# restunrant-exe

Restorch Offline POS Desktop Server & Client (Electron wrapper for Windows).

## Features Included in Builds
- **V8 Bytecode Protection (`bytenode` + `esbuild`):** Compiles `main.js` and the NestJS backend into `.jsc` binary bytecode without source maps or `.d.ts` files.
- **Hardware-Bound Single-Restaurant License (Ed25519):** First-Time Setup binds the restaurant tenant to the PC's hardware ID (`MachineGuid`) and verifies the signed `license.json` offline on every launch. Super Admins can reset the binding from `/super-admin/tenants/<id>`.
- **Automatic Over-the-Air Updates (`electron-updater`):** Checks `https://restaurant.learnica.net/desktop-updates/` and updates the app while preserving `%APPDATA%\restorch-desktop\pgdata`.

## Cloud Server Prerequisite
Add the Ed25519 private signing key to your Cloud backend `.env` / `PROD_ENV_FILE`:
```env
DESKTOP_LICENSE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```
(Generate a new pair anytime with `node fanaye-resturant-backend/scripts/generate-desktop-license-keys.js`.)

## Rebuild `Restorch Setup <version>.exe` on Windows

Place all 4 folders side-by-side in the same parent folder (e.g. `restunrat/`):

```text
restunrat/
├── restunrant-exe/            (this repo)
├── fanaye-resturant/          (frontend repo)
├── fanaye-resturant-backend/  (backend repo)
└── pgsql/                     (portable PostgreSQL 17 Windows x64: bin/, lib/, share/)
```

### Steps

1. **Prepare portable PostgreSQL 17** (`bin/`, `lib/`, `share/`) in `pgsql/` from https://www.enterprisedb.com/download-postgresql-binaries.
2. **Build the backend:**
   ```cmd
   cd /d c:\Users\mila\Desktop\restunrat\fanaye-resturant-backend
   npm.cmd install
   npx.cmd prisma generate
   npm.cmd run build
   ```
3. **Build the frontend** (Next.js standalone pointed at the local desktop backend on port `3001`):
   ```cmd
   cd /d c:\Users\mila\Desktop\restunrat\fanaye-resturant
   set NEXT_PUBLIC_API_URL=http://localhost:3001/backend/v1
   set NEXT_PUBLIC_APP_URL=http://localhost:3000
   set NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
   npm.cmd install
   npm.cmd run build
   ```
4. **Build the protected Windows `.exe` installer:**
   ```cmd
   cd /d c:\Users\mila\Desktop\restunrat\restunrant-exe
   npm.cmd install
   npm.cmd run build:exe
   ```

The installer and `latest.yml` (for auto-updates) will be generated in `restunrant-exe/dist/`.
Upload `Restorch Setup <version>.exe`, `Restorch Setup <version>.exe.blockmap`, and `latest.yml` to `https://restaurant.learnica.net/desktop-updates/` to push an automatic update to existing restaurants.
