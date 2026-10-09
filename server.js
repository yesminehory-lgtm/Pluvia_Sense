"use strict";
// AquaMind Flood Watch — zero-dependency Node backend (Node >= 18)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = +process.env.PORT || 3000, DATA = process.env.DATA_DIR || path.join(__dirname, "data"), PUB = path.join(__dirname, "public");
const OPS = process.env.OPS_TOKEN || crypto.randomBytes(6).toString("hex");   // decision-makers' access code
const DEV = process.env.DEVICE_KEY || crypto.randomBytes(8).toString("hex");  // sensors' API key
const RISK = ["Normal", "Watch", "Warning", "Critical"], TYPES = ["Flooding", "Blocked drain", "Road cut off", "Accident", "Other"];
const STAT = ["New", "Verified", "Acknowledged", "Dispatched", "Resolved"], BOX = { lat: [36.5, 37.15], lon: [9.8, 10.75] };
fs.mkdirSync(path.join(DATA, "media"), { recursive: true });
const DBF = path.join(DATA, "db.json"); let db = { reports: [], alerts: [] };
try { db = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch (e) {}
let tm; const save = () => { clearTimeout(tm); tm = setTimeout(() => fs.writeFile(DBF, JSON.stringify(db), () => {}), 400); };
const media = n => path.join(DATA, "media", n);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dist = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371e3; };
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
// Monitoring points: proposed placement in flood-prone areas of Greater Tunis (id must match the device's configured node id)
const NODES = [["Lac 2 outfall", 36.835, 10.27, 90], ["Ennasr / Ariana", 36.865, 10.16, 100], ["Manouba centre", 36.81, 10.095, 110], ["Sijoumi basin", 36.79, 10.136, 120],
  ["Ettadhamen", 36.835, 10.1, 100], ["Ben Arous", 36.753, 10.23, 110], ["Mégrine", 36.77, 10.233, 90], ["Oued Méliane", 36.72, 10.29, 130]]
  .map(([name, lat, lon, thr], i) => ({ id: "N" + (i + 1), name, lat, lon, thr, L: 14 + i, real: 0, f3: 0, boost: 0, rain: 0, devRain: 0, rate: 0, eta: Infinity, risk: 0, sim: true, lastReal: 0, frame: false, stormy: i > 0 && i < 5 }));
let storm = false, wxOK = null;
// ---- Decision support
const acts = (k, n) => k >= 3 ? [`Dispatch Protection Civile pumping and rescue units to ${n.name}`, "Close the nearest road or underpass and divert traffic", "Send an SMS / push alert to residents within 500 m", "Activate pumping stations and open retention basins", "Alert ONAS and the municipal crisis cell"]
  : k == 2 ? ["Pre-position pump trucks within 15 minutes", "Clear grates and culverts upstream", "Brief municipal crews and traffic police", "Raise sensor sampling to 1-minute readings"]
  : ["Keep monitoring and review the 3-hour forecast", "Inspect drains before the rain peak"];
const near = p => NODES.reduce((a, n) => dist(n, p) < dist(a, p) ? n : a);
function cred(r) {
  let s = 10; const w = ["Report received"], n = near(r), d = dist(n, r);
  if (r.np || r.vext) { s += 25; w.push("Photo or video evidence +25"); }
  if (r.vext) { s += 10; w.push("Video +10"); }
  if (r.src === "gps" && r.acc < 50) { s += 20; w.push("GPS fix under 50 m +20"); } else if (r.src === "gps") { s += 10; w.push("GPS fix +10"); } else { s += 5; w.push("Pin placed by hand +5"); }
  if (d < 2500 && r.type !== "Accident") { if (n.risk >= 2) { s += 25; w.push(`${n.name} sensor at ${RISK[n.risk]} +25`); } else if (n.risk == 1) { s += 10; w.push(`${n.name} sensor at Watch +10`); } }
  const o = db.reports.filter(x => x.id !== r.id && Date.now() - x.t < 36e5 && dist(x, r) < 400).length; if (o) { s += 15; w.push(`${o} other report(s) within 400 m +15`); }
  if (n.rain > .1 && d < 5000) { s += 5; w.push("Rain confirmed by weather data +5"); }
  return { s: Math.min(100, s), w };
}
function advise(r) {
  const n = near(r), d = dist(n, r), a = [];
  if (r.type === "Accident") return ["Call SAMU 190 / Police 197 and dispatch the nearest unit", "Divert traffic and warn drivers of standing water on the route"];
  if (d < 2500 && n.risk >= 2) a.push(`Nearest sensor (${n.name}, ${(d / 1000).toFixed(1)} km) is at ${RISK[n.risk]}${isFinite(n.eta) ? `, overflow in about ${Math.round(n.eta)} min` : ""}`);
  return a.concat(acts(Math.max(n.risk, r.sev >= 3 ? 3 : r.sev == 2 ? 2 : 1), n));
}
const svgFrame = n => { const h = Math.round(Math.min(1, n.L / n.thr) * 120), t = (y, s) => `<text x="8" y="${y}" fill="#fff" font-size="12" font-family="sans-serif">${esc(s)}</text>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2b3a42"/><rect y="${180 - h}" width="320" height="${h}" fill="#3A86B8" opacity=".85"/>${t(16, `CAM ${n.id} · ${n.name}`)}${t(32, `level ${Math.round(n.L)} cm · rain ${Math.round(n.rain)} mm/h`)}${t(172, n.sim ? "simulated frame" : "sensor frame")}</svg>`); };
function raise(n, k) {
  const id = "A" + Date.now().toString(36) + n.id; let img = svgFrame(n);
  if (n.frame && !n.sim) { try { fs.copyFileSync(media(`node-${n.id}.jpg`), media(`alert-${id}.jpg`)); img = `/api/media/alert-${id}.jpg`; } catch (e) {} }
  const a = { id, kind: "alert", node: n.id, lat: n.lat, lon: n.lon, risk: k, t: Date.now(), status: "New", img, acts: acts(k, n) };
  db.alerts.unshift(a); db.alerts.length = Math.min(db.alerts.length, 200); save(); push("alert", { id, node: n.id, risk: k });
}
// ---- Risk engine (runs every 2 s). Nodes with a recent device reading use it; others are simulated, driven by live rainfall.
function tick() {
  const now = Date.now();
  NODES.forEach(n => {
    n.sim = now - n.lastReal > 120000;
    if (n.sim) {
      n.boost = storm && n.stormy ? Math.min(50, n.boost + 4) : Math.max(0, n.boost - 5);
      n.rain = n.real + n.boost; const pL = n.L;
      n.L = clamp(n.L + n.rain * .035 - .2 - n.L * .004 + (Math.random() - .5) * .1, 8, n.thr * 1.5); n.rate = n.L - pL;
    } else n.rain = n.devRain;
    const r = n.L / n.thr; n.eta = n.rate > .05 ? (n.thr - n.L) / n.rate : Infinity;
    let k = 0; if (r >= .4 || n.rain >= 5 || n.f3 >= 10) k = 1; if (r >= .65 || n.rain >= 15) k = 2; if (r >= .9 || (n.eta < 20 && n.rain >= 20)) k = 3;
    if (k > n.risk && k >= 2) raise(n, k); n.risk = k;
  });
  broadcast();
}
async function loadWx() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${NODES.map(n => n.lat).join()}&longitude=${NODES.map(n => n.lon).join()}&current=precipitation&hourly=precipitation&forecast_hours=3&timezone=auto`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(r.status); const j = await r.json();
    (Array.isArray(j) ? j : [j]).forEach((x, i) => { NODES[i].real = x.current.precipitation || 0; NODES[i].f3 = (x.hourly.precipitation || []).reduce((a, b) => a + (b || 0), 0); }); wxOK = true;
  } catch (e) { wxOK = false; }
}
// ---- Views and real-time push (Server-Sent Events)
const full = r => { const c = cred(r); return { id: r.id, t: r.t, lat: r.lat, lon: r.lon, type: r.type, sev: r.sev, status: r.status, src: r.src, acc: r.acc, desc: r.desc, photos: r.np, vext: r.vext || null, score: c.s, why: c.w, advice: advise(r) }; };
function view(ops) {
  return { t: Date.now(), storm, wx: wxOK, ops,
    nodes: NODES.map(n => ({ id: n.id, name: n.name, lat: n.lat, lon: n.lon, thr: n.thr, L: +n.L.toFixed(1), rain: +n.rain.toFixed(1), f3: +n.f3.toFixed(1), eta: isFinite(n.eta) ? Math.round(n.eta) : null, risk: n.risk, sim: n.sim })),
    reports: db.reports.slice(0, 100).filter(r => ops || r.status !== "Resolved").map(r => ops ? full(r) : { id: r.id, t: r.t, lat: r.lat, lon: r.lon, type: r.type, sev: r.sev, status: r.status }),
    alerts: ops ? db.alerts.slice(0, 50) : [] };
}
const clients = new Set();
function push(ev, data, opsOnly) { const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) if (!opsOnly || c.ops) c.res.write(s); }
function broadcast() { if (!clients.size) return; const p = JSON.stringify(view(false)), o = JSON.stringify(view(true)); for (const c of clients) c.res.write(`event: state\ndata: ${c.ops ? o : p}\n\n`); }
// ---- HTTP
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4" };
const hits = new Map(); const limited = ip => { const t = Date.now(), a = (hits.get(ip) || []).filter(x => t - x < 6e4); a.push(t); hits.set(ip, a); return a.length > 8; };
async function body(req, max) { const c = []; let n = 0; for await (const x of req) { n += x.length; if (n > max) throw Object.assign(new Error("Payload too large"), { code: 413 }); c.push(x); } return Buffer.concat(c); }
const J = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const isOps = (req, u) => eq(req.headers["x-ops-token"] || u.searchParams.get("token") || "", OPS);
const jpg = (s, max) => { const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(s || ""); if (!m) return null; const b = Buffer.from(m[1], "base64"); return b.length <= max ? b : null; };
const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type,x-ops-token,x-device-key"); res.setHeader("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("permissions-policy", "camera=(self), geolocation=(self)");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, "http://x"), p = u.pathname, ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  try {
    if (p === "/api/health") return J(res, 200, { ok: true, weather: wxOK });
    if (p === "/api/state" && req.method === "GET") return J(res, 200, view(isOps(req, u)));
    if (p === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      const c = { res, ops: isOps(req, u) }; clients.add(c); res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(view(c.ops))}\n\n`); req.on("close", () => clients.delete(c)); return;
    }
    if (p === "/api/reports" && req.method === "POST") {
      if (limited(ip)) return J(res, 429, { error: "Too many reports. Wait a minute." });
      const b = JSON.parse((await body(req, 8e6)).toString() || "{}"), lat = +b.lat, lon = +b.lon;
      if (!(lat >= BOX.lat[0] && lat <= BOX.lat[1] && lon >= BOX.lon[0] && lon <= BOX.lon[1])) return J(res, 400, { error: "Location is outside the Greater Tunis coverage area" });
      if (!TYPES.includes(b.type) || ![1, 2, 3].includes(+b.sev)) return J(res, 400, { error: "Invalid type or severity" });
      const id = "R" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4).map(s => jpg(s, 1.5e6)).filter(Boolean);
      photos.forEach((buf, i) => fs.writeFileSync(media(`${id}-${i}.jpg`), buf));
      const r = { id, kind: "report", t: Date.now(), lat, lon, src: b.src === "gps" ? "gps" : "tap", acc: isFinite(+b.acc) ? +b.acc : null, type: b.type, sev: +b.sev, desc: String(b.desc || "").slice(0, 1000), np: photos.length, status: "New" };
      db.reports.unshift(r); db.reports.length = Math.min(db.reports.length, 500); save(); push("report", { id, type: r.type, sev: r.sev }, true); broadcast(); return J(res, 201, { id });
    }
    let m;
    if ((m = /^\/api\/reports\/(R[\w]+)\/video$/.exec(p)) && req.method === "POST") {
      const r = db.reports.find(x => x.id === m[1]); if (!r || r.vext || Date.now() - r.t > 6e5) return J(res, 404, { error: "Report not found" });
      const ext = /mp4/.test(req.headers["content-type"] || "") ? "mp4" : "webm"; fs.writeFileSync(media(`${r.id}-v.${ext}`), await body(req, 15e6)); r.vext = ext; save(); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/readings" && req.method === "POST") {   // sensor ingestion
      if (!eq(req.headers["x-device-key"] || "", DEV)) return J(res, 401, { error: "Invalid device key" });
      const b = JSON.parse((await body(req, 3e6)).toString() || "{}"), n = NODES.find(x => x.id === b.node), L = +b.level_cm;
      if (!n) return J(res, 404, { error: "Unknown node id" }); if (!isFinite(L) || L < 0 || L > 1000) return J(res, 400, { error: "level_cm out of range" });
      const t = Date.now(), dt = Math.max(.1, (t - n.lastReal) / 6e4); n.rate = n.lastReal && t - n.lastReal < 6e5 ? (L - n.L) / dt : 0;
      n.L = L; n.devRain = clamp(+b.rain_mmh || 0, 0, 300); n.lastReal = t; n.sim = false;
      const f = jpg(b.frame, 2e6); if (f) { fs.writeFile(media(`node-${n.id}.jpg`), f, () => {}); n.frame = true; }
      return J(res, 200, { ok: true });
    }
    if ((m = /^\/api\/items\/(\w+)$/.exec(p)) && req.method === "PATCH") {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      const b = JSON.parse((await body(req, 1e4)).toString() || "{}"), it = db.reports.find(x => x.id === m[1]) || db.alerts.find(x => x.id === m[1]);
      if (!it || !STAT.includes(b.status)) return J(res, 400, { error: "Unknown item or status" }); it.status = b.status; save(); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/sim/storm" && req.method === "POST") {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      storm = !!JSON.parse((await body(req, 1e3)).toString() || "{}").on; broadcast(); return J(res, 200, { storm });
    }
    if ((m = /^\/api\/media\/([\w.-]+)$/.exec(p))) {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      return fs.readFile(media(m[1]), (e, d) => { if (e) return J(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": MIME[path.extname(m[1])] || "application/octet-stream", "cache-control": "private, max-age=3600" }); res.end(d); });
    }
    if (p.startsWith("/api/")) return J(res, 404, { error: "Not found" });
    const f = path.normalize(path.join(PUB, p === "/" ? "index.html" : p)); if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end("Not found"); } res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(d); });
  } catch (e) { if (!res.headersSent) J(res, e.code === 413 ? 413 : e instanceof SyntaxError ? 400 : 500, { error: e.code === 413 ? e.message : e instanceof SyntaxError ? "Invalid JSON" : "Server error" }); }
});
loadWx(); setInterval(loadWx, 3e5); setInterval(tick, 2000);
server.listen(PORT, () => console.log(`AquaMind Flood Watch on :${PORT}\n  Operations code : ${OPS}\n  Device key      : ${DEV}\n  (set OPS_TOKEN and DEVICE_KEY env vars to make these permanent)`));
