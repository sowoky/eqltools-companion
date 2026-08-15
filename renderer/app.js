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
let T2Q = new Map();  // quest wiki path (q.t, unique) -> quest row — the tracked-quest key
let QDROPS = {};      // normName(item) -> [[mob, mobPath, zone, zonePath], ...] lowest level first
let QSRC = {};        // itemKey(item) -> {z:[zone], k:[kind], m:{zone:[mob]}, many, various, r:{c,to}}
let QZONES = {};      // zone display name -> wiki path
// article-stripped fallbacks, consulted only when the exact key misses
let QIDX_L = new Map(), TIDX_L = new Map(), GIDX_L = new Map(), QSRC_L = {}, QDROPS_L = {};
let TDATA = null;     // item-tooltips.json
let TIDX = new Map(); // normName(item) -> {n, t, ic, sb: [lines]}
let GDATA = null;     // gear-data.json — stats, flags, slots, classes, drop sources
let GIDX = new Map(); // itemKey(item) -> gear record (the name's FIRST wiki record, same pick as /gear)
let GVARS = new Map(); // itemKey(item) -> [all records sharing that display name], only when > 1
let GEO = null;       // quest-items.json geo: {nodes: {name: {adj, keys, oe}}, alias}
let KEY2NODE = new Map(); // atlas zone key -> geo node name
let NPCLOC = {};      // NPC display name -> {t, z, loc}

function buildIndexes(datasets) {
  const kd = datasets["kills-data.json"], qd = datasets["quest-items.json"];
  SOURCES = { kills: kd.source, quests: qd.source };
  DATA = kd.data; QDATA = qd.data;
  NAME2KEY = new Map(); ROSTER = new Map(); NAMEZONES = new Map(); QIDX = new Map(); T2Q = new Map(); QDROPS = {};
  if (DATA) {
    for (const [key, z] of Object.entries(DATA.zones)) {
      NAME2KEY.set(z.name.toLowerCase(), key);
      const m = new Map();
      for (const row of z.mobs) {
        const n = K.normMob(row.n);
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
    for (const q of QDATA.quests) T2Q.set(q.t, q);
    QDROPS = QDATA.drops || {};
    QSRC = QDATA.src || {};
    QZONES = QDATA.zones || {};
    GEO = QDATA.geo || null;
    NPCLOC = QDATA.npcs || {};
    KEY2NODE = new Map();
    if (GEO) {
      for (const [name, node] of Object.entries(GEO.nodes))
        for (const k of node.keys || []) KEY2NODE.set(k, name);
    }
    // a data refresh can swap GEO mid-session; a BFS map cached against the
    // old graph would keep serving distances for node names that no longer
    // exist until the player zones
    DIST = { from: null, map: null };
  }
  const td = datasets["item-tooltips.json"];
  TDATA = td ? td.data : null;
  SOURCES.tooltips = td ? td.source : "none";
  TIDX = new Map();
  if (TDATA) for (const [nk, e] of Object.entries(TDATA.items)) TIDX.set(nk, e);
  const gd = datasets["gear-data.json"];
  GDATA = gd ? gd.data : null;
  SOURCES.gear = gd ? gd.source : "none";
  GIDX = new Map(); GVARS = new Map();
  /* 57 display names map to several distinct wiki records (deity armor
     variants, "(Sky)" pages, material variants) and a dump only carries the
     display name — fusing them silently would show the wrong item's stats
     (the A-Sapphire lesson). The dataset's own `names` table resolves the
     name to its record list; the FIRST record is what /gear shows for the
     same name, so the two tools agree, and the full list surfaces in the
     row detail as "N variants" instead of being hidden. */
  if (GDATA && GDATA.names) {
    for (const keys of Object.values(GDATA.names)) {
      const recs = keys.map(k => GDATA.items[k]).filter(Boolean);
      if (!recs.length) continue;
      const key = itemKey(recs[0].n);
      if (!GIDX.has(key)) GIDX.set(key, recs[0]);
      if (recs.length > 1 && !GVARS.has(key)) GVARS.set(key, recs);
    }
  } else if (GDATA) {
    for (const rec of Object.values(GDATA.items)) {
      const key = itemKey(rec.n);
      if (!GIDX.has(key)) GIDX.set(key, rec);
    }
  }
  QIDX_L = looseIndex(QIDX); TIDX_L = looseIndex(TIDX); GIDX_L = looseIndex(GIDX);
  QSRC_L = looseObj(QSRC); QDROPS_L = looseObj(QDROPS);
  const sd = datasets["sky.json"];
  SOURCES.sky = sd ? sd.source : "none";
  SKYD = sd ? sd.data : null;
  buildSkyUses();
}

/* ── tracker state (same blob shape as the /kills page) ───────────────────*/
let STATE = null;

/* ── live stream ──────────────────────────────────────────────────────────*/
let stream = null;
let currentFile = null;
let killBuf = [];        // resolved kills awaiting a batched ingest
let killTimer = null;
const SESSION = { feed: [], quests: 0, kills: 0, loots: 0, xpSum: 0, activeSec: 0, lastEvTs: 0 };
const FEED_CAP = 500;
let FEED_ID = 0;
const FEED_OPEN = new Set(); // entries expanded past the quest-chip cap

// Active time, /log-parser's rule: event-to-event gaps over 30 min don't
// count (you were AFK or logged out, not playing slowly).
function bumpActive(ts) {
  if (SESSION.lastEvTs && ts > SESSION.lastEvTs && ts - SESSION.lastEvTs < 1800)
    SESSION.activeSec += ts - SESSION.lastEvTs;
  if (ts > SESSION.lastEvTs) SESSION.lastEvTs = ts;
}

function newStream(file) {
  currentFile = file;
  stream = new P.KillStream({ name2key: NAME2KEY, normName: K.normMob });
  killBuf = [];
}

// The feed used to start blank until the first live loot (Kyle, 2026-07-31:
// "no reason to start blank") — the bootstrap tail's trailing drops seed it.
const SEED_CAP = 100;

function onBootstrap({ file, text }) {
  // another character's log took over — their live loot tally isn't yours
  if (file !== currentFile) LIVE_HAVE = new Map();
  newStream(file);
  LINES_SEEN++; // a (re)bootstrapped file is new data for the parser tab
  // One pass over the tail serves three consumers: kill credit for the
  // tracker (high-water mark makes restarts safe — same parseLog semantics,
  // inlined so loot isn't discarded), the last SEED_CAP drops for the feed,
  // and the final zone so the live stream starts where the player is.
  const boot = new P.KillStream({ name2key: NAME2KEY, normName: K.normMob });
  const kills = [], loots = [];
  const collect = ev => {
    if (ev.kind === "kill") kills.push({ ts: ev.ts, zone: ev.zone, n: ev.n, credit: ev.credit });
    else if (ev.kind === "loot") { loots.push(ev); if (loots.length > SEED_CAP) loots.shift(); }
  };
  for (const raw of text.split(/\r?\n/)) for (const ev of boot.feed(raw)) collect(ev);
  for (const ev of boot.flush()) collect(ev);
  if (DATA) {
    if (!STATE) STATE = K.blank();
    P.ingest(STATE, { nameZones: NAMEZONES }, file, { kills, lastTs: boot.lastTs, lines: boot.lines });
    K.save(STATE);
  }
  stream.zone = boot.zone;
  lastStreamZone = stream.zone;
  // Seed once per app run: historical drops fill the feed's display but never
  // touch the session strip's counters or replay into the overlay; a mid-run
  // character switch keeps the feed it already has.
  if (!SESSION.feed.length && loots.length) {
    for (const ev of loots) SESSION.feed.push(lootEntry(ev));
    renderFeed();
  }
  if (ZONE.follow && DATA && DATA.zones[stream.zone]) selectZone(stream.zone);
  combatSeed(file, text);
  skySeed(file, text);
  renderStatus(); renderTracker(); pushZone(); renderSky(); pushSky();
}

let lastStreamZone = "?";
function onLines({ file, lines }) {
  if (file !== currentFile || !stream) return;
  LINES_SEEN += lines.length;
  for (const line of lines) {
    const evs = stream.feed(line);
    for (const ev of evs) handleEvent(ev);
  }
  combatFeed(lines);
  skyFeed(lines);
  if (stream.zone !== lastStreamZone) {
    lastStreamZone = stream.zone;
    pushZone();
    if (ZONE.follow && DATA && DATA.zones[stream.zone]) selectZone(stream.zone);
    renderQuestsSoon(); // the by-zone ordering starts from where you stand
  }
  renderStatus();
}

// A loot stream event → a feed entry, quest matches resolved. Shared by the
// live handler and the bootstrap seed so both build identical rows.
function lootEntry(ev) {
  return {
    kind: "loot", id: ++FEED_ID, ts: ev.ts, item: ev.item, qty: ev.qty, mob: ev.mob,
    disp: ev.disp, zone: ev.zone, quests: questRefsFor(ev.item),
  };
}

function handleEvent(ev) {
  bumpActive(ev.ts);
  if (ev.kind === "xp") {
    SESSION.xpSum += ev.pct;
    renderStats();
    return;
  }
  if (ev.kind === "loot") {
    SESSION.loots++;
    const entry = lootEntry(ev);
    SESSION.feed.push(entry);
    if (entry.quests.length) SESSION.quests++;
    if (SESSION.feed.length > FEED_CAP) SESSION.feed.shift();
    window.companion.sendFeedEvent(overlayEvent(entry));
    // Live loot counts toward quest components until the next /out inventory
    // dump supersedes it; sold loot never reached the bags.
    if (ev.disp !== "sold" && ev.disp !== "sold_free") {
      for (const k of new Set([itemKey(ev.item), itemKey(stripDecor(ev.item))]))
        LIVE_HAVE.set(k, (LIVE_HAVE.get(k) || 0) + (ev.qty || 1));
      renderQuestsSoon();
    }
    renderFeedSoon(); renderStats();
  } else if (ev.kind === "kill") {
    SESSION.kills++;
    killBuf.push({ ts: ev.ts, zone: ev.zone, n: ev.n, credit: ev.credit });
    if (!killTimer) killTimer = setTimeout(flushKills, 800);
    const entry = { kind: "kill", ts: ev.ts, n: ev.n, credit: ev.credit, zone: ev.zone };
    SESSION.feed.push(entry);
    if (SESSION.feed.length > FEED_CAP) SESSION.feed.shift();
    window.companion.sendFeedEvent(overlayEvent(entry));
    renderFeedSoon(); renderStats();
  }
}

/* The session strip — the /log-parser headline numbers, live (Kyle,
   2026-07-31: "fold the log parser in as a new section at the top").
   Rates divide by active time and only render once there's enough of it to
   mean anything. */
function renderStats() {
  const s = SESSION;
  if (!s.kills && !s.loots && !s.xpSum) return;
  const el = $("stats");
  el.hidden = false;
  const hrs = s.activeSec / 3600;
  const dur = s.activeSec >= 3600
    ? `${Math.floor(s.activeSec / 3600)}h${String(Math.floor((s.activeSec % 3600) / 60)).padStart(2, "0")}m`
    : `${Math.floor(s.activeSec / 60)}m`;
  const cell = (v, label) => `<span class="stat"><b>${v}</b> ${label}</span>`;
  const rates = s.activeSec >= 120
    ? cell((s.kills / hrs).toFixed(0), "kills/h") + cell((s.xpSum / hrs).toFixed(1) + "%", "xp/h")
    : "";
  el.innerHTML =
    cell(dur, "active") +
    cell(s.kills, "kills") +
    cell(s.xpSum.toFixed(2) + "%", "xp") +
    rates +
    cell(s.loots, "loots") +
    cell(s.quests, "quest items");
}

let feedTimer = null;
function renderFeedSoon() {
  // Coalesce bursts: a big pull can resolve a dozen events in one poll, and
  // re-rendering per event is what made tooltips die mid-hover.
  if (!feedTimer) feedTimer = setTimeout(() => { feedTimer = null; renderFeed(); }, 250);
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
    // The overlay is a dumb display with no datasets of its own, so every
    // event carries its links and EQ-tooltip lines pre-resolved: the looted
    // item and each shown reward get {url, sb} when the tooltip data knows
    // them. Payloads stay small (a few hundred bytes).
    const itemRef = (name) => {
      const t = lookupItem(TIDX, name);
      return { n: name, url: t && base ? base + t.t : "", sb: t ? t.sb : null };
    };
    const it = itemRef(entry.item);
    return {
      kind: "loot", item: entry.item, qty: entry.qty, url: it.url, sb: it.sb,
      quests: entry.quests.map(q => ({
        n: q.n, url: base ? base + q.t : "", as: q.as, oe: q.oe,
        rewards: q.as === "r" ? [] : q.rewards.slice(0, 3).map(itemRef), // same no-echo rule as the main feed
      })),
    };
  }
  const base = (QDATA && QDATA.base) || (DATA && DATA.base) || "";
  const mt = mobPathFor(entry.n || "");
  return { kind: "kill", n: entry.n, credit: entry.credit, url: mt && base ? base + mt : "" };
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

/* ── shared item rendering — Live and Inventory draw the same rows ─────────
   Item lookups resolve in two steps: EXACT normName first — a trailing "*"
   can be part of the wiki item name itself (Bread Cakes*; and Club vs Club*
   are two different items, so the star must never be blindly stripped) —
   then with client decorations stripped (`+N` upgrade tier, `(Exaltation)`,
   the inventory dump's own trailing `*`), which is how "Giant Snake Fang +4"
   and "Backpack*" find their base entries. Log names are bare, so step one
   hits for the live feed. */
const stripDecor = name => String(name)
  .replace(/\*+$/, "").replace(/\s*\(Exaltation\)$/, "").replace(/\s*\+\d+$/, "");

/* Item IDENTITY key — everything the datasets are keyed by. NOT normName:
   normName strips a leading article, which fuses items the wiki keeps apart on
   purpose ('Sapphire' the merchant gem vs 'A Sapphire', the Iksar Warrior Pike
   quest drop — its page literally says "not to be confused with Sapphire").
   Article stripping survives below as a LOOKUP fallback, never as identity. */
const itemKey = s => String(s).replace(/[`']/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/* Loose alias table per index, built once: article-stripped key -> entry, with
   an article-LESS title winning any tie. Only consulted when the exact key
   misses, so it can rescue a game name whose article the title doesn't carry
   without ever overriding a real item. */
function looseIndex(map) {
  const out = new Map();
  for (const [k, v] of map) {
    const lk = K.normName(k);
    if (lk === k || !out.has(lk)) out.set(lk, v);
  }
  return out;
}
function looseObj(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const lk = K.normName(k);
    if (lk === k || !(lk in out)) out[lk] = obj[k];
  }
  return out;
}
const lookupExact = (map, name) =>
  map.get(itemKey(name)) ?? map.get(itemKey(stripDecor(name)));
// name from the game (log line or inventory dump): exact first, then loose
const lookupLoose = (map, loose, name) => lookupExact(map, name)
  ?? loose.get(K.normName(name)) ?? loose.get(K.normName(stripDecor(name)));
const lookupItem = (map, name) => lookupExact(map, name);

// called with a name off a log line or an inventory row — loose lookup
const questRefsFor = name => (lookupLoose(QIDX, QIDX_L, name) || []).map(({ q, as }) => ({
  n: q.n, t: q.t, as, rewards: q.rewards || [], zone: q.zone, lvl: q.lvl, oe: !!q.oe,
}));

/* Mob name -> its wiki page. The kill-tracker roster already carries a wiki
   path per mob (kills-data rows: {n, t, lv, …}), so any mob the feed names is
   one lookup from a link — the same treatment items have always had (Kyle,
   2026-08-01: "if you're gonna show mob names / kills in the loot tab of the
   widget, at least make them clickable to go to wiki"). A mob can appear in
   several zones; every row for one name points at the same page, so the first
   hit wins. */
function mobPathFor(name) {
  const n = K.normMob(name);
  for (const key of NAMEZONES.get(n) || []) {
    const row = ROSTER.get(key) && ROSTER.get(key).get(n);
    if (row && row.t) return row.t;
  }
  return "";
}
// a mob name as a wiki link when the roster knows it, plain text when it doesn't
function mobSpan(name, cls) {
  const t = mobPathFor(name);
  return t ? `<a class="wk ${cls || ""}" data-wiki="${esc(t)}">${esc(name)}</a>`
    : `<span class="${cls || ""}">${esc(name)}</span>`;
}

/* item name: tooltip always; a wiki link too when the dataset knows it.
   `loose` for a name that came from the game (log line, inventory dump) — it
   may carry an article the item title doesn't. A wiki-sourced name (a quest
   component, a rollup row) is exact, and must stay exact or 'Sapphire' links
   to 'A Sapphire'. */
function itemSpan(name, loose) {
  const ti = loose ? lookupLoose(TIDX, TIDX_L, name) : lookupExact(TIDX, name);
  const base = (TDATA && TDATA.base) || (DATA && DATA.base) || "";
  return ti && base
    ? `<span class="itn is-link" data-tt="${esc(name)}" data-url="${esc(base + ti.t)}">${esc(name)}</span>`
    : `<span class="itn" data-tt="${esc(name)}">${esc(name)}</span>`;
}

// Common turn-ins (bone chips: 22 quests) would wall the list with chips —
// cap and expand on demand. Full data always collected, grouping is display.
function questChips(quests, id) {
  const CHIP_CAP = 4;
  const open = FEED_OPEN.has(id);
  const qlist = open ? quests : quests.slice(0, CHIP_CAP);
  const more = quests.length > CHIP_CAP && !open
    ? `<div class="quest quest--more" data-open="${id}">+${quests.length - CHIP_CAP} more quests</div>` : "";
  return qlist.map(q => {
    // Looting a quest's REWARD: re-listing that quest's whole reward table is
    // noise (some armor-set quests list 60). Only component hits show what
    // the quest pays, capped.
    const role = q.as === "r" ? "reward from" : "quest item";
    let rew = "";
    if (q.as !== "r" && q.rewards.length) {
      // each reward is an item — give it the EQ tooltip too
      const shown = q.rewards.slice(0, 4).map(r => `<span data-tt="${esc(r)}">${esc(r)}</span>`).join(", ");
      rew = ` — reward: ${shown}${q.rewards.length > 4 ? ` +${q.rewards.length - 4} more` : ""}`;
    }
    // the wiki's own in/out switch says this quest's content isn't live yet —
    // without the marker a drop that only feeds future quests looks useless
    const oe = q.oe ? ` <span class="oe">out of era</span>` : "";
    return `<div class="quest" data-wiki="${esc(q.t)}"><b>${role}</b> ${esc(q.n)}${oe}${rew}</div>`;
  }).join("") + more;
}

function feedLi(e) {
  if (e.kind === "kill") {
    const tag = e.credit === "blow" ? "kill" : e.credit === "xp" ? "group kill" : "witnessed";
    return `<li class="ev ev--kill"><span class="ev__t">${hhmmss(e.ts)}</span>
      <span class="ev__body">${mobSpan(e.n)} <span class="tag">${tag}</span></span></li>`;
  }
  const qty = e.qty > 1 ? ` ×${e.qty}` : "";
  const disp = DISP[e.disp] ? ` <span class="dim">${DISP[e.disp]}</span>` : "";
  return `<li class="ev ev--loot ${e.quests.length ? "is-quest" : ""}">
    <span class="ev__t">${hhmmss(e.ts)}</span>
    <span class="ev__body">${itemSpan(e.item, true)}${qty} <span class="dim">from ${mobSpan(e.mob, "dim")}</span>${disp}${questChips(e.quests, e.id)}</span></li>`;
}

function renderFeed() {
  const only = $("onlyQuest").checked;
  const needle = $("feedFilter").value.trim().toLowerCase();
  const fmatch = e => !needle || (e.kind === "kill"
    ? e.n.toLowerCase().includes(needle)
    : [e.item, e.mob, ...e.quests.map(q => q.n)].some(s => s && s.toLowerCase().includes(needle)));
  const items = SESSION.feed.filter(e => (!only || (e.kind === "loot" && e.quests.length)) && fmatch(e));
  // Feed order is emission order, and kill candidates resolve a couple of
  // seconds late by design — sort the DISPLAY by log time so a slain_by that
  // resolved after a loot line doesn't render above it.
  const shown = items.slice(-200).map((e, i) => [e, i])
    .sort((a, b) => (b[0].ts - a[0].ts) || (b[1] - a[1]));
  $("feed").innerHTML = shown.map(([e]) => feedLi(e)).join("");
  retip(); // rows shifted under the cursor — re-derive the tooltip
  $("feedEmpty").hidden = SESSION.feed.length > 0;
  // Gate on live events, not feed length: a freshly seeded feed shows
  // historical quest chips, and "0 quest items this session" beside them
  // reads as a contradiction.
  $("feedCount").textContent = SESSION.kills || SESSION.loots
    ? `${SESSION.kills} kills · ${SESSION.quests} quest items this session` : "";
}

const EXPANDED = new Set();
function renderTracker() {
  // shares the Zone tab's chrome: one banner, one filter box, two modes
  const banner = $("zoneBanner");
  if (!DATA) { banner.hidden = false; banner.textContent = "Mob roster not loaded yet — refresh from eqltools.com in Settings."; $("trackerHead").innerHTML = ""; $("zones").innerHTML = ""; return; }
  banner.hidden = true;
  $("zoneMeta").textContent = "";
  const s = STATE || K.blank();
  const sum = K.summarize(s, DATA.zones);
  const pct = sum.total ? Math.round(100 * sum.done / sum.total) : 0;
  $("trackerHead").innerHTML = `<span class="big">${pct}%</span> ${sum.done} of ${sum.total} mobs ·
    ${sum.zonesDone}/${sum.zonesTotal} zones cleared
    <span class="kbar"><span class="kbar__fill" style="width:${sum.total ? (100 * sum.done / sum.total).toFixed(1) : 0}%"></span></span>`;
  const q = ($("zoneFilter").value || "").trim().toLowerCase();
  const entries = Object.entries(DATA.zones).filter(([, z]) => z.mobs.length)
    .filter(([k]) => !sum.zones[k].ignored)
    .filter(([, z]) => !q || z.name.toLowerCase().includes(q))
    .sort((a, b) => ((sum.zones[a[0]].total - sum.zones[a[0]].done) - (sum.zones[b[0]].total - sum.zones[b[0]].done)) || (a[1].name < b[1].name ? -1 : 1));
  $("zones").innerHTML = entries.map(([key, z]) => {
    const zs = sum.zones[key];
    const open = EXPANDED.has(key);
    let body = "";
    if (open) {
      // The whole roster, checklist-style: killed rows keep their place —
      // checked and struck through — instead of vanishing (Kyle, 2026-07-31:
      // "show killed, but also show unkilled").
      const rows = K.sortRows(z.mobs.map(r => ({ ...r })));
      body = `<ul class="klist">${rows.map(r => {
        const dead = K.credited(s, sum.glob, key, r);
        return `<li class="kmob ${dead ? "is-dead" : ""}"><span class="kchk"></span><a data-wiki="${esc(r.t)}">${esc(r.n)}</a>${r.lvl ? `<span class="klvl">${esc(r.lvl)}</span>` : ""}</li>`;
      }).join("")}</ul>`;
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

/* "All zones" IS the kill tracker: every zone's completion, expandable to its
   roster. It was a tab of its own, showing the same DATA.zones roster with the
   same K.credited() ticks as this one — the difference was the drops column
   and which zone you were looking at, which is a <select>, not a tab. */
const ZONE_ALL = "*";

function populateZoneSel() {
  if (!DATA) return;
  const opts = Object.entries(DATA.zones)
    .sort((a, b) => a[1].name < b[1].name ? -1 : 1)
    .map(([k, z]) => `<option value="${k}">${esc(z.name)}</option>`);
  $("zoneSel").innerHTML =
    `<option value="${ZONE_ALL}">All zones — kill tracker</option>` + opts.join("");
  $("zoneSel").value = ZONE.sel || ZONE_ALL;
}

async function selectZone(key) {
  if (!key || ZONE.sel === key) return;
  ZONE.sel = key; ZONE.file = null;
  $("zoneSel").value = key;
  renderZoneTab(); // spinner-ish empty state while loading
  if (key === ZONE_ALL) return;
  const f = await window.companion.getZoneFile(key);
  if (ZONE.sel !== key) return; // player zoned again mid-fetch
  ZONE.file = f;
  renderZoneTab();
}

function renderZoneTab() {
  const banner = $("zoneBanner"), body = $("zoneBody");
  const allWrap = $("zones"), allHead = $("trackerHead");
  const isAll = !ZONE.sel || ZONE.sel === ZONE_ALL;
  // the two modes never draw at once — one roster, one question at a time
  allWrap.hidden = !isAll; allHead.hidden = !isAll;
  body.hidden = isAll;
  $("trkAtlas").hidden = isAll;
  if (isAll) { body.innerHTML = ""; renderTracker(); return; }
  if (!DATA) { banner.hidden = false; banner.textContent = "Zone data needs the mob roster — refresh from eqltools.com in Settings."; body.innerHTML = ""; return; }
  const f = ZONE.file;
  if (!f) { banner.hidden = false; banner.textContent = "Loading zone data…"; body.innerHTML = ""; return; }
  banner.hidden = true;
  $("zoneMeta").innerHTML = `${f.mobs.length} mobs · ${f.items.length} items · <a class="wk" data-url="${esc(f.wikiUrl || "")}">wiki page</a>`;

  const s = STATE || K.blank();
  const glob = K.globalKilled(s);
  const zNeedle = $("zoneFilter").value.trim().toLowerCase();
  const mobRows = K.sortRows(f.mobs.map(r => ({ ...r })))
    .filter(m => !zNeedle || m.n.toLowerCase().includes(zNeedle) ||
      (m.drops || []).some(di => f.items[di] && f.items[di].n.toLowerCase().includes(zNeedle)));
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
    .filter(({ it, i }) => !zNeedle || it.n.toLowerCase().includes(zNeedle) ||
      (droppers.get(i) || []).some(n => n.toLowerCase().includes(zNeedle)))
    .sort((a, b) => a.it.n.toLowerCase() < b.it.n.toLowerCase() ? -1 : 1);
  const itemLi = ({ it, i }) => {
    const by = droppers.get(i) || [];
    const quests = lookupExact(QIDX, it.n) || [];
    // every referencing quest out of era → say so, or the pill promises a
    // hand-in that doesn't exist yet
    const allOe = quests.length && quests.every(r => r.q.oe);
    const qmark = quests.length
      ? (allOe ? `<span class="zquest zquest--oe" title="every quest wanting this is out of era">quest · out of era</span>`
               : `<span class="zquest" title="quest item">quest</span>`)
      : "";
    return `<li class="zitem"><a class="wk" data-url="${esc(it.u || "")}" data-tt="${esc(it.n)}">${esc(it.n)}</a>${qmark}
      ${by.length ? `<span class="dim"> — ${esc(by.slice(0, 4).join(", "))}${by.length > 4 ? ` +${by.length - 4}` : ""}</span>` : ""}</li>`;
  };

  body.innerHTML = `
    <div><h3>Mobs (${mobRows.length}${zNeedle ? ` of ${f.mobs.length}` : ""})</h3><ul class="zlist">${mobRows.map(mobLi).join("")}</ul></div>
    <div><h3>Items (${itemRows.length}${zNeedle ? ` of ${f.items.length}` : ""})</h3><ul class="zlist">${itemRows.map(itemLi).join("")}</ul></div>`;
  retip();
}

/* ── inventory tab — the whole bag corpus as one sortable table ───────────
   /out inventory writes a TSV — header Location/Name/ID/Count/Slots, CRLF,
   "Empty" placeholder rows — validated against a real live-play dump.
   Sections observed in real dumps (docs/DATA-COLLECTION.md): worn slots
   (+ -SlotN socket rows), General 1–12 (+bag sub-slots), Held, Bank 1–24,
   SharedBank 1–6, Personal-Depot, KeyRing; the Dragon's Hoard only while its
   window is open. Rows keep their raw Location (collect full) — the area
   subtabs, parent/child nesting, and every enrichment column are display,
   resolved at render time from the live datasets so a data refresh re-answers
   the same dump. */
const INV = { file: null, mtime: 0, rows: null, text: null, problem: null };
const IV = { tab: "all", trade: "", cls: "", sort: "where", dir: 1 };
/* One sort per mode. Spare opens on the item the most things beat, which is
   the whole point of the mode; Gear opens on the pieces that are first pick
   for the most classes. */
const IV_SORT = { quest: { k: "where", d: 1 }, gear: { k: "bis", d: -1 }, spare: { k: "ahead", d: -1 }, exalt: { k: "xfits", d: -1 } };
const IV_OPEN = new Set(); // expanded rows, keyed by row id
/* The location vocabulary is /_shared/gear-score.js (vendored) — the site's
   /gear, /sky and /valet read the same dump and a second classifier here is
   exactly the fork the vendor script exists to prevent. It also carries the
   fix this file was wrong about: `Any Slot` is a WORN slot, not a bag, and
   the storage bins (Equipment, Activated, the loose exaltation stones) are a
   section of their own instead of 113 rows landing in Elsewhere. */
const INV_SECTIONS = window.EQLGearScore.LOC_SECTIONS;
const invSection = window.EQLGearScore.locSection;

const TIER_RX = /\s\+(\d+)$/; // the same "+N" decoration /gear parses
function parseInventory(text) {
  const rows = [], byLoc = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.replace(/\r$/, "").split("\t");
    // The dump is two concatenated tables: Location/Name/ID/Count/Slots, then
    // a 3-column KeyRing/Name/ID table with its own header — skip BOTH header
    // rows by shape, not by first column.
    if (f.length < 3 || (f[1] === "Name" && f[2] === "ID")) continue;
    const loc = f[0], name = f[1];
    if (!name || name === "Empty") continue;
    // client decorations, outermost first: "Name +4 (Exaltation)*" (stripDecor
    // peels them in the same order)
    const tm = TIER_RX.exec(name.replace(/\*+$/, "").replace(/\s*\(Exaltation\)$/, ""));
    const pm = /^(.+)-Slot\d+$/.exec(loc);
    // id joins the FEED_OPEN chip-expand space; itemId is the client's item ID
    rows.push({
      loc, name, itemId: +f[2] || 0, count: +f[3] || 1, id: ++FEED_ID,
      idx: rows.length, sec: invSection(loc),
      tier: tm ? Math.min(10, +tm[1]) : 0,
      /* An exaltation stone is named after the item it was rendered FROM, so
         the row is not one of that item — the Inventory tab lists it (it is
         really in your bags), but nothing that answers "how many do I have"
         may count it. Same rule as gear-score's parseRows, which /gear, /sky
         and /valet already read the dump through. */
      exalt: /\(Exaltation\)\*?$/.test(name),
      parentLoc: pm ? pm[1] : null, parent: null, kids: null,
    });
    // EVERY row is a potential parent — a socketed item sitting in a bag slot
    // makes its rune a "General 1-Slot2-Slot1" child of a row that is itself
    // a child (KeyRing rows repeat one loc; nothing references them, harmless)
    byLoc.set(loc, rows[rows.length - 1]);
  }
  // General5-Slot3 sits in the container at General5; Chest-Slot1 sits in the
  // item worn on Chest; deeper chains resolve one level at a time
  for (const r of rows) {
    if (!r.parentLoc) continue;
    const p = byLoc.get(r.parentLoc);
    if (p) { r.parent = p; (p.kids || (p.kids = [])).push(r); }
  }
  return rows;
}

function onInvFile({ file, mtime, text }) {
  INV.file = file; INV.mtime = mtime;
  // the raw dump is kept because the Valet walk reads it through the shared
  // valet-core, which takes the file rather than this tab's parsed rows
  INV.text = text;
  INV.rows = parseInventory(text);
  LIVE_HAVE = new Map(); // the dump holds everything looted before it
  /* valetReload() first: it builds the row set with gear records attached,
     which the Gear and Spare modes of the Inventory table rank off. Rendering
     the table before the analysis existed showed an empty Spare tab on the
     first dump of every session. */
  valetReload();
  renderInv(); renderQuests(); pushQuests(); renderSky(); pushSky();
  renderValet(); pushValet(); pushSpare();
}

function onInvStatus({ problem }) {
  INV.problem = problem;
  renderInv(); renderQuests(); renderSky();
}

/* ── enrichment — every column resolves from the datasets per render ────── */
const gearFor = name => lookupLoose(GIDX, GIDX_L, name);
const STAT_ORDER = ["hp", "mana", "end", "str", "sta", "agi", "dex", "wis", "int", "cha", "atk"];
const STAT_LABEL = { hp: "HP", mana: "MANA", end: "END", str: "STR", sta: "STA", agi: "AGI", dex: "DEX", wis: "WIS", int: "INT", cha: "CHA", atk: "ATK" };
const SV_LABEL = { f: "F", c: "C", m: "M", d: "D", p: "P", v: "VOID" };
const FLAG_WORD = { magic: "magic", lore: "lore", lore_equipped: "lore-equipped", temporary: "temporary", expendable: "expendable", quest: "quest", no_rent: "no rent", placeable: "placeable", artifact: "artifact" };

function tradeOf(name, g) {
  if (g && g.fl) {
    if (g.fl.includes("no_drop")) return "no drop";
    if (g.fl.includes("no_trade")) return "no trade";
    if (g.fl.includes("attunable")) return "attunable";
    return "yes";
  }
  if (g) return "yes"; // a gear record with no flags at all states no restriction
  // no gear record — the tooltip's own flag line still knows the hard ones
  const ti = lookupLoose(TIDX, TIDX_L, name);
  if (!ti) return "";
  const text = (ti.sb || []).join(" ");
  if (text.includes("NO DROP")) return "no drop";
  if (text.includes("NO TRADE")) return "no trade";
  return "yes";
}

function invFlagsOf(name, g) {
  if (g && g.fl) return g.fl.filter(f => FLAG_WORD[f]).map(f => FLAG_WORD[f]).join(" ");
  const ti = lookupLoose(TIDX, TIDX_L, name);
  const text = ((ti && ti.sb) || []).join(" ");
  const out = [];
  if (text.includes("MAGIC ITEM")) out.push("magic");
  if (text.includes("LORE ITEM")) out.push("lore");
  if (text.includes("TEMPORARY")) out.push("temporary");
  if (text.includes("EXPENDABLE")) out.push("expendable");
  if (text.includes("QUEST ITEM")) out.push("quest");
  return out.join(" ");
}

/* class/race sets ship as {"all":1} | {"all":1,"x":[..]} | {"c":[..]} | {"none":1} */
function codesText(c) {
  if (!c) return "";
  if (c.none) return "NONE";
  if (c.all) return c.x && c.x.length ? "ALL except " + c.x.join(" ") : "ALL";
  return (c.c || []).join(" ");
}

/* Where an item comes from: the gear dataset's source table first (zones with
   mobs, level and rarity), the quest-items source table for everything it
   doesn't cover. zones is [zone, [[mob, lvl, rarity]...], note?] triples. */
function srcSummary(r, g) {
  const kinds = [];
  let zones = null;
  if (g && g.src && Object.keys(g.src).length) {
    const s = g.src;
    if (s.d && s.d.length) { kinds.push("drops"); zones = s.d.map(([z, mobs]) => [z, mobs, ""]); }
    if (s.v) kinds.push("various mobs");
    if (s.c) kinds.push("crafted");
    if (s.s) kinds.push("merchant-sold");
    if (s.f) kinds.push("foraged");
    if (s.q) kinds.push("quest");
  } else {
    const s = srcFor(r.name);
    if (s) {
      if (s.many) kinds.push("many zones");
      else if (s.z && s.z.length) {
        kinds.push("drops");
        zones = s.z.map(z => {
          const si = sourceIn(r.name, z);
          return [z, (si.mobs || []).map(mn => [mn, null, null]),
            [si.isl, si.note].filter(Boolean).join(" · ")];
        });
      }
    }
  }
  const rest = kinds.filter(k => k !== "drops");
  const cell = zones
    ? `${zones[0][0]}${zones.length > 1 ? ` +${zones.length - 1}` : ""}${rest.length ? ` · ${rest.join(", ")}` : ""}`
    : rest.join(", ");
  const hay = (zones || []).map(([z, mobs]) => z + " " + (mobs || []).map(m => m[0]).join(" ")).join(" ")
    + " " + kinds.join(" ");
  return { kinds, zones, cell, hay };
}

function invView(r) {
  const T = window.EQLTier;
  const g = gearFor(r.name) || null;
  const quests = questRefsFor(r.name);
  const v = { r, g, quests, oe: !!(g && g.oe) };
  v.vars = GVARS.get(itemKey(r.name)) || GVARS.get(itemKey(stripDecor(r.name))) || null;
  const st = g && g.st ? T.statsAt(g, r.tier) : null;
  v.ac = st && st.ac != null ? st.ac : null;
  const sb = []; let sum = 0;
  if (st) for (const k of STAT_ORDER) if (st[k]) { sb.push(`${st[k] > 0 ? "+" : ""}${st[k]} ${STAT_LABEL[k]}`); sum += st[k]; }
  v.statsTxt = sb.join(" "); v.statSum = sb.length ? sum : null;
  const svb = []; let svSum = 0;
  if (g && g.sv) for (const k of ["f", "c", "m", "d", "p", "v"]) {
    const n = g.sv[k];
    if (!n) continue;
    svb.push(`${SV_LABEL[k]}${n > 0 ? "+" : ""}${n}`);
    if (k !== "v") svSum += n; // SV VOID is the upgrade-tier marker — never summed (same rule as /gear)
  }
  v.svTxt = svb.join(" "); v.svSum = svb.length ? svSum : null;
  if (g && g.dmg && g.dly) {
    const dmg = T.statAt(g.dmg, r.tier);
    v.ratioTxt = `${dmg}/${g.dly}`; v.ratio = dmg / g.dly;
  } else { v.ratioTxt = ""; v.ratio = null; }
  v.slotTxt = g && g.sl ? g.sl.join(" ") : "";
  v.wt = g && g.wt != null ? g.wt : null;
  const effs = [];
  if (g && g.haste) effs.push(`haste +${g.haste}%`);
  for (const e of (g && g.eff) || []) effs.push(e.n);
  if (g && g.charges) effs.push(`${g.charges} charges`);
  v.effTxt = effs.join(", ");
  v.trade = tradeOf(r.name, g);
  v.tradeRank = { yes: 0, attunable: 1, "no trade": 2, "no drop": 3 }[v.trade] ?? null;
  v.flagsTxt = invFlagsOf(r.name, g);
  v.clsTxt = g ? codesText(g.cls) : "";
  v.eraTxt = g ? ERA_SHORT(g.era) : "";
  v.eraKey = g && g.era ? (v.oe ? "z" : "a") + g.era : null;
  v.src = srcSummary(r, g);
  v.hay = [r.name, r.loc, r.parent && r.parent.name, v.slotTxt, v.statsTxt, v.svTxt, v.effTxt,
    v.trade, v.flagsTxt, v.clsTxt, v.eraTxt, v.src.hay, ...quests.map(q => q.n)]
    .filter(Boolean).join(" | ").toLowerCase();
  return v;
}

/* every column click-sorts; blanks always sink to the bottom whatever the
   direction; d0 is the first-click direction (numbers open biggest-first) */
/* The Quests cell — the reason this table exists: every quest wanting the
   item, INLINE and readable in the row (Kyle, 2026-08-10: "all i really want
   is to figure out if items are for quests and what quests … links.
   tooltips."). Same shape as the overlay's loot rows: linked quest name,
   " → " the rewards as EQ-tooltip spans. Capped per row, expandable through
   the same FEED_OPEN space the feed chips use. */
function invQuestsCell(v) {
  const QCAP = 3, RCAP = 3;
  const open = FEED_OPEN.has(v.r.id);
  const qlist = open ? v.quests : v.quests.slice(0, QCAP);
  const lines = qlist.map(q => {
    const oe = q.oe ? ` <span class="oe">out of era</span>` : "";
    const link = `<a class="wk" data-wiki="${esc(q.t)}">${esc(q.n)}</a>`;
    if (q.as === "r") return `<div class="iv-qline"><span class="dim">reward from</span> ${link}${oe}</div>`;
    const rew = q.rewards.length
      ? ` <span class="dim">→</span> ${q.rewards.slice(0, RCAP).map(r => `<span class="itn" data-tt="${esc(r)}">${esc(r)}</span>`).join(", ")}${q.rewards.length > RCAP ? ` <span class="dim">+${q.rewards.length - RCAP}</span>` : ""}`
      : "";
    return `<div class="iv-qline">${link}${oe}${rew}</div>`;
  });
  const more = v.quests.length > QCAP && !open
    ? `<div class="iv-qline iv-qmore" data-open="${v.r.id}">+${v.quests.length - QCAP} more quests</div>` : "";
  return lines.join("") + more;
}

/* ── Gear and Spare: the ranking behind two of the three modes ────────────
   vendor/spare-core.js does the work — it is the site's file, and /valet runs
   the identical analysis over the identical dump. All this layer does is run
   it when the data changes and key the answer back onto the rows this table
   already has.

   It runs ONCE per dump, never inside renderInv(): the table re-renders on
   every keystroke in the search box and the analysis is ~70ms over 16 classes.

   The two parses of the dump are keyed together by location + name rather than
   by row index. They agree on index today — both skip the same header and
   "Empty" rows in file order — but that is a coincidence of two independent
   parsers, and a table that silently attributes one item's verdict to another
   is worse than one that shows nothing. */
let SPARE = null, SPARE_BY = null;
const spareKey = (loc, name) => loc + "|" + name;
function spareReload() {
  SPARE = null; SPARE_BY = null;
  if (!VINV || !window.EQLSpare) return;
  SPARE = window.EQLSpare.analyze({ rows: VINV.rows, level: VL.level, D: window.EQL_DATA });
  SPARE_BY = new Map(SPARE.items.map(it => [spareKey(it.row.loc, it.row.name), it]));
  exaltReload();
}

/* ── Exalt: the fourth mode ──────────────────────────────────────────────
   vendor/exalt-core.js (the /exalt page's core) reads the dump once — every
   worn item's four sockets, every loose exaltation and where it fits, every
   item you own whose wiki record yields one — and this layer keys the answer
   back onto the rows by location + name, same as Spare. */
let EXALT = null, EXALT_CAT = null, EXALT_BY = null;
function exaltReload() {
  EXALT = null; EXALT_BY = null;
  if (!INV.text || !GDATA || !window.EQLExaltCore) return;
  const X = window.EQLExaltCore;
  if (!EXALT_CAT || EXALT_CAT.data !== GDATA) {
    X.setLockedZones(GDATA.zone_oe);
    EXALT_CAT = X.build(GDATA); EXALT_CAT.data = GDATA;
  }
  const rows = window.EQLGearScore.parseRows(INV.text);
  EXALT = X.readDump(rows, GDATA, EXALT_CAT);
  EXALT_BY = new Map();
  for (const l of EXALT.loose) EXALT_BY.set(spareKey(l.row.loc, l.row.name), { kind: "loose", l });
  for (const src of EXALT.sources) {
    EXALT_BY.set(spareKey(src.row.loc, src.row.name), { kind: "source", src });
    for (const t of X.TYPES) {
      const sk = src.sockets[t.key];
      if (sk.filled) EXALT_BY.set(spareKey(sk.stone.row.loc, sk.stone.row.name), { kind: "socketed", host: src, type: t.key, st: sk.stone });
    }
  }
  pushExalt();
}
const exaltOf = v => (EXALT_BY && EXALT_BY.get(spareKey(v.r.loc, v.r.name))) || null;
const xKind = t => `<span class="ivb ivb--x${t}">${window.EQLExaltCore.TYPE[t].label}</span>`;
const xEffText = (y) => {
  const fx = GDATA && GDATA.effects ? GDATA.effects[y.effect] : null;
  return `<span title="${esc(fx && fx.d ? fx.d : "")}">${esc(y.effect)}</span>`;
};
/* The overlay's Exalt view: loose exaltations that fit something worn right
   now, one line each. Same shape of push as Spare — the answer the tab already
   computed, trimmed for 340px. */
let lastExaltJson = "";
function pushExalt() {
  if (!EXALT) { if (lastExaltJson !== "null") { lastExaltJson = "null"; window.companion.sendExalt(null); } return; }
  const X = window.EQLExaltCore;
  const rows = [];
  for (const l of EXALT.loose) for (const y of l.yields.filter(x => x.type)) {
    const h = X.homesFor(y, EXALT.worn);
    if (!h.now.length) continue;
    const ref = skyRef(l.row.base);
    rows.push({ n: l.row.base, url: ref.url, sb: ref.sb, kind: X.TYPE[y.type].label, effect: y.effect,
                into: `${h.now[0].w.slot}: ${h.now[0].w.row.base}`,
                more: h.now.length > 1 ? h.now.slice(1).map(x => x.w.slot).join(", ") : null });
  }
  const p = { loose: EXALT.loose.length, rows: rows.slice(0, 40) };
  const j = JSON.stringify(p);
  if (j !== lastExaltJson) { lastExaltJson = j; window.companion.sendExalt(p); }
}
const spareOf = v => (SPARE_BY && SPARE_BY.get(spareKey(v.r.loc, v.r.name))) || null;

const CLS_ORDER = window.EQLChar.CLASSES;
const clsSort = list => list.slice().sort((a, b) => CLS_ORDER.indexOf(a) - CLS_ORDER.indexOf(b));

/* Where a row is, as a place you can walk to. A socket is the one case the raw
   location cannot express: "Head-Slot7" is a stone inside the thing on your
   head, and the number is an exaltation TYPE (vendor/exalt-slots.js), not a
   position. Bag and bank positions keep their numbers because that is what
   gets your hand on the item. */
function whereText(loc) {
  const GS = window.EQLGearScore;
  const sock = window.EQLExalt.socketAt(loc);
  const base = sock ? sock.host : loc;
  const b = GS.locBadge(base);
  let head;
  if (b.kind === "bag") head = `Bag ${b.n}${b.sub ? ` · ${b.sub}` : ""}`;
  else if (b.kind === "bank") head = `Bank ${b.n}${b.sub ? ` · ${b.sub}` : ""}`;
  else if (GS.WORN_RX.test(GS.rootLoc(base))) head = base;
  else head = b.word;
  if (!sock) return head;
  return `${head} · ${sock.type ? sock.type.label : `socket ${sock.n}`}`;
}

/* Every column the data can fill exists; WHICH show is the player's call
   (the columns picker, persisted per mode). Defaults answer the mode's own
   question and nothing else. */
const IV_COLS = [
  { k: "where", h: "Where", d0: 1, key: v => v.r.idx,
    cell: v => `<td class="iv-where" title="${esc(v.r.loc)}">${esc(whereText(v.r.loc))}</td>` },
  { k: "item", h: "Item", d0: 1, always: true, key: v => v.r.name.toLowerCase(), cell: v => {
    // the name already prints "+N" and "(Exaltation)" — no chips restating it
    const badges = (v.r.kids ? `<span class="ivb">${v.r.kids.length} inside</span>` : "") +
      (v.vars ? `<span class="ivb" title="the wiki lists ${v.vars.length} items with this name — the columns show the first; open the row for all of them">${v.vars.length} variants</span>` : "");
    const span = v.r.exalt ? exaltSpan(v.r) : itemSpan(v.r.name, true);
    return `<td class="iv-item">${span}${badges}${spareChips(v)}</td>`;
  } },
  { k: "qty", h: "Qty", d0: -1, key: v => v.r.count > 1 ? v.r.count : null, cell: v => `<td class="iv-n">${v.r.count > 1 ? v.r.count : ""}</td>` },
  { k: "quests", h: "Quests", d0: -1, key: v => v.quests.length || null, cell: v => `<td class="iv-q">${invQuestsCell(v)}</td>` },
  { k: "tier", h: "Tier", d0: -1, key: v => v.r.tier || null, cell: v => `<td class="iv-n">${v.r.tier || ""}</td>` },
  { k: "slot", h: "Slot", d0: 1, key: v => v.slotTxt || null, cell: v => `<td>${esc(v.slotTxt)}</td>` },
  { k: "ac", h: "AC", d0: -1, key: v => v.ac, cell: v => `<td class="iv-n">${v.ac ?? ""}</td>` },
  { k: "ratio", h: "Dmg/Dly", d0: -1, key: v => v.ratio, cell: v => `<td class="iv-n">${v.ratioTxt}</td>` },
  { k: "stats", h: "Stats", d0: -1, key: v => v.statSum, cell: v => `<td>${esc(v.statsTxt)}</td>` },
  { k: "sv", h: "Resists", d0: -1, key: v => v.svSum, cell: v => `<td>${esc(v.svTxt)}</td>` },
  { k: "wt", h: "Wt", d0: -1, key: v => v.wt, cell: v => `<td class="iv-n">${v.wt ?? ""}</td>` },
  { k: "eff", h: "Effect", d0: 1, key: v => v.effTxt.toLowerCase() || null, cell: v => `<td class="iv-eff">${esc(v.effTxt)}</td>` },
  { k: "trade", h: "Trade", d0: 1, key: v => v.tradeRank, cell: v => `<td>${esc(v.trade)}</td>` },
  { k: "flags", h: "Flags", d0: 1, key: v => v.flagsTxt || null, cell: v => `<td>${esc(v.flagsTxt)}</td>` },
  { k: "cls", h: "Class", d0: 1, key: v => v.clsTxt || null, cell: v => `<td class="iv-cls">${esc(v.clsTxt)}</td>` },
  { k: "era", h: "Era", d0: 1, key: v => v.eraKey, cell: v => `<td>${v.oe ? `<span class="oe">out of era</span>` : esc(v.eraTxt)}</td>` },
  { k: "src", h: "Source", d0: 1, key: v => v.src.cell.toLowerCase() || null, cell: v => `<td class="iv-src">${esc(v.src.cell)}</td>` },

  /* ── the Exalt columns ─────────────────────────────────────────────────
     A row is one of three things to this mode: an exaltation sitting loose,
     an exaltation socketed in an item, or an item that yields one. Effect says
     which effect(s), Fits says where it can go (or whether the socket it is in
     agrees with the wiki), Sockets shows an item's four sockets. */
  { k: "xeff", h: "Effect", d0: 1,
    key: v => { const x = exaltOf(v); if (!x) return null; if (x.kind === "socketed") return x.st.stone ? x.st.stone.effect.toLowerCase() : "zz"; const ys = (x.kind === "loose" ? x.l.yields : x.src.yields).filter(y => y.type); return ys.length ? ys[0].effect.toLowerCase() : null; },
    cell: v => {
      const x = exaltOf(v);
      if (!x) return `<td></td>`;
      if (x.kind === "socketed") {
        const st = x.st;
        return `<td class="iv-eff">${st.stone ? `${xKind(st.stone.type)} ${xEffText(st.stone)}` : `<span class="dim">${esc(st.row.base)} — kind unknown</span>`}</td>`;
      }
      const ys = (x.kind === "loose" ? x.l.yields : x.src.yields).filter(y => y.type);
      if (!ys.length) return `<td class="iv-eff"><span class="dim">${x.l && !x.l.rec ? "no wiki record" : "no focus, click, worn or proc effect on the wiki"}</span></td>`;
      const one = x.kind === "loose" && ys.length > 1 ? ` <span class="dim" title="the item yields more than one effect; this exaltation is one of them">one of ${ys.length}</span>` : "";
      return `<td class="iv-eff">${ys.map(y => `<div>${xKind(y.type)} ${xEffText(y)}${x.kind === "source" ? ` <span class="dim">+${y.at}</span>` : ""}</div>`).join("")}${one}</td>`;
    } },
  { k: "xfits", h: "Fits", d0: -1,
    key: v => {
      const x = exaltOf(v); if (!x) return null;
      const X = window.EQLExaltCore;
      if (x.kind === "loose") { let n = 0; for (const y of x.l.yields.filter(y => y.type)) n += X.homesFor(y, EXALT.worn).now.length; return n; }
      if (x.kind === "socketed") { if (!x.st.stone || !x.host.rec) return null; return X.fit(x.st.stone, { cls: x.host.cls, sl: x.host.sl, tier: x.host.tier }).ok ? 1 : 0; }
      return x.src.yields.filter(y => y.type && x.src.tier >= y.at).length;
    },
    cell: v => {
      const x = exaltOf(v);
      if (!x) return `<td></td>`;
      const X = window.EQLExaltCore;
      if (x.kind === "loose") {
        const lines = [];
        for (const y of x.l.yields.filter(y => y.type)) {
          const h = X.homesFor(y, EXALT.worn);
          const now = h.now.map(z => `${esc(z.w.slot)}: ${esc(z.w.row.base)}${z.occupied ? ' <span class="dim">(holds one)</span>' : ""}${z.f.narrowsCls ? ` <span class="ivb ivb--warn" title="would be usable only by ${esc(X.clsText(z.f.cls))}">narrows</span>` : ""}`);
          const later = h.later.map(z => `${esc(z.w.slot)}: ${esc(z.w.row.base)} <span class="dim">at +${z.needs}</span>`);
          lines.push(`<div>${now.join("; ") || '<span class="dim">nothing you wear</span>'}${later.length ? ` <span class="dim">· after upgrade: ${later.join("; ")}</span>` : ""}</div>`);
        }
        return `<td class="iv-by">${lines.join("")}</td>`;
      }
      if (x.kind === "socketed") {
        if (!x.st.stone || !x.host.rec) return `<td><span class="dim">no wiki record to check</span></td>`;
        const f = X.fit(x.st.stone, { cls: x.host.cls, sl: x.host.sl, tier: x.host.tier });
        return f.ok ? `<td><span class="ok">in ${esc(x.host.row.base)}</span>${f.narrowsCls ? ` <span class="dim">→ ${esc(X.clsText(f.cls))}</span>` : ""}</td>`
                    : `<td><span class="ivb ivb--warn" title="the wiki's class or slot line for one of these two items disagrees with the game, which accepted this exaltation (${esc(f.why.join("; "))})">wiki?</span></td>`;
      }
      const ys = x.src.yields.filter(y => y.type);
      return `<td>${ys.map(y => {
        const sk = x.src.sockets[y.type];
        if (x.src.socketsKnown && sk.open && !sk.filled) return `<div class="dim">${esc(y.effect)}: pulled out already</div>`;
        if (x.src.socketsKnown && sk.filled && sk.stone.key !== x.src.key) return `<div class="dim">${esc(y.effect)}: replaced by ${esc(sk.stone.row.base)}</div>`;
        return x.src.tier >= y.at ? `<div><span class="ok">ready</span> to pull ${esc(y.effect)}</div>` : `<div class="dim">${esc(y.effect)}: +${x.src.tier} of +${y.at}</div>`;
      }).join("")}</td>`;
    } },
  { k: "xsock", h: "Sockets", d0: -1,
    key: v => { const x = exaltOf(v); if (!x || x.kind !== "source" || !x.src.socketsKnown) return null; return Object.values(x.src.sockets).filter(s => s.filled).length; },
    cell: v => {
      const x = exaltOf(v);
      if (!x || x.kind !== "source" || !x.src.socketsKnown) return `<td></td>`;
      const X = window.EQLExaltCore;
      return `<td class="iv-by">${X.TYPES.map(t => {
        const sk = x.src.sockets[t.key];
        const body = sk.filled ? esc(sk.stone.stone ? sk.stone.stone.effect : sk.stone.row.base) : sk.open ? "empty" : `+${t.at}`;
        return `<span class="ivb ivb--x${t.key}${sk.filled ? "" : " ivb--dim"}" title="${t.label}: ${sk.filled ? "holds " + body : sk.open ? "open, empty" : "opens at +" + t.at}">${t.label[0]} ${body}</span>`;
      }).join(" ")}</td>`;
    } },

  /* ── the three ranking columns ─────────────────────────────────────────
     Kyle's Gear-mode spec, verbatim: "best for classes (a list of classes for
     which this is judged the #1 item for a slot - remember some slots need 2
     items so the 2nd best is still bis)". So a class is listed when the item
     holds a position in a slot for it, and a paired slot has two positions. */
  { k: "bis", h: "Best for", d0: -1,
    key: v => { const s = spareOf(v); return s ? (s.bis.length || null) : null; },
    cell: v => {
      const s = spareOf(v);
      if (!s) return `<td class="iv-cls"></td>`;
      if (!s.bis.length) return `<td class="iv-cls"><span class="dim">—</span></td>`;
      const where = {};
      for (const n of s.niches) if (n.ahead < n.cap) (where[n.cls] || (where[n.cls] = [])).push(`${n.slot}${n.cap > 1 ? ` #${n.ahead + 1}` : ""}`);
      // sixteen codes in a cell is a wall; the rest of the app already says ALL
      if (s.bis.length === CLS_ORDER.length)
        return `<td class="iv-cls"><span class="ivb ivb--bis" title="first pick for every class that can wear it">ALL</span></td>`;
      return `<td class="iv-cls">${clsSort(s.bis).map(c =>
        `<span class="ivb ivb--bis" title="${esc(`${window.EQLChar.name(c)}: ${where[c].join(", ")}`)}">${c}</span>`).join(" ")}</td>`;
    } },
  { k: "ahead", h: "Better", d0: -1,
    key: v => { const s = spareOf(v); return s ? s.ahead : null; },
    cell: v => {
      const s = spareOf(v);
      if (!s) return `<td class="iv-n"></td>`;
      if (s.noClass) return `<td class="iv-n"><span class="dim" title="the wiki lists no class that can equip this">no class</span></td>`;
      const b = s.best;
      const t = `${s.ahead} of the items you own beat this for a ${window.EQLChar.name(b.cls)} in ${b.slot}` +
        `${b.cap > 1 ? ` — that slot takes ${b.cap}` : ""}` +
        (s.aheadAsIs !== s.ahead ? `. At the tiers they are actually at: ${s.aheadAsIs}.` : "");
      return `<td class="iv-n"><b>${s.ahead}</b>${s.spare ? "" : `<span class="dim"> / ${b.cap}</span>`}` +
        `<span class="iv-nichex" title="${esc(t)}">${esc(b.cls)} ${esc(b.slot)}</span></td>`;
    } },
  { k: "beatenby", h: "Beaten by", d0: 1,
    key: v => { const s = spareOf(v); return s && s.best && s.best.by.length ? s.best.by[0].item.row.name.toLowerCase() : null; },
    cell: v => {
      const s = spareOf(v);
      if (!s || !s.best || !s.best.by.length) return `<td class="iv-by"></td>`;
      /* One wrapping line, not one line per rival — stacked divs made every
         row in the table four lines tall. */
      const CAP = 3;
      const rows = s.best.by.slice(0, CAP).map(x =>
        `<span class="iv-byline">${itemSpan(x.item.row.name, true)} <span class="dim">${esc(whereText(x.item.row.loc))}</span></span>`);
      const more = s.best.ahead > Math.min(CAP, s.best.by.length)
        ? `<span class="iv-byline dim">+${s.best.ahead - Math.min(CAP, s.best.by.length)} more</span>` : "";
      return `<td class="iv-by">${rows.join("")}${more}</td>`;
    } },
];
/* One saved column set PER MODE. The three modes ask different questions and
   a single shared set meant switching to Gear showed the quest columns.
   Defaults are what Kyle asked each mode for and nothing else — the picker is
   how you get the rest. */
const IV_DEFAULTS = {
  quest: ["where", "item", "qty", "quests"],
  gear:  ["where", "item", "bis"],
  spare: ["where", "item", "ahead", "beatenby"],
  exalt: ["where", "item", "tier", "xeff", "xfits", "xsock"],
};
const IV_DEFAULT_COLS = IV_DEFAULTS.quest;
const IV_COLS_KEY = "eqlt-companion-invcols-v2";
const IV_MODE_COLS = {};
let IV_SHOW = new Set(IV_DEFAULTS.quest);
function loadInvCols() {
  for (const m of INV_MODES) IV_MODE_COLS[m] = new Set(IV_DEFAULTS[m]);
  try {
    const o = JSON.parse(localStorage.getItem(IV_COLS_KEY));
    if (o && typeof o === "object") for (const m of INV_MODES) {
      if (Array.isArray(o[m]) && o[m].length)
        IV_MODE_COLS[m] = new Set(o[m].filter(k => IV_COLS.some(c => c.k === k)));
    }
  } catch { /* defaults stand */ }
  for (const m of INV_MODES) IV_MODE_COLS[m].add("item");
  syncInvCols();
}
// the mode's own set, aliased so every existing IV_SHOW reader keeps working
function syncInvCols() {
  const m = invMode();
  if (!IV_MODE_COLS[m]) IV_MODE_COLS[m] = new Set(IV_DEFAULTS[m]);
  IV_SHOW = IV_MODE_COLS[m];
}
function saveInvCols() {
  try {
    const o = {};
    for (const m of INV_MODES) o[m] = [...IV_MODE_COLS[m]];
    localStorage.setItem(IV_COLS_KEY, JSON.stringify(o));
  } catch {}
}
const invMode = () => (INV_MODES.includes(INV_VIEW) ? INV_VIEW : "quest");
const invVisibleCols = () => IV_COLS.filter(c => IV_SHOW.has(c.k));
function renderInvColPicker() {
  syncInvCols();
  $("invColsBody").innerHTML = IV_COLS.map(c => `<label class="chk invcols__row">
    <input type="checkbox" data-ivcol="${c.k}" ${IV_SHOW.has(c.k) ? "checked" : ""} ${c.always ? "disabled" : ""}> ${c.h}</label>`).join("");
}

/* An exaltation row carries its socket with it, so the hover can say which of
   the source item's properties this stone actually holds. */
function exaltSpan(r) {
  const sock = window.EQLExalt.socketAt(r.loc);
  return `<span class="itn" data-tt="${esc(r.name)}" data-exalt="${sock ? sock.n : 0}">${esc(r.name)}</span>`;
}

/* What the score could not read, said on the item rather than in a footnote.
   The scorer prices stats, resists, AC, haste and weapon ratio; a click, a
   proc, a worn effect and a bard's resonance are invisible to it, and the
   first run of this ranking put a lute and a war horn at the top of the list
   of things to throw away. A quest chip rides along here too — Kyle chose a
   chip over a separate section (2026-08-14). */
const UNSCORED_WORD = { inst: "instrument", effect: "effect", charges: "charges" };
function spareChips(v) {
  if (invMode() === "quest") return "";
  const s = spareOf(v);
  const out = [];
  if (v.quests.length) out.push(`<span class="ivb ivb--quest" title="${esc(v.quests.map(q => q.n).join(", "))}">quest</span>`);
  if (s) for (const u of s.unscored)
    out.push(`<span class="ivb ivb--warn" title="Its ${UNSCORED_WORD[u]} is not part of the score.">${UNSCORED_WORD[u]}</span>`);
  if (s && s.spareAsIs && !s.spare)
    out.push(`<span class="ivb" title="At the upgrade ranks these items are actually at, this one is beaten. It wins the comparison only because it was scaled up to match.">needs +${s.upgradeTo || "?"}</span>`);
  else if (s && s.spare && s.upgradeTo)
    out.push(`<span class="ivb" title="Taking it to +${s.upgradeTo} would put it back in a slot.">+${s.upgradeTo} saves it</span>`);
  return out.join("");
}
function cmpNullLast(a, b, dir) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a < b ? -1 : a > b ? 1 : 0) * dir;
}

function populateInvFilters() {
  const codes = new Set();
  if (GDATA) for (const rec of Object.values(GDATA.items)) {
    const c = rec.cls;
    if (c && c.c) for (const code of c.c) codes.add(code);
    if (c && c.x) for (const code of c.x) codes.add(code);
  }
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  $("invClass").innerHTML = opt("", "any class") + [...codes].sort().map(c => opt(c, c)).join("");
  if (IV.cls) $("invClass").value = IV.cls;
}

function invRow(v, cols) {
  const open = IV_OPEN.has(v.r.id);
  return `<tr class="ivr ${v.quests.length ? "is-quest" : ""} ${v.oe ? "is-oe" : ""} ${open ? "is-open" : ""}" data-ivx="${v.r.id}">
    ${cols.map(c => c.cell(v)).join("\n    ")}
  </tr>` + (open ? `<tr class="ivd"><td colspan="${cols.length}">${invDetail(v)}</td></tr>` : "");
}

function invDetail(v) {
  const g = v.g;
  const parts = [];
  if (v.vars) {
    const gbase = (GDATA && GDATA.base) || "";
    parts.push(`<div class="ivd__vars"><div class="dim">${v.vars.length} wiki items share this name — the columns show the first:</div>${v.vars.map(rec => {
      const st = Object.entries(rec.st || {}).map(([k, n]) => `${n > 0 ? "+" : ""}${n} ${STAT_LABEL[k] || k.toUpperCase()}`).join(" ");
      const bits = [(rec.sl || []).join(" "), st, rec.dmg && rec.dly ? `${rec.dmg}/${rec.dly}` : "",
        ERA_SHORT(rec.era), codesText(rec.cls)].filter(Boolean).join(" · ");
      return `<div><a class="wk" data-url="${esc(gbase + rec.t)}">${esc(rec.t.replace(/_/g, " "))}</a>${bits ? ` <span class="dim">${esc(bits)}</span>` : ""}</div>`;
    }).join("")}</div>`);
  }
  if (v.src.zones) {
    // a Fine Steel weapon drops in 51 zones from 200+ mobs — cap what one
    // panel shows; the item's wiki page carries the full list
    const ZCAP = 10, MCAP = 8;
    parts.push(`<div class="ivd__src">${v.src.zones.slice(0, ZCAP).map(([z, mobs, note]) => {
      const zl = QZONES[z] ? `<a class="wk" data-wiki="${esc(QZONES[z])}">${esc(z)}</a>` : esc(z);
      const ms = (mobs || []).slice(0, MCAP).map(([mn, lvl, rar]) =>
        `${mobSpan(mn)}${lvl || rar ? ` <span class="dim">(${esc([lvl, rar && String(rar).toLowerCase()].filter(Boolean).join(", "))})</span>` : ""}`).join(", ")
        + (mobs && mobs.length > MCAP ? ` <span class="dim">+${mobs.length - MCAP} more</span>` : "");
      const tail = [ms, note && esc(note)].filter(Boolean).join(" · ");
      return `<div>${zl}${tail ? ` — ${tail}` : ""}</div>`;
    }).join("")}${v.src.zones.length > ZCAP
      ? `<div class="dim">+${v.src.zones.length - ZCAP} more zones — the full list is on the wiki page</div>` : ""}</div>`);
  }
  const rest = v.src.kinds.filter(k => k !== "drops");
  if (rest.length) parts.push(`<div class="dim">${rest.map(esc).join(" · ")}</div>`);
  if (g && g.eff && g.eff.length) parts.push(`<div>${g.eff.map(e =>
    `${esc(e.n)}${e.m || e.l || (e.ct && e.ct !== "Instant") ? ` <span class="dim">(${[e.m, e.l && `lvl ${e.l}`, e.ct && e.ct !== "Instant" && e.ct].filter(Boolean).map(esc).join(", ")})</span>` : ""}`).join(" · ")}</div>`);
  if (g && g.ex) parts.push(`<div class="dim">${Object.entries(g.ex).map(([k2, val]) => esc(`${k2}: ${val}`)).join(" · ")}</div>`);
  if (!parts.length) parts.push(`<span class="dim">nothing more known about this item</span>`);
  return parts.join("");
}

const INV_HINT = $("invEmpty").innerHTML;
function renderInv() {
  const body = $("invBody"), empty = $("invEmpty"), tabs = $("invTabs"), banner = $("invBanner");
  if (!INV.rows) {
    $("invMeta").textContent = ""; body.innerHTML = ""; tabs.hidden = true; banner.hidden = true;
    if (INV.problem) empty.textContent = INV.problem; else empty.innerHTML = INV_HINT;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  banner.hidden = !!GDATA;
  if (!GDATA) banner.textContent = "Item stats, flags and sources need the gear dataset — refresh from eqltools.com in Settings.";
  const mode = invMode();
  syncInvCols();
  /* Spare states the rule it ranks by. Without it the number in the Better
     column is uninterpretable, and this is the one mode whose output is a
     suggestion to get rid of something. Quest and Gear say nothing — their
     columns are the explanation. */
  const note = $("invNote");
  note.hidden = mode !== "spare" && mode !== "exalt";
  if (mode === "exalt") {
    note.innerHTML = `Everything in the dump that is an exaltation or could yield one. `
      + `An exaltation keeps its item's class and slot lines and the item you put it in becomes the overlap; the game refuses a pair with no shared class. `
      + `Sockets open at +1 focus, +2 click, +3 worn, +4 proc, and the same tier pulls the effect out of the item that has it. `
      + `<span class="dim">Full finder by slot: eqltools.com/exalt.</span>`;
  }
  if (mode === "spare") {
    note.innerHTML = `Every class that can wear it has better options in every slot it fits. `
      + `<b>Better</b> counts what beats it in the slot where it does best — Ear, Wrist, Fingers and Any Slot keep two. `
      + `An item at a lower upgrade rank is scaled up to its rival's before the comparison. `
      + `<span class="dim">Clicks, procs, worn effects and bard resonance are not part of the score; items carrying one are chipped.</span>`;
  }
  const needle = $("invSearch").value.trim().toLowerCase();
  const qOnly = $("invQuestOnly").checked;
  // a gear record with NO cls field is an unrestricted item (the wiki page had
  // no Class: line) — /gear's legal() reads it the same way
  const clsOk = v => !IV.cls || (v.g &&
    (!v.g.cls || (v.g.cls.all ? !(v.g.cls.x || []).includes(IV.cls) : (v.g.cls.c || []).includes(IV.cls))));
  const tradeOk = v => !IV.trade ||
    (IV.trade === "yes" ? v.trade === "yes"
      : IV.trade === "att" ? v.trade === "attunable"
      : v.trade === "no drop" || v.trade === "no trade");
  /* Spare keeps only the rows the analysis calls beaten. Gear keeps every row
     it could rank — an unresolvable row (a gem, a bag, a tradeskill component)
     has no slot and no classes, so there is nothing to be best at, and it
     belongs in Quest mode where it can still carry a turn-in. */
  const modeOk = v => {
    if (mode === "quest") return true;
    if (mode === "exalt") return !!exaltOf(v);
    const s = spareOf(v);
    if (!s) return false;
    return mode === "gear" || s.spare;
  };
  const pool = INV.rows.map(invView).filter(v =>
    modeOk(v) && (!qOnly || v.quests.length) && tradeOk(v) && clsOk(v) &&
    (!needle || v.hay.includes(needle)));
  // subtab counts respect every other filter: searching shows WHERE the hits live
  const counts = { all: pool.length };
  for (const v of pool) counts[v.r.sec] = (counts[v.r.sec] || 0) + 1;
  if (IV.tab !== "all" && !counts[IV.tab]) IV.tab = "all"; // a filter emptied the active tab
  tabs.hidden = false;
  tabs.innerHTML = [["all", "All"], ...INV_SECTIONS.map(([k, label]) => [k, label])]
    .filter(([k]) => k === "all" || counts[k])
    .map(([k, label]) => `<button class="invtab ${IV.tab === k ? "is-on" : ""}" data-ivtab="${k}">${label} <span class="invtab__n">${counts[k] || 0}</span></button>`).join("");
  const rows = pool.filter(v => IV.tab === "all" || v.r.sec === IV.tab);
  const cols = invVisibleCols();
  // the sort belongs to the MODE — Spare opens on the most-beaten item, and
  // carrying Quest's "where" sort into it buries the answer
  const st = IV_SORT[mode];
  if (!IV_SHOW.has(st.k)) { st.k = cols[0].k; st.d = cols[0].d0; } // hiding the sorted column resets the sort
  IV.sort = st.k; IV.dir = st.d;
  const col = IV_COLS.find(c => c.k === st.k) || cols[0];
  rows.sort((a, b) => cmpNullLast(col.key(a), col.key(b), st.d) || (a.r.idx - b.r.idx));
  // the weight total belongs to the Wt column — hidden column, no stray number
  const wt = IV_SHOW.has("wt") ? rows.reduce((n, v) => n + (v.wt != null ? v.wt * v.r.count : 0), 0) : null;
  const scope = mode === "quest" ? `${rows.length} of ${INV.rows.length} items`
    : mode === "exalt" ? `${rows.length} rows · ${EXALT ? EXALT.loose.length : 0} loose exaltations · ${EXALT ? EXALT.worn.length : 0} worn`
    : `${rows.length} of ${SPARE ? SPARE.items.length : 0} rankable items`;
  $("invMeta").textContent =
    `${INV.file} · dumped ${new Date(INV.mtime).toLocaleString()} · ${scope}${wt != null ? ` · ${Math.round(wt * 10) / 10} wt` : ""}`;
  const arrow = k => st.k === k ? (st.d > 0 ? " ▲" : " ▼") : "";
  body.innerHTML = rows.length
    ? `<table class="qtab ivt"><thead><tr>${cols.map(c =>
        `<th class="is-sort${c.k === "item" ? " iv-item" : ""}" data-ivsort="${c.k}">${c.h}${arrow(c.k)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(v => invRow(v, cols)).join("")}</tbody></table>`
    : `<p class="empty">${invEmptyText(mode)}</p>`;
  retip();
}

/* Why a mode is showing nothing. "Nothing matches those filters" is wrong for
   two of the three cases and sends you looking for a filter you never set. */
function invEmptyText(mode) {
  const filtered = $("invSearch").value.trim() || $("invQuestOnly").checked || IV.trade || IV.cls;
  if (filtered) return "Nothing matches those filters.";
  if (mode === "quest") return "Nothing in the dump.";
  if (mode === "exalt") return EXALT ? "Nothing in the dump is an exaltation or yields one." : "The gear dataset has not loaded — refresh from eqltools.com in Settings.";
  if (!SPARE) return "The gear dataset has not loaded — refresh from eqltools.com in Settings.";
  if (!SPARE.items.length) return "Nothing in the dump resolves to an item the wiki has stats for.";
  return mode === "spare"
    ? "Nothing you own is beaten in every slot it fits."
    : "Nothing in the dump can be ranked.";
}

/* ── Quests tab — search every wiki quest, track any, see what's hand-in ready ─
   Held counts cross the newest inventory dump with loot seen live since it (a
   fresh dump supersedes the live tally). A quest counts as READY when you hold
   every item it needs, in the quantity it needs.

   What the dataset now says, and what it still can't:

   1. Quantities are real. 217 of 904 quests state a count for at least one
      item ('3x [[Flawed Emerald]]', 'three [[Flawless Diamond]]s', 'Hand him 4
      [[Bone Chips]]'), and q.need carries the total — recipe-expanded, so a
      seven-piece Lambent set asks for the seven Lambent Stones its own page
      never adds up. Where a page states no count, the requirement is one.
   2. A quest PAGE is often several turn-ins. q.parts splits them (120 pages),
      each with its own giver and hand-in list; q.split says the split is real
      rather than assumed. A part named "" is what the page lists outside any
      turn-in section — usually a summary table — and is shown as such.
   3. 114 quests list no items at all (index pages like "Bone Chips Quests",
      and chain articles). They stay searchable — with the gap named on the row
      — but hold nothing to track and can never be "ready".
   4. Zones come from each item's own wiki page (dropsfrom/soldby/foraged),
      which is written zone-by-zone with the mobs under each. 1,699 of 3,020
      quest items resolve to at least one zone; the rest bucket as "many zones"
      or "source not listed" rather than being quietly dropped.

   Tracking: q.t (the quest's wiki path) is unique across all 904 quests and
   survives dataset refreshes, so it is the stored key. Tracked progress also
   feeds the overlay through main's relay (pushQuests). */
const TURNIN = { q: "", readyOnly: false }; // Turn-ins tab — filter within held quests
const QB = { q: "", cls: "", zone: "", era: "", lvlMin: "", lvlMax: "", sort: "name", dir: 1 }; // Quests browser
const QEXPANDED = new Set(); // browser rows opened to full detail (q.t keys)
const QPARTS_OPEN = new Set(); // quests whose turn-in list is expanded (q.t keys)
const TRACK_KEY = "eqlt-companion-tracked-v1";
const TRACK_VIEW_KEY = "eqlt-companion-trackview-v1";
let TRACKED = []; // q.t keys, in the order the player tracked them
let TRACK_VIEW = "quest"; // "quest" | "zone"
function loadTracked() {
  try { const a = JSON.parse(localStorage.getItem(TRACK_KEY)); TRACKED = Array.isArray(a) ? a.filter(t => typeof t === "string") : []; }
  catch { TRACKED = []; }
  try { TRACK_VIEW = localStorage.getItem(TRACK_VIEW_KEY) === "zone" ? "zone" : "quest"; }
  catch { TRACK_VIEW = "quest"; }
}
function setTrackView(v) {
  TRACK_VIEW = v === "zone" ? "zone" : "quest";
  try { localStorage.setItem(TRACK_VIEW_KEY, TRACK_VIEW); } catch {}
  for (const b of document.querySelectorAll("[data-trackview]"))
    b.classList.toggle("is-on", b.dataset.trackview === TRACK_VIEW);
  renderTrackedTab();
}
function saveTracked() { try { localStorage.setItem(TRACK_KEY, JSON.stringify(TRACKED)); } catch {} }
function toggleTrack(t) {
  const i = TRACKED.indexOf(t);
  if (i >= 0) TRACKED.splice(i, 1); else TRACKED.push(t);
  saveTracked(); renderQuests(); pushQuests();
}

let LIVE_HAVE = new Map(); // normName -> qty looted since the current dump

/* ── items the app CANNOT see you holding ─────────────────────────────────
   Held counts come from a `/outputfile inventory` dump plus loot lines. Two
   real holdings never reach either: something you bought from a merchant
   (the client prints no line for an ordinary merchant sale — the "You've
   bought" string belongs to the barter log) and something parked on your
   pet (/outputfile has no `pet` option, and handing an item over prints
   nothing). Both leave the tracker demanding an item you already own
   (Kyle, 2026-08-11: bought a Fire Opal; Ghoulbane on the pet).

   So the player can say it: a marked item counts as held, and every row
   that leans on the mark SAYS it's a mark, never dressing it up as
   something observed. Cleared by clicking again. */
const HELD_KEY = "eqlt-companion-held-v1";
let HELD = new Map();   // itemKey -> {n, c} the player says they hold
function loadHeld() {
  try {
    const o = JSON.parse(localStorage.getItem(HELD_KEY)) || {};
    HELD = new Map(Object.entries(o).filter(([, v]) => v && typeof v === "object")
      .map(([k, v]) => [k, { n: String(v.n || k), c: Math.max(1, +v.c || 1) }]));
  } catch { HELD = new Map(); }
}
function saveHeld() {
  try { localStorage.setItem(HELD_KEY, JSON.stringify(Object.fromEntries(HELD))); } catch {}
}
// toggle: mark `want` of this item held, or drop the mark if it already has one
function toggleHeld(name, want) {
  const k = itemKey(name);
  if (HELD.has(k)) HELD.delete(k);
  else HELD.set(k, { n: name, c: Math.max(1, want || 1) });
  saveHeld();
  renderInv(); renderQuests(); pushQuests(); renderSky(); pushSky();
}
const heldMark = name => HELD.get(itemKey(name)) || null;

// normName -> total count held, keyed BOTH raw and decoration-stripped so a
// "Giant Snake Fang +4" in the dump answers a bare "Giant Snake Fang".
/* itemKey, not normName: an inventory dump prints the item's real name, so
   'Sapphire' and 'A Sapphire' are two rows and must stay two counts. The loose
   fallback lives in held() below, so a dump row that DOES carry a stray article
   still finds its item. */
function haveMap() {
  const m = new Map();
  for (const r of INV.rows || []) {
    // an exaltation stone carries the name of an item you no longer own
    if (r.exalt) continue;
    for (const k of new Set([itemKey(r.name), itemKey(stripDecor(r.name))]))
      m.set(k, (m.get(k) || 0) + r.count);
  }
  for (const [k, c] of LIVE_HAVE) m.set(k, (m.get(k) || 0) + c);
  // a mark is a FLOOR, never a sum: re-dumping with the item finally visible
  // must not read as two of them
  for (const [k, v] of HELD) m.set(k, Math.max(m.get(k) || 0, v.c));
  return m;
}
// how many of a WIKI-named item the player holds: exact, then article-stripped
function heldCount(have, name) {
  const exact = have.get(itemKey(name)) ?? have.get(itemKey(stripDecor(name)));
  if (exact !== undefined) return exact;
  const lk = K.normName(name), lk2 = K.normName(stripDecor(name));
  for (const [k, c] of have) if (K.normName(k) === lk || K.normName(k) === lk2) return c;
  return 0;
}

/* A quest's shopping list: q.need (rolled up and recipe-expanded) crossed with
   what you hold. `got` counts items you hold ENOUGH of — with quantities in the
   data, holding one of four Bone Chips is not holding Bone Chips. Older
   datasets have no `need`; those fall back to the flat item list at one each,
   so a companion that hasn't refreshed still works. */
function compsFor(q, have) {
  const held = n => heldCount(have, n);
  /* An item this quest's own steps hand you (give-step `out`) is chain-made,
     not farmed — and the item's GLOBAL src can be a different item wearing the
     same name ('Sealed Note' is five distinct notes on one wiki page; the
     SoulFire one comes from Assistant Kiolna, not The Prophet in Crushbone).
     The step knows better than the item page: source these rows from the
     step's NPC. */
  const madeBy = new Map();          // itemKey -> [every step producing it]
  for (const st of q.steps || []) {
    for (const [n] of st.out || []) {
      const k2 = itemKey(n);
      if (!madeBy.has(k2)) madeBy.set(k2, []);
      madeBy.get(k2).push(st);
    }
  }
  /* The zone list is a "do now" list, so it obeys the step graph the same
     way the checklist does: an item whose EVERY producing step is locked
     behind unmet prereqs (Testimony needs Token of Truth needs Guard Willia
     needs both token turn-ins — Kyle, 2026-08-11) is not something to go
     get yet. `lk` rows stay in the counts and the checklist but never
     render as a zone row until the chain reaches them. */
  const ss = stepState(q, have);
  const stStateOf = new Map((ss ? ss.states : []).map(s => [s.st, s]));
  const rows = (q.need && q.need.length ? q.need : (q.items || []).map(n => [n, 1]))
    .map(([n, want]) => {
      const mks = madeBy.get(itemKey(n)) || [];
      const giver = mks.find(st2 => st2.k === "give" && st2.npc);
      const st = giver
        ? { npc: giver.npc, z: giver.z || (NPCLOC[giver.npc] && NPCLOC[giver.npc].z) || "" }
        : undefined;
      const states = mks.map(st2 => stStateOf.get(st2)).filter(Boolean);
      const lk = states.length > 0 && states.every(s2 => !s2.done && !s2.can);
      return { n, want, have: held(n), fr: q.from && q.from[n],
               ...(st ? { st } : {}), ...(lk ? { lk: true } : {}) };
    });
  const got = rows.filter(c => c.have >= c.want).length;
  return { q, comps: rows, got, need: rows.length, done: rows.length > 0 && got === rows.length };
}

/* Pool tracked plans into one shopping list: an item two quests want is one
   thing to farm, at the larger requirement. The tag names the quest by its
   SHORT name (a tracked turn-in is "Paladin Test of Sacrifice", never
   "… — Paladin Plane of Sky Tests" — the hub is noise on an item row), and
   `tt` carries what the quest pays, for the hover (Kyle, 2026-08-09: "when i
   mouse over the quest name, show me the reward"). */
function mergePlans(plans) {
  const merged = new Map();
  for (const p of plans) {
    const name = p.q.sn || p.q.n;
    const rew = (p.q.rewards || []).slice(0, 4).join(", ");
    for (const c of p.comps) {
      const k = itemKey(c.n), cur = merged.get(k);
      if (cur) {
        cur.want = Math.max(cur.want, c.want); cur.quests.set(name, rew);
        // one quest chain-makes it, another farms it: the pooled row can't
        // claim the chain (same-named items are sometimes different items) —
        // and it hides only when EVERY quest that wants it says locked
        if (!cur.st !== !c.st) cur.st = undefined;
        cur.lk = cur.lk && c.lk;
      }
      else merged.set(k, { n: c.n, want: c.want, have: c.have, st: c.st,
                           lk: !!c.lk, quests: new Map([[name, rew]]) });
    }
  }
  return [...merged.values()].map(r => {
    const names = [...r.quests.keys()];
    const tt = names.map(n => r.quests.get(n) ? `${n} → ${r.quests.get(n)}` : n).join("\n");
    return { n: r.n, want: r.want, have: r.have,
             ...(r.st ? { st: r.st } : {}),
             ...(r.lk ? { lk: true } : {}),
             tag: names.length > 1 ? `${names.length} quests` : names[0],
             ...(tt ? { tt } : {}) };
  });
}

/* A tracked key is a quest path, or "path::partIndex" for ONE turn-in off a
   hub page — the Plane of Sky test pages are five separate quests wearing one
   URL, and tracking "Paladin Test of Love" must not drag the other four
   tests' shopping lists along (Kyle, 2026-08-09). A part-plan is a pared-down
   pseudo-quest: that part's items only, the base page kept for the wiki link. */
function trackedPlan(key, have) {
  // a Sky test tracked from the Sky tab: sky.json is its source, because its
  // wiki page is a `{{#lsth:}}` stub the quest parser reads as empty
  if (key.startsWith(SKY_TRACK)) return skyTrackPlan(key, have);
  const ix = key.indexOf("::");
  const t = ix < 0 ? key : key.slice(0, ix);
  const q = T2Q.get(t);
  if (!q) return null;
  if (ix < 0) return compsFor(q, have);
  const p = (q.parts || [])[+key.slice(ix + 2)];
  if (!p) return null;
  const held = n => heldCount(have, n);
  const rows = p.c.map(([n, want]) => ({ n, want, have: held(n), fr: q.from && q.from[n] }));
  const got = rows.filter(c => c.have >= c.want).length;
  const short = p.n || `Turn-in ${+key.slice(ix + 2) + 1}`;
  const pq = {
    ...q, t: key, wk: q.t,
    // full name for browser rows (the hub gives context in a big table);
    // sn for the overlay and zone-view tags, where the hub is just noise
    n: `${short} — ${q.n}`, sn: short,
    giver: p.g || q.giver, rewards: p.r || [], need: p.c,
    items: p.c.map(([n]) => n), parts: [], split: undefined,
    steps: undefined, roles: undefined,
  };
  return { q: pq, comps: rows, got, need: rows.length,
           done: rows.length > 0 && got === rows.length };
}

/* ── step state ───────────────────────────────────────────────────────────
   Quests with a parsed step graph (q.steps) know their order: what's done,
   what you can do right now, and what is locked behind an earlier hand-in.
   Locked steps are noise while wandering — the UI folds them away (Kyle,
   2026-08-09: "things they can't do yet is noise").

   done, inferred from the bag: a made step (give/combine) is done when its
   product is in hand, or when anything consuming that product is done — you
   can't hold the Gleaming coin without having handed over the Glowing one.
   World pickups pool: holding 3 of the 10 coins marks 3 pins done. */
function stepState(q, have) {
  const steps = q.steps || [];
  if (!steps.length) return null;
  const held = n => heldCount(have, n);
  const done = new Map();
  const outsHeld = st => (st.out || []).length &&
    st.out.every(([n]) => held(n) >= 1);
  for (let j = steps.length - 1; j >= 0; j--) {
    const st = steps[j];
    const consumerDone = steps.some(s2 => (s2.pre || []).includes(st.i) && done.get(s2.i));
    // world pickups (no inputs) are pooled below — ten coin pins all "hold"
    // the same 3 coins, and marking them all done here read 3/10 as complete
    done.set(st.i, consumerDone || ((st.in || st.tool) ? outsHeld(st) : false));
  }
  // pooled world pickups: the first `held` pins of an item count as done
  const pools = new Map();
  for (const st of steps) {
    if (st.in || st.tool || !(st.out || []).length) continue;
    if (done.get(st.i)) continue;
    const n = st.out[0][0];
    if (!pools.has(n)) pools.set(n, []);
    pools.get(n).push(st);
  }
  for (const [n, pins] of pools) {
    // pins already done via a consumer stay done; these are the leftovers
    const already = steps.filter(s2 => (s2.out || []).some(([m]) => m === n) && done.get(s2.i)).length;
    let k = Math.max(0, Math.min(held(n) - already, pins.length));
    for (const st of pins) { if (k <= 0) break; done.set(st.i, true); k--; }
  }
  const actionable = st => !done.get(st.i) &&
    (st.pre || []).every(i => done.get(i));
  const states = steps.map(st => ({
    st, done: !!done.get(st.i), can: actionable(st),
  }));
  const next = states.find(s => s.can && (s.st.k === "give" || s.st.k === "combine"))
    || states.find(s => s.can);
  const finalGive = [...steps].reverse().find(st => st.k === "give" && (st.in || []).length);
  const handinReady = !!finalGive && finalGive.in.every(([n, w]) => held(n) >= w) &&
    (finalGive.pre || []).every(i => done.get(i));
  return { states, next: next ? next.st : null, handinReady,
           doneN: states.filter(s => s.done).length };
}

// one line of a step as the player acts on it: what, where, from whom
function stepLine(st, cls) {
  const zone = st.z ? `<span class="dim"> · ${esc(st.z)}</span>` : "";
  const loc = st.loc ? `<span class="dim"> (${esc(st.loc)})</span>` : "";
  const npc = st.npc && NPCLOC[st.npc] && NPCLOC[st.npc].z && !st.z
    ? `<span class="dim"> · ${esc(NPCLOC[st.npc].z)}${NPCLOC[st.npc].loc ? ` (${esc(NPCLOC[st.npc].loc)})` : ""}</span>` : "";
  return `<li class="qc qstep ${cls}"><span class="kchk"></span>${esc(st.txt)}${zone}${loc}${npc}</li>`;
}

const QSTEPS_OPEN = new Set(); // quests whose locked-steps fold is expanded
function stepsHtml(q, ss) {
  if (!ss) return "";
  const doable = ss.states.filter(s => s.can);
  const locked = ss.states.filter(s => !s.done && !s.can);
  const open = QSTEPS_OPEN.has(q.t);
  return `<div class="qsteps">
    ${ss.doneN ? `<div class="qsteps__done dim">✓ ${ss.doneN} of ${ss.states.length} steps done</div>` : ""}
    <ul class="qcomps">${doable.map(s => stepLine(s.st, "is-can")).join("")}</ul>
    ${locked.length ? `<button class="qparts__toggle" data-steps="${esc(q.t)}">${open ? "▾" : "▸"}
      ${locked.length} later step${locked.length === 1 ? "" : "s"} — locked until the ones above are done</button>
      ${open ? `<ul class="qcomps">${locked.map(s => stepLine(s.st, "is-locked")).join("")}</ul>` : ""}` : ""}
  </div>`;
}

/* ── where an item comes from ─────────────────────────────────────────────
   Every item lands in exactly one bucket per zone it names, so walking into a
   zone surfaces everything that zone can give you. Items the wiki puts in five
   or more zones (or calls "Various Zones") would otherwise appear under half
   the game, so they get one bucket of their own; items with no stated source
   get another, because "everywhere" and "the wiki doesn't say" are different
   answers and pretending otherwise sends people hunting. */
const MANY = "::many";        // "::" can't collide with a zone name
const NOSRC = "::nosrc";
const BUCKET_LABEL = { [MANY]: "Anywhere · many zones", [NOSRC]: "Source not listed on the wiki" };
const srcFor = name => QSRC[itemKey(name)] ?? QSRC[itemKey(stripDecor(name))]
  ?? QSRC_L[K.normName(name)] ?? QSRC_L[K.normName(stripDecor(name))] ?? null;
/* A dataset built before the source table existed has no `src` at all, and the
   app must not read that silence as "the wiki lists no source" — it would say
   so on every row of every quest. The companion prefers its CACHED download
   over its bundled snapshot, so a freshly installed build hits this until the
   site publishes a rebuild. Fall back to the flat list the older data supports,
   and say why. */
const hasSrc = () => !!(QDATA && QDATA.src);
const STALE_DATA_NOTE = "Quest data is older than this app — items can't be grouped by zone yet. " +
  "It refreshes from eqltools.com automatically, or hit Refresh data in Settings.";

function bucketsFor(name) {
  const s = srcFor(name);
  if (!s) return [NOSRC];
  // an item in five or more zones is not a reason to go anywhere, and listing
  // Fire Opal under eight zone headings buries the one item that IS only here
  if (s.many) return [MANY];
  if (s.z && s.z.length) return s.z;
  return [NOSRC];
}

// how you get this item IN this zone: the mobs to kill, or — when the zone is
// on the item's soldby/foraged list rather than its dropsfrom — what to do
// instead. "Freeport" under a gem means buy it, and a list of mobs to kill
// there would be a lie of omission. A ground spawn gets its coordinates: "in
// Grobb" is a swamp-sized haystack, "(+197, -261)" is a coin in a pool.
const KIND_LABEL = { vendor: "from a merchant", forage: "forage", buy: "buy it" };
function sourceIn(name, zone) {
  const s = srcFor(name);
  if (!s) return { mobs: [] };
  // Plane of Sky items carry their island — the only "where" that matters up there
  const isl = s.isl ? `Isle ${s.isl}` : "";
  const mobs = (s.m && s.m[zone]) || [];
  if (mobs.length) return { mobs, isl };
  const locs = (s.g && s.g[zone]) || [];
  if (locs.length)
    return { mobs: [], isl, note: `ground spawn · ${locs.slice(0, 2).join(" / ")}` };
  const vend = (s.v && s.v[zone]) || [];
  if (vend.length) {
    const [npc, where] = vend[0];
    return { mobs: [], isl, note: `sold by ${npc}${where ? ` · ${where}` : ""}` };
  }
  const i = (s.z || []).indexOf(zone);
  const kind = i >= 0 && s.k ? s.k[i] : null;
  return { mobs: [], isl, note: KIND_LABEL[kind] || "" };
}

/* ── zone distance: how far is each zone from where the player stands ─────
   The dataset ships the wiki's zone adjacency graph (geo). BFS from the
   current zone's node gives every zone a hop count; out-of-era zones aren't
   in the game and don't get walked. Cached per starting node. */
let DIST = { from: null, map: null };
const geoNode = z => GEO && (GEO.nodes[z] ? z : GEO.alias[z] || null);
function zoneDists() {
  if (!GEO) return null;
  const from = KEY2NODE.get(lastStreamZone) || null;
  if (!from) return null;
  if (DIST.from === from) return DIST.map;
  const d = new Map([[from, 0]]);
  const q = [from];
  while (q.length) {
    const n = q.shift();
    for (const m of GEO.nodes[n].adj) {
      const node = GEO.nodes[m];
      if (node && !node.oe && !d.has(m)) { d.set(m, d.get(n) + 1); q.push(m); }
    }
  }
  DIST = { from, map: d };
  return d;
}

/* rows [{n, want, have, tag?}] -> ordered zone buckets. The zone you are
   standing in comes first, then the rest by how many zones away they are —
   and at equal distance the dead-end zone wins (Mistmoore before Greater
   Faydark from Lesser Faydark: you can reach GFay from plenty of other
   places, but Mistmoore only through here, so do it while you're close).
   Zones with something outstanding still outrank cleared ones, and the two
   catch-all buckets sit at the bottom whatever they hold. */
/* The wiki has city pages ('Freeport', 'Kaladim') that cover two or three
   CLIENT zones. You cannot stand in Freeport, so it is never a destination:
   the pipeline resolves those headings to the real zone the mob or merchant
   states, and the handful it cannot resolve are labelled as unresolved
   rather than printed as if they were a place (Kyle, 2026-08-11). A geo node
   carrying more than one atlas key, whose own name is not a zone the log can
   report you standing in, is one of those umbrellas. */
const isUmbrella = z => !!(GEO && GEO.nodes[z] && (GEO.nodes[z].keys || []).length > 1
  && !NAME2KEY.has(String(z).toLowerCase()));

function zoneBuckets(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.lk) continue; // chain-locked: not doable yet, the checklist shows why
    // chain-made rows live where their hand-in happens, not where the item's
    // global src points (which can be a same-named different item)
    const zs = r.st && r.st.z ? [r.st.z] : bucketsFor(r.n);
    for (const z of zs) {
      if (!by.has(z)) by.set(z, []);
      by.get(z).push(r);
    }
  }
  const dist = zoneDists();
  const out = [...by.entries()].map(([z, items]) => {
    items.sort((a, b) => (a.have >= a.want) - (b.have >= b.want) ||
      (a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1));
    const node = dist ? geoNode(z) : null;
    // no graph or no known position: d/deg flat, the old ordering stands
    const d = !dist ? 0 : node && dist.has(node) ? dist.get(node) : 9999;
    const deg = !dist ? 0 : node ? (GEO.nodes[node].adj || []).length : 99;
    return { z, items, d, deg, umb: isUmbrella(z),
             left: items.filter(r => r.have < r.want).length };
  });
  out.sort((a, b) => {
    const ca = a.z in BUCKET_LABEL, cb = b.z in BUCKET_LABEL;
    // an unresolved city sinks below the zones you can actually walk to
    return (ca - cb) || (a.umb - b.umb) || ((b.left > 0) - (a.left > 0)) ||
      (a.d - b.d) || (a.deg - b.deg) || (b.left - a.left) ||
      (a.z < b.z ? -1 : 1);
  });
  return out;
}

const zoneLink = z => BUCKET_LABEL[z]
  ? `<span class="zg__name is-catch">${esc(BUCKET_LABEL[z])}</span>`
  : (QZONES[z] ? `<a class="wk zg__name" data-wiki="${esc(QZONES[z])}">${esc(z)}</a>`
    : `<span class="zg__name">${esc(z)}</span>`)
    + (isUmbrella(z) ? `<span class="zg__umb dim">the wiki doesn't say which zone</span>` : "");

// one item row inside a zone bucket: held/needed, and who drops it here
function zoneItemRow(r, zone) {
  const done = r.have >= r.want;
  const src = done ? { mobs: [] }
    : r.st ? { mobs: [], note: `turn-in at ${r.st.npc}` }
    : sourceIn(r.n, zone);
  const count = r.want > 1 || r.have
    ? `<span class="qct ${done ? "is-ok" : ""}">${r.have}/${r.want}</span>` : "";
  const mobsHtml = src.mobs.slice(0, 3).map(m => {
    const t = mobPath(r.n, m);
    return t ? `<a class="wk" data-wiki="${esc(t)}">${esc(m)}</a>` : esc(m);
  }).join(", ") || esc(src.note || "");
  const who = src.isl ? `${esc(src.isl)}${mobsHtml ? ` · ${mobsHtml}` : ""}` : mobsHtml;
  // an item that is another quest's reward is a quest to do, not a mob to farm
  const fr = !done && r.fr && T2Q.get(r.fr)
    ? `<a class="wk qfrom" data-wiki="${esc(r.fr)}">reward of ${esc(T2Q.get(r.fr).n)}</a>` : "";
  const mark = heldMark(r.n);
  return `<li class="qc ${done ? "is-have" : ""} ${mark ? "is-marked" : ""}">${holdChk(r)}${itemSpan(r.n)}${count}
    ${r.tag ? `<span class="qtag"${r.tt ? ` title="${esc(r.tt)}"` : ""}>${esc(r.tag)}</span>` : ""}
    ${who ? `<span class="qsrc dim">${who}</span>` : ""}${fr ? `<span class="qsrc dim">${fr}</span>` : ""}
    ${mark ? `<span class="qsrc dim">marked held — the app can't see a merchant buy or your pet's bags</span>` : ""}</li>`;
}

/* The checkbox on a component row is the "I have this" switch. It carries the
   item name so one delegated listener serves every list that renders a row. */
const holdChk = r =>
  `<span class="kchk kchk--hold" data-hold="${esc(r.n)}" data-want="${r.want || 1}"
     title="${heldMark(r.n) ? "Marked as held — click to clear" : "Mark as held (bought it, or it's on your pet)"}"></span>`;

// the pre-zone-grouping rendering, kept for datasets that predate `src`:
// item, held/needed, and the lowest-level droppers with their zone
function flatCompsHtml(rows) {
  return `<ul class="qcomps">${rows.map(r => {
    const done = r.have >= r.want;
    const d = done ? [] : dropsFor(r.n).slice(0, 2);
    const src = d.map(([mn, mt, zn, zt]) =>
      `<a class="wk" data-wiki="${esc(mt)}">${esc(mn)}</a>${zn ? ` <span class="dim">·</span> <a class="wk" data-wiki="${esc(zt)}">${esc(zn)}</a>` : ""}`).join(", ");
    return `<li class="qc ${done ? "is-have" : ""} ${heldMark(r.n) ? "is-marked" : ""}">${holdChk(r)}${itemSpan(r.n)}
      ${r.want > 1 || r.have ? `<span class="qct ${done ? "is-ok" : ""}">${r.have}/${r.want}</span>` : ""}
      ${r.tag ? `<span class="qtag">${esc(r.tag)}</span>` : ""}
      ${src ? `<span class="qsrc dim">${src}</span>` : ""}</li>`;
  }).join("")}</ul>`;
}

function zoneGroupsHtml(rows) {
  if (!hasSrc()) return flatCompsHtml(rows);
  const groups = zoneBuckets(rows);
  if (!groups.length) return "";
  // a one-item quest doesn't need a boxed heading over a single row — most of
  // the Turn-ins tab is these, and the chrome outweighs the fact
  if (groups.length === 1 && groups[0].items.length === 1) {
    return `<ul class="qcomps qcomps--bare">${zoneItemRow(groups[0].items[0], groups[0].z)}
      <li class="qc qc--where dim">${zoneLink(groups[0].z)}</li></ul>`;
  }
  return `<div class="zgs">${groups.map(g => `
    <div class="zg ${g.left ? "" : "is-done"}">
      <div class="zg__head">${zoneLink(g.z)}<span class="zg__n">${g.left ? `${g.left} to get` : "all held"}</span></div>
      <ul class="qcomps">${g.items.map(r => zoneItemRow(r, g.z)).join("")}</ul>
    </div>`).join("")}</div>`;
}

let questsTimer = null;
function renderQuestsSoon() { // coalesce loot bursts, same reason as the feed
  if (!questsTimer) questsTimer = setTimeout(() => { questsTimer = null; renderQuests(); pushQuests(); }, 500);
}

/* The overlay's Tracked tab: every tracked quest with its items already grouped
   by zone and counted, plus the mobs to kill in each zone — all resolved here
   because the overlay has no datasets of its own. It ships both shapes: `zones`
   for the pooled by-zone view (the one you read mid-fight) and per-quest rows
   for the by-quest view, so the overlay only has to pick. */
function pushQuests() {
  if (!QDATA) return;
  const have = haveMap();
  const base = QDATA.base || (DATA && DATA.base) || "";
  const itemUrl = n => { const t = lookupItem(TIDX, n); return t && base ? base + t.t : ""; };
  const plans = TRACKED.map(k => trackedPlan(k, have)).filter(Boolean);

  const packRow = (c, zone) => {
    const s = c.have >= c.want ? { mobs: [] }
      : c.st ? { mobs: [], note: `turn-in at ${c.st.npc}` }
      : sourceIn(c.n, zone);
    const note = [s.isl, s.note].filter(Boolean).join(" · ");
    return {
      n: c.n, have: c.have, want: c.want, url: itemUrl(c.n),
      mobs: s.mobs.slice(0, 3), ...(note ? { note } : {}),
      ...(c.tag ? { tag: c.tag } : {}),
      ...(c.tt ? { tt: c.tt } : {}),
      ...(heldMark(c.n) ? { mk: true } : {}),
    };
  };
  // no source table (a dataset older than this app) means no zone answer at
  // all — send the flat list instead of one bucket claiming the wiki is silent
  const packZones = rows => !hasSrc() ? [] : zoneBuckets(rows).map(g => ({
    z: BUCKET_LABEL[g.z] || g.z, url: QZONES[g.z] && base ? base + QZONES[g.z] : "",
    ...(g.umb ? { umb: true } : {}),
    left: g.left, items: g.items.map(c => packRow(c, g.z)),
  }));
  const packFlat = rows => rows.map(c => ({
    ...packRow(c, null),
    mobs: c.have >= c.want ? [] : dropsFor(c.n).slice(0, 2).map(([mn, , zn]) => zn ? `${mn} · ${zn}` : mn),
  }));

  // one item two quests want is one thing to farm — same merge the main window
  // does, so the two views can never disagree about what is left
  const pooled = mergePlans(plans);

  // the one thing to do next per quest, for the overlay's quest rows
  const nextLine = q => {
    const ss = stepState(q, have);
    if (!ss || !ss.next) return null;
    const st = ss.next;
    const where = st.z || (st.npc && NPCLOC[st.npc] && NPCLOC[st.npc].z) || "";
    return `${st.txt.slice(0, 90)}${where ? ` · ${where}` : ""}`;
  };

  window.companion.sendQuests({
    // how old the held counts are: a merchant buy or a pet hand-off never
    // reaches a log line, so "you still need it" is only ever true as of the
    // last dump — the overlay says so rather than implying live truth
    inv: INV.mtime ? { age: Date.now() - INV.mtime } : null,
    zones: packZones(pooled),
    quests: plans.map(p => {
      const nx = nextLine(p.q);
      const rew = (p.q.rewards || []).slice(0, 4).join(", ");
      return {
      n: p.q.sn || p.q.n, url: base ? base + (p.q.wk || p.q.t) : "",
      got: p.got, need: p.need, done: p.done, oe: !!p.q.oe,
      ...(rew ? { rew } : {}),
      ...(nx ? { next: nx } : {}),
      zones: packZones(p.comps),
      ...(hasSrc() ? {} : { comps: packFlat(p.comps) }),
      parts: (p.q.parts || []).map(pt => ({
        n: pt.n, g: pt.g || "",
        c: pt.c.map(([n, want]) => ({
          n, want, have: heldCount(have, n),
        })),
      })),
      };
    }),
  });
}

// facts line shared by full rows and stubs; the chain note only applies to
// quests that DO list components (see questRow's comment). Out of era leads —
// it changes what the whole row means.
function questFacts(q, chain) {
  const oe = q.oe ? `out of era — ${String(q.era || "").replace(/\s*Era$/i, "") || "?"}` : "";
  return [oe, q.lvl ? `lvl ${q.lvl}${q.lvlUse ? ` (use ${q.lvlUse})` : ""}` : "", (q.classes || []).filter(c => c && c !== "?").join("/"),
    q.zone, q.giver ? `→ ${q.giver}` : "", chain ? "multi-step chain — no single turn-in" : ""]
    .filter(Boolean).join(" · ");
}

/* The item page names the mobs per zone but links nothing; `drops` (built from
   the mob corpus) has the wiki paths but only one zone per mob. Crossing them
   gives a linkable mob where both know it and plain text where only the item
   page does — better than dropping either half. */
const dropsFor = name => QDROPS[itemKey(name)] ?? QDROPS[itemKey(stripDecor(name))]
  ?? QDROPS_L[K.normName(name)] ?? QDROPS_L[K.normName(stripDecor(name))] ?? [];
function mobPath(item, mob) {
  const hit = dropsFor(item).find(([mn]) => K.normMob(mn) === K.normMob(mob));
  return hit ? hit[1] : "";
}

/* The turn-in list: what you hand to whom. Shown under the zone groups because
   the zones are what you act on — the parts are what you do when you get back.
   A part named "" is the page's leftovers (a summary table, or items the page
   mentions outside any turn-in section) and says so instead of pretending to
   be a step. */
function partsHtml(q, have) {
  const parts = q.parts || [];
  // no split means the page never said where one turn-in ends; its "parts" are
  // just the page's links and its prose mentions, which the zone groups already
  // show. Two unnamed blocks labelled "turn-ins" would invent a structure.
  if (!q.split || parts.length < 2) return "";
  const held = n => heldCount(have, n);
  const open = QPARTS_OPEN.has(q.t);
  const rows = parts.map((p, i) => {
    const cs = p.c.map(([n, want]) => ({ n, want, have: held(n) }));
    const got = cs.filter(c => c.have >= c.want).length;
    // a hub page's turn-in is its own quest in all but URL (the five Sky
    // tests share one page) — each is trackable alone
    const pkey = `${q.t}::${i}`;
    const ptracked = TRACKED.includes(pkey);
    return `<li class="qpart ${got === cs.length ? "is-ready" : ""}">
      <div class="qpart__head">
        <span class="qpart__n">${esc(p.n || "Also listed on this page")}</span>
        ${p.g ? `<span class="dim">→ ${esc(p.g)}</span>` : ""}
        ${(p.r || []).length ? `<span class="dim">reward: ${p.r.map(esc).join(", ")}</span>` : ""}
        <span class="qprog">${got}/${cs.length}</span>
        <button class="btn btn--mini qtrk" data-track="${esc(pkey)}">${ptracked ? "Untrack" : "Track"}</button>
      </div>
      <ul class="qcomps">${cs.map(c => `<li class="qc ${c.have >= c.want ? "is-have" : ""} ${heldMark(c.n) ? "is-marked" : ""}">
        ${holdChk(c)}${itemSpan(c.n)}${c.want > 1 || c.have ? `<span class="qct ${c.have >= c.want ? "is-ok" : ""}">${c.have}/${c.want}</span>` : ""}</li>`).join("")}</ul>
    </li>`;
  }).join("");
  return `<div class="qparts">
    <button class="qparts__toggle" data-parts="${esc(q.t)}">${open ? "▾" : "▸"} ${parts.length} turn-in${parts.length === 1 ? "" : "s"} on this page</button>
    ${open ? `<ul class="qplist">${rows}</ul>` : ""}</div>`;
}

// zone groups + turn-ins + rewards + related pages — shared by the Turn-ins
// rows, the Tracked tab, and the browser's expanded rows
function questDetail(p, have) {
  const { q } = p;
  const ss = have ? stepState(q, have) : null;
  const comps = (ss ? stepsHtml(q, ss) : "")
    + zoneGroupsHtml(p.comps) + (have ? partsHtml(q, have) : "");
  const rew = (q.rewards || []).length
    ? `<div class="qrew">reward: ${q.rewards.slice(0, 10).map(r => `<span data-tt="${esc(r)}">${esc(r)}</span>`).join(", ")}${q.rewards.length > 10 ? ` <span class="dim">+${q.rewards.length - 10} more</span>` : ""}</div>`
    : "";
  // the wiki's top table fills empty cells with a literal "None"
  const rz = (q.relatedZones || []).filter(z => z && z !== "None");
  const rn = (q.relatedNpcs || []).filter(n => n && n !== "None");
  const rel = [
    rz.length ? `zones: ${rz.map(esc).join(", ")}` : "",
    rn.length ? `NPCs: ${rn.slice(0, 8).map(esc).join(", ")}${rn.length > 8 ? ` +${rn.length - 8}` : ""}` : "",
  ].filter(Boolean).join(" · ");
  return (comps || `<p class="dim">The wiki page lists no items for this quest.</p>`)
    + rew + (rel ? `<p class="qrel dim">${rel}</p>` : "");
}

function questRow(p, tracked, have) {
  const { q } = p;
  // 27 quests carry components but no giver and no zone. They are not junk —
  // "Cleric Plane of Sky Tests" (26 items) and the Coldain ring chain live
  // here — but they have no single hand-in NPC, so calling them "ready to
  // hand in" would be a lie. Say what they are instead.
  const facts = questFacts(q, !q.giver && !q.zone);
  // a chain quest is READY when the FINAL hand-in is satisfiable, not when
  // the base materials are pocketed — 10 coins in the bag is step 13 of 17
  const ss = have ? stepState(q, have) : null;
  const ready = ss ? ss.handinReady : p.done;
  return `<li class="qrow ${ready ? "is-ready" : ""} ${tracked ? "is-tracked" : ""}">
    <div class="qrow__head">
      <a class="wk" data-wiki="${esc(q.wk || q.t || "")}">${esc(q.n)}</a>
      <span class="qprog">${p.got}/${p.need}</span>
      ${facts ? `<span class="dim">${esc(facts)}</span>` : ""}
      <button class="btn btn--mini qtrk" data-track="${esc(q.t)}">${tracked ? "Untrack" : "Track"}</button>
    </div>
    ${questDetail(p, have)}</li>`;
}

/* ── Turn-ins tab — what the inventory says you could hand in ────────────── */
const TURNIN_HINT = $("turninsEmpty").innerHTML;
function renderTurnins() {
  const body = $("turninsBody"), empty = $("turninsEmpty"), banner = $("turninsBanner");
  banner.hidden = !!QDATA;
  if (!QDATA) {
    banner.textContent = "Quest data not loaded yet — refresh from eqltools.com in Settings.";
    $("tiMeta").textContent = ""; body.innerHTML = ""; empty.hidden = true;
    return;
  }
  banner.hidden = hasSrc();
  if (!hasSrc()) banner.textContent = STALE_DATA_NOTE;
  const have = haveMap();
  const held = [];
  for (const q of QDATA.quests) {
    if (!q.items || !q.items.length) continue;
    const p = compsFor(q, have);
    if (p.got) held.push(p); // hold nothing for it — not this player's problem yet
  }
  // ready first, in-era before out-of-era, then by how complete, then by size
  // (a 4-of-4 outranks a 1-of-1)
  held.sort((a, b) =>
    (b.done - a.done) || ((a.q.oe ? 1 : 0) - (b.q.oe ? 1 : 0)) ||
    (b.got / b.need - a.got / a.need) || (b.need - a.need) ||
    (a.q.n.toLowerCase() < b.q.n.toLowerCase() ? -1 : 1));
  const ready = held.filter(p => p.done), partial = held.filter(p => !p.done);
  $("tiMeta").textContent = held.length
    ? `${ready.length} ready · ${partial.length} partly collected${INV.file ? ` · from ${INV.file}` : ""}` : "";

  const needle = TURNIN.q.trim().toLowerCase();
  const match = p => !needle || [p.q.n, p.q.giver, p.q.zone, ...(p.q.items || []), ...(p.q.rewards || [])]
    .some(s => s && String(s).toLowerCase().includes(needle));
  const showReady = ready.filter(match);
  const showPartial = TURNIN.readyOnly ? [] : partial.filter(match);

  const any = showReady.length || showPartial.length;
  empty.hidden = !!any;
  if (!any) {
    if (TURNIN.readyOnly && partial.some(match)) empty.textContent = "Nothing ready — untick “ready only” to see partly collected quests.";
    else if (needle) empty.textContent = "Nothing you hold items for matches that filter.";
    else if (INV.problem) empty.textContent = INV.problem;
    else empty.innerHTML = TURNIN_HINT;
    body.innerHTML = "";
    return;
  }
  const trackedSet = new Set(TRACKED);
  const section = (label, rows) => rows.length
    ? `<h3>${label} (${rows.length})</h3><ul class="qlist">${rows.map(p => questRow(p, trackedSet.has(p.q.t), have)).join("")}</ul>` : "";
  body.innerHTML =
    section("Ready to hand in", showReady) +
    section("Partly collected", showPartial) +
    (hasSrc()
      ? `<p class="dim qnote">Counts come from the quest page where it states one and are
         assumed to be one where it doesn’t, so “ready” can still be short on a page that
         never said how many. Items you can only make are counted through their recipe —
         a full Lambent set needs seven Lambent Stones its own page never totals up.</p>`
      : "");
  retip();
}

/* ── Quests tab — the full quest table: search, filter, sort, track ──────── */
function populateQuestFilters() {
  if (!QDATA) return;
  const classes = new Set(), zones = new Set();
  for (const q of QDATA.quests) {
    for (const c of q.classes || []) if (c && c !== "?" && c !== "Any") classes.add(c);
    if (q.zone) zones.add(q.zone);
  }
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  $("qbClass").innerHTML = opt("", "any class") + [...classes].sort().map(c => opt(c, c)).join("");
  $("qbZone").innerHTML = opt("", "any zone") + [...zones].sort().map(z => opt(z, z)).join("");
  if (QB.cls) $("qbClass").value = QB.cls;
  if (QB.zone) $("qbZone").value = QB.zone;
}

const ERA_SHORT = e => String(e || "").replace(/\s*Era$/i, "");

function qbMatch(q) {
  const needle = QB.q.trim().toLowerCase();
  if (needle && ![q.n, q.giver, q.zone, q.era, ...(q.items || []), ...(q.rewards || []),
    ...(q.relatedZones || []), ...(q.relatedNpcs || []), ...(q.classes || [])]
    .some(s => s && String(s).toLowerCase().includes(needle))) return false;
  return qbFilters(q);
}

// the non-search filters, shared by quest rows and their part rows
function qbFilters(q) {
  // a quest with no class list is open to everyone — it passes any class filter
  if (QB.cls && (q.classes || []).length && !q.classes.some(c => c === QB.cls || c === "Any")) return false;
  if (QB.zone && q.zone !== QB.zone) return false;
  if (QB.era === "in" && q.oe) return false;
  if (QB.era === "out" && !q.oe) return false;
  const min = +QB.lvlMin || 0, max = +QB.lvlMax || 0;
  if ((min || max) && q.lvl == null) return false;
  if (min && q.lvl < min) return false;
  if (max && q.lvl > max) return false;
  return true;
}

/* A hub page's turn-in matches on ITS OWN name, giver, items and — the part
   Kyle actually searched for — its own reward: "aldryn" must surface
   "Paladin Test of Sacrifice", not just the hub (2026-08-09). */
function qbMatchPart(q, p) {
  const needle = QB.q.trim().toLowerCase();
  if (needle && ![p.n, p.g, q.n, ...(p.c || []).map(([n]) => n), ...(p.r || [])]
    .some(s => s && String(s).toLowerCase().includes(needle))) return false;
  return qbFilters(q);
}

const QB_SORTS = {
  name: p => p.q.n.toLowerCase(),
  lvl: p => p.q.lvl ?? 999,
  zone: p => (p.q.zone || "￿").toLowerCase(),
  era: p => (p.q.oe ? "z" : "a") + (p.q.era || ""),
  held: p => -(p.need ? p.got / p.need + p.need / 1000 : -1),
};

function qbRow(p, tracked, open, have) {
  const { q } = p;
  const cls = (q.classes || []).filter(c => c && c !== "?").join("/");
  // a page the parts walk split IS a chain, and now says how many turn-ins;
  // the old guess (no giver and no zone) stays for pages it couldn't split
  const parts = (q.parts || []).length;
  // a part row (q.wk = its hub) is one turn-in by construction — no tag
  const chain = q.wk ? "" : q.split ? `${parts} turn-ins`
    : (q.items && q.items.length && !q.giver && !q.zone ? "chain" : "");
  return `<tr class="qbr ${p.done ? "is-ready" : ""} ${q.oe ? "is-oe" : ""} ${open ? "is-open" : ""}" data-qx="${esc(q.t)}">
    <td class="qb-trk"><button class="btn btn--mini" data-track="${esc(q.t)}">${tracked ? "Untrack" : "Track"}</button></td>
    <td class="qb-name"><a class="wk" data-wiki="${esc(q.t)}">${esc(q.n)}</a>${chain ? ` <span class="dim" title="this page is more than one hand-in">${esc(chain)}</span>` : ""}</td>
    <td class="qb-lvl">${q.lvl ?? ""}</td>
    <td class="qb-cls" title="${esc(cls)}">${esc(cls)}</td>
    <td class="qb-zone">${esc(q.zone || "")}</td>
    <td class="qb-giver">${esc(q.giver || "")}</td>
    <td class="qb-era">${q.oe ? `<span class="oe">out of era</span>` : esc(ERA_SHORT(q.era))}</td>
    <td class="qb-held">${p.need ? `<span class="qprog">${p.got}/${p.need}</span>` : "—"}</td>
  </tr>` + (open ? `<tr class="qbx"><td></td><td colspan="7">${questDetail(p, have)}</td></tr>` : "");
}

function renderQuestBrowser() {
  const banner = $("questsBanner");
  banner.hidden = !!QDATA;
  if (!QDATA) {
    banner.textContent = "Quest data not loaded yet — refresh from eqltools.com in Settings.";
    $("qbMeta").textContent = ""; $("qbBody").innerHTML = "";
    return;
  }
  const have = haveMap();
  const trackedSet = new Set(TRACKED);
  // a split page's named turn-ins are quests in their own right: they get
  // their own searchable, trackable rows beside the hub's
  const rows = [];
  for (const q of QDATA.quests) {
    if (qbMatch(q)) rows.push(compsFor(q, have));
    if (q.split) (q.parts || []).forEach((p, i) => {
      if (p.n && p.c.length && qbMatchPart(q, p)) {
        const plan = trackedPlan(`${q.t}::${i}`, have);
        if (plan) rows.push(plan);
      }
    });
  }
  const key = QB_SORTS[QB.sort] || QB_SORTS.name;
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ((ka < kb ? -1 : ka > kb ? 1 : 0) * QB.dir) ||
      (a.q.n.toLowerCase() < b.q.n.toLowerCase() ? -1 : 1);
  });
  // rows ≠ quests: a split page contributes a row per named turn-in as well as
  // its own, so counting rows against the quest total printed "1797 of 923"
  const pages = new Set(rows.map(p => p.q.t)).size;
  $("qbMeta").textContent = pages === rows.length
    ? `${rows.length} of ${QDATA.quests.length} quests`
    : `${rows.length} turn-ins across ${pages} of ${QDATA.quests.length} quests`;

  const arrow = k => QB.sort === k ? (QB.dir > 0 ? " ▲" : " ▼") : "";
  const th = (k, label) => k
    ? `<th class="is-sort" data-qsort="${k}">${label}${arrow(k)}</th>`
    : `<th>${label}</th>`;
  $("qbBody").innerHTML = rows.length ? `<table class="qtab">
    <thead><tr>
      ${th("", "")}${th("name", "Quest")}${th("lvl", "Lvl")}${th("", "Classes")}${th("zone", "Zone")}${th("", "Giver")}${th("era", "Era")}${th("held", "Items")}
    </tr></thead>
    <tbody>${rows.map(p => qbRow(p, trackedSet.has(p.q.t), QEXPANDED.has(p.q.t), have)).join("")}</tbody>
  </table>` : `<p class="empty">Nothing matches those filters.</p>`;
  retip();
}

/* ── Tracked tab — the working list ───────────────────────────────────────
   Two ways to read the same set, because there are two moments. Planning, you
   think in quests: what is this armour set going to cost me. Playing, you
   think in zones: I am standing in Lower Guk, what does Lower Guk owe me —
   and that view has to pool every tracked quest, or you clear a zone and find
   out later the other quest wanted something here too. Inside a quest the
   items still group by zone for the same reason. */
function renderTrackedTab() {
  const banner = $("trackedBanner"), body = $("trackedBody"), empty = $("trackedEmpty");
  // the count rides the sub-tab chip now, not a top-level tab
  const tab = document.querySelector('[data-qview="tracked"]');
  const head = $("trackedHead");
  if (tab) tab.textContent = TRACKED.length ? `Tracked (${TRACKED.length})` : "Tracked";
  banner.hidden = !!QDATA;
  if (!QDATA) {
    // tracked keys can't resolve without the dataset — "nothing tracked yet"
    // would be a lie here
    banner.textContent = "Quest data not loaded yet — refresh from eqltools.com in Settings.";
    body.innerHTML = ""; empty.hidden = true; if (head) head.hidden = true;
    return;
  }
  const have = haveMap();
  const plans = TRACKED.map(k => trackedPlan(k, have)).filter(Boolean);
  empty.hidden = plans.length > 0;
  if (head) head.hidden = plans.length < 1;
  // the by-zone view needs the source table; offering the toggle without it
  // would switch to an empty answer. Scoped by id: document.querySelector(".seg")
  // returned the FIRST .seg in the document — the Sky tab's grouping toggle —
  // so missing quest-source data used to hide a control on another tab.
  const seg = $("trackViews");
  if (seg) seg.hidden = !hasSrc();
  banner.hidden = hasSrc();
  if (!hasSrc()) banner.textContent = STALE_DATA_NOTE;
  if (!plans.length) { body.innerHTML = ""; return; }

  if (TRACK_VIEW === "zone" && hasSrc() && plans.length > 1) {
    // one item wanted by two quests is one thing to farm, so the rows merge and
    // carry the largest requirement; the tag names every quest waiting on it
    const rows = mergePlans(plans);
    const left = rows.filter(r => r.have < r.want).length;
    $("trackedMeta").textContent =
      `${rows.length} item${rows.length === 1 ? "" : "s"} across ${plans.length} quests · ${left} still to get`;
    body.innerHTML = zoneGroupsHtml(rows);
  } else {
    const ready = plans.filter(p => p.done).length;
    $("trackedMeta").textContent = plans.length > 1
      ? `${plans.length} quests · ${ready} ready to hand in` : "";
    body.innerHTML = `<ul class="qlist">${plans.map(p => questRow(p, true, have)).join("")}</ul>`;
  }
  retip();
}

function renderQuests() { renderTurnins(); renderTrackedTab(); renderQuestBrowser(); }

/* ── the two sub-tab strips ───────────────────────────────────────────────
   Quests was three top-level tabs (Turn-ins, Tracked, Quests) over one
   dataset, separated in the tab bar by Sky, Valet and Unlocks; Inventory and
   the loot feed were two. Both are now one tab with a strip, and the choice
   sticks — you come back to the view you were using. */
const QVIEW_KEY = "eqlt-companion-qview-v1";
const IVIEW_KEY = "eqlt-companion-invview-v1";
let QUEST_VIEW = "turnins", INV_VIEW = "quest";
const paintStrip = (stripId, wrapSel, attr, val) => {
  for (const b of document.querySelectorAll(`#${stripId} [data-${attr}]`)) b.classList.toggle("is-on", b.dataset[attr] === val);
  for (const p of document.querySelectorAll(wrapSel)) p.hidden = p.dataset[attr] !== val;
};
function setQuestView(v) {
  QUEST_VIEW = v;
  try { localStorage.setItem(QVIEW_KEY, v); } catch {}
  paintStrip("qViews", "#tab-quests .qview", "qview", v);
}
/* Quest, Gear and Spare are three readings of ONE table, so they share a pane
   and the strip cannot be painted by the generic matcher — three of the four
   buttons show the same element. "bags" was the old key for what is now
   "quest"; anything unrecognised falls back to it rather than showing a blank
   tab to someone upgrading. */
const INV_MODES = ["quest", "gear", "spare", "exalt"];
function setInvView(v) {
  INV_VIEW = v;
  try { localStorage.setItem(IVIEW_KEY, v); } catch {}
  for (const b of document.querySelectorAll("#invViews [data-invview]"))
    b.classList.toggle("is-on", b.dataset.invview === v);
  for (const p of document.querySelectorAll("#tab-inv .invview"))
    p.hidden = p.dataset.invview !== (v === "recent" ? "recent" : "table");
  if (v !== "recent") { renderInvColPicker(); renderInv(); }
}
function loadViews() {
  try {
    const q = localStorage.getItem(QVIEW_KEY);
    if (q === "turnins" || q === "tracked" || q === "all") QUEST_VIEW = q;
    const i = localStorage.getItem(IVIEW_KEY);
    if (i === "recent" || INV_MODES.includes(i)) INV_VIEW = i;
    else if (i === "bags") INV_VIEW = "quest";
  } catch {}
  setQuestView(QUEST_VIEW); setInvView(INV_VIEW);
}

/* ── Sky tab: what can I hand in, right now ───────────────────────────────
   Kyle, 2026-08-13: "if im sitting in the quest room with a bag full of stuff,
   i want to see class/npc, expandable/collapsable, and then a list of quests to
   turn in, showing the items for the quest."

   So this is not /sky's three views. It is the quest room: sixteen givers, each
   a fold, each holding the tests you could walk up and complete. The measuring
   — the log grammar, what a closed trade proves, which tests are done — is
   vendor/sky-core.js, the same file /sky runs; only the arrangement is new.

   The log and the dump answer different halves and neither is optional:
   the dump knows WHERE a piece is (bag 2, bank 5 — the thing you need when
   eight bags are open), and only the log has ever seen a wind rune, which goes
   to the currency tab that /outputfile can't export. */
const SKY = window.EQLSky;
const SKY_CLASS = {
  BRD: "Bard", BST: "Beastlord", BER: "Berserker", CLR: "Cleric",
  DRU: "Druid", ENC: "Enchanter", MAG: "Magician", MNK: "Monk",
  NEC: "Necromancer", PAL: "Paladin", RNG: "Ranger", ROG: "Rogue",
  SHD: "Shadow Knight", SHM: "Shaman", WAR: "Warrior", WIZ: "Wizard",
};
let SKYD = null;          // sky.json
let SKYL = null;          // {st, led, me} — the running fold over this log
const SKY_KEY = "eqlt-companion-sky-v1";
const SKY_DEF = {
  // open: null = never chosen, so the folds that have something ready open
  // themselves — the quest room's first question is "what can I hand in".
  show: "held", hideDone: false, cls: "", open: null,
  /* Two arrangements of the same board. `class` is the quest room — sixteen
     givers, what you can hand in. `boss` is the island — what the thing on the
     floor drops and whether you want any of it. */
  view: "class", onlyNeed: false, openBoss: null,
  // "never doing this one": a want, not a measurement, so it can only ever
  // suppress. Same meaning as /sky's skip; the two can't share storage because
  // the app and the site are different origins.
  skipped: {},
  // wid.cls is an explicit list of class codes — [] really means none, so
  // "show me nothing but my trio" and "show me nothing" stay different answers
  wid: { show: "ready", hideDone: true, loc: true, say: true, cls: null,
         view: "class", trackedFirst: true },
};
let SKYP = JSON.parse(JSON.stringify(SKY_DEF));
function loadSkyPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(SKY_KEY)) || {};
    SKYP = { ...SKY_DEF, ...o, wid: { ...SKY_DEF.wid, ...(o.wid || {}) } };
    if (SKYP.open !== null && !Array.isArray(SKYP.open)) SKYP.open = null;
    if (SKYP.openBoss !== null && !Array.isArray(SKYP.openBoss)) SKYP.openBoss = null;
    if (!SKYP.skipped || typeof SKYP.skipped !== "object") SKYP.skipped = {};
  } catch { SKYP = JSON.parse(JSON.stringify(SKY_DEF)); }
  if (!Array.isArray(SKYP.wid.cls)) SKYP.wid.cls = Object.keys(SKY_CLASS);
}
const skyMark = (code, test) => code + "::" + test;
const skySkipped = (code, test) => !!SKYP.skipped[skyMark(code, test)];
function skyToggleSkip(code, test, on) {
  if (on) SKYP.skipped[skyMark(code, test)] = true;
  else delete SKYP.skipped[skyMark(code, test)];
  saveSkyPrefs();
  renderSkySoon();
}

/* ── tracking a Sky test ──────────────────────────────────────────────────
   ONE tracked list. The Quests tab can still track a Sky turn-in off its wiki
   page, so a Sky test tracked here has to be the same entry, not a second one:
   toggling looks for an existing quest-tracker key for this test first and
   flips that when it finds one.

   It usually won't. The wiki is converting the sixteen `<Class> Plane of Sky
   Tests` pages into `{{#lsth:Plane of Sky|…}}` transclusions, and a page that
   is now a transclusion call parses to nothing — as of 2026-08-14, ten of the
   sixteen carry no turn-ins in quest-items.json and three have no page at all.
   sky.json is built from the `Plane of Sky` page itself and has all 95, so a
   sky-native key is the one that keeps working. `trackedPlan` resolves both. */
const SKY_TRACK = "sky::";
const skyTrackKey = (code, test) => SKY_TRACK + code + "::" + test;
// the quest-tracker key for the same test, when its wiki page still parses
function skyQuestKey(code, test) {
  const page = `${SKY_CLASS[code]} Plane of Sky Tests`;
  for (const [t, q] of T2Q) {
    if (q.n !== page) continue;
    const i = (q.parts || []).findIndex(p => (p.n || "") === test);
    if (i >= 0) return `${t}::${i}`;
  }
  return null;
}
const skyTracked = (code, test) => {
  const qk = skyQuestKey(code, test);
  return TRACKED.includes(skyTrackKey(code, test)) || (!!qk && TRACKED.includes(qk));
};
function skyToggleTrack(code, test) {
  const qk = skyQuestKey(code, test);
  toggleTrack(qk && TRACKED.includes(qk) ? qk : (qk || skyTrackKey(code, test)));
  renderSkySoon();
}
/* A sky-native tracked key as a plan, in the shape every tracked-quest consumer
   already reads — so the Tracked tab, the overlay and the pooled shopping list
   pick Sky tests up without knowing this shape exists. */
function skyTrackPlan(key, have) {
  if (!SKYD) return null;
  const p = key.split("::");
  const c = SKYD.classes[p[1]];
  const t = c && c.tests.find(x => x.n === p[2]);
  if (!t) return null;
  const seen = n => SKY_LOCS ? SKY_LOCS.has(itemKey(n)) : false;
  const comps = t.rune.map(n => ({ n, want: 1, have: skyHave(have, n).n }))
    .concat(t.items.map(i => ({ n: i.n, want: 1, have: skyHave(have, i.n, seen(i.n)).n })));
  const got = comps.filter(x => x.have >= x.want).length;
  const q = {
    t: key, wk: `${SKY_CLASS[p[1]].replace(/ /g, "_")}_Plane_of_Sky_Tests`,
    n: t.n, sn: t.n.replace(SKY_CLASS[p[1]] + " ", ""),
    giver: c.giver || "", rewards: t.reward ? [t.reward] : [],
    items: comps.map(x => x.n), need: comps.map(x => [x.n, 1]), parts: [],
  };
  return { q, comps, got, need: comps.length,
           done: comps.length > 0 && got === comps.length };
}
const saveSkyPrefs = () => { try { localStorage.setItem(SKY_KEY, JSON.stringify(SKYP)); } catch {} };

/* One fold per log file. The bootstrap tail seeds it and live lines extend it,
   which is the same deal every other tab gets: turn-ins from before the 40 MB
   tail are invisible, and the tab says so rather than reading as "not done". */
function skyReset(file) {
  const me = (String(file || "").match(/eqlog_([^_]+)_/) || [])[1] || "";
  SKYL = { st: SKY.stream(me), me, file };
  SKYL.led = SKYL.st.led;
}
function skySeed(file, text) { skyReset(file); SKYL.st.text(text); }
/* Only a line the Sky grammar actually consumed can move this board, and a
   busy zone is thousands of lines a minute that don't. */
function skyFeed(lines) {
  if (!SKYL) return;
  const before = SKYL.led.n;
  SKYL.st.feed(lines);
  if (SKYL.led.n !== before) renderSkySoon();
}

const skyRec = name => {
  const k = SKYD && SKYD.names[String(name).toLowerCase()];
  return k ? SKYD.items[k] : null;
};

/* Every component the wiki puts in more than one test. The star is a warning
   that handing this one over costs another test its piece — which is exactly
   the decision you're making standing at the giver. Wind runes are excluded on
   purpose: every rune feeds several tests, so starring them would star the
   whole column and say nothing (Kyle: "runes can definitely be used for
   multiple so no astrisk needed on those"). */
let SKY_USES = new Map();  // itemKey -> [{code, test}]
function buildSkyUses() {
  SKY_USES = new Map();
  if (!SKYD) return;
  for (const [code, c] of Object.entries(SKYD.classes))
    for (const t of c.tests)
      for (const i of t.items) {
        const k = itemKey(i.n);
        if (!SKY_USES.has(k)) SKY_USES.set(k, []);
        SKY_USES.get(k).push({ code, test: t.n });
      }
}

/* Deliveries the dump can't know about yet. A dump is a snapshot: everything
   handed over before it is already missing from it, but a turn-in you did five
   minutes later still shows in the bags it exported. Only trades AFTER the
   dump come off the count. */
let SKY_DEL = { key: "", map: new Map() };
function deliveredAfter(cut) {
  const led = SKYL && SKYL.led;
  if (!led) return new Map();
  const key = `${led.trades.length}|${cut}`;
  if (SKY_DEL.key === key) return SKY_DEL.map;
  const m = new Map();
  for (const tr of led.trades) {
    const ts = Date.parse(tr.ts);
    if (!(ts > cut)) continue;
    for (const [n, q] of tr.items) m.set(itemKey(n), (m.get(itemKey(n)) || 0) + q);
  }
  SKY_DEL = { key, map: m };
  return m;
}

/* How many of a piece you hold, and on whose word.
     inv   — the dump, minus anything handed over since it was written
     log   — looted minus delivered minus destroyed; the only answer for a wind
             rune, and the only answer at all before the first dump
     mark  — you told the app you have it (bought it, it's on the pet)

   `seen` is whether the dump lists it anywhere. A mark is a FLOOR, so an item
   the dump can see is the dump's answer even when it is also marked — calling
   that "marked" would dress an observation up as a claim, backwards from the
   mistake the mark exists to prevent. */
function skyHave(have, name, seen) {
  const led = SKYL && SKYL.led;
  const mark = heldMark(name);
  if (!led) return { n: mark ? mark.c : 0, src: mark ? "mark" : "inv" };
  if (!INV.rows || SKY.isRune(name)) {
    const n = SKY.held(led, null, name).n;
    return mark ? { n: Math.max(n, mark.c), src: n ? "log" : "mark" } : { n, src: "log" };
  }
  const n = heldCount(have, name) - (deliveredAfter(INV.mtime).get(itemKey(name)) || 0);
  return { n: Math.max(0, n), src: !seen && mark ? "mark" : "inv" };
}

/* ── where is it ──────────────────────────────────────────────────────────
   Kyle: "a little bag icon with a number indicating the slot number 1-8, or a
   coin number showing 1-16. that helps people find that item." So bags and
   bank get the icon and the number; everywhere else gets a word, because a
   number means nothing on a worn slot or the depot.

   'General 1-Slot2' is bag one, slot two — the badge prints both, since the
   bag number alone still leaves you opening it and reading.

   The badge itself is /_shared/gear-score.js (vendored), so the site's Sky page
   and this tab name a place the same way — including the storage bins, which
   this file used to print as the bare location string ("equipment", which reads
   like a worn slot). */
const SKY_BAG_SVG = `<svg class="skl__i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 5.5h8.8l-.9 7.4a1 1 0 0 1-1 .9H5.5a1 1 0 0 1-1-.9z"/><path d="M6 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>`;
const SKY_COIN_SVG = `<svg class="skl__i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.9"/></svg>`;
const skyBadge = window.EQLGearScore.locBadge;
/* Dump rows by item, in the order the client wrote them, keyed both raw and
   decoration-stripped like every other lookup here. Built once per model —
   asking each of 95 tests' components to re-scan the whole dump was the same
   work a hundred times over. */
function skyLocIndex() {
  const m = new Map();
  for (const r of INV.rows || []) {
    if (r.exalt) continue;   // the stone is not the piece — see haveMap
    const b = { ...skyBadge(r.loc), count: r.count };
    for (const k of new Set([itemKey(r.name), itemKey(stripDecor(r.name))]))
      m.set(k, (m.get(k) || []).concat(b));
  }
  SKY_LOCS = m;   // skyTrackPlan runs outside a model build and needs the same answer
  return m;
}
let SKY_LOCS = null;
const skyLocs = (idx, name) => idx.get(itemKey(name)) || idx.get(itemKey(stripDecor(name))) || [];
function skyBadgeHtml(b) {
  const cnt = b.count > 1 ? ` <b class="skl__c">×${b.count}</b>` : "";
  if (b.kind === "word")
    return `<span class="skl skl--word" title="${esc(b.title)}">${esc(b.word)}${cnt}</span>`;
  return `<span class="skl skl--${b.kind}" title="${esc(b.title)}">` +
    (b.kind === "bag" ? SKY_BAG_SVG : SKY_COIN_SVG) +
    `<b>${b.n}</b>${b.sub ? `<span class="skl__s">·${b.sub}</span>` : ""}${cnt}</span>`;
}

/* ── the model ────────────────────────────────────────────────────────────
   Built once per render and handed to BOTH surfaces — the tab draws it and the
   widget gets the same rows pre-resolved, because the overlay holds no data. */
function skyModel() {
  if (!SKYD || !SKYL) return null;
  const have = haveMap();
  const locIdx = skyLocIndex();
  const led = SKYL.led;
  const classes = Object.keys(SKYD.classes).sort((a, b) =>
    SKY_CLASS[a].localeCompare(SKY_CLASS[b]));
  const tot = { tests: 0, done: 0, ready: 0, partial: 0, pieces: 0 };
  const out = [];
  for (const code of classes) {
    const c = SKYD.classes[code];
    const comp = SKY.completions(SKYD, led, code);
    const tests = c.tests.map(t => {
      const items = t.items.map(i => {
        const locs = skyLocs(locIdx, i.n);
        const h = skyHave(have, i.n, locs.length > 0);
        const uses = (SKY_USES.get(itemKey(i.n)) || []).filter(u => u.test !== t.n);
        return {
          n: i.n, need: 1, have: h.n, src: h.src,
          isl: i.isl || "", mob: i.mob || "", nodrop: !!i.nodrop,
          star: uses.length > 0,
          starWith: uses.map(u => `${SKY_CLASS[u.code]}: ${u.test.replace(SKY_CLASS[u.code] + " ", "")}`),
          locs,
        };
      });
      const rune = t.rune.map(r => ({
        n: r, short: r.replace("Wind Rune ", ""), need: 1, have: skyHave(have, r).n,
      }));
      const done = comp.byTest[t.n] || 0;
      /* The second witness. `done` is what this log saw you hand over; `ach`
         is the client's own achievement record saying you hold the reward —
         the only evidence that survives from before the app was installed.
         Both are measurements, neither is a player's mark, and they are kept
         apart so a row can say which one it is standing on. Either one means
         the test is behind you, so both suppress "ready". */
      const ach = !!(ACH_SKY[code] && ACH_SKY[code].byTest[t.n]);
      const skip = skySkipped(code, t.n);
      const st = SKY.testState(t, done + (ach ? 1 : 0), skip, n => skyHave(have, n, locIdx.has(itemKey(n))).n);
      /* Progress on a test means a COMPONENT of it. Runes are generic — one
         Wind Rune Dena feeds seven different tests, so counting it as progress
         listed all seven as started off a single drop. */
      const held = items.filter(i => i.have >= 1).length;
      tot.pieces += items.reduce((a, i) => a + i.have, 0);
      return {
        code, full: t.n, n: t.n.replace(SKY_CLASS[code] + " ", ""),
        say: t.say || "", reward: t.reward || "", items, rune,
        done, ach, ready: st.ready, missing: st.missing.length, held,
        skip, track: skyTracked(code, t.n),
        need: items.length + rune.length,
      };
    });
    const nDone = tests.filter(t => t.done > 0 || t.ach).length;
    const nReady = tests.filter(t => t.ready).length;
    const nPartial = tests.filter(t => !t.ready && !t.done && t.held > 0).length;
    tot.tests += tests.length; tot.done += nDone; tot.ready += nReady; tot.partial += nPartial;
    out.push({ code, name: SKY_CLASS[code], giver: c.giver || "", tests, nDone, nReady, nPartial, orphan: comp.orphan });
  }
  return { classes: out, tot, isles: skyBossModel(out) };
}

/* ── the same board, arranged by what dropped it ──────────────────────────
   Kyle, 2026-08-14: "by boss. show me what each boss drops, and what i need /
   want / have" — then, exactly: "have and need are numbers, (how many do i
   currently have, how many do i still need to complete all quests that use this
   object), skip is a strikethrough or something, and track is some indicator
   like a star".

   So the two numbers are different kinds of claim and the row keeps them apart:

     have  measured — the dump, the log, or your own held mark
     need  how many MORE this object owes: every test that still wants it,
           minus what you are holding

   A test stops owing when it is turned in (measured), when the achievement
   record says it is behind you (measured), or when you skip it (a want). Track
   changes no number at all — it is the ordering, and the star.

   Item counts come straight off the class model, so a piece can never read one
   number here and another under its giver. */
function skyBossModel(classes) {
  if (!SKYD || !SKYD.isles) return [];
  const idx = new Map();
  for (const g of classes) for (const t of g.tests) for (const i of t.items) {
    let e = idx.get(i.n);
    if (!e) idx.set(i.n, e = { have: i.have, src: i.src, locs: i.locs, uses: [] });
    e.uses.push({ code: g.code, cls: g.name, giver: g.giver, test: t.full,
                  short: t.n, reward: t.reward, fin: t.done > 0 || t.ach,
                  skip: t.skip, track: t.track });
  }
  const have = haveMap();
  const board = SKY.bossBoard(SKYD, n => {
    const e = idx.get(n);
    const uses = e ? e.uses : [];
    const open = uses.filter(u => !u.fin && !u.skip);
    const held = e ? e.have : skyHave(have, n, false).n;
    return {
      n, have: held, uses, open: open.length, quest: !!e,
      need: Math.max(0, open.length - held),
      track: uses.some(u => u.track && !u.fin && !u.skip),
      locs: (e && e.locs) || [],
    };
  });
  /* Tracked first — "shows those items first". Then what you still owe, then
     quest pieces, then the rest of the drop table. */
  for (const isle of board) for (const m of isle.mobs) {
    m.rows.sort((a, b) => (b.track - a.track) || (b.need - a.need)
      || (b.open - a.open) || (b.quest - a.quest) || a.n.localeCompare(b.n));
    m.need = m.rows.reduce((s, r) => s + r.need, 0);
    m.track = m.rows.filter(r => r.track).length;
    m.nq = m.rows.filter(r => r.quest).length;
  }
  return board;
}

// One rule, both surfaces: "ready" is everything in hand, "held" adds the tests
// you have started, "all" is the other 90 you have not.
function skyKeep(t, show, hideDone) {
  const fin = t.done > 0 || t.ach;   // either witness closes a test
  if (hideDone && fin) return false;
  if (show === "ready") return t.ready || (fin && !hideDone && t.missing === 0);
  if (show === "held") return t.ready || t.held > 0 || fin;
  return true;
}
function skyMatch(g, t, q) {
  if (!q) return true;
  const hay = [g.name, g.giver, t.n, t.say, t.reward,
    ...t.items.map(i => i.n), ...t.items.map(i => i.mob), ...t.rune.map(r => r.n)]
    .join(" ").toLowerCase();
  return hay.includes(q);
}

const SKY_SRC_NOTE = {
  inv: "from your inventory dump",
  log: "from the log — a dump can't see the currency tab",
  mark: "you marked this one held",
};
/* Wiki page and item window for a Sky name. item-tooltips.json is the app's
   index for both; sky.json carries the same statsblock for the ~400 names this
   board uses, so a piece the tooltip index misses still gets its window. */
function skyRef(name) {
  const ti = lookupExact(TIDX, name);
  const rec = skyRec(name);
  const t = (ti && ti.t) || (rec && rec.t) || "";
  const base = (TDATA && TDATA.base) || (DATA && DATA.base) || "";
  return { n: name, url: t && base ? base + t : "", sb: (ti && ti.sb) || (rec && rec.sb) || null };
}
function skyItemSpan(name) {
  const r = skyRef(name);
  return r.url
    ? `<span class="itn is-link" data-tt="${esc(name)}" data-url="${esc(r.url)}">${esc(name)}</span>`
    : `<span class="itn" data-tt="${esc(name)}">${esc(name)}</span>`;
}
function skyPieceHtml(i) {
  const has = i.have >= i.need;
  const star = i.star
    ? `<span class="sk-star" title="Also wanted by ${esc(i.starWith.join("; "))}">★</span>` : "";
  const locs = i.locs.length ? ` ${i.locs.map(skyBadgeHtml).join(" ")}` : "";
  const where = i.isl ? `<span class="sk-src">${esc(skyIsle(i.isl))}${i.mob ? " · " + esc(i.mob) : ""}</span>` : "";
  return `<li class="skp ${has ? "is-have" : "is-miss"}">` +
    `<span class="skp__tick" data-hold="${esc(i.n)}" data-want="1" title="${i.src === "mark" ? "Marked as held — click to clear" : has ? "" : "Mark as held (bought it, or it's on your pet)"}">${has ? "✓" : "·"}</span>` +
    skyItemSpan(i.n) + star +
    `<span class="skp__ct" title="${esc(SKY_SRC_NOTE[i.src] || "")}">${i.have}/${i.need}</span>` +
    locs + (has ? "" : where) + `</li>`;
}
const skyIsle = n => {
  const nm = SKYD && SKYD.islands && SKYD.islands[String(n)];
  return nm ? `${nm} (I${n})` : `Isle ${n}`;
};
/* A rune you looted before `/log on` is invisible to both sources — the log
   never saw it and the dump can't export the currency tab — so the mark is the
   only way to say you have one. */
function skyRuneHtml(r) {
  const has = r.have >= 1;
  return `<li class="skp skp--rune ${has ? "is-have" : "is-miss"}">` +
    `<span class="skp__tick" data-hold="${esc(r.n)}" data-want="1" title="${has ? "" : "Mark as held — the log is the only witness for a rune"}">${has ? "✓" : "·"}</span>` +
    skyItemSpan(r.n) +
    `<span class="skp__ct" title="${esc(SKY_SRC_NOTE.log)}">${r.have}/1</span></li>`;
}

function skyStatus(t) {
  if (t.skip) return `<span class="sk-st sk-st--skip">skipped</span>`;
  if (t.ready) return `<span class="sk-st sk-st--ready">ready</span>`;
  const fin = t.done > 0 || t.ach;
  if (fin && t.missing === 0) return `<span class="sk-st sk-st--ready">can repeat</span>`;
  // "done" when only the achievement witnessed it: the turn-in happened before
  // this log, so calling it "turned in" would imply a trade we never saw.
  if (t.done > 0) return `<span class="sk-st sk-st--done">turned in</span>`;
  if (t.ach) return `<span class="sk-st sk-st--done">done</span>`;
  return `<span class="sk-st sk-st--miss">missing ${t.missing}</span>`;
}

/* The boss board. One fold per mob, ordered down the islands, and inside it the
   drop table with the two numbers on it. A drop no class test wants is still
   listed — it IS what the boss drops — but it never outranks a piece you owe. */
function skyBossHtml(m, q) {
  let shown = 0, openCount = 0;
  SKY_DROPS = new Map();
  for (const isle of m.isles || []) for (const mob of isle.mobs)
    for (const r of mob.rows) if (r.quest) SKY_DROPS.set(r.n, r.uses);
  const html = (m.isles || []).map(isle => isle.mobs.map(mob => {
    let rows = mob.rows;
    if (q) rows = rows.filter(r => (r.n + " " + mob.n + " " + isle.name
      + " " + r.uses.map(u => u.short + " " + u.reward).join(" ")).toLowerCase().includes(q));
    if (SKYP.onlyNeed) rows = rows.filter(r => r.need > 0);
    if (!rows.length) return "";
    shown += rows.length;
    const key = isle.isl + "::" + mob.n;
    const open = SKYP.openBoss ? SKYP.openBoss.includes(key) : (mob.need > 0 || mob.track > 0);
    openCount += open ? 1 : 0;
    const tally = [
      mob.track ? `<b class="sk-n sk-n--track">★${mob.track}</b>` : "",
      mob.need ? `<b class="sk-n sk-n--need">${mob.need}</b> to loot` : "",
      `${mob.rows.length} drops`,
    ].filter(Boolean).join(" · ");
    return `<section class="skg">
      <button type="button" class="skg__h" data-skyboss="${esc(key)}" aria-expanded="${open}">
        <span class="skg__caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
        <span class="skg__n">${esc(mob.n)}</span>
        <span class="skb__role skb__role--${esc(mob.role)}">${esc(mob.role)}</span>
        <span class="skg__giver">${esc(isle.name)} · I${esc(isle.isl)}</span>
        <span class="skg__tally">${tally}</span>
      </button>
      <div class="skg__b"${open ? "" : " hidden"}>
        ${mob.role === "trash" && mob.from.length ? `<p class="skb__key">${esc(mob.from.join(", "))}</p>` : ""}
        ${isle.req.length ? `<p class="skb__key">${esc(isle.req.join(", "))} to reach${
          isle.key.length ? ` · drops ${esc(isle.key.join(", "))}` : ""}</p>` : ""}
        <ul class="skb">${rows.map(r => skyDropHtml(r, key, mob.src)).join("")}</ul>
      </div>
    </section>`;
  }).join("")).join("");
  return { html, shown, openCount };
}

/* Distinct pieces, not folds. The same piece drops off several mobs, so adding
   up the per-mob counts would bill you twice for one Djinni War Blade. */
function skyTotalNeed(m) {
  const per = new Map();
  for (const isle of m.isles || []) for (const mob of isle.mobs)
    for (const r of mob.rows) if (r.need) per.set(r.n, r.need);
  let n = 0;
  for (const v of per.values()) n += v;
  return n;
}

/* One drop. The star and the strikethrough are the two marks; the two numbers
   are measurements. Right-click reaches skip, and the whole row expands to the
   tests it feeds — a corpse is not where you read four reward names at once
   (Kyle, 2026-08-14: "i need to mouseover to see the rewards the item gives,
   or an expand thing. and i need to be able to right click to choose skip"). */
function skyDropHtml(r, mobKey, src) {
  const dead = r.quest && r.open === 0;
  const cls = ["skb__r", r.quest ? "" : "is-extra", dead ? "is-off" : "",
               r.need ? "is-need" : "", r.track ? "is-track" : ""].filter(Boolean).join(" ");
  const who = src && src[r.n] ? src[r.n].join(", ") : "";
  /* The count says what it counts. A bare "+1" after a reward name would read
     as an upgrade tier — "Skycleaver +1" is a different item from "Skycleaver",
     and this app strips exactly that suffix elsewhere. */
  const buys = r.quest
    ? `${esc(r.uses[0].reward || r.uses[0].short)}${r.uses.length > 1
        ? ` <span class="dim">&middot; ${r.uses.length} tests</span>` : ""}`
    : `<span class="dim" title="${esc(who)}">${who ? esc(src[r.n][0]) : "no test wants it"}</span>`;
  const locs = r.locs.length ? ` ${r.locs.map(skyBadgeHtml).join(" ")}` : "";
  /* Exactly six grid children, always. The bag badges have to live INSIDE the
     name cell — as siblings they were extra grid items, and a piece the dump
     could place shunted its own numbers into the next column and wrapped the
     row. */
  return `<li class="${cls}" data-drop="${esc(r.n)}" data-mob="${esc(mobKey)}"
      title="${esc(r.uses.map(u => `${u.cls} · ${u.short}${u.reward ? " → " + u.reward : ""}${
        u.skip ? " (skipped)" : u.fin ? " (done)" : ""}`).join("\n"))}">
    <span class="skb__star">${r.track ? "★" : ""}</span>
    <span class="skb__nm">${skyItemSpan(r.n)}${locs}</span>
    <span class="skb__buys">${buys}</span>
    <span class="skb__n" title="How many you are holding">${r.have || "·"}</span>
    <span class="skb__need" title="How many more you must loot to finish every test that still wants it">${
      r.quest ? (r.need || "·") : ""}</span>
    ${r.quest ? `<button type="button" class="skb__x" data-skyexp="${esc(r.n)}" aria-expanded="false" title="What it buys">▾</button>` : "<span></span>"}
  </li>`;
}

/* What the expand and the right-click menu read. Rebuilt with the board, so a
   menu can never act on a test the row above it no longer shows. */
let SKY_DROPS = new Map();   // item name -> uses[]

function skyExpandDrop(btn) {
  const li = btn.closest("li");
  const open = btn.getAttribute("aria-expanded") === "true";
  const next = li.nextElementSibling;
  if (open) {
    if (next && next.classList.contains("skb__x2")) next.remove();
    btn.setAttribute("aria-expanded", "false"); btn.textContent = "▾";
    return;
  }
  const uses = SKY_DROPS.get(li.dataset.drop) || [];
  const el = document.createElement("li");
  el.className = "skb__x2";
  el.innerHTML = uses.map(u => `<div class="skb__u${u.skip ? " is-skip" : ""}${u.fin ? " is-done" : ""}${u.track ? " is-track" : ""}">
      <button type="button" class="skb__ustar${u.track ? " on" : ""}" data-skytrack="${esc(u.code)}" data-test="${esc(u.test)}"
        title="${u.track ? "Tracking — click to stop" : "Track this test"}">${u.track ? "★" : "☆"}</button>
      <span class="skb__ucls">${esc(u.cls)}</span>
      <span class="skb__utest">${esc(u.short)}</span>
      <span class="dim">→</span>
      <span class="skb__urew">${u.reward ? skyItemSpan(u.reward) : "?"}</span>
      <span class="dim">${u.skip ? "skipped" : u.fin ? "done" : esc(u.giver || "")}</span>
      <button type="button" class="skb__uskip" data-skyskip="${esc(u.code)}" data-test="${esc(u.test)}"
        title="${u.skip ? "Un-skip" : "Never doing this one"}">${u.skip ? "un-skip" : "skip"}</button>
    </div>`).join("");
  li.after(el);
  btn.setAttribute("aria-expanded", "true"); btn.textContent = "▴";
  retip();
}

/* Right-click a drop → skip a test that wants it. Skip is per TEST: a piece
   four classes want carries four separate decisions, so the menu lists them
   instead of toggling something ambiguous under the cursor. */
let SKY_MENU = null;
function skyCloseMenu() { if (SKY_MENU) { SKY_MENU.remove(); SKY_MENU = null; } }
function skyOpenMenu(li, x, y) {
  skyCloseMenu();
  const name = li.dataset.drop;
  const uses = SKY_DROPS.get(name) || [];
  if (!uses.length) return;
  const el = document.createElement("div");
  el.className = "skmenu";
  el.dataset.drop = name;
  el.innerHTML = `<div class="skmenu__h">${esc(name)}</div>`
    + uses.map(u => `<button type="button" class="skmenu__i${u.skip ? " is-skip" : ""}${u.fin ? " is-done" : ""}"
        data-skyskip="${esc(u.code)}" data-test="${esc(u.test)}">
        <span class="skmenu__b">${u.skip ? "✓" : ""}</span>
        <span>${esc(u.cls)} · ${esc(u.short)}</span>
        <span class="dim">${u.reward ? "→ " + esc(u.reward) : ""}</span></button>`).join("")
    + (uses.length > 1 ? `<button type="button" class="skmenu__i skmenu__all" data-skyskipall="${esc(name)}">${
        uses.every(u => u.skip) ? "Un-skip all" : "Skip all"}</button>` : "");
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  el.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  SKY_MENU = el;
}

function paintSkyView() {
  for (const b of document.querySelectorAll("[data-skyview]"))
    b.classList.toggle("is-on", b.dataset.skyview === SKYP.view);
  const boss = SKYP.view === "boss", drop = SKYP.view === "drop";
  // the giver-view filters mean nothing on a drop table, and vice versa
  $("skyShow").hidden = boss || drop;
  $("skyClass").hidden = boss || drop;
  $("skyHideDone").closest("label").hidden = boss || drop;
  $("skyNeedWrap").hidden = !boss;
  $("skyExpand").hidden = drop;   // nothing folds in a table
}

function renderSky(model) {
  const body = $("skyBody"), empty = $("skyEmpty"), meta = $("skyMeta"), banner = $("skyBanner");
  const m = model || skyModel();
  if (!m) {
    body.innerHTML = ""; meta.textContent = "";
    banner.hidden = true;
    empty.hidden = false;
    empty.innerHTML = SKYD
      ? `Waiting for log lines. Walk up to a quest giver and this fills in.<br>` +
        `<span class="dim">Logging must be on in game: <code>/log</code></span>`
      : `Plane of Sky data hasn't downloaded yet — check the Settings tab.`;
    return;
  }
  empty.hidden = true;
  const q = ($("skySearch").value || "").trim().toLowerCase();
  let shown = 0, openCount = 0;
  const classHtml = () => m.classes.map(g => {
    if (SKYP.cls && g.code !== SKYP.cls) return "";
    const rows = g.tests.filter(t => skyKeep(t, SKYP.show, SKYP.hideDone) && skyMatch(g, t, q));
    if (!rows.length) return "";
    shown += rows.length;
    const open = SKYP.open ? SKYP.open.includes(g.code) : g.nReady > 0;
    openCount += open ? 1 : 0;
    // the header's own counts are the class's WHOLE picture, so the fold says
    // what is in it without being opened; "N shown" beside them was the same
    // number twice
    const tally = [
      g.nReady ? `<b class="sk-n sk-n--ready">${g.nReady}</b> ready` : "",
      // "done", not "turned in": this count now folds in tests only the
      // achievement record witnessed, which this log never saw handed over.
      g.nDone ? `<b class="sk-n sk-n--done">${g.nDone}</b> done` : "",
      g.nPartial ? `${g.nPartial} started` : "",
      `${g.tests.length} tests`,
    ].filter(Boolean).join(" · ");
    const orphan = g.orphan
      ? `<p class="sk-orphan">${g.orphan} completed trade${g.orphan === 1 ? "" : "s"} with ${esc(g.giver)} matched no single test — that is what a turn-in split across two trades looks like.</p>`
      : "";
    const tests = rows.map(t => `<div class="skt${t.ready ? " is-ready" : ""}${t.done || t.ach ? " is-done" : ""}${t.skip ? " is-skip" : ""}${t.track ? " is-track" : ""}">
      <div class="skt__h">
        <button type="button" class="skt__star${t.track ? " on" : ""}" data-skytrack="${g.code}" data-test="${esc(t.full)}"
          title="${t.track ? "Tracking this one — click to stop" : "Track this test: it stars here and joins the Tracked tab"}"
          aria-pressed="${t.track}">${t.track ? "★" : "☆"}</button>
        <span class="skt__n">${esc(t.n)}</span>
        ${t.say ? `<span class="skt__say" title="Hail ${esc(g.giver)} and say this">say <code>${esc(t.say)}</code></span>` : ""}
        ${skyStatus(t)}
        ${t.done ? `<span class="skt__done" title="Your log shows ${t.done} turn-in${t.done === 1 ? "" : "s"} of this test">✓${t.done}</span>` : ""}
        ${t.ach && !t.done ? `<span class="skt__done skt__done--ach" title="Your achievement record says you obtained ${esc(t.reward)}; the turn-in happened before this log">✓ recorded</span>` : ""}
        <span class="skt__rew">→ ${skyItemSpan(t.reward)}</span>
        <button type="button" class="skt__skip" data-skyskip="${g.code}" data-test="${esc(t.full)}"
          title="${t.skip ? "Un-skip: count this one again" : "Never doing this one — its pieces stop counting as needed"}">${t.skip ? "un-skip" : "skip"}</button>
      </div>
      <ul class="skt__items">${t.rune.map(skyRuneHtml).join("")}${t.items.map(skyPieceHtml).join("")}</ul>
    </div>`).join("");
    return `<section class="skg">
      <button type="button" class="skg__h" data-skyclass="${g.code}" aria-expanded="${open}">
        <span class="skg__caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
        <span class="skg__n">${esc(g.name)}</span>
        <span class="skg__giver">${esc(g.giver)}</span>
        <span class="skg__tally">${tally}</span>
      </button>
      <div class="skg__b"${open ? "" : " hidden"}>${orphan}${tests}</div>
    </section>`;
  }).join("");

  let html;
  if (SKYP.view === "boss") {
    const b = skyBossHtml(m, q);
    html = b.html; shown = b.shown; openCount = b.openCount;
  } else if (SKYP.view === "drop") {
    const d = skyDropHtml(m, q);
    html = d.html; shown = d.shown;
  } else {
    html = classHtml();
  }
  body.classList.toggle("sky--boss", SKYP.view === "boss");
  body.innerHTML = html || `<p class="empty">Nothing matches. ${
    SKYP.view === "boss" ? "Clear the search, or untick <b>only what I need</b>." : "Widen <b>show</b>, or clear the search."}</p>`;
  meta.textContent = SKYP.view === "boss"
    ? `${skyTotalNeed(m)} pieces to loot · ${m.tot.done}/${m.tot.tests} tests done · ${shown} shown`
    : SKYP.view === "drop"
    ? `${m.tot.done}/${m.tot.tests} tests done · ${shown} rows`
    : `${m.tot.ready} ready · ${m.tot.done}/${m.tot.tests} done · ${m.tot.partial} started · ${shown} shown`;
  $("skyExpand").textContent = openCount ? "collapse all" : "expand all";
  // What this reading can and can't have seen. Both halves are real limits and
  // neither is recoverable, so they are stated rather than left to be inferred.
  const bits = [];
  if (!INV.rows) bits.push("No inventory dump yet — counts come from the log alone. Type <code>/out inventory</code> in game to get bag and bank locations.");
  else if (INV.mtime) {
    const age = Date.now() - INV.mtime;
    if (age > 10 * 60 * 1000) bits.push(`Inventory dump is ${age > 3600e3 ? Math.round(age / 3600e3) + "h" : Math.round(age / 60000) + "m"} old — <code>/out inventory</code> to refresh.`);
  }
  if (SKYL.led && !SKYL.led.sawSky) bits.push("No Plane of Sky zone-in in this log — turn-ins from before it aren't counted.");
  banner.innerHTML = bits.join(" ");
  banner.hidden = !bits.length;
  retip();
}

/* Widget payload — pre-resolved, like every other feed:* relay. Only what the
   widget options let through, so a 95-row board doesn't land in a 340px
   window; the tab's own filters stay out of it deliberately (the two are read
   in different places and for different reasons). */
let lastSkyJson = "";
/* The widget's boss board. Only mobs that owe you something — a 340px window is
   not where you read a full 46-mob drop table — and tracked pieces first inside
   each one, which is the whole reason the star exists (Kyle, 2026-08-14: "it
   also indicates what im tracking. shows those items first"). */
function pushSkyBosses(m, w) {
  const out = [];
  for (const isle of m.isles || []) for (const mob of isle.mobs) {
    const rows = mob.rows.filter(r => r.need > 0 || (w.trackedFirst && r.track));
    if (!rows.length) continue;
    out.push({
      n: mob.n, role: mob.role, isle: isle.name, isl: isle.isl,
      need: mob.need, track: mob.track,
      drops: rows.map(r => ({
        ...skyRef(r.n), have: r.have, need: r.need, track: r.track,
        buys: r.uses.filter(u => !u.fin && !u.skip)
          .map(u => `${u.cls}: ${u.reward || u.short}`).slice(0, 4),
        locs: w.loc ? r.locs.map(b => ({ k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title })) : [],
      })),
    });
  }
  return out;
}

/* The widget's cleanout list. The overlay holds no datasets, so every row
   arrives resolved: what you skipped, where it is, and which of the two
   disposals it is. Capped, and the cap is sent with it — a silent truncation
   reads as "this is everything". */
const SKY_WID_DROPS = 40;
function pushSkyDrops(m, w) {
  const d = skyDropModel();
  if (!d) return { rows: [], n: 0, give: 0, total: 0, skips: 0 };
  const items = d.items;
  return {
    n: items.reduce((a, r) => a + r.count, 0),
    give: items.filter(r => r.give).length,
    total: items.length,
    // what the other half of the tab is recommending, as one number
    skips: d.tests.filter(k => !k.st.skip).length,
    rows: items.slice(0, SKY_WID_DROPS).map(r => ({
      ...skyRef(r.n), count: r.count, tier: r.tier, give: r.give,
      why: r.uses.map(u => `${u.code} ${skdShort(u.code, u.test.n)}`).join(" · "),
      locs: w.loc && r.loc ? [(b => ({ k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title }))(skyBadge(r.loc))] : [],
    })),
  };
}

function pushSky(model) {
  const m = model || skyModel();
  if (!m) return;
  const w = SKYP.wid;
  const groups = [];
  for (const g of m.classes) {
    if (!w.cls.includes(g.code)) continue;
    const tests = g.tests.filter(t => skyKeep(t, w.show, w.hideDone) && !t.skip).map(t => ({
      // `ach` rides along so the overlay marks a pre-log completion the same
      // way the tab does; an older overlay build just ignores the extra key.
      n: t.n, say: w.say ? t.say : "", done: t.done, ach: t.ach, ready: t.ready,
      missing: t.missing, track: t.track,
      rew: skyRef(t.reward),
      items: t.rune.map(r => ({ ...skyRef(r.n), n: "Rune " + r.short, have: r.have, need: 1, rune: true, locs: [] }))
        .concat(t.items.map(i => ({
          ...skyRef(i.n), have: i.have, need: i.need, star: i.star,
          isl: i.have >= i.need ? "" : (i.isl ? skyIsle(i.isl) + (i.mob ? " · " + i.mob : "") : ""),
          locs: w.loc ? i.locs.map(b => ({ k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title })) : [],
        }))),
    }));
    // tracked tests lead their giver's fold, same rule as the boss board
    tests.sort((a, b) => (b.track - a.track) || (b.ready - a.ready));
    if (tests.length) groups.push({ code: g.code, name: g.name, giver: g.giver,
                                    ready: tests.filter(t => t.ready).length, tests });
  }
  const drop = w.view === "drop" ? pushSkyDrops(m, w) : null;
  const p = { groups, view: w.view === "boss" ? "boss" : w.view === "drop" ? "drop" : "class",
              bosses: w.view === "boss" ? pushSkyBosses(m, w) : [],
              drop,
              ready: m.tot.ready, tests: m.tot.tests, done: m.tot.done,
              loot: skyTotalNeed(m),
              inv: INV.rows ? { age: INV.mtime ? Date.now() - INV.mtime : 0 } : null };
  const j = JSON.stringify(p);
  if (j !== lastSkyJson) { lastSkyJson = j; window.companion.sendSky(p); }
}

let skyTimer = null;
function renderSkySoon() {   // loot bursts land in batches; coalesce like the feed
  if (skyTimer) return;
  skyTimer = setTimeout(() => {
    skyTimer = null;
    const m = skyModel();      // one derivation feeds both surfaces
    renderSky(m); pushSky(m);
  }, 300);
}

/* The widget options block: what the overlay's Sky tab shows. Kept out of
   SETTINGS.overlay on purpose — the payload is built here, so the choice that
   shapes it belongs here too. */
function renderSkyWidget() {
  const w = SKYP.wid;
  const chip = code => `<label class="skw__c"><input type="checkbox" data-skywcls="${code}"${w.cls.includes(code) ? " checked" : ""}> ${esc(SKY_CLASS[code])}</label>`;
  const boss = w.view === "boss", drop = w.view === "drop";
  $("skyWidBody").innerHTML =
    `<label class="skw__r">Group by <select data-skyw="view">
       <option value="class"${!boss && !drop ? " selected" : ""}>quest giver</option>
       <option value="boss"${boss ? " selected" : ""}>boss</option>
       <option value="drop"${drop ? " selected" : ""}>what to get rid of</option>
     </select></label>` +
    (boss || drop ? "" :
    `<label class="skw__r">Show <select data-skyw="show">
       <option value="ready"${w.show === "ready" ? " selected" : ""}>ready to turn in</option>
       <option value="held"${w.show === "held" ? " selected" : ""}>anything I hold a piece of</option>
       <option value="all"${w.show === "all" ? " selected" : ""}>every test</option>
     </select></label>` +
    `<label class="skw__r"><input type="checkbox" data-skyw="hideDone"${w.hideDone ? " checked" : ""}> hide tests I've finished</label>`) +
    `<label class="skw__r"><input type="checkbox" data-skyw="loc"${w.loc ? " checked" : ""}> show where each piece is</label>` +
    (boss
      ? `<label class="skw__r"><input type="checkbox" data-skyw="trackedFirst"${w.trackedFirst ? " checked" : ""}> keep tracked pieces on the board</label>`
      : drop ? ""
      : `<label class="skw__r"><input type="checkbox" data-skyw="say"${w.say ? " checked" : ""}> show the hail phrase</label>`) +
    (drop ? `<p class="skw__note">The list is what you have ticked skip on and are still carrying, by place, and whether another player can take it. Which tests to tick is the table above.</p>` :
     boss ? `<p class="skw__note">The boss board lists the mobs that still owe you a piece. Tracked pieces come first and keep their star.</p>` :
    `<div class="skw__h">Classes <button type="button" class="lnk" data-skywall="1">all</button> ·
       <button type="button" class="lnk" data-skywall="0">none</button></div>` +
    `<div class="skw__cls">${Object.keys(SKY_CLASS).sort((a, b) => SKY_CLASS[a].localeCompare(SKY_CLASS[b])).map(chip).join("")}</div>`);
}

/* ── Sky: get rid of it ────────────────────────────────────────────────────
   Kyle, 2026-08-14: *"most people want to finish all quests for each class once
   to unlock that class … you're recommending things that i have already done
   once that are not strong items"* and *"showing me what i have that i have
   marked skip, sorted by location (bank, inventory, storage, etc) so i can
   clean it out"*.

   Two tables in the order you ask them. The first run of a test is the class
   unlock and is never recommended away; the second and after only buy an
   upgrade tier on the reward you already hold, which is worth the islands only
   if the reward is. Tick the ones that aren't, and their pieces show up in the
   second table by place.

   The measuring is ../vendor/sky-core.js — `skipRows` and `cleanoutRows`, the
   same two functions /sky's own tab runs. What is injected is what differs
   between the surfaces:

     have  — this tab's held count (the dump, the log, your own held mark), plus
             the worn count, the upgrade tier and every place the dump found it
     rank  — a scorer per class. The site has a trio picker and a Compare-against
             switch; this tab has neither, so it runs that switch's `class`
             position: the reward against everything its own class can wear. */
const SKD = { top: 3, unlockFirst: true, sort: "frees", dir: -1, csort: "where", cdir: 1 };
const SKD_KEY = "eqlt-companion-skydrop-v1";
function loadSkyDropPrefs() {
  try { Object.assign(SKD, JSON.parse(localStorage.getItem(SKD_KEY)) || {}); } catch {}
}
const saveSkyDropPrefs = () => { try { localStorage.setItem(SKD_KEY, JSON.stringify(SKD)); } catch {} };

let SKY_SCORERS = new Map();
function skyScorer(code) {
  const key = code + "|" + VL.level;
  if (!SKY_SCORERS.has(key)) {
    SKY_SCORERS.set(key, window.EQLGearScore.make({
      classes: [code], level: VL.level, race: null, equipped: null, D: window.EQL_DATA }));
  }
  return SKY_SCORERS.get(key);
}
/* Where a reward stands in its own slot. Cached: the alternatives pool in
   sky.json is 2,900 items and every render asks about 95 rewards. */
const SKY_RANKS = new Map();
function skyRankOf(name, code, tier) {
  if (!SKYD || !name) return null;
  const t = tier || 0;
  const key = `${code}|${VL.level}|${t}|${name}`;
  if (SKY_RANKS.has(key)) return SKY_RANKS.get(key);
  let out = null;
  const rec = skyRec(name);
  const slot = rec && (rec.sl || [])[0];
  const sc = skyScorer(code);
  if (rec && slot && (rec.st || rec.sv || rec.haste || rec.dmg)) {
    const s = sc.score(rec, t, 0, slot);
    const skip = SKYD.names[name.toLowerCase()];
    const all = (SKYD.alts[slot] || [])
      .filter(k => k !== skip && sc.legal(SKYD.items[k]))
      .map(k => ({ rec: SKYD.items[k], s: sc.score(SKYD.items[k], 0, 0, slot) }))
      .sort((a, b) => b.s - a.s);
    const better = all.filter(a => a.s > s);
    out = { rank: better.length + 1, of: all.length + 1, score: s, slot, tier: t,
            better: better.slice(0, 3).map(a => a.rec.n) };
  }
  SKY_RANKS.set(key, out);
  return out;
}

/* Every place the dump found each item, plus how many are worn and the best
   upgrade tier you hold. sky-core takes all three off `have()`. */
function skyPlaceIndex() {
  const m = new Map();
  const GS = window.EQLGearScore;
  for (const r of INV.rows || []) {
    if (r.exalt) continue;   // the stone is not the item — see haveMap
    const worn = !/-Slot\d+$/.test(r.loc) && GS.WORN_RX.test(GS.rootLoc(r.loc));
    for (const k of new Set([itemKey(r.name), itemKey(stripDecor(r.name))])) {
      const e = m.get(k) || { worn: 0, tier: 0, where: [] };
      if (worn) e.worn += r.count;
      e.tier = Math.max(e.tier, r.tier || 0);
      e.where.push({ loc: r.loc, sec: r.sec, count: r.count });
      m.set(k, e);
    }
  }
  return m;
}

function skyDropModel() {
  if (!SKYD || !SKYL) return null;
  const have = haveMap();
  const locIdx = skyLocIndex();
  const placeIdx = skyPlaceIndex();
  const seen = n => locIdx.has(itemKey(n));
  const hav = (n) => {
    const h = skyHave(have, n, seen(n));
    const p = placeIdx.get(itemKey(n)) || placeIdx.get(itemKey(stripDecor(n)))
      || { worn: 0, tier: 0, where: [] };
    return { n: h.n, src: h.src, worn: p.worn, tier: p.tier, where: p.where };
  };
  /* Completions per class, memoised for this build only — sky-core asks one
     test's state a few hundred times, and walking every closed trade in the log
     for each of them is the same work over and over. Nothing survives the
     build: the ledger grows with every line the tail reads. */
  const comp = new Map();
  const state = (code, test) => {
    if (!comp.has(code)) comp.set(code, SKY.completions(SKYD, SKYL.led, code));
    const done = comp.get(code).byTest[test.n] || 0;
    const ach = !!(ACH_SKY[code] && ACH_SKY[code].byTest[test.n]);
    // times done, every witness — the achievement record proves one, the log
    // may have watched more
    return { done: Math.max(done, ach ? 1 : 0), logDone: done, ach,
             skip: skySkipped(code, test.n) };
  };
  const o = { top: SKD.top, unlockFirst: SKD.unlockFirst, have: hav,
              rec: skyRec, rank: skyRankOf, state };
  return { tests: SKY.skipRows(SKYD, o), items: SKY.cleanoutRows(SKYD, o) };
}

const skdShort = (code, n) => n.replace((SKY_CLASS[code] || "") + " ", "");

const SKD_TCOLS = [
  { k: "cls", h: "Class", d0: 1, key: k => SKY_CLASS[k.code], cell: k => `<td>${esc(SKY_CLASS[k.code])}</td>` },
  { k: "test", h: "Test", d0: 1, key: k => k.test.n, cell: k => `<td>${esc(skdShort(k.code, k.test.n))}</td>` },
  { k: "done", h: "Done", d0: -1, key: k => k.done, cell: k => `<td class="iv-n">${k.done
      ? `<b class="sk-n sk-n--done">${k.done}×</b>`
      : (SKD.unlockFirst && k.st.skip)
      ? `<span class="skd__w skd__w--clash" title="you have skipped a test you have never run; the ${esc(SKY_CLASS[k.code])} unlock needs this one, along with every other test in its class">never run</span>`
      : `<span class="dim">—</span>`}</td>` },
  { k: "rew", h: "Reward", d0: 1, key: k => k.reward, cell: k => `<td class="iv-item">${skyItemSpan(k.reward)}</td>` },
  { k: "rep", h: "Repeat pays", d0: -1, key: k => (k.tier == null ? null : k.tier),
    cell: k => `<td class="iv-n">${!k.done ? `<span class="dim">first copy</span>`
      : k.tier == null ? `<span class="dim">—</span>`
      : `<span class="skd__n" title="running it again hands you a duplicate, and merging it takes your copy up a tier">+${k.tier} → +${k.tier + 1}</span>`}</td>` },
  { k: "rank", h: "Rank", d0: -1, key: k => k.rk.rank,
    cell: k => `<td class="iv-n skd__n" title="against every in-era item ${esc(k.code)} can wear in ${esc(k.rk.slot)}">${k.rk.rank} of ${k.rk.of}</td>` },
  { k: "beat", h: "Beaten by", d0: 1, key: k => k.rk.better[0] || null,
    cell: k => `<td>${k.rk.better.map(n => skyItemSpan(n)).join(" · ")}</td>` },
  { k: "hold", h: "You hold", d0: -1, key: k => k.held.length || null,
    cell: k => `<td class="iv-n" title="${esc(k.held.join(", ")) || "none"}">${k.held.length || ""}</td>` },
  { k: "frees", h: "Frees", d0: -1, key: k => k.frees.length || null,
    cell: k => `<td class="iv-n${k.frees.length ? " skd__n" : ""}" title="${k.frees.length
      ? esc(k.frees.join(", ")) : "nothing you hold would come free — another test you have not skipped wants the same pieces"}">${k.frees.length || ""}</td>` },
];

const SKD_CCOLS = [
  // section first, then the bag and slot NUMBERS as numbers — see /sky's locSortKey
  { k: "where", h: "Where", d0: 1,
    key: r => String(r.secIdx).padStart(2, "0") + "|" + String(r.loc).replace(/\d+/g, d => d.padStart(4, "0")),
    cell: r => `<td>${r.loc ? skyBadgeHtml(skyBadge(r.loc)) : `<span class="dim">your log, not the dump</span>`}</td>` },
  { k: "item", h: "Item", d0: 1, key: r => r.n.toLowerCase(),
    cell: r => `<td class="iv-item">${skyItemSpan(r.n)}${r.tier ? ` <b class="skd__t">+${r.tier}</b>` : ""}</td>` },
  { k: "count", h: "Count", d0: -1, key: r => r.count, cell: r => `<td class="iv-n">${r.count}</td>` },
  { k: "wt", h: "Weight", d0: -1, key: r => r.wt * r.count || null,
    cell: r => `<td class="iv-n dim" title="${r.wt} each">${r.wt ? (r.wt * r.count).toFixed(1) : ""}</td>` },
  { k: "how", h: "Get rid of it by", d0: 1, key: r => (r.give ? "a" : r.give === false ? "b" : "z"),
    cell: r => `<td>${skdHow(r)}</td>` },
  { k: "for", h: "Skipped for", d0: 1, key: r => r.uses[0].code,
    cell: r => `<td>${r.uses.map(u => `<span class="skd__w skd__w--skip" title="${esc(SKY_CLASS[u.code] || u.code)} — ${esc(u.test.n)}, you skipped it">${
      esc(u.code)} ${esc(skdShort(u.code, u.test.n))}</span>`).join(" ")}</td>` },
];

function skdHow(r) {
  const fl = (r.rec && r.rec.fl) || [];
  const flag = fl.includes("no_drop") ? "NO DROP" : fl.includes("no_trade") ? "No Trade" : "";
  const clash = r.clash ? ` <span class="skd__w skd__w--clash" title="the item window and the wiki's Plane of Sky table disagree about this one; the window is what the game shows you">wiki disagrees</span>` : "";
  if (r.give === null) return `<span class="dim" title="no item page on the wiki, so nothing here knows whether it is NO DROP">not known</span>`;
  if (r.give) return `<span class="skd__h skd__h--give" title="not NO DROP, so another player can take it${r.wantedBy ? `. ${r.wantedBy} class test${r.wantedBy === 1 ? "" : "s"} use it` : ""}">sell to a player</span>${clash}`;
  return `<span class="skd__h skd__h--nd" title="${esc(flag || "NO DROP")} — nobody else can take it, so destroying it is what frees the slot">destroy</span>${clash}`;
}

function skyDropHtml(m, q) {
  const d = skyDropModel();
  if (!d) return { html: "", shown: 0 };
  const hit = (s) => !q || String(s).toLowerCase().includes(q);
  /* "uses" opens the SAME per-test skip menu the boss board's right-click does,
     so the map it reads is filled here too — only one of the three views is on
     screen at a time, and one menu implementation is the point. */
  SKY_DROPS = new Map();
  for (const r of d.items) {
    SKY_DROPS.set(r.n, r.uses.map(u => ({
      code: u.code, cls: SKY_CLASS[u.code], test: u.test.n,
      short: skdShort(u.code, u.test.n), reward: u.reward,
      fin: !!u.st.done, skip: !!u.st.skip,
    })));
  }

  const arrow = (k, s, dir) => s === k ? (dir > 0 ? " ▲" : " ▼") : "";
  const head = (cols, attr, s, dir) => `<thead><tr>${cols.map(c =>
    `<th class="is-sort" data-${attr}="${c.k}">${esc(c.h)}${arrow(c.k, s, dir)}</th>`).join("")}<th></th></tr></thead>`;

  const tests = d.tests.filter(k => hit(k.test.n) || hit(k.reward));
  const open = tests.filter(k => !k.st.skip);
  const frees = new Set(open.flatMap(k => k.frees)).size;
  const tcol = SKD_TCOLS.find(c => c.k === SKD.sort) || SKD_TCOLS[8];
  const trows = tests.slice().sort((a, b) => (a.st.skip - b.st.skip)
    || cmpNullLast(tcol.key(a), tcol.key(b), SKD.dir) || a.test.n.localeCompare(b.test.n));

  const items = d.items.filter(r => hit(r.n));
  const ccol = SKD_CCOLS.find(c => c.k === SKD.csort) || SKD_CCOLS[0];
  const crows = items.slice().sort((a, b) => cmpNullLast(ccol.key(a), ccol.key(b), SKD.cdir)
    || a.n.localeCompare(b.n));
  const n = items.reduce((a, r) => a + r.count, 0);
  const wt = items.reduce((a, r) => a + r.wt * r.count, 0);
  const give = items.filter(r => r.give);
  const places = new Set(items.map(r => r.sec)).size;

  const one = open.length === 1;
  const back = [];
  if (d.tests.unlock) back.push(`<b>${d.tests.unlock}</b> more rank outside it, but you have never run ${
    d.tests.unlock === 1 ? "that one" : "them"}: the first run of a test is what unlocks the class.`);
  if (d.tests.unranked) back.push(`${d.tests.unranked} can't be ranked — the wiki has no stats for the reward.`);
  const cnote = [];
  if (d.items.mixed) cnote.push(`${d.items.mixed} more ${d.items.mixed === 1 ? "piece is" : "pieces are"} still wanted by a test you haven't skipped.`);
  if (d.items.worn) cnote.push(`${d.items.worn} ${d.items.worn === 1 ? "is" : "are"} on your character.`);

  const html = `<div class="skd">
    <div class="skd__ctl">
      <label class="chk"><input type="checkbox" data-skd="unlockFirst"${SKD.unlockFirst ? " checked" : ""}> do each test at least once to unlock its class</label>
      <span class="dim">a finished test is worth running again if its reward is in the top
        <select data-skd="top">${[1, 3, 5, 10].map(x =>
          `<option value="${x}"${SKD.top === x ? " selected" : ""}>${x}</option>`).join("")}</select>
        of its own slot</span>
    </div>
    <h3 class="skd__h3">Tests to skip</h3>
    <p class="skd__sum">${(open.length
      ? `<b>${open.length}</b> test${one ? "" : "s"} you have already finished pay${one ? "s" : ""} a reward outside the top ${SKD.top} of its slot.`
        + (frees ? ` Skipping ${one ? "it" : "them"} clears <b>${frees}</b> piece${frees === 1 ? "" : "s"} out of your bags.` : "")
      : `Every test you have finished pays a reward inside the top ${SKD.top} of its slot.`)
      + (back.length ? " " + back.join(" ") : "")}</p>
    ${trows.length ? `<table class="qtab ivt skd__t2">${head(SKD_TCOLS, "skdtsort", SKD.sort, SKD.dir)}<tbody>${
      trows.map(k => `<tr class="${k.st.skip ? "is-skip" : ""}">${SKD_TCOLS.map(c => c.cell(k)).join("")}<td><button type="button" class="lnk"
        data-skyskip="${esc(k.code)}" data-test="${esc(k.test.n)}">${k.st.skip ? "un-skip" : "skip"}</button></td></tr>`).join("")
    }</tbody></table>` : `<p class="empty">Nothing to skip.</p>`}
    <h3 class="skd__h3">Skipped, and still in your bags</h3>
    <p class="skd__sum">${(items.length
      ? `<b>${n}</b> item${n === 1 ? "" : "s"} across <b>${places}</b> place${places === 1 ? "" : "s"}${wt ? `, ${wt.toFixed(1)} weight` : ""}. Nothing else wants any of ${n === 1 ? "it" : "them"}.`
        + (give.length ? ` <b>${give.length}</b> ${give.length === 1 ? "is" : "are"} not NO DROP: sell ${give.length === 1 ? "that one" : "those"} to a player rather than a merchant.` : "")
      : `Nothing in your bags belongs to a test you've skipped.`)
      + (cnote.length ? " " + cnote.join(" ") : "")}</p>
    ${crows.length ? `<table class="qtab ivt skd__t2">${head(SKD_CCOLS, "skdcsort", SKD.csort, SKD.cdir)}<tbody>${
      crows.map(r => `<tr>${SKD_CCOLS.map(c => c.cell(r)).join("")}<td><button type="button" class="lnk skd__u" data-drop="${esc(r.n)}">uses</button></td></tr>`).join("")
    }</tbody></table>` : ""}
  </div>`;
  return { html, shown: crows.length + trows.length };
}
function populateSkyFilters() {
  const sel = $("skyClass");
  sel.innerHTML = `<option value="">all classes</option>` +
    Object.keys(SKY_CLASS).sort((a, b) => SKY_CLASS[a].localeCompare(SKY_CLASS[b]))
      .map(c => `<option value="${c}"${SKYP.cls === c ? " selected" : ""}>${esc(SKY_CLASS[c])}</option>`).join("");
  $("skyShow").value = SKYP.show;
  $("skyHideDone").checked = SKYP.hideDone;
  $("skyOnlyNeed").checked = !!SKYP.onlyNeed;
  paintSkyView();
  renderSkyWidget();
}


/* ── Valet tab: get dressed out of what you already own ────────────────────
   The site's /valet page and this tab run ONE implementation of the walk —
   ../vendor/valet-core.js, vendored from public/valet/valet-core.js. What
   differs is injected: the scorer (this tab has its own trio picker, the site
   reads the shared EQLChar store) and the memory (a decision can't be shared —
   the app and the site are different origins, same wall Sky's skip marks hit).

   The overlay gets the RESULT only. Picking twenty-three slots through a 340px
   panel is not something anyone does with a corpse on the floor; reading "bank
   3 · Ethereal Mist Helm +2" while standing at the banker is the whole point. */
const VL_KEY = "eqlt-companion-valet-v1";
const VL = { classes: ["WAR", "CLR", "WIZ"], level: 50, mem: {}, sort: "where", dir: 1 };
let VWALK = null;
function loadValetPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(VL_KEY)) || {};
    if (Array.isArray(o.classes) && o.classes.length === 3) VL.classes = o.classes;
    if (o.level) VL.level = Math.min(50, Math.max(1, o.level | 0));
    if (o.mem && typeof o.mem === "object") VL.mem = o.mem;
  } catch (e) {}
}
const saveValetPrefs = () => {
  try { localStorage.setItem(VL_KEY, JSON.stringify({ classes: VL.classes, level: VL.level, mem: VL.mem })); } catch (e) {}
};
const vlTrioKey = () => VL.classes.slice().sort().join("/");
const VL_MEM = {
  get: k => (VL.mem[vlTrioKey()] || {})[k] || null,
  set: (k, rec) => { (VL.mem[vlTrioKey()] || (VL.mem[vlTrioKey()] = {}))[k] = rec; saveValetPrefs(); },
  del: k => { const m = VL.mem[vlTrioKey()]; if (m) { delete m[k]; saveValetPrefs(); } },
};

let VINV = null;   // { rows, equipped, unmatched, wornUnknown }
function valetReload() {
  /* No race here on purpose: gear-score derives its weights from the
     character's own totals only when it has one, and this tab has no race
     picker. Without it the weights fall back to the class/level model, exactly
     as the site does before you choose a race. */
  VINV = (INV.text && GDATA) ? window.EQLValet.readInventory(INV.text, GDATA) : null;
  spareReload();
  valetRestart();
}
function valetScorer() {
  return window.EQLGearScore.make({ classes: VL.classes, level: VL.level, race: null,
                                    equipped: VINV && VINV.equipped, D: window.EQL_DATA });
}
function valetRestart() {
  VWALK = VINV ? window.EQLValet.makeWalk({ rows: VINV.rows, equipped: VINV.equipped,
                                            scorer: valetScorer(), mem: VL_MEM }) : null;
}

const vlStat = (rec, tier) => {
  const s = window.EQLTier.statsAt(rec, tier), out = [];
  for (const k of ["ac", "hp", "mana", "end", "atk", "str", "sta", "agi", "dex", "wis", "int", "cha"])
    if (s[k]) out.push(`<b>${s[k]}</b> ${k.toUpperCase()}`);
  for (const k in rec.sv || {}) if (k !== "v") out.push(`<b>${rec.sv[k]}</b> SV${k.toUpperCase()}`);
  if (rec.haste) out.push(`<b>${rec.haste}%</b> haste`);
  if (rec.dmg && rec.dly) out.push(`<b>${window.EQLTier.statAt(rec.dmg, tier)}</b>/<b>${rec.dly}</b> = <b>${(window.EQLTier.statAt(rec.dmg, tier) / rec.dly).toFixed(2)}</b>${window.EQLGearScore.TWO_H(rec) ? " 2H" : ""}`);
  return out.join(" · ") || `<span class="dim">no stats on the wiki</span>`;
};
function vlBadge(loc) {
  const b = window.EQLGearScore.locBadge(loc);
  return b.kind === "word"
    ? `<span class="skl skl--word" title="${esc(b.title)}">${esc(b.word)}</span>`
    : `<span class="skl skl--${b.kind}" title="${esc(b.title)}">${esc(b.kind)} <b>${b.n}</b>${b.sub ? `<span class="skl__s">·${b.sub}</span>` : ""}</span>`;
}

function renderValet() {
  const run = $("vlRun"), done = $("vlDone"), empty = $("vlEmpty"), meta = $("vlMeta");
  drawValetTrio();
  if (!VWALK) {
    run.hidden = true; done.hidden = true; empty.hidden = false;
    if (INV.problem) empty.textContent = INV.problem;
    meta.textContent = "";
    return;
  }
  empty.hidden = true;
  meta.textContent = `${INV.file} · ${VINV.rows.length} items · ${VL.classes.join("/")} at ${VL.level}`;
  if (VWALK.done()) { run.hidden = true; done.hidden = false; renderValetDone(); }
  else { done.hidden = true; run.hidden = false; renderValetRun(); }
}

function renderValetRun() {
  const step = VWALK.step(), all = VWALK.options(), opts = all.slice(0, 4);
  $("vlSlot").textContent = step.label;
  $("vlCount").textContent = `${VWALK.i + 1} of ${VWALK.steps.length}`;
  $("vlPool").textContent = all.length + " you own fit here"
    + (all.length > 4 ? " · the four best are below" : "");
  /* The two-hander question, on the step where the choice is made. */
  const wc = VWALK.weaponCompare();
  const a = wc && wc.best2H ? `<b>${Math.round(wc.best2H.score)}</b> two-handed — ${esc(wc.best2H.items[0].row.name)}` : "";
  const b = wc && wc.bestPair ? `<b>${Math.round(wc.bestPair.total)}</b> main + off — ${esc(wc.bestPair.main.name)} + ${esc(wc.bestPair.off.name)}` : "";
  $("vlCmp").innerHTML = a || b ? [a, b].filter(Boolean).join(" · ") : "";
  $("vlCmp").hidden = !(a || b);
  const now = VWALK.wearingAt(step);
  $("vlNow").innerHTML = now.length
    ? "On you now: " + now.map(e => e.rec ? `<b>${esc(e.name)}</b>`
        : `<b>${esc(e.name)}</b> <span class="warn">no wiki page — nothing here can be compared against it</span>`).join(" + ")
    : "nothing in this slot";
  $("vlCards").innerHTML = opts.map((o, n) => `
    <div class="vlc" role="button" tabindex="0" data-vlopt="${n}">
      <div class="vlc__s" title="HP-equivalents for this trio">${Math.round(o.score)}</div>
      ${o.items.map(it => `<div class="vlc__i">
        <div class="vlc__n">${itemSpan(it.row.name, true)}</div>
        <div class="vlc__st">${vlStat(it.row.rec, it.row.tier)}</div>
        <div class="vlc__w">${vlBadge(it.row.loc)}${o.items.length > 1 ? ` <span class="dim">${esc(it.slot)}</span>` : ""}</div>
      </div>`).join("")}
    </div>`).join("") || `<p class="dim">Nothing you own fits here.</p>`;
  $("vlRemember").checked = !!VL_MEM.get(step.key);
  $("vlBack").disabled = VWALK.i === 0;
  const k = VWALK.autoSummary(), bits = [];
  if (k.mem.length) bits.push(`<b>${k.mem.length}</b> remembered (<button type="button" class="linkish" id="vlClearMem">ask me again</button>)`);
  if (k.only.length) bits.push(`<b>${k.only.length}</b> had one candidate`);
  if (k.flat.length) bits.push(`<b title="${esc(k.flat.join(", "))}">${k.flat.length}</b> nothing the scorer reads — kept what you have on`);
  if (k.twoh && k.twoh.length) bits.push("off hand held by your two-hander");
  if (k.skip.length) bits.push(`<b>${k.skip.length}</b> left empty`);
  if (k.none.length) bits.push(`<b>${k.none.length}</b> had nothing that fits`);
  $("vlAuto").innerHTML = bits.join(" · ");
}

/* The fetch list. Every column sorts, same rule as every other table here. */
const VL_COLS = [
  { k: "where", h: "Where it is", d0: 1, v: it => window.EQLValet.secRank(it.row.sec) * 1000 + (window.EQLGearScore.locBadge(it.row.loc).n || 0) },
  { k: "slot", h: "Slot", d0: 1, v: it => it.step.label },
  { k: "item", h: "Item", d0: 1, v: it => it.row.name.toLowerCase() },
  { k: "tier", h: "Tier", d0: -1, v: it => it.row.tier, num: 1 },
  { k: "stats", h: "Stats", d0: 1, v: it => it.row.name.toLowerCase() },
  { k: "do", h: "Do", d0: 1, v: it => (it.row.sec === "worn" ? 0 : 1) },
];
function renderValetDone() {
  const plan = VWALK.planLoadout(), cur = VWALK.currentLoadout();
  const ds = plan.score - cur.score;
  $("vlNow2").textContent = Math.round(cur.score);
  $("vlNew").textContent = Math.round(plan.score);
  $("vlDelta").textContent = (ds > 0 ? "+" : "") + Math.round(ds);
  $("vlDelta").className = ds > 0 ? "up" : ds < 0 ? "down" : "";

  const k = VWALK.autoSummary(), notes = [];
  if (k.none.length) notes.push(`Nothing you own fits: ${esc(k.none.join(", "))}.`);
  if (k.flat.length) notes.push(`Kept what you have on, because nothing the scorer reads separates the candidates: ${esc(k.flat.join(", "))}.`);
  if (VINV.unmatched.length) notes.push(`${VINV.unmatched.length} items in your dump have no wiki page, so they were not considered`
    + (VINV.wornUnknown.length ? ` — including what you are wearing on ${VINV.wornUnknown.map(e => `${esc(e.slot)} (${esc(e.name)})`).join(", ")}. Check those swaps yourself.` : "."));
  $("vlNotes").innerHTML = notes.join(" ");

  const col = VL_COLS.find(c => c.k === VL.sort) || VL_COLS[0];
  const items = window.EQLValet.fetchOrder(plan.items).sort((a, b) => {
    const av = col.v(a), bv = col.v(b);
    return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * VL.dir;
  });
  const arrow = k2 => VL.sort === k2 ? (VL.dir > 0 ? " ▲" : " ▼") : "";
  $("vlFetch").innerHTML = `<table class="qtab ivt"><thead><tr>${
    VL_COLS.map(c => `<th data-vlsort="${c.k}">${esc(c.h)}${arrow(c.k)}</th>`).join("")
  }</tr></thead><tbody>${items.map(it => {
    const worn = it.row.sec === "worn";
    return `<tr class="${worn ? "is-dim" : ""}">
      <td>${vlBadge(it.row.loc)}</td>
      <td>${esc(it.step.label)}</td>
      <td class="iv-item">${itemSpan(it.row.name, true)}</td>
      <td>${it.row.tier ? "+" + it.row.tier : ""}</td>
      <td>${vlStat(it.row.rec, it.row.tier)}</td>
      <td>${worn ? `<span class="dim">already on</span>` : "<b>fetch</b>"}</td>
    </tr>`;
  }).join("") + plan.kept.map(k => `<tr class="is-dim">
      <td>${vlBadge(k.slot)}</td>
      <td>${esc(k.step.label)}</td>
      <td class="iv-item">${esc(k.e.name)}</td>
      <td></td>
      <td><span class="dim">${k.e.rec ? "not scored here" : "no wiki page — can't be scored"}</span></td>
      <td><span class="dim">keep</span></td>
    </tr>`).join("")}</tbody></table>`;
}

/* What crosses to the overlay: the pull list, and nothing you are already
   wearing. Same shape discipline as pushSky — build it here, send only on
   change, and keep it small enough to redraw a 340px panel. */
let lastValetJson = "";
function pushValet() {
  if (!VWALK) { if (lastValetJson !== "null") { lastValetJson = "null"; window.companion.sendValet(null); } return; }
  const plan = VWALK.planLoadout(), cur = VWALK.currentLoadout();
  const all = window.EQLValet.fetchOrder(plan.items);
  const p = {
    trio: `${VL.classes.join("/")} at ${VL.level}`,
    gain: Math.round(plan.score - cur.score),
    worn: all.filter(it => it.row.sec === "worn").length,
    ready: VWALK.done(),
    fetch: all.filter(it => it.row.sec !== "worn").map(it => {
      const b = window.EQLGearScore.locBadge(it.row.loc);
      const ref = skyRef(it.row.name);
      return { slot: it.step.label, n: it.row.name, url: ref.url, sb: ref.sb,
               loc: { k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title } };
    }),
  };
  const j = JSON.stringify(p);
  if (j !== lastValetJson) { lastValetJson = j; window.companion.sendValet(p); }
}

/* The Spare list, trimmed for a 340px window: the most-beaten first, one line
   each, and the ONE caveat a row can carry. The overlay never re-runs the
   analysis — it gets the answer the Inventory tab already computed. */
let lastSpareJson = "";
const SPARE_OVERLAY_ROWS = 40;
function pushSpare() {
  if (!SPARE) { if (lastSpareJson !== "null") { lastSpareJson = "null"; window.companion.sendSpare(null); } return; }
  const p = {
    n: SPARE.spare.length, total: SPARE.items.length,
    rows: SPARE.spare.slice(0, SPARE_OVERLAY_ROWS).map(it => {
      const b = window.EQLGearScore.locBadge(it.row.loc);
      const ref = skyRef(it.row.name);
      return {
        n: it.row.name, url: ref.url, sb: ref.sb,
        ahead: it.ahead, cls: it.best.cls, slot: it.best.slot,
        warn: it.unscored.length ? UNSCORED_WORD[it.unscored[0]] : null,
        loc: { k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title },
      };
    }),
  };
  const j = JSON.stringify(p);
  if (j !== lastSpareJson) { lastSpareJson = j; window.companion.sendSpare(p); }
}

function drawValetTrio() {
  const C = window.EQLChar;
  ["vlC1", "vlC2", "vlC3"].forEach((id, i) => {
    const sel = $(id);
    if (!sel.options.length)
      sel.innerHTML = C.CLASSES.map((c, j) => `<option value="${c}">${esc(C.NAMES[j])}</option>`).join("");
    sel.value = VL.classes[i];
  });
  $("vlLvl").value = VL.level;
}
function wireValet() {
  loadValetPrefs();
  ["vlC1", "vlC2", "vlC3"].forEach((id, i) => $(id).addEventListener("change", () => {
    const v = $(id).value, j = VL.classes.indexOf(v);
    if (j !== -1 && j !== i) VL.classes[j] = VL.classes[i];   // a trio is 3 distinct
    VL.classes[i] = v;
    saveValetPrefs(); valetRestart(); renderValet(); pushValet(); pushSpare();
  }));
  $("vlLvl").addEventListener("change", () => {
    VL.level = Math.min(50, Math.max(1, $("vlLvl").value | 0 || 50));
    // every per-class scorer behind Gear and Spare is built at this level
    saveValetPrefs(); spareReload(); valetRestart();
    renderValet(); pushValet(); pushSpare(); renderInv();
  });
  $("vlRestart").addEventListener("click", () => { valetRestart(); renderValet(); pushValet(); pushSpare(); });
  $("vlSkip").addEventListener("click", () => { VWALK.skip(); renderValet(); pushValet(); pushSpare(); });
  $("vlBack").addEventListener("click", () => { if (VWALK.back()) { renderValet(); pushValet(); pushSpare(); } });
  $("vlAuto").addEventListener("click", (e) => {
    if (!e.target.closest("#vlClearMem")) return;
    delete VL.mem[vlTrioKey()]; saveValetPrefs(); valetRestart(); renderValet(); pushValet(); pushSpare();
  });
  const take = (e) => {
    if (e.target.closest("a")) return;
    const b = e.target.closest("[data-vlopt]");
    if (!b || !VWALK) return;
    VWALK.pick(VWALK.step().key, VWALK.options()[+b.dataset.vlopt], $("vlRemember").checked);
    renderValet(); pushValet(); pushSpare();
  };
  $("vlCards").addEventListener("click", take);
  $("vlCards").addEventListener("keydown", (e) => {
    if ((e.key !== "Enter" && e.key !== " ") || !e.target.closest(".vlc")) return;
    e.preventDefault(); take(e);
  });
  $("vlFetch").addEventListener("click", (e) => {
    const th = e.target.closest("[data-vlsort]");
    if (!th) return;
    const k = th.dataset.vlsort, c = VL_COLS.find(x => x.k === k);
    if (VL.sort === k) VL.dir = -VL.dir; else { VL.sort = k; VL.dir = (c && c.d0) || 1; }
    renderValetDone();
  });
}

/* ── achievements: what you did before anything was watching ──────────────
   `/outputfile achievements` is the client's own record of a character's
   history, and it is the ONLY source for the thing every tracker gets wrong
   on day one: a player who installs this after weeks of play. The log starts
   the day the log starts; this file does not.

   What it can actually prove is narrow, and the tab says so. `Obtain X`
   criteria exist ONLY under the sixteen Primary Class Unlocks, where they are
   that class's Plane of Sky test rewards one-for-one. There is no general
   "you completed quest X" row anywhere in the file, so Sky is the whole quest
   backfill; the rest is unlock progress, which is worth its own tab.

   The trust rule lives in the shared module (EQLAch.trust) because it is a
   fact about the file, not about this app: a completed unlock force-marks
   every criterion, so only an INCOMPLETE one — or a complete one that took
   neither escape hatch — can be read. */
const ACH = { file: null, mtime: 0, parsed: null, problem: null, char: "" };
const UNL = { view: "class", q: "", hideDone: false };
const UNL_KEY = "eqlt-companion-unlocks-v1";
let ACH_SKY = {};   // class code -> {byTest, trusted, …}; rebuilt on load

function onAchFile({ file, mtime, text }) {
  ACH.file = file; ACH.mtime = mtime;
  ACH.char = window.EQLAch.whose(file).char;
  ACH.parsed = window.EQLAch.parse(text);
  rebuildAchSky();
  renderUnlocks(); renderSky(); pushSky();
}
function onAchStatus({ problem }) { ACH.problem = problem; renderUnlocks(); }

/* Whose dump is this? The app follows whatever character the log is on, and
   applying one character's achievements to another's Sky tab would be silent
   fiction — Averaj's finished tests are not Ravlin's. Mismatch keeps the
   Unlocks tab (it is still a real record, and says whose) but contributes
   nothing to Sky. */
function achMine() {
  if (!ACH.parsed) return false;
  const me = SKYL && SKYL.me;
  if (!me || !ACH.char) return true;   // can't tell yet — don't withhold
  return ACH.char.toLowerCase() === me.toLowerCase();
}
function rebuildAchSky() {
  ACH_SKY = ACH.parsed && SKYD && achMine()
    ? window.EQLAch.skyTests(SKYD, ACH.parsed, SKY_CLASS) : {};
}

/* ── the Unlocks tab ──────────────────────────────────────────────────────
   Three lists off one file. A locked unlock shows its real requirements with
   the ones already done ticked; an unlocked one says HOW, because "unlocked"
   and "earned" are different facts and only one of them means the work is
   behind you. Deity rows mostly read "Future Placeholder for X Requirements"
   — the client's own words for unimplemented — and are never drawn as a
   checklist a player could work on. */
const UNL_TITLE = {
  class: "Primary class unlocks are the Plane of Sky class tests — the Sky tab has the pieces and where they drop.",
  race: "Race unlocks come from faction. Max the factions listed and the race opens.",
  deity: "The client ships these as placeholders — the requirements are not implemented yet.",
};
function unlockRowHtml(u) {
  const pct = u.need ? Math.round((u.have / u.need) * 100) : 0;
  const state = u.unlocked
    ? `<span class="unl__st unl__st--on" title="${esc(u.whyText)}">unlocked</span>`
    : u.placeholder ? `<span class="unl__st unl__st--na">not implemented</span>`
    : `<span class="unl__st">${u.have}/${u.need}</span>`;
  /* An unlocked-by-token/creation row has nothing to show under it: every
     criterion reads complete whether or not it happened, so the honest move is
     to say that instead of printing six ticks that mean nothing. */
  const steps = !u.trusted
    ? `<div class="unl__note dim">${esc(u.whyNote)}</div>`
    : u.placeholder
    ? `<div class="unl__note dim">${esc(u.steps.map(s => s.t).join(" "))}</div>`
    : `<ul class="unl__steps">${u.steps.map(s =>
        `<li class="${s.done ? "is-done" : ""}"><span class="unl__tick">${s.done ? "✓" : "·"}</span> ${esc(s.t)}</li>`).join("")}</ul>`;
  return `<details class="unl${u.unlocked ? " is-on" : ""}"${!u.unlocked && u.have > 0 ? " open" : ""}>
    <summary><span class="unl__n">${esc(u.name)}</span> ${state}
      ${u.unlocked && u.whyText ? `<span class="dim">${esc(u.whyText)}</span>` : ""}
      ${!u.unlocked && u.need && u.have ? `<span class="unl__bar"><i style="width:${pct}%"></i></span>` : ""}
    </summary>${steps}</details>`;
}
function renderUnlocks() {
  const body = $("unlBody"), empty = $("unlEmpty"), banner = $("unlBanner");
  const meta = $("unlMeta");
  if (!ACH.parsed) {
    body.innerHTML = ""; meta.textContent = "";
    empty.hidden = false;
    banner.hidden = !ACH.problem;
    if (ACH.problem) banner.textContent = ACH.problem;
    return;
  }
  empty.hidden = true;
  const u = window.EQLAch.unlocks(ACH.parsed);
  const list = { class: u.classes, race: u.races, deity: u.deities }[UNL.view] || [];
  const q = UNL.q.trim().toLowerCase();
  const rows = list.filter(r => {
    if (UNL.hideDone && r.unlocked) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || r.steps.some(s => s.t.toLowerCase().includes(q));
  });
  const mine = achMine();
  banner.hidden = mine;
  if (!mine) banner.textContent =
    `This dump is ${ACH.char}'s and the log is ${SKYL && SKYL.me}'s — shown, but not applied to the Sky tab.`;
  const on = list.filter(r => r.unlocked).length;
  meta.textContent = `${on}/${list.length} unlocked · ${rows.length} shown · ${ACH.char || "dump"}`;
  body.innerHTML =
    `<p class="unl__hint dim">${esc(UNL_TITLE[UNL.view])}</p>` +
    (rows.length ? rows.map(unlockRowHtml).join("") : `<p class="empty">Nothing matches.</p>`);
}

/* ── Parser tab: the site's report, rendered here ─────────────────────────
   Not an iframe of /log-parser and no file to drop — the log is the one
   Settings points at. vendor/site/log-parser/render.js is the SAME renderer
   the website runs, so a panel cannot look or count differently in the two
   places; this file only decides which slice it draws.

   TWO windows, on purpose, because they answer different questions:

   * CB.live — the current zone visit, re-parsed on a fast adaptive cadence.
     It drives the plaques, the damage meter and the overlay: what is
     happening right now. Rolls (and forgets) when you zone.
   * PR.win — the SESSION: the freshest lines regardless of zoning, pinned to
     a zone-entry line at the head so buildClaims still cuts at the window
     start. It drives the report panels, so zoning doesn't wipe the mob table,
     and its seg.visits fills the zone-session picker for free. Parsed only
     while this tab is open, on a much slower cadence — it is a report you
     read between pulls, not a meter you watch mid-fight. */
let LINES_SEEN = 0; // bootstrap + live lines; PR re-parses on growth
const PR_WIN_LINES = 60000;   // session window; ~50m of a busy raid group
const PR = {
  win: [], zoneLine: null, run: null,
  open: false, timer: null, runMs: 0, fedLines: -1,
  view: "fights",     // which panel group is showing
  sess: null,         // chosen zone session (seg visit id), null = all of them
  fight: "*",         // focused fight key
};

/* Same head-pinning rule as capLive(): a plain tail-slice would cut the
   window's own zone-entry line, and with it both the zone readout and the
   claims-cut-at-window-start property. */
function prPush(lines) {
  for (const l of lines) {
    if (CB_ZONE_RX.test(l)) PR.zoneLine = l;
    PR.win.push(l);
  }
  if (PR.win.length > PR_WIN_LINES) {
    PR.win = PR.win.slice(-PR_WIN_LINES);
    if (PR.zoneLine && PR.win[0] !== PR.zoneLine) PR.win.unshift(PR.zoneLine);
  }
}

function prRun() {
  if (!PR.open) return;
  const t0 = performance.now();
  PR.run = combatParse(PR.win);
  PR.runMs = performance.now() - t0;
  PR.fedLines = LINES_SEEN;
  renderParser();
}
function prSoon() {
  if (PR.timer || !PR.open) return;
  // a report between pulls, not a meter: 3 s floor, and it still backs off on
  // a window expensive enough to matter
  PR.timer = setTimeout(() => { PR.timer = null; if (LINES_SEEN > PR.fedLines) prRun(); else prSoon(); },
    Math.max(3000, PR.runMs * 8));
}
function parserTabActive(on) {
  PR.open = on;
  if (!on) { if (PR.timer) { clearTimeout(PR.timer); PR.timer = null; } return; }
  if (!PR.run || LINES_SEEN > PR.fedLines) prRun(); else renderParser();
  prSoon();
}

/* The slice, in the shape render.js takes. Day and level stay open: this
   window is at most an evening, and the app already knows whose log it is. */
const prSel = () => ({
  day: null, sess: PR.sess, levels: null, combo: "*", fight: PR.fight,
  labels: { sess: prSessLabel() },
});
function prSessLabel() {
  if (PR.sess == null || !PR.run) return null;
  const v = PR.run.seg.visits.find(x => x.id === PR.sess);
  return v ? v.name : null;
}

function prVisitOpts() {
  const sel = $("cbScope");
  if (!PR.run) { sel.hidden = true; return; }
  const vs = PR.run.seg.visits.slice().reverse();
  sel.hidden = vs.length < 2;
  const prev = String(PR.sess ?? "*");
  sel.innerHTML = `<option value="*">All ${vs.length} zone sessions</option>` +
    vs.map(v => `<option value="${v.id}">${esc(v.name)}${v.tier ? ` · D${v.tier}` : ""} · ${tsShort(v.ts)}</option>`).join("");
  // a session that slid out of the window falls back to all, never to a
  // different one — the same stale-key rule the site's controls follow
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  else { PR.sess = null; sel.value = "*"; }
}
function prFightOpts() {
  const sel = $("cbFight");
  if (!PR.run) { sel.hidden = true; return; }
  const fights = PR.run.seg.fights.filter(f => f.total > 0 || f.taken > 0)
    .filter(f => PR.sess == null || f.zv === PR.sess)
    .sort((a, b) => b.start - a.start);
  sel.hidden = !fights.length;
  const prev = PR.fight;
  sel.innerHTML = `<option value="*">All fights</option>` +
    fights.slice(0, 300).map(f => `<option value="${esc(E.fkey(f))}">${esc(f.mob)} · ${tsShort(f.start)} · ${fmtN(f.total)} dmg</option>`).join("");
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  else { PR.fight = "*"; sel.value = "*"; }
}

function renderParser() {
  const empty = $("cbEmpty"), report = $("lpReport");
  const has = !!(PR.run && PR.run.P.events.length);
  empty.hidden = has;
  report.hidden = !has;
  $("plaques").hidden = !has;
  $("cbViews").hidden = !has;
  if (!has) { $("whoLine").innerHTML = ""; $("cbScope").hidden = true; $("cbFight").hidden = true; return; }

  const { P, seg, side } = PR.run;
  const w = P.who;
  const pets = [...new Set(side.claims.names.filter(c => c.kind === "pet").map(c => c.name))];
  const charms = [...new Set(side.claims.names.filter(c => c.kind === "charm").map(c => c.name))];
  const here = seg.visits.length ? seg.visits[seg.visits.length - 1] : null;
  $("whoLine").innerHTML = `<span class="who-name">${esc(P.owner || "—")}</span>` +
    (w ? `<span class="who-meta">${esc(w.race)} · ${esc(w.classes)}</span>` : "") +
    (here ? `<span class="who-meta">${esc(here.name)}${here.tier ? ` · D${here.tier}` : ""}</span>` : "") +
    (pets.length ? `<span class="who-pet">pets: ${esc(pets.slice(0, 3).join(", "))}</span>` : "") +
    (charms.length ? `<span class="who-pet">charm: ${esc(charms.slice(0, 2).join(", "))}</span>` : "") +
    (seg.levels.length ? `<span class="who-lvl">levels ${seg.levels[0]}–${seg.levels[seg.levels.length - 1]}</span>` : "");

  const t = $("cbTrunc");
  t.hidden = PR.win.length < PR_WIN_LINES;
  if (!t.hidden) t.textContent = `Reading the freshest ${fmtN(PR_WIN_LINES)} lines of your log — earlier play isn't in this report.`;

  prVisitOpts();
  prFightOpts();
  EQLLogView.render(PR.run, prSel());
  // everyone's damage is a companion panel, not one of the site's — the site
  // report is your own side only, and a group meter is the thing you actually
  // want on the second monitor
  $("prRaid").innerHTML = raidHtml();
  paintParserView();
}

function paintParserView() {
  for (const el of document.querySelectorAll("#lpReport .lpview")) el.hidden = el.dataset.lpview !== PR.view;
  for (const b of document.querySelectorAll("#cbViews .seg__b")) b.classList.toggle("is-on", b.dataset.lpview === PR.view);
}

/* ── combat tab: live per-fight and session stats ─────────────────────────
   The site's /log-parser ENGINE (vendor/site/log-parser/engine.js — the same
   parse/claims/fights/analyze the page itself runs) over a rolling window of
   the live log. Nothing is transcribed here; every number is the engine's
   own, so this tab can never disagree with eqltools.com/log-parser.

   The engine is a whole-window pass by design (fights, claims, and kill
   clusters need lookahead), so "live" means re-running it over a SMALL
   window on a throttle, not feeding it line by line. The window is the
   current zone visit: buildClaims cuts every claim interval at a zone-entry
   line, so a window that starts on one has byte-identical attribution to a
   full-file parse for everything inside it. Earlier visits parse once and
   freeze. The refresh cadence adapts to the measured parse time (10×), so a
   marathon visit degrades to a slower meter instead of pinning a core. */
const E = window.EQLLog;
const CB = {
  hist: [],            // frozen rows from earlier zone visits, oldest first
  histKeys: new Set(),
  encHist: [],         // frozen ENCOUNTER rows (overlapping fights grouped)
  encKeys: new Set(),
  live: [],            // raw lines of the current zone visit
  zoneLine: null,      // the visit's zone-entry line, pinned when live caps
  owner: null,
  run: null,           // last live engine result {P, side, seg}
  session: null,       // {a, kills} for the live window
  runMs: 0,            // last parse duration — drives the adaptive cadence
  timer: null, dirty: false,
  sel: null,           // expanded fight key
  raidOpen: false,     // Everyone's-damage table shown
  raidSel: null,       // expanded raid actor
  trunc: false,        // the visit outran the window; `all` is a tail, not all
  raidZero: null,      // reset stamp: a LOG timestamp, and nothing before it
                       // counts. Session-lifetime and never persisted — a zero
                       // from yesterday's play names a moment that isn't in
                       // today's window. Dropped when the visit rolls.
  raidWin: 0,          // meter window in minutes, 0 = the whole visit. Lives in
                       // SETTINGS.overlay.statsWindow so this tab and the widget
                       // can never label one window and show another's numbers.
  raidSort: "dmg", raidDir: 1,
  encCache: new Map(), // encounter key -> {sig, detail, raid} drill-down memo
};
let OVERLAY_SHOWN = false;
/* The bootstrap has to reach back far enough to find the CURRENT visit's
   zone-entry line, and a big group writes a lot of lines: measured on a real
   Plane of Hate 4 farm group, 2026-08-14, the visit was 97,804 lines and 73
   minutes, so the old 60,000 missed its own entry line and fell through to the
   10,000-line branch below — 7.5 minutes of window, no zone name, and no
   claims cut. Only the backward regex scan runs over the whole seed; the
   history parse is what the number really costs, ~700ms once at this size,
   already on a timeout. */
const CB_SEED_LINES = 150000;
const CB_LIVE_LINES = 40000; // cap on one visit's window — past it the window
                             // truncates, the same semantics as the site's 40 MB cap
const CB_HIST_CAP = 40;      // frozen fights kept
// the engine's own zone rule: these entries are not zone changes
const CB_ZONE_RX = /^\[.{24}\] You have entered (?!an area|an Arena|the Drunken Monkey).+\.$/;
/* A marathon visit overruns CB_LIVE_LINES and a plain tail-slice would cut
   the visit's own zone-entry line — losing the zone readout and the
   claims-cut-at-window-start property. Keep the zone line pinned at the
   head: the window becomes "the zone entry plus the freshest N lines" —
   the same attribution contract, with a gap the engine's rate math already
   handles (found live: an 18-minute Plane of Hate raid visit).

   CB.trunc records that this happened, because it is the difference between
   the meter's widest scope being the whole visit and it being a tail — and
   the widest button is labeled from it rather than always saying "all".
   40,000 lines is 35 minutes of that same PoH group, at a 150ms parse. */
function capLive() {
  if (CB.live.length <= CB_LIVE_LINES) return;
  CB.trunc = true;
  CB.live = CB.live.slice(-CB_LIVE_LINES);
  if (CB.zoneLine && CB.live[0] !== CB.zoneLine) CB.live.unshift(CB.zoneLine);
}

function combatSeed(file, text) {
  CB.owner = (file.match(/eqlog_([^_]+)_/) || [])[1] || null;
  CB.hist = []; CB.histKeys = new Set(); CB.encHist = []; CB.encKeys = new Set();
  CB.live = []; CB.run = null; CB.session = null; CB.raidSel = null;
  CB.encCache = new Map(); CB.trunc = false; CB.raidZero = null;
  // the bootstrap tail can be 40 MB; slice and parse off the handler's stack
  setTimeout(() => {
    let lines = text.split(/\r?\n/).filter(l => l.length);
    if (lines.length > CB_SEED_LINES) lines = lines.slice(-CB_SEED_LINES);
    let cut = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (CB_ZONE_RX.test(lines[i])) { cut = i; break; }
    // no zone line in the whole tail: keep a window, and the same one a long
    // visit gets — the old 10,000 here was a third of that for no stated reason
    if (cut < 0 && lines.length > CB_LIVE_LINES) { lines = lines.slice(-CB_LIVE_LINES); CB.trunc = true; }
    CB.live = lines.slice(Math.max(0, cut));
    CB.zoneLine = cut >= 0 ? lines[cut] : null;
    capLive();
    if (cut > 0) {
      const r = combatParse(lines.slice(0, cut));
      if (r) combatFreeze(r);
    }
    // the Parser's window spans visits, so it takes the whole seed, not the
    // slice from the last zone line
    PR.win = []; PR.zoneLine = null; PR.run = null; PR.sess = null; PR.fight = "*";
    prPush(lines);
    if (PR.open) prRun();
    combatSoon();
  }, 50);
}

function combatFeed(lines) {
  for (const l of lines) {
    CB.live.push(l);
    if (CB_ZONE_RX.test(l)) combatRollVisit(l);
  }
  capLive();
  prPush(lines);
  prSoon();
  CB.dirty = true;
  combatSoon();
}

/* A zone line ends the visit: parse it one last time (the zone event closes
   every open fight), freeze those fights, and start the new visit's window
   at its own zone line. */
function combatRollVisit(zoneLine) {
  const r = combatParse(CB.live);
  if (r) combatFreeze(r);
  CB.live = [zoneLine];
  CB.zoneLine = zoneLine;
  // a new zone is already a fresh start; carrying the stamp across would hide
  // the new visit behind an instant that belongs to the old one
  CB.run = null; CB.session = null; CB.trunc = false; CB.raidZero = null;
}

function combatParse(lines) {
  if (!lines.length) return null;
  const p = E.parse(lines.join("\n"), CB.owner);
  if (!p.events.length) return null;
  const claims = E.buildClaims(p);
  const side = E.mkSide(p, claims);
  const seg = E.buildSegments(p, side);
  return { P: p, side, seg };
}

function combatFreeze(r) {
  for (const f of r.seg.fights) {
    if (!(f.total > 0 || f.taken > 0)) continue;
    const key = E.fkey(f);
    if (CB.histKeys.has(key)) continue;
    const row = combatRow(f, r);
    row.detail = combatDetailFor(f, r); // the engine objects are dropped; keep the expansion
    CB.hist.push(row); CB.histKeys.add(key);
  }
  if (CB.hist.length > CB_HIST_CAP) {
    for (const row of CB.hist.slice(0, CB.hist.length - CB_HIST_CAP)) CB.histKeys.delete(row.key);
    CB.hist = CB.hist.slice(-CB_HIST_CAP);
  }
  // encounter rows freeze alongside — the overlay's drill-down survives the
  // visit roll the same way the per-fight expansions do. Only the groups that
  // will survive the cap get the analyze() pass (a marathon farming visit can
  // hold far more), and the live memo serves the ones it already computed.
  const groups = encounterize(r.seg.fights).slice(-CB_HIST_CAP);
  for (const g of groups) {
    const row = encRow(g, r);
    if (CB.encKeys.has(row.key)) continue;
    const c = encCached(row, g, r);
    row.detail = c.detail; row.raid = c.raid;
    CB.encHist.push(row); CB.encKeys.add(row.key);
  }
  if (CB.encHist.length > CB_HIST_CAP) {
    for (const row of CB.encHist.slice(0, CB.encHist.length - CB_HIST_CAP)) CB.encKeys.delete(row.key);
    CB.encHist = CB.encHist.slice(-CB_HIST_CAP);
  }
  CB.encCache = new Map(); // per-visit memo; frozen rows carry their detail
}

/* "Your kill" the way a player means it: your own blow landed it, something on
   your side landed it, or the server credited you — an xp or coin burst on the
   death line is credit, and in a raid the killing blow is usually someone
   else's while the kill is still yours. This is ONE rule because the three
   places that ask were drifting: the encounter rows had the credit clause and
   the session counter didn't, so a real Plane of Hate farm group read 6 kills
   in 35 minutes with the ✓ marks below it disagreeing (measured 2026-08-14). */
const teamKill = (f, r) => !!f.killed &&
  (f.killer === r.P.owner || !!r.side.claims.at(f.killer, f.end) || f.xp > 0 || f.coin > 0);

function combatRow(f, r) {
  return {
    key: E.fkey(f), ts: f.start, mob: f.mob, zone: f.zone,
    secs: Math.max(1, Math.round((f.end - f.start) / 1000)),
    total: f.total, you: f.dmg.you, pet: f.dmg.pet, charm: f.dmg.charm,
    taken: f.taken, xp: f.xp, coin: f.coin, killed: f.killed,
    team: teamKill(f, r),
    detail: null,
  };
}

/* The site's fight-focus slice, generalized to a SET of mobs: their own
   damage/miss events plus every non-combat event in the span, through one
   analyze() pass — so every drill-down number is the engine's own and can
   never disagree with eqltools.com/log-parser. */
function combatSliceDetail(names, start, end, r) {
  const t0 = start - 2000, t1 = end.getTime() + 2000;
  const evs = r.P.events.filter(e => e.ts >= t0 && e.ts <= t1 &&
    (names.has(e.src) || names.has(e.tgt) || (e.k !== "dmg" && e.k !== "miss")));
  const oc = r.P.who ? r.P.who.classes.split("/") : null;
  const a = E.analyze(r.P, evs, r.side, oc);
  return {
    tot: { you: a.tot.you, pet: a.tot.pet, charm: a.tot.charm },
    sources: a.sources.slice(0, 14).map(s => ({ name: s.name, side: s.side, hits: s.hits, dmg: s.dmg, max: s.max, crit: s.crit })),
    takenBy: a.takenBy.slice(0, 10).map(t => ({ src: t.src, name: t.name, hits: t.hits, dmg: t.dmg, max: t.max, res: t.res })),
    taken: a.taken.dmg, avoid: a.taken.avoid,
    healTot: a.healTot, healInTot: a.healInTot, petTaken: a.petTaken,
    swings: a.swings,
  };
}
function combatDetailFor(f, r) { return combatSliceDetail(new Set([f.mob]), f.start, f.end, r); }

/* One ENCOUNTER = every fight that overlapped in time — the pull plus its
   adds. A fight opening while the previous group is still running joins it;
   a chain-pull that starts after the last mob dropped is a new encounter. */
function encounterize(fights) {
  const fs = fights.filter(f => f.total > 0 || f.taken > 0).sort((a, b) => a.start - b.start);
  const groups = [];
  for (const f of fs) {
    const g = groups[groups.length - 1];
    if (g && f.start <= g.end) { g.fights.push(f); if (f.end > g.end) g.end = f.end; }
    else groups.push({ start: f.start, end: f.end, fights: [f] });
  }
  return groups;
}

// same identity rule as fkey: (start second, first mob) survives re-parses
function encRow(g, r) {
  const sum = k => g.fights.reduce((a, f) => a + f[k], 0);
  const mobs = g.fights.map(f => ({
    mob: f.mob, killed: f.killed, team: teamKill(f, r),
    dmg: f.total, taken: f.taken, xp: Math.round(f.xp * 10) / 10, coin: f.coin,
  }));
  return {
    key: `${g.start.getTime()}~${g.fights[0].mob}`, ts: g.start,
    secs: Math.max(1, Math.round((g.end - g.start) / 1000)),
    mobs, total: sum("total"), taken: sum("taken"),
    xp: Math.round(sum("xp") * 10) / 10, coin: sum("coin"),
    kills: mobs.filter(m => m.killed).length,
    team: mobs.some(m => m.team),
    detail: null, raid: null,
  };
}
const encDetail = (g, r) => combatSliceDetail(new Set(g.fights.map(f => f.mob)), g.start, g.end, r);
/* Drill-down memo: an analyze() pass per encounter per tick is waste when the
   encounter hasn't changed. The signature covers every encRow number — any
   new damage/kill/xp moves one of them; a heals-only second can serve one
   stale healTot and self-corrects on the next swing. Cleared per visit.

   The per-pull meter rides the same memo. Expanding one pull is where a raid
   asks "who did what on THAT", and until now a pull expanded to your own
   sources only — the actors were visible for the visit and nowhere per fight. */
const encSig = row => `${row.secs}|${row.total}|${row.taken}|${row.xp}|${row.coin}|${row.kills}|${row.mobs.length}`;
function encCached(row, g, r) {
  const hit = CB.encCache.get(row.key);
  const sig = encSig(row);
  if (hit && hit.sig === sig) return hit;
  const rec = { sig, detail: encDetail(g, r), raid: raidMeter(r, +g.start, +g.end) };
  if (rec.raid && rec.raid.actors.length < 2) rec.raid = null; // solo: the row already says it
  CB.encCache.set(row.key, rec);
  return rec;
}

/* Raid meter: EVERYONE the log shows damaging a mob — you, your pet/charm,
   other players, their pets — one row per actor name, expandable to that
   actor's per-source split. Engine-consumer code, not engine code: the meter
   reads P.events/side()/mobSet, so it can never disagree with the engine
   about attribution. A text log can't tell another player's summoned pet from
   a player (both are bare capitalized names) and can't tie either to an owner,
   so rows stay per-name; only YOUR side is labeled.

   [t0, t1] narrows it, and every scope the app offers is this one function
   over a different slice: the whole visit unbounded, a rolling window ending
   at the newest swing, one pull bounded by its own encounter. */
function raidMeter(r, t0, t1) {
  const actors = new Map();
  const times = [];
  /* e.ts is a DATE, not a number — every arithmetic use below coerces, but a
     comparison against a non-number silently passes everything, so the bounds
     are numbers and the event's stamp is coerced once, here. (That exact slip
     shipped a reset button that zeroed the session line and left the meter
     reading the whole visit.) */
  for (const e of r.P.events) {
    if (e.k !== "dmg" || !e.src || !e.tgt) continue;
    const ts = +e.ts;
    if (t0 != null && (ts < t0 || ts > t1)) continue;
    if (!r.P.mobSet.has(e.tgt) || e.tgt === e.src) continue;
    // a claimed target is YOUR charm wearing a mob's name — damage to it is
    // damage taken, not raid damage (another player's charm can't be told
    // from a mob brawl; those rows stay, labeled as the mob they are)
    if (r.side.claims.at(e.tgt, e.ts)) continue;
    const s = r.side(e);
    // a mob damaging a mob with no claim is unattributable — someone's charm
    // or a brawl; it still swung for our side, so it stays, labeled by name
    let a = actors.get(e.src);
    if (!a) { a = { name: e.src, dmg: 0, hits: 0, max: 0, crit: 0, srcs: new Map(), sides: new Map() }; actors.set(e.src, a); }
    a.dmg += e.amt; a.hits++; if (e.crit) a.crit++; if (e.amt > a.max) a.max = e.amt;
    /* An actor's side can change inside one window — you charm a mob, it
       breaks — so the row is labeled by where most of its damage came from
       rather than by whichever event happened to land first. Reading the
       first event made the same name say "your charm" under one window
       button and something else under the next. */
    a.sides.set(s, (a.sides.get(s) || 0) + e.amt);
    const phys = e.cat === "melee" || e.cat === "ranged";
    const nm = phys ? (e.cat === "ranged" ? "ranged" : (e.verb === "hit" ? "auto-attack" : e.verb)) : e.spell || "unknown";
    const sr = a.srcs.get(nm) || { name: nm, hits: 0, dmg: 0, max: 0, crit: 0 };
    sr.hits++; sr.dmg += e.amt; if (e.crit) sr.crit++; if (e.amt > sr.max) sr.max = e.amt;
    a.srcs.set(nm, sr);
    times.push(ts);
  }
  if (!actors.size) return null;
  /* raid-wide combat seconds: the same 30s-gap rule as the engine's team
     denominator, over every counted event — one shared clock for all rows.

     SORT FIRST. The event stream is NOT monotonic: measured on a live Plane of
     Hate window, 22 of 14,858 counted events step backwards, the worst by 345
     seconds. Walking that in file order makes the gap rule bill a negative
     stretch for every inversion — the same window measured -5,979 s unsorted
     and 1,538 s sorted — and a denominator ≤ 0 hits the Math.max(1, …) floor
     below, which is what printed a raid's total damage as its DPS. */
  times.sort((a, b) => a - b);
  let secs = 0, s0 = null, last = null;
  for (const t of times) { if (last && (t - last) / 1000 > 30) { secs += (last - s0) / 1000 + 1; s0 = t; } if (!s0) s0 = t; last = t; }
  if (s0) secs += (last - s0) / 1000 + 1;
  const rows = [...actors.values()].sort((a, b) => b.dmg - a.dmg).slice(0, 16).map(a => ({
    name: a.name, who: [...a.sides].sort((x, y) => y[1] - x[1])[0][0],
    dmg: a.dmg, hits: a.hits, max: a.max, crit: a.crit,
    sources: [...a.srcs.values()].sort((x, y) => y.dmg - x.dmg).slice(0, 8),
  }));
  const total = [...actors.values()].reduce((n, a) => n + a.dmg, 0);
  // from/to are the sorted ends, so the rolling windows anchor on the newest
  // stamp the log really states rather than on whichever line happened to land
  // last (which the same inversions can make an older one)
  return { secs: Math.max(1, Math.round(secs)), total, actors: rows, from: times[0], to: times[times.length - 1] };
}

/* ── meter scope ──────────────────────────────────────────────────────────
   Kyle, 2026-08-14: "good to have a single fight/pull, and maybe whole
   raid/instance but also good to have a rolling window… ok we're farming hate
   and the group keeps rolling. not fair to compare whole instance for new
   people." So the meter carries a window, and comparing people over the last
   N minutes is a different question from comparing them over the whole visit.

   THE WINDOW ENDS AT THE NEWEST SWING, NOT AT THE WALL CLOCK. Every other
   number on this tab is measured off log timestamps, and a clock-anchored
   window drains to nothing during a med break — exactly when someone is
   reading it. So "the last 10 minutes" means the ten minutes ending on the
   last damage event the log states, and the row of numbers holds still
   between pulls instead of decaying.

   `all` is the current zone VISIT, which is the instance when you are in one:
   the live parse window starts at the zone-entry line. Bounded by
   CB_LIVE_LINES, so a marathon visit's `all` is as far back as we still hold. */
const RAID_WINS = [5, 10, 15];       // rolling windows, minutes
function raidTable(r) {              // the whole visit, or everything since a reset
  if (!r) return null;
  if (r._raid === undefined) r._raid = raidMeter(r, CB.raidZero, CB.raidZero ? Infinity : null);
  return r._raid;
}
function raidWindowTable(r, mins) {
  const full = raidTable(r);
  if (!mins || !full) return full;
  if (!r._raidW) r._raidW = new Map();
  // a reset floors every window: "the last 10 minutes" can't reach past it
  if (!r._raidW.has(mins))
    r._raidW.set(mins, raidMeter(r, Math.max(full.to - mins * 60000, CB.raidZero || 0), full.to));
  return r._raidW.get(mins);
}

/* Reset — Kyle, 2026-08-14: "give me a button to reset which captures a
   timestamp and the windows only go from that timestamp." The stamp is a LOG
   timestamp, like every other instant this tab measures, taken from the newest
   event the log states rather than from the clock. Everything on the tab obeys
   it — the meter, the rungs, the encounter list and the session line — because
   a top line still counting the whole visit next to a meter that isn't would
   just be two answers to one question. */
function setRaidZero(ts) {
  CB.raidZero = ts;
  if (CB.run) { CB.run._raid = undefined; CB.run._raidW = null; }
  CB.encCache = new Map();   // memoized per-visit tables predate the stamp
  if (CB.run) combatRun(); else { renderCombat(); lastStatsJson = ""; pushStats(); }
}
function raidResetNow() {
  const r = CB.run, evs = r && r.P.events;
  if (!evs || !evs.length) return;
  // the newest stamp the log states, which is the same instant the rolling
  // windows anchor on. Scanned rather than read off the tail: the event array
  // is close to sorted but not guaranteed to be, and one late line would put
  // the reset in the past. +1 so it starts strictly after what's written.
  let max = 0;
  for (const e of evs) { const t = +e.ts; if (t > max) max = t; }
  setRaidZero(max + 1);
}
/* Which rungs are worth offering. A window longer than the combat we hold is
   `all` under a second name, and two buttons for one number teach the reader
   something false. */
function raidRungs(r) {
  const full = raidTable(r);
  if (!full || full.actors.length < 2) return [];
  return RAID_WINS.filter(m => full.to - full.from > m * 60000);
}
// a rung that stopped being offered (you zoned, the new visit is 2 minutes
// old) falls back to `all` rather than quietly showing `all` under a 15m label
const effRaidWin = r => raidRungs(r).includes(CB.raidWin) ? CB.raidWin : 0;
/* The widest button says "all" only when the window still holds the start of
   the visit. Past CB_LIVE_LINES it is a tail, and a tail called "all" is
   exactly the misreading the rungs exist to prevent — so it gets labeled with
   the span it actually covers and reads as one more window. */
function raidAllLabel(r) {
  if (CB.raidZero) return "since reset";
  const full = raidTable(r);
  if (!CB.trunc || !full) return "all";
  return `${Math.max(1, Math.round((full.to - full.from) / 60000))}m`;
}
const raidWinLabel = (m, allLabel) => m ? `${m}m` : (allLabel || "all");

/* Refresh cadence, measured rather than guessed (2026-08-14, on a live Plane
   of Hate group): the engine phases cost parse 84 ms + claims 31 + segments 68
   + analyze 34 = ~217 ms over a 40k-line window, so the old `runMs × 10` —
   "spend at most a tenth of a core" — put a live damage meter on a 2.2-second
   refresh, and 8.5 s whenever a tick ran slow. Streaming a real raid log
   through it measured gaps of median 2.0 s, p90 4.0 s, max 17.2 s, which is
   not a live meter. `× 3` is a quarter of one core while you are actually
   fighting, with a 750 ms floor so a cheap window doesn't spin. The adaptive
   part stays: it is what keeps a marathon visit from pinning a core. */
function combatSoon() {
  if (CB.timer) return;
  CB.timer = setTimeout(() => { CB.timer = null; combatRun(); }, Math.max(750, CB.runMs * 3));
}
function combatRun() {
  CB.dirty = false;
  const t0 = performance.now();
  CB.run = combatParse(CB.live);
  if (CB.run) {
    const oc = CB.run.P.who ? CB.run.P.who.classes.split("/") : null;
    const z = CB.raidZero;
    const evs = z ? CB.run.P.events.filter(e => +e.ts >= z) : CB.run.P.events;
    const a = E.analyze(CB.run.P, evs, CB.run.side, oc);
    const kills = CB.run.seg.fights.filter(f => teamKill(f, CB.run) && (!z || +f.end >= z)).length;
    CB.session = { a, kills };
  } else CB.session = null;
  CB.runMs = performance.now() - t0;
  renderCombat();
  pushStats();
  if (CB.dirty) combatSoon(); // lines landed while we parsed
}

// merged fight list, newest first. The engine emits fights in CLOSE order (an
// idle-closed fight lands after kills that happened mid-way through it), so
// sort by start time or the list reads shuffled.

const fmtN = n => Math.round(n).toLocaleString();
const fmtDur = s => s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m`;
const tsShort = d => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const fmtCu = cu => {
  cu = Math.round(cu);
  const p = Math.floor(cu / 1000), g = Math.floor(cu % 1000 / 100), s = Math.floor(cu % 100 / 10);
  return p ? `${fmtN(p)}p ${g}g` : g ? `${g}g ${s}s` : `${s}s ${cu % 10}c`;
};

/* The fast per-visit path only owns the live meter now: the fights table, the
   plaques and every panel come from PR's session parse through render.js.
   Redrawing the meter is cheap (raidTable is memoized per run), but it still
   only happens when the panel it lives in is actually on screen. */
function renderCombat() {
  if (!PR.open || PR.view !== "damage") return;
  const el = $("prRaid");
  if (el) el.innerHTML = raidHtml();
}



/* ── swing intervals ──────────────────────────────────────────────────────
   How fast each actor is actually swinging, per weapon verb. Built for the
   weapon-swap question: run the same pet through two fights and compare the
   interval. Both the number and its range are shown because the range is what
   says whether a difference is real — two fights whose ranges overlap have
   not measurably changed, however different the middle numbers look. */
const SIDE_LABEL = { you: "you", pet: "your pet", charm: "your charm", othermob: "other", other: "other" };

/* Everyone's damage — the raid meter, on the Combat tab too. Collapsed to its
   header row until clicked; each actor row expands to that actor's source
   split, and the window chips pick the stretch of play it covers (the same
   SETTINGS.overlay.statsWindow the widget writes). */
const RAID_COLS = [
  { k: "name", h: "Actor", v: a => a.name.toLowerCase() },
  { k: "pct", h: "%", v: a => a.dmg },
  { k: "dmg", h: "Damage", v: a => a.dmg },
  { k: "dps", h: "DPS", v: a => a.dmg },   // one shared denominator: ranks as damage does
  { k: "hits", h: "Hits", v: a => a.hits },
  { k: "max", h: "Max", v: a => a.max },
  { k: "crit", h: "Crits", v: a => a.crit },
];
/* Only the sides a surefire claim established get a tag. There is deliberately
   no "(mob)": a player who was damaged lands in the engine's mobSet, so that
   tag read "(mob)" beside real raiders' names — and where it was right, the
   name already said so ("a Champion of Innoruuk"). An untagged row is an actor
   the log shows swinging, which is all the log actually states. */
const RAID_TAG = { you: " (you)", pet: " (your pet)", charm: " (your charm)" };
/* ONE window value for the tab and the widget, whichever surface set it: it
   writes the overlay pref, main persists and broadcasts, renderOverlayState
   applies it back here. The local write is so the tab redraws without waiting
   on the round-trip. */
function setRaidWin(m) {
  if (CB.raidWin === m) return;
  CB.raidWin = m;
  window.companion.setOverlayPrefs({ statsWindow: m });
  renderCombat();
  lastStatsJson = ""; pushStats();
}
function raidWinChips(rungs, sel, allLabel) {
  // `all` alone is not a choice, but reset is always offered
  const wins = rungs.length ? rungs.concat([0]).map(m =>
    `<button class="cb-win${m === sel ? " on" : ""}" data-raidwin="${m}">${raidWinLabel(m, allLabel)}</button>`).join("") : "";
  return `<span class="cb-wins">${wins}` +
    `<button class="cb-win cb-reset" data-raidreset="1" title="Count from now">reset</button>` +
    (CB.raidZero ? `<button class="cb-win cb-reset" data-raidreset="0" title="Count from the start of the visit again">✕</button>` : "") +
    `</span>`;
}
function raidHtml() {
  if (!CB.run) return "";
  const rungs = raidRungs(CB.run);
  const win = effRaidWin(CB.run);
  const rt = raidWindowTable(CB.run, win);
  // solo: the fight list already says it all, so no meter — but reset governs
  // the session line too, so its button is never hidden behind having a group
  const many = rt && rt.actors.length > 1;
  const secs = rt ? Math.max(1, rt.secs) : 1;
  let h = `<div class="cb-raidline">`;
  if (many) {
    h += `<span class="cb-raidhead" data-raidtoggle><span class="cb-caret">${CB.raidOpen ? "▾" : "▸"}</span> ` +
      `Everyone's damage</span> <span class="dim">· ${rt.actors.length} actors · ${fmtN(rt.total)} dmg · ` +
      `${fmtN(rt.total / secs)} dps · ${fmtDur(secs)} of combat</span>`;
  } else if (CB.raidZero) {
    h += `<span class="dim">Counting from the reset.</span>`;
  }
  h += raidWinChips(many ? rungs : [], win, raidAllLabel(CB.run)) + `</div>`;
  if (!many || !CB.raidOpen) return h;
  const col = RAID_COLS.find(c => c.k === CB.raidSort) || RAID_COLS[2];
  const rows = rt.actors.slice().sort((a, b) => {
    const ka = col.v(a), kb = col.v(b);
    return ((ka < kb ? -1 : ka > kb ? 1 : 0) * -CB.raidDir) || (b.dmg - a.dmg);
  });
  h += `<table class="qtab cbt cbraid"><thead><tr>` + RAID_COLS.map(c =>
    `<th class="is-sort" data-raidsort="${c.k}">${c.h}${CB.raidSort === c.k ? (CB.raidDir > 0 ? " ▼" : " ▲") : ""}</th>`).join("") +
    `</tr></thead><tbody>`;
  for (const a of rows) {
    h += `<tr class="cbr" data-raidactor="${esc(a.name)}"><td class="cb-mob">${esc(a.name)}<span class="dim">${RAID_TAG[a.who] || ""}</span></td>` +
      `<td>${(a.dmg / rt.total * 100).toFixed(0)}%</td><td class="cb-dmg">${fmtN(a.dmg)}</td>` +
      `<td>${fmtN(a.dmg / secs)}</td><td>${a.hits}</td><td>${fmtN(a.max)}</td><td>${a.crit || "—"}</td></tr>`;
    if (CB.raidSel === a.name) {
      const srcs = a.sources.map(s =>
        `<tr><td>${esc(s.name)}</td><td>${s.hits}</td><td class="cb-dmg">${fmtN(s.dmg)}</td><td>${fmtN(s.max)}</td><td>${s.crit || "—"}</td></tr>`).join("");
      h += `<tr class="cbd"><td colspan="7"><table class="cbt-sub"><thead><tr><th>Source</th><th>Hits</th><th>Damage</th><th>Max</th><th>Crits</th></tr></thead><tbody>${srcs}</tbody></table></td></tr>`;
    }
  }
  return h + "</tbody></table>";
}

/* Overlay payload — pre-resolved like every other feed:* relay; the overlay
   holds no engine. Encounters, newest first: frozen visits from encHist plus
   the live visit's groups, with the full drill-down detail on each so the
   overlay can expand a fight without asking anything back. Pushed only when
   the numbers changed. */
const CB_OVERLAY_ENCS = 8;
function encounterRows() {
  const rows = CB.encHist.slice();
  if (CB.run) for (const g of encounterize(CB.run.seg.fights)) {
    const row = encRow(g, CB.run);
    row.live = g; // live rows keep their group so detail computes on demand
    rows.push(row);
  }
  // a reset means start over, so pulls that ended before the stamp are gone
  // from the list too — not just out of the meter
  const z = CB.raidZero;
  return rows.filter(r => !z || +r.ts + r.secs * 1000 >= z).sort((a, b) => b.ts - a.ts);
}
let lastStatsJson = "";
function pushStats() {
  if (!CB.session) return;
  const { a, kills } = CB.session;
  const visit = CB.run.seg.visits[CB.run.seg.visits.length - 1] || null;
  // detail and the raid table are computed only while the overlay can see
  // them; opening the overlay re-pushes (renderOverlayState), so a hidden
  // overlay costs one cheap summary per tick instead of analyze() passes
  const encs = encounterRows().slice(0, CB_OVERLAY_ENCS);
  if (OVERLAY_SHOWN)
    for (const row of encs) if (!row.detail && row.live) {
      const c = encCached(row, row.live, CB.run);
      row.detail = c.detail; row.raid = c.raid;
    }
  const p = {
    raid: OVERLAY_SHOWN ? raidWindowTable(CB.run, effRaidWin(CB.run)) : null,
    wins: OVERLAY_SHOWN ? raidRungs(CB.run) : [],
    allLabel: OVERLAY_SHOWN ? raidAllLabel(CB.run) : "all",
    zero: !!CB.raidZero,
    session: {
      zone: visit ? visit.name : null,
      mins: Math.round(a.activeSecs / 60),
      dmg: a.total,
      dps: a.combatSec >= 5 ? Math.round(a.total / a.combatSec) : null,
      kills, xp: Math.round(a.xp * 10) / 10,
      kph: a.activeSecs >= 120 ? Math.round(kills / (a.activeSecs / 3600)) : null,
      xph: a.activeSecs >= 120 ? Math.round(a.xp / (a.activeSecs / 3600) * 10) / 10 : null,
      taken: a.taken.dmg,
      coin: a.copper || 0,
    },
    fights: encs.map(r => ({
      key: r.key, mobs: r.mobs, secs: r.secs, dmg: r.total,
      dps: Math.round(r.total / r.secs), taken: r.taken,
      xp: r.xp, coin: r.coin, kills: r.kills, team: r.team,
      detail: r.detail, raid: r.raid,
    })),
  };
  const j = JSON.stringify(p);
  if (j !== lastStatsJson) { lastStatsJson = j; window.companion.sendStats(p); }
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

/* eqclient.ini's Log key. Reports what the FILE says, never what we asked it
   to say: the game rewrites this file on exit, so a write made while it is
   running is discarded, and a button that claimed success anyway would be
   worse than no button. `running` is null off Windows — an unknown, and the
   copy says so rather than picking an answer. */
async function renderEqConfig(state) {
  const st = state || await window.companion.getEqConfig();
  const label = $("setIniState"), btn = $("btnEnableLog");
  if (st.error) { label.textContent = st.error; btn.hidden = false; return; }
  if (!st.ini) {
    label.textContent = LOGSTATUS.logDir
      ? "No eqclient.ini beside the Logs folder — set the log folder to the game's own Logs directory."
      : "Set the log folder first.";
    btn.hidden = true;
    return;
  }
  const on = st.log === "1";
  btn.hidden = on;
  btn.textContent = "Turn logging on";
  // The paragraph below this line already explains the closed-game rule, so
  // only the DETECTED case adds anything here.
  label.innerHTML = on
    ? `Logging is <b>on</b> (<code>Log=1</code>).`
    : `Logging is <b>off</b> — the game is writing no log.` +
      (st.running === true ? ` <b>Close the game first</b>: it rewrites this file on exit.` : "");
}

function renderData() {
  const rows = [];
  const one = (label, d, src) => {
    if (!d) return rows.push(`<p>${label}: <b>missing</b> — refresh below once the site ships it.</p>`);
    // sky.json states its wiki page rather than a build date — print what the
    // file actually carries instead of a bare "?"
    const upd = d.meta && (d.meta.updated || d.meta.generated);
    rows.push(`<p>${label}: ${src}${upd ? ` · updated ${esc(String(upd))}` : ""}</p>`);
  };
  one(`Mob roster (${DATA ? Object.keys(DATA.zones).length + " zones" : "—"})`, DATA, SOURCES.kills);
  one(`Quest items (${QDATA ? QDATA.quests.length + " quests, " + Object.keys(QDATA.items).length + " items" : "—"})`, QDATA, SOURCES.quests);
  one(`Item tooltips (${TDATA ? Object.keys(TDATA.items).length + " items" : "—"})`, TDATA, SOURCES.tooltips);
  one(`Gear (${GDATA ? Object.keys(GDATA.items).length + " items" : "—"})`, GDATA, SOURCES.gear);
  one(`Plane of Sky (${SKYD ? Object.keys(SKYD.classes).length + " classes" : "—"})`, SKYD, SOURCES.sky);
  $("dataStatus").innerHTML = rows.join("");
}

/* ── EQ item tooltip ──────────────────────────────────────────────────────
   The wiki's statsblock is literally the in-game item-display text, one line
   per row — render it as-is under the item name. Anything carrying data-tt
   gets one on hover when the tooltip dataset knows the name. */
const FLAGS_RX = /^[A-Z][A-Z0-9 *'&-]+$/; // all-caps flag rows: MAGIC ITEM LORE ITEM…
let tipEl = null, MX = 0, MY = 0;
function showTip(e) {
  tipEl.innerHTML = `<div class="tt__name">${esc(e.n)}</div>` +
    e.sb.map(l => `<div class="${FLAGS_RX.test(l) ? "tt__flags" : "tt__line"}">${esc(l)}</div>`).join("");
  tipEl.hidden = false;
  moveTip();
}
// Live lists re-render and shift under the cursor constantly (a new feed
// event replaces the DOM the mouse was over — Kyle saw tooltips "pop up
// briefly"). retip() re-derives the tooltip from whatever is under the
// cursor NOW; renders and scrolls call it instead of blindly hiding.
function retip() {
  if (!tipEl) return;
  const el = document.elementFromPoint(MX, MY);
  const t = el && el.closest ? el.closest("[data-tt]") : null;
  if (t && t.dataset.exalt != null) { showExaltTip(t.dataset.tt, +t.dataset.exalt || 0); return; }
  const e = t && lookupItem(TIDX, t.dataset.tt); // "+N"/"*" decorated names resolve too
  if (e) showTip(e); else tipEl.hidden = true;
}

/* An exaltation stone is NOT the item it is named after, and the ordinary
   tooltip path says it is: lookupItem() strips "(Exaltation)" along with "+N"
   and "*", so hovering "Shining Metallic Robes (Exaltation)" was drawing the
   robe's full stat block — AC, HP, the lot. A stone carries exactly ONE
   property of its source item, decided by the socket it sits in (the wiki's
   "Exaltations" page; vendor/exalt-slots.js maps the socket number to the
   type). Socket 0 means a loose stone in the Augmentation bin, where nothing
   has told us which of the source item's properties it holds — so every
   transferable one is listed and none is claimed. */
function showExaltTip(name, socketN) {
  const src = stripDecor(name);
  const rec = gearFor(src);
  const X = window.EQLExalt;
  const lines = [];
  if (socketN) {
    const d = X.describe(rec, socketN, src);
    lines.push([d.title, d.body]);
  } else {
    for (const r of X.describeLoose(rec, src)) lines.push([r.label, r.text]);
    if (!lines.length) lines.push(["", `Rendered from ${src}. The wiki records no transferable effect on it.`]);
  }
  tipEl.innerHTML = `<div class="tt__name">${esc(name)}</div>`
    + `<div class="tt__flags">EXALTATION</div>`
    + lines.map(([k, v]) => `<div class="tt__line">${k ? `<b>${esc(k)}</b> — ` : ""}${esc(v)}</div>`).join("")
    + `<div class="tt__line tt__dim">Carries one property of ${esc(src)}, not its stats.</div>`;
  tipEl.hidden = false;
  moveTip();
}
function initTip() {
  tipEl = document.createElement("div");
  tipEl.id = "eqtip"; tipEl.hidden = true;
  document.body.appendChild(tipEl);
  document.addEventListener("mousemove", ev => { MX = ev.clientX; MY = ev.clientY; if (!tipEl.hidden) moveTip(); });
  document.addEventListener("mouseover", ev => { MX = ev.clientX; MY = ev.clientY; retip(); });
  document.addEventListener("scroll", retip, true);
}
function moveTip() {
  const pad = 14, r = tipEl.getBoundingClientRect();
  let x = MX + pad, y = MY + pad;
  if (x + r.width > innerWidth - 8) x = Math.max(8, MX - r.width - pad);
  if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
  tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
}

/* ── updater ──────────────────────────────────────────────────────────────*/
function renderUpdate(u) {
  const banner = $("updBanner"), act = $("updAct");
  const doAct = () => u.status === "ready" ? window.companion.installUpdate() : window.companion.openReleases();
  const msg = {
    downloading: [`Downloading update ${u.version || ""}…`, null],
    ready: [`Update ${u.version} is ready.`, "Install and restart"],
    manual: [`Version ${u.version} is out.`, "Open download page"],
  }[u.status];
  banner.hidden = !msg || !msg[1]; // only bother the player when there's an action
  if (msg) { $("updText").textContent = msg[0]; act.textContent = msg[1] || ""; }
  act.onclick = doAct;
  $("updStatus").textContent = {
    idle: "Automatic — checks every few hours.",
    dev: "Dev builds don't update.",
    checking: "Checking…",
    downloading: `Downloading ${u.version || "update"}…`,
    ready: `Update ${u.version} downloaded — restarts into it.`,
    manual: `Version ${u.version} is out — this install type updates by re-downloading.`,
    current: "Up to date.",
    error: `Update check failed: ${u.detail || "unknown"}`,
  }[u.status] || "—";
  // the settings-page controls mirror the banner's action
  $("btnUpdCheck").disabled = u.status === "checking" || u.status === "downloading" || u.status === "dev";
  const sAct = $("btnUpdAct");
  sAct.hidden = !msg || !msg[1];
  if (msg && msg[1]) sAct.textContent = msg[1];
  sAct.onclick = doAct;
}

/* Which tabs the overlay carries. Kyle, 2026-08-13: "what tabs/features a
   person wants/doesn't want. the widget could be small and having too many tabs
   may be clutter." The last ticked box is disabled — an overlay with no tabs
   can show nothing, and unticking it would look like the app broke. */
const OV_VIEW_LABEL = { tracked: "Tracked", loot: "Loot", stats: "Parser", sky: "Sky", valet: "Valet", spare: "Spare", exalt: "Exalt" };
function renderOverlayViews(prefs) {
  const all = prefs.all || Object.keys(OV_VIEW_LABEL);
  const on = prefs.views || all;
  $("setOvViews").innerHTML = `<span class="dim">Tabs</span> ` + all.map(v =>
    `<label class="chk"><input type="checkbox" data-ovview="${v}"${on.includes(v) ? " checked" : ""}` +
    `${on.length === 1 && on.includes(v) ? " disabled" : ""}> ${esc(OV_VIEW_LABEL[v] || v)}</label>`).join(" ");
}

function renderOverlayState(o) {
  // the stats drill-down is computed only while the overlay can see it; a
  // fresh open re-pushes so the window never seeds from a detail-less payload
  const wasShown = OVERLAY_SHOWN;
  OVERLAY_SHOWN = !!o.shown;
  if (OVERLAY_SHOWN && !wasShown) { lastStatsJson = ""; pushStats(); }
  $("btnOverlay").textContent = o.shown ? "Hide overlay" : "Overlay";
  $("btnOverlay2").textContent = o.shown ? "Hide overlay" : "Show overlay";
  $("setClickThrough").checked = o.clickThrough;
  $("setOpacity").value = o.opacity;
  if (o.prefs) {
    $("setOvScale").value = o.prefs.fontScale;
    $("setOvKills").checked = o.prefs.showKills;
    $("setOvQuestOnly").checked = o.prefs.questOnly;
    renderOverlayViews(o.prefs);
    // the meter's window is the widget's to set too, and this renderer is what
    // computes it, so it comes back through here. (The widget's sub-view is not
    // here on purpose: both sub-views ride one payload, so switching costs no
    // round-trip and main only has to persist it.)
    const win = +o.prefs.statsWindow || 0;
    if (win !== CB.raidWin) { CB.raidWin = win; renderCombat(); lastStatsJson = ""; pushStats(); }
  }
}

/* ── wiring ───────────────────────────────────────────────────────────────*/
async function main() {
  const init = await window.companion.init();
  buildIndexes(init.datasets);
  STATE = K.load();
  loadTracked();
  loadHeld();
  loadSkyPrefs();
  for (const b of document.querySelectorAll("[data-trackview]"))
    b.classList.toggle("is-on", b.dataset.trackview === TRACK_VIEW);
  // Kills an older matching rule filed as unmatched (the site's /kills page
  // does the same migration on load).
  if (STATE && K.reclassify(STATE, NAMEZONES)) K.save(STATE);
  LOGSTATUS.logDir = init.settings.logDir;
  renderOverlayState(init.overlay);
  $("verLine").textContent = `EQL Tools Companion ${init.version} — data © eqlwiki (CC BY-SA 4.0), served by eqltools.com. Logs are read locally and never leave this machine.`;

  const s = (STATE || K.blank()).settings;
  $("setCities").checked = s.ignoreCities;
  $("setGeneric").checked = s.genericEverywhere;
  $("setWitnessed").checked = s.witnessed;

  loadViews();
  renderStatus(); renderFeed(); renderData();
  populateZoneSel(); renderZoneTab(); populateQuestFilters(); populateInvFilters(); renderQuests();
  populateSkyFilters(); renderSky(); initTip();
  parserTabActive(true); // Parser is the tab the app opens on
  wireValet(); valetReload(); renderValet(); pushValet(); pushSpare();

  window.companion.onBootstrap(onBootstrap);
  window.companion.onLines(onLines);
  window.companion.onLogStatus(st => { LOGSTATUS = st; renderStatus(); });
  window.companion.onInvFile(onInvFile);
  window.companion.onInvStatus(onInvStatus);
  window.companion.onAchFile(onAchFile);
  window.companion.onAchStatus(onAchStatus);
  window.companion.onDataUpdated(d => { buildIndexes(d); if (STATE && K.reclassify(STATE, NAMEZONES)) K.save(STATE); renderTracker(); renderData(); populateZoneSel(); renderZoneTab(); populateInvFilters(); valetReload(); renderInv(); populateQuestFilters(); renderQuests(); populateSkyFilters(); renderSky(); pushZone(); pushQuests(); pushSky(); renderValet(); pushValet(); pushSpare(); });
  window.companion.onOverlayState(renderOverlayState);
  window.companion.onUpdate(renderUpdate);
  renderUpdate(await window.companion.getUpdate());
  window.companion.ready(); // listeners live — main may start tailing now
  pushQuests(); // a fresh overlay shouldn't wait for the next loot to learn the tracked list
  pushSky();

  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll(".pane").forEach(p => p.classList.toggle("on", p.id === "tab-" + b.dataset.tab));
    parserTabActive(b.dataset.tab === "parser");
  }));

  /* The Parser tab is the site's report in the app's window. render.js draws
     it; this wiring says which slice, and routes the clicks it makes back
     through one redraw so the selects and the panels can never disagree. */
  EQLLogView.config({
    dataBase: "eqlt://app/log-parser/data/",
    onRerender: () => { if (PR.run) EQLLogView.render(PR.run, prSel()); },
    onFocusFight: (fid) => { PR.fight = fid; renderParser(); },
  });
  $("cbViews").addEventListener("click", e => {
    const b = e.target.closest("[data-lpview]");
    if (!b || b.dataset.lpview === PR.view) return;
    PR.view = b.dataset.lpview;
    paintParserView();
    if (PR.view === "damage") renderCombat(); // the meter redraws on view, not on a timer it can't see
  });
  $("cbScope").addEventListener("change", e => {
    PR.sess = e.target.value === "*" ? null : +e.target.value;
    PR.fight = "*";               // a fight from another session isn't in this slice
    renderParser();
  });
  $("cbFight").addEventListener("change", e => { PR.fight = e.target.value; renderParser(); });
  $("cbCopy").addEventListener("click", async () => {
    if (!PR.run) return;
    try {
      await navigator.clipboard.writeText(EQLLogView.summary(PR.run, prSel()));
      const b = $("cbCopy"); b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy summary"; }, 1500);
    } catch {}
  });

  // sub-tab strips: Inventory (bags | recent loot) and Quests (turn-ins |
  // tracked | all). Same shape, so one helper wires both.
  const wireViews = (stripId, attr, paint) => $(stripId).addEventListener("click", e => {
    const b = e.target.closest("[data-" + attr + "]");
    if (!b) return;
    paint(b.dataset[attr]);
  });
  wireViews("invViews", "invview", v => setInvView(v));
  wireViews("qViews", "qview", v => setQuestView(v));

  $("onlyQuest").addEventListener("change", renderFeed);
  $("feedFilter").addEventListener("input", renderFeed);
  $("invQuestOnly").addEventListener("change", renderInv);
  $("invSearch").addEventListener("input", renderInv);
  $("invTrade").addEventListener("change", e => { IV.trade = e.target.value; renderInv(); });
  $("invClass").addEventListener("change", e => { IV.cls = e.target.value; renderInv(); });
  loadInvCols(); renderInvColPicker();
  $("invColsBody").addEventListener("change", e => {
    const k = e.target.dataset.ivcol;
    if (!k) return;
    syncInvCols();
    e.target.checked ? IV_SHOW.add(k) : IV_SHOW.delete(k);
    saveInvCols(); renderInv();
  });
  // click-away closes the picker; clicks inside it stay in it
  document.addEventListener("click", e => {
    const w = $("invColsWrap");
    if (w && w.open && !w.contains(e.target)) w.open = false;
  });
  // "I have this" — every component row, wherever it renders
  document.addEventListener("click", e => {
    const h = e.target.closest("[data-hold]");
    if (h) { e.stopPropagation(); toggleHeld(h.dataset.hold, +h.dataset.want || 1); }
  });
  window.companion.onMarkHeld(n => toggleHeld(n, 1));
  window.companion.onStatsReset(on => on ? raidResetNow() : setRaidZero(null));
  /* Unlocks tab */
  try { Object.assign(UNL, JSON.parse(localStorage.getItem(UNL_KEY)) || {}); } catch { /* defaults */ }
  const saveUnl = () => { try { localStorage.setItem(UNL_KEY, JSON.stringify(UNL)); } catch { /* full */ } };
  document.querySelectorAll("[data-unlview]").forEach(b => b.addEventListener("click", () => {
    UNL.view = b.dataset.unlview; saveUnl();
    document.querySelectorAll("[data-unlview]").forEach(x => x.classList.toggle("is-on", x === b));
    renderUnlocks();
  }));
  $("unlSearch").addEventListener("input", e => { UNL.q = e.target.value; renderUnlocks(); });
  $("unlHideDone").addEventListener("change", e => { UNL.hideDone = e.target.checked; saveUnl(); renderUnlocks(); });
  $("unlPick").addEventListener("click", async () => {
    const r = await window.companion.pickAchFile();
    if (!r) return;
    if (r.error) { const b = $("unlBanner"); b.hidden = false; b.textContent = r.error; return; }
    onAchFile(r);
  });
  document.querySelectorAll("[data-unlview]").forEach(x => x.classList.toggle("is-on", x.dataset.unlview === UNL.view));
  $("unlSearch").value = UNL.q || "";
  $("unlHideDone").checked = !!UNL.hideDone;
  renderUnlocks();

  $("skySearch").addEventListener("input", renderSky);
  $("skyBody").addEventListener("contextmenu", e => {
    const li = e.target.closest("li[data-drop]");
    if (!li || !SKY_DROPS.has(li.dataset.drop)) return;
    e.preventDefault();
    skyOpenMenu(li, e.clientX, e.clientY);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") skyCloseMenu(); });
  window.addEventListener("blur", skyCloseMenu);
  $("skyShow").addEventListener("change", e => { SKYP.show = e.target.value; saveSkyPrefs(); renderSky(); });
  $("skyClass").addEventListener("change", e => { SKYP.cls = e.target.value; saveSkyPrefs(); renderSky(); });
  $("skyHideDone").addEventListener("change", e => { SKYP.hideDone = e.target.checked; saveSkyPrefs(); renderSky(); });
  $("skyOnlyNeed").addEventListener("change", e => { SKYP.onlyNeed = e.target.checked; saveSkyPrefs(); renderSky(); });
  $("skyView").addEventListener("click", e => {
    const b = e.target.closest("[data-skyview]");
    if (!b || b.dataset.skyview === SKYP.view) return;
    SKYP.view = b.dataset.skyview;
    saveSkyPrefs(); paintSkyView(); renderSky();
  });
  /* Get rid of it: the two controls, the two sortable tables, and "uses". Every
     one of them only reshapes this view, so none of them re-push the widget. */
  loadSkyDropPrefs();
  $("skyBody").addEventListener("change", e => {
    const k = e.target.dataset.skd;
    if (!k) return;
    SKD[k] = k === "top" ? (parseInt(e.target.value, 10) || 3) : e.target.checked;
    saveSkyDropPrefs(); renderSky();
  });
  $("skyBody").addEventListener("click", e => {
    const s = e.target.closest("[data-skdtsort]");
    if (s) {
      const k = s.dataset.skdtsort, c = SKD_TCOLS.find(x => x.k === k);
      SKD.dir = SKD.sort === k ? -SKD.dir : (c ? c.d0 : -1);
      SKD.sort = k; saveSkyDropPrefs(); renderSky(); return;
    }
    const cs = e.target.closest("[data-skdcsort]");
    if (cs) {
      const k = cs.dataset.skdcsort, c = SKD_CCOLS.find(x => x.k === k);
      SKD.cdir = SKD.csort === k ? -SKD.cdir : (c ? c.d0 : 1);
      SKD.csort = k; saveSkyDropPrefs(); renderSky(); return;
    }
    // the same per-test skip menu the boss board's right-click opens
    const d = e.target.closest("button.skd__u");
    if (d) { e.stopPropagation(); skyOpenMenu(d, e.clientX, e.clientY); }
  });
  $("skyExpand").addEventListener("click", () => {
    const anyOpen = !!document.querySelector(".skg__h[aria-expanded=true]");
    if (SKYP.view === "boss") {
      SKYP.openBoss = anyOpen ? [] : [...document.querySelectorAll("[data-skyboss]")]
        .map(b => b.dataset.skyboss);
    } else {
      SKYP.open = anyOpen ? [] : Object.keys(SKY_CLASS);
    }
    saveSkyPrefs(); renderSky();
  });
  // widget options — every one of them reshapes the payload, so each writes
  // through and re-pushes
  $("skyWidBody").addEventListener("change", e => {
    const k = e.target.dataset.skyw, c = e.target.dataset.skywcls;
    if (k) SKYP.wid[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    else if (c) {
      const on = new Set(SKYP.wid.cls);
      e.target.checked ? on.add(c) : on.delete(c);
      SKYP.wid.cls = [...on];
    } else return;
    saveSkyPrefs(); renderSkyWidget(); pushSky();
  });
  $("skyWidBody").addEventListener("click", e => {
    const b = e.target.closest("[data-skywall]");
    if (!b) return;
    SKYP.wid.cls = b.dataset.skywall === "1" ? Object.keys(SKY_CLASS) : [];
    saveSkyPrefs(); renderSkyWidget(); pushSky();
  });
  $("zoneFilter").addEventListener("input", renderZoneTab);
  $("tiSearch").addEventListener("input", e => { TURNIN.q = e.target.value; renderTurnins(); });
  $("qReadyOnly").addEventListener("change", e => { TURNIN.readyOnly = e.target.checked; renderTurnins(); });
  $("qSearch").addEventListener("input", e => { QB.q = e.target.value; renderQuestBrowser(); });
  $("qbClass").addEventListener("change", e => { QB.cls = e.target.value; renderQuestBrowser(); });
  $("qbZone").addEventListener("change", e => { QB.zone = e.target.value; renderQuestBrowser(); });
  $("qbEra").addEventListener("change", e => { QB.era = e.target.value; renderQuestBrowser(); });
  $("qbLvlMin").addEventListener("input", e => { QB.lvlMin = e.target.value; renderQuestBrowser(); });
  $("qbLvlMax").addEventListener("input", e => { QB.lvlMax = e.target.value; renderQuestBrowser(); });
  $("trkAtlas").addEventListener("click", () => {
    // Land on the player's zone with the atlas sidebar open on KILLS; the
    // atlas root otherwise.
    const key = stream && stream.zone !== "?" && DATA && DATA.zones[stream.zone] ? stream.zone : ZONE.sel;
    window.companion.openWiki(key
      ? `https://eqltools.com/atlas/?zone=${encodeURIComponent(key)}&wb=1&wbt=kills`
      : "https://eqltools.com/atlas/");
  });
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
  $("btnOvReset").addEventListener("click", () => window.companion.resetOverlayPlacement());
  $("setClickThrough").addEventListener("change", e => window.companion.setClickThrough(e.target.checked));
  $("setOpacity").addEventListener("input", e => window.companion.setOverlayOpacity(+e.target.value));
  $("setOvScale").addEventListener("input", e => window.companion.setOverlayPrefs({ fontScale: +e.target.value }));
  $("setOvKills").addEventListener("change", e => window.companion.setOverlayPrefs({ showKills: e.target.checked }));
  $("setOvQuestOnly").addEventListener("change", e => window.companion.setOverlayPrefs({ questOnly: e.target.checked }));
  $("setOvViews").addEventListener("change", e => {
    if (!e.target.dataset.ovview) return;
    const views = [...document.querySelectorAll("[data-ovview]")]
      .filter(b => b.checked).map(b => b.dataset.ovview);
    window.companion.setOverlayPrefs({ views });   // main echoes the accepted list back
  });
  $("btnPickDir").addEventListener("click", async () => { LOGSTATUS.logDir = await window.companion.pickLogDir(); renderStatus(); renderEqConfig(); });
  $("btnEnableLog").addEventListener("click", async () => renderEqConfig(await window.companion.enableGameLog()));
  renderEqConfig();
  $("btnRefresh").addEventListener("click", async () => {
    $("btnRefresh").disabled = true;
    buildIndexes(await window.companion.refreshData());
    $("btnRefresh").disabled = false;
    renderTracker(); renderData(); pushZone();
  });
  // fire and forget — every state change streams back through update:state
  $("btnUpdCheck").addEventListener("click", () => window.companion.checkUpdate());

  const setSetting = (k, v) => { if (!STATE) STATE = K.blank(); STATE.settings[k] = v; K.save(STATE); renderTracker(); pushZone(); };
  $("setCities").addEventListener("change", e => setSetting("ignoreCities", e.target.checked));
  $("setGeneric").addEventListener("change", e => setSetting("genericEverywhere", e.target.checked));
  $("setWitnessed").addEventListener("change", e => setSetting("witnessed", e.target.checked));
  $("btnReset").addEventListener("click", () => {
    if (!confirm("Forget every tracked kill and start over?")) return;
    K.clear(); STATE = null; renderTracker(); pushZone();
  });

  document.addEventListener("click", e => {
    // window chips and sort headers sit in/under the meter's own header line,
    // so both have to win before the toggle collapses the table under them
    const rr = e.target.closest("[data-raidreset]");
    if (rr) { rr.dataset.raidreset === "1" ? raidResetNow() : setRaidZero(null); return; }
    const rw = e.target.closest("[data-raidwin]");
    if (rw) { setRaidWin(+rw.dataset.raidwin); return; }
    const rs = e.target.closest("[data-raidsort]");
    if (rs) {
      const k = rs.dataset.raidsort;
      if (CB.raidSort === k) CB.raidDir = -CB.raidDir; else { CB.raidSort = k; CB.raidDir = k === "name" ? -1 : 1; }
      renderCombat(); return;
    }
    const rt = e.target.closest("[data-raidtoggle]");
    if (rt) { CB.raidOpen = !CB.raidOpen; renderCombat(); return; }
    const ra = e.target.closest("[data-raidactor]");
    if (ra) { CB.raidSel = CB.raidSel === ra.dataset.raidactor ? null : ra.dataset.raidactor; renderCombat(); return; }
    const tk = e.target.closest("[data-track]");
    if (tk) { toggleTrack(tk.dataset.track); return; }
    const tv = e.target.closest("[data-trackview]");
    if (tv) { setTrackView(tv.dataset.trackview); return; }
    const pt = e.target.closest("[data-parts]");
    if (pt) {
      const t = pt.dataset.parts;
      QPARTS_OPEN.has(t) ? QPARTS_OPEN.delete(t) : QPARTS_OPEN.add(t);
      renderQuests(); return;
    }
    const stp = e.target.closest("[data-steps]");
    if (stp) {
      const t = stp.dataset.steps;
      QSTEPS_OPEN.has(t) ? QSTEPS_OPEN.delete(t) : QSTEPS_OPEN.add(t);
      renderQuests(); return;
    }
    const sh = e.target.closest("[data-qsort]");
    if (sh) {
      const k = sh.dataset.qsort;
      if (QB.sort === k) QB.dir = -QB.dir; else { QB.sort = k; QB.dir = 1; }
      renderQuestBrowser(); return;
    }
    const ivt = e.target.closest("[data-ivtab]");
    if (ivt) { IV.tab = ivt.dataset.ivtab; renderInv(); return; }
    const ivs = e.target.closest("[data-ivsort]");
    if (ivs) {
      const k = ivs.dataset.ivsort, c = IV_COLS.find(x => x.k === k), st = IV_SORT[invMode()];
      if (st.k === k) st.d = -st.d; else { st.k = k; st.d = (c && c.d0) || 1; }
      renderInv(); return;
    }
    const mo = e.target.closest("[data-open]");
    if (mo) { FEED_OPEN.add(+mo.dataset.open); renderFeed(); renderInv(); return; }
    const u = e.target.closest("[data-url]");
    if (u && u.dataset.url) { window.companion.openWiki(u.dataset.url); return; }
    const w = e.target.closest("[data-wiki]");
    const base = (DATA && DATA.base) || (QDATA && QDATA.base);
    if (w && base) { window.companion.openWiki(base + w.dataset.wiki); return; }
    // anywhere else on an inventory row toggles its detail (links handled above)
    const ivr = e.target.closest("tr.ivr");
    if (ivr) {
      const id = +ivr.dataset.ivx;
      IV_OPEN.has(id) ? IV_OPEN.delete(id) : IV_OPEN.add(id);
      renderInv(); return;
    }
    // anywhere else on a browser row toggles its detail (links handled above)
    const qr = e.target.closest("tr.qbr");
    if (qr) {
      const t = qr.dataset.qx;
      QEXPANDED.has(t) ? QEXPANDED.delete(t) : QEXPANDED.add(t);
      renderQuestBrowser(); return;
    }
    const str = e.target.closest("[data-skytrack]");
    if (str) { skyToggleTrack(str.dataset.skytrack, str.dataset.test); return; }
    const ssk = e.target.closest("[data-skyskip]");
    if (ssk) {
      skyCloseMenu();
      skyToggleSkip(ssk.dataset.skyskip, ssk.dataset.test, !skySkipped(ssk.dataset.skyskip, ssk.dataset.test));
      return;
    }
    const sall = e.target.closest("[data-skyskipall]");
    if (sall) {
      const uses = SKY_DROPS.get(sall.dataset.skyskipall) || [];
      const on = !uses.every(u => u.skip);
      skyCloseMenu();
      for (const u of uses) {
        if (on) SKYP.skipped[skyMark(u.code, u.test)] = true;
        else delete SKYP.skipped[skyMark(u.code, u.test)];
      }
      saveSkyPrefs(); renderSkySoon();
      return;
    }
    if (SKY_MENU && !e.target.closest(".skmenu")) skyCloseMenu();
    const sx = e.target.closest("[data-skyexp]");
    if (sx) { skyExpandDrop(sx); return; }
    const sg = e.target.closest("[data-skyclass]");
    if (sg) {
      const c = sg.dataset.skyclass;
      // first click freezes whatever the auto-open rule was showing, so one
      // fold closing doesn't reshuffle the other fifteen
      if (!SKYP.open) SKYP.open = [...document.querySelectorAll(".skg__h[aria-expanded=true]")].map(b => b.dataset.skyclass);
      SKYP.open = SKYP.open.includes(c) ? SKYP.open.filter(x => x !== c) : SKYP.open.concat(c);
      saveSkyPrefs(); renderSky(); return;
    }
    const sb = e.target.closest("[data-skyboss]");
    if (sb) {
      const k = sb.dataset.skyboss;
      if (!SKYP.openBoss) SKYP.openBoss = [...document.querySelectorAll(".skg__h[aria-expanded=true]")].map(b => b.dataset.skyboss).filter(Boolean);
      SKYP.openBoss = SKYP.openBoss.includes(k) ? SKYP.openBoss.filter(x => x !== k) : SKYP.openBoss.concat(k);
      saveSkyPrefs(); renderSky(); return;
    }
    const zh = e.target.closest("[data-zone]");
    if (zh) { const k = zh.dataset.zone; EXPANDED.has(k) ? EXPANDED.delete(k) : EXPANDED.add(k); renderTracker(); }
  });
}
main();
