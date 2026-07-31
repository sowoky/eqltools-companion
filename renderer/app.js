/* EQL Tools Companion — main-window renderer. The brain of the app: everything
   domain-shaped happens here through the vendored site modules. Main only
   ships us raw log lines and cached datasets.
   - vendor/shared.js  → window.EQLKills   (state, credit rules)
   - vendor/parse.js   → window.EQLKillsParse (grammar, KillStream, ingest) */
"use strict";
const $ = id => document.getElementById(id);
const K = window.EQLKills;
const P = window.EQLKillsParse;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── datasets & indexes ───────────────────────────────────────────────────*/
let DATA = null;      // kills-data.json
let QDATA = null;     // quest-items.json
let SOURCES = {};     // {name: source-string} for the settings pane
let NAME2KEY = new Map(), ROSTER = new Map(), NAMEZONES = new Map();
let QIDX = new Map(); // normName(item) -> [{q: quest row, as: "r"|"c"}]
let TDATA = null;     // item-tooltips.json
let TIDX = new Map(); // normName(item) -> {n, t, ic, sb: [lines]}

function buildIndexes(datasets) {
  const kd = datasets["kills-data.json"], qd = datasets["quest-items.json"];
  SOURCES = { kills: kd.source, quests: qd.source };
  DATA = kd.data; QDATA = qd.data;
  NAME2KEY = new Map(); ROSTER = new Map(); NAMEZONES = new Map(); QIDX = new Map();
  if (DATA) {
    for (const [key, z] of Object.entries(DATA.zones)) {
      NAME2KEY.set(z.name.toLowerCase(), key);
      const m = new Map();
      for (const row of z.mobs) {
        const n = K.normName(row.n);
        if (!m.has(n)) m.set(n, row);
        if (!NAMEZONES.has(n)) NAMEZONES.set(n, new Set());
        NAMEZONES.get(n).add(key);
      }
      ROSTER.set(key, m);
    }
  }
  if (QDATA) {
    for (const [nk, refs] of Object.entries(QDATA.items)) {
      QIDX.set(nk, refs.map(([qi, as]) => ({ q: QDATA.quests[qi], as })));
    }
  }
  const td = datasets["item-tooltips.json"];
  TDATA = td ? td.data : null;
  SOURCES.tooltips = td ? td.source : "none";
  TIDX = new Map();
  if (TDATA) for (const [nk, e] of Object.entries(TDATA.items)) TIDX.set(nk, e);
}

/* ── tracker state (same blob shape as the /kills page) ───────────────────*/
let STATE = null;

/* ── live stream ──────────────────────────────────────────────────────────*/
let stream = null;
let currentFile = null;
let killBuf = [];        // resolved kills awaiting a batched ingest
let killTimer = null;
const SESSION = { feed: [], quests: 0, kills: 0 };
const FEED_CAP = 500;
let FEED_ID = 0;
const FEED_OPEN = new Set(); // entries expanded past the quest-chip cap

function newStream(file) {
  currentFile = file;
  stream = new P.KillStream({ name2key: NAME2KEY, normName: K.normName });
  killBuf = [];
}

function onBootstrap({ file, text }) {
  newStream(file);
  if (DATA) {
    // Historical tail: credit kills (high-water mark makes restarts safe),
    // but never replay old loot into the live feed.
    const parsed = P.parseLog(text, NAME2KEY, K.normName);
    if (!STATE) STATE = K.blank();
    P.ingest(STATE, { nameZones: NAMEZONES }, file, parsed);
    K.save(STATE);
  }
  // Seed the live stream's zone from where the log left off: replay only the
  // last zone-entry line so the stream starts where the player is.
  const zrx = P.RX.zone;
  let lastZoneLine = null;
  for (const line of text.split(/\r?\n/)) if (zrx.test(line)) lastZoneLine = line;
  if (lastZoneLine) stream.feed(lastZoneLine);
  lastStreamZone = stream.zone;
  if (ZONE.follow && DATA && DATA.zones[stream.zone]) selectZone(stream.zone);
  renderStatus(); renderTracker(); pushZone();
}

let lastStreamZone = "?";
function onLines({ file, lines }) {
  if (file !== currentFile || !stream) return;
  for (const line of lines) {
    const evs = stream.feed(line);
    for (const ev of evs) handleEvent(ev);
  }
  if (stream.zone !== lastStreamZone) {
    lastStreamZone = stream.zone;
    pushZone();
    if (ZONE.follow && DATA && DATA.zones[stream.zone]) selectZone(stream.zone);
  }
  renderStatus();
}

function handleEvent(ev) {
  if (ev.kind === "loot") {
    const quests = QIDX.get(K.normName(ev.item)) || [];
    const entry = {
      kind: "loot", id: ++FEED_ID, ts: ev.ts, item: ev.item, qty: ev.qty, mob: ev.mob,
      disp: ev.disp, zone: ev.zone,
      quests: quests.map(({ q, as }) => ({
        n: q.n, t: q.t, as, rewards: q.rewards || [], zone: q.zone, lvl: q.lvl,
      })),
    };
    SESSION.feed.push(entry);
    if (entry.quests.length) SESSION.quests++;
    if (SESSION.feed.length > FEED_CAP) SESSION.feed.shift();
    window.companion.sendFeedEvent(overlayEvent(entry));
    renderFeed();
  } else if (ev.kind === "kill") {
    SESSION.kills++;
    killBuf.push({ ts: ev.ts, zone: ev.zone, n: ev.n, credit: ev.credit });
    if (!killTimer) killTimer = setTimeout(flushKills, 800);
    const entry = { kind: "kill", ts: ev.ts, n: ev.n, credit: ev.credit, zone: ev.zone };
    SESSION.feed.push(entry);
    if (SESSION.feed.length > FEED_CAP) SESSION.feed.shift();
    window.companion.sendFeedEvent(overlayEvent(entry));
    renderFeed();
  }
}

function flushKills() {
  killTimer = null;
  if (!killBuf.length || !DATA) { killBuf = []; return; }
  if (!STATE) STATE = K.blank();
  const batch = killBuf; killBuf = [];
  const lastTs = Math.max(STATE.files[currentFile] ? STATE.files[currentFile].ts : 0,
    ...batch.map(e => e.ts));
  // hwm:false — within a run every line is fed exactly once (byte offsets in
  // main dedup for us), and the high-water check would eat same-second
  // stragglers that resolve a batch late. Restarts still bootstrap through
  // the normal hwm path.
  P.ingest(STATE, { nameZones: NAMEZONES }, currentFile,
    { kills: batch, lastTs, lines: 0 }, { hwm: false });
  K.save(STATE);
  renderTracker(); renderZoneTab(); pushZone();
}

function overlayEvent(entry) {
  if (entry.kind === "loot") {
    const base = (QDATA && QDATA.base) || (DATA && DATA.base) || "";
    return {
      kind: "loot", item: entry.item, qty: entry.qty,
      quests: entry.quests.map(q => ({
        n: q.n, url: base ? base + q.t : "", as: q.as,
        rewards: q.as === "r" ? [] : q.rewards.slice(0, 3), // same no-echo rule as the main feed
      })),
    };
  }
  return { kind: "kill", n: entry.n, credit: entry.credit };
}

function pushZone() {
  if (!stream || !DATA) return;
  const key = stream.zone;
  const z = key !== "?" && DATA.zones[key];
  if (!z) { window.companion.sendZone(null); return; }
  const sum = K.summarize(STATE || K.blank(), DATA.zones);
  const s = sum.zones[key];
  window.companion.sendZone({ key, name: z.name, done: s ? s.done : 0, total: s ? s.total : z.mobs.length });
}

/* ── rendering ────────────────────────────────────────────────────────────*/
const hhmmss = ts => {
  const d = new Date(ts * 1000); // toSec built these as UTC — read them back the same way
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(n => String(n).padStart(2, "0")).join(":");
};
const DISP = { kept: "", depot: "→ depot", sold_free: "sold (worthless)", sold: "auto-sold", created: "→ crafted" };

function feedLi(e) {
  if (e.kind === "kill") {
    const tag = e.credit === "blow" ? "kill" : e.credit === "xp" ? "group kill" : "witnessed";
    return `<li class="ev ev--kill"><span class="ev__t">${hhmmss(e.ts)}</span>
      <span class="ev__body">${esc(e.n)} <span class="tag">${tag}</span></span></li>`;
  }
  const qty = e.qty > 1 ? ` ×${e.qty}` : "";
  const disp = DISP[e.disp] ? ` <span class="dim">${DISP[e.disp]}</span>` : "";
  // Common turn-ins (bone chips: 22 quests) would wall the feed with chips —
  // cap and expand on demand. Full data always collected, grouping is display.
  const CHIP_CAP = 4;
  const open = FEED_OPEN.has(e.id);
  const qlist = open ? e.quests : e.quests.slice(0, CHIP_CAP);
  const more = e.quests.length > CHIP_CAP && !open
    ? `<div class="quest quest--more" data-open="${e.id}">+${e.quests.length - CHIP_CAP} more quests</div>` : "";
  const badges = qlist.map(q => {
    // Looting a quest's REWARD: re-listing that quest's whole reward table is
    // noise (some armor-set quests list 60). Only component hits show what
    // the quest pays, capped.
    const role = q.as === "r" ? "reward from" : "quest item";
    let rew = "";
    if (q.as !== "r" && q.rewards.length) {
      const shown = q.rewards.slice(0, 4).map(esc).join(", ");
      rew = ` — reward: ${shown}${q.rewards.length > 4 ? ` +${q.rewards.length - 4} more` : ""}`;
    }
    return `<div class="quest" data-wiki="${esc(q.t)}"><b>${role}</b> ${esc(q.n)}${rew}</div>`;
  }).join("") + more;
  return `<li class="ev ev--loot ${e.quests.length ? "is-quest" : ""}">
    <span class="ev__t">${hhmmss(e.ts)}</span>
    <span class="ev__body"><span class="itn" data-tt="${esc(e.item)}">${esc(e.item)}</span>${qty} <span class="dim">from ${esc(e.mob)}</span>${disp}${badges}</span></li>`;
}

function renderFeed() {
  const only = $("onlyQuest").checked;
  const items = SESSION.feed.filter(e => !only || (e.kind === "loot" && e.quests.length));
  // Feed order is emission order, and kill candidates resolve a couple of
  // seconds late by design — sort the DISPLAY by log time so a slain_by that
  // resolved after a loot line doesn't render above it.
  const shown = items.slice(-200).map((e, i) => [e, i])
    .sort((a, b) => (b[0].ts - a[0].ts) || (b[1] - a[1]));
  $("feed").innerHTML = shown.map(([e]) => feedLi(e)).join("");
  $("feedEmpty").hidden = SESSION.feed.length > 0;
  $("feedCount").textContent = SESSION.feed.length
    ? `${SESSION.kills} kills · ${SESSION.quests} quest items this session` : "";
}

const EXPANDED = new Set();
function renderTracker() {
  const banner = $("trackerBanner");
  if (!DATA) { banner.hidden = false; banner.textContent = "Mob roster not loaded yet — refresh from eqltools.com in Settings."; $("trackerHead").innerHTML = ""; $("zones").innerHTML = ""; return; }
  banner.hidden = true;
  const s = STATE || K.blank();
  const sum = K.summarize(s, DATA.zones);
  const pct = sum.total ? Math.round(100 * sum.done / sum.total) : 0;
  $("trackerHead").innerHTML = `<span class="big">${pct}%</span> ${sum.done} of ${sum.total} mobs ·
    ${sum.zonesDone}/${sum.zonesTotal} zones cleared
    <span class="kbar"><span class="kbar__fill" style="width:${sum.total ? (100 * sum.done / sum.total).toFixed(1) : 0}%"></span></span>`;
  const entries = Object.entries(DATA.zones).filter(([, z]) => z.mobs.length)
    .filter(([k]) => !sum.zones[k].ignored)
    .sort((a, b) => ((sum.zones[a[0]].total - sum.zones[a[0]].done) - (sum.zones[b[0]].total - sum.zones[b[0]].done)) || (a[1].name < b[1].name ? -1 : 1));
  $("zones").innerHTML = entries.map(([key, z]) => {
    const zs = sum.zones[key];
    const open = EXPANDED.has(key);
    let body = "";
    if (open) {
      const rows = K.sortRows(z.mobs.map(r => ({ ...r })));
      const miss = rows.filter(r => !K.credited(s, sum.glob, key, r));
      body = `<ul class="klist">${miss.map(r =>
        `<li class="kmob"><a data-wiki="${esc(r.t)}">${esc(r.n)}</a>${r.lvl ? `<span class="klvl">${esc(r.lvl)}</span>` : ""}</li>`).join("")}</ul>`;
      if (!miss.length) body = `<p class="dim">Zone cleared.</p>`;
    }
    return `<section class="kzone ${zs.done === zs.total ? "is-full" : ""}">
      <button class="kzone__head" data-zone="${key}">
        <span class="kzone__name">${esc(z.name)}</span>
        <span class="kbar"><span class="kbar__fill" style="width:${zs.total ? (100 * zs.done / zs.total).toFixed(1) : 0}%"></span></span>
        <span class="kzone__n">${zs.done}/${zs.total}</span>
      </button>${body ? `<div class="kzone__body">${body}</div>` : ""}</section>`;
  }).join("");
}

/* ── zone tab: the atlas mobs & drops widget, log-aware ───────────────────*/
const ZONE = { sel: null, follow: true, file: null };

function populateZoneSel() {
  if (!DATA) return;
  const opts = Object.entries(DATA.zones)
    .sort((a, b) => a[1].name < b[1].name ? -1 : 1)
    .map(([k, z]) => `<option value="${k}">${esc(z.name)}</option>`);
  $("zoneSel").innerHTML = `<option value="">— pick a zone —</option>` + opts.join("");
  if (ZONE.sel) $("zoneSel").value = ZONE.sel;
}

async function selectZone(key) {
  if (!key || ZONE.sel === key) return;
  ZONE.sel = key; ZONE.file = null;
  $("zoneSel").value = key;
  renderZoneTab(); // spinner-ish empty state while loading
  const f = await window.companion.getZoneFile(key);
  if (ZONE.sel !== key) return; // player zoned again mid-fetch
  ZONE.file = f;
  renderZoneTab();
}

function renderZoneTab() {
  const banner = $("zoneBanner"), body = $("zoneBody");
  if (!DATA) { banner.hidden = false; banner.textContent = "Zone data needs the mob roster — refresh from eqltools.com in Settings."; body.innerHTML = ""; return; }
  if (!ZONE.sel) { banner.hidden = false; banner.textContent = "Pick a zone, or zone in-game with “follow my character” on."; body.innerHTML = ""; $("zoneMeta").textContent = ""; return; }
  const f = ZONE.file;
  if (!f) { banner.hidden = false; banner.textContent = "Loading zone data…"; body.innerHTML = ""; return; }
  banner.hidden = true;
  $("zoneMeta").innerHTML = `${f.mobs.length} mobs · ${f.items.length} items · <a class="wk" data-url="${esc(f.wikiUrl || "")}">wiki page</a>`;

  const s = STATE || K.blank();
  const glob = K.globalKilled(s);
  const mobRows = K.sortRows(f.mobs.map(r => ({ ...r })));
  const mobLi = (m) => {
    const dead = K.credited(s, glob, ZONE.sel, m);
    const drops = (m.drops || []).map((di, j) => {
      const it = f.items[di];
      if (!it) return "";
      const r = m.dr && m.dr[j] ? ` <i>${esc(m.dr[j])}</i>` : "";
      return `<span class="zdrop" data-url="${esc(it.u || "")}" data-tt="${esc(it.n)}">${esc(it.n)}${r}</span>`;
    }).filter(Boolean).join(", ");
    return `<li class="zmob ${dead ? "is-dead" : ""} ${m.named ? "is-named" : ""}">
      <span class="zmob__tick">${dead ? "✓" : ""}</span>
      <a class="wk" data-url="${esc(m.u || "")}">${esc(m.n)}</a>
      ${m.lvl ? `<span class="klvl">${esc(m.lvl)}</span>` : ""}
      ${drops ? `<div class="zdrops">${drops}</div>` : ""}</li>`;
  };

  // items → which mobs drop them (the widget's other direction)
  const droppers = new Map(); // item idx -> [mob names]
  f.mobs.forEach(m => (m.drops || []).forEach(di => {
    if (!droppers.has(di)) droppers.set(di, []);
    droppers.get(di).push(m.n);
  }));
  const itemRows = f.items.map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.n.toLowerCase() < b.it.n.toLowerCase() ? -1 : 1);
  const itemLi = ({ it, i }) => {
    const by = droppers.get(i) || [];
    const quests = QIDX.get(K.normName(it.n)) || [];
    const qmark = quests.length ? `<span class="zquest" title="quest item">quest</span>` : "";
    return `<li class="zitem"><a class="wk" data-url="${esc(it.u || "")}" data-tt="${esc(it.n)}">${esc(it.n)}</a>${qmark}
      ${by.length ? `<span class="dim"> — ${esc(by.slice(0, 4).join(", "))}${by.length > 4 ? ` +${by.length - 4}` : ""}</span>` : ""}</li>`;
  };

  body.innerHTML = `
    <div><h3>Mobs (${f.mobs.length})</h3><ul class="zlist">${mobRows.map(mobLi).join("")}</ul></div>
    <div><h3>Items (${f.items.length})</h3><ul class="zlist">${itemRows.map(itemLi).join("")}</ul></div>`;
}

let LOGSTATUS = {};
function renderStatus() {
  const bits = [];
  if (currentFile) {
    const ch = (currentFile.match(/eqlog_([^_]+)_/) || [])[1];
    if (ch) bits.push(ch);
  }
  if (stream && stream.zone !== "?" && DATA && DATA.zones[stream.zone]) bits.push(DATA.zones[stream.zone].name);
  if (LOGSTATUS.problem) bits.push(LOGSTATUS.problem);
  else if (!currentFile) bits.push(LOGSTATUS.logDir ? "watching for log lines…" : "no log folder set");
  $("status").textContent = bits.join(" · ");
  $("setLogDir").textContent = LOGSTATUS.logDir || "not set";
  $("setLogStatus").textContent = currentFile ? `Following ${currentFile}` : (LOGSTATUS.problem || "");
}

function renderData() {
  const rows = [];
  const one = (label, d, src) => {
    if (!d) return rows.push(`<p>${label}: <b>missing</b> — refresh below once the site ships it.</p>`);
    const upd = d.meta && (d.meta.updated || d.meta.generated) || "?";
    rows.push(`<p>${label}: ${src} · updated ${esc(String(upd))}</p>`);
  };
  one(`Mob roster (${DATA ? Object.keys(DATA.zones).length + " zones" : "—"})`, DATA, SOURCES.kills);
  one(`Quest items (${QDATA ? QDATA.quests.length + " quests, " + Object.keys(QDATA.items).length + " items" : "—"})`, QDATA, SOURCES.quests);
  one(`Item tooltips (${TDATA ? Object.keys(TDATA.items).length + " items" : "—"})`, TDATA, SOURCES.tooltips);
  $("dataStatus").innerHTML = rows.join("");
}

/* ── EQ item tooltip ──────────────────────────────────────────────────────
   The wiki's statsblock is literally the in-game item-display text, one line
   per row — render it as-is under the item name. Anything carrying data-tt
   gets one on hover when the tooltip dataset knows the name. */
const FLAGS_RX = /^[A-Z][A-Z0-9 *'&-]+$/; // all-caps flag rows: MAGIC ITEM LORE ITEM…
let tipEl = null;
function initTip() {
  tipEl = document.createElement("div");
  tipEl.id = "eqtip"; tipEl.hidden = true;
  document.body.appendChild(tipEl);
  document.addEventListener("mouseover", ev => {
    const t = ev.target.closest ? ev.target.closest("[data-tt]") : null;
    const e = t && TIDX.get(K.normName(t.dataset.tt));
    if (!e) { tipEl.hidden = true; return; }
    tipEl.innerHTML = `<div class="tt__name">${esc(e.n)}</div>` +
      e.sb.map(l => `<div class="${FLAGS_RX.test(l) ? "tt__flags" : "tt__line"}">${esc(l)}</div>`).join("");
    tipEl.hidden = false;
    moveTip(ev);
  });
  document.addEventListener("mousemove", ev => { if (!tipEl.hidden) moveTip(ev); });
  document.addEventListener("scroll", () => { tipEl.hidden = true; }, true);
}
function moveTip(ev) {
  const pad = 14, r = tipEl.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 8) x = Math.max(8, ev.clientX - r.width - pad);
  if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
  tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
}

/* ── updater ──────────────────────────────────────────────────────────────*/
function renderUpdate(u) {
  const banner = $("updBanner"), act = $("updAct");
  const msg = {
    downloading: [`Downloading update ${u.version || ""}…`, null],
    ready: [`Update ${u.version} is ready.`, "Restart to update"],
    manual: [`Version ${u.version} is out.`, "Open download page"],
  }[u.status];
  banner.hidden = !msg || !msg[1]; // only bother the player when there's an action
  if (msg) { $("updText").textContent = msg[0]; act.textContent = msg[1] || ""; }
  act.onclick = () => u.status === "ready" ? window.companion.installUpdate() : window.companion.openReleases();
  $("updStatus").textContent = {
    idle: "Automatic — checks every few hours.",
    downloading: `Downloading ${u.version || "update"}…`,
    ready: `Update ${u.version} downloaded — restarts into it.`,
    manual: `Version ${u.version} is out — this install type updates by re-downloading.`,
    current: "Up to date.",
    error: `Update check failed: ${u.detail || "unknown"}`,
  }[u.status] || "—";
}

function renderOverlayState(o) {
  $("btnOverlay").textContent = o.shown ? "Hide overlay" : "Overlay";
  $("btnOverlay2").textContent = o.shown ? "Hide overlay" : "Show overlay";
  $("setClickThrough").checked = o.clickThrough;
  $("setOpacity").value = o.opacity;
}

/* ── wiring ───────────────────────────────────────────────────────────────*/
async function main() {
  const init = await window.companion.init();
  buildIndexes(init.datasets);
  STATE = K.load();
  LOGSTATUS.logDir = init.settings.logDir;
  renderOverlayState(init.overlay);
  $("verLine").textContent = `EQL Tools Companion ${init.version} — data © eqlwiki (CC BY-SA 4.0), served by eqltools.com. Logs are read locally and never leave this machine.`;

  const s = (STATE || K.blank()).settings;
  $("setCities").checked = s.ignoreCities;
  $("setGeneric").checked = s.genericEverywhere;
  $("setWitnessed").checked = s.witnessed;

  renderStatus(); renderTracker(); renderFeed(); renderData();
  populateZoneSel(); renderZoneTab(); initTip();

  window.companion.onBootstrap(onBootstrap);
  window.companion.onLines(onLines);
  window.companion.onLogStatus(st => { LOGSTATUS = st; renderStatus(); });
  window.companion.onDataUpdated(d => { buildIndexes(d); renderTracker(); renderData(); populateZoneSel(); renderZoneTab(); pushZone(); });
  window.companion.onOverlayState(renderOverlayState);
  window.companion.onUpdate(renderUpdate);
  renderUpdate(await window.companion.getUpdate());
  window.companion.ready(); // listeners live — main may start tailing now

  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll(".pane").forEach(p => p.classList.toggle("on", p.id === "tab-" + b.dataset.tab));
  }));

  $("onlyQuest").addEventListener("change", renderFeed);
  $("zoneSel").addEventListener("change", e => {
    if (!e.target.value) return;
    // A manual pick means the player wants to browse — stop yanking the tab
    // back to wherever their character zones.
    ZONE.follow = false; $("zoneFollow").checked = false;
    selectZone(e.target.value);
  });
  $("zoneFollow").addEventListener("change", e => {
    ZONE.follow = e.target.checked;
    if (ZONE.follow && stream && DATA && DATA.zones[stream.zone]) selectZone(stream.zone);
  });
  $("btnOverlay").addEventListener("click", () => window.companion.toggleOverlay());
  $("btnOverlay2").addEventListener("click", () => window.companion.toggleOverlay());
  $("setClickThrough").addEventListener("change", e => window.companion.setClickThrough(e.target.checked));
  $("setOpacity").addEventListener("input", e => window.companion.setOverlayOpacity(+e.target.value));
  $("btnPickDir").addEventListener("click", async () => { LOGSTATUS.logDir = await window.companion.pickLogDir(); renderStatus(); });
  $("btnRefresh").addEventListener("click", async () => {
    $("btnRefresh").disabled = true;
    buildIndexes(await window.companion.refreshData());
    $("btnRefresh").disabled = false;
    renderTracker(); renderData(); pushZone();
  });

  const setSetting = (k, v) => { if (!STATE) STATE = K.blank(); STATE.settings[k] = v; K.save(STATE); renderTracker(); pushZone(); };
  $("setCities").addEventListener("change", e => setSetting("ignoreCities", e.target.checked));
  $("setGeneric").addEventListener("change", e => setSetting("genericEverywhere", e.target.checked));
  $("setWitnessed").addEventListener("change", e => setSetting("witnessed", e.target.checked));
  $("btnReset").addEventListener("click", () => {
    if (!confirm("Forget every tracked kill and start over?")) return;
    K.clear(); STATE = null; renderTracker(); pushZone();
  });

  document.addEventListener("click", e => {
    const mo = e.target.closest("[data-open]");
    if (mo) { FEED_OPEN.add(+mo.dataset.open); renderFeed(); return; }
    const u = e.target.closest("[data-url]");
    if (u && u.dataset.url) { window.companion.openWiki(u.dataset.url); return; }
    const w = e.target.closest("[data-wiki]");
    const base = (DATA && DATA.base) || (QDATA && QDATA.base);
    if (w && base) { window.companion.openWiki(base + w.dataset.wiki); return; }
    const zh = e.target.closest("[data-zone]");
    if (zh) { const k = zh.dataset.zone; EXPANDED.has(k) ? EXPANDED.delete(k) : EXPANDED.add(k); renderTracker(); }
  });
}
main();
