const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

const PG_PORT = 5433;
const BACKEND_PORT = 3001;
const FRONTEND_PORT = 3000;
const DB_NAME = 'restorch';
const CLOUD_URL = 'https://restaurant.learnica.net';

let mainWindow = null;
let tray = null;
let backendProc = null;
let frontendProc = null;
let isQuitting = false;
let autoUpdaterInstance = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
}

function getPaths() {
  const isPackaged = app.isPackaged;
  const resourcesDir = isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
  const userDataDir = app.getPath('userData');

  return {
    isPackaged,
    resourcesDir,
    userDataDir,
    pgBinDir: isPackaged
      ? path.join(resourcesDir, 'postgres', 'bin')
      : path.join(resourcesDir, 'pgsql', 'bin'),
    backendDir: isPackaged
      ? path.join(resourcesDir, 'backend')
      : path.join(resourcesDir, 'fanaye-resturant-backend'),
    frontendDir: isPackaged
      ? path.join(resourcesDir, 'frontend')
      : path.join(resourcesDir, 'fanaye-resturant', '.next', 'standalone'),
    trayIconPath: isPackaged
      ? path.join(resourcesDir, 'tray-icon.png')
      : path.join(resourcesDir, 'fanaye-resturant', 'public', 'favicon.png'),
    pgDataDir: path.join(userDataDir, 'pgdata'),
    filesDir: path.join(userDataDir, 'files'),
    envPath: path.join(userDataDir, '.env'),
    logPath: path.join(userDataDir, 'restorch.log'),
    pgLogPath: path.join(userDataDir, 'postgres.log'),
  };
}

function appendLog(logPath, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // ignore
  }
}

function getLocalHardwareHash() {
  let machineGuid = '';
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 },
      );
      const match = out.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
      if (match && match[1]) machineGuid = match[1].trim();
    } catch {
      // fallback below
    }
  }
  const cpuModel = (os.cpus()[0] && os.cpus()[0].model) || '';
  const raw = machineGuid
    ? `win-guid:${machineGuid}:${os.arch()}`
    : `host:${os.hostname()}:${os.platform()}:${os.arch()}:${cpuModel}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function getEmbeddedPublicKey(paths) {
  const packagedPem = path.join(__dirname, 'license-public-key.pem');
  if (fs.existsSync(packagedPem)) {
    return fs.readFileSync(packagedPem, 'utf8');
  }
  const devPem = path.join(paths.resourcesDir, 'restunrant-exe', 'license-public-key.pem');
  if (fs.existsSync(devPem)) {
    return fs.readFileSync(devPem, 'utf8');
  }
  return '';
}

async function verifyDesktopHardwareLicense(paths, hardwareHash) {
  const psql = path.join(paths.pgBinDir, 'psql.exe');
  let localTenantId = '';
  try {
    const res = await execPromise(psql, [
      '-h',
      '127.0.0.1',
      '-p',
      String(PG_PORT),
      '-U',
      'postgres',
      '-d',
      DB_NAME,
      '-tAc',
      'SELECT id::text FROM public.tenants LIMIT 1',
    ]);
    localTenantId = res.stdout.trim();
  } catch {
    return;
  }

  // Brand-new PC before first-time setup has no tenant rows yet
  if (!localTenantId) {
    return;
  }

  const licensePath = path.join(paths.userDataDir, 'license.json');
  if (!fs.existsSync(licensePath)) {
    throw new Error(
      'Missing offline license file (license.json) for this restaurant database.\nPlease run First-Time Setup on this computer or contact platform support.',
    );
  }

  let license;
  try {
    license = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  } catch {
    throw new Error('Corrupted offline license file (license.json).');
  }

  const publicKeyPem = getEmbeddedPublicKey(paths);
  if (!publicKeyPem) {
    throw new Error('Missing embedded license public key.');
  }

  const canonical = JSON.stringify({
    version: license.version,
    tenantId: license.tenantId,
    hardwareHash: license.hardwareHash,
    deviceLabel: license.deviceLabel || 'POS-PC',
    issuedAt: license.issuedAt,
  });

  const sigValid = crypto.verify(
    null,
    Buffer.from(canonical, 'utf8'),
    crypto.createPublicKey(publicKeyPem),
    Buffer.from(String(license.signature || ''), 'base64'),
  );

  if (!sigValid) {
    throw new Error('Invalid desktop license signature.');
  }
  if (license.hardwareHash !== hardwareHash) {
    throw new Error(
      'This Restorch installation is locked to a different computer hardware ID.\nAsk Super Admin to reset the Desktop Device License to move to this PC.',
    );
  }
  if (license.tenantId !== localTenantId) {
    throw new Error('Desktop license does not match the restaurant database on this PC.');
  }
}

function getLocalLanIps() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function execPromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function ensureUserEnv(paths) {
  fs.mkdirSync(paths.userDataDir, { recursive: true });
  fs.mkdirSync(paths.filesDir, { recursive: true });

  const lanOrigins = getLocalLanIps().map((ip) => `http://${ip}:${FRONTEND_PORT}`);
  const frontendDomains = [
    `http://localhost:${FRONTEND_PORT}`,
    `http://127.0.0.1:${FRONTEND_PORT}`,
    ...lanOrigins,
  ].join(',');

  const dbUrl = `postgresql://postgres@127.0.0.1:${PG_PORT}/${DB_NAME}?schema=public`;

  let envContent = '';
  if (fs.existsSync(paths.envPath)) {
    envContent = fs.readFileSync(paths.envPath, 'utf8');
  }

  const defaults = {
    NODE_ENV: 'production',
    TZ: 'Africa/Addis_Ababa',
    APP_PORT: String(BACKEND_PORT),
    APP_NAME: '"Restorch"',
    API_PREFIX: 'backend',
    APP_FALLBACK_LANGUAGE: 'en',
    APP_HEADER_LANGUAGE: 'x-custom-lang',
    FRONTEND_DOMAIN: frontendDomains,
    BACKEND_DOMAIN: `http://localhost:${BACKEND_PORT}`,
    DATABASE_TYPE: 'postgres',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(PG_PORT),
    DATABASE_USERNAME: 'postgres',
    DATABASE_PASSWORD: '',
    DATABASE_NAME: DB_NAME,
    DATABASE_SYNCHRONIZE: 'false',
    DATABASE_SSL_ENABLED: 'false',
    DATABASE_URL: dbUrl,
    FILE_DRIVER: 'local',
    MAIL_HOST: 'localhost',
    MAIL_PORT: '1025',
    MAIL_DEFAULT_EMAIL: 'noreply@restaurant.learnica.net',
    MAIL_DEFAULT_NAME: '"Restorch"',
    MAIL_IGNORE_TLS: 'true',
    MAIL_SECURE: 'false',
    MAIL_REQUIRE_TLS: 'false',
    AUTH_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    AUTH_JWT_TOKEN_EXPIRES_IN: '15m',
    AUTH_REFRESH_SECRET: crypto.randomBytes(32).toString('hex'),
    AUTH_REFRESH_TOKEN_EXPIRES_IN: '7d',
    AUTH_FORGOT_SECRET: crypto.randomBytes(32).toString('hex'),
    AUTH_FORGOT_TOKEN_EXPIRES_IN: '30m',
    AUTH_CONFIRM_EMAIL_SECRET: crypto.randomBytes(32).toString('hex'),
    AUTH_CONFIRM_EMAIL_TOKEN_EXPIRES_IN: '1d',
    CLOUD_SYNC_URL: CLOUD_URL,
    OFFLINE_SYNC_ENABLED: 'false',
    OFFLINE_DESKTOP: 'true',
    REDIS_ENABLED: 'false',
    DESKTOP_HARDWARE_HASH: getLocalHardwareHash(),
  };

  // Always update dynamic local values (FRONTEND_DOMAIN, DATABASE_URL, APP_PORT, offline flags)
  const alwaysUpdate = new Set([
    'FRONTEND_DOMAIN',
    'DATABASE_URL',
    'APP_PORT',
    'DATABASE_PORT',
    'OFFLINE_DESKTOP',
    'REDIS_ENABLED',
    'DESKTOP_HARDWARE_HASH',
  ]);

  for (const [key, val] of Object.entries(defaults)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      if (alwaysUpdate.has(key)) {
        envContent = envContent.replace(regex, `${key}=${val}`);
      }
    } else {
      envContent += `\n${key}=${val}`;
    }
  }

  fs.writeFileSync(paths.envPath, envContent.trim() + '\n', 'utf8');

  // Parse into env object for child processes
  const parsed = {};
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const k = trimmed.slice(0, idx).trim();
      let v = trimmed.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      parsed[k] = v;
    }
  }

  // Copy eng.traineddata to userDataDir if present so tesseract finds it in cwd
  const srcTrained = path.join(paths.backendDir, 'eng.traineddata');
  const dstTrained = path.join(paths.userDataDir, 'eng.traineddata');
  if (fs.existsSync(srcTrained) && !fs.existsSync(dstTrained)) {
    try {
      fs.copyFileSync(srcTrained, dstTrained);
    } catch {
      // ignore
    }
  }

  return parsed;
}

async function startPostgres(paths, envVars) {
  const initdb = path.join(paths.pgBinDir, 'initdb.exe');
  const pgCtl = path.join(paths.pgBinDir, 'pg_ctl.exe');
  const pgIsReady = path.join(paths.pgBinDir, 'pg_isready.exe');
  const psql = path.join(paths.pgBinDir, 'psql.exe');
  const createdb = path.join(paths.pgBinDir, 'createdb.exe');

  if (!fs.existsSync(path.join(paths.pgDataDir, 'PG_VERSION'))) {
    appendLog(paths.logPath, 'Initializing PostgreSQL cluster...');
    fs.mkdirSync(paths.pgDataDir, { recursive: true });
    await execPromise(initdb, [
      '-D',
      paths.pgDataDir,
      '-U',
      'postgres',
      '-A',
      'trust',
      '--encoding=UTF8',
      '--locale=C',
    ]);
  }

  let pgReady = false;
  try {
    await execPromise(pgIsReady, ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres']);
    pgReady = true;
    appendLog(paths.logPath, `PostgreSQL already running on port ${PG_PORT}.`);
  } catch {
    pgReady = false;
  }

  if (!pgReady) {
    // Recover from stale postmaster.pid left behind after a power loss or crash
    const pidPath = path.join(paths.pgDataDir, 'postmaster.pid');
    if (fs.existsSync(pidPath)) {
      try {
        await execPromise(pgCtl, ['-D', paths.pgDataDir, 'status']);
      } catch {
        appendLog(paths.logPath, 'Removing stale PostgreSQL postmaster.pid after unclean shutdown...');
        try {
          fs.unlinkSync(pidPath);
        } catch {
          // ignore
        }
      }
    }

    appendLog(paths.logPath, `Starting PostgreSQL on port ${PG_PORT}...`);
    await new Promise((resolve) => {
      const pgProc = spawn(
        pgCtl,
        ['-D', paths.pgDataDir, '-o', `-p ${PG_PORT}`, '-l', paths.pgLogPath, 'start'],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      pgProc.on('error', (err) => {
        appendLog(paths.logPath, `pg_ctl start notice: ${err.message}`);
        resolve();
      });
      pgProc.on('exit', () => resolve());
      pgProc.unref();
    });

    // Wait for Postgres readiness
    for (let i = 0; i < 40; i++) {
      try {
        await execPromise(pgIsReady, ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres']);
        pgReady = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!pgReady) {
      throw new Error(`PostgreSQL failed to start on port ${PG_PORT}. Check ${paths.pgLogPath}`);
    }
  }

  // Ensure database exists
  const check = await execPromise(psql, [
    '-h',
    '127.0.0.1',
    '-p',
    String(PG_PORT),
    '-U',
    'postgres',
    '-tAc',
    `SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'`,
  ]);

  if (check.stdout.trim() !== '1') {
    appendLog(paths.logPath, `Creating database ${DB_NAME}...`);
    await execPromise(createdb, ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', DB_NAME]);
  }

  // Run Prisma migrations only on first run or after app version update
  const markerPath = path.join(paths.userDataDir, '.migrated-version');
  const currentVersion = app.getVersion();
  const prevVersion = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';

  if (prevVersion !== currentVersion || check.stdout.trim() !== '1') {
    appendLog(paths.logPath, 'Running Prisma migrations...');
    const prismaCli = path.join(paths.backendDir, 'node_modules', 'prisma', 'build', 'index.js');
    const schemaPath = path.join(paths.backendDir, 'prisma', 'schema.prisma');
    await execPromise(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', schemaPath],
      {
        cwd: paths.backendDir,
        env: {
          ...process.env,
          ...envVars,
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    );
    fs.writeFileSync(markerPath, currentVersion, 'utf8');
  }
  appendLog(paths.logPath, 'PostgreSQL & migrations ready.');
}

async function stopPostgres(paths) {
  const pgCtl = path.join(paths.pgBinDir, 'pg_ctl.exe');
  if (!fs.existsSync(pgCtl) || !fs.existsSync(paths.pgDataDir)) return;
  try {
    await execPromise(pgCtl, ['-D', paths.pgDataDir, 'stop', '-m', 'fast']);
    appendLog(paths.logPath, 'PostgreSQL stopped cleanly.');
  } catch (err) {
    appendLog(paths.logPath, `PostgreSQL stop notice: ${err.message}`);
  }
}

function waitForHttp(url, timeoutMs = 45000, getProc = null) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const proc = getProc ? getProc() : null;
      if (proc && proc.exitCode !== null) {
        return reject(new Error(`Process exited early with code ${proc.exitCode} while waiting for ${url}`));
      }
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for ${url}`));
        } else {
          setTimeout(attempt, 500);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

function startBackend(paths, envVars) {
  appendLog(paths.logPath, 'Starting NestJS backend...');
  const entry = path.join(paths.backendDir, 'dist', 'main.js');
  backendProc = spawn(process.execPath, [entry], {
    cwd: paths.userDataDir,
    windowsHide: true,
    env: {
      ...process.env,
      ...envVars,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  backendProc.stdout.on('data', (d) => appendLog(paths.logPath, `[backend] ${d.toString().trim()}`));
  backendProc.stderr.on('data', (d) => appendLog(paths.logPath, `[backend:err] ${d.toString().trim()}`));
  backendProc.on('exit', (code) => appendLog(paths.logPath, `Backend exited with code ${code}`));
}

function startFrontend(paths, envVars) {
  appendLog(paths.logPath, 'Starting Next.js frontend...');
  const entry = path.join(paths.frontendDir, 'server.js');
  frontendProc = spawn(process.execPath, [entry], {
    cwd: paths.frontendDir,
    windowsHide: true,
    env: {
      ...process.env,
      ...envVars,
      HOSTNAME: '0.0.0.0',
      PORT: String(FRONTEND_PORT),
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  frontendProc.stdout.on('data', (d) => appendLog(paths.logPath, `[frontend] ${d.toString().trim()}`));
  frontendProc.stderr.on('data', (d) => appendLog(paths.logPath, `[frontend:err] ${d.toString().trim()}`));
  frontendProc.on('exit', (code) => appendLog(paths.logPath, `Frontend exited with code ${code}`));
}

function createSplashHtml() {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Restorch</title>
      <style>
        body {
          margin: 0; height: 100vh; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          background: #0f172a; color: #f8fafc; font-family: system-ui, -apple-system, sans-serif;
        }
        .spinner {
          width: 44px; height: 44px; border: 4px solid #334155;
          border-top-color: #f97316; border-radius: 50%;
          animation: spin 0.9s linear infinite; margin-bottom: 20px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        h1 { margin: 0 0 8px; font-size: 24px; font-weight: 700; }
        p { margin: 0; color: #94a3b8; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="spinner"></div>
      <h1>Restorch</h1>
      <p>Starting local database and offline server...</p>
    </body>
    </html>
  `;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createTray(paths) {
  if (!fs.existsSync(paths.trayIconPath)) return;
  const icon = nativeImage.createFromPath(paths.trayIconPath);
  tray = new Tray(icon);
  tray.setToolTip('Restorch Offline POS');

  const lanUrls = getLocalLanIps().map((ip) => `http://${ip}:${FRONTEND_PORT}`);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Restorch',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: `Tablet URLs: ${lanUrls.length ? lanUrls.join(', ') : 'localhost:' + FRONTEND_PORT}`,
      enabled: false,
    },
    {
      label: 'Check for Updates...',
      click: () => {
        if (!app.isPackaged || !autoUpdaterInstance) {
          dialog.showMessageBox({
            type: 'info',
            title: 'Restorch Updates',
            message: 'Automatic updates are enabled in the packaged Windows installer.',
          });
          return;
        }
        autoUpdaterInstance.checkForUpdates().catch((err) => {
          dialog.showMessageBox({
            type: 'warning',
            title: 'Update Check',
            message: `Could not reach update server: ${err.message}`,
          });
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Restorch (Stops Server)',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow(paths) {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Restorch',
    icon: fs.existsSync(paths.trayIconPath) ? paths.trayIconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(createSplashHtml());

  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function setupAutoUpdater(paths) {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdaterInstance = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      appendLog(paths.logPath, '[updater] Checking for updates...');
    });
    autoUpdater.on('update-available', (info) => {
      appendLog(paths.logPath, `[updater] Update available: v${info.version}`);
    });
    autoUpdater.on('update-not-available', () => {
      appendLog(paths.logPath, '[updater] App is up to date.');
    });
    autoUpdater.on('error', (err) => {
      appendLog(paths.logPath, `[updater] Notice: ${err.message}`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      appendLog(paths.logPath, `[updater] Downloaded v${info.version}. Prompting user...`);
      dialog
        .showMessageBox(mainWindow || undefined, {
          type: 'info',
          buttons: ['Restart & Update Now', 'Later (On Quit)'],
          defaultId: 0,
          title: 'Restorch Update Ready',
          message: `Restorch v${info.version} has been downloaded.`,
          detail: 'Your restaurant database and settings will be preserved automatically.',
        })
        .then((res) => {
          if (res.response === 0) {
            isQuitting = true;
            autoUpdater.quitAndInstall();
          }
        })
        .catch(() => {});
    });

    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 15_000);
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000).unref();
  } catch (err) {
    appendLog(paths.logPath, `[updater] Init skipped: ${err.message}`);
  }
}

if (gotTheLock) {
  app.whenReady().then(async () => {
    const paths = getPaths();

    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: app.getPath('exe'),
      });
    }

    createWindow(paths);
    createTray(paths);
    setupAutoUpdater(paths);

    try {
      const envVars = ensureUserEnv(paths);
      await startPostgres(paths, envVars);
      await verifyDesktopHardwareLicense(paths, envVars.DESKTOP_HARDWARE_HASH);
      startBackend(paths, envVars);
      await waitForHttp(
        `http://127.0.0.1:${BACKEND_PORT}/backend/v1/sync/status`,
        240000,
        () => backendProc,
      );
      startFrontend(paths, envVars);
      await waitForHttp(
        `http://127.0.0.1:${FRONTEND_PORT}`,
        60000,
        () => frontendProc,
      );

      if (mainWindow) {
        await mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}`);
      }
    } catch (err) {
      appendLog(paths.logPath, `Startup error: ${err.stack || err.message}`);
      dialog.showErrorBox(
        'Restorch Startup Error',
        `Failed to start local services:\n\n${err.message}\n\nLog: ${paths.logPath}`,
      );
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', async (e) => {
    const paths = getPaths();
    if (frontendProc) {
      try {
        frontendProc.kill();
      } catch {
        // ignore
      }
      frontendProc = null;
    }
    if (backendProc) {
      try {
        backendProc.kill();
      } catch {
        // ignore
      }
      backendProc = null;
    }
    e.preventDefault();
    await stopPostgres(paths);
    app.exit(0);
  });
}

