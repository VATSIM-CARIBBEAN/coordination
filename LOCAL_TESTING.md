Local build & smoke test

1) Install dependencies at project root (server) and client:

# From project root
npm install

# Build client
cd vatsim-coord-app
npm install
npm run build
cd ..

# Set CLIENT_DIR so the server serves the built client
# On Windows (PowerShell):
$env:CLIENT_DIR = "vatsim-coord-app/dist"
# On bash:
export CLIENT_DIR=vatsim-coord-app/dist

# Start server
npm start

2) Test realtime sync
- Open http://localhost:5175 in two browser windows (Railway or local server port may vary).
- Drag a card from 'Unassigned' to another lane and observe the other window updating.
- Edit values (estimate/alt/mach) and verify the other window receives changes.

Notes:
- If you prefer to copy the build to project root, run `cp -r vatsim-coord-app/dist dist` and ensure CLIENT_DIR is unset.
- For Railway, set the build command to run the client build and set CLIENT_DIR to vatsim-coord-app/dist in Environment.
