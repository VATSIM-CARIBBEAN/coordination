import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { io, Socket } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

/* ===========================
   Types
=========================== */

type AuthedUser = {
  cid: string;
  name: string;
  rating?: string | null;
  pilotRating?: string | null;
  division?: string | null;
};

type MeResponse = {
  authenticated: boolean;
  authorized?: boolean;
  isManager?: boolean;
  user?: AuthedUser;
  accessListSize?: number;
};

interface VatsimPilot {
  callsign: string;
  altitude: number;
  groundspeed: number;
  heading: number | null;
  latitude: number;
  longitude: number;
  planned_depairport?: string | null;
  planned_destairport?: string | null;
  flight_plan?: {
    departure?: string | null;
    arrival?: string | null;
    altitude?: string | null;
    route?: string | null;
  } | null;
}

interface BoardItemFields {
  callsign: string;
  waypoint: string;
  estimate: string;        // Pilot estimate (HHMM)
  centerEstimate?: string; // Center estimate (HHMM)
  altitude: string;        // FL###
  mach: string;            // M##
  squawk: string;          // transponder / squawk code
}

interface BoardItem extends BoardItemFields {
  id: string;
  source: "manual" | "vatsim";
  routeWaypoints: string[];
}

type LaneKey = "Unassigned" | "New York" | "Curacao" | "Piarco" | "Maiquetia";

interface BoardState {
  lanes: Record<LaneKey, string[]>;
  items: Record<string, BoardItem>;
  lastUpdated: number;
}

/* ===========================
   Config
=========================== */

const DEFAULT_LANES: Record<LaneKey, string[]> = {
  Unassigned: [],
  "New York": [],
  Curacao: [],
  Piarco: [],
  Maiquetia: [],
};

const LANE_FIXES: Partial<Record<LaneKey, string[]>> = {
  Curacao: ["Select", "SCAPA"],
  Maiquetia: ["Select", "ARMUR", "MILOK", "KIKER"],
  Piarco: ["Select", "ANADA", "GEECE", "ILURI", "MODUX", "GABAR", "ZPATA", "ELOPO", "LAMKN"],
  "New York": ["Select", "DAWIN", "OBIKE", "SOCCO", "OPAUL", "KEEKA", "CHEDR", "HANCY", "FERNA", "KINCH", "CRUPE", "BAROE"],
};

const FIX_COORDS: Record<string, { lat: number; lon: number }> = {
  // Curacao
  SCAPA: { lat: 15.834139, lon: -67.5 },

  // Maiquetia
  ARMUR: { lat: 15.543333, lon: -66.635 },
  MILOK: { lat: 15.293333, lon: -65.88 },
  KIKER: { lat: 15.098372, lon: -65.294847 },

  // Piarco
  ANADA: { lat: 15.0, lon: -64.146247 },
  GEECE: { lat: 15.0, lon: -63.25 },
  ILURI: { lat: 16.301111, lon: -63.0 },
  MODUX: { lat: 16.958889, lon: -63.0 },
  GABAR: { lat: 17.353333, lon: -63.0 },
  ZPATA: { lat: 17.473056, lon: -62.833056 },
  ELOPO: { lat: 17.650056, lon: -62.554389 },
  LAMKN: { lat: 18.0, lon: -61.966111 },

  // New York
  DAWIN: { lat: 20.538769, lon: -62.457578 },
  OBIKE: { lat: 19.341283, lon: -61.767164 },
  SOCCO: { lat: 21.116403, lon: -63.061878 },
  OPAUL: { lat: 21.856597, lon: -63.846578 },
  KEEKA: { lat: 22.097069, lon: -65.134825 },
  CHEDR: { lat: 22.046697, lon: -66.009619 },
  HANCY: { lat: 22.036886, lon: -66.170619 },
  FERNA: { lat: 21.768772, lon: -67.021481 },
  KINCH: { lat: 21.621478, lon: -67.197817 },
  CRUPE: { lat: 22.043089, lon: -66.061208 },
  BAROE: { lat: 22.059194, lon: -65.793025 },
};

// Dev: override with VITE_SOCKET_URL, default http://localhost:3000
// Prod: same-origin (served by server.mjs)
const SOCKET_URL =
  import.meta.env.DEV
    ? ((import.meta as any)?.env?.VITE_SOCKET_URL || "http://localhost:3000")
    : window.location.origin;

/* ===========================
   Helpers (formatting, math)
=========================== */

function parseWaypointsFromRoute(route?: string | null): string[] {
  if (!route) return [];
  const toks = route
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .filter((t) => /^[A-Z0-9]{2,7}$/.test(t));
  return Array.from(new Set(toks));
}

function callsignMatch(a: string, b: string) {
  return a.toLowerCase().includes(b.toLowerCase());
}

function getFixOptions(lane: LaneKey, item: BoardItem): string[] {
  const fixed = LANE_FIXES[lane];
  if (fixed && fixed.length) return fixed;
  return item.routeWaypoints?.length ? item.routeWaypoints : ["—"];
}

// Keep only digits
const digits = (s: string) => (s || "").replace(/\D+/g, "");

// HHMM (4 digits)
function fmtHHMM(input: string): string {
  return digits(input).slice(0, 4);
}

// FL + up to 3 digits (FL350)
function fmtFL(input: string): string {
  const d = digits(input).slice(0, 3);
  return d ? `FL${d}` : "";
}

// M + up to 2 digits (M82)
function fmtMach(input: string): string {
  const d = digits(input).slice(0, 2);
  return d ? `M${d}` : "";
}

function parseHHMMToMinutes(hhmm: string): number | null {
  const s = (hhmm || "").trim();
  if (s.length !== 4) return null;
  const hh = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  if (
    Number.isNaN(hh) ||
    Number.isNaN(mm) ||
    hh < 0 ||
    hh > 23 ||
    mm < 0 ||
    mm > 59
  ) {
    return null;
  }
  return hh * 60 + mm;
}

function diffMinutes(hhmmA: string, hhmmB: string): number | null {
  const a = parseHHMMToMinutes(hhmmA);
  const b = parseHHMMToMinutes(hhmmB);
  if (a == null || b == null) return null;
  return Math.abs(a - b);
}

/**
 * Great-circle distance (Haversine) in nautical miles.
 */
function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R_nm = 3440.065; // Earth radius in NM

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_nm * c;
}

/**
 * Compute Center Estimate HHMM from VATSIM pilot + fix coordinates.
 */
function computeCenterEstimateFromPilot(
  pilot: VatsimPilot | undefined,
  waypoint: string
): string | undefined {
  if (!pilot) return undefined;
  if (!waypoint) return undefined;
  const fix = FIX_COORDS[waypoint];
  if (!fix) return undefined;

  const gs = pilot.groundspeed || 0;
  if (gs <= 0) return undefined;

  const distanceNm = haversineNm(pilot.latitude, pilot.longitude, fix.lat, fix.lon);
  const hours = distanceNm / gs;
  const minutes = Math.round(hours * 60);
  if (!Number.isFinite(minutes)) return undefined;

  const now = new Date();
  const eta = new Date(now.getTime() + minutes * 60_000);
  const hh = String(eta.getUTCHours()).padStart(2, "0");
  const mm = String(eta.getUTCMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

/* ===========================
   VATSIM data hook (15s)
=========================== */

function useVatsimPilots() {
  const [pilots, setPilots] = useState<VatsimPilot[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function fetchPilots() {
    try {
      setLoading(true);
      setErr(null);
      const res = await fetch("https://data.vatsim.net/v3/vatsim-data.json", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const list: VatsimPilot[] = (data?.pilots || []).map((p: any) => ({
        callsign: p.callsign,
        altitude: p.altitude ?? 0,
        groundspeed: p.groundspeed ?? 0,
        heading: p.heading ?? null,
        latitude: p.latitude,
        longitude: p.longitude,
        planned_depairport: p.planned_depairport ?? p.flight_plan?.departure ?? null,
        planned_destairport: p.planned_destairport ?? p.flight_plan?.arrival ?? null,
        flight_plan: p.flight_plan ?? null,
      }));
      setPilots(list);
    } catch (e: any) {
      setErr(e?.message || "Failed to load VATSIM data");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPilots();
    const id = setInterval(fetchPilots, 15_000); // 15 seconds
    return () => clearInterval(id);
  }, []);

  return { pilots, loading, err };
}

/* ===========================
   Realtime sync (Socket.IO)
=========================== */

function useRealtimeSync(
  setState: React.Dispatch<React.SetStateAction<BoardState>>
) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(SOCKET_URL);
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("board:pull");
    });

    // Initial full board from server
    socket.on("board:state", (incoming: BoardState) => {
      const cleanedLanes: Record<LaneKey, string[]> = { ...incoming.lanes } as any;
      (Object.keys(cleanedLanes) as LaneKey[]).forEach((laneKey) => {
        cleanedLanes[laneKey] = cleanedLanes[laneKey].filter(
          (id) => !!incoming.items[id]
        );
      });
      setState({
        ...incoming,
        lanes: cleanedLanes,
      });
    });

    socket.on("item:add:apply", ({ item, lane, index, mtime }: any) => {
      setState((prev) => {
        const items = { ...prev.items, [item.id]: item };
        const lanes = { ...prev.lanes } as Record<LaneKey, string[]>;
        if (!lanes[lane]) return prev;

        const laneArr = lanes[lane].filter((x) => x !== item.id);
        if (typeof index === "number") {
          laneArr.splice(index, 0, item.id);
        } else {
          laneArr.unshift(item.id);
        }
        lanes[lane] = laneArr;

        return {
          ...prev,
          items,
          lanes,
          lastUpdated: mtime || Date.now(),
        };
      });
    });

    socket.on("item:delete:apply", ({ id, mtime }: any) => {
      setState((prev) => {
        if (!prev.items[id]) return prev;

        const items = { ...prev.items };
        delete items[id];

        const lanes = { ...prev.lanes } as Record<LaneKey, string[]>;
        (Object.keys(lanes) as LaneKey[]).forEach((k) => {
          lanes[k] = lanes[k].filter((x) => x !== id);
        });

        return {
          ...prev,
          items,
          lanes,
          lastUpdated: mtime || Date.now(),
        };
      });
    });

    socket.on("item:patch:apply", ({ id, patch, mtime }: any) => {
      setState((prev) => {
        if (!prev.items[id]) return prev;
        return {
          ...prev,
          items: { ...prev.items, [id]: { ...prev.items[id], ...patch } },
          lastUpdated: mtime || Date.now(),
        };
      });
    });

    socket.on("lanes:move:apply", ({ id, from, to, index, mtime }: any) => {
      setState((prev) => {
        if (!prev.lanes[from] || !prev.lanes[to]) return prev;
        const fromArr = prev.lanes[from].filter((x) => x !== id);
        const toArr = [...prev.lanes[to]];
        if (typeof index === "number") {
          toArr.splice(index, 0, id);
        } else {
          toArr.unshift(id);
        }
        return {
          ...prev,
          lanes: { ...prev.lanes, [from]: fromArr, [to]: toArr },
          lastUpdated: mtime || Date.now(),
        };
      });
    });

    return () => socket.disconnect();
  }, [setState]);

  function sendItemAdd(item: BoardItem, lane: LaneKey, index?: number) {
    socketRef.current?.emit("item:add", {
      item,
      lane,
      index,
      mtime: Date.now(),
    });
  }

  function sendItemDelete(id: string) {
    socketRef.current?.emit("item:delete", { id, mtime: Date.now() });
  }

  function sendItemPatch(id: string, patch: Partial<BoardItemFields>) {
    socketRef.current?.emit("item:patch", { id, patch, mtime: Date.now() });
  }

  function sendMove(id: string, from: LaneKey, to: LaneKey, index?: number) {
    socketRef.current?.emit("lanes:move", { id, from, to, index, mtime: Date.now() });
  }

  return { sendItemAdd, sendItemDelete, sendItemPatch, sendMove };
}

/* ===========================
   Roles Page (admin only)
=========================== */

function RolesPage({ auth }: { auth: MeResponse }) {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [admins, setAdmins] = useState<string[]>([]);
  const [newAccessCid, setNewAccessCid] = useState("");
  const [newAdminCid, setNewAdminCid] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadAccess() {
    try {
      setLoading(true);
      const res = await fetch("/access", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setAllowed(data.allowed || []);
        setAdmins(data.admins || []);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (auth.isManager) {
      loadAccess();
    }
  }, [auth.isManager]);

  if (!auth.isManager) {
    return (
      <div className="search-card dark-panel" style={{ marginTop: 16 }}>
        <div className="card-header-row">
          <div className="brand">Roles</div>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          You don&apos;t have permission to manage roles.
        </p>
      </div>
    );
  }

  async function addAccess() {
    if (!newAccessCid.trim()) return;
    const res = await fetch("/access/add", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid: newAccessCid.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setAllowed(data.allowed || []);
      setAdmins(data.admins || []);
      setNewAccessCid("");
    }
  }

  async function removeAccess(cid: string) {
    const res = await fetch("/access/remove", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
    });
    if (res.ok) {
      const data = await res.json();
      setAllowed(data.allowed || []);
      setAdmins(data.admins || []);
    }
  }

  async function addAdmin() {
    if (!newAdminCid.trim()) return;
    const res = await fetch("/access/add-admin", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid: newAdminCid.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setAllowed(data.allowed || []);
      setAdmins(data.admins || []);
      setNewAdminCid("");
    }
  }

  async function removeAdmin(cid: string) {
    const res = await fetch("/access/remove-admin", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
    });
    if (res.ok) {
      const data = await res.json();
      setAllowed(data.allowed || []);
      setAdmins(data.admins || []);
    }
  }

  return (
    <div className="search-card dark-panel roles-card">
      <div className="card-header-row">
        <div>
          <div className="brand">Roles &amp; Access</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            Control who can use the coordination board and who can manage roles.
          </div>
        </div>
        {loading && <div className="pill pill-soft">Syncing…</div>}
      </div>

      <div className="roles-grid">
        {/* Access list */}
        <div className="roles-section">
          <div className="roles-section-header">
            <div>
              <div className="roles-title">Access List</div>
              <div className="muted" style={{ fontSize: 11 }}>
                CIDs allowed to use the board.
              </div>
            </div>
          </div>

          <div className="roles-input-row">
            <input
              className="input-sm roles-input"
              placeholder="CID"
              value={newAccessCid}
              onChange={(e) => setNewAccessCid(e.target.value)}
            />
            <button className="btn-small" onClick={addAccess} disabled={loading}>
              Add
            </button>
          </div>

          <div className="chip-row">
            {allowed.map((cid) => (
              <span key={cid} className="chip chip-access">
                <span>{cid}</span>
                <button
                  onClick={() => removeAccess(cid)}
                  className="chip-remove"
                  title="Remove from access list"
                >
                  ×
                </button>
              </span>
            ))}
            {allowed.length === 0 && !loading && (
              <span className="muted" style={{ fontSize: 11 }}>
                No CIDs configured – everyone is allowed by default.
              </span>
            )}
          </div>
        </div>

        {/* Admin list */}
        <div className="roles-section">
          <div className="roles-section-header">
            <div>
              <div className="roles-title">Admins</div>
              <div className="muted" style={{ fontSize: 11 }}>
                CIDs that can edit this page.
              </div>
            </div>
          </div>

          <div className="roles-input-row">
            <input
              className="input-sm roles-input"
              placeholder="CID"
              value={newAdminCid}
              onChange={(e) => setNewAdminCid(e.target.value)}
            />
            <button className="btn-small" onClick={addAdmin} disabled={loading}>
              Add
            </button>
          </div>

          <div className="chip-row">
            {admins.map((cid) => (
              <span key={cid} className="chip chip-admin">
                <span>{cid}</span>
                <button
                  onClick={() => removeAdmin(cid)}
                  className="chip-remove"
                  title="Remove admin role"
                >
                  ×
                </button>
              </span>
            ))}
            {admins.length === 0 && !loading && (
              <span className="muted" style={{ fontSize: 11 }}>
                No admins configured yet.
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===========================
   Sortable Card
=========================== */

type SortableCardProps = {
  id: string;
  laneKey: LaneKey;
  item: BoardItem;
  pilots: VatsimPilot[];
  onChange: (patch: Partial<BoardItemFields>) => void;
  onDelete: () => void;
  [key: string]: any;
};

function SortableCard({ id, laneKey, item, pilots, onChange, onDelete }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  };

  const [copied, setCopied] = useState(false);

  // Pilot estimate: local input state, only sync on blur/Enter
  const pilotEstimate = item.estimate;
  const [localPilotEstimate, setLocalPilotEstimate] = useState(pilotEstimate);

  useEffect(() => {
    setLocalPilotEstimate(pilotEstimate);
  }, [pilotEstimate]);

  async function handleCopy() {
    const fix = item.waypoint || "—";
    const estimate = item.estimate || "—";
    const altitude = item.altitude || "—";
    const squawk = item.squawk || "—";
    const text = `${item.callsign} ${fix} ${estimate} ${altitude} ${squawk}`;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy failed", e);
    }
  }

  const showFix = laneKey !== "Unassigned";
  const options = getFixOptions(laneKey, item);
  const valid = options.includes(item.waypoint) || item.waypoint === "";

  useEffect(() => {
    if (!valid && showFix) onChange({ waypoint: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneKey]);

  // Center estimate + color
  const centerEstimate = item.centerEstimate || "";

  useEffect(() => {
    if (!item.waypoint) return;

    const pilot = pilots.find(
      (p) => p.callsign.toUpperCase() === item.callsign.toUpperCase()
    );

    const computed = computeCenterEstimateFromPilot(pilot, item.waypoint);
    if (!computed) return;

    if (computed !== item.centerEstimate) {
      onChange({ centerEstimate: computed });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.waypoint, pilots]);

  let centerEstimateClassName = "input-sm center-estimate-display";

  if (pilotEstimate && centerEstimate) {
    const diff = diffMinutes(pilotEstimate, centerEstimate);
    if (diff != null) {
      if (diff <= 3) {
        centerEstimateClassName += " center-estimate--match";
      } else {
        centerEstimateClassName += " center-estimate--mismatch";
      }
    }
  }

  return (
    <div ref={setNodeRef} style={style} className="card dark-card">
      <div className="card-top" {...attributes} {...listeners}>
        <div className="callsign">{item.callsign}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="copy" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <button className="remove" onClick={onDelete}>
            Remove
          </button>
        </div>
      </div>

      <div className="grid">
        {showFix && (
          <div>
            <label className="label">Fix</label>
            <select
              className="input-sm"
              value={valid ? item.waypoint : ""}
              onChange={(e) => onChange({ waypoint: e.target.value })}
            >
              {options.map((w) => (
                <option key={w} value={w === "—" ? "" : w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="label">Pilot Estimate (HHMM)</label>
          <input
            className="input-sm"
            placeholder="HHMM"
            value={localPilotEstimate}
            onChange={(e) => setLocalPilotEstimate(fmtHHMM(e.target.value))}
            onBlur={() => {
              if (localPilotEstimate !== pilotEstimate) {
                onChange({ estimate: localPilotEstimate });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>

        <div>
          <label className="label">Center Estimate (HHMM)</label>
          <div className={centerEstimateClassName}>
            {centerEstimate || "----"}
          </div>
        </div>

        <div>
          <label className="label">Altitude</label>
          <input
            className="input-sm"
            placeholder="FL350"
            value={item.altitude}
            onChange={(e) => onChange({ altitude: fmtFL(e.target.value) })}
          />
        </div>

        <div>
          <label className="label">Mach</label>
          <input
            className="input-sm"
            placeholder="M82"
            value={item.mach}
            onChange={(e) => onChange({ mach: fmtMach(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}

/* ===========================
   Lane (droppable)
=========================== */

type LaneProps = {
  laneKey: LaneKey;
  ids: string[];
  items: Record<string, BoardItem>;
  pilots: VatsimPilot[];
  onPatch: (id: string, patch: Partial<BoardItemFields>) => void;
  onDelete: (id: string) => void;
  [key: string]: any;
};

function Lane({ laneKey, ids, items, pilots, onPatch, onDelete }: LaneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: laneKey });

  return (
    <div className="lane dark-lane">
      <div className="lane-head">
        <div className="lane-title">
          <span>{laneKey}</span>
        </div>
        <div className="count">{ids.length}</div>
      </div>

      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="lane-dropzone"
          style={{
            minHeight: 60,
            outline: isOver ? "2px dashed var(--accent)" : "none",
            outlineOffset: 4,
            borderRadius: 10,
            padding: 2,
          }}
        >
          {ids.map((id) => {
            const item = items[id];
            if (!item) {
              console.warn("Lane has id with no item", laneKey, id);
              return null;
            }
            return (
              <SortableCard
                key={id}
                id={id}
                laneKey={laneKey}
                item={item}
                pilots={pilots}
                onChange={(patch) => onPatch(id, patch)}
                onDelete={() => onDelete(id)}
              />
            );
          })}
        </div>
      </SortableContext>
    </div>
  );
}

/* ===========================
   Main App
=========================== */

type View = "board" | "roles";

export default function App() {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );
  const { pilots, loading, err } = useVatsimPilots();

  const [auth, setAuth] = useState<MeResponse | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [view, setView] = useState<View>("board");

  // Load auth status
  useEffect(() => {
    async function loadMe() {
      try {
        const res = await fetch("/auth/me", { credentials: "include" });
        if (!res.ok) {
          setAuth({ authenticated: false });
        } else {
          const data = await res.json();
          setAuth(data);
        }
      } catch (e) {
        setAuth({ authenticated: false });
      } finally {
        setAuthChecking(false);
      }
    }
    loadMe();
  }, []);

  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => pilots.filter((p) => callsignMatch(p.callsign, query)).slice(0, 50),
    [pilots, query]
  );

  const [state, setState] = useState<BoardState>({
    lanes: { ...DEFAULT_LANES },
    items: {},
    lastUpdated: Date.now(),
  });

  const { sendItemAdd, sendItemDelete, sendItemPatch, sendMove } = useRealtimeSync(setState);

  // ---- CRUD ----
  function addPilotToUnassigned(p: VatsimPilot) {
    const exists = (Object.values(state.items) as BoardItem[]).some(
      (x) => x.callsign.toLowerCase() === p.callsign.toLowerCase()
    );
    if (exists) return;

    const id = uuidv4();
    const item: BoardItem = {
      id,
      source: "vatsim",
      callsign: p.callsign,
      waypoint: "",
      estimate: "",
      centerEstimate: "",
      altitude: fmtFL(p.flight_plan?.altitude || String(p.altitude || "")),
      mach: "",
      squawk: (p as any)?.flight_plan?.assigned_transponder || "",
      routeWaypoints: parseWaypointsFromRoute(p.flight_plan?.route ?? ""),
    };

    setState((prev) => ({
      ...prev,
      items: { ...prev.items, [id]: item },
      lanes: { ...prev.lanes, Unassigned: [id, ...prev.lanes.Unassigned] },
      lastUpdated: Date.now(),
    }));

    sendItemAdd(item, "Unassigned");
  }

  function patchItem(id: string, patch: Partial<BoardItemFields>) {
    setState((prev) => ({
      ...prev,
      items: { ...prev.items, [id]: { ...prev.items[id], ...patch } },
      lastUpdated: Date.now(),
    }));
    sendItemPatch(id, patch);
  }

  function deleteItem(id: string) {
    setState((prev) => {
      const items = { ...prev.items };
      delete items[id];
      const lanes: Record<LaneKey, string[]> = { ...prev.lanes } as any;
      (Object.keys(lanes) as LaneKey[]).forEach((k) => {
        lanes[k] = lanes[k].filter((x) => x !== id);
      });
      return { ...prev, items, lanes, lastUpdated: Date.now() };
    });
    sendItemDelete(id);
  }

  // ---- DnD: cross-lane + reorder ----
  function moveItem(id: string, from: LaneKey, to: LaneKey, index?: number) {
    setState((prev) => {
      const fromArr = prev.lanes[from].filter((x) => x !== id);
      const toArr = [...prev.lanes[to]];
      if (typeof index === "number") {
        toArr.splice(index, 0, id);
      } else {
        toArr.unshift(id);
      }
      return {
        ...prev,
        lanes: { ...prev.lanes, [from]: fromArr, [to]: toArr },
        lastUpdated: Date.now(),
      };
    });
    sendMove(id, from, to, index);
  }

  function reorderInLane(lane: LaneKey, oldIndex: number, newIndex: number) {
    setState((prev) => ({
      ...prev,
      lanes: { ...prev.lanes, [lane]: arrayMove(prev.lanes[lane], oldIndex, newIndex) },
      lastUpdated: Date.now(),
    }));
  }

  function handleDragStart(_event: any) {}

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (!over) return;

    const laneKeys = Object.keys(state.lanes) as LaneKey[];

    const origin = laneKeys.find((l) => state.lanes[l].includes(active.id)) as
      | LaneKey
      | undefined;

    const overLane = laneKeys.find(
      (k) => k === over.id || state.lanes[k].includes(over.id)
    ) as LaneKey | undefined;

    if (!origin || !overLane) return;

    if (origin === overLane) {
      const oldIndex = state.lanes[origin].indexOf(active.id);
      const newIndex =
        over.id === origin
          ? state.lanes[origin].length - 1
          : state.lanes[origin].indexOf(over.id);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        reorderInLane(origin, oldIndex, newIndex);
      }
    } else {
      const targetIndex =
        over.id === overLane
          ? state.lanes[overLane].length
          : state.lanes[overLane].indexOf(over.id);

      moveItem(
        active.id,
        origin,
        overLane,
        targetIndex === -1 ? undefined : targetIndex
      );
    }
  }

  // ---- Auth gating ----
  if (authChecking || !auth) {
    return (
      <div className="dark-root">
        <div className="container" style={{ paddingTop: 80 }}>
          <div className="search-card dark-panel">
            <div className="brand" style={{ marginBottom: 8 }}>Coordination Board</div>
            <div className="muted">Checking login…</div>
          </div>
        </div>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="dark-root">
        <div className="container login-page">
          <div className="search-card dark-panel login-card">
            <div className="brand" style={{ marginBottom: 8 }}>Coordination Board</div>
            <p className="muted" style={{ marginBottom: 16 }}>
              Sign in with your VATSIM account to access the board.
            </p>
            <a className="pill dark-pill login-button" href="/auth/login">
              Log in with VATSIM
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (auth.authorized === false) {
    return (
      <div className="dark-root">
        <div className="container login-page">
          <div className="search-card dark-panel login-card">
            <div className="brand" style={{ marginBottom: 8 }}>Access denied</div>
            <p className="muted" style={{ marginBottom: 8 }}>
              Your CID <strong>{auth.user?.cid}</strong> isn&apos;t on the allowed list.
            </p>
            <p className="muted" style={{ fontSize: 11 }}>
              Contact a system admin to be added.
            </p>
          </div>
        </div>
      </div>
    );
  }

  async function handleLogout() {
    try {
      await fetch("/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (_) {
      // ignore
    } finally {
      window.location.href = "/";
    }
  }

  return (
    <div className="dark-root">
      {/* Top bar */}
      <div className="top dark-top">
        <div className="inner container">
          <div className="brand">Coordination Board</div>
          <div className="top-right">
            <div className="top-row">
              {view === "board" && (
                <input
                  className="input dark-input"
                  placeholder="Search callsign (e.g., JBU123)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              <div className="muted top-pilots">
                {loading
                  ? "Loading…"
                  : err
                    ? `Error: ${err}`
                    : `${pilots.length.toLocaleString()} pilots online`}
              </div>
            </div>

            <div className="top-row user-row">
              <div className="user-pill">
                <div className="user-name">{auth.user?.name}</div>
                <div className="user-meta">
                  {auth.user?.cid}
                  {auth.user?.rating ? ` · ${auth.user?.rating}` : ""}
                </div>
              </div>
              <button className="btn-small btn-ghost" onClick={handleLogout}>
                Logout
              </button>
            </div>

            {auth.isManager && (
              <div className="top-row">
                <button
                  className={`pill top-tab ${view === "board" ? "top-tab-active" : ""}`}
                  onClick={() => setView("board")}
                >
                  Board
                </button>
                <button
                  className={`pill top-tab ${view === "roles" ? "top-tab-active" : ""}`}
                  onClick={() => setView("roles")}
                >
                  Roles
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="container" style={{ marginTop: 12 }}>
        {view === "roles" && auth.isManager && (
          <RolesPage auth={auth} />
        )}

        {view === "board" && (
          <>
            {!!query && (
              <div className="search-card dark-panel">
                <div style={{ marginBottom: 6 }} className="muted">
                  Search Results
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {filtered.map((p) => (
                    <button
                      key={p.callsign}
                      className="pill dark-pill"
                      onClick={() => addPilotToUnassigned(p)}
                      title={`${
                        p.planned_depairport || p.flight_plan?.departure || "?"
                      } → ${
                        p.planned_destairport || p.flight_plan?.arrival || "?"
                      }`}
                    >
                      {p.callsign}
                    </button>
                  ))}
                  {!filtered.length && <div className="muted">No matches</div>}
                </div>
              </div>
            )}

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <div className="board">
                {(Object.keys(state.lanes) as LaneKey[]).map((laneKey) => (
                  <Lane
                    key={laneKey}
                    laneKey={laneKey}
                    ids={state.lanes[laneKey]}
                    items={state.items}
                    pilots={pilots}
                    onPatch={patchItem}
                    onDelete={deleteItem}
                  />
                ))}
              </div>
            </DndContext>
          </>
        )}
      </div>
    </div>
  );
}

/* ===========================
   Dark theme styles (inline)
=========================== */
const styleId = "coord-board-dark-styles";
if (!document.getElementById(styleId)) {
  const el = document.createElement("style");
  el.id = styleId;
  el.innerHTML = `
:root{
  --bg:#0b1020; --panel:#0e162b; --panel2:#0b1426; --card:#101a33;
  --text:#e7efff; --muted:#94a3b8; --accent:#60a5fa; --danger:#ef4444; --border:rgba(255,255,255,.10);
}
*{box-sizing:border-box}
body{margin:0}
.dark-root{min-height:100vh;background:radial-gradient(circle at top,#1f2937 0,#020617 55%,#000 100%);color:var(--text);font-family:Inter,system-ui,Arial,Helvetica}
.container{max-width:1000px;margin:0 auto;padding:16px}
.muted{color:var(--muted);font-size:12px}
.top{position:sticky;top:0;z-index:10}
.dark-top{background:rgba(9,14,28,.85);backdrop-filter:blur(14px);border-bottom:1px solid var(--border)}
.top .inner{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 16px}
.brand{font-weight:800;color:#cfe1ff;letter-spacing:.02em}
.input{border:1px solid var(--border);border-radius:12px;padding:8px 10px;min-width:240px;font-size:13px}
.dark-input{background:#020617;color:var(--text)}
.search-card{border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:12px}
.dark-panel{background:linear-gradient(180deg,var(--panel),var(--panel2))}
.pill{border:1px solid var(--border);border-radius:999px;padding:8px 12px;cursor:pointer;font-size:12px}
.dark-pill{background:#02091b;color:var(--text)}
.board{display:flex;flex-direction:column;gap:16px;margin-top:16px}
.lane{border:1px solid var(--border);border-radius:16px;padding:14px;box-shadow:0 16px 30px rgba(0,0,0,.4)}
.dark-lane{background:linear-gradient(180deg,var(--panel),var(--panel2))}
.lane-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.lane-title{font-weight:600;font-size:13px;letter-spacing:.02em;text-transform:uppercase;color:#cbd5f5}
.count{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:2px 8px;background:rgba(15,23,42,.8)}
.card{border:1px solid var(--border);border-radius:14px;padding:12px;margin-bottom:10px;box-shadow:0 12px 24px rgba(0,0,0,.35)}
.dark-card{background:radial-gradient(circle at top left,#111827,#020617)}
.card-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.callsign{font-weight:800;letter-spacing:.15em;font-size:13px;cursor:grab;text-transform:uppercase}
.remove{font-size:11px;border:1px solid rgba(239,68,68,.35);color:#fecaca;background:rgba(239,68,68,.1);padding:6px 10px;border-radius:999px;cursor:pointer}
.copy{font-size:11px;border:1px solid rgba(96,165,250,.35);color:#cfe1ff;background:rgba(59,130,246,.16);padding:6px 10px;border-radius:999px;cursor:pointer}
.grid{display:grid;gap:10px;margin-top:6px}
@media(min-width:740px){.grid{grid-template-columns:repeat(4,1fr)}}
.label{display:block;font-size:10px;color:#9fb3df;margin-bottom:3px;text-transform:uppercase;letter-spacing:.06em}
.input-sm,select{width:100%;border:1px solid var(--border);border-radius:10px;padding:7px 9px;background:#020617;color:#e7efff;font-size:12px}

/* Center Estimate colored display */
.center-estimate-display{
  display:flex;
  align-items:center;
  justify-content:center;
  border-radius:10px;
  min-height:34px;
  padding:6px 10px;
  background:#020617;
  border:1px solid var(--border);
  font-family:monospace;
  letter-spacing:.08em;
}

/* pilot estimate within 3 minutes of center estimate -> green */
.center-estimate--match{
  background:#14532d;
  border-color:#22c55e;
}

/* pilot estimate more than 3 minutes away from center estimate -> red */
.center-estimate--mismatch{
  background:#7f1d1d;
  border-color:#ef4444;
}

/* Top bar layout */
.top-right{display:flex;flex-direction:column;gap:6px;align-items:flex-end}
.top-row{display:flex;gap:8px;align-items:center}
.top-pilots{white-space:nowrap}
.user-row{justify-content:flex-end}
.user-pill{padding:4px 10px;border-radius:999px;background:rgba(15,23,42,.85);border:1px solid rgba(148,163,184,.3);display:flex;flex-direction:column;align-items:flex-start;min-width:0}
.user-name{font-size:11px;font-weight:600;white-space:nowrap}
.user-meta{font-size:10px;color:var(--muted)}
.btn-small{font-size:11px;border-radius:999px;padding:6px 10px;border:1px solid rgba(148,163,184,.4);background:rgba(15,23,42,.9);color:#e5e7eb;cursor:pointer}
.btn-ghost{background:transparent}
.top-tab{padding:4px 12px;font-size:11px;border-radius:999px;background:rgba(15,23,42,.8)}
.top-tab-active{background:rgba(37,99,235,.22);border-color:rgba(96,165,250,.75)}

/* Roles page */
.roles-card{margin-top:16px}
.card-header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.roles-grid{display:grid;gap:14px;margin-top:4px}
@media(min-width:780px){.roles-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.roles-section{border-radius:12px;padding:10px 10px 8px 10px;background:rgba(15,23,42,.9);border:1px solid rgba(148,163,184,.25)}
.roles-section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.roles-title{font-size:13px;font-weight:600;color:#e5edff}
.roles-input-row{display:flex;gap:6px;margin-bottom:8px}
.roles-input{max-width:140px}
.chip-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 9px;font-size:11px;border:1px solid rgba(148,163,184,.4);background:rgba(15,23,42,.95)}
.chip-access{border-color:rgba(34,197,94,.4);background:rgba(22,101,52,.25)}
.chip-admin{border-color:rgba(59,130,246,.55);background:rgba(37,99,235,.22)}
.chip-remove{border:none;background:transparent;color:#fecaca;cursor:pointer;font-size:12px;line-height:1}
.pill-soft{border-radius:999px;padding:4px 10px;font-size:11px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.7)}
.login-page{display:flex;justify-content:center;align-items:center;min-height:100vh;max-width:460px}
.login-card{width:100%;box-shadow:0 20px 40px rgba(0,0,0,.6)}
.login-button{text-align:center;display:inline-block;width:100%;justify-content:center;font-weight:500;margin-top:4px}
`;
  document.head.appendChild(el);
}
