'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const backendDir = path.resolve(rootDir, '..', 'fanaye-resturant-backend');
const frontendDir = path.resolve(rootDir, '..', 'fanaye-resturant');
const frontendStandalone = path.join(frontendDir, '.next', 'standalone', 'server.js');
const frontendChunksDir = path.join(frontendDir, '.next', 'static', 'chunks');
const backendDistDir = path.join(backendDir, 'dist');
const backendEntry = path.join(backendDistDir, 'main.js');
const stagingBackendDist = path.join(rootDir, 'build-staging', 'backend-dist');
const electronExe = path.join(
  rootDir,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

if (!fs.existsSync(backendEntry)) {
  throw new Error(
    `Backend build not found at ${backendEntry}. Run "npm run build" in fanaye-resturant-backend first.`,
  );
}
if (!fs.existsSync(frontendStandalone)) {
  throw new Error(
    `Frontend standalone build not found at ${frontendStandalone}. Build fanaye-resturant with NEXT_PUBLIC_API_URL=http://localhost:3001/backend/v1 first.`,
  );
}
if (fs.existsSync(frontendChunksDir)) {
  for (const file of fs.readdirSync(frontendChunksDir)) {
    if (!file.endsWith('.js')) continue;
    const content = fs.readFileSync(path.join(frontendChunksDir, file), 'utf8');
    if (content.includes('localhost:5000')) {
      throw new Error(
        `Frontend chunk ${file} has dev URL "localhost:5000" baked in! Rebuild fanaye-resturant with NEXT_PUBLIC_API_URL=http://localhost:3001/backend/v1, NEXT_PUBLIC_APP_URL=http://localhost:3000, NEXT_PUBLIC_SOCKET_URL=http://localhost:3001.`,
      );
    }
  }
}
if (!fs.existsSync(electronExe)) {
  throw new Error(
    `Electron binary not found at ${electronExe}. Run "npm install" in restunrant-exe first.`,
  );
}

const esbuild = require('esbuild');

fs.rmSync(stagingBackendDist, { recursive: true, force: true });
fs.mkdirSync(stagingBackendDist, { recursive: true });

console.log('[protect] Bundling backend with esbuild (no source maps)...');
const bundlePath = path.join(stagingBackendDist, 'bundle.js');
esbuild.buildSync({
  entryPoints: [backendEntry],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  keepNames: true,
  packages: 'external',
  logLevel: 'info',
});

// Copy runtime assets needed relative to __dirname in backend
const i18nSrc = path.join(backendDistDir, 'i18n');
if (fs.existsSync(i18nSrc)) {
  fs.cpSync(i18nSrc, path.join(stagingBackendDist, 'i18n'), {
    recursive: true,
  });
}
const schemaSrc = path.join(backendDir, 'src', 'ai', 'extracted_schema.sql');
if (fs.existsSync(schemaSrc)) {
  fs.copyFileSync(
    schemaSrc,
    path.join(stagingBackendDist, 'extracted_schema.sql'),
  );
}

console.log('[protect] Compiling backend bundle to V8 bytecode (.jsc)...');
const backendJsc = path.join(stagingBackendDist, 'main.jsc');
const compileBackendScript = `
  const bytenode = require(${JSON.stringify(require.resolve('bytenode'))});
  bytenode.compileFile({
    filename: ${JSON.stringify(bundlePath)},
    output: ${JSON.stringify(backendJsc)},
    compileAsModule: true,
  }).then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
`;
execFileSync(electronExe, ['-e', compileBackendScript], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
fs.rmSync(bundlePath, { force: true });

// Bundle bytenode runtime into a standalone file next to main.jsc
// (electron-builder strips nested node_modules inside extraResources)
const bytenodeRuntimeOut = path.join(stagingBackendDist, 'bytenode.cjs');
esbuild.buildSync({
  entryPoints: [require.resolve('bytenode')],
  outfile: bytenodeRuntimeOut,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'silent',
});

fs.writeFileSync(
  path.join(stagingBackendDist, 'main.js'),
  `'use strict';\nrequire('./bytenode.cjs');\nrequire('./main.jsc');\n`,
  'utf8',
);

console.log('[protect] Compiling Electron main.js to V8 bytecode (.jsc)...');
const mainSrc = path.join(rootDir, 'main.js');
const mainJsc = path.join(rootDir, 'main.jsc');
const tmpCompiler = path.join(rootDir, '.compile-electron-main.cjs');
fs.writeFileSync(
  tmpCompiler,
  `
  const { app } = require('electron');
  const bytenode = require(${JSON.stringify(require.resolve('bytenode'))});
  app.whenReady().then(async () => {
    try {
      await bytenode.compileFile({
        filename: ${JSON.stringify(mainSrc)},
        output: ${JSON.stringify(mainJsc)},
        compileAsModule: true,
      });
      app.exit(0);
    } catch (err) {
      console.error(err);
      app.exit(1);
    }
  });
`,
  'utf8',
);

try {
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  execFileSync(electronExe, [tmpCompiler], {
    stdio: 'inherit',
    env: electronEnv,
  });
} finally {
  fs.rmSync(tmpCompiler, { force: true });
}

console.log('[protect] Bytecode protection ready (main.jsc + backend/dist/main.jsc).');
