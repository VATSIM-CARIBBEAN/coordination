Railway deployment notes

This project runs a Node server (Socket.IO) and optionally serves a built Vite client from a `dist/` folder.

Recommended project layout for Railway:
- Build client into `dist/` at the project root, or set CLIENT_DIR env to point to a different folder (for example `vatsim-coord-app/dist`).

Railway settings:
- Build command (root): npm install && npm run build
  - If using the `vatsim-coord-app` subfolder: cd vatsim-coord-app && npm install && npm run build && cd ..
- Start command: npm start
- Environment:
  - PORT (optional) - Railway will set the port automatically. Server uses process.env.PORT.
  - CLIENT_DIR (optional) - override where static client build is served from (default: dist)

Notes:
- The server listens on process.env.PORT and will serve static files from the directory set by CLIENT_DIR (or `dist` by default).
- If you keep the client in `vatsim-coord-app`, set CLIENT_DIR to `vatsim-coord-app/dist` in Railway's environment variables before starting.
- Socket.IO runs on the same origin (same host/port) as the web app. No additional proxy configuration required.
