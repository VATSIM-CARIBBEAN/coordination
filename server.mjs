import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// Parse JSON + cookies
app.use(express.json());
app.use(cookieParser());

// Allow dev connections from anywhere for sockets
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// ---- Shared in-memory board state ----
let boardState = {
  lanes: {
    Unassigned: [],
    'New York': [],
    Curacao: [],
    Piarco: [],
    Maiquetia: [],
  },
  items: {},
  lastUpdated: Date.now(),
};

// =======================
//   Session + Access
// =======================

const sessions = new Map(); // sid -> { user, createdAt }

// Access list: who is allowed to use the board
const ACCESS_CIDS = new Set(); // strings

// Admin list: who can edit ACCESS_CIDS and admins via API
// Defaults from environment variables (comma-separated CIDs)
const DEFAULT_ADMIN_CIDS = process.env.ADMIN_CIDS
  ? process.env.ADMIN_CIDS.split(',').map((c) => c.trim()).filter(Boolean)
  : [];
const DEFAULT_ALLOWED_CIDS = process.env.ALLOWED_CIDS
  ? process.env.ALLOWED_CIDS.split(',').map((c) => c.trim()).filter(Boolean)
  : [];

const ADMIN_CIDS = new Set(DEFAULT_ADMIN_CIDS);

// File used to persist access/admin roles
const ACCESS_FILE = path.join(__dirname, 'access.json');

function loadAccessFromDisk() {
  try {
    if (!fs.existsSync(ACCESS_FILE)) {
      console.log('ℹ️ No access.json found, using environment defaults.');
      // Initialize from environment variables if no access.json exists
      if (DEFAULT_ALLOWED_CIDS.length > 0) {
        DEFAULT_ALLOWED_CIDS.forEach((cid) => ACCESS_CIDS.add(cid));
        console.log(`   Loaded ${DEFAULT_ALLOWED_CIDS.length} allowed CIDs from ALLOWED_CIDS env var.`);
      }
      if (DEFAULT_ADMIN_CIDS.length > 0) {
        console.log(`   Loaded ${DEFAULT_ADMIN_CIDS.length} admin CIDs from ADMIN_CIDS env var.`);
      }
      return;
    }
    const raw = fs.readFileSync(ACCESS_FILE, 'utf8');
    const json = JSON.parse(raw);

    if (Array.isArray(json.allowed)) {
      ACCESS_CIDS.clear();
      json.allowed.forEach((cid) => {
        if (cid) ACCESS_CIDS.add(String(cid));
      });
    }

    if (Array.isArray(json.admins) && json.admins.length > 0) {
      ADMIN_CIDS.clear();
      json.admins.forEach((cid) => {
        if (cid) ADMIN_CIDS.add(String(cid));
      });
    }

    console.log('✅ Loaded access/admin lists from access.json');
  } catch (err) {
    console.error('⚠️ Failed to load access.json:', err);
  }
}

function saveAccessToDisk() {
  try {
    const data = {
      allowed: Array.from(ACCESS_CIDS),
      admins: Array.from(ADMIN_CIDS),
    };
    fs.writeFileSync(ACCESS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('💾 Saved access/admin lists to access.json');
  } catch (err) {
    console.error('⚠️ Failed to save access.json:', err);
  }
}

// Load access/admin on server start
loadAccessFromDisk();

const VATSIM_BASE = 'https://auth-dev.vatsim.net';
const {
  VATSIM_CLIENT_ID,
  VATSIM_CLIENT_SECRET,
  VATSIM_REDIRECT_URI,
  NODE_ENV,
} = process.env;

function isProd() {
  return NODE_ENV === 'production';
}

function createSession(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { user, createdAt: Date.now() });
  return sid;
}

function getSession(req) {
  const sid = req.cookies?.sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function setSidCookie(res, sid) {
  res.cookie('sid', sid, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd() ? true : false, // false on localhost
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function devLogin(req, res) {
  const profile = {
    cid: '9999999',
    name: 'DEV USER',
    rating: 'C1',
    pilotRating: 'P1',
    division: 'DEV',
  };
  const sid = createSession(profile);
  console.log('⚙️ DEV login used, sid=', sid);

  setSidCookie(res, sid);
  return res.redirect('/');
}

// =======================
//   VATSIM SSO ROUTES
// =======================

// 1) Start OAuth flow
app.get('/auth/login', (req, res) => {
  // If VATSIM not configured AND not in prod, use dev login
  if ((!VATSIM_CLIENT_ID || !VATSIM_REDIRECT_URI || !VATSIM_CLIENT_SECRET) && !isProd()) {
    console.warn('VATSIM SSO not configured; using DEV login instead.');
    return devLogin(req, res);
  }

  if (!VATSIM_CLIENT_ID || !VATSIM_REDIRECT_URI || !VATSIM_CLIENT_SECRET) {
    console.error('VATSIM SSO not configured (missing env vars).');
    return res
      .status(500)
      .send('VATSIM SSO not configured (missing env vars).');
  }

  const state = crypto.randomBytes(16).toString('hex');

  res.cookie('oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
    path: '/',
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: VATSIM_CLIENT_ID,
    redirect_uri: VATSIM_REDIRECT_URI,
    scope: 'full_name email vatsim_details country',
    state,
  });

  console.log('Redirecting to VATSIM auth with state:', state);
  res.redirect(`${VATSIM_BASE}/oauth/authorize?${params.toString()}`);
});

// 2) OAuth callback from VATSIM
app.get('/auth/callback', async (req, res) => {
  // If not configured and somehow callback is hit, just dev-login
  if ((!VATSIM_CLIENT_ID || !VATSIM_REDIRECT_URI || !VATSIM_CLIENT_SECRET) && !isProd()) {
    console.warn('Callback without VATSIM config; using DEV login instead.');
    return devLogin(req, res);
  }

  const { code, state } = req.query;
  const cookieState = req.cookies?.oauth_state;

  console.log('OAuth callback', { code, state, cookieState });

  if (!code || !state || !cookieState || state !== cookieState) {
    console.error('Invalid OAuth state or code.');
    return res.status(400).send('Invalid OAuth state or code.');
  }

  res.clearCookie('oauth_state', {
    sameSite: 'lax',
    secure: isProd(),
    path: '/',
  });

  try {
    const tokenRes = await fetch(`${VATSIM_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: VATSIM_CLIENT_ID,
        client_secret: VATSIM_CLIENT_SECRET,
        redirect_uri: VATSIM_REDIRECT_URI,
        code: String(code),
      }),
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error('VATSIM token error:', tokenRes.status, txt);

      if (!isProd()) {
        console.warn('Using DEV login because token exchange failed in dev.');
        return devLogin(req, res);
      }

      return res.status(500).send('Failed to get access token from VATSIM.');
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      console.error('No access_token in VATSIM response:', tokenJson);

      if (!isProd()) {
        console.warn('Using DEV login because no access_token in dev.');
        return devLogin(req, res);
      }

      return res.status(500).send('No access token from VATSIM.');
    }

    const userRes = await fetch(`${VATSIM_BASE}/api/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!userRes.ok) {
      const txt = await userRes.text();
      console.error('VATSIM user error:', userRes.status, txt);

      if (!isProd()) {
        console.warn('Using DEV login because user fetch failed in dev.');
        return devLogin(req, res);
      }

      return res.status(500).send('Failed to fetch VATSIM user profile.');
    }

    const userJson = await userRes.json();
    const data = userJson.data || {};

    const profile = {
      cid: String(data.cid),
      name:
        data.personal?.name_full ||
        `${data.personal?.name_first ?? ''} ${data.personal?.name_last ?? ''}`.trim(),
      rating: data.vatsim?.rating?.short || null,
      pilotRating: data.vatsim?.pilotrating?.short || null,
      division: data.vatsim?.division?.name || null,
    };

    const sid = createSession(profile);
    setSidCookie(res, sid);

    // Bootstrap – if access list is empty, auto allow first user
    if (ACCESS_CIDS.size === 0) {
      console.log('Bootstrap: adding first user to ACCESS_CIDS:', profile.cid);
      ACCESS_CIDS.add(profile.cid);
      saveAccessToDisk();
    }

    console.log('✅ VATSIM login success:', profile, 'sid=', sid);
    res.redirect('/');
  } catch (err) {
    console.error('VATSIM callback error:', err);

    if (!isProd()) {
      console.warn('Using DEV login because callback threw error in dev.');
      return devLogin(req, res);
    }

    res.status(500).send('Unexpected error during VATSIM login.');
  }
});

// 3) Who am I? + access info
app.get('/auth/me', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ authenticated: false });
  }

  const cid = String(session.user.cid);
  const isManager = ADMIN_CIDS.has(cid);

  // If ACCESS_CIDS is empty, treat everyone as allowed
  const isAllowed = ACCESS_CIDS.size === 0 || ACCESS_CIDS.has(cid);

  res.json({
    authenticated: true,
    authorized: isAllowed,
    isManager,
    user: session.user,
    accessListSize: ACCESS_CIDS.size,
  });
});

// 4) Logout
app.post('/auth/logout', (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) {
    sessions.delete(sid);
  }
  res.clearCookie('sid', {
    sameSite: 'lax',
    secure: isProd(),
    path: '/',
  });
  res.json({ ok: true });
});

// =======================
//   Access & Roles APIs
// =======================

// GET /access -> list allowed CIDs and admins
app.get('/access', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const cid = String(session.user.cid);
  if (!ADMIN_CIDS.has(cid)) {
    return res.status(403).json({ error: 'not_admin' });
  }

  res.json({
    ok: true,
    allowed: Array.from(ACCESS_CIDS),
    admins: Array.from(ADMIN_CIDS),
  });
});

// POST /access/add { cid: "1234567" }
app.post('/access/add', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const cid = String(session.user.cid);
  if (!ADMIN_CIDS.has(cid)) {
    return res.status(403).json({ error: 'not_admin' });
  }

  const { cid: newCid } = req.body || {};
  if (!newCid) {
    return res.status(400).json({ error: 'cid_required' });
  }

  ACCESS_CIDS.add(String(newCid));
  saveAccessToDisk();
  console.log(`👤 Admin ${cid} added access for CID ${newCid}`);
  res.json({
    ok: true,
    allowed: Array.from(ACCESS_CIDS),
    admins: Array.from(ADMIN_CIDS),
  });
});

// POST /access/remove { cid: "1234567" }
app.post('/access/remove', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const cid = String(session.user.cid);
  if (!ADMIN_CIDS.has(cid)) {
    return res.status(403).json({ error: 'not_admin' });
  }

  const { cid: remCid } = req.body || {};
  if (!remCid) {
    return res.status(400).json({ error: 'cid_required' });
  }

  ACCESS_CIDS.delete(String(remCid));
  saveAccessToDisk();
  console.log(`👤 Admin ${cid} removed access for CID ${remCid}`);
  res.json({
    ok: true,
    allowed: Array.from(ACCESS_CIDS),
    admins: Array.from(ADMIN_CIDS),
  });
});

// POST /access/add-admin { cid: "1234567" }
app.post('/access/add-admin', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const cid = String(session.user.cid);
  if (!ADMIN_CIDS.has(cid)) {
    return res.status(403).json({ error: 'not_admin' });
  }

  const { cid: newAdmin } = req.body || {};
  if (!newAdmin) {
    return res.status(400).json({ error: 'cid_required' });
  }

  ADMIN_CIDS.add(String(newAdmin));
  saveAccessToDisk();
  console.log(`👑 Admin ${cid} added ADMIN role for CID ${newAdmin}`);
  res.json({
    ok: true,
    allowed: Array.from(ACCESS_CIDS),
    admins: Array.from(ADMIN_CIDS),
  });
});

// POST /access/remove-admin { cid: "1234567" }
app.post('/access/remove-admin', (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const cid = String(session.user.cid);
  if (!ADMIN_CIDS.has(cid)) {
    return res.status(403).json({ error: 'not_admin' });
  }

  const { cid: remAdmin } = req.body || {};
  if (!remAdmin) {
    return res.status(400).json({ error: 'cid_required' });
  }

  ADMIN_CIDS.delete(String(remAdmin));
  saveAccessToDisk();
  console.log(`👑 Admin ${cid} removed ADMIN role for CID ${remAdmin}`);
  res.json({
    ok: true,
    allowed: Array.from(ACCESS_CIDS),
    admins: Array.from(ADMIN_CIDS),
  });
});

// =======================
//   Socket.IO board sync
// =======================

io.on('connection', (socket) => {
  console.log('🔌 client connected', socket.id);

  socket.on('board:pull', () => {
    socket.emit('board:state', boardState);
  });

  socket.on('item:add', ({ item, lane, index, mtime }) => {
    if (!item || !item.id || !lane || !boardState.lanes[lane]) return;

    const lanes = boardState.lanes;
    const items = boardState.items;

    items[item.id] = item;

    const laneArr = lanes[lane].filter((x) => x !== item.id);
    if (typeof index === 'number') {
      laneArr.splice(index, 0, item.id);
    } else {
      laneArr.unshift(item.id);
    }
    lanes[lane] = laneArr;

    boardState = {
      ...boardState,
      items,
      lanes,
      lastUpdated: mtime || Date.now(),
    };

    socket.broadcast.emit('item:add:apply', {
      item,
      lane,
      index,
      mtime: boardState.lastUpdated,
    });
  });

  socket.on('item:delete', ({ id, mtime }) => {
    if (!id || !boardState.items[id]) return;

    const items = { ...boardState.items };
    delete items[id];

    const lanes = { ...boardState.lanes };
    Object.keys(lanes).forEach((laneKey) => {
      lanes[laneKey] = lanes[laneKey].filter((x) => x !== id);
    });

    boardState = {
      ...boardState,
      items,
      lanes,
      lastUpdated: mtime || Date.now(),
    };

    socket.broadcast.emit('item:delete:apply', {
      id,
      mtime: boardState.lastUpdated,
    });
  });

  socket.on('item:patch', ({ id, patch, mtime }) => {
    if (!id || !patch || typeof patch !== 'object') return;
    const existing = boardState.items[id];
    if (!existing) return;
    boardState.items[id] = { ...existing, ...patch };
    boardState.lastUpdated = mtime || Date.now();
    socket.broadcast.emit('item:patch:apply', {
      id,
      patch,
      mtime: boardState.lastUpdated,
    });
  });

  socket.on('lanes:move', ({ id, from, to, index, mtime }) => {
    if (!id || !from || !to) return;
    const lanes = boardState.lanes;
    if (!lanes[from] || !lanes[to]) return;

    const fromArr = lanes[from].filter((x) => x !== id);
    const toArr = [...lanes[to]];
    if (typeof index === 'number') {
      toArr.splice(index, 0, id);
    } else {
      toArr.unshift(id);
    }

    boardState.lanes = { ...lanes, [from]: fromArr, [to]: toArr };
    boardState.lastUpdated = mtime || Date.now();

    socket.broadcast.emit('lanes:move:apply', {
      id,
      from,
      to,
      index,
      mtime: boardState.lastUpdated,
    });
  });

  socket.on('disconnect', () => {
    console.log('🔌 client disconnected', socket.id);
  });
});

// ---- Serve built client from /dist ----
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.use((_, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server + Socket.IO listening on :${PORT}`);
});
