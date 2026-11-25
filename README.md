# restunrant-exe

Restorch Offline POS Desktop Server & Client (Electron wrapper for Windows).

## Rebuild `Restorch Setup 1.0.0.exe` on a New PC

Place all 4 folders side-by-side in the same parent folder (e.g. `resturnat/`):

```text
resturnat/
├── desktop/                   (this repo)
├── fanaye-resturant/          (frontend repo)
├── fanaye-resturant-backend/  (backend repo)
└── pgsql/                     (portable PostgreSQL Windows x64 binaries: bin/, lib/, share/)
```

### Steps

1. **Clone the 3 repos** side-by-side:
   ```bash
   git clone https://github.com/MinilikBelachew/fanaye-resturant.git
   git clone https://github.com/MinilikBelachew/fanaye-resturant-backend.git
   git clone https://github.com/MinilikBelachew/restunrant-exe.git desktop
   ```
2. **Place portable PostgreSQL** (`bin/`, `lib/`, `share/`) in `pgsql/`.
3. **Build the backend:**
   ```bash
   cd fanaye-resturant-backend
   npm install
   npx prisma generate
   npm run build
   ```
4. **Build the frontend** (with Next.js standalone output):
   ```bash
   cd ../fanaye-resturant
   npm install
   npm run build
   ```
5. **Build the Windows `.exe` installer:**
   ```bash
   cd ../desktop
   npm install
   npm run build:exe
   ```

The installer will be generated at `desktop/dist/Restorch Setup 1.0.0.exe`.
