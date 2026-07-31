/* EQL Tools Companion — main process.
   Responsibilities kept deliberately thin: window lifecycle, the log tail
   engine (raw bytes → lines), the dataset cache/refresh, settings, and IPC
   plumbing. ALL domain logic — line grammar, kill credit, quest-item lookup —
   runs in the renderer via the vendored site modules (vendor/shared.js,
   vendor/parse.js), so the app can never disagree with eqltools.com. */
"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } = require("electron");
const fs = require("fs");
const path = require("path");

const isDev = !app.isPackaged;

/* Where the EQL client writes logs on a default Windows install. The client
   only writes when the player has `/log on` — the renderer surfaces that. */
const WIN_LOG_DIR = "C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends\\Logs";

/* Same live site files the browser tools fetch; the app refreshes its bundled
   snapshot from them. 404 on quest-items just means the site hasn't shipped
   that dataset yet — the bundled copy keeps working. */
const REMOTE = {
  "kills-data.json": "https://eqltools.com/kills/data/kills-data.json",
  "quest-items.json": "https://eqltools.com/companion/data/quest-items.json",
  "item-tooltips.json": "https://eqltools.com/companion/data/item-tooltips.json",
};
const REFRESH_MS = 12 * 3600 * 1000;

const TAIL_POLL_MS = 1000;
const BOOTSTRAP_CAP = 40 * 1024 * 1024; // same tail cap as the /kills page

/* ── settings ─────────────────────────────────────────────────────────────*/
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
let SETTINGS = null;
function loadSettings() {
  try { SETTINGS = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); }
  catch { SETTINGS = {}; }
  SETTINGS.overlay = { opacity: 0.92, clickThrough: false, shown: false, bounds: null, ...SETTINGS.overlay };
  if (!SETTINGS.logDir && process.platform === "win32" && fs.existsSync(WIN_LOG_DIR))
    SETTINGS.logDir = WIN_LOG_DIR;
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
    }, 3000);
  });
  mainWin.on("closed", () => { mainWin = null; app.quit(); });
}

function createOverlayWindow() {
  if (overlayWin) return;
  const b = SETTINGS.overlay.bounds;
  overlayWin = new BrowserWindow({
    width: b ? b.width : 340, height: b ? b.height : 240,
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
  overlayWin.webContents.on("did-finish-load", () => {
    overlayWin.webContents.send("overlay:init", {
      opacity: SETTINGS.overlay.opacity,
      clickThrough: SETTINGS.overlay.clickThrough,
      feed: FEED_RING.slice(-30),
      zone: LAST_ZONE,
    });
    applyClickThrough();
  });
  const saveBounds = () => { if (overlayWin) { SETTINGS.overlay.bounds = overlayWin.getBounds(); saveSettings(); } };
  overlayWin.on("moved", saveBounds);
  overlayWin.on("resized", saveBounds);
  overlayWin.on("closed", () => { overlayWin = null; SETTINGS.overlay.shown = false; saveSettings(); notifyOverlayState(); });
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
  if (mainWin) mainWin.webContents.send("overlay:state", {
    shown: !!(overlayWin && overlayWin.isVisible()),
    clickThrough: SETTINGS.overlay.clickThrough,
    opacity: SETTINGS.overlay.opacity,
  });
}

/* ── overlay feed relay ───────────────────────────────────────────────────
   The main-window renderer is the brain; it emits display events (loot with
   quest matches resolved, kill ticks, zone progress). Main fans them out to
   the overlay and keeps a small ring so a freshly opened overlay isn't
   empty. */
const FEED_RING = [];
let LAST_ZONE = null;

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

function bootstrap(file, size) {
  const start = Math.max(0, size - BOOTSTRAP_CAP);
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch { activeFile = null; return; } // retry next poll rather than wedging on this file
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

/* ── datasets ─────────────────────────────────────────────────────────────
   Resolution order per file: userData cache (a successful past refresh) →
   bundled snapshot (whatever the build machine had) → null. A background
   refresh rewrites the cache and pushes the new data to the renderer. */
const cacheDir = () => path.join(app.getPath("userData"), "data");
const bundledDir = () => isDev ? path.join(__dirname, "data-snapshot") : path.join(process.resourcesPath, "data");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function loadDatasets() {
  const out = {};
  for (const name of Object.keys(REMOTE)) {
    const cached = readJson(path.join(cacheDir(), name));
    const bundled = cached ? null : readJson(path.join(bundledDir(), name));
    out[name] = { data: cached || bundled, source: cached ? "cached" : bundled ? "bundled" : "none" };
  }
  return out;
}
async function refreshDatasets(force) {
  const last = SETTINGS.dataRefreshedAt || 0;
  if (!force && Date.now() - last < REFRESH_MS) return;
  fs.mkdirSync(cacheDir(), { recursive: true });
  let any = false;
  for (const [name, url] of Object.entries(REMOTE)) {
    try {
      const r = await fetch(url, { headers: { "user-agent": `eqltools-companion/${app.getVersion()}` } });
      if (!r.ok) continue; // quest-items may 404 until the site ships it
      const body = await r.text();
      JSON.parse(body); // never cache a non-JSON error page
      fs.writeFileSync(path.join(cacheDir(), name), body);
      any = true;
    } catch { /* offline is normal; bundled data carries on */ }
  }
  SETTINGS.dataRefreshedAt = Date.now(); saveSettings();
  if (any && mainWin) mainWin.webContents.send("data:updated", loadDatasets());
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
function initUpdater() {
  if (isDev) return;
  if (isNsisInstall()) {
    try { ({ autoUpdater } = require("electron-updater")); } catch { return; }
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-available", i => setUpdate({ status: "downloading", version: i.version }));
    autoUpdater.on("update-not-available", () => setUpdate({ status: "current" }));
    autoUpdater.on("update-downloaded", i => setUpdate({ status: "ready", version: i.version }));
    autoUpdater.on("error", e => setUpdate({ status: "error", detail: String((e && e.message) || e) }));
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, 4 * 3600 * 1000);
  } else {
    const check = async () => {
      try {
        const r = await fetch("https://api.github.com/repos/sowoky/eqltools-companion/releases/latest",
          { headers: { "user-agent": `eqltools-companion/${app.getVersion()}` } });
        if (!r.ok) return;
        const tag = (await r.json()).tag_name;
        if (tag && semverNewer(tag, app.getVersion()))
          setUpdate({ status: "manual", version: tag.replace(/^v/, "") });
        else setUpdate({ status: "current" });
      } catch {}
    };
    check();
    setInterval(check, 4 * 3600 * 1000);
  }
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
    overlay: { shown: !!(overlayWin && overlayWin.isVisible()), clickThrough: SETTINGS.overlay.clickThrough, opacity: SETTINGS.overlay.opacity },
    datasets: loadDatasets(),
  };
});
/* The renderer says "ready" only after its IPC listeners are registered and
   its indexes are built — starting the tail off app:init raced the first
   log:bootstrap against listener registration and lost it. */
ipcMain.on("renderer:ready", () => {
  rendererReady = true;
  startTail();
  refreshDatasets(false);
});
ipcMain.handle("data:refresh", async () => { await refreshDatasets(true); return loadDatasets(); });
ipcMain.handle("data:zoneFile", (_e, key) => zoneFile(String(key || "")));
ipcMain.handle("update:get", () => UPDATE);
ipcMain.on("update:install", () => { if (autoUpdater && UPDATE.status === "ready") autoUpdater.quitAndInstall(); });
ipcMain.on("update:openPage", () => shell.openExternal(RELEASES_URL));
ipcMain.handle("log:pickDir", async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: "Pick the EverQuest Legends Logs folder",
    defaultPath: SETTINGS.logDir || WIN_LOG_DIR,
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return SETTINGS.logDir || null;
  SETTINGS.logDir = r.filePaths[0]; saveSettings();
  startTail();
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

/* ── lifecycle ────────────────────────────────────────────────────────────*/
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (mainWin) { mainWin.show(); mainWin.focus(); } });
  app.whenReady().then(() => {
    loadSettings();
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
