# restunrant-exe

Restorch Offline POS Desktop Server & Client (Electron wrapper for Windows).

## Rebuild `Restorch Setup 1.0.0.exe` on Windows

Place all 4 folders side-by-side in the same parent folder (e.g. `restunrat/`):

```text
restunrat/
├── restunrant-exe/            (this repo)
├── fanaye-resturant/          (frontend repo)
├── fanaye-resturant-backend/  (backend repo)
└── pgsql/                     (portable PostgreSQL Windows x64: bin/, lib/, share/)
```

### Steps

1. **Prepare portable PostgreSQL** (`bin/`, `lib/`, `share/`) in `pgsql/`.
   - If PostgreSQL is installed locally (e.g. `C:\Program Files\PostgreSQL\19`), copy `bin`, `lib`, and `share` into `pgsql/` (excluding `data/`).
2. **Build the backend:**
   ```powershell
   cd fanaye-resturant-backend
   npm install
   npx prisma generate
   npm run build
   ```
3. **Build the frontend** (Next.js standalone pointed at the local desktop backend on port `3001`):
   ```powershell
   cd ..\fanaye-resturant
   $env:NEXT_PUBLIC_API_URL="http://localhost:3001/backend/v1"
   $env:NEXT_PUBLIC_APP_URL="http://localhost:3000"
   $env:NEXT_PUBLIC_SOCKET_URL="http://localhost:3001"
   npm install
   npm run build
   ```
4. **Build the Windows `.exe` installer:**
   ```powershell
   cd ..\restunrant-exe
   npm install
   npm run build:exe
   ```

The installer will be generated at `restunrant-exe/dist/Restorch Setup 1.0.0.exe`.
