# VATSIM Coordination Board — Drag & Drop Fix

- Stacked vertical lanes
- One card per callsign
- Cross-lane drag & drop working (droppable containers added)
- Lane-specific fixes for Curacao, Maiquetia, Piarco, New York

## Run
```bash
npm install
npm run server   # start backend server
npm run dev      # start Vite client
```

## Local build & smoke test

1. Build client

```bash
cd vatsim-coord-app
npm install
npm run build
cd ..
```

2. Start server (serve built client):

```bash
export CLIENT_DIR=vatsim-coord-app/dist
npm start
```

3. Open the site and verify realtime sync via two browser windows. Drag cards between lanes and edit fields. Values should propagate between windows.
