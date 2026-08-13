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
let TRACKER_Q = "";
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
  const q = TRACKER_Q.trim().toLowerCase();
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
const INV = { file: null, mtime: 0, rows: null, problem: null };
const IV = { tab: "all", trade: "", cls: "", sort: "where", dir: 1 };
const IV_OPEN = new Set(); // expanded rows, keyed by row id
const WORN_RX = /^(Charm|Ear|Head|Face|Neck|Shoulders|Arms|Back|Wrist|Range|Hands|Primary|Secondary|Fingers?|Ring|Chest|Legs|Feet|Waist|Ammo|Power Source)(-Slot\d+)?$/;
/* The client writes "General 1" WITH a space but "Bank1" without — matchers
   take an optional space so a format nudge doesn't reclassify. No real dump
   with the Dragon's Hoard open has been captured yet, so its location string
   is unconfirmed — the prefix matcher is deliberately loose, and any location
   nothing matches lands in Elsewhere instead of vanishing. */
const INV_SECTIONS = [
  ["worn", "Worn", loc => WORN_RX.test(loc)],
  ["bags", "Bags", loc => /^(General ?\d+|Held$|Any Slot$)/.test(loc)],
  ["bank", "Bank", loc => /^Bank ?\d+/.test(loc)],
  ["shared", "Shared bank", loc => /^SharedBank/.test(loc)],
  ["depot", "Depot", loc => /^Personal-Depot/.test(loc)],
  ["hoard", "Dragon's hoard", loc => /^Dragon/i.test(loc)],
  ["keyring", "Key ring", loc => /^KeyRing/.test(loc)],
  ["other", "Elsewhere", () => true],
];
const invSection = loc => INV_SECTIONS.find(([, , test]) => test(loc))[0];

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
  INV.rows = parseInventory(text);
  LIVE_HAVE = new Map(); // the dump holds everything looted before it
  renderInv(); renderQuests(); pushQuests(); renderSky(); pushSky();
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

/* Every column the data can fill exists; WHICH show is the player's call
   (the columns picker, persisted). Defaults are the quest-ID job — where,
   what, how many, which quests — not a stat sheet. */
const IV_COLS = [
  { k: "where", h: "Where", d0: 1, key: v => v.r.idx, cell: v => `<td class="iv-where">${esc(v.r.loc)}</td>` },
  { k: "item", h: "Item", d0: 1, always: true, key: v => v.r.name.toLowerCase(), cell: v => {
    // the name already prints "+N" and "(Exaltation)" — no chips restating it
    const badges = (v.r.kids ? `<span class="ivb">${v.r.kids.length} inside</span>` : "") +
      (v.vars ? `<span class="ivb" title="the wiki lists ${v.vars.length} items with this name — the columns show the first; open the row for all of them">${v.vars.length} variants</span>` : "");
    return `<td class="iv-item">${itemSpan(v.r.name, true)}${badges}</td>`;
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
];
const IV_DEFAULT_COLS = ["where", "item", "qty", "quests"];
const IV_COLS_KEY = "eqlt-companion-invcols-v1";
let IV_SHOW = new Set(IV_DEFAULT_COLS);
function loadInvCols() {
  try {
    const a = JSON.parse(localStorage.getItem(IV_COLS_KEY));
    if (Array.isArray(a) && a.length) IV_SHOW = new Set(a.filter(k => IV_COLS.some(c => c.k === k)));
  } catch { /* defaults stand */ }
  IV_SHOW.add("item");
}
function saveInvCols() { try { localStorage.setItem(IV_COLS_KEY, JSON.stringify([...IV_SHOW])); } catch {} }
const invVisibleCols = () => IV_COLS.filter(c => IV_SHOW.has(c.k));
function renderInvColPicker() {
  $("invColsBody").innerHTML = IV_COLS.map(c => `<label class="chk invcols__row">
    <input type="checkbox" data-ivcol="${c.k}" ${IV_SHOW.has(c.k) ? "checked" : ""} ${c.always ? "disabled" : ""}> ${c.h}</label>`).join("");
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
  const pool = INV.rows.map(invView).filter(v =>
    (!qOnly || v.quests.length) && tradeOk(v) && clsOk(v) &&
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
  if (!IV_SHOW.has(IV.sort)) { IV.sort = cols[0].k; IV.dir = cols[0].d0; } // hiding the sorted column resets the sort
  const col = IV_COLS.find(c => c.k === IV.sort) || cols[0];
  rows.sort((a, b) => cmpNullLast(col.key(a), col.key(b), IV.dir) || (a.r.idx - b.r.idx));
  // the weight total belongs to the Wt column — hidden column, no stray number
  const wt = IV_SHOW.has("wt") ? rows.reduce((n, v) => n + (v.wt != null ? v.wt * v.r.count : 0), 0) : null;
  $("invMeta").textContent =
    `${INV.file} · dumped ${new Date(INV.mtime).toLocaleString()} · ${rows.length} of ${INV.rows.length} items${wt != null ? ` · ${Math.round(wt * 10) / 10} wt` : ""}`;
  const arrow = k => IV.sort === k ? (IV.dir > 0 ? " ▲" : " ▼") : "";
  body.innerHTML = rows.length
    ? `<table class="qtab ivt"><thead><tr>${cols.map(c =>
        `<th class="is-sort${c.k === "item" ? " iv-item" : ""}" data-ivsort="${c.k}">${c.h}${arrow(c.k)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(v => invRow(v, cols)).join("")}</tbody></table>`
    : `<p class="empty">Nothing matches those filters.</p>`;
  retip();
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
  $("qbMeta").textContent = `${rows.length} of ${QDATA.quests.length} quests`;

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
  const tab = document.querySelector('[data-tab="tracked"]');
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
  // would switch to an empty answer
  const seg = document.querySelector(".seg");
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
  // wid.cls is an explicit list of class codes — [] really means none, so
  // "show me nothing but my trio" and "show me nothing" stay different answers
  wid: { show: "ready", hideDone: true, loc: true, say: true, cls: null },
};
let SKYP = JSON.parse(JSON.stringify(SKY_DEF));
function loadSkyPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(SKY_KEY)) || {};
    SKYP = { ...SKY_DEF, ...o, wid: { ...SKY_DEF.wid, ...(o.wid || {}) } };
    if (SKYP.open !== null && !Array.isArray(SKYP.open)) SKYP.open = null;
  } catch { SKYP = JSON.parse(JSON.stringify(SKY_DEF)); }
  if (!Array.isArray(SKYP.wid.cls)) SKYP.wid.cls = Object.keys(SKY_CLASS);
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
   bag number alone still leaves you opening it and reading. */
const SKY_BAG_SVG = `<svg class="skl__i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 5.5h8.8l-.9 7.4a1 1 0 0 1-1 .9H5.5a1 1 0 0 1-1-.9z"/><path d="M6 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>`;
const SKY_COIN_SVG = `<svg class="skl__i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.9"/></svg>`;
const SKY_LOC_WORD = [
  [/^SharedBank ?(\d+)/, "shared bank"],
  [/^Personal-Depot ?(\d+)?/, "depot"],
  [/^Dragon/i, "hoard"],
  [/^KeyRing/, "key ring"],
  [/^Cursor/, "cursor"],
];
function skyBadge(loc) {
  let m;
  if ((m = /^General ?(\d+)(?:-Slot(\d+))?/.exec(loc)))
    return { kind: "bag", n: +m[1], sub: m[2] ? +m[2] : null,
             title: `Bag ${m[1]}${m[2] ? `, slot ${m[2]}` : ""}` };
  if ((m = /^Bank ?(\d+)(?:-Slot(\d+))?/.exec(loc)))
    return { kind: "bank", n: +m[1], sub: m[2] ? +m[2] : null,
             title: `Bank slot ${m[1]}${m[2] ? `, slot ${m[2]}` : ""}` };
  for (const [rx, word] of SKY_LOC_WORD) if (rx.test(loc)) return { kind: "word", word, title: loc };
  if (WORN_RX.test(loc)) return { kind: "word", word: "worn", title: `Worn — ${loc}` };
  return { kind: "word", word: loc.toLowerCase(), title: loc };
}
/* Dump rows by item, in the order the client wrote them, keyed both raw and
   decoration-stripped like every other lookup here. Built once per model —
   asking each of 95 tests' components to re-scan the whole dump was the same
   work a hundred times over. */
function skyLocIndex() {
  const m = new Map();
  for (const r of INV.rows || []) {
    const b = { ...skyBadge(r.loc), count: r.count };
    for (const k of new Set([itemKey(r.name), itemKey(stripDecor(r.name))]))
      m.set(k, (m.get(k) || []).concat(b));
  }
  return m;
}
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
      const st = SKY.testState(t, done, false, n => skyHave(have, n, locIdx.has(itemKey(n))).n);
      /* Progress on a test means a COMPONENT of it. Runes are generic — one
         Wind Rune Dena feeds seven different tests, so counting it as progress
         listed all seven as started off a single drop. */
      const held = items.filter(i => i.have >= 1).length;
      tot.pieces += items.reduce((a, i) => a + i.have, 0);
      return {
        code, full: t.n, n: t.n.replace(SKY_CLASS[code] + " ", ""),
        say: t.say || "", reward: t.reward || "", items, rune,
        done, ready: st.ready, missing: st.missing.length, held,
        need: items.length + rune.length,
      };
    });
    const nDone = tests.filter(t => t.done > 0).length;
    const nReady = tests.filter(t => t.ready).length;
    const nPartial = tests.filter(t => !t.ready && !t.done && t.held > 0).length;
    tot.tests += tests.length; tot.done += nDone; tot.ready += nReady; tot.partial += nPartial;
    out.push({ code, name: SKY_CLASS[code], giver: c.giver || "", tests, nDone, nReady, nPartial, orphan: comp.orphan });
  }
  return { classes: out, tot };
}

// One rule, both surfaces: "ready" is everything in hand, "held" adds the tests
// you have started, "all" is the other 90 you have not.
function skyKeep(t, show, hideDone) {
  if (hideDone && t.done > 0) return false;
  if (show === "ready") return t.ready || (t.done > 0 && !hideDone && t.missing === 0);
  if (show === "held") return t.ready || t.held > 0 || t.done > 0;
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
  if (t.ready) return `<span class="sk-st sk-st--ready">ready</span>`;
  if (t.done > 0 && t.missing === 0) return `<span class="sk-st sk-st--ready">can repeat</span>`;
  if (t.done > 0) return `<span class="sk-st sk-st--done">turned in</span>`;
  return `<span class="sk-st sk-st--miss">missing ${t.missing}</span>`;
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
  const html = m.classes.map(g => {
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
      g.nDone ? `<b class="sk-n sk-n--done">${g.nDone}</b> turned in` : "",
      g.nPartial ? `${g.nPartial} started` : "",
      `${g.tests.length} tests`,
    ].filter(Boolean).join(" · ");
    const orphan = g.orphan
      ? `<p class="sk-orphan">${g.orphan} completed trade${g.orphan === 1 ? "" : "s"} with ${esc(g.giver)} matched no single test — that is what a turn-in split across two trades looks like.</p>`
      : "";
    const tests = rows.map(t => `<div class="skt${t.ready ? " is-ready" : ""}${t.done ? " is-done" : ""}">
      <div class="skt__h">
        <span class="skt__n">${esc(t.n)}</span>
        ${t.say ? `<span class="skt__say" title="Hail ${esc(g.giver)} and say this">say <code>${esc(t.say)}</code></span>` : ""}
        ${skyStatus(t)}
        ${t.done ? `<span class="skt__done" title="Your log shows ${t.done} turn-in${t.done === 1 ? "" : "s"} of this test">✓${t.done}</span>` : ""}
        <span class="skt__rew">→ ${skyItemSpan(t.reward)}</span>
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
  body.innerHTML = html || `<p class="empty">Nothing matches. Widen <b>show</b>, or clear the search.</p>`;
  meta.textContent = `${m.tot.ready} ready · ${m.tot.done}/${m.tot.tests} turned in · ${m.tot.partial} started · ${shown} shown`;
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
function pushSky(model) {
  const m = model || skyModel();
  if (!m) return;
  const w = SKYP.wid;
  const groups = [];
  for (const g of m.classes) {
    if (!w.cls.includes(g.code)) continue;
    const tests = g.tests.filter(t => skyKeep(t, w.show, w.hideDone)).map(t => ({
      n: t.n, say: w.say ? t.say : "", done: t.done, ready: t.ready, missing: t.missing,
      rew: skyRef(t.reward),
      items: t.rune.map(r => ({ ...skyRef(r.n), n: "Rune " + r.short, have: r.have, need: 1, rune: true, locs: [] }))
        .concat(t.items.map(i => ({
          ...skyRef(i.n), have: i.have, need: i.need, star: i.star,
          isl: i.have >= i.need ? "" : (i.isl ? skyIsle(i.isl) + (i.mob ? " · " + i.mob : "") : ""),
          locs: w.loc ? i.locs.map(b => ({ k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title })) : [],
        }))),
    }));
    if (tests.length) groups.push({ code: g.code, name: g.name, giver: g.giver,
                                    ready: tests.filter(t => t.ready).length, tests });
  }
  const p = { groups, ready: m.tot.ready, tests: m.tot.tests, done: m.tot.done,
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
  $("skyWidBody").innerHTML =
    `<label class="skw__r">Show <select data-skyw="show">
       <option value="ready"${w.show === "ready" ? " selected" : ""}>ready to turn in</option>
       <option value="held"${w.show === "held" ? " selected" : ""}>anything I hold a piece of</option>
       <option value="all"${w.show === "all" ? " selected" : ""}>every test</option>
     </select></label>` +
    `<label class="skw__r"><input type="checkbox" data-skyw="hideDone"${w.hideDone ? " checked" : ""}> hide tests I've turned in</label>` +
    `<label class="skw__r"><input type="checkbox" data-skyw="loc"${w.loc ? " checked" : ""}> show where each piece is</label>` +
    `<label class="skw__r"><input type="checkbox" data-skyw="say"${w.say ? " checked" : ""}> show the hail phrase</label>` +
    `<div class="skw__h">Classes <button type="button" class="lnk" data-skywall="1">all</button> ·
       <button type="button" class="lnk" data-skywall="0">none</button></div>` +
    `<div class="skw__cls">${Object.keys(SKY_CLASS).sort((a, b) => SKY_CLASS[a].localeCompare(SKY_CLASS[b])).map(chip).join("")}</div>`;
}

function populateSkyFilters() {
  const sel = $("skyClass");
  sel.innerHTML = `<option value="">all classes</option>` +
    Object.keys(SKY_CLASS).sort((a, b) => SKY_CLASS[a].localeCompare(SKY_CLASS[b]))
      .map(c => `<option value="${c}"${SKYP.cls === c ? " selected" : ""}>${esc(SKY_CLASS[c])}</option>`).join("");
  $("skyShow").value = SKYP.show;
  $("skyHideDone").checked = SKYP.hideDone;
  renderSkyWidget();
}

/* ── parser tab: the site's /log-parser page, embedded whole ──────────────
   The iframe loads the vendored page over eqlt:// on first open; we post the
   active log's tail into its embed intake and re-post while the tab stays
   open (5 s cadence, only when new lines arrived — the page re-parses the
   whole tail each time, exactly like its own live-watch mode). */
const PARSER = { fedLines: -1, timer: null };
let LINES_SEEN = 0; // bootstrap + live lines; the parser re-feeds on growth

async function feedParser(keep) {
  const t = await window.companion.getLogTail();
  if (!t) return;
  PARSER.fedLines = LINES_SEEN;
  $("lpFrame").contentWindow.postMessage({ type: "eqlt-log", text: t.text, name: t.name, keep: !!keep }, "*");
  $("lpFrame").hidden = false;
  $("lpEmpty").hidden = true;
}

function parserTabActive(on) {
  if (!on) {
    if (PARSER.timer) { clearInterval(PARSER.timer); PARSER.timer = null; }
    return;
  }
  const f = $("lpFrame");
  if (!f.src) {
    f.addEventListener("load", () => feedParser(false), { once: true });
    f.src = "eqlt://app/log-parser/index.html?embed=1";
  } else if (LINES_SEEN > PARSER.fedLines) feedParser(true);
  if (!PARSER.timer) PARSER.timer = setInterval(() => { if (LINES_SEEN > PARSER.fedLines) feedParser(true); }, 5000);
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
  encCache: new Map(), // encounter key -> {sig, detail} drill-down memo
};
let OVERLAY_SHOWN = false;
const CB_SEED_LINES = 60000; // bootstrap window (whole visits within it)
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
   handles (found live: an 18-minute Plane of Hate raid visit). */
function capLive() {
  if (CB.live.length <= CB_LIVE_LINES) return;
  CB.live = CB.live.slice(-CB_LIVE_LINES);
  if (CB.zoneLine && CB.live[0] !== CB.zoneLine) CB.live.unshift(CB.zoneLine);
}

function combatSeed(file, text) {
  CB.owner = (file.match(/eqlog_([^_]+)_/) || [])[1] || null;
  CB.hist = []; CB.histKeys = new Set(); CB.encHist = []; CB.encKeys = new Set();
  CB.live = []; CB.run = null; CB.session = null; CB.sel = null; CB.raidSel = null;
  CB.encCache = new Map();
  // the bootstrap tail can be 40 MB; slice and parse off the handler's stack
  setTimeout(() => {
    let lines = text.split(/\r?\n/).filter(l => l.length);
    if (lines.length > CB_SEED_LINES) lines = lines.slice(-CB_SEED_LINES);
    let cut = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (CB_ZONE_RX.test(lines[i])) { cut = i; break; }
    // no zone line in the whole tail: keep a bounded live window and no history
    if (cut < 0 && lines.length > 10000) lines = lines.slice(-10000);
    CB.live = lines.slice(Math.max(0, cut));
    CB.zoneLine = cut >= 0 ? lines[cut] : null;
    capLive();
    if (cut > 0) {
      const r = combatParse(lines.slice(0, cut));
      if (r) combatFreeze(r);
    }
    combatSoon();
  }, 50);
}

function combatFeed(lines) {
  for (const l of lines) {
    CB.live.push(l);
    if (CB_ZONE_RX.test(l)) combatRollVisit(l);
  }
  capLive();
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
  CB.run = null; CB.session = null;
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
    row.detail = encDetailCached(row, g, r);
    CB.encHist.push(row); CB.encKeys.add(row.key);
  }
  if (CB.encHist.length > CB_HIST_CAP) {
    for (const row of CB.encHist.slice(0, CB.encHist.length - CB_HIST_CAP)) CB.encKeys.delete(row.key);
    CB.encHist = CB.encHist.slice(-CB_HIST_CAP);
  }
  CB.encCache = new Map(); // per-visit memo; frozen rows carry their detail
}

function combatRow(f, r) {
  return {
    key: E.fkey(f), ts: f.start, mob: f.mob, zone: f.zone,
    secs: Math.max(1, Math.round((f.end - f.start) / 1000)),
    total: f.total, you: f.dmg.you, pet: f.dmg.pet, charm: f.dmg.charm,
    taken: f.taken, xp: f.xp, coin: f.coin, killed: f.killed,
    team: f.killed && (f.killer === r.P.owner || r.side.claims.at(f.killer, f.end)),
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
  // "team" = the kill was OURS in the way a player means it: our blow landed
  // it, or the server credited us (xp/coin burst) — in a raid the killing
  // blow is usually someone else's while the kill is still yours
  const mobs = g.fights.map(f => ({
    mob: f.mob, killed: f.killed,
    team: f.killed && (f.killer === r.P.owner || r.side.claims.at(f.killer, f.end) || f.xp > 0 || f.coin > 0),
    dmg: f.total, taken: f.taken, xp: Math.round(f.xp * 10) / 10, coin: f.coin,
  }));
  return {
    key: `${g.start.getTime()}~${g.fights[0].mob}`, ts: g.start,
    secs: Math.max(1, Math.round((g.end - g.start) / 1000)),
    mobs, total: sum("total"), taken: sum("taken"),
    xp: Math.round(sum("xp") * 10) / 10, coin: sum("coin"),
    kills: mobs.filter(m => m.killed).length,
    team: mobs.some(m => m.team),
    detail: null,
  };
}
const encDetail = (g, r) => combatSliceDetail(new Set(g.fights.map(f => f.mob)), g.start, g.end, r);
/* Drill-down memo: an analyze() pass per encounter per tick is waste when the
   encounter hasn't changed. The signature covers every encRow number — any
   new damage/kill/xp moves one of them; a heals-only second can serve one
   stale healTot and self-corrects on the next swing. Cleared per visit. */
const encSig = row => `${row.secs}|${row.total}|${row.taken}|${row.xp}|${row.coin}|${row.kills}|${row.mobs.length}`;
function encDetailCached(row, g, r) {
  const hit = CB.encCache.get(row.key);
  const sig = encSig(row);
  if (hit && hit.sig === sig) return hit.detail;
  const detail = encDetail(g, r);
  CB.encCache.set(row.key, { sig, detail });
  return detail;
}

/* Raid meter: EVERYONE the log shows damaging a mob this visit — you, your
   pet/charm, other players, their pets — one row per actor name, expandable
   to that actor's per-source split. Engine-consumer code, not engine code:
   the meter reads P.events/side()/mobSet, so it can never disagree with the
   engine about attribution. A text log can't tell another player's summoned
   pet from a player (both are bare capitalized names) and can't tie either
   to an owner, so rows stay per-name; only YOUR side is labeled. */
function raidTable(r) {
  if (!r) return null;
  if (r._raid !== undefined) return r._raid; // computed once per engine run
  const actors = new Map();
  const times = [];
  for (const e of r.P.events) {
    if (e.k !== "dmg" || !e.src || !e.tgt) continue;
    if (!r.P.mobSet.has(e.tgt) || e.tgt === e.src) continue;
    // a claimed target is YOUR charm wearing a mob's name — damage to it is
    // damage taken, not raid damage (another player's charm can't be told
    // from a mob brawl; those rows stay, labeled as the mob they are)
    if (r.side.claims.at(e.tgt, e.ts)) continue;
    const s = r.side(e);
    // a mob damaging a mob with no claim is unattributable — someone's charm
    // or a brawl; it still swung for our side, so it stays, labeled by name
    let a = actors.get(e.src);
    if (!a) { a = { name: e.src, who: s === "othermob" ? "mob" : s, dmg: 0, hits: 0, max: 0, crit: 0, srcs: new Map() }; actors.set(e.src, a); }
    a.dmg += e.amt; a.hits++; if (e.crit) a.crit++; if (e.amt > a.max) a.max = e.amt;
    const phys = e.cat === "melee" || e.cat === "ranged";
    const nm = phys ? (e.cat === "ranged" ? "ranged" : (e.verb === "hit" ? "auto-attack" : e.verb)) : e.spell || "unknown";
    const sr = a.srcs.get(nm) || { name: nm, hits: 0, dmg: 0, max: 0, crit: 0 };
    sr.hits++; sr.dmg += e.amt; if (e.crit) sr.crit++; if (e.amt > sr.max) sr.max = e.amt;
    a.srcs.set(nm, sr);
    times.push(e.ts);
  }
  if (!actors.size) return (r._raid = null);
  // raid-wide combat seconds: the same 30s-gap rule as the engine's team
  // denominator, over every counted event — one shared clock for all rows
  let secs = 0, s0 = null, last = null;
  for (const t of times) { if (last && (t - last) / 1000 > 30) { secs += (last - s0) / 1000 + 1; s0 = t; } if (!s0) s0 = t; last = t; }
  if (s0) secs += (last - s0) / 1000 + 1;
  const rows = [...actors.values()].sort((a, b) => b.dmg - a.dmg).slice(0, 16).map(a => ({
    name: a.name, who: a.who, dmg: a.dmg, hits: a.hits, max: a.max, crit: a.crit,
    sources: [...a.srcs.values()].sort((x, y) => y.dmg - x.dmg).slice(0, 8),
  }));
  const total = [...actors.values()].reduce((n, a) => n + a.dmg, 0);
  return (r._raid = { secs: Math.round(secs), total, actors: rows });
}

function combatSoon() {
  if (CB.timer) return;
  CB.timer = setTimeout(() => { CB.timer = null; combatRun(); }, Math.max(1000, CB.runMs * 10));
}
function combatRun() {
  CB.dirty = false;
  const t0 = performance.now();
  CB.run = combatParse(CB.live);
  if (CB.run) {
    const oc = CB.run.P.who ? CB.run.P.who.classes.split("/") : null;
    const a = E.analyze(CB.run.P, CB.run.P.events, CB.run.side, oc);
    const killed = CB.run.seg.fights.filter(f => f.killed);
    const kills = killed.filter(f => f.killer === CB.run.P.owner || CB.run.side.claims.at(f.killer, f.end)).length;
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
function combatRows() {
  const rows = CB.hist.slice();
  if (CB.run) for (const f of CB.run.seg.fights) if (f.total > 0 || f.taken > 0) rows.push(combatRow(f, CB.run));
  return rows.sort((a, b) => b.ts - a.ts);
}

const fmtN = n => Math.round(n).toLocaleString();
const fmtDur = s => s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m` : `${Math.floor(s / 60)}m`;
const tsShort = d => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const fmtCu = cu => {
  cu = Math.round(cu);
  const p = Math.floor(cu / 1000), g = Math.floor(cu % 1000 / 100), s = Math.floor(cu % 100 / 10);
  return p ? `${fmtN(p)}p ${g}g` : g ? `${g}g ${s}s` : `${s}s ${cu % 10}c`;
};

function renderCombat() {
  const sEl = $("cbSession"), body = $("cbBody"), empty = $("cbEmpty");
  const rows = combatRows();
  if (!rows.length && !CB.session) { sEl.hidden = true; body.innerHTML = ""; empty.hidden = false; return; }
  empty.hidden = true;
  if (CB.session) {
    const { a, kills } = CB.session;
    const hrs = a.activeSecs / 3600;
    const visit = CB.run.seg.visits[CB.run.seg.visits.length - 1] || null;
    const cell = (v, label) => `<span class="stat"><b>${v}</b> ${label}</span>`;
    sEl.innerHTML =
      (visit ? `<span class="stat cb-zone">${esc(visit.name)}${visit.tier ? " · tier " + visit.tier : ""}</span>` : "") +
      cell(fmtDur(a.activeSecs), "active") +
      cell(fmtN(a.total), "damage") +
      (a.combatSec >= 5 ? cell(fmtN(a.total / a.combatSec), "dps") : "") +
      cell(kills, "kills") +
      (a.xp ? cell(a.xp.toFixed(1) + "%", "xp") : "") +
      (a.activeSecs >= 120 && kills ? cell((kills / hrs).toFixed(0), "kills/h") : "") +
      (a.activeSecs >= 120 && a.xp ? cell((a.xp / hrs).toFixed(1) + "%", "xp/h") : "") +
      (a.taken.dmg ? cell(fmtN(a.taken.dmg), "taken") : "") +
      (a.copper ? cell(fmtCu(a.copper), "coin") : "");
    sEl.hidden = false;
  } else sEl.hidden = true;
  if (!rows.length) { body.innerHTML = raidHtml(); return; }
  let h = raidHtml();
  h += `<table class="qtab cbt"><thead><tr><th>Time</th><th>Mob</th><th></th><th>Dur</th><th>Damage</th><th>DPS</th><th>Taken</th><th>XP</th></tr></thead><tbody>`;
  for (const row of rows) {
    const open = CB.sel === row.key;
    h += `<tr class="cbr${row.team ? "" : " cb-dim"}" data-fight="${esc(row.key)}">` +
      `<td class="dim">${tsShort(row.ts)}</td>` +
      `<td class="cb-mob">${esc(row.mob)}</td>` +
      `<td title="${row.killed ? (row.team ? "your kill" : "killed by someone else") : "no death line"}">${row.killed ? (row.team ? "✓" : "✕") : ""}</td>` +
      `<td>${row.secs}s</td>` +
      `<td class="cb-dmg">${fmtN(row.total)}</td>` +
      `<td>${fmtN(row.total / row.secs)}</td>` +
      `<td>${row.taken ? fmtN(row.taken) : "—"}</td>` +
      `<td>${row.xp ? row.xp.toFixed(1) + "%" : "—"}</td></tr>`;
    if (open) h += `<tr class="cbd"><td colspan="8">${combatDetailHtml(row)}</td></tr>`;
  }
  body.innerHTML = h + "</tbody></table>";
}

function combatDetail(row) {
  if (row.detail) return row.detail;
  if (!CB.run) return null;
  const f = CB.run.seg.fights.find(x => E.fkey(x) === row.key);
  if (!f) return null;
  row.detail = combatDetailFor(f, CB.run);
  return row.detail;
}

function combatDetailHtml(row) {
  const d = combatDetail(row);
  if (!d) return `<span class="dim">no detail for this fight</span>`;
  const src = d.sources.map(s =>
    `<tr><td>${esc(s.name)}${s.side !== "you" ? ` <span class="dim">${s.side}</span>` : ""}</td>` +
    `<td>${s.hits}</td><td class="cb-dmg">${fmtN(s.dmg)}</td><td>${fmtN(s.max)}</td><td>${s.crit || "—"}</td></tr>`).join("");
  const tkn = (d.takenBy || []).map(t =>
    `<tr><td>${esc(t.src)} <span class="dim">${esc(t.name)}</span></td>` +
    `<td>${t.hits}</td><td class="cb-dmg">${fmtN(t.dmg)}</td><td>${fmtN(t.max)}</td><td>${t.res || "—"}</td></tr>`).join("");
  const bits = [];
  if (row.you) bits.push(`you ${fmtN(row.you)}`);
  if (row.pet) bits.push(`pet ${fmtN(row.pet)}`);
  if (row.charm) bits.push(`charm ${fmtN(row.charm)}`);
  for (const [how, n] of d.avoid || []) bits.push(`${how} ×${n}`);
  if (d.healTot) bits.push(`healed ${fmtN(d.healTot)}`);
  if (d.healInTot) bits.push(`took heals ${fmtN(d.healInTot)}`);
  if (d.petTaken) bits.push(`pet took ${fmtN(d.petTaken)}`);
  if (row.coin) bits.push(fmtCu(row.coin));
  return (src ? `<table class="cbt-sub"><thead><tr><th>Source</th><th>Hits</th><th>Damage</th><th>Max</th><th>Crits</th></tr></thead><tbody>${src}</tbody></table>` : "") +
    (tkn ? `<table class="cbt-sub"><thead><tr><th>Hit you with</th><th>Hits</th><th>Damage</th><th>Max</th><th>Resisted</th></tr></thead><tbody>${tkn}</tbody></table>` : "") +
    swingHtml(d.swings) +
    (bits.length ? `<p class="dim cb-line">${bits.join(" · ")}</p>` : "");
}

/* ── swing intervals ──────────────────────────────────────────────────────
   How fast each actor is actually swinging, per weapon verb. Built for the
   weapon-swap question: run the same pet through two fights and compare the
   interval. Both the number and its range are shown because the range is what
   says whether a difference is real — two fights whose ranges overlap have
   not measurably changed, however different the middle numbers look. */
const SW = { sort: "swings", dir: 1 };
const SIDE_LABEL = { you: "you", pet: "your pet", charm: "your charm", othermob: "other", other: "other" };
function swingHtml(rows) {
  if (!rows || !rows.length) return "";
  const key = r => SW.sort === "actor" ? r.actor.toLowerCase() : SW.sort === "verb" ? r.verb : r[SW.sort];
  const sorted = rows.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ((ka < kb ? -1 : ka > kb ? 1 : 0) * -SW.dir) || (b.swings - a.swings);
  });
  const arrow = k => SW.sort === k ? (SW.dir > 0 ? " ▼" : " ▲") : "";
  const th = (k, label) => `<th class="is-sort" data-swsort="${k}">${label}${arrow(k)}</th>`;
  return `<div class="cb-swingwrap"><table class="cbt-sub cb-swings"><thead><tr>` +
    th("actor", "Swinging") + th("verb", "Attack") + th("swings", "Swings") +
    th("engaged", "Engaged") + th("interval", "Every") + `<th>95% range</th>` +
    `</tr></thead><tbody>` +
    sorted.map(r => `<tr><td>${esc(r.actor)} <span class="dim">${SIDE_LABEL[r.side] || r.side}</span></td>` +
      `<td>${esc(r.verb)}</td><td>${r.swings}</td><td>${r.engaged}s</td>` +
      `<td class="cb-dmg">${r.interval.toFixed(2)}s</td>` +
      `<td class="dim">${r.lo.toFixed(2)}–${r.hi == null ? "?" : r.hi.toFixed(2)}s</td></tr>`).join("") +
    `</tbody></table></div><p class="dim cb-line cb-swingnote">Seconds between swings — not the weapon's ` +
    `delay stat, since haste and double attacks fold in. For one actor across two fights those cancel: ` +
    `overlapping ranges mean no measurable change.</p>`;
}

/* Everyone's damage this visit — the raid meter, on the Combat tab too.
   Collapsed to its header row until clicked; each actor row expands to that
   actor's source split. */
function raidHtml() {
  if (!CB.run) return "";
  const rt = raidTable(CB.run);
  if (!rt || rt.actors.length < 2) return ""; // solo: the fight list already says it all
  const secs = Math.max(1, rt.secs);
  let h = `<div class="cb-raidhead" data-raidtoggle><span class="cb-caret">${CB.raidOpen ? "▾" : "▸"}</span> ` +
    `Everyone's damage <span class="dim">· ${rt.actors.length} actors · ${fmtN(rt.total)} dmg · ${fmtN(rt.total / secs)} dps</span></div>`;
  if (!CB.raidOpen) return h;
  h += `<table class="qtab cbt cbraid"><thead><tr><th>Actor</th><th>%</th><th>Damage</th><th>DPS</th><th>Hits</th><th>Max</th><th>Crits</th></tr></thead><tbody>`;
  for (const a of rt.actors) {
    const tag = a.who === "you" ? " (you)" : a.who === "pet" ? " (your pet)" : a.who === "charm" ? " (your charm)" : a.who === "mob" ? " (mob)" : "";
    h += `<tr class="cbr" data-raidactor="${esc(a.name)}"><td class="cb-mob">${esc(a.name)}<span class="dim">${tag}</span></td>` +
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
  return rows.sort((a, b) => b.ts - a.ts);
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
    for (const row of encs) if (!row.detail && row.live) row.detail = encDetailCached(row, row.live, CB.run);
  const p = {
    raid: OVERLAY_SHOWN ? raidTable(CB.run) : null,
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
      xp: r.xp, coin: r.coin, kills: r.kills, team: r.team, detail: r.detail,
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
  const e = t && lookupItem(TIDX, t.dataset.tt); // "+N"/"*" decorated names resolve too
  if (e) showTip(e); else tipEl.hidden = true;
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
const OV_VIEW_LABEL = { tracked: "Tracked", loot: "Loot", stats: "Stats", sky: "Sky" };
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

  renderStatus(); renderTracker(); renderFeed(); renderData();
  populateZoneSel(); renderZoneTab(); populateQuestFilters(); populateInvFilters(); renderQuests();
  populateSkyFilters(); renderSky(); initTip();

  window.companion.onBootstrap(onBootstrap);
  window.companion.onLines(onLines);
  window.companion.onLogStatus(st => { LOGSTATUS = st; renderStatus(); });
  window.companion.onInvFile(onInvFile);
  window.companion.onInvStatus(onInvStatus);
  window.companion.onDataUpdated(d => { buildIndexes(d); if (STATE && K.reclassify(STATE, NAMEZONES)) K.save(STATE); renderTracker(); renderData(); populateZoneSel(); renderZoneTab(); populateInvFilters(); renderInv(); populateQuestFilters(); renderQuests(); populateSkyFilters(); renderSky(); pushZone(); pushQuests(); pushSky(); });
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
  $("skySearch").addEventListener("input", renderSky);
  $("skyShow").addEventListener("change", e => { SKYP.show = e.target.value; saveSkyPrefs(); renderSky(); });
  $("skyClass").addEventListener("change", e => { SKYP.cls = e.target.value; saveSkyPrefs(); renderSky(); });
  $("skyHideDone").addEventListener("change", e => { SKYP.hideDone = e.target.checked; saveSkyPrefs(); renderSky(); });
  $("skyExpand").addEventListener("click", () => {
    const all = Object.keys(SKY_CLASS);
    const anyOpen = !!document.querySelector(".skg__h[aria-expanded=true]");
    SKYP.open = anyOpen ? [] : all.slice();
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
  $("trkSearch").addEventListener("input", e => { TRACKER_Q = e.target.value; renderTracker(); });
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
  $("btnPickDir").addEventListener("click", async () => { LOGSTATUS.logDir = await window.companion.pickLogDir(); renderStatus(); });
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
    // swing-table headers sit INSIDE an expanded fight row, so they have to
    // win before [data-fight] or sorting would collapse the fight instead
    const sw = e.target.closest("[data-swsort]");
    if (sw) {
      const k = sw.dataset.swsort;
      if (SW.sort === k) SW.dir = -SW.dir; else { SW.sort = k; SW.dir = k === "actor" || k === "verb" ? -1 : 1; }
      renderCombat(); return;
    }
    const rt = e.target.closest("[data-raidtoggle]");
    if (rt) { CB.raidOpen = !CB.raidOpen; renderCombat(); return; }
    const ra = e.target.closest("[data-raidactor]");
    if (ra) { CB.raidSel = CB.raidSel === ra.dataset.raidactor ? null : ra.dataset.raidactor; renderCombat(); return; }
    const cf = e.target.closest("[data-fight]");
    if (cf) { CB.sel = CB.sel === cf.dataset.fight ? null : cf.dataset.fight; renderCombat(); return; }
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
      const k = ivs.dataset.ivsort, c = IV_COLS.find(x => x.k === k);
      if (IV.sort === k) IV.dir = -IV.dir; else { IV.sort = k; IV.dir = (c && c.d0) || 1; }
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
    const sg = e.target.closest("[data-skyclass]");
    if (sg) {
      const c = sg.dataset.skyclass;
      // first click freezes whatever the auto-open rule was showing, so one
      // fold closing doesn't reshuffle the other fifteen
      if (!SKYP.open) SKYP.open = [...document.querySelectorAll(".skg__h[aria-expanded=true]")].map(b => b.dataset.skyclass);
      SKYP.open = SKYP.open.includes(c) ? SKYP.open.filter(x => x !== c) : SKYP.open.concat(c);
      saveSkyPrefs(); renderSky(); return;
    }
    const zh = e.target.closest("[data-zone]");
    if (zh) { const k = zh.dataset.zone; EXPANDED.has(k) ? EXPANDED.delete(k) : EXPANDED.add(k); renderTracker(); }
  });
}
main();
