/* EQL Tools Companion — main process.
   Responsibilities kept deliberately thin: window lifecycle, the log tail
   engine (raw bytes → lines), the dataset cache/refresh, settings, and IPC
   plumbing. ALL domain logic — line grammar, kill credit, quest-item lookup —
   runs in the renderer via the vendored site modules (vendor/shared.js,
   vendor/parse.js), so the app can never disagree with eqltools.com. */
"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, protocol } = require("electron");
const fs = require("fs");
const path = require("path");

const isDev = !app.isPackaged;

/* Where the EQL client writes logs on a default Windows install. The client
   only writes when the player has `/log on` — the renderer surfaces that. */
const WIN_LOG_DIR = "C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs";
/* On a Mac the game runs under osxEQL, whose wineprefix mirrors the same
   Windows layout — this is where the client actually writes its logs there. */
const MAC_LOG_DIR = path.join(require("os").homedir(),
  "Library", "Application Support", "osxEQL", "prefix", "drive_c",
  "users", "Public", "Daybreak Game Company", "Installed Games", "EverQuest Legends", "Logs");
const DEFAULT_LOG_DIR = process.platform === "darwin" ? MAC_LOG_DIR : WIN_LOG_DIR;

/* Same live site files the browser tools fetch; the app refreshes its bundled
   snapshot from them. 404 on quest-items just means the site hasn't shipped
   that dataset yet — the bundled copy keeps working. */
const REMOTE = {
  "kills-data.json": "https://eqltools.com/kills/data/kills-data.json",
  "quest-items.json": "https://eqltools.com/companion/data/quest-items.json",
  "item-tooltips.json": "https://eqltools.com/companion/data/item-tooltips.json",
  "gear-data.json": "https://eqltools.com/gear/data/gear-data.json",
  "sky.json": "https://eqltools.com/sky/data/sky.json",
};
/* Data the embedded /log-parser page fetches. Cached under its site URL
   paths and served straight to the iframe by the eqlt:// protocol — the
   renderer never sees these, so they live outside loadDatasets(). */
const REMOTE_PAGES = {
  "log-parser/data/con-bands.json": "https://eqltools.com/log-parser/data/con-bands.json",
  "log-parser/data/wiki-items.json": "https://eqltools.com/log-parser/data/wiki-items.json",
  "log-parser/data/wiki-mobs.json": "https://eqltools.com/log-parser/data/wiki-mobs.json",
  "spellmaster/data/spells.json": "https://eqltools.com/spellmaster/data/spells.json",
};
const REFRESH_MS = 12 * 3600 * 1000;

const TAIL_POLL_MS = 1000;
const BOOTSTRAP_CAP = 40 * 1024 * 1024; // same tail cap as the /kills page

/* ── settings ─────────────────────────────────────────────────────────────*/
/* Every overlay view, in tab order. The list is the allowlist for the `view`
   pref AND the menu the main window offers — a view missing from here silently
   fails to round-trip, which is how the Sky tab first refused to stick. */
const OVERLAY_VIEWS = ["tracked", "loot", "stats", "sky"];
const OVERLAY_BAR_H = 26;   // the title bar alone, in DIPs — collapsed height
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
let SETTINGS = null;
function loadSettings() {
  try { SETTINGS = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); }
  catch { SETTINGS = {}; }
  SETTINGS.overlay = {
    opacity: 0.92, clickThrough: false, shown: false, bounds: null,
    // display prefs, all renderer-facing (Kyle, 2026-07-31: "resizable/customizable")
    fontScale: 1, showKills: true, questOnly: false, view: "loot",
    /* Which tabs the overlay carries at all (Kyle, 2026-08-13: "the widget
       could be small and having too many tabs may be clutter"), and whether it
       is rolled up to its title bar — the alternative was dragging it off the
       bottom of the screen to get it out of the way. `height` is what to
       restore on expand, since the collapsed bounds overwrite the saved ones. */
    views: ["tracked", "loot", "stats", "sky"], collapsed: false, height: null,
    ...SETTINGS.overlay,
  };
  // a stored list from an older build predates any view added since
  if (!Array.isArray(SETTINGS.overlay.views) || !SETTINGS.overlay.views.length)
    SETTINGS.overlay.views = OVERLAY_VIEWS.slice();
  if (!SETTINGS.logDir && fs.existsSync(DEFAULT_LOG_DIR))
    SETTINGS.logDir = DEFAULT_LOG_DIR;
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(SETTINGS, null, 2)); } catch {}
}

/* ── windows ──────────────────────────────────────────────────────────────*/
let mainWin = null;
let overlayWin = null;

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1100, height: 780, minWidth: 780, minHeight: 520,
    backgroundColor: "#0b0913",
    title: "EQL Tools Companion",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  mainWin.removeMenu();
  mainWin.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (isDev && process.env.EQLC_DEVTOOLS) mainWin.webContents.openDevTools({ mode: "detach" });
  if (isDev) mainWin.webContents.on("console-message", (_e, _l, msg) => console.log("[renderer]", msg));
  // Dev: EQLC_TAB=zone|tracker|settings opens the app on that tab, and
  // EQLC_EXEC=<file.js> runs a script in the page — the agent-side
  // screenshot loop can't click or hover, so these drive the UI for it.
  if (isDev && (process.env.EQLC_TAB || process.env.EQLC_EXEC)) mainWin.webContents.on("did-finish-load", () => {
    setTimeout(() => {
      if (!mainWin) return;
      if (process.env.EQLC_TAB) mainWin.webContents.executeJavaScript(
        `document.querySelector('[data-tab="${process.env.EQLC_TAB}"]')?.click()`);
      if (process.env.EQLC_EXEC) mainWin.webContents.executeJavaScript(
        fs.readFileSync(process.env.EQLC_EXEC, "utf8")).catch(e => console.log("[exec]", e.message));
      // EQLC_SHOT=<png> writes a screenshot and quits — the agent has no eyes
      // on this window otherwise, and "the probe says the DOM is right" is not
      // the same as having looked at it. Waits out EQLC_EXEC's own async work.
      // A directory value belongs to the 5s interval loop below, not this
      // one-shot — quitting on it cut a live-log test off mid-run.
      if (process.env.EQLC_SHOT && process.env.EQLC_SHOT.endsWith(".png")) setTimeout(async () => {
        try {
          const img = await mainWin.webContents.capturePage();
          fs.writeFileSync(process.env.EQLC_SHOT, img.toPNG());
          console.log("[shot]", process.env.EQLC_SHOT);
        } catch (e) { console.log("[shot] failed", e.message); }
        /* The overlay is a second window the agent can't see either, and every
           bug it has ever had lived in the wire between the two — so it gets
           its own shot. EQLC_EXEC opens it (companion.toggleOverlay(true)) and
           picks the view. */
        if (process.env.EQLC_SHOT_OVERLAY && overlayWin) {
          try {
            const oi = await overlayWin.webContents.capturePage();
            fs.writeFileSync(process.env.EQLC_SHOT_OVERLAY, oi.toPNG());
            console.log("[shot]", process.env.EQLC_SHOT_OVERLAY);
          } catch (e) { console.log("[shot overlay] failed", e.message); }
        } else if (process.env.EQLC_SHOT_OVERLAY) console.log("[shot overlay] no overlay window");
        app.quit();
      }, Number(process.env.EQLC_SHOT_DELAY || 2500));
    }, 3000);
  });
  mainWin.on("closed", () => { mainWin = null; app.quit(); });
}

function createOverlayWindow() {
  if (overlayWin) return;
  const o = SETTINGS.overlay, b = o.bounds;
  overlayWin = new BrowserWindow({
    width: b ? b.width : 340,
    height: o.collapsed ? OVERLAY_BAR_H : (b ? b.height : 240),
    x: b ? b.x : undefined, y: b ? b.y : undefined,
    transparent: true, frame: false, resizable: true, hasShadow: false,
    skipTaskbar: true, minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  /* screen-saver level sits above a borderless-windowed game. Exclusive
     fullscreen bypasses the compositor entirely — no OS-level window can
     overlay it; the UI tells the player to use windowed/borderless. */
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, "overlay", "overlay.html"));
  overlayWin.webContents.on("did-finish-load", () => { sendOverlayInit(); applyClickThrough(); });
  /* Collapsed bounds must not become the remembered size — expanding would
     restore the title bar. The height to come back to lives in `height`, and
     only an uncollapsed resize updates it. */
  const saveBounds = () => {
    if (!overlayWin) return;
    const g = overlayWin.getBounds();
    SETTINGS.overlay.bounds = g;
    if (!SETTINGS.overlay.collapsed) SETTINGS.overlay.height = g.height;
    saveSettings();
  };
  overlayWin.on("moved", saveBounds);
  overlayWin.on("resized", saveBounds);
  overlayWin.on("closed", () => { overlayWin = null; SETTINGS.overlay.shown = false; saveSettings(); notifyOverlayState(); });
}

/* One prefs shape, sent to both windows. The overlay draws from it; the main
   window's Settings pane edits it. */
const overlayPrefs = () => {
  const o = SETTINGS.overlay;
  return { fontScale: o.fontScale, showKills: o.showKills, questOnly: o.questOnly,
           view: o.view, views: o.views, all: OVERLAY_VIEWS, collapsed: o.collapsed };
};

/* Full overlay redraw: mode + prefs + the feed ring, so a prefs change (or a
   fresh window) rebuilds the list under the new filters. */
function sendOverlayInit() {
  if (!overlayWin) return;
  const o = SETTINGS.overlay;
  overlayWin.webContents.send("overlay:init", {
    opacity: o.opacity, clickThrough: o.clickThrough,
    prefs: overlayPrefs(),
    feed: FEED_RING.slice(-50),
    zone: LAST_ZONE,
    quests: LAST_QUESTS,
    stats: LAST_STATS,
    sky: LAST_SKY,
  });
}

function applyClickThrough() {
  if (!overlayWin) return;
  /* forward:true keeps mouse-move events flowing so the overlay can still
     style hovers while clicks fall through to the game. Getting pointer
     control back is the hotkey's job — a clicked-through button can't hear
     its own click. */
  overlayWin.setIgnoreMouseEvents(SETTINGS.overlay.clickThrough, { forward: true });
  overlayWin.webContents.send("overlay:mode", { clickThrough: SETTINGS.overlay.clickThrough, opacity: SETTINGS.overlay.opacity });
}

function toggleOverlay(force) {
  const want = force !== undefined ? force : !(overlayWin && overlayWin.isVisible());
  if (want) { createOverlayWindow(); overlayWin.showInactive(); SETTINGS.overlay.shown = true; }
  else if (overlayWin) { overlayWin.close(); }
  saveSettings(); notifyOverlayState();
}
function notifyOverlayState() {
  const o = SETTINGS.overlay;
  if (mainWin) mainWin.webContents.send("overlay:state", {
    shown: !!(overlayWin && overlayWin.isVisible()),
    clickThrough: o.clickThrough, opacity: o.opacity,
    prefs: overlayPrefs(),
  });
}

/* ── overlay feed relay ───────────────────────────────────────────────────
   The main-window renderer is the brain; it emits display events (loot with
   quest matches resolved, kill ticks, zone progress). Main fans them out to
   the overlay and keeps a small ring so a freshly opened overlay isn't
   empty. */
const FEED_RING = [];
let LAST_ZONE = null;
// tracked-quest progress, pre-resolved by the renderer: {zones, quests}
let LAST_QUESTS = { zones: [], quests: [] };
// live combat stats, pre-resolved by the renderer: {session, fights}
let LAST_STATS = null;
// Plane of Sky turn-in board, pre-resolved by the renderer: {groups, note}
let LAST_SKY = null;

/* ── log tail engine ──────────────────────────────────────────────────────
   Poll-stat the log directory (fs.watch is unreliable enough on Windows
   drives that a 1s stat loop is the honest choice; the files are appended a
   few KB/s at most). The ACTIVE file is the most recently modified
   eqlog_*.txt — the client writes one file per character+server, so the busy
   one is the character being played. Bytes are the dedup mechanism: we hand
   the renderer the tail once (bootstrap) and only appended bytes after that,
   so nothing is ever parsed twice within a run; across runs the shared
   ingest high-water mark protects the tracker state. */
let tailTimer = null;
const tails = new Map(); // file path -> {offset, remainder}
let activeFile = null;
let rendererReady = false;

function startTail() {
  stopTail();
  if (!SETTINGS.logDir) { sendStatus(); return; }
  tailTimer = setInterval(pollTail, TAIL_POLL_MS);
  pollTail();
}
function stopTail() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
  tails.clear(); activeFile = null;
}

function pollTail() {
  if (!rendererReady || !mainWin) return;
  let entries;
  try { entries = fs.readdirSync(SETTINGS.logDir); } catch { sendStatus("Log folder is unreadable."); return; }
  let best = null, bestM = 0;
  for (const name of entries) {
    if (!/^eqlog_.+\.txt$/i.test(name)) continue;
    const p = path.join(SETTINGS.logDir, name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = { p, st }; }
  }
  if (!best) { sendStatus("No eqlog_*.txt files here — is logging on? (/log)"); return; }

  if (best.p !== activeFile) {
    activeFile = best.p;
    bootstrap(best.p, best.st.size);
    return;
  }
  const t = tails.get(activeFile);
  if (!t) return;
  let st; try { st = fs.statSync(activeFile); } catch { return; }
  if (st.size < t.offset) {
    /* File shrank: the client rotated/reset it. Start over from byte 0 — the
       ingest high-water mark keeps already-counted kills from recounting. */
    t.offset = 0; t.remainder = "";
  }
  if (st.size > t.offset) readAppended(activeFile, t, st.size);
}

// ≤40 MB tail of a log file, first partial line dropped. Throws on fs errors.
function readTailText(file, size) {
  const start = Math.max(0, size - BOOTSTRAP_CAP);
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  let text = buf.toString("utf8");
  if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  return text;
}

function bootstrap(file, size) {
  let text = "";
  try { text = readTailText(file, size); }
  catch { activeFile = null; return; } // retry next poll rather than wedging on this file
  tails.set(file, { offset: size, remainder: "" });
  mainWin.webContents.send("log:bootstrap", { file: path.basename(file), text });
  sendStatus();
}

function readAppended(file, t, size) {
  let chunk;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - t.offset);
    fs.readSync(fd, buf, 0, buf.length, t.offset);
    fs.closeSync(fd);
    chunk = buf.toString("utf8");
  } catch { return; }
  t.offset = size;
  const text = t.remainder + chunk;
  const parts = text.split(/\r?\n/);
  t.remainder = parts.pop(); // last piece may be a partial line; hold it
  const lines = parts.filter(l => l.length);
  if (lines.length) mainWin.webContents.send("log:lines", { file: path.basename(file), lines });
}

function sendStatus(problem) {
  if (!mainWin) return;
  mainWin.webContents.send("log:status", {
    logDir: SETTINGS.logDir || null,
    activeFile: activeFile ? path.basename(activeFile) : null,
    problem: problem || null,
  });
}

/* ── inventory dumps ──────────────────────────────────────────────────────
   /out inventory writes <Char>_<server>-Inventory.txt into the EQ install
   dir — the PARENT of the Logs folder we tail. Poll that dir and the log dir
   itself (dev points logDir at a scratch dir with no install layout) for the
   newest dump and ship the whole file whenever path or mtime changes; a dump
   is a few KB. Parsing is the renderer's job, same as log lines. */
const INV_POLL_MS = 3000;
let invTimer = null;
let invSent = null;    // "path:mtime" of the last file shipped
let invProblem = "-";  // last problem sent; "-" forces the first send
function startInvWatch() {
  stopInvWatch();
  if (!SETTINGS.logDir) return;
  invTimer = setInterval(pollInv, INV_POLL_MS);
  pollInv();
}
function stopInvWatch() {
  if (invTimer) { clearInterval(invTimer); invTimer = null; }
  invSent = null; invProblem = "-";
}
function pollInv() {
  if (!rendererReady || !mainWin) return;
  let best = null, readable = false;
  for (const dir of [path.dirname(SETTINGS.logDir), SETTINGS.logDir]) {
    let entries; try { entries = fs.readdirSync(dir); } catch { continue; }
    readable = true;
    for (const name of entries) {
      if (!/-Inventory\.txt$/i.test(name)) continue;
      const p = path.join(dir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
    }
  }
  // A dump-less folder is the normal empty state; an unreadable one must be
  // nameable by the tab, or misconfiguration is indistinguishable from
  // "you haven't dumped yet" (same rule as the tail engine's sendStatus).
  const problem = readable ? null : "Game folder is unreadable.";
  if (problem !== invProblem) { invProblem = problem; mainWin.webContents.send("inv:status", { problem }); }
  if (!best) return;
  const sig = best.p + ":" + best.mtimeMs;
  if (sig === invSent) return;
  let text; try { text = fs.readFileSync(best.p, "utf8"); } catch { return; }
  invSent = sig;
  mainWin.webContents.send("inv:file", { file: path.basename(best.p), mtime: best.mtimeMs, text });
}

/* ── datasets ─────────────────────────────────────────────────────────────
   Resolution order per file: userData cache (a successful past refresh) →
   bundled snapshot (whatever the build machine had) → null. A background
   refresh rewrites the cache and pushes the new data to the renderer. */
const cacheDir = () => path.join(app.getPath("userData"), "data");
const bundledDir = () => isDev ? path.join(__dirname, "data-snapshot") : path.join(process.resourcesPath, "data");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
/* Minimum dataset schema this build needs. A cache written by an older build
   is normally NEWER than the bundle and rightly wins — but not when it predates
   a field this app renders: a fresh install would then start on data that
   cannot answer, and could only say so. Below the floor we fall back to the
   bundled snapshot until the next refresh brings the live file up. Raise the
   number here in the same commit that starts depending on the new field. */
const MIN_SCHEMA = { "quest-items.json": 4, "item-tooltips.json": 1, "sky.json": 1 };

function loadDatasets() {
  const out = {};
  for (const name of Object.keys(REMOTE)) {
    let cached = readJson(path.join(cacheDir(), name));
    const floor = MIN_SCHEMA[name] || 0;
    let stale = false;
    if (cached && (cached.schema || 0) < floor) { stale = true; cached = null; }
    const bundled = cached ? null : readJson(path.join(bundledDir(), name));
    out[name] = {
      data: cached || bundled,
      source: cached ? "cached" : bundled ? (stale ? "bundled (cache too old)" : "bundled") : "none",
    };
  }
  return out;
}
async function refreshDatasets(force) {
  const last = SETTINGS.dataRefreshedAt || 0;
  if (!force && Date.now() - last < REFRESH_MS) return;
  fs.mkdirSync(cacheDir(), { recursive: true });
  let any = false;
  for (const [name, url] of Object.entries({ ...REMOTE, ...REMOTE_PAGES })) {
    try {
      const r = await fetch(url, { headers: { "user-agent": `eqltools-companion/${app.getVersion()}` } });
      if (!r.ok) continue; // quest-items may 404 until the site ships it
      const body = await r.text();
      JSON.parse(body); // never cache a non-JSON error page
      const out = path.join(cacheDir(), name); // page-data names carry site subpaths
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, body);
      any = true;
    } catch { /* offline is normal; bundled data carries on */ }
  }
  SETTINGS.dataRefreshedAt = Date.now(); saveSettings();
  if (any && mainWin) mainWin.webContents.send("data:updated", loadDatasets());
}

/* ── eqlt:// — the embedded log-parser page ───────────────────────────────
   The site's /log-parser is vendored whole (vendor/site/, sync-vendor.mjs)
   and served under a scheme of its own so the page's absolute URLs
   (/log-parser/app.js, /_shared/theme.css, /log-parser/data/…) work
   untouched. Static files come from the vendor mirror; data files resolve
   cache → bundled snapshot, same order as the datasets. Anything else 404s. */
const PAGE_DATA_RX = /^\/(log-parser\/data\/(?:con-bands|wiki-items|wiki-mobs)\.json|spellmaster\/data\/spells\.json)$/;
const PAGE_FILE_RX = /^\/(log-parser\/(?:index\.html|style\.css|engine\.js|app\.js)|_shared\/(?:theme\.css|tip\.js|fonts\/[A-Za-z0-9.-]+\.woff2))$/;
const vendorSiteDir = () => path.join(__dirname, "vendor", "site");
protocol.registerSchemesAsPrivileged([
  { scheme: "eqlt", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const PAGE_MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
// Serve with fs, not net.fetch(file://): fs is asar-aware, net.fetch is not
// reliably so — vendor/site lives inside the packaged asar.
function pageResponse(p) {
  try {
    const body = fs.readFileSync(p);
    return new Response(body, { headers: { "content-type": PAGE_MIME[path.extname(p)] || "application/octet-stream" } });
  } catch { return null; }
}
function registerPageProtocol() {
  protocol.handle("eqlt", (req) => {
    const { pathname } = new URL(req.url);
    let m;
    if ((m = PAGE_DATA_RX.exec(pathname))) {
      return pageResponse(path.join(cacheDir(), m[1]))
        || pageResponse(path.join(bundledDir(), m[1]))
        || new Response("no data", { status: 404 });
    }
    if ((m = PAGE_FILE_RX.exec(pathname)))
      return pageResponse(path.join(vendorSiteDir(), m[1])) || new Response("not found", { status: 404 });
    return new Response("not found", { status: 404 });
  });
}

/* ── app updater ──────────────────────────────────────────────────────────
   Three install shapes, three behaviors:
   - NSIS-installed (exe under AppData\Local\Programs): full electron-updater
     flow — download in background, "restart to update" when ready.
   - portable target (PORTABLE_EXECUTABLE_DIR set) or zip-extracted anywhere
     else: no in-place update path exists, so just compare versions against
     the latest GitHub release and point at the download page.
   Unsigned builds: electron-updater only verifies signatures when the
   installed app is signed, so unsigned→unsigned updates are fine. */
const RELEASES_URL = "https://github.com/sowoky/eqltools-companion/releases/latest";
let UPDATE = { status: "idle", version: null, url: RELEASES_URL };

function setUpdate(patch) {
  UPDATE = { ...UPDATE, ...patch };
  if (mainWin) mainWin.webContents.send("update:state", UPDATE);
}

function isNsisInstall() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return false;
  return process.platform === "win32" &&
    app.getPath("exe").toLowerCase().includes("\\appdata\\local\\programs\\");
}

const semverNewer = (a, b) => { // a > b, "1.2.3" strings
  const pa = String(a).replace(/^v/, "").split(".").map(Number);
  const pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

let autoUpdater = null;
let checkNow = null; // set per install shape; null in dev, where updates can't apply
function initUpdater() {
  if (isDev) { setUpdate({ status: "dev" }); return; }
  if (isNsisInstall()) {
    try { ({ autoUpdater } = require("electron-updater")); } catch { return; }
    autoUpdater.autoDownload = true;
    autoUpdater.on("checking-for-update", () => setUpdate({ status: "checking" }));
    autoUpdater.on("update-available", i => setUpdate({ status: "downloading", version: i.version }));
    autoUpdater.on("update-not-available", () => setUpdate({ status: "current" }));
    autoUpdater.on("update-downloaded", i => setUpdate({ status: "ready", version: i.version }));
    autoUpdater.on("error", e => setUpdate({ status: "error", detail: String((e && e.message) || e) }));
    checkNow = () => autoUpdater.checkForUpdates().catch(() => {});
  } else {
    // Failures only surface on a manual button press — a background check
    // failing on a flaky connection shouldn't park "Update check failed" in
    // Settings for hours (the pre-checkNow behavior was silent too).
    checkNow = async (manual) => {
      if (manual) setUpdate({ status: "checking" });
      try {
        const r = await fetch("https://api.github.com/repos/sowoky/eqltools-companion/releases/latest",
          { headers: { "user-agent": `eqltools-companion/${app.getVersion()}` } });
        if (!r.ok) { if (manual) setUpdate({ status: "error", detail: `GitHub answered ${r.status}` }); return; }
        const tag = (await r.json()).tag_name;
        if (tag && semverNewer(tag, app.getVersion()))
          setUpdate({ status: "manual", version: tag.replace(/^v/, "") });
        else setUpdate({ status: "current" });
      } catch (e) { if (manual) setUpdate({ status: "error", detail: String((e && e.message) || e) }); }
    };
  }
  checkNow();
  setInterval(() => checkNow(), 4 * 3600 * 1000);
}

/* Per-zone mobs & drops (the atlas widget's data). Resolution: fresh cache
   (<24 h) → live fetch (cached on success) → stale cache → bundled snapshot.
   Zone keys are atlas shortnames, validated hard since they become paths. */
const ZONE_MAX_AGE = 24 * 3600 * 1000;
async function zoneFile(key) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) return null;
  const cachePath = path.join(cacheDir(), "atlas-wiki", key + ".json");
  try {
    if (Date.now() - fs.statSync(cachePath).mtimeMs < ZONE_MAX_AGE) {
      const j = readJson(cachePath);
      if (j) return j;
    }
  } catch {}
  try {
    const r = await fetch(`https://eqltools.com/atlas/wiki/${key}.json`,
      { headers: { "user-agent": `eqltools-companion/${app.getVersion()}` }, signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const body = await r.text();
      const j = JSON.parse(body);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, body);
      return j;
    }
  } catch {}
  return readJson(cachePath) || readJson(path.join(bundledDir(), "atlas-wiki", key + ".json"));
}

/* ── IPC ──────────────────────────────────────────────────────────────────*/
ipcMain.handle("app:init", () => {
  return {
    version: app.getVersion(),
    platform: process.platform,
    settings: { logDir: SETTINGS.logDir || null },
    overlay: {
      shown: !!(overlayWin && overlayWin.isVisible()), clickThrough: SETTINGS.overlay.clickThrough, opacity: SETTINGS.overlay.opacity,
      prefs: overlayPrefs(),
    },
    datasets: loadDatasets(),
  };
});
/* The renderer says "ready" only after its IPC listeners are registered and
   its indexes are built — starting the tail off app:init raced the first
   log:bootstrap against listener registration and lost it. */
ipcMain.on("renderer:ready", () => {
  rendererReady = true;
  startTail();
  startInvWatch();
  refreshDatasets(false);
});
ipcMain.handle("data:refresh", async () => { await refreshDatasets(true); return loadDatasets(); });
/* The Parser tab re-reads the active log's tail on demand — the renderer
   doesn't retain the bootstrap text, and the embedded page re-parses whole
   (its own live-watch mode works the same way). */
ipcMain.handle("log:tail", () => {
  if (!activeFile) return null;
  try { return { name: path.basename(activeFile), text: readTailText(activeFile, fs.statSync(activeFile).size) }; }
  catch { return null; }
});
ipcMain.handle("data:zoneFile", (_e, key) => zoneFile(String(key || "")));
ipcMain.handle("update:get", () => UPDATE);
ipcMain.handle("update:check", () => { if (checkNow) checkNow(true); return UPDATE; });
ipcMain.on("update:install", () => { if (autoUpdater && UPDATE.status === "ready") autoUpdater.quitAndInstall(); });
ipcMain.on("update:openPage", () => shell.openExternal(RELEASES_URL));
ipcMain.handle("log:pickDir", async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: "Pick the EverQuest Legends Logs folder",
    defaultPath: SETTINGS.logDir || DEFAULT_LOG_DIR,
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return SETTINGS.logDir || null;
  SETTINGS.logDir = r.filePaths[0]; saveSettings();
  startTail();
  startInvWatch();
  return SETTINGS.logDir;
});
ipcMain.on("wiki:open", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on("overlay:toggle", (_e, force) => toggleOverlay(force));
ipcMain.on("overlay:clickThrough", (_e, on) => {
  SETTINGS.overlay.clickThrough = !!on; saveSettings(); applyClickThrough(); notifyOverlayState();
});
/* The unpin hotspot: forward:true keeps mousemove flowing while ignoring
   clicks, so the overlay can tell us the cursor is over the pin button and
   we flip the window interactive just for it — otherwise a pinned overlay
   could only be unpinned by hotkey or the main window (Kyle, 2026-07-31:
   "once you pin it, you can't unpin it"). */
ipcMain.on("overlay:hotspot", (_e, on) => {
  if (overlayWin && SETTINGS.overlay.clickThrough)
    overlayWin.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on("overlay:prefs", (_e, p) => {
  const o = SETTINGS.overlay;
  if (p.fontScale !== undefined) o.fontScale = Math.min(1.6, Math.max(0.8, +p.fontScale || 1));
  if (p.showKills !== undefined) o.showKills = !!p.showKills;
  if (p.questOnly !== undefined) o.questOnly = !!p.questOnly;
  // every view name has to be listed here or the pref silently fails to
  // round-trip and the overlay snaps back to its old tab
  if (OVERLAY_VIEWS.includes(p.view)) o.view = p.view;
  if (Array.isArray(p.views)) {
    const keep = OVERLAY_VIEWS.filter(v => p.views.includes(v));
    // an overlay with no tabs is a window that can show nothing; the last one
    // stays whatever the checkbox says
    if (keep.length) o.views = keep;
  }
  // the shown tab must be one that still exists
  if (!o.views.includes(o.view)) o.view = o.views[0];
  if (p.collapsed !== undefined) setCollapsed(!!p.collapsed);
  saveSettings(); sendOverlayInit(); notifyOverlayState();
});

/* Rolled up to the title bar and back (Kyle, 2026-08-13: "right now i have to
   drag it to the bottom to hide it"). The window itself shrinks — leaving it
   full-size with a transparent body would keep eating clicks over the game. */
function setCollapsed(on) {
  const o = SETTINGS.overlay;
  if (o.collapsed === on) return;
  if (on && overlayWin) o.height = overlayWin.getBounds().height;
  o.collapsed = on;
  if (!overlayWin) return;
  const b = overlayWin.getBounds();
  overlayWin.setBounds({ x: b.x, y: b.y, width: b.width,
                         height: on ? OVERLAY_BAR_H : Math.max(70, o.height || 240) });
}
/* Transparent frameless windows have NO native resize borders on Windows —
   the overlay's corner grip drives resizing through here instead. */
ipcMain.on("overlay:resize", (_e, w, h) => {
  if (!overlayWin) return;
  const b = overlayWin.getBounds();
  overlayWin.setBounds({ x: b.x, y: b.y,
    width: Math.min(900, Math.max(180, ~~w)), height: Math.min(900, Math.max(70, ~~h)) });
});
ipcMain.on("overlay:opacity", (_e, v) => {
  SETTINGS.overlay.opacity = Math.min(1, Math.max(0.2, +v || 0.92)); saveSettings(); applyClickThrough();
});
ipcMain.on("feed:event", (_e, ev) => {
  FEED_RING.push(ev); if (FEED_RING.length > 50) FEED_RING.shift();
  if (overlayWin) overlayWin.webContents.send("feed:event", ev);
});
ipcMain.on("feed:zone", (_e, z) => {
  LAST_ZONE = z;
  if (overlayWin) overlayWin.webContents.send("feed:zone", z);
});
/* 0.9.0 changed this payload from an array of quests to {zones, quests} (the
   overlay groups by zone now). The old `Array.isArray(q) ? … : []` guard turned
   every new payload into [] and the overlay's Tracked view went permanently
   empty while the main window showed the same quests fine — the two ends were
   both verified, the wire between them was not. Accept both shapes. */
ipcMain.on("feed:stats", (_e, s) => {
  LAST_STATS = s && typeof s === "object" ? s : null;
  if (overlayWin) overlayWin.webContents.send("feed:stats", LAST_STATS);
});
ipcMain.on("feed:sky", (_e, s) => {
  LAST_SKY = s && typeof s === "object" ? s : null;
  if (overlayWin) overlayWin.webContents.send("feed:sky", LAST_SKY);
});
ipcMain.on("feed:quests", (_e, q) => {
  const p = Array.isArray(q) ? { zones: [], quests: q }
    : (q && typeof q === "object" ? q : { zones: [], quests: [] });
  LAST_QUESTS = { zones: p.zones || [], quests: (p.quests || []).slice(0, 20) };
  if (overlayWin) overlayWin.webContents.send("feed:quests", LAST_QUESTS);
});
/* Overlay -> main window: "I have this one, you just can't see it" (bought
   from a merchant, parked on the pet — neither prints a log line, and
   /outputfile has no pet option). The main renderer owns the tracker state,
   so the overlay only relays the item name. */
ipcMain.on("quest:markHeld", (_e, n) => {
  if (mainWin && typeof n === "string") mainWin.webContents.send("quest:markHeld", n);
});

/* ── lifecycle ────────────────────────────────────────────────────────────*/
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
  app.whenReady().then(() => {
    loadSettings();
    registerPageProtocol();
    createMainWindow();
    initUpdater();
    /* Overlay control works while the game has focus. Show/hide, and the
       pointer-control escape hatch for click-through mode. */
    globalShortcut.register("Control+Shift+O", () => toggleOverlay());
    globalShortcut.register("Control+Shift+L", () => {
      SETTINGS.overlay.clickThrough = !SETTINGS.overlay.clickThrough;
      saveSettings(); applyClickThrough(); notifyOverlayState();
    });
    if (SETTINGS.overlay.shown) toggleOverlay(true);
    /* Dev screenshot loop: EQLC_SHOT=<dir> writes main.png/overlay.png every
       5 s via capturePage — how the agent-side verification loop inspects a
       run without OS window juggling. */
    if (isDev && process.env.EQLC_SHOT) setInterval(async () => {
      try {
        if (mainWin) fs.writeFileSync(path.join(process.env.EQLC_SHOT, "main.png"), (await mainWin.webContents.capturePage()).toPNG());
        if (overlayWin) fs.writeFileSync(path.join(process.env.EQLC_SHOT, "overlay.png"), (await overlayWin.webContents.capturePage()).toPNG());
      } catch {}
    }, 5000);
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => app.quit());
}
