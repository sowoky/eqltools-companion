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
let PETD = null;      // pet-data.json — summon lines, pet slot table, pet-haste buffs
let GIDX = new Map(); // itemKey(item) -> gear record (the name's FIRST wiki record, same pick as /gear)
let GVARS = new Map(); // itemKey(item) -> [all records sharing that display name], only when > 1
let GEO = null;       // quest-items.json geo: {nodes: {name: {adj, keys, oe}}, alias}
let KEY2NODE = new Map(); // atlas zone key -> geo node name
let NPCLOC = {};      // NPC display name -> {t, z, loc}
/* itemKey(in-game name) -> wiki page title. The dataset speaks page titles
   ('Bunker Cell No 1'); the dump and the log speak the client's name ('Bunker
   Cell #1'). Without this map the key you are holding never matched the key
   the chain says you need (Zimel's Blades, 2026-08-16). */
let QALIAS = {};
/* GVARS is several wiki PAGES sharing a display name. These two are the other
   shape of the same trouble: ONE page covering several real items, told apart
   only by the client item ID the inventory dump prints.
     IDLABEL  item ID   -> what that ID actually is ("Coin of the Tash - Azia")
     IDGROUP  itemKey   -> [[id, label], …] for every item wearing that name */
let IDLABEL = new Map();
let IDGROUP = new Map();

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
    /* A hub page ("Popular Quests by Level") indexes other quests' rewards
       as its components. The pipeline flags it `hub`; a file built before
       the flag is read by shape. Its component uses are nobody's turn-in. */
    const isHub = q => !!q.hub || (!q.giver && !q.zone && !(q.steps || []).length && (q.need || []).length >= 20);
    for (const [nk, refs] of Object.entries(QDATA.items)) {
      QIDX.set(nk, refs.map(([qi, as]) => ({ q: QDATA.quests[qi], as })).filter(r => !(r.as === "c" && isHub(r.q))));
    }
    for (const q of QDATA.quests) T2Q.set(q.t, q);
    QDROPS = QDATA.drops || {};
    QSRC = QDATA.src || {};
    QZONES = QDATA.zones || {};
    GEO = QDATA.geo || null;
    NPCLOC = QDATA.npcs || {};
    QALIAS = QDATA.alias || {};
    /* One display name, several real items. The dump prints the client's item
       ID beside every row, and that ID is the only thing separating ten
       different `Old Silver Coin` — the wiki has one page for all ten. QDATA.ids
       (schema 6) says which ID is which; an older cached download simply has no
       `ids` and every count falls back to being by name, as before. */
    IDLABEL = new Map(); IDGROUP = new Map();
    for (const [key, list] of Object.entries(QDATA.ids || {})) {
      IDGROUP.set(key, list);
      for (const [id, label] of list) IDLABEL.set(id, label);
    }
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
  const petd = datasets["pet-data.json"];
  PETD = petd ? petd.data : null;
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
  // ACH_SKY is keyed off SKYD's tests as well as the achievements file, so a
  // dataset refresh has to re-derive it too
  rebuildAchSky();
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

function onBootstrap({ file, text, head }) {
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
  skySeed(file, text, head);
  exaltSeed(file, text);
  // renderUnlocks too: on a character switch the "this dump is X's and the log
  // is Y's" banner is the only thing that says the achievements are not applied
  renderStatus(); renderTracker(); pushZone(); renderSky(); pushSky(); renderUnlocks();
  renderQuestsSoon(); // the tail's trades, buys and combines just landed in the ledger
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
  exaltFeed(lines);
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
  n: q.n, t: q.t, as, rewards: as === "c" ? partRewards(q, name) : (q.rewards || []),
  zone: q.zone, lvl: q.lvl, oe: !!q.oe,
}));
/* A split page is many turn-ins under one URL, and each pays its own prize:
   the Efreeti War Spear buys the Spear of Harmony, not every Bard test's
   reward. The parts that consume this item name what they pay; when none does
   (a flat page, or parts with no stated payout) the page's rewards stand. Only
   real prizes count — a step-made part pays an intermediate (the pick digs up
   a leg bone), and that is not what the quest is for. */
function partRewards(q, name) {
  const prizes = q.rewards || [], out = [];
  for (const p of q.parts || []) {
    if (!(p.r || []).length || !(p.c || []).some(([c]) => sameItem(c, name))) continue;
    for (const r of p.r) if (prizes.includes(r) && !out.includes(r)) out.push(r);
  }
  return out.length ? out : prizes;
}

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
/* Whose dump is this? main.js picks the NEWEST `*-Inventory.txt` in the game
   folder without looking at who it belongs to, so dumping on one character and
   then playing another leaves the app holding Averaj's bags against Ravlin's
   log. Mixing them into a held count is silent fiction — the same rule, and
   the same wording, as achMine() for the achievements file.

   Scope, deliberately: this gates the HELD COUNTS only (haveMap and the
   post-dump credit window), which is where the two sources are mixed. The
   Inventory table, and its Gear/Spare/Valet modes, are views OF the dump and
   still show it; renderInv says whose it is. Whether an unmatched dump should
   be hidden outright, or refused earlier in main.js, is a product call — see
   the Codex finding "inventory dump crosses character boundary". */
const invChar = f => (String(f || "").match(/^([^_]+)_/) || [])[1] || "";
function invMine() {
  if (!INV.rows) return false;
  const me = SKYL && SKYL.me, who = invChar(INV.file);
  if (!me || !who) return true;   // can't tell yet — don't withhold
  return who.toLowerCase() === me.toLowerCase();
}
const IV = { tab: "all", trade: "", cls: "", focus: "", sort: "where", dir: 1 };
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
  const rows = [], last = new Map();
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
    /* A child row belongs to the row it FOLLOWS, not to whatever row last
       carried its parent's location: the dump names both worn Ear, Wrist,
       Fingers and Any Slot items identically, so "Ear-Slot7" resolved by
       location put the first earring's stone inside the second earring. Resolving in dump
       order — the most recent row at the parent's location — files each
       socket under its own item. EVERY row is a potential parent: a socketed
       item sitting in a bag slot makes its rune a "General 1-Slot2-Slot1"
       child of a row that is itself a child. */
    const r = rows[rows.length - 1];
    if (r.parentLoc) {
      const p = last.get(r.parentLoc);
      if (p) { r.parent = p; (p.kids || (p.kids = [])).push(r); }
    }
    last.set(loc, r);
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
  if (VINV && window.EQLSpare) {
    SPARE = window.EQLSpare.analyze({ rows: VINV.rows, level: VL.level, D: window.EQL_DATA });
    SPARE_BY = new Map(SPARE.items.map(it => [spareKey(it.row.loc, it.row.name), it]));
  }
  exaltReload();
  /* Copies needs only the dump; Rank and Exalt inside need the gear dataset
     too, and come back empty without it — the same degrade as every other
     enrichment column. */
  invxReload();
}

/* ── Exalt: the fourth mode ──────────────────────────────────────────────
   vendor/exalt-core.js (the /exalt page's core) reads the dump once — every
   worn item's four sockets, every loose exaltation and where it fits, every
   item you own whose wiki record yields one — and this layer keys the answer
   back onto the rows by location + name, same as Spare. */
let EXALT = null, EXALT_CAT = null, EXALT_BY = null, EXALT_ROWS = null;

/* ── which exaltations actually fire ────────────────────────────────────
   The client names the exaltation when its effect goes off: a focus applying
   prints "Your Idol of the Underking (Exaltation) feels alive with power.", a
   worn vision effect "…pulses with light as your vision sharpens.", others
   "…shimmers briefly." (client-observed — 5,891 such lines in Kyle's own log
   for three exaltations, 2026-08-15). Counted per exaltation over the log
   tail the app bootstrapped from plus everything live since; the count is a
   "does this one do anything" reading, never a rate. */
const EXFIRE_RX = /^\[[^\]]{20,30}\] Your (.+?) \(Exaltation\) (?:feels alive with power|shimmers briefly|pulses with light[^.]*)\.\s*$/;
let EXFIRED = new Map(), exfireFile = null, exfireDirty = false;
function exaltSeed(file, text) {
  if (file !== exfireFile) { EXFIRED = new Map(); exfireFile = file; }
  exaltFeed(text.split(/\r?\n/));
}
function exaltFeed(lines) {
  let hit = false;
  for (const line of lines) {
    const m = EXFIRE_RX.exec(line);
    if (!m) continue;
    EXFIRED.set(m[1], (EXFIRED.get(m[1]) || 0) + 1);
    hit = true;
  }
  if (hit && INV_VIEW === "exalt" && !exfireDirty) {
    exfireDirty = true;
    setTimeout(() => { exfireDirty = false; renderInv(); }, 1500);
  }
}
// the companion's rows keep the raw name; the log names the source item
const exfireOf = v => (v.r.exalt ? EXFIRED.get(stripDecor(v.r.name)) : null) || null;

function exaltReload() {
  EXALT = null; EXALT_BY = null; EXALT_ROWS = null;
  if (!INV.text || !GDATA || !window.EQLExaltCore) return;
  const X = window.EQLExaltCore;
  if (!EXALT_CAT || EXALT_CAT.data !== GDATA) {
    X.setLockedZones(GDATA.zone_oe);
    EXALT_CAT = X.build(GDATA); EXALT_CAT.data = GDATA;
  }
  // keepEmpty: an Empty socket row is how the dump says an effect was pulled out
  const rows = window.EQLGearScore.parseRows(INV.text, { keepEmpty: true });
  EXALT = X.readDump(rows, GDATA, EXALT_CAT);
  EXALT_ROWS = rows;   // the row objects EXALT points at — invxReload joins on them
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
    // where the stone IS, not only what it fits: standing at the banker those
    // are the two facts, and the location was not on the wire at all
    const b = window.EQLGearScore.locBadge(l.row.loc);
    rows.push({ n: l.row.base, url: ref.url, sb: ref.sb, kind: X.TYPE[y.type].label, effect: y.effect,
                loc: { k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title },
                into: `${h.now[0].w.slot}: ${h.now[0].w.row.base}`,
                more: h.now.length > 1 ? h.now.slice(1).map(x => x.w.slot).join(", ") : null });
  }
  const p = { loose: EXALT.loose.length, rows: rows.slice(0, 40) };
  const j = JSON.stringify(p);
  if (j !== lastExaltJson) { lastExaltJson = j; window.companion.sendExalt(p); }
}
const spareOf = v => (SPARE_BY && SPARE_BY.get(spareKey(v.r.loc, v.r.name))) || null;

/* ── Rank, Copies, Exalt inside: the inventory-management answers ─────────
   vendor/inventory-core.js does the measuring; this layer runs it when the
   dump or the datasets change and keys the answers onto the rows. Kyle
   (2026-08-23): "on the /sky stuff we are already measuring how strong an item
   is for its class, a ranking. so i want to see that as a column … highlight
   … when a piece of gear i have is a duplicate also anywhere else in my
   bag/bank/inventory. so i can merge and save space … an indication if an
   item has an exaltation i don't have anywhere else so i know to strip it
   before getting rid of the item."

   Rank is the /sky ranking — gear-score per class against every in-era item
   the class can wear in the slot, at +0 — and is a property of the ITEM, so
   it is memoised per gear record, not per row. Copies and the exaltation
   check are properties of the DUMP and are rebuilt with it. */
let RANKER = null, RANKER_FOR = null, RANKER_LVL = 0, RANKER_CLS = "", RANK_MEMO = new Map();
function ranker() {
  if (!GDATA || !window.EQLInventory) return null;
  if (!RANKER || RANKER_FOR !== GDATA || RANKER_LVL !== VL.level) {
    RANKER = window.EQLInventory.makeRanker({ D: GDATA, level: VL.level, combat: window.EQL_DATA });
    RANKER_FOR = GDATA; RANKER_LVL = VL.level; RANK_MEMO = new Map();
  }
  // the pools are per class and survive a trio change; the memo's headline
  // tie-break and `trio` list do not
  const cls = VL.classes.join("/");
  if (cls !== RANKER_CLS) { RANKER_CLS = cls; RANK_MEMO = new Map(); }
  return RANKER;
}
function rankOf(v) {
  // a stone or an ornament is named after an item; it is not one
  if (!v.g || v.r.exalt || /\(Ornamentation\)\*?$/.test(v.r.name)) return null;
  const R = ranker();
  if (!R) return null;
  let b = RANK_MEMO.get(v.g);
  if (b === undefined) { b = R.best(v.g, { classes: VL.classes }); RANK_MEMO.set(v.g, b); }
  return b.best ? b : null;
}
/* TWO columns, not one headline. "Your trio" is where the item stands for the
   classes you have selected; "Any class" is the best standing it has anywhere.
   They part company for 159 in-era items — Basilisk Bracer is BER #67 of 81
   and SHM #8 of 113 — and one number cannot say both: trio-first calls it junk,
   best-of-all calls it a top-10 piece for a class you will get to. Kyle
   settled it 2026-08-28: show two columns. */
const rankTrio = b => b.trio[0] || null;
const rankAny = b => b.best || null;
// rank first, then the bigger pool: a #1 of 459 above a #1 of 27
const rankKey = x => x.rank * 100000 - x.of;
/* What the denominator counts, for the cell's title — the main hand is two
   catalogues now and "of 320" alone does not say which one you are in. */
const rankWhat = x => `${x.of} ${x.noun || "in-era items"} a ${window.EQLChar.name(x.cls)} can `
  + (x.slot === "Primary" ? "put in the main hand" : x.slot === "Secondary" ? "put in the off hand" : `wear at ${x.slot}`);
/* An item can carry a clicky, a proc or a focus and no stats at all — 30
   in-era records do, Manastone and Shiny Brass Idol among them — and
   gear-score reads none of it (its weights are HP, mana, stats, AC, resists,
   haste and weapon ratio; there is no effect term). Those get no pool and no
   rank, and an empty cell in a keep-or-toss column reads as a verdict. Say
   why it is empty instead. */
const rankEffOnly = (v) => !!(v.g && !v.r.exalt && ((v.g.eff && v.g.eff.length) || v.g.foc));
const NO_SCORE_WHY = "Not ranked — it carries an effect and none of the stats the score reads. "
  + "Clicky, proc and focus effects are all unscored, so an empty rank here is not a verdict on it.";
function rankCellHtml(v, x, opts) {
  const o = opts || {};
  return `<td class="iv-n iv-rank${x.rank <= 3 ? " is-top" : ""}${o.echo ? " is-echo" : ""}"`
    + ` data-pop="${o.pop}:${v.r.id}" title="${esc(rankWhat(x))}">`
    + `<b>#${x.rank}</b><span class="dim"> of ${x.of}</span>`
    + `<span class="iv-nichex">${esc(x.cls)} ${esc(x.slot)}</span></td>`;
}

let COPIES = new Map();     // INV row -> copies group
let UNIQX = new Map();      // row key -> { stones, unique }
let OWNED = new Map();      // gear record -> [INV rows] (what you hold of a catalogue item)
/* The two parses of the dump (this tab's and gear-score's) agree on row
   order but not on row objects, and a location is not unique — both worn
   Ear items are "Ear". Joined by location + name + the nth time that pair
   has appeared. */
function ordKeys(rows) {
  const seen = new Map(), out = new Map();
  for (const r of rows) {
    const k = r.loc + "|" + r.name;
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    out.set(r, k + "#" + n);
  }
  return out;
}
let INV_KEYS = new Map();
/* A container: it holds things (positional children, not sockets), or the
   tooltip dataset gives it a Capacity line (an empty bag in the bank). */
function invIsContainer(r) {
  if (r.kids && r.kids.some(k => !window.EQLExalt.socketAt(k.loc))) return true;
  const ti = lookupLoose(TIDX, TIDX_L, r.name);
  return !!(ti && (ti.sb || []).some(l => /^Capacity:/.test(l)));
}
/* Can this carry an upgrade tier: a wiki gear record, a "Slot:" line in its
   item window, or a copy that already wears a +N. A quest component or a
   tradeskill drop has none of those, and "merge → +1" on a Cyclops Skull is
   advice about a mechanic it does not have. */
function invIsGear(r) {
  if (r.tier) return true;
  const g = gearFor(r.name);
  if (g && g.sl && g.sl.length) return true;
  const ti = lookupLoose(TIDX, TIDX_L, r.name);
  return !!(ti && (ti.sb || []).some(l => /^Slot:/.test(l)));
}
function invxReload() {
  COPIES = new Map(); UNIQX = new Map(); OWNED = new Map(); INV_KEYS = new Map();
  if (!INV.rows || !window.EQLInventory) return;
  INV_KEYS = ordKeys(INV.rows);
  COPIES = window.EQLInventory.copies(INV.rows, { isContainer: invIsContainer, isGear: invIsGear });
  for (const r of INV.rows) {
    if (r.exalt) continue;
    const g = gearFor(r.name);
    if (g) (OWNED.get(g) || OWNED.set(g, []).get(g)).push(r);
  }
  if (EXALT && EXALT_ROWS) {
    const keys = ordKeys(EXALT_ROWS);
    for (const [row, info] of window.EQLInventory.uniqueExaltations(EXALT)) UNIQX.set(keys.get(row), info);
  }
  /* Rank is lazy per gear record; touching every record the dump names here
     (~130 ms, 280 pools) keeps that cost with the rest of the per-dump
     analysis instead of inside the first renderInv(). */
  if (ranker()) for (const g of OWNED.keys()) rankOf({ g, r: { exalt: false, name: g.n } });
}
const uniqOf = v => UNIQX.get(INV_KEYS.get(v.r)) || null;

/* One line of what a record carries, for a comparison row: AC, stats,
   resists, ratio, haste — the things the score reads, nothing it does not. */
function recLine(rec, tier) {
  const T = window.EQLTier, st = T.statsAt(rec, tier || 0), bits = [];
  if (st.ac) bits.push(`${st.ac} AC`);
  const sb = [];
  for (const k of STAT_ORDER) if (st[k]) sb.push(`${st[k] > 0 ? "+" : ""}${st[k]} ${STAT_LABEL[k]}`);
  if (sb.length) bits.push(sb.join(" "));
  const sv = [];
  for (const k of ["f", "c", "m", "d", "p"]) if (rec.sv && rec.sv[k]) sv.push(`${SV_LABEL[k]}${rec.sv[k] > 0 ? "+" : ""}${rec.sv[k]}`);
  if (sv.length) bits.push(sv.join(" "));
  if (rec.dmg && rec.dly) bits.push(`${T.statAt(rec.dmg, tier || 0)}/${rec.dly}`);
  if (rec.haste) bits.push(`haste ${rec.haste}%`);
  return bits.join(" · ");
}
/* Where you hold a catalogue item, if anywhere: every place, with tier. */
function ownedText(rec) {
  const rows = OWNED.get(rec);
  if (!rows || !rows.length) return "";
  return rows.map(r => `${whereText(r.loc)}${r.tier ? ` +${r.tier}` : ""}${r.count > 1 ? ` ×${r.count}` : ""}`).join("; ");
}
/* The comparison: the three best in the (class, slot) and this item, with
   what each carries, where it comes from and whether you hold one. `link`
   makes the names wiki links (the row detail); the hover popover cannot be
   clicked, so it names them plain. */
function rankTable(v, b, x, opts) {
  const o = opts || {};
  const R = ranker(), X = window.EQLExaltCore;
  const pool = R.pool(x.cls, x.slot, x.kind);
  // the same tie rule as the headline: 1 + the number scoring strictly above
  let above = 0;
  const top = pool.slice(0, o.n || 3).map((e, i) => {
    if (i && e.s < pool[i - 1].s) above = i;
    return { rec: e.rec, rank: above + 1, s: e.s };
  });
  const mine = top.find(t => t.rec === v.g);
  const list = top.slice();
  const lastShown = top.length ? top[top.length - 1].rank : 0;
  if (!mine) list.push({ rec: v.g, rank: x.rank, s: x.score, me: true, gap: Math.max(0, x.rank - lastShown - 1) });
  else mine.me = true;
  const gbase = (GDATA && GDATA.base) || "";
  const name = rec => o.link && rec.t
    ? `<a class="wk" data-url="${esc(gbase + rec.t)}">${esc(rec.n)}</a>` : esc(rec.n);
  const rows = list.map(t => `${t.gap > 0 ? `<tr class="pop__gap"><td></td><td colspan="5">${t.gap} more</td></tr>` : ""}
    <tr class="${t.me ? "is-me" : ""}"><td class="pop__n">#${t.rank}</td><td class="pop__item">${name(t.rec)}${t.me ? ` <span class="dim">this</span>` : ""}</td>
    <td class="pop__stats">${esc(recLine(t.rec, 0))}</td><td class="pop__score">${Math.round(t.s)}</td>
    <td class="pop__src" title="${esc(X.sourceLines(t.rec).join("\n"))}">${srcCell(t.rec, o.link)}</td>
    <td class="pop__have">${t.me ? `<span class="ok">${esc(whereText(v.r.loc))}${v.r.tier ? ` +${v.r.tier}` : ""}</span>` : ownedText(t.rec) ? `<span class="ok">${esc(ownedText(t.rec))}</span>` : `<span class="dim">—</span>`}</td></tr>`).join("");
  /* Every other standing the item has, and each one says WHICH SLOT. They are
     (class, slot) pairs and were printed class-only, so a one-hander listed
     the same class twice with two different numbers and no way to tell why —
     Kyle read a Ranger main-hand #70 next to "also RNG #16" and asked what the
     16 was (2026-08-28). It was the off hand. */
  const chip = (t) => `${t.cls} ${t.slot} #${t.rank}`;
  const own = b.trio.length ? b.trio.map(chip).join(" · ") : null;
  const others = b.all.filter(t => t !== x && !b.trio.includes(t));
  /* No "at +N as you hold it" rank: the pool is at +0, so any upgraded copy
     lands at #1 against it by construction — a number, not a comparison. */
  const blind = rankEffOnly(v)
    ? `<div class="pop__warn">Ranked on its stats only — the score has no term for the effect it carries.</div>` : "";
  return `<div class="pop__head"><b>${esc(x.slot)}</b> for <b>${esc(window.EQLChar.name(x.cls))}</b> · #${x.rank} of ${x.of} ${esc(x.noun || "in-era items")}<span class="dim"> · scored at +0</span></div>${blind}
    <table class="pop__t"><thead><tr><th></th><th>Item</th><th>Carries</th><th>Score</th><th>From</th><th>You hold</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="pop__foot">${own ? `Your ${esc(VL.classes.join("/"))}: ${esc(own)}` : b.anyClass ? "Any class can wear it" : `Your ${esc(VL.classes.join("/"))} can't wear it`}${others.length ? `<span class="dim"> · also ${others.slice(0, 6).map(t => esc(chip(t))).join(", ")}${others.length > 6 ? ` +${others.length - 6}` : ""}</span>` : ""}</div>`;
}
/* Where a catalogue item comes from, one line: the first zone and mob as
   wiki links when the panel can be clicked, plain when it cannot. The
   zone/mob vocabulary is the row detail's own (QZONES, mobSpan). */
function srcCell(rec, link) {
  const X = window.EQLExaltCore;
  if (!link) return esc(X.sourceText(rec) || "");
  const s = (rec && rec.src) || {};
  const drops = (s.d || []).filter(([z]) => !(GDATA.zone_oe || []).includes(z));
  const parts = [];
  if (drops.length) {
    const [z, mobs] = drops[0];
    const mobN = drops.reduce((n, [, ms]) => n + ms.length, 0);
    const zl = QZONES[z] ? `<a class="wk" data-wiki="${esc(QZONES[z])}">${esc(z)}</a>` : esc(z);
    parts.push(`${zl}${mobs[0] ? ` · ${mobSpan(mobs[0][0])}` : ""}${mobN > 1 ? ` <span class="dim">(+${mobN - 1} more)</span>` : ""}`);
  }
  if (s.q) parts.push("quest");
  if (s.c) parts.push("crafted");
  if (s.s) parts.push("sold");
  if (s.f) parts.push("foraged");
  if (s.v) parts.push("various");
  return parts.join(" · ");
}

/* Copies: what the cell says in six words, and what the popover spells out. */
const MAX_TIER = 10;
function copiesAction(g, r) {
  if (g.wornPair) return "both worn";
  if (g.stack) return g.saves ? `frees ${g.saves} slot${g.saves > 1 ? "s" : ""}` : "no slot to gain";
  const L = g.landing;
  if (!L) return g.gear ? "" : `${g.rows.length} places`;
  if (L.tier >= MAX_TIER && !L.rises) return `already +${MAX_TIER}`;
  const n = g.donors.length;
  if (r === g.host) return L.rises ? `merge ${n} in → +${L.tier}` : `merge ${n} in · frees ${n} slot${n > 1 ? "s" : ""}`;
  if (g.donors.includes(r)) return L.rises ? `into ${whereText(g.host.loc)} → +${L.tier}` : `into ${whereText(g.host.loc)}`;
  return "stays on";
}
/* ONE rule for "is there something to merge here": the cell's colour, the
   focus menu and the header count all read it. A worn pair, a set of stacks
   with no slot to gain, a host already at the cap and a pair of things that
   carry no tier all say no. */
const copiesTodo = g => !g.wornPair && (g.stack ? g.saves > 0
  : !!g.landing && !(g.landing.tier >= MAX_TIER && !g.landing.rises));
// a merge that gains nothing is flagged quietly, not in red
const copiesQuiet = (g, r) => !copiesTodo(g) || (!g.stack && !g.donors.includes(r) && r !== g.host);
function copiesPop(v, g) {
  const I = window.EQLInventory, GS = window.EQLGearScore;
  const place = r => `${r === v.r ? "<b>here</b> · " : ""}${esc(whereText(r.loc))}${r.tier ? ` +${r.tier}` : ""}${r.count > 1 ? ` ×${r.count}` : ""}`;
  const L = g.landing;
  const capped = !!(L && L.tier >= MAX_TIER && !L.rises);
  const lines = g.rows.map(r => {
    const role = g.stack || capped || !g.gear ? ""
      : g.wornPair ? `<span class="dim">worn — stays</span>`
      : r === g.host ? `<span class="ok">merge into this</span>`
      : g.donors.includes(r) ? `<span class="pop__hot">merge this in</span>` : `<span class="dim">worn — stays</span>`;
    return `<tr><td>${place(r)}</td><td>${role}</td></tr>`;
  }).join("");
  let verdict;
  if (g.wornPair) {
    const slot = GS.WORN_RX.exec(GS.rootLoc(g.host.loc))[1];
    verdict = g.rows.length === 2
      ? `Both copies are on. Merging them empties one of your ${esc(slot)} slots.`
      : `All ${g.rows.length} copies are on. Merging any two empties a worn slot.`;
  } else if (g.stack) {
    const sum = g.rows.map(r => r.count).join(" + ");
    verdict = g.saves
      ? `${sum} = ${g.total}. At stacks of ${g.cap} — the biggest you hold — that is ${g.slotsMin} slot${g.slotsMin > 1 ? "s" : ""}, not ${g.rows.length}.`
      : `${sum} = ${g.total}. No slot to gain unless a stack goes past ${g.cap}, the biggest you hold.`;
  } else if (capped) {
    verdict = `The +${MAX_TIER} is at the cap. Merging ${g.donors.map(r => `the +${r.tier}`).join(" or ")} into it gains nothing.`;
  } else if (!g.gear) {
    verdict = `The wiki lists no slot for it, so there is no tier to merge into. If it stacks, putting them together gives ${g.rows.length - 1} slot${g.rows.length > 2 ? "s" : ""} back.`;
  } else {
    const d = g.donors.map(r => `+${r.tier}`).join(" and ");
    verdict = L.rises
      ? `${d} merged into the +${g.host.tier} lands on <b>+${L.tier}</b>` + (L.tier < MAX_TIER ? `, with ${L.toward} of the ${L.nextCost} exp toward +${L.tier + 1}.` : " — the cap.")
      : `${d} merged into the +${g.host.tier} is still <b>+${g.host.tier}</b>, with at least ${L.toward} of the ${L.nextCost} exp toward +${L.tier + 1}.`;
    verdict += ` <span class="dim">A +${g.donors[0].tier} duplicate donates ${I.donation(g.donors[0].tier)} exp; each tier costs twice the one before.</span>`;
  }
  /* the same name on a different item ID is a different item, and the rows
     sit next to each other saying the same thing — say why one is left out */
  const k = itemKey(stripDecor(g.base));
  const others = (INV.rows || []).filter(r => !r.exalt && r.itemId && r.itemId !== g.host.itemId && itemKey(stripDecor(r.name)) === k);
  const note = others.length
    ? `<div class="pop__foot dim">${others.map(r => `${esc(r.name)} in ${esc(whereText(r.loc))} is a different item (ID ${r.itemId}${IDLABEL.has(r.itemId) ? `, ${esc(IDLABEL.get(r.itemId))}` : ""}) — not a copy.`).join("<br>")}</div>` : "";
  return `<div class="pop__head">${g.rows.length} of <b>${esc(g.base)}</b></div><table class="pop__t pop__t--list"><tbody>${lines}</tbody></table><div class="pop__foot">${verdict}</div>${note}`;
}
function xkeepPop(v, u) {
  const lines = u.stones.map(s => {
    const eff = s.effect ? esc(s.effect) : `<span class="dim">${esc(s.stone.row.base)} — effect unknown to the wiki</span>`;
    let state;
    if (s.unique) state = `<span class="pop__keep">the only one you own</span>`;
    else {
      const bits = [];
      for (const e of s.elsewhere) bits.push(e.how === "socketed" ? `in ${esc(e.host.name)} · ${esc(whereText(e.host.loc))}` : `loose · ${esc(whereText(e.row.loc))}`);
      for (const r of s.again) bits.push(`${esc(r.name)} · ${esc(whereText(r.loc))} can yield another`);
      state = `<span class="ok">also ${bits.join("; ")}</span>`;
    }
    const maybe = s.maybe.length ? ` <span class="dim">· a loose ${esc(s.maybe[0].base)} exaltation${s.maybe.length > 1 ? ` (×${s.maybe.length})` : ""} may be one — its source yields more than one effect</span>` : "";
    return `<tr><td>${xKind(s.type)}</td><td>${eff}${s.own ? ` <span class="dim">its own</span>` : ""}</td><td>${state}${maybe}</td></tr>`;
  }).join("");
  return `<div class="pop__head">Exaltations inside <b>${esc(v.r.name)}</b></div><table class="pop__t pop__t--list"><tbody>${lines}</tbody></table>
    <div class="pop__foot">${u.unique
      ? (() => { const n = u.stones.filter(s => s.unique).map(s => s.effect || s.stone.row.base); return `Strip ${esc(n.slice(0, 2).join(" and "))}${n.length > 2 ? ` and ${n.length - 2} more` : ""} before this leaves your bags.`; })()
      : u.stones.length === 1 ? "You hold this one elsewhere too." : "You hold every one of these elsewhere too."}</div>`;
}

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
    // a socket row's title names its host: two Ear rows read alike otherwise
    cell: v => `<td class="iv-where" title="${esc(v.r.loc)}${v.r.parent && window.EQLExalt.socketAt(v.r.loc) ? esc(` · inside ${v.r.parent.name}`) : ""}">${esc(whereText(v.r.loc))}</td>` },
  // sorts on name THEN on which item the ID says it is — otherwise ten rows
  // reading `Old Silver Coin` tie and land in whatever order they came in
  { k: "item", h: "Item", d0: 1, always: true,
    key: v => `${v.r.name} ${IDLABEL.get(v.r.itemId) || ""}`.toLowerCase(), cell: v => {
    // the name already prints "+N" and "(Exaltation)" — no chips restating it
    const badges = (v.r.kids ? `<span class="ivb">${v.r.kids.length} inside</span>` : "") +
      (v.vars ? `<span class="ivb" title="the wiki lists ${v.vars.length} items with this name — the columns show the first; open the row for all of them">${v.vars.length} variants</span>` : "");
    const span = v.r.exalt ? exaltSpan(v.r) : itemSpan(v.r.name, true);
    /* Which one this actually is. Five rows reading `Old Silver Coin` are five
       different items, and the row's own ID is the only thing that says which —
       so it goes beside the name rather than in a column you have to turn on.
       Classic EQ's word for the ID, not EQL's: see the tooltip. */
    const which = v.r.itemId ? IDLABEL.get(v.r.itemId) : null;
    const idl = which ? ` <span class="dim">· <span title="Item ID ${v.r.itemId}. ${
      IDGROUP.has(itemKey(v.r.name)) ? `${IDGROUP.get(itemKey(v.r.name)).length} different items carry this name. ` : ""
      }The name is what classic EverQuest called this ID — EQL has edited some of these strings.">${esc(which)}</span></span>` : "";
    return `<td class="iv-item">${span}${idl}${badges}${spareChips(v)}</td>`;
  } },
  /* ── Rank, Copies, Exaltations — next to the name, ahead of the wide cells */
  { k: "rank", h: "Your trio", d0: 1,
    ht: "Where the item sits among every in-era item one of your three classes can wear in that slot, at +0. "
      + "Each class is scored with its own computed weights, so Stat priorities does not move this number.",
    key: v => { const b = rankOf(v); const x = b && rankTrio(b); return x ? rankKey(x) : null; },
    cell: v => {
      const b = rankOf(v);
      const x = b && rankTrio(b);
      if (!x) return `<td class="iv-n iv-rank is-none"${b ? ` title="None of your three classes can wear this. Any class says what it is worth to somebody."` : ""}></td>`;
      return rankCellHtml(v, x, { pop: "rank" });
    } },
  /* The same item measured for whoever it suits best. In EQL you get to every
     class eventually, so a Cleric-only piece that is #4 for a Cleric is worth
     keeping and one that is #70 is not — a question your current trio cannot
     answer (Kyle, 2026-08-28: "we want to keep the best gear for all classes.
     but if something is CLR only, and is the 10th best CLR item for that slot,
     then we can get rid of it"). Dimmed when it is repeating the trio cell. */
  { k: "rankany", h: "Any class", d0: 1,
    ht: "The best standing the item has for any class that can wear it, including classes you are not playing. "
      + "A Cleric-only piece that is #4 for a Cleric is worth keeping; one that is #70 is not.",
    key: v => { const b = rankOf(v); const x = b && rankAny(b); return x ? rankKey(x) : null; },
    cell: v => {
      const b = rankOf(v);
      const x = b && rankAny(b);
      if (!x) return rankEffOnly(v)
        ? `<td class="iv-n iv-rank is-noscore" title="${esc(NO_SCORE_WHY)}">effect only</td>`
        : `<td class="iv-n"></td>`;
      const t = rankTrio(b);
      return rankCellHtml(v, x, { pop: "rankany", echo: !!t && t.cls === x.cls && t.slot === x.slot });
    } },
  { k: "copies", h: "Copies", d0: -1,
    // what merging wins first, the copy count as the tie-break
    key: v => { const g = COPIES.get(v.r); return g ? (g.stack ? g.saves : g.wornPair ? 0 : g.donors.length) * 100 + g.rows.length : null; },
    cell: v => {
      const g = COPIES.get(v.r);
      if (!g) return `<td class="iv-n"></td>`;
      const quiet = copiesQuiet(g, v.r);
      return `<td class="iv-copies${quiet ? " is-quiet" : " is-hot"}" data-pop="copies:${v.r.id}"><span class="iv-glyph">⧉</span>×${g.rows.length}<span class="iv-nichex">${esc(copiesAction(g, v.r))}</span></td>`;
    } },
  { k: "xkeep", h: "Exaltations", d0: -1,
    key: v => { const u = uniqOf(v); return u ? u.unique : null; },
    cell: v => {
      const u = uniqOf(v);
      if (!u) return `<td class="iv-n"></td>`;
      if (!u.unique) return `<td class="iv-xkeep is-quiet" data-pop="xkeep:${v.r.id}"><span class="dim">${u.stones.length === 1 ? "held elsewhere too" : `all ${u.stones.length} held elsewhere too`}</span></td>`;
      const names = u.stones.filter(s => s.unique).map(s => s.effect || s.stone.row.base);
      return `<td class="iv-xkeep is-hot" data-pop="xkeep:${v.r.id}"><span class="iv-glyph">✦</span>strip first<span class="iv-nichex">${esc(names.slice(0, 2).join(" · "))}${names.length > 2 ? ` +${names.length - 2}` : ""}</span></td>`;
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
  /* Spare proves an item is beaten and then says nothing about what to do
     with it. Same rule and same words as the Sky cleanout list — a merchant
     is the wrong place for anything another player can take. */
  { k: "how", h: "Get rid of it by", d0: 1,
    key: v => (v.trade === "" ? "z" : v.trade === "no drop" || v.trade === "no trade" ? "b" : "a"),
    cell: v => `<td>${disposeHtml({ give: v.trade === "" ? null : !(v.trade === "no drop" || v.trade === "no trade"),
      flag: v.trade === "no drop" ? "NO DROP" : v.trade === "no trade" ? "No Trade" : "" })}</td>` },
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
  { k: "xfire", h: "Fired", d0: -1,
    key: v => exfireOf(v),
    cell: v => { const n = exfireOf(v); return `<td class="iv-n" title="times the log named this exaltation going off — the tail the app read at start plus everything since">${n || ""}</td>`; } },
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
  quest: ["where", "item", "rank", "rankany", "copies", "xkeep", "qty", "quests"],
  gear:  ["where", "item", "bis", "rank", "rankany", "copies", "xkeep"],
  /* Spare exists to reclaim bag space: the disposal route and the weight are
     the two facts that make a row actionable, so they come before the wide
     Beaten-by cell rather than off the right edge behind it. */
  spare: ["where", "item", "ahead", "how", "wt", "beatenby", "rank", "rankany", "copies", "xkeep"],
  exalt: ["where", "item", "tier", "xeff", "xfits", "xfire", "xsock", "xkeep"],
};
const IV_DEFAULT_COLS = IV_DEFAULTS.quest;
/* A saved set is a player's own choice and is kept across a version bump —
   with the columns added since it was written turned on once, because a
   column nobody has heard of cannot be turned on. v3 added the three
   inventory-management columns; v4 added Spare's disposal route and weight;
   v5 split Rank into the trio's standing and any class's. */
const IV_COLS_KEY = "eqlt-companion-invcols-v5";
/* the columns each older set never heard of — only those get switched on;
   a choice a v3 set made about rank/copies/xkeep stands */
const IV_COLS_OLD = ["eqlt-companion-invcols-v4", "eqlt-companion-invcols-v3", "eqlt-companion-invcols-v2"];
const IV_NEW_COLS = {
  "eqlt-companion-invcols-v4": ["rankany"],
  "eqlt-companion-invcols-v3": ["rankany", "how", "wt"],
  "eqlt-companion-invcols-v2": ["rankany", "rank", "copies", "xkeep", "how", "wt"],
};
const IV_MODE_COLS = {};
let IV_SHOW = new Set(IV_DEFAULTS.quest);
function loadInvCols() {
  for (const m of INV_MODES) IV_MODE_COLS[m] = new Set(IV_DEFAULTS[m]);
  try {
    let o = JSON.parse(localStorage.getItem(IV_COLS_KEY)), migrate = null;
    for (const k of IV_COLS_OLD) { if (o) break; o = JSON.parse(localStorage.getItem(k)); if (o) migrate = k; }
    if (o && typeof o === "object") for (const m of INV_MODES) {
      if (Array.isArray(o[m]) && o[m].length) {
        IV_MODE_COLS[m] = new Set(o[m].filter(k => IV_COLS.some(c => c.k === k)));
        if (migrate) for (const k of IV_NEW_COLS[migrate] || []) if (IV_DEFAULTS[m].includes(k)) IV_MODE_COLS[m].add(k);
      }
    }
    if (migrate) saveInvCols();
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
/* Display order follows the mode's default list, then declaration order:
   Gear opens Best for beside the name, Spare opens Better / Beaten by there,
   and the three inventory-management columns come before the wide Quests
   cell in Quest mode. A column the player turns on later lands after. */
const invVisibleCols = () => {
  const pref = IV_DEFAULTS[invMode()] || [];
  const at = c => { const i = pref.indexOf(c.k); return i >= 0 ? i : pref.length + IV_COLS.indexOf(c); };
  return IV_COLS.filter(c => IV_SHOW.has(c.k)).sort((a, b) => at(a) - at(b));
};
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
  /* The badge names only in-era quests: the Quests column marks a locked-era
     quest with its pill (Kyle's call), but this chip has no pill, and in
     Gear/Spare/Exalt it is the only quest signal on the row — "hold this for
     the Paladin Epic" is advice about a quest EQL does not have. */
  const live = v.quests.filter(q => !q.oe);
  if (live.length) out.push(`<span class="ivb ivb--quest" title="${esc(live.map(q => q.n).join(", "))}">quest</span>`);
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
  /* The three management answers again, with room and with links — the hover
     popovers cannot be clicked. */
  const b = rankOf(v);
  if (b) {
    /* Both standings get their own table in the row detail when they differ —
       the two columns, opened up. */
    const seen = new Set();
    for (const x of [rankTrio(b), rankAny(b)]) {
      if (!x || seen.has(x.cls + x.slot)) continue;
      seen.add(x.cls + x.slot);
      parts.push(`<div class="ivd__pop">${rankTable(v, b, x, { n: 5, link: true })}</div>`);
    }
  }
  const cg = COPIES.get(v.r);
  if (cg) parts.push(`<div class="ivd__pop">${copiesPop(v, cg)}</div>`);
  const u = uniqOf(v);
  if (u) parts.push(`<div class="ivd__pop">${xkeepPop(v, u)}</div>`);
  if (!parts.length) parts.push(`<span class="dim">nothing more known about this item</span>`);
  return parts.join("");
}

const INV_HINT = $("invEmpty").innerHTML;
let IV_BYID = new Map();   // row id -> view, for the popovers
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
      + `<b>Fired</b> counts the log lines that name an exaltation going off ("feels alive with power"), from the tail read at start plus everything since. `
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
  /* The focus menu: the rows the inventory-management columns flag. "copies"
     keeps only the rows with something to do — a worn pair and a set of full
     stacks are copies with nothing to merge, and a list you have to re-read
     before acting on is not a to-do list. */
  const focusOk = v => {
    if (!IV.focus) return true;
    if (IV.focus === "copies") { const g = COPIES.get(v.r); return !!g && copiesTodo(g); }
    if (IV.focus === "xkeep") { const u = uniqOf(v); return !!u && u.unique > 0; }
    if (IV.focus === "top") { const b = rankOf(v); const x = b && rankAny(b); return !!x && x.rank <= 10; }
    return true;
  };
  const pool = INV.rows.map(invView).filter(v =>
    modeOk(v) && (!qOnly || v.quests.length) && tradeOk(v) && clsOk(v) && focusOk(v) &&
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
  /* what the whole dump says, whatever the filters show: the two counts a
     bank visit is about */
  const todo = new Set();
  for (const g of COPIES.values()) if (copiesTodo(g)) todo.add(g);
  let slots = 0;
  for (const g of todo) slots += g.stack ? g.saves : g.donors.length;
  let uniq = 0;
  for (const u of UNIQX.values()) uniq += u.unique;
  const mgmt = [todo.size ? `${todo.size} to merge · ${slots} bag slot${slots === 1 ? "" : "s"} back` : "", uniq ? `${uniq} exaltation${uniq > 1 ? "s" : ""} held nowhere else` : ""].filter(Boolean).join(" · ");
  // whose dump this is, when it is not the character the log is on: the table
  // still shows it, but nothing else counts it (see invMine)
  const notMine = !invMine()
    ? ` · ${invChar(INV.file)}'s dump, log is ${SKYL && SKYL.me}'s — shown, but not counted as held`
    : "";
  $("invMeta").textContent =
    `${INV.file} · dumped ${new Date(INV.mtime).toLocaleString()} · ${scope}${wt != null ? ` · ${Math.round(wt * 10) / 10} wt` : ""}${mgmt ? ` · ${mgmt}` : ""}${notMine}`;
  IV_BYID = new Map(rows.map(v => [v.r.id, v]));
  const arrow = k => st.k === k ? (st.d > 0 ? " ▲" : " ▼") : "";
  body.innerHTML = rows.length
    ? `<table class="qtab ivt"><thead><tr>${cols.map(c =>
        `<th class="is-sort${c.k === "item" ? " iv-item" : ""}" data-ivsort="${c.k}"${c.ht ? ` title="${esc(c.ht)}"` : ""}>${c.h}${arrow(c.k)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(v => invRow(v, cols)).join("")}</tbody></table>`
    : `<p class="empty">${invEmptyText(mode)}</p>`;
  retip(); repop();
}

/* Why a mode is showing nothing. "Nothing matches those filters" is wrong for
   two of the three cases and sends you looking for a filter you never set. */
function invEmptyText(mode) {
  const otherFilters = $("invSearch").value.trim() || $("invQuestOnly").checked || IV.trade || IV.cls || mode !== "quest";
  if (IV.focus === "copies" && !otherFilters) return "Nothing in the dump is in two places with something to merge.";
  if (IV.focus === "xkeep" && !otherFilters) return "No item holds an exaltation you have nowhere else.";
  const filtered = otherFilters || IV.focus;
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

/* ── folding ──────────────────────────────────────────────────────────────
   Kyle, 2026-08-16: "i need to be able to collapse quests/zones." A quest
   folds to its head — name, count, facts, Track — and a zone to its heading
   and how many are left. Both are CLOSED-lists over an open default, so a
   quest you track tomorrow and a zone the data learns about next patch arrive
   open rather than hidden by a set written today.

   Zones fold by name, everywhere the name appears: pooled across tracked
   quests and inside each quest's own group. "I'm finished with Lower Guk" is
   a fact about the zone, not about one quest's copy of it.

   Folded detail is never built — no step list, no zone groups, no turn-ins —
   which is what makes a long Turn-ins list cheap to redraw. */
const QFOLD_KEY = "eqlt-companion-qfold-v1";
const QFOLD = { q: new Set(), z: new Set() };
function loadFolds() {
  try {
    const o = JSON.parse(localStorage.getItem(QFOLD_KEY)) || {};
    if (Array.isArray(o.q)) QFOLD.q = new Set(o.q.filter(s => typeof s === "string"));
    if (Array.isArray(o.z)) QFOLD.z = new Set(o.z.filter(s => typeof s === "string"));
  } catch {}
}
function saveFolds() {
  try { localStorage.setItem(QFOLD_KEY, JSON.stringify({ q: [...QFOLD.q], z: [...QFOLD.z] })); } catch {}
}
const qOpen = t => !QFOLD.q.has(t);
const zOpen = z => !QFOLD.z.has(z);
/* Collapse all / expand all reads the carets that are ON SCREEN rather than a
   list it keeps of its own, so it always means "these", whatever the filter and
   whichever view is up: quest rows under Turn-ins and by-quest, zone headings
   under by-zone. Nested zones inside a folded quest aren't touched — they come
   back the way you left them. */
const foldCarets = id => {
  const el = $(id);
  if (!el) return [];
  // quest rows are the outer level wherever there are any; the by-zone view has
  // none, and there the zone headings are what "all" means
  const rows = [...el.querySelectorAll("li.qrow > .qrow__head > [data-fold]")];
  return rows.length ? rows : [...el.querySelectorAll(".zg > .zg__head > [data-fold]")];
};
function paintFoldAll(id) {
  const btn = document.querySelector(`[data-foldall="${id}"]`);
  if (!btn) return;
  const cs = foldCarets(id);
  btn.hidden = cs.length < 2;
  btn.textContent = cs.some(c => c.getAttribute("aria-expanded") === "true") ? "Collapse all" : "Expand all";
}
function foldAll(id) {
  const cs = foldCarets(id);
  const close = cs.some(c => c.getAttribute("aria-expanded") === "true");
  for (const c of cs) {
    const set = c.dataset.fold === "z" ? QFOLD.z : QFOLD.q;
    if (close) set.add(c.dataset.foldkey); else set.delete(c.dataset.foldkey);
  }
  saveFolds();
}
// the twisty. A button, not the heading itself: the heading is a wiki link, and
// a link that sometimes folds instead of opening the page is a trap (page-design 0f)
const caret = (kind, key, open) => `<button class="fold" data-fold="${kind}" data-foldkey="${esc(key)}"
  aria-expanded="${open ? "true" : "false"}" title="${open ? "Collapse" : "Expand"}">${open ? "▾" : "▸"}</button>`;
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
   Held counts come from a `/outputfile inventory` dump plus what the log
   says happened since it: loot, merchant buys ("You purchased 4 Drom's
   Champagne from …" — a line the 2026-08-11 finding wrongly said never
   prints), combines, and hand-ins closed with "You complete the trade".
   One real holding reaches none of that: something parked on your pet
   (/outputfile has no `pet` option, and handing an item over prints
   nothing). It leaves the tracker demanding an item you already own
   (Kyle, 2026-08-11: Ghoulbane on the pet).

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
/* every key a name answers to: raw, decoration-stripped, and the wiki title
   the client name aliases ('Bunker Cell #1' -> 'Bunker Cell No 1') */
function nameKeys(name) {
  const ks = new Set([itemKey(name), itemKey(stripDecor(name))]);
  for (const k of [...ks]) if (QALIAS[k]) ks.add(itemKey(QALIAS[k]));
  return ks;
}
/* The log's own record of what changed hands since the dump — the same
   ledger the Sky board reads (sky-core stream over the tail + live lines).
   Log timestamps are local time; so is the dump's mtime. */
const logTs = ts => { const t = Date.parse(ts); return Number.isFinite(t) ? t : 0; };
const questLedger = () => (SKYL && SKYL.led) || null;
function haveMap() {
  const m = new Map();
  const add = (name, n) => { for (const k of nameKeys(name)) m.set(k, (m.get(k) || 0) + n); };
  // another character's dump contributes nothing and dates nothing: this is
  // then exactly the no-dump path, where the log alone answers (see invMine)
  const mine = invMine();
  for (const r of mine ? INV.rows : []) {
    // an exaltation stone carries the name of an item you no longer own
    if (r.exalt) continue;
    add(r.name, r.count);
  }
  for (const [k, c] of LIVE_HAVE) m.set(k, (m.get(k) || 0) + c);
  // since the dump: buys and combines arrive, closed hand-ins leave
  const led = questLedger(), since = mine ? INV.mtime || 0 : 0;
  if (led) {
    for (const b of led.bought || []) if (logTs(b.ts) > since) add(b.n, b.q);
    for (const c of led.made || []) if (logTs(c.ts) > since) add(c.n, 1);
    /* A player trade or a parcel is an arrival exactly like a buy, and was
       missing here: the floor pass below reads led.received, but the floor
       only fills a row the dump has NONE of, so a second copy handed to you
       after the dump never raised a count the dump already showed. Same
       caveat as bought/made — a hand-sale prints no quantity, so a copy
       received and then vendored after the dump stays counted. */
    for (const e of led.received || []) if (logTs(e.ts) > since) add(e.n, e.q || 1);
    for (const t of led.trades || []) {
      if (logTs(t.ts) <= since) continue;
      for (const [n, q] of t.items) for (const k of nameKeys(n)) if (m.has(k)) m.set(k, Math.max(0, m.get(k) - q));
    }
  }
  /* The log is a FLOOR under the dump, over the whole log. It used to be a
     delta on top of it (only lines newer than the dump), on the premise that
     the dump had already seen everything older — and the dump lies: the
     storage export drops rows (docs/KNOWN-ISSUES.md), so a Trueshot Longbow
     bought from a player on Aug 11 sat in storage through three dumps that
     never listed it, while the log had "Franchise has offered you 1 Trueshot
     Longbow" the whole time (Kyle, 2026-08-16). sky-core's logFloor is the
     arithmetic and the guard (0 for anything ever hand-sold — a sale prints
     no quantity). One more silent exit is visible from here: a render into an
     exaltation leaves a stone wearing the item's name in the dump, and each
     such stone is one copy the log still counts. Rows the floor raised are
     kept in LOG_FLOOR so the row can SAY the count is the log's word.

     The floor fills only a row the dump has NONE of. Where the dump shows the
     item at all, its count stands: the log runs high on gear whose spare
     copies fed an upgrade, and "you hold 3" over a dump that shows 1 would
     tick a two-of quest that isn't done. The bug this answers hides whole
     rows, and a hidden row is a zero. */
  LOG_FLOOR = new Set();
  if (led) {
    const stones = new Map();
    for (const r of mine ? INV.rows : []) if (r.exalt) {
      const b = K.normName(stripDecor(r.name));
      stones.set(b, (stones.get(b) || 0) + 1);
    }
    const seen = new Set();
    const consider = name => {
      if (seen.has(name)) return;
      seen.add(name);
      const keys = nameKeys(name);
      for (const k of keys) if (m.get(k)) return; // the dump (or live loot) has it: its word
      const floor = SKY.logFloor(led, name) - (stones.get(K.normName(name)) || 0);
      if (floor <= 0) return;
      for (const k of keys) { m.set(k, floor); LOG_FLOOR.add(k); }
    };
    for (const n of led.looted.keys()) consider(n);
    for (const e of led.bought) consider(e.n);
    for (const e of led.made) consider(e.n);
    for (const e of led.received) consider(e.n);
  }
  // a mark is a FLOOR, never a sum: re-dumping with the item finally visible
  // must not read as two of them
  for (const [k, v] of HELD) m.set(k, Math.max(m.get(k) || 0, v.c));
  return m;
}
let LOG_FLOOR = new Set(); // itemKeys whose held count is the log's floor, not the dump's row
// is this row's count the log's word rather than the dump's?
const logSaid = name => { for (const k of nameKeys(name)) if (LOG_FLOOR.has(k)) return true; return false; };
/* The article-stripped fallback used to WALK the whole have map, calling
   normName on every key, every time a name missed — and a miss is the ordinary
   case, because most quest items are ones you don't own. At 389 held keys and
   ~14k lookups a render that was 82% of the entire Quests tab: renderQuests()
   took 1.7s, the log tail re-fired it every 500ms, and the window stopped
   answering clicks (Kyle, 2026-08-16: "changing tabs takes seconds"). The walk
   is now an index built once per have map. First key wins, and where both
   spellings hit, the earlier insertion wins — which is the entry the walk
   returned. */
const HAVE_LOOSE = new WeakMap(); // a have map -> its normName index, built on first miss
function haveLoose(have) {
  let ix = HAVE_LOOSE.get(have);
  if (ix) return ix;
  ix = new Map();
  let i = 0;
  for (const [k, c] of have) {
    const nk = K.normName(k);
    if (!ix.has(nk)) ix.set(nk, { c, i });
    i++;
  }
  HAVE_LOOSE.set(have, ix);
  return ix;
}
// how many of a WIKI-named item the player holds: exact, then article-stripped
/* Which of the same-named items you actually hold, by client item ID.

   The DUMP only. The log prints names and never IDs, so a coin looted since
   the last export raises the count without saying which coin it was — see
   unidentified() below, which says so rather than guessing. */
function heldIds() {
  const s = new Set();
  for (const r of INV.rows || []) if (r.itemId && IDLABEL.has(r.itemId)) s.add(r.itemId);
  return s;
}
/* Copies of `name` in hand that the dump can't put an ID on: looted since the
   export, or in a bag the export dropped. The number of pins we cannot honestly
   tick. */
function unidentified(have, name, ids) {
  const held = heldIds();
  const known = ids.filter(id => held.has(id)).length;
  return Math.max(0, heldCount(have, name) - known);
}
function heldCount(have, name) {
  const exact = have.get(itemKey(name)) ?? have.get(itemKey(stripDecor(name)));
  if (exact !== undefined) return exact;
  const ix = haveLoose(have);
  const a = ix.get(K.normName(name)), b = ix.get(K.normName(stripDecor(name)));
  if (a && b) return (a.i <= b.i ? a : b).c;
  return a ? a.c : b ? b.c : 0;
}

/* A quest's shopping list: what is still to be handed in, crossed with what
   you hold. `got` counts items you hold ENOUGH of — with quantities in the
   data, holding one of four Bone Chips is not holding Bone Chips.

   Where the page has a step graph, the list is the INPUTS OF THE STEPS NOT
   YET DONE — nothing else. Handing Tykar his four Drom's Champagne (proven by
   the H. K. 102 in your bag, or by the log's "You complete the trade with
   Tykar Renlin") takes the champagne off the list; the old list re-read
   q.need — a build-time base list that never heard the trade happened —
   and kept demanding it two steps later (Kyle, 2026-08-15).

   Recipes roll up at RUN time, against the bag: an item you can only make
   (no world source; `src[].r`) expands into ingredients for the SHORTFALL
   only, so four Edible Goo in the bag never turn into "Rat Ears 0/1". The
   dataset's `want` is the unexpanded turn-in list; `need` (older, expanded)
   and the flat item list are the fallbacks for stale data. */
function recipeFor(name) {
  const s = srcFor(name);
  if (!s || !s.r || !(s.r.c || []).length) return null;
  // a real world source outranks the recipe: killing for it is an answer
  if ((s.z && s.z.length) || s.many || s.various) return null;
  return s.r;
}
function compsFor(q, have) {
  const ss0 = stepState(q, have);
  const held = n => heldCount(have, n) + ((ss0 && ss0.gained.get(itemKey(n))) || 0);
  /* An item this quest's own steps hand you (give-step `out`) is chain-made,
     not farmed — and the item's GLOBAL src can be a different item wearing the
     same name ('Sealed Note' is five distinct notes on one wiki page; the
     SoulFire one comes from Assistant Kiolna, not The Prophet in Crushbone).
     The step knows better than the item page: source these rows from the
     step's NPC. */
  const steps = q.steps || [];
  const madeBy = new Map();          // itemKey -> [every step producing it]
  const consumed = new Set();        // itemKey of every step input
  for (const st of steps) {
    for (const [n] of st.out || []) {
      const k2 = itemKey(n);
      if (!madeBy.has(k2)) madeBy.set(k2, []);
      madeBy.get(k2).push(st);
    }
    for (const [n] of st.in || []) consumed.add(itemKey(n));
  }
  const ss = ss0;
  const stStateOf = new Map((ss ? ss.states : []).map(s => [s.st, s]));

  // the top-level wants: undone steps' inputs, plus page items no step touches
  const wants = new Map();           // itemKey -> {n, want}
  const want = (n, w) => {
    const k = itemKey(n), cur = wants.get(k);
    if (cur) cur.want += w; else wants.set(k, { n, want: w });
  };
  const top = (q.want && q.want.length ? q.want : q.need && q.need.length ? q.need
    : (q.items || []).map(n => [n, 1]));
  if (ss) {
    for (const s of ss.states) {
      if (s.done) continue;
      for (const [n, w] of s.st.in || []) want(n, w);
    }
    for (const [n, w] of top) {
      const k = itemKey(n);
      if (!consumed.has(k) && !madeBy.has(k)) want(n, w);
    }
  } else {
    for (const [n, w] of top) want(n, w);
  }

  /* The zone list is a "do now" list, so it obeys the step graph the same
     way the checklist does: an item whose EVERY producing step is locked
     behind unmet prereqs (Testimony needs Token of Truth needs Guard Willia
     needs both token turn-ins — Kyle, 2026-08-11) is not something to go
     get yet. `lk` rows stay in the counts and the checklist but never
     render as a zone row until the chain reaches them. */
  const rows = new Map();            // itemKey -> row
  const put = (n, w, via) => {
    const k = itemKey(n), cur = rows.get(k);
    if (cur) { cur.want += w; if (via && cur.via !== via) cur.via = ""; return; }
    const mks = madeBy.get(k) || [];
    // an NPC hands it over — for a turn-in, for coin, or for asking
    const giver = mks.find(st2 => st2.npc && (st2.k === "give" || st2.k === "get" || st2.k === "buy"));
    const st = giver
      ? { npc: giver.npc, k: giver.k, z: giver.z || (NPCLOC[giver.npc] && NPCLOC[giver.npc].z) || "" }
      : undefined;
    const states = mks.map(st2 => stStateOf.get(st2)).filter(Boolean);
    const lk = states.length > 0 && states.every(s2 => !s2.done && !s2.can);
    /* Ten `Old Silver Coin` is one row wanting ten, and it used to bucket into
       all ten cities — so a coin already in the bank still put its city on the
       list. Where every producing step is pinned to a specific item ID, the
       row goes ONLY to the cities whose own coin is still missing, and the
       walk is the five swims you actually have left. Falls back to the item's
       global sources whenever the pinning is partial: a half-pinned set would
       hide a zone that is genuinely still needed. */
    const pins = mks.filter(st2 => st2.iid && st2.z);
    const zs = pins.length > 1 && pins.length === mks.length
      ? [...new Set(pins.filter(st2 => !(stStateOf.get(st2) || {}).done).map(st2 => st2.z))]
      : null;
    rows.set(k, { n, want: w, have: held(n), fr: q.from && q.from[n],
                  ...(st ? { st } : {}), ...(lk ? { lk: true } : {}),
                  ...(zs && zs.length ? { zs } : {}), ...(via ? { via } : {}) });
  };
  const expand = (n, w, depth, via) => {
    const k = itemKey(n);
    // a step makes it, or another quest pays it: the chain says how, no rollup
    if (madeBy.has(k) || (q.from && q.from[n]) || depth >= 3) return put(n, w, via);
    const short = w - held(n);
    const r = short > 0 ? recipeFor(n) : null;
    if (!r) return put(n, w, via);
    // held copies cover their share; only the shortfall costs ingredients
    for (const [qn, ing] of r.c) expand(ing, qn * short, depth + 1, n);
  };
  for (const { n, want: w } of wants.values()) expand(n, w, 0, "");
  const comps = [...rows.values()];
  const got = comps.filter(c => c.have >= c.want).length;
  return { q, comps, got, need: comps.length, done: comps.length > 0 && got === comps.length };
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
        // pinned zones survive pooling only if BOTH quests pin them; one quest
        // that reads the item's global sources needs all of them
        if (!cur.zs !== !c.zs) cur.zs = undefined;
        else if (cur.zs && c.zs) cur.zs = [...new Set([...cur.zs, ...c.zs])];
        cur.lk = cur.lk && c.lk;
      }
      else merged.set(k, { n: c.n, want: c.want, have: c.have, st: c.st, zs: c.zs,
                           lk: !!c.lk, quests: new Map([[name, rew]]) });
    }
  }
  return [...merged.values()].map(r => {
    const names = [...r.quests.keys()];
    const tt = names.map(n => r.quests.get(n) ? `${n} → ${r.quests.get(n)}` : n).join("\n");
    return { n: r.n, want: r.want, have: r.have,
             ...(r.st ? { st: r.st } : {}),
             // the pin has to survive the pool, or zoneBuckets falls back to
             // the item's GLOBAL sources and the pooled zone view sends you to
             // cities whose own coin is already in the bank — the exact walk
             // the pinning exists to shorten. The conflict rule is applied in
             // the merge above (both quests pin: union; only one pins: dropped).
             ...(r.zs && r.zs.length ? { zs: r.zs } : {}),
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

   done, two ways. From the LOG: a give step is done when a closed trade with
   its NPC ("You offered … to X" … "You complete the trade with X") carried
   every input; a combine when "You have fashioned … : <product>" printed; a
   buy when "You purchased N <item>" did — the log the tail read plus every
   line since. From the BAG: a made step (give/combine) is done when its
   product is in hand, or when anything consuming that product is done — you
   can't hold the Gleaming coin without having handed over the Glowing one.
   World pickups pool: holding 3 of the 10 coins marks 3 pins done.

   Notes (`k: "note"`, advice the checklist carries — "obtain warmly faction")
   are shown, never counted and never "doable": nothing could ever tick them. */
const isNote = st => st.k === "note";
// NPC names as the log prints them vs the wiki titles them: case and article
const npcKey = s => String(s || "").toLowerCase().replace(/^(?:a|an|the)\s+/, "").replace(/[`']/g, "").trim();
const sameItem = (a, b) => {
  const ka = nameKeys(a), kb = nameKeys(b);
  for (const k of ka) if (kb.has(k)) return true;
  return K.normName(stripDecor(a)) === K.normName(stripDecor(b));
};
// the closed trade with this NPC that carried everything the step hands over
function tradeProves(led, st) {
  if (!led || !st.npc || !(st.in || []).length) return null;
  const npc = npcKey(st.npc);
  return led.trades.find(t => npcKey(t.npc) === npc &&
    st.in.every(([n, w]) => { let got = 0; for (const [tn, tq] of t.items) if (sameItem(tn, n)) got += tq; return got >= w; })) || null;
}
function stepState(q, have) {
  const steps = q.steps || [];
  if (!steps.length) return null;
  const held = n => heldCount(have, n);
  const led = questLedger();
  const done = new Map();
  const outsHeld = st => (st.out || []).length &&
    st.out.every(([n]) => held(n) >= 1);
  /* What a hand-in the log proved must have put in your bags: an NPC's
     payout prints no item line ("A prisoner hands you something"), so the
     Sealed Note Kiolna handed over after the last dump is invisible to every
     count — except that the step that pays it is proven done. `gained` is
     that credit, per item, for trades newer than the dump: the step's out
     minus what later proven trades consumed, never below zero. */
  const gained = new Map();
  const credit = (n, q) => { const k = itemKey(n); gained.set(k, (gained.get(k) || 0) + q); };
  // another character's dump dates nothing here either — the whole log counts
  const since = invMine() ? INV.mtime || 0 : 0;
  const logged = st => {
    if (!led) return false;
    if (st.k === "give") {
      const t = tradeProves(led, st);
      if (t && logTs(t.ts) > since) {
        for (const [n, q] of st.out || []) credit(n, q);
        for (const [n, q] of st.in || []) credit(n, -q);
      }
      return !!t;
    }
    if (st.k === "combine" && (st.out || []).length)
      return (led.made || []).some(m => sameItem(m.n, st.out[0][0]));
    if (st.k === "buy" && (st.out || []).length)
      return (led.bought || []).some(b => sameItem(b.n, st.out[0][0]));
    return false;
  };
  for (let j = steps.length - 1; j >= 0; j--) {
    const st = steps[j];
    if (isNote(st)) continue;
    const consumerDone = steps.some(s2 => (s2.pre || []).includes(st.i) && done.get(s2.i));
    // world pickups (no inputs) are pooled below — ten coin pins all "hold"
    // the same 3 coins, and marking them all done here read 3/10 as complete
    // A combine whose product IS its container (fill the casket) can't be
    // read off the bag — the empty casket is already there — so only the
    // log or the hand-in after it can tick it.
    const madeNew = (st.out || []).some(([n]) => !(st.tool || []).includes(n));
    done.set(st.i, consumerDone || logged(st) || ((st.in || st.tool) && madeNew ? outsHeld(st) : false));
  }
  /* Pins the data can name: a step whose item ID the build pinned (`iid`) is
     done when THAT ID is in the dump, never when some same-named item is.
     Ten `Old Silver Coin` are ten different items; holding Azia, Beza, Caza,
     Dena and Geza used to tick the first five pins in step order, which said
     Ena was done and Geza wasn't — exactly backwards, and it sent you to
     Grobb for a coin already in the bank. */
  const idHeld = heldIds();
  const pinned = new Set();
  const pinnedItems = new Map();     // item name -> every ID pinned for it
  for (const st of steps) {
    if (!st.iid || isNote(st)) continue;
    pinned.add(st.i);
    if (!done.get(st.i)) done.set(st.i, idHeld.has(st.iid));
    const n = (st.out && st.out[0] && st.out[0][0]) || null;
    if (n) { if (!pinnedItems.has(n)) pinnedItems.set(n, []); pinnedItems.get(n).push(st.iid); }
  }
  // copies in hand the dump can't name — looted since the export. Counted, not
  // guessed at: ticking an arbitrary pin is how the old pooling got it wrong.
  let unnamed = 0;
  for (const [n, ids] of pinnedItems) unnamed += unidentified(have, n, ids);
  // pooled world pickups: the first `held` pins of an item count as done
  const pools = new Map();
  for (const st of steps) {
    if (st.in || st.tool || !(st.out || []).length) continue;
    if (done.get(st.i) || pinned.has(st.i)) continue;
    const n = st.out[0][0];
    if (!pools.has(n)) pools.set(n, []);
    pools.get(n).push(st);
  }
  for (const [n, pins] of pools) {
    // enough in hand for every step that wants it: every way of getting it is
    // done ('Loot from a treant' OR 'from Jyle Windshot' — one Wooden Heart
    // satisfies both, Rain Caller 2026-08-16); otherwise the first `held`
    // pins count (three of the ten coins)
    const needQ = Math.max(1, ...steps.map(s2 => ((s2.in || []).find(([m]) => m === n) || [])[1] || 0));
    if (held(n) >= needQ) { for (const st of pins) done.set(st.i, true); continue; }
    // pins already done via a consumer stay done; these are the leftovers
    const already = steps.filter(s2 => (s2.out || []).some(([m]) => m === n) && done.get(s2.i)).length;
    let k = Math.max(0, Math.min(held(n) - already, pins.length));
    for (const st of pins) { if (k <= 0) break; done.set(st.i, true); k--; }
  }
  const actionable = st => !isNote(st) && !done.get(st.i) &&
    (st.pre || []).every(i => done.get(i));
  const states = steps.map(st => ({
    st, done: !!done.get(st.i), can: actionable(st), note: isNote(st),
  }));
  const next = states.find(s => s.can && (s.st.k === "give" || s.st.k === "combine"))
    || states.find(s => s.can);
  const finalGive = [...steps].reverse().find(st => st.k === "give" && (st.in || []).length);
  const handinReady = !!finalGive && !done.get(finalGive.i) &&
    finalGive.in.every(([n, w]) => held(n) >= w) &&
    (finalGive.pre || []).every(i => done.get(i));
  const real = states.filter(s => !s.note);
  for (const [k, v] of gained) if (v <= 0) gained.delete(k);
  return { states, next: next ? next.st : null, handinReady, gained, unnamed,
           doneN: real.filter(s => s.done).length, total: real.length,
           finished: real.length > 0 && real.every(s => s.done) };
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
  const locked = ss.states.filter(s => !s.note && !s.done && !s.can);
  const notes = ss.states.filter(s => s.note);
  const open = QSTEPS_OPEN.has(q.t);
  const led = questLedger();
  const seen = led && led.first ? `log read from ${esc(String(led.first).replace(/ \d{2}:\d{2}:\d{2}/, ""))}` : "";
  return `<div class="qsteps">
    ${ss.finished ? `<div class="qsteps__done dim">✓ all ${ss.total} steps done${seen ? ` · ${seen}` : ""}</div>`
      : ss.doneN ? `<div class="qsteps__done dim">✓ ${ss.doneN} of ${ss.total} steps done — from the bag${seen ? `, and the ${seen}` : ""}</div>` : ""}
    ${ss.unnamed ? `<div class="qsteps__done dim">${ss.unnamed} more in hand than the dump can name — several items here share one name, and only the export carries the ID that tells them apart. Run /outputfile inventory to place ${ss.unnamed === 1 ? "it" : "them"}.</div>` : ""}
    <ul class="qcomps">${doable.map(s => stepLine(s.st, "is-can")).join("")}</ul>
    ${locked.length ? `<button class="qparts__toggle" data-steps="${esc(q.t)}">${open ? "▾" : "▸"}
      ${locked.length} later step${locked.length === 1 ? "" : "s"} — locked until the ones above are done</button>
      ${open ? `<ul class="qcomps">${locked.map(s => stepLine(s.st, "is-locked")).join("")}</ul>` : ""}` : ""}
    ${notes.length ? `<ul class="qcomps qsteps__notes">${notes.map(s => `<li class="qc qstep is-note dim">${esc(s.st.txt)}</li>`).join("")}</ul>` : ""}
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
    // r.zs: the item's steps are pinned to item IDs, so only the zones whose
    // own copy is still missing count (see compsFor)
    const zs = r.st && r.st.z ? [r.st.z] : r.zs && r.zs.length ? r.zs : bucketsFor(r.n);
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

// how a chain-made row is obtained: the step's NPC and what you do there
const stNote = st => st.k === "get" ? `from ${st.npc}` : st.k === "buy" ? `buy from ${st.npc}` : `turn-in at ${st.npc}`;
// one item row inside a zone bucket: held/needed, and who drops it here
function zoneItemRow(r, zone) {
  const done = r.have >= r.want;
  const src = done ? { mobs: [] }
    : r.st ? { mobs: [], note: stNote(r.st) }
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
  // an ingredient standing in for something you make: say what it is for
  const via = !done && r.via ? `<span class="qsrc dim">for ${esc(r.via)}</span>` : "";
  return `<li class="qc ${done ? "is-have" : ""} ${mark ? "is-marked" : ""}">${holdChk(r)}${itemSpan(r.n)}${count}
    ${r.tag ? `<span class="qtag"${r.tt ? ` title="${esc(r.tt)}"` : ""}>${esc(r.tag)}</span>` : ""}
    ${via}${who ? `<span class="qsrc dim">${who}</span>` : ""}${fr ? `<span class="qsrc dim">${fr}</span>` : ""}
    ${mark ? `<span class="qsrc dim">marked held — the app can't see your pet's bags</span>` : logSaidTag(r.n)}</li>`;
}

/* A held count that is the log's word, not the dump's, says so on the row —
   the same rule the pet mark follows: an inference never dresses as an
   observation. */
const LOG_SAID_TT = "The log has you getting this and never handing it in, destroying it or selling it. The dump doesn't list it — the storage export drops rows.";
const logSaidTag = name => logSaid(name)
  ? `<span class="qsrc dim" title="${LOG_SAID_TT}">log says held — not in the dump</span>` : "";

/* The checkbox on a component row is the "I have this" switch. It carries the
   item name so one delegated listener serves every list that renders a row. */
const holdChk = r =>
  `<span class="kchk kchk--hold" data-hold="${esc(r.n)}" data-want="${r.want || 1}"
     title="${heldMark(r.n) ? "Marked as held — click to clear" : "Mark as held (it's on your pet, or neither the dump nor the log saw it)"}"></span>`;

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
      ${src ? `<span class="qsrc dim">${src}</span>` : ""}${heldMark(r.n) ? "" : logSaidTag(r.n)}</li>`;
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
  return `<div class="zgs">${groups.map(g => {
    const open = zOpen(g.z);
    return `
    <div class="zg ${g.left ? "" : "is-done"} ${open ? "" : "is-folded"}">
      <div class="zg__head">${caret("z", g.z, open)}${zoneLink(g.z)}<span class="zg__n">${g.left ? `${g.left} to get` : "all held"}</span></div>
      ${open ? `<ul class="qcomps">${g.items.map(r => zoneItemRow(r, g.z)).join("")}</ul>` : ""}
    </div>`;
  }).join("")}</div>`;
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
      : c.st ? { mobs: [], note: stNote(c.st) }
      : sourceIn(c.n, zone);
    const note = [c.have < c.want && c.via ? `for ${c.via}` : "", s.isl, s.note].filter(Boolean).join(" · ");
    return {
      n: c.n, have: c.have, want: c.want, url: itemUrl(c.n),
      mobs: s.mobs.slice(0, 3), ...(note ? { note } : {}),
      ...(c.tag ? { tag: c.tag } : {}),
      ...(c.tt ? { tt: c.tt } : {}),
      ...(heldMark(c.n) ? { mk: true } : {}),
      ...(!heldMark(c.n) && logSaid(c.n) ? { lg: true } : {}),
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
    // how old the held counts are: a pet hand-off never reaches a log line
    // (and the log's own receipts only go back as far as the tail it read),
    // so "you still need it" is only ever true as of the last dump — the
    // overlay says so rather than implying live truth
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
        ${holdChk(c)}${itemSpan(c.n)}${c.want > 1 || c.have ? `<span class="qct ${c.have >= c.want ? "is-ok" : ""}">${c.have}/${c.want}</span>` : ""}${heldMark(c.n) ? "" : logSaidTag(c.n)}</li>`).join("")}</ul>
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
  const open = qOpen(q.t);
  return `<li class="qrow ${ready ? "is-ready" : ""} ${tracked ? "is-tracked" : ""} ${open ? "" : "is-folded"}">
    <div class="qrow__head">
      ${caret("q", q.t, open)}
      <a class="wk" data-wiki="${esc(q.wk || q.t || "")}">${esc(q.n)}</a>
      <span class="qprog">${p.got}/${p.need}</span>
      ${facts ? `<span class="dim">${esc(facts)}</span>` : ""}
      <button class="btn btn--mini qtrk" data-track="${esc(q.t)}">${tracked ? "Untrack" : "Track"}</button>
    </div>
    ${open ? questDetail(p, have) : ""}</li>`;
}

/* ── Turn-ins tab — what the inventory says you could hand in ────────────── */
const TURNIN_HINT = $("turninsEmpty").innerHTML;
function renderTurnins() {
  const body = $("turninsBody"), empty = $("turninsEmpty"), banner = $("turninsBanner");
  banner.hidden = !!QDATA;
  if (!QDATA) {
    banner.textContent = "Quest data not loaded yet — refresh from eqltools.com in Settings.";
    $("tiMeta").textContent = ""; body.innerHTML = ""; empty.hidden = true;
    paintFoldAll("turninsBody");
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
    paintFoldAll("turninsBody");
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
  paintFoldAll("turninsBody");
  retip();
}

/* ── Quests tab — the full quest table: search, filter, sort, track ──────── */
function populateQuestFilters() {
  if (!QDATA) return;
  const classes = new Set(), zones = new Set();
  for (const q of QDATA.quests) {
    for (const c of q.classes || []) if (c && c !== "?" && c !== "Any") classes.add(c);
    // the zone list follows the era filter: "in era" never names a locked zone
    if (q.zone && !(QB.era === "in" && q.oe) && !(QB.era === "out" && !q.oe)) zones.add(q.zone);
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
// the count rides the sub-tab chip now, not a top-level tab — and it is painted
// whether or not the Tracked view is the one on screen
function paintTrackedChip() {
  const tab = document.querySelector('[data-qview="tracked"]');
  if (tab) tab.textContent = TRACKED.length ? `Tracked (${TRACKED.length})` : "Tracked";
}
function renderTrackedTab() {
  const banner = $("trackedBanner"), body = $("trackedBody"), empty = $("trackedEmpty");
  const head = $("trackedHead");
  paintTrackedChip();
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
  if (!plans.length) { body.innerHTML = ""; paintFoldAll("trackedBody"); return; }

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
  paintFoldAll("trackedBody");
  retip();
}

/* Three views over one dataset and one of them on screen. Every log line that
   moved the ledger used to redraw all three, so the two you weren't looking at
   cost the same as the one you were. A view you can't see is marked dirty and
   drawn when you switch to it — the sub-tab strip and the tab bar both flush.
   The Tracked chip's count is not part of that: it is painted from the tab bar,
   so it stays live whichever view is up. */
const QDRAW = { turnins: renderTurnins, tracked: renderTrackedTab, all: renderQuestBrowser };
const QDIRTY = new Set(Object.keys(QDRAW));
const qPaneOn = () => { const p = $("tab-quests"); return !!p && p.classList.contains("on"); };
const qLive = v => qPaneOn() && QUEST_VIEW === v;
function drawQuestView(v) {
  if (!qLive(v)) { QDIRTY.add(v); return; }
  QDIRTY.delete(v); QDRAW[v]();
}
function flushQuests() { for (const v of [...QDIRTY]) if (qLive(v)) drawQuestView(v); }
function renderQuests() {
  paintTrackedChip();
  for (const v of Object.keys(QDRAW)) drawQuestView(v);
}

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
  flushQuests(); // the view you just switched to may have gone stale while hidden
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
  // the rollup above the folds: sixteen classes with one stat shape
  rsort: "left", rdir: -1,
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

   Since 2026-08-16 it always finds one: quest-items.json builds the sixteen
   `<Class> Plane of Sky Tests` quests from the `Plane of Sky` page's own
   tables (the same tables sky.json reads), one part per test, named as the
   test is named here — so the wiki key is the normal case. The sky-native key
   remains for a test tracked before that, or when quest-items is older than
   the app; `trackedPlan` resolves both. Whichever key is ALREADY tracked is
   the one a click flips, so an old sky-native entry never gains a wiki-key
   twin. */
const SKY_TRACK = "sky::";
const skyTrackKey = (code, test) => SKY_TRACK + code + "::" + test;
// the quest-tracker key for the same test, when quest-items carries its part
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
  const qk = skyQuestKey(code, test), sk = skyTrackKey(code, test);
  toggleTrack(TRACKED.includes(sk) ? sk : qk && TRACKED.includes(qk) ? qk : (qk || sk));
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

/* One fold per log file. The bootstrap seeds it — every ledger line from the
   whole file before the tail (`head`, prefiltered in main.js), then the 40 MB
   tail itself — and live lines extend it. So this fold, unlike the kill and
   exalt streams, sees the character's whole log: a quest item bought from a
   player a week ago is still "held" here even when the dump can't show it. */
function skyReset(file) {
  const me = (String(file || "").match(/eqlog_([^_]+)_/) || [])[1] || "";
  SKYL = { st: SKY.stream(me), me, file };
  SKYL.led = SKYL.st.led;
  /* ACH_SKY is derived from ACH.parsed AND from who the log is on (achMine),
     and it used to be rebuilt only when an achievements file arrived. A
     character switch changes `me` here, so without this the previous
     character's completed tests stayed applied to the new one's Sky tab. */
  rebuildAchSky();
}
function skySeed(file, text, head) {
  skyReset(file);
  if (head && head.length) SKYL.st.feed(head);
  SKYL.st.text(text);
}
/* Only a line the Sky grammar actually consumed can move this board, and a
   busy zone is thousands of lines a minute that don't. */
function skyFeed(lines) {
  if (!SKYL) return;
  const before = SKYL.led.n;
  SKYL.st.feed(lines);
  // the quest tracker reads the same ledger: a closed trade, a buy or a
  // combine moves a step or a held count there too
  if (SKYL.led.n !== before) { renderSkySoon(); renderQuestsSoon(); }
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
  // haveMap already took post-dump hand-ins off the dump's count — taking
  // them off again here read "2 held, 1 handed in" as 0
  const n = heldCount(have, name);
  return { n: Math.max(0, n), src: !seen && mark ? "mark" : !seen && logSaid(name) ? "log" : "inv" };
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
/* Which key an island takes to stand on. sky.json states it per isle and the
   boss board prints it; a component line named the island and never said what
   the trip costs. */
let SKY_ISLES = null, SKY_ISLES_D = null;
function skyIsleIndex() {
  if (SKY_ISLES && SKY_ISLES_D === SKYD) return SKY_ISLES;
  SKY_ISLES = new Map();
  for (const i of (SKYD && SKYD.isles) || []) SKY_ISLES.set(String(i.isl), i);
  SKY_ISLES_D = SKYD;
  return SKY_ISLES;
}
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
  const placeIdx = skyPlaceIndex();
  const isleIdx = skyIsleIndex();
  const led = SKYL.led;
  const classes = Object.keys(SKYD.classes).sort((a, b) =>
    SKY_CLASS[a].localeCompare(SKY_CLASS[b]));
  const tot = { tests: 0, done: 0, ready: 0, partial: 0, pieces: 0, held: 0 };
  const heldNames = new Set();
  const out = [];
  for (const code of classes) {
    const c = SKYD.classes[code];
    const comp = SKY.completions(SKYD, led, code);
    // Can this class's achievement record be read at all? A granted or
    // token-bought unlock has every criterion force-marked, so it answers
    // neither way and no row under it may claim a first run.
    const achOk = !!(ACH_SKY[code] && ACH_SKY[code].trusted);
    const tests = c.tests.map(t => {
      const items = t.items.map(i => {
        const locs = skyLocs(locIdx, i.n);
        const h = skyHave(have, i.n, locs.length > 0);
        const uses = (SKY_USES.get(itemKey(i.n)) || []).filter(u => u.test !== t.n);
        const isle = i.isl ? isleIdx.get(String(i.isl)) : null;
        return {
          n: i.n, need: 1, have: h.n, src: h.src,
          isl: i.isl || "", mob: i.mob || "", nodrop: !!i.nodrop,
          // what the island takes to reach, so the component line prices the trip
          req: (isle && isle.req) || [],
          /* The three ways a piece leaves without reaching a bank. An autosale
             is stamped on the loot line itself, so it can only be the loot
             filter — nothing that reads an inventory dump can see it. */
          sold: SKY.soldCount(led, i.n), vend: SKY.vendorCount(led, i.n),
          gone: SKY.goneCount(led, i.n),
          star: uses.length > 0,
          starWith: uses.map(u => `${SKY_CLASS[u.code]}: ${u.test.replace(SKY_CLASS[u.code] + " ", "")}`),
          locs,
        };
      });
      const rune = t.rune.map(r => ({
        n: r, short: r.replace("Wind Rune ", ""), need: 1, have: skyHave(have, r).n,
      }));
      const done = comp.byTest[t.n] || 0;
      /* Three witnesses to one turn-in, kept apart so a row can say which one
         it is standing on. None is a player's mark; all three are measurements.

           done  this log watched you hand it over
           ach   the client's achievement record lists the reward as obtained
           rew   the reward is in your dump, and only this giver hands it out
                 (sky-core `rewardProves`)

         Any of them puts the test behind you, so all three suppress "ready". */
      const ach = !!(ACH_SKY[code] && ACH_SKY[code].byTest[t.n]);
      const rew = !!t.reward && SKY.rewardProves(skyRec(t.reward))
        && locIdx.has(itemKey(t.reward));
      const fin = done > 0 || ach || rew;
      /* The negative. Nothing measures "never handed in" — the log only starts
         where it starts and the dump only says what you hold now. The one
         source that can is a class unlock whose criteria are readable: an
         unflagged `Obtain <reward>` under it means you have never had that
         reward. Without that, a row with no witness is unknown, not new. */
      const never = !fin && achOk;
      const skip = skySkipped(code, t.n);
      const st = SKY.testState(t, fin ? Math.max(done, 1) : 0, skip, n => skyHave(have, n, locIdx.has(itemKey(n))).n);
      /* Progress on a test means a COMPONENT of it. Runes are generic — one
         Wind Rune Dena feeds seven different tests, so counting it as progress
         listed all seven as started off a single drop. */
      const held = items.filter(i => i.have >= 1).length;
      tot.pieces += items.reduce((a, i) => a + i.have, 0);
      for (const i of items) if (i.have >= 1) heldNames.add(i.n);
      /* Where the reward stands in its own slot, and what a repeat pays. Both
         are the numbers you decide on standing at the giver, and both were one
         view away in Get-rid-of. Rank is read at +0, the item's own worth;
         the tier is the copy you are holding, which a repeat takes up one. */
      const rk = t.reward ? skyRankOf(t.reward, code, 0) : null;
      const rewN = t.reward ? skyHave(have, t.reward, locIdx.has(itemKey(t.reward))).n : 0;
      const rewP = t.reward && (placeIdx.get(itemKey(t.reward))
        || placeIdx.get(itemKey(stripDecor(t.reward))));
      return {
        code, full: t.n, n: t.n.replace(SKY_CLASS[code] + " ", ""),
        say: t.say || "", reward: t.reward || "", items, rune,
        done, ach, rew, fin, never, ready: st.ready, missing: st.missing.length, held,
        skip, track: skyTracked(code, t.n),
        need: items.length + rune.length,
        rank: rk ? rk.rank : null, of: rk ? rk.of : null, rslot: rk ? rk.slot : "",
        better: rk ? rk.better : [],
        heldTier: rewN ? (rewP ? rewP.tier : 0) : null,
      };
    });
    const nDone = tests.filter(t => t.fin).length;
    const nReady = tests.filter(t => t.ready).length;
    const nRepeat = tests.filter(t => t.fin && t.missing === 0 && !t.skip).length;
    const nPartial = tests.filter(t => !t.ready && !t.fin && t.held > 0).length;
    const nSkip = tests.filter(t => t.skip).length;
    const nLeft = tests.filter(t => !t.fin && !t.skip).length;
    // distinct components, not copies: one Efreeti Zweihander is one piece
    // however many tests it feeds
    const mine = new Set();
    for (const t of tests) for (const i of t.items) if (i.have >= 1) mine.add(i.n);
    tot.tests += tests.length; tot.done += nDone; tot.ready += nReady; tot.partial += nPartial;
    out.push({ code, name: SKY_CLASS[code], giver: c.giver || "", tests,
               nDone, nReady, nRepeat, nPartial, nSkip, nLeft, nHeld: mine.size,
               orphan: comp.orphan,
               achOk, achWhy: (ACH_SKY[code] && ACH_SKY[code].whyText) || "" });
  }
  tot.held = heldNames.size;
  return { classes: out, tot, ach: Object.keys(ACH_SKY).length > 0, isles: skyBossModel(out) };
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
    if (!e) idx.set(i.n, e = { have: i.have, src: i.src, locs: i.locs, uses: [],
                               sold: i.sold, vend: i.vend, gone: i.gone });
    e.uses.push({ code: g.code, cls: g.name, giver: g.giver, test: t.full,
                  short: t.n, reward: t.reward, fin: t.fin,
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
      sold: e ? e.sold : SKY.soldCount(SKYL.led, n),
      vend: e ? e.vend : SKY.vendorCount(SKYL.led, n),
      gone: e ? e.gone : SKY.goneCount(SKYL.led, n),
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
/* A finished test whose pieces are in hand again is a turn-in — the thing
   the widget exists to show at the giver. "Hide finished" hides a finished
   test with NOTHING to hand in; it used to hide every finished test before
   the repeat check ran, so the widget's default filter (ready + hide
   finished) never showed a repeat at all (Kyle, 2026-08-23: "the widget
   isn't showing me things i can turn in (duplicates)"). */
function skyKeep(t, show, hideDone) {
  const repeat = t.fin && t.missing === 0;
  if (hideDone && t.fin && !repeat) return false;
  if (show === "ready") return t.ready || repeat;
  if (show === "held") return t.ready || t.held > 0 || t.fin;
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
/* The check beside a reward you already own, on the boss board — the test rows
   carry ✓N / ✓ recorded already; a use line and the buys cell print the reward
   without a state, so the mark rides the name (site parity, 2026-08-16). */
function skyGot(u) {
  return u && u.fin ? `<span class="sk-got" title="Already yours — you turned it in, your achievement record lists it, or it is in your dump">✓</span>` : "";
}
/* What the log watched happen to a piece that never reached your bags. The
   loot filter selling one on pickup is the case nothing else can see: the
   sale is stamped on the loot line itself, so an inventory dump only ever
   shows what you kept. Loud when a live test still wants the piece and you
   are holding none — that is a filter to fix, not a trip to make. */
function skyLossHtml(i, wanted) {
  const hard = !!wanted && !i.have;
  const out = [];
  if (i.sold) out.push(`<span class="sk-loss${hard ? " sk-loss--hard" : ""}" title="${esc(
    `Your loot filter sold ${i.sold} of these on pickup.`
    + (i.have ? ` You kept ${i.have}.` : hard ? " You are holding none and a test here still wants it." : ""))
  }">autosold ${i.sold}×</span>`);
  if (i.vend) out.push(`<span class="sk-loss" title="${esc(
    `Your log has ${i.vend} merchant sale${i.vend === 1 ? "" : "s"} of this. A merchant line carries no quantity, so this counts sales, not pieces.`)
  }">vendored ${i.vend}×</span>`);
  if (i.gone) out.push(`<span class="sk-loss${hard ? " sk-loss--hard" : ""}" title="${esc(
    `You destroyed ${i.gone}.` + (hard ? " A test here still wants this piece." : ""))
  }">destroyed ${i.gone}×</span>`);
  return out.length ? " " + out.join(" ") : "";
}
function skyPieceHtml(i, wanted) {
  const has = i.have >= i.need;
  const star = i.star
    ? `<span class="sk-star" title="Also wanted by ${esc(i.starWith.join("; "))}">★</span>` : "";
  const locs = i.locs.length ? ` ${i.locs.map(skyBadgeHtml).join(" ")}` : "";
  const where = i.isl ? `<span class="sk-src">${esc(skyIsle(i.isl))}${i.mob ? " · " + esc(i.mob) : ""}</span>` : "";
  // the island's own toll, beside the island — the fact that decides whether
  // the trip is possible at all
  const req = !has && (i.req || []).length
    ? `<span class="sk-req" title="Isle ${esc(String(i.isl))} cannot be reached without it">needs ${i.req.map(n => skyItemSpan(n)).join(", ")}</span>` : "";
  return `<li class="skp ${has ? "is-have" : "is-miss"}">` +
    `<span class="skp__tick" data-hold="${esc(i.n)}" data-want="1" title="${i.src === "mark" ? "Marked as held — click to clear" : has ? "" : "Mark as held (bought it, or it's on your pet)"}">${has ? "✓" : "·"}</span>` +
    skyItemSpan(i.n) + star +
    `<span class="skp__ct" title="${esc(SKY_SRC_NOTE[i.src] || "")}">${i.have}/${i.need}</span>` +
    locs + skyLossHtml(i, wanted) + (has ? "" : where + req) + `</li>`;
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

/* Which turn-in this would be — the question you are actually asking standing
   at the giver (Kyle, 2026-08-16: "i need to know if the turn in is a repeat or
   first time"). The first run of a test is what the class unlock counts; a
   repeat only merges a duplicate reward into the copy you hold to raise its
   upgrade tier.

   Whichever witness answered says so on hover, because they are not equally
   direct: a log turn-in was watched, an achievement flag and a reward in the
   bank are inferences from what you ended up holding. `ready` is what is left
   when nothing can settle it — everything in hand, no turn-in seen, and no
   readable achievement record to say you have never had the reward. */
const skyWitness = t =>
  t.done > 0 ? `Your log shows ${t.done} turn-in${t.done === 1 ? "" : "s"} of this test`
  : t.ach ? `Your achievement record lists ${t.reward} as obtained — that turn-in happened before this log`
  : t.rew ? `${t.reward} is in your inventory dump, and this test is the only place it comes from`
  : "";
function skyStatus(t) {
  if (t.skip) return `<span class="sk-st sk-st--skip">skipped</span>`;
  if (t.fin && t.missing === 0)
    return `<span class="sk-st sk-st--rep" title="${esc(skyWitness(t))}. Handing it in again merges a duplicate into the copy you hold and raises its upgrade tier.">repeat</span>`;
  if (t.fin) return `<span class="sk-st sk-st--done" title="${esc(skyWitness(t))}">done</span>`;
  if (t.ready) return t.never
    ? `<span class="sk-st sk-st--ready" title="Your achievement record doesn't list ${esc(t.reward)}, so this one is still ahead of you. The first run is what the class unlock counts.">first time</span>`
    : `<span class="sk-st sk-st--ready" title="Everything is in hand. Nothing here has seen a turn-in of this test, and without a readable achievement record that is not the same as never.">ready</span>`;
  return `<span class="sk-st sk-st--miss">missing ${t.missing}</span>`;
}

/* Where the reward stands against everything else that class can put in that
   slot, and — on a test you have already run — what handing it in again pays.
   Both were computed one view away in Get-rid-of and printed nowhere near the
   row you decide on. */
function skyRankHtml(t, code) {
  if (!t.rank) return "";
  return ` <span class="skt__rank" title="${esc(`${t.rank} of ${t.of} in-era ${t.rslot} items ${SKY_CLASS[code]} can wear, at +0`
    + (t.better.length ? `. Beaten by ${t.better.join(", ")}.` : ""))}">${t.rank} of ${t.of}</span>`;
}
/* What a repeat pays, from the merge pyramid (inventory-core.mergeLanding):
   the reward arrives at +0 and a +0 duplicate donates 1 exp, so it is a whole
   tier only from +0 — from +4 it is 1 of the 16 exp to +5, and the chip says
   so rather than promising a tier. */
function skyPaysText(tier) {
  const L = window.EQLInventory.mergeLanding(tier, [0]);
  return L.rises
    ? { text: `+${tier} → +${L.tier}`, title: `Handing it in again hands you a +0 duplicate; merged into your +${tier} it lands on +${L.tier}.` }
    : { text: `+${tier} · 1 of ${L.nextCost} exp`, title: `Handing it in again hands you a +0 duplicate worth 1 exp; your +${tier} needs ${L.nextCost} for +${tier + 1}, so it stays +${tier}.` };
}
function skyPaysHtml(t) {
  if (!t.fin || t.missing !== 0 || t.heldTier == null) return "";
  const p = skyPaysText(t.heldTier);
  return `<span class="skt__pays" title="${esc(p.title)}">${esc(p.text)}</span>`;
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
    ? `${esc(r.uses[0].reward || r.uses[0].short)}${skyGot(r.uses[0])}${r.uses.length > 1
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
    <span class="skb__nm">${skyItemSpan(r.n)}${locs}${skyLossHtml(r, r.open > 0)}</span>
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
      <span class="skb__urew">${u.reward ? skyItemSpan(u.reward) : "?"}${skyGot(u)}</span>
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
        <span class="dim">${u.reward ? "→ " + esc(u.reward) + skyGot(u) : ""}</span></button>`).join("")
    + (uses.length > 1 ? `<button type="button" class="skmenu__i skmenu__all" data-skyskipall="${esc(name)}">${
        uses.every(u => u.skip) ? "Un-skip all" : "Skip all"}</button>` : "");
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 8) + "px";
  el.style.top = Math.min(y, window.innerHeight - r.height - 8) + "px";
  SKY_MENU = el;
}

/* ── the rollup ───────────────────────────────────────────────────────────
   Sixteen classes with an identical stat shape: which one is closest to its
   unlock, and where the pieces in your bags are pointed. The folds answer one
   class at a time and nothing answered "which class". Same head()/sort idiom
   as the Get-rid-of tables. */
const SKR_COLS = [
  { k: "cls", h: "Class", d0: 1, key: g => g.name,
    cell: g => `<td><b>${esc(g.name)}</b></td>`, tot: () => `<td><b>All sixteen</b></td>` },
  { k: "giver", h: "Quest giver", d0: 1, key: g => g.giver,
    cell: g => `<td>${g.giver ? mobSpan(g.giver) : ""}</td>`, tot: () => `<td></td>` },
  { k: "tests", h: "Tests", d0: -1, key: g => g.tests.length, n: g => g.tests.length },
  { k: "done", h: "Finished", d0: -1, key: g => g.nDone, n: g => g.nDone, cls: "sk-n--done" },
  { k: "ready", h: "Ready", d0: -1, key: g => g.nReady, n: g => g.nReady, cls: "sk-n--ready" },
  { k: "repeat", h: "Repeat", d0: -1, key: g => g.nRepeat, n: g => g.nRepeat, cls: "sk-n--rep" },
  { k: "skip", h: "Skipped", d0: -1, key: g => g.nSkip, n: g => g.nSkip },
  { k: "left", h: "Left", d0: -1, key: g => g.nLeft, n: g => g.nLeft,
    h2: "Tests neither finished nor skipped — what the class unlock still needs." },
  { k: "held", h: "Pieces held", d0: -1, key: g => g.nHeld, n: g => g.nHeld,
    h2: "Distinct components of this class's tests you are holding at least one of." },
];
function skRollupHtml(m) {
  const rows = m.classes.filter(g => !SKYP.cls || g.code === SKYP.cls);
  if (!rows.length) return "";
  const col = SKR_COLS.find(c => c.k === SKYP.rsort) || SKR_COLS[0];
  const sorted = rows.slice().sort((a, b) =>
    cmpNullLast(col.key(a), col.key(b), SKYP.rdir) || a.name.localeCompare(b.name));
  const arrow = k => SKYP.rsort === k ? (SKYP.rdir > 0 ? " ▲" : " ▼") : "";
  const cell = (c, g) => c.cell ? c.cell(g)
    : `<td class="iv-n"><b class="sk-n ${c.cls || ""}">${c.n(g) || ""}</b></td>`;
  const sum = c => c.n ? sorted.reduce((n, g) => n + c.n(g), 0) : 0;
  // the same piece feeds several classes, so the total holds the distinct
  // names rather than adding the sixteen counts up
  const tots = rows.length < 2 ? "" : `<tfoot><tr>${SKR_COLS.map(c => c.tot ? c.tot(m)
    : `<td class="iv-n"${c.k === "held" ? ` title="distinct pieces across all sixteen — one component feeds several classes, so this is less than the column adds up to"` : ""}><b>${c.k === "held" ? m.tot.held : sum(c)}</b></td>`).join("")}</tr></tfoot>`;
  return `<table class="qtab ivt skr"><thead><tr>${SKR_COLS.map(c =>
      `<th class="is-sort" data-skrsort="${c.k}"${c.h2 ? ` title="${esc(c.h2)}"` : ""}>${esc(c.h)}${arrow(c.k)}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map(g => `<tr>${SKR_COLS.map(c => cell(c, g)).join("")}</tr>`).join("")}</tbody>${tots}</table>`;
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
      g.nRepeat ? `<b class="sk-n sk-n--rep">${g.nRepeat}</b> repeat` : "",
      // "done", not "turned in": this count folds in tests the log never saw
      // handed over, witnessed by the achievement record or by the reward.
      g.nDone ? `<b class="sk-n sk-n--done">${g.nDone}</b> done` : "",
      g.nPartial ? `${g.nPartial} started` : "",
      `${g.tests.length} tests`,
    ].filter(Boolean).join(" · ");
    /* A granted or token-bought unlock force-marks its criteria, so nothing
       under this giver can tell a first run from a repeat unless the log or the
       reward itself says so. Once per class, not once per row. */
    const blind = !g.achOk && m.ach
      ? `<p class="sk-orphan">${esc(g.name)} was ${esc(g.achWhy || "already unlocked")}, so its achievement record marks every test complete and can't say which you ran. A turn-in in this log, or the reward in your dump, still can.</p>`
      : "";
    const orphan = g.orphan
      ? `<p class="sk-orphan">${g.orphan} completed trade${g.orphan === 1 ? "" : "s"} with ${esc(g.giver)} matched no single test — that is what a turn-in split across two trades looks like.</p>`
      : "";
    const tests = rows.map(t => `<div class="skt${t.ready ? " is-ready" : ""}${t.fin ? " is-done" : ""}${t.skip ? " is-skip" : ""}${t.track ? " is-track" : ""}">
      <div class="skt__h">
        <button type="button" class="skt__star${t.track ? " on" : ""}" data-skytrack="${g.code}" data-test="${esc(t.full)}"
          title="${t.track ? "Tracking this one — click to stop" : "Track this test: it stars here and joins the Tracked tab"}"
          aria-pressed="${t.track}">${t.track ? "★" : "☆"}</button>
        <span class="skt__n">${esc(t.n)}</span>
        ${t.say ? `<span class="skt__say" title="Hail ${esc(g.giver)} and say this">say <code>${esc(t.say)}</code></span>` : ""}
        ${skyStatus(t)}
        <!-- the COUNT, and only when there is one to give: a bare tick beside a
             chip already reading "repeat" says the same thing twice, and which
             witness answered is on that chip's hover -->
        ${t.done ? `<span class="skt__done" title="${esc(skyWitness(t))}">✓${t.done}</span>` : ""}
        ${skyPaysHtml(t)}
        <span class="skt__rew">→ ${skyItemSpan(t.reward)}${skyRankHtml(t, g.code)}</span>
        <button type="button" class="skt__skip" data-skyskip="${g.code}" data-test="${esc(t.full)}"
          title="${t.skip ? "Un-skip: count this one again" : "Never doing this one — its pieces stop counting as needed"}">${t.skip ? "un-skip" : "skip"}</button>
      </div>
      <ul class="skt__items">${t.rune.map(skyRuneHtml).join("")}${t.items.map(i => skyPieceHtml(i, !t.fin && !t.skip)).join("")}</ul>
    </div>`).join("");
    return `<section class="skg">
      <button type="button" class="skg__h" data-skyclass="${g.code}" aria-expanded="${open}">
        <span class="skg__caret" aria-hidden="true">${open ? "▾" : "▸"}</span>
        <span class="skg__n">${esc(g.name)}</span>
        <span class="skg__giver">${esc(g.giver)}</span>
        <span class="skg__tally">${tally}</span>
      </button>
      <div class="skg__b"${open ? "" : " hidden"}>${blind}${orphan}${tests}</div>
    </section>`;
  }).join("");

  let html;
  if (SKYP.view === "boss") {
    const b = skyBossHtml(m, q);
    html = b.html; shown = b.shown; openCount = b.openCount;
  } else if (SKYP.view === "drop") {
    const d = skyGetRidHtml(m, q);
    html = d.html; shown = d.shown;
  } else {
    // the rollup answers "which class", the folds answer "which test" — the
    // search box shapes the folds and leaves the summary whole
    const folds = classHtml();
    html = `<div class="skrwrap invwrap">${skRollupHtml(m)}</div>`
      + (folds || `<p class="empty">Nothing matches. Widen <b>show</b>, or clear the search.</p>`);
  }
  body.classList.toggle("sky--boss", SKYP.view === "boss");
  body.innerHTML = html || `<p class="empty">Nothing matches. ${
    SKYP.view === "boss" ? "Clear the search, or untick <b>only what I need</b>." : "Widen <b>show</b>, or clear the search."}</p>`;
  meta.textContent = SKYP.view === "boss"
    ? `${skyTotalNeed(m)} pieces to loot · ${m.tot.done}/${m.tot.tests} tests done · ${shown} shown`
    : SKYP.view === "drop"
    ? `${m.tot.done}/${m.tot.tests} tests done · ${shown} rows`
    : `${m.tot.ready} ready${(r => r ? ` · ${r} repeat` : "")(m.classes.reduce((n, g) => n + g.tests.filter(t => t.fin && t.missing === 0 && !t.skip).length, 0))} · ${m.tot.done}/${m.tot.tests} done · ${m.tot.partial} started · ${shown} shown`;
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
  // Without it, a row with everything in hand can only say "ready": the log
  // starts where it starts, so "no turn-in seen" is not "never turned in".
  if (!m.ach) bits.push("No achievement record — that is the one source that can tell a first run from a repeat on a test you did before this log. Type <code>/outputfile achievements</code> in game.");
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
      /* `fin` and `never` are the repeat-or-first-time answer, resolved here
         like everything else the widget draws; done/ach/rewHeld ride along so
         the row can name the witness on hover. An older overlay build ignores
         the extra keys and falls back to its own done/ach reading. `rew` below
         is the reward ITEM — the witness flag can't share the name. */
      n: t.n, say: w.say ? t.say : "", done: t.done, ach: t.ach, rewHeld: t.rew,
      fin: t.fin, never: t.never, ready: t.ready,
      missing: t.missing, track: t.track,
      rew: skyRef(t.reward),
      items: t.rune.map(r => ({ ...skyRef(r.n), n: "Rune " + r.short, have: r.have, need: 1, rune: true, locs: [] }))
        .concat(t.items.map(i => ({
          ...skyRef(i.n), have: i.have, need: i.need, star: i.star,
          isl: i.have >= i.need ? "" : (i.isl ? skyIsle(i.isl) + (i.mob ? " · " + i.mob : "") : ""),
          // the island's toll, and the three ways the log watched one leave —
          // loud only when this test still wants the piece and you hold none
          req: i.have >= i.need ? "" : (i.req || []).join(", "),
          reqs: i.have >= i.need ? [] : (i.req || []).map(n => skyRef(n)),
          sold: i.sold, vend: i.vend, gone: i.gone, hard: !t.fin && !i.have,
          locs: w.loc ? i.locs.map(b => ({ k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title })) : [],
        }))),
    }));
    // tracked tests lead their giver's fold, same rule as the boss board
    tests.sort((a, b) => (b.track - a.track) || (b.ready - a.ready));
    if (tests.length) groups.push({ code: g.code, name: g.name, giver: g.giver,
                                    ready: tests.filter(t => t.ready).length,
                                    repeat: tests.filter(t => t.fin && t.missing === 0).length,
                                    // a granted unlock's record can't tell a
                                    // first run from a repeat — say so once
                                    blind: !g.achOk && m.ach ? (g.achWhy || "already unlocked") : "",
                                    tests });
  }
  const drop = w.view === "drop" ? pushSkyDrops(m, w) : null;
  const p = { groups, view: w.view === "boss" ? "boss" : w.view === "drop" ? "drop" : "class",
              bosses: w.view === "boss" ? pushSkyBosses(m, w) : [],
              drop,
              ready: m.tot.ready, tests: m.tot.tests, done: m.tot.done,
              loot: skyTotalNeed(m), ach: m.ach,
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
    `<label class="skw__r"><input type="checkbox" data-skyw="hideDone"${w.hideDone ? " checked" : ""}> hide finished tests with nothing to hand in</label>`) +
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
    const rew = !!test.reward && SKY.rewardProves(skyRec(test.reward))
      && locIdx.has(itemKey(test.reward));
    // times done, every witness — the record and the reward each prove one, the
    // log may have watched more
    return { done: Math.max(done, ach || rew ? 1 : 0), logDone: done, ach, rew,
             skip: skySkipped(code, test.n) };
  };
  const o = { top: SKD.top, unlockFirst: SKD.unlockFirst, have: hav,
              rec: skyRec, rank: skyRankOf, state };
  return { tests: SKY.skipRows(SKYD, o), items: SKY.cleanoutRows(SKYD, o) };
}

const skdShort = (code, n) => n.replace((SKY_CLASS[code] || "") + " ", "");

/* What an item is, in one line: the slot it goes in and the numbers on it, at
   the upgrade rank you hold. Same string /sky's boss board prints. */
const SKY_STAT_KEYS = ["ac", "hp", "mana", "end", "atk", "str", "sta", "agi", "dex", "wis", "int", "cha"];
function skyStatText(rec, tier) {
  const T = window.EQLTier, s = T.statsAt(rec, tier || 0), out = [];
  for (const k of SKY_STAT_KEYS) if (s[k]) out.push(`${s[k]} ${k.toUpperCase()}`);
  for (const k in rec.sv || {}) if (k !== "v") out.push(`${rec.sv[k]} SV${k.toUpperCase()}`);
  if (rec.haste) out.push(`${rec.haste}% haste`);
  if (rec.dmg && rec.dly) out.push(`${T.statAt(rec.dmg, tier || 0)}/${rec.dly}`);
  return [(rec.sl || [])[0], out.join(" ")].filter(Boolean).join(" · ");
}

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
      : (p => `<span class="skd__n" title="${esc(p.title)}">${esc(p.text)}</span>`)(skyPaysText(k.tier))}</td>` },
  { k: "rank", h: "Rank", d0: -1, key: k => k.rk.rank,
    cell: k => `<td class="iv-n skd__n" title="against every in-era item ${esc(k.code)} can wear in that slot">${k.rk.rank} of ${k.rk.of}</td>` },
  // sorting by slot groups the rows you would compare against each other; the
  // rank's denominator swings from 116 to 427 on slot alone
  { k: "slot", h: "Slot", d0: 1, key: k => k.rk.slot,
    cell: k => `<td>${esc(k.rk.slot)}</td>` },
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
  /* Keep or destroy is the whole job of this list, and it was asking you to
     decide on a bare name. Blank for the components the wiki gives no
     statsblock. */
  { k: "stats", h: "Stats", d0: 1, key: r => (r.rec && (r.rec.sl || [])[0]) || null,
    cell: r => `<td class="dim">${r.rec ? esc(skyStatText(r.rec, r.tier)) : ""}</td>` },
  { k: "count", h: "Count", d0: -1, key: r => r.count, cell: r => `<td class="iv-n">${r.count}</td>` },
  { k: "wt", h: "Weight", d0: -1, key: r => r.wt * r.count || null,
    cell: r => `<td class="iv-n dim" title="${r.wt} each">${r.wt ? (r.wt * r.count).toFixed(1) : ""}</td>` },
  { k: "how", h: "Get rid of it by", d0: 1, key: r => (r.give ? "a" : r.give === false ? "b" : "z"),
    cell: r => `<td>${skdHow(r)}</td>` },
  { k: "for", h: "Skipped for", d0: 1, key: r => r.uses[0].code,
    cell: r => `<td>${r.uses.map(u => `<span class="skd__w skd__w--skip" title="${esc(SKY_CLASS[u.code] || u.code)} — ${esc(u.test.n)}, you skipped it">${
      esc(u.code)} ${esc(skdShort(u.code, u.test.n))}</span>`).join(" ")}</td>` },
];

/* One rule, one wording, both surfaces: NO DROP → destroy, anything else →
   sell to a player, never a merchant. The Sky cleanout list and the Inventory
   tab's Spare mode are the same decision about the same bags. */
function disposeHtml(o) {
  const clash = o.clash ? ` <span class="skd__w skd__w--clash" title="the item window and the wiki's Plane of Sky table disagree about this one; the window is what the game shows you">wiki disagrees</span>` : "";
  if (o.give === null) return `<span class="dim" title="no item page on the wiki, so nothing here knows whether it is NO DROP">not known</span>`;
  if (o.give) return `<span class="skd__h skd__h--give" title="not NO DROP, so another player can take it${o.wantedBy ? `. ${o.wantedBy} class test${o.wantedBy === 1 ? "" : "s"} use it` : ""}">sell to a player</span>${clash}`;
  return `<span class="skd__h skd__h--nd" title="${esc(o.flag || "NO DROP")} — nobody else can take it, so destroying it is what frees the slot">destroy</span>${clash}`;
}
function skdHow(r) {
  const fl = (r.rec && r.rec.fl) || [];
  return disposeHtml({ give: r.give, wantedBy: r.wantedBy, clash: r.clash,
    flag: fl.includes("no_drop") ? "NO DROP" : fl.includes("no_trade") ? "No Trade" : "" });
}

/* The Get-rid-of view. Was a second `function skyDropHtml` — the same name as
   the By-boss row renderer above; the later declaration hoisted over the
   earlier one, and every drop row on the boss board printed [object Object]
   from 2026-08-14 until this rename. */
function skyGetRidHtml(m, q) {
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
  const tcol = SKD_TCOLS.find(c => c.k === SKD.sort) || SKD_TCOLS.find(c => c.k === "frees");
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
    ${trows.length ? `<div class="skd__scroll"><table class="qtab ivt skd__t2">${head(SKD_TCOLS, "skdtsort", SKD.sort, SKD.dir)}<tbody>${
      trows.map(k => `<tr class="${k.st.skip ? "is-skip" : ""}">${SKD_TCOLS.map(c => c.cell(k)).join("")}<td><button type="button" class="lnk"
        data-skyskip="${esc(k.code)}" data-test="${esc(k.test.n)}">${k.st.skip ? "un-skip" : "skip"}</button></td></tr>`).join("")
    }</tbody></table></div>` : `<p class="empty">Nothing to skip.</p>`}
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
const VL = { classes: ["WAR", "CLR", "WIZ"], level: 50, mem: {}, sort: "where", dir: 1,
  // the before-and-after table under the fetch list
  csort: "d", cdir: -1 };
let VWALK = null;
function loadValetPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(VL_KEY)) || {};
    if (Array.isArray(o.classes) && o.classes.length === 3) VL.classes = o.classes;
    if (o.level) VL.level = Math.min(50, Math.max(1, o.level | 0));
    if (o.mem && typeof o.mem === "object") VL.mem = o.mem;
    // the By slot view's own state: which view, which slot, which columns, the gap toggle
    if (o.vs && typeof o.vs === "object") {
      Object.assign(VS, { view: ["slot", "dress", "pet", "exalt"].includes(o.vs.view) ? o.vs.view : "slot",
        slot: o.vs.slot || "Head", cols: Array.isArray(o.vs.cols) ? o.vs.cols : null, gapAll: !!o.vs.gapAll });
      if (o.vs.petLine) VS.petLine = o.vs.petLine;
      if (o.vs.petRank != null) VS.petRank = o.vs.petRank | 0;
      // sorts and the show-all toggle: only what was actually stored, so a
      // saved set from before they existed keeps this file's defaults
      for (const k of ["xesort", "xedir", "xisort", "xidir", "xnsort", "xndir", "asort", "adir"])
        if (o.vs[k] != null) VS[k] = o.vs[k];
      VS.allOpen = !!o.vs.allOpen;
    }
  } catch (e) {}
}
const saveValetPrefs = () => {
  try { localStorage.setItem(VL_KEY, JSON.stringify({ classes: VL.classes, level: VL.level, mem: VL.mem,
    vs: { view: VS.view, slot: VS.slot, cols: VS.cols, gapAll: VS.gapAll,
          petLine: VS.petLine, petRank: VS.petRank,
          xesort: VS.xesort, xedir: VS.xedir, xisort: VS.xisort, xidir: VS.xidir,
          xnsort: VS.xnsort, xndir: VS.xndir, allOpen: VS.allOpen, asort: VS.asort, adir: VS.adir } })); } catch (e) {}
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
/* The companion's own priorities store: the site's is another origin and
   invisible here (the same wall Sky's skip marks hit). One panel, under the
   trio picker; the same widget the site mounts (vendor/priorities.js). */
const VL_PRIO = window.EQLPriorities ? window.EQLPriorities.localStore("eqlt-companion-priorities-v1") : null;
/* One store, mounted twice: on the Valet tab where the comparisons are, and in
   Settings so there is a place to look for it (Kyle, 2026-08-28: "it is not
   clear at all where i adjust the stat priorities for this tab. there should be
   a common place across the app"). The old note claimed the edits reached
   "every ranking for your trio in this app" — they do not reach the Inventory
   tab's Rank columns, which is what sent him looking. Say what they cover. */
const PRIO_NOTE = "HP-equivalents per point of the stat, computed from your trio and level. "
  + "Hover a stat for the derivation. These weights score the Valet tab — its walk, its slot tables "
  + "and its catalogue gap. The Inventory tab's Your trio and Any class ranks are scored per class "
  + "with that class's own weights and do not read them. The site keeps a separate copy.";
const vlOverrides = () => (VL_PRIO ? VL_PRIO.read() : {});
let VSCORER = null;
function valetScorer() {
  if (!VSCORER) VSCORER = window.EQLGearScore.make({ classes: VL.classes, level: VL.level, race: null,
                                    equipped: VINV && VINV.equipped, D: window.EQL_DATA, overrides: vlOverrides() });
  return VSCORER;
}
function valetRestart() {
  VSCORER = null;
  VWALK = VINV ? window.EQLValet.makeWalk({ rows: VINV.rows, equipped: VINV.equipped,
                                            scorer: valetScorer(), mem: VL_MEM }) : null;
  valetAuditReload();
}

/* ── By slot and Exaltations: the same cores the site runs ─────────────────
   VEXALT is exalt-core's reading of THIS tab's rows (VINV.rows), so a worn
   item in the slot table and the same item in the audit are one object; the
   Inventory tab's EXALT is a different parse of the same dump and is not
   reused here. VAUDIT is per trio. */
let VEXALT = null, VAUDIT = null, VRANKER = null, VRANKER_LVL = 0;
const VS = { view: "slot", slot: "Head", cols: null, gapAll: false, sort: null, dir: 1, gsort: null, gdir: 1,
  petLine: null, petRank: 0, psort: null, pdir: 1,
  // the Exaltations view's three tables, each sorted on its own
  xesort: "fits", xedir: -1, xisort: "empty", xidir: -1, xnsort: "where", xndir: 1,
  // Get dressed: every option for the open step, not only the four cards
  allOpen: false, asort: "score", adir: -1 };
function valetAuditReload() {
  VEXALT = null; VAUDIT = null;
  if (!VINV || !GDATA || !window.EQLExaltCore) return;
  const X = window.EQLExaltCore;
  if (!EXALT_CAT || EXALT_CAT.data !== GDATA) {
    EXALT_CAT = X.build(GDATA); EXALT_CAT.data = GDATA;
    X.setLockedZones(GDATA.zone_oe || []);
  }
  VEXALT = X.readDump(VINV.all || VINV.rows, GDATA, EXALT_CAT);
  VAUDIT = window.EQLValet.exaltAudit({ exalt: VEXALT, trio: VL.classes });
}
function valetRanker() {
  if (!GDATA || !window.EQLInventory) return null;
  if (!VRANKER || VRANKER_LVL !== VL.level || VRANKER.data !== GDATA) {
    VRANKER = window.EQLInventory.makeRanker({ D: GDATA, level: VL.level, combat: window.EQL_DATA });
    VRANKER.data = GDATA; VRANKER_LVL = VL.level;
  }
  return VRANKER;
}
const vlFxName = (name) => String(name).replace(/\s*\((?:Spell|spell|proc|click|worn|focus)\)$/, "");
function vlEffects(rec) {
  const X = window.EQLExaltCore, out = [];
  if (rec.foc) out.push(`<span class="vlfx"><span class="vlfx__k">focus</span> ${esc(vlFxName(rec.foc))}</span>`);
  for (const e of rec.eff || []) {
    if (e.n === rec.foc) continue;
    out.push(`<span class="vlfx"><span class="vlfx__k">${esc((X && X.kindOf(e)) || "effect")}</span> ${esc(vlFxName(e.n))}</span>`);
  }
  return out.join(" ");
}
function vlSockets(w) {
  const X = window.EQLExaltCore;
  if (!w || !w.sockets || !X) return "";
  return X.TYPES.map((t) => {
    const s = w.sockets[t.key];
    if (!s.open) return `<span class="vlsock vlsock--shut" title="${t.label} opens at +${t.at}">${t.label}</span>`;
    if (!s.filled) {
      const e = VAUDIT ? VAUDIT.empty.find((x) => x.w === w && x.type === t.key) : null;
      const n = e ? e.fits.length : 0;
      return `<span class="vlsock vlsock--empty${n ? " vlsock--fit" : ""}" title="${t.label} socket is empty${n ? ` — ${n} exaltation${n === 1 ? "" : "s"} you own fit${n === 1 ? "s" : ""} it` : ""}">${t.label}: empty${n ? ` · ${n} fit` : ""}</span>`;
    }
    const st = s.stone, eff = st && st.stone ? st.stone.effect : null;
    const name = st ? st.row.name.replace(/\s*\(Exaltation\)\*?$/, "") : "?";
    return `<span class="vlsock vlsock--full" title="${t.label}: ${esc(name)}">${t.label}: ${esc(eff ? vlFxName(eff) : name)}</span>`;
  }).join(" ");
}
const VL_SOCK_KNOWN = new Set(["worn", "bags", "bank", "shared"]);
function vlSocketsFor(c) {
  const X = window.EQLExaltCore, r = c.row;
  if (!VEXALT || !X) return null;
  if (c.wornHere || c.wornIn) return VEXALT.worn.find((w) => w.row === r) || null;
  if (!VL_SOCK_KNOWN.has(r.sec)) return null;
  const src = VEXALT.sources.find((s) => s.row === r);
  if (src) return src;
  const sockets = {};
  for (const t of X.TYPES) sockets[t.key] = { open: r.tier >= t.at, filled: false, stone: null };
  return { row: r, sockets };
}
// what the By-slot table is pricing right now: the slot and the AC already on
let VS_CTX = { baseAC: 0, slot: "Head" };
const VS_ATTRS = ["str", "sta", "agi", "dex", "wis", "int", "cha", "atk", "end"];
const vsTopAttrs = () => { const w = valetScorer().w || {}; return VS_ATTRS.slice().sort((a, b) => (w[b] || 0) - (w[a] || 0)).slice(0, 3); };
const vsSvText = (rec) => Object.keys(rec.sv || {}).filter((k) => k !== "v")
  .map((k) => `${rec.sv[k]} ${window.EQLGearScore.SV_NAMES[k] || k.toUpperCase()}`).join(" · ");
const vsStat = (k, h) => ({ k, h, num: 1, def: () => ["ac", "hp", "mana"].includes(k) || vsTopAttrs().includes(k),
  v: (rec, tier) => window.EQLTier.statsAt(rec, tier)[k] || 0, cell: (rec, tier) => { const v = window.EQLTier.statsAt(rec, tier)[k] || 0; return v ? String(v) : ""; } });
const VS_COLS = [
  { k: "rank", h: "#", num: 1, def: true, own: 1, v: (c) => c.rank, cell: (c) => String(c.rank) },
  /* The score opens its own derivation — the panel is the whole reason the
     Stat priorities weights are editable. VS_CTX carries the slot and the AC
     base the table priced this column at; without them a breakdown would not
     total to the number beside it. */
  { k: "score", h: "Score", num: 1, def: true, own: 1, v: (c) => c.score,
    cell: (c) => `<b data-pop="vlwhy:${vlWhy(c.row.rec, c.row.tier, VS_CTX.baseAC, VS_CTX.slot, c.score)}">${Math.round(c.score)}</b>` },
  { k: "item", h: "Item", fixed: 1, def: true },
  { k: "where", h: "Where", def: true, own: 1 },
  { k: "crank", h: "Class rank", def: true, own: 1, v: (c) => (c.catalog ? c.catalog.rank : 9999),
    cell: (c) => (c.catalog ? `<span title="${c.catalog.rank} of ${c.catalog.of} ${esc(c.catalog.slot)} items a ${esc(window.EQLChar.name(c.catalog.cls))} can wear, at +0">${c.catalog.rank} <span class="dim">of ${c.catalog.of} · ${esc(c.catalog.cls)}</span></span>` : "") },
  ...window.EQLGearScore.ITEM_STATS.map(([k, h]) => vsStat(k, h)),
  /* ITEM_STATS is STAT_DEFS minus resists, haste and the weapon ratio — but
     the scorer reads all three, so a row can outrank another on 40 resists or
     10% haste with nothing on screen saying so. Site parity, both off by
     default and both in the picker. SV VOID is the upgrade-rank marker, never
     a resist, so it stays out of the sum (same rule as /gear). */
  { k: "sv", h: "Resists", num: 1, def: false,
    v: (rec) => Object.keys(rec.sv || {}).reduce((n, k) => (k === "v" ? n : n + (+rec.sv[k] || 0)), 0),
    cell: (rec) => { const t = vsSvText(rec); return t ? `<span title="${esc(t)}">${
      Object.keys(rec.sv || {}).reduce((n, k) => (k === "v" ? n : n + (+rec.sv[k] || 0)), 0)}</span>` : ""; } },
  { k: "haste", h: "Haste", num: 1, def: false, v: (rec) => rec.haste || 0,
    cell: (rec) => (rec.haste ? `${rec.haste}%` : "") },
  { k: "ratio", h: "DMG/DLY", num: 1, def: null, v: (rec, tier) => (rec.dmg && rec.dly ? window.EQLTier.statAt(rec.dmg, tier) / rec.dly : 0),
    cell: (rec, tier) => (rec.dmg && rec.dly ? `${window.EQLTier.statAt(rec.dmg, tier)}/${rec.dly} = ${(window.EQLTier.statAt(rec.dmg, tier) / rec.dly).toFixed(2)}` : "") },
  { k: "fx", h: "Effects", def: true, v: (rec) => (rec.eff || []).length + (rec.foc ? 1 : 0), cell: (rec) => vlEffects(rec) },
  { k: "sock", h: "Sockets", def: true, own: 1 },
];
const VS_HANDS = ["Primary", "Secondary", "Range"];
function vsCols() {
  const picked = Array.isArray(VS.cols) ? new Set(VS.cols) : null;
  return VS_COLS.filter((c) => c.fixed || (picked ? picked.has(c.k)
    : (c.def === null ? VS_HANDS.includes(VS.slot) : typeof c.def === "function" ? c.def() : c.def)));
}
function vsSorted(list, cols, key, dir, valueOf) {
  const col = cols.find((c) => c.k === key);
  if (!col) return list;
  return list.slice().sort((a, b) => {
    const av = valueOf(col, a), bv = valueOf(col, b);
    return (typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))) * dir;
  });
}
function renderValetFlags() {
  const s = VAUDIT ? VAUDIT.summary : null, bits = [];
  if (s && s.fillable) bits.push(`<button type="button" class="vl-flag vl-flag--fit" data-vlview="exalt"><b>${s.fillable}</b> empty socket${s.fillable === 1 ? "" : "s"} on what you're wearing can be filled from what you own <span class="dim">(${s.usable} exaltation${s.usable === 1 ? "" : "s"} fit)</span></button>`);
  if (s && s.empty) bits.push(`<button type="button" class="vl-flag" data-vlview="exalt"><b>${s.empty}</b> empty socket${s.empty === 1 ? "" : "s"} on ${s.wornWithEmpty} worn item${s.wornWithEmpty === 1 ? "" : "s"}</button>`);
  $("vlFlags").innerHTML = bits.join("");
  $("vlFlags").hidden = !bits.length;
}
function renderValetSlot() {
  const V = window.EQLValet, GS = window.EQLGearScore, sc = valetScorer();
  const counts = {}, flags = {};
  for (const b of V.BROWSE) counts[b.slot] = V.slotView({ rows: VINV.rows, equipped: VINV.equipped, scorer: sc, slot: b.slot }).owned.length;
  if (VAUDIT) for (const e of VAUDIT.empty) if (e.fits.length) flags[e.w.slot] = 1;
  $("vlSlotPick").innerHTML = V.BROWSE.map((b) =>
    `<button type="button" class="invtab${b.slot === VS.slot ? " is-on" : ""}" data-vlslot="${esc(b.slot)}" title="${flags[b.slot] ? "an exaltation you own fits an empty socket here" : ""}">${esc(b.label)} <span class="invtab__n">${counts[b.slot] || 0}</span>${flags[b.slot] ? `<i class="slotdot"></i>` : ""}</button>`).join("");
  const slot = VS.slot, label = (V.BROWSE.find((b) => b.slot === slot) || {}).label || slot;
  const sv = V.slotView({ rows: VINV.rows, equipped: VINV.equipped, scorer: sc, slot, trio: VL.classes, ranker: valetRanker(), exalt: VEXALT });
  VS_CTX = { baseAC: sv.baseAC || 0, slot };
  $("vlSlotName").textContent = label;
  // names only: the score and sockets sit on the same item's highlighted row below
  $("vlSlotNow").innerHTML = (sv.now.map((n) => n.e.rec ? itemSpan(n.e.name, true) : `<b>${esc(n.e.name)}</b> <span class="warn">no wiki page</span>`).join(` <span class="dim">+</span> `) || `<span class="dim">Nothing in this slot.</span>`)
    + (sv.handsNow && sv.handsNow.off ? `<div class="dim">Main + off together: <b>${Math.round(sv.handsNow.total)}</b> — the number a two-hander has to beat.</div>` : "");
  // columns
  const C = vsCols(), on = new Set(C.map((c) => c.k));
  $("vlOwnCols").innerHTML = VS_COLS.filter((c) => !c.fixed).map((c) => `<label class="chk"><input type="checkbox" data-vlcol="${c.k}" ${on.has(c.k) ? "checked" : ""}> ${esc(c.h)}</label>`).join("")
    + `<button type="button" class="linkish" id="vlColsReset">reset</button>`;
  $("vlOwnCount").textContent = sv.owned.length ? `${sv.owned.length} cop${sv.owned.length === 1 ? "y" : "ies"} fit` : "";
  const valueOf = (col, c) => (col.k === "item" ? c.row.name.toLowerCase() : col.k === "where" ? V.secRank(c.row.sec) * 1000 + (GS.locBadge(c.row.loc).n || 0)
    : col.k === "sock" ? (vlSocketsFor(c) ? 0 : 1) : col.own ? col.v(c) : col.v(c.row.rec, c.row.tier));
  const rows = VS.sort ? vsSorted(sv.owned, C, VS.sort, VS.dir, valueOf) : sv.owned;
  const arrow = (k, s, d) => (s === k ? (d > 0 ? " ▲" : " ▼") : "");
  $("vlOwn").innerHTML = `<table class="qtab ivt"><thead><tr>${C.map((c) => `<th data-vlosort="${c.k}">${esc(c.h)}${arrow(c.k, VS.sort, VS.dir)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((c) => {
      const r = c.row, w = vlSocketsFor(c);
      return `<tr class="${c.wornHere ? "is-worn" : ""}">${C.map((col) => {
        if (col.k === "item") return `<td class="iv-item vl-item">${itemSpan(r.name, true)}${c.twoH ? ` <span class="dim">2H</span>` : ""}${c.unscored.includes("charges") ? ` <span class="warn" title="Its click has charges and runs out.">charges</span>` : ""}${!c.legal ? ` <span class="warn" title="The wiki's class list for this item has none of your three; it is on your body, so the game disagrees.">wiki: not your class</span>` : ""}${c.wornHere && !c.placeable ? ` <span class="warn" title="Without Dual Wield the wiki says a damaging one-hander cannot go here; it is in your off hand, so the game disagrees.">wiki: can't hold it</span>` : ""}</td>`;
        if (col.k === "where") return `<td>${c.wornHere ? `<span class="skl skl--word">on you</span>` : c.wornIn ? `<span class="skl skl--word">on you · ${esc(c.wornIn)}</span>` : vlBadge(r.loc)}</td>`;
        if (col.k === "sock") return `<td>${w ? vlSockets(w) : `<span class="dim" title="The storage bins export no sockets.">not listed</span>`}</td>`;
        return `<td class="${col.num ? "num" : ""}">${col.own ? col.cell(c) : col.cell(r.rec, r.tier)}</td>`;
      }).join("")}</tr>`;
    }).join("") : `<tr><td colspan="${C.length}">Nothing you own fits here.</td></tr>`}</tbody></table>`;
  // the catalogue gap
  const par = sv.parTier, best = sv.owned.length ? sv.owned[0].score : 0;
  const gap = V.slotGap({ scorer: sc, slot, D: GDATA, ownedKeys: V.ownedKeys(VINV.rows, GDATA), baseAC: sv.baseAC, parTier: par });
  const above = gap.items.filter((g) => g.sPar > best);
  const list = VS.gapAll ? gap.items : above;
  $("vlGapCount").textContent = gap.items.length ? `${above.length} of ${gap.items.length} score above your best` : "";
  $("vlGapAll").textContent = gap.items.length > above.length ? (VS.gapAll ? `Show only the ${above.length} above your best` : `Show all ${gap.items.length}`) : "";
  $("vlGapNote").innerHTML = gap.items.length ? `In era, wearable by your trio, not in your dump.${par ? ` <b>+${par}</b> is the rank of your best copy.` : ""}` : "The catalogue has nothing in era your trio can wear here that you don't already own.";
  const GC = C.filter((c) => !c.own);
  const gcols = [{ k: "s0", h: par ? "Score +0" : "Score", num: 1, v: (g) => g.s0 }, ...(par ? [{ k: "sPar", h: `at +${par}`, num: 1, v: (g) => g.sPar }] : []),
    ...GC.map((c) => ({ k: c.k, h: c.h, num: c.num, v: (g) => (c.k === "item" ? g.rec.n.toLowerCase() : c.v(g.rec, par)) })),
    { k: "src", h: "Source", v: (g) => { const d = ((g.rec.src || {}).d || []).find(([z]) => !(GDATA.zone_oe || []).includes(z)); return d ? d[0].toLowerCase() : "~"; } }];
  const grows = VS.gsort ? vsSorted(list, gcols, VS.gsort, VS.gdir, (col, g) => col.v(g)) : list;
  $("vlGap").innerHTML = `<table class="qtab ivt"><thead><tr>${gcols.map((c) => `<th data-vlgsort="${c.k}">${esc(c.h)}${arrow(c.k, VS.gsort, VS.gdir)}</th>`).join("")}</tr></thead><tbody>${
    grows.length ? grows.map((g) => {
      const k = V.catalogRank(valetRanker(), g.rec, slot, 0, VL.classes);
      return `<tr>${gcols.map((col) => {
        if (col.k === "s0") return `<td class="num"><span data-pop="vlwhy:${vlWhy(g.rec, 0, sv.baseAC || 0, slot, g.s0)}">${Math.round(g.s0)}</span></td>`;
        if (col.k === "sPar") return `<td class="num"><b data-pop="vlwhy:${vlWhy(g.rec, par, sv.baseAC || 0, slot, g.sPar)}">${Math.round(g.sPar)}</b></td>`;
        if (col.k === "item") return `<td class="iv-item vl-item">${itemSpan(g.rec.n, true)}${g.twoH ? ` <span class="dim">2H</span>` : ""}${g.variant ? ` <span class="dim" title="The wiki has ${g.variants} pages under this name with different stats.">${esc(g.variant)}</span>` : ""}${g.unscored.includes("charges") ? ` <span class="warn" title="Its click has charges and runs out.">charges</span>` : ""}</td>`;
        if (col.k === "crank") return `<td class="num">${k ? `${k.rank} <span class="dim">of ${k.of} · ${esc(k.cls)}</span>` : ""}</td>`;
        if (col.k === "src") return `<td>${esc(window.EQLExaltCore ? window.EQLExaltCore.sourceText(g.rec) : "")}</td>`;
        const c = GC.find((x) => x.k === col.k);
        return `<td class="${c.num ? "num" : ""}">${c.cell(g.rec, par)}</td>`;
      }).join("")}</tr>`;
    }).join("") : `<tr><td colspan="${gcols.length}">${gap.items.length ? "Nothing in the catalogue scores above your best copy at its rank." : ""}</td></tr>`}</tbody></table>`;
}
/* ── the Pet view: dress the pet out of what dressing YOU did not take ─────
   Same core as the site (vendor/pet-core.js). The player plan is the walk run
   to completion on its own — every open step takes its top card, remembered
   decisions apply through a READ-ONLY view of the memory (pick(key, opt,
   false) would otherwise erase the user's own "remember this" marks). */
function vlAutoPlanTaken() {
  const roMem = { get: VL_MEM.get, set: () => {}, del: () => {} };
  const W = window.EQLValet.makeWalk({ rows: VINV.rows, equipped: VINV.equipped, scorer: valetScorer(), mem: roMem });
  let guard = 0;
  while (!W.done() && guard++ < 60) {
    const opts = W.options();
    if (opts.length) W.pick(W.step().key, opts[0], false); else W.skip();
  }
  const plan = W.planLoadout();
  const taken = new Set();
  for (const it of plan.items) taken.add(it.row.i);
  for (const k of plan.kept) if (k.e.row) taken.add(k.e.row.i);
  return taken;
}
const VL_PET_WHY = {
  ae: (c) => `<span class="warn" title="AE procs never fire from a summoned pet.">AE proc: ${esc(c.n)}</span>`,
  proc: (c) => `<span title="Procs fire even when the pet ignores the weapon for damage. The gate is the pet's base level, before spell rank.">proc: ${esc(vlFxName(c.n))}</span>`,
  proclvl: (c) => `<span class="warn" title="The proc's level requirement reads the pet's base level, before spell rank.">proc at pet ${c.l}: ${esc(vlFxName(c.n))}</span>`,
  hits: () => `<span title="Players put the bar for a one-hander out-damaging a level-50 pet's own swing near 40 damage.">40+ dmg</span>`,
  twoh: () => `<span>2H</span>`,
  bash: () => `<span title="Shield AC raises the pet's bash damage.">bash</span>`,
  haste: (c) => `<span>haste ${c.n}%</span>`,
};
function renderValetPet() {
  const P = window.EQLPetCore;
  const showEmpty = (msg) => {
    $("vlPetEmpty").innerHTML = msg; $("vlPetEmpty").hidden = false;
    $("vlPet").innerHTML = ""; $("vlPetNotes").innerHTML = ""; $("vlPetFoot").textContent = "";
    $("vlPetName").textContent = "Pet"; $("vlPetMath").textContent = "";
    $("vlPetLine").closest(".vl-petpick").hidden = true;
  };
  if (!PETD || !P) return showEmpty("The pet dataset has not loaded — refresh from eqltools.com in Settings.");
  const lines = P.linesFor(PETD, VL.classes);
  if (!lines.length) return showEmpty("No pet class in this trio. Summoned pets come with Magician, Necromancer, Shadow Knight, Enchanter, Beastlord or Shaman.");
  $("vlPetLine").closest(".vl-petpick").hidden = false;
  $("vlPetEmpty").hidden = true;

  const lineKey = lines.some((l) => l.key === VS.petLine) ? VS.petLine : lines[0].key;
  const rank = Math.min(10, Math.max(0, VS.petRank | 0));
  $("vlPetLine").innerHTML = lines.map((l) =>
    `<option value="${esc(l.key)}"${l.key === lineKey ? " selected" : ""}>${esc(l.label)} (${esc(Object.keys(l.owners).find((c) => VL.classes.includes(c)))})</option>`).join("");
  $("vlPetRank").innerHTML = Array.from({ length: 11 }, (_, i) =>
    `<option value="${i}"${i === rank ? " selected" : ""}>+${i}</option>`).join("");

  const pet = P.petAt(PETD, lineKey, VL.classes, VL.level, rank);
  if (!pet) {
    const line = lines.find((l) => l.key === lineKey);
    const first = line.owners[VL.classes.find((c) => line.owners[c])][0].o;
    return showEmpty(`Nothing to summon yet — the first ${esc(line.label)} arrives at level ${first}.`);
  }
  const taken = vlAutoPlanTaken();
  const DP = P.dressPet({ rows: VINV.rows, taken, trio: VL.classes, pet, PD: PETD, effects: GDATA && GDATA.effects });

  $("vlPetName").textContent = `${pet.line.label} — ${pet.cls.join("/")}, level ${pet.level}`;
  $("vlPetMath").innerHTML = `<b>${DP.slotMath.count}</b> pet slots: `
    + DP.slotMath.parts.map((p) => `${p.n} ${esc(p.label === "base" ? "base" : p.label)}`).join(" + ")
    + ` &middot; wears gear for ${DP.allCls.map(esc).join(", ")}`
    + (DP.weightCap ? ` &middot; ${DP.weight} of ~${DP.weightCap} weight` : "");

  const notes = [];
  notes.push(`You are dressed first; the pet picks from the ${DP.pool} usable items your loadout doesn't take.`);
  for (const n of DP.notes) {
    if (n.k === "hasteBuff") notes.push(`No haste item: ${esc(n.buff.n)} (${n.buff.pct}%) from your ${esc(n.buff.cls)} already covers most of the pet's haste cap.`);
    if (n.k === "twoh") notes.push(`A two-hander in the main hand — the pet refuses off-hand items while it holds one.`);
    if (n.k === "nowep") notes.push(`Empty hands: no spare weapon carries a proc the pet can fire, stats worth wearing, or 40+ damage — the pet's own swing beats them all.`);
  }
  if (DP.picks.some((p) => p.kind === "weapon" && p.row.rec.dmg))
    notes.push(`Weapon picks are proc-first: a weapon only out-damages the pet's own swing when it clears the pet's innate (player consensus puts a one-hander's bar near 40 damage at 50), and the dev team says this scaling is being rewritten.`);
  if (DP.weightCap && DP.weight > DP.weightCap)
    notes.push(`<b>${DP.weight} weight</b> on a monk-classed pet — past ~${DP.weightCap} its AC drops.`);
  if (pet.line.seal === "chat") notes.push(`This pet's class pair is player-reported; no pet-window reading yet.`);
  for (const extra of pet.line.notes || []) notes.push(esc(extra));
  $("vlPetNotes").innerHTML = notes.map((n) => `<p class="dim">${n}</p>`).join("");

  const wtCol = !!DP.weightCap;
  const cols = [
    { k: "slot", h: "Slot", v: (p) => DP.picks.indexOf(p) },
    { k: "item", h: "Item", v: (p) => p.row.name.toLowerCase() },
    { k: "why", h: "Why", v: (p) => p.chips.map((c) => c.k).join(" ") },
    { k: "score", h: "Score", num: 1, v: (p) => p.score },
    { k: "where", h: "Where", v: (p) => vlWhereKey(p.row) },
    ...(wtCol ? [{ k: "wt", h: "Wt", num: 1, v: (p) => p.row.rec.wt || 0 }] : []),
  ];
  const arrow = (k) => (VS.psort === k ? (VS.pdir > 0 ? " ▲" : " ▼") : "");
  const rows = VS.psort ? vsSorted(DP.picks, cols, VS.psort, VS.pdir, (col, p) => col.v(p)) : DP.picks;
  $("vlPet").innerHTML = `<table class="qtab ivt"><thead><tr>${cols.map((c) => `<th data-vlpsort="${c.k}">${esc(c.h)}${arrow(c.k)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((p) => {
      const why = p.chips.map((c) => (VL_PET_WHY[c.k] || (() => ""))(c)).join(" ") || (p.kind === "haste" ? "" : `<span class="dim">stats</span>`);
      const where = p.row.sec === "worn" ? `<span class="skl skl--word">on you now</span>` : vlBadge(p.row.loc);
      return `<tr>
        <td>${esc(p.slot)}</td>
        <td class="iv-item vl-item">${itemSpan(p.row.name, true)}</td>
        <td>${why}</td>
        <td class="num">${Math.round(p.score)}</td>
        <td>${where}</td>
        ${wtCol ? `<td class="num">${p.row.rec.wt || ""}</td>` : ""}
      </tr>`;
    }).join("") : `<tr><td colspan="${cols.length}">Nothing usable is left over for the pet.</td></tr>`}</tbody></table>`;

  const sums = P.petStats(DP.picks), bits = [];
  for (const [k, label] of [["hp", "HP"], ["mana", "mana"], ["ac", "AC"], ["str", "STR"], ["agi", "AGI"], ["dex", "DEX"]])
    if (sums.st[k]) bits.push(`<b>${sums.st[k]}</b> ${label}`);
  // incidental haste on a stat pick is dead under a trio pet-haste buff — don't advertise it
  if (sums.haste && !DP.notes.some((n) => n.k === "hasteBuff")) bits.push(`<b>${sums.haste}%</b> haste`);
  $("vlPetFoot").innerHTML = (bits.length ? `This set adds ${bits.join(" · ")} to the pet. ` : "")
    + `<span class="dim">Slot count, legality and what a stat does for a pet are player-reported (Discord, 2026-08); pet classes are read off pet windows.</span>`;
}

const vlStoneName = (row) => row.name.replace(/\s*\(Exaltation\)\*?$/, "");
const vlStoneLink = (it) => (it.rec ? itemSpan(vlStoneName(it.row), true) : esc(vlStoneName(it.row)));
const vlStoneWhere = (it) => (it.host ? `${vlBadge(it.host.row.loc)} <span class="dim">in ${esc(it.host.row.name)}</span>`
  : it.row.sec === "exalts" ? "" : vlBadge(it.row.loc));
const vlWornLine = (w) => `<b>${esc(w.slot)}</b> · ${w.rec ? itemSpan(w.row.name, true) : esc(w.row.name)}`;
const vlDefsHtml = (it) => (it.unknown ? `<span class="dim">no wiki page for its source</span>`
  : it.defs.map((d) => `<span class="vlfx"><span class="vlfx__k">${esc(d.type)}</span> ${esc(vlFxName(d.effect))}</span>`).join(" "));
const vlWhereKey = (row) => window.EQLValet.secRank(row.sec) * 1000 + (window.EQLGearScore.locBadge(row.loc).n || 0);
/* What a candidate for one empty socket actually GRANTS. Three rows reading
   "Serpentine Bracer, Serpentine Bracer, Ivory Bracelet" are three source
   items and no choice; the effect is the choice. */
function vlFitHtml(it, type) {
  const d = (it.defs || []).find((x) => x.type === type);
  const maybe = it.maybe
    ? ` <span class="dim" title="The dump does not say which of its source's effects a loose exaltation holds.">one of ${it.defs.length}</span>` : "";
  const where = vlStoneWhere(it);
  return (d ? `<b>${esc(vlFxName(d.effect))}</b> <span class="dim">from</span> ` : "")
    + vlStoneLink(it) + maybe + (where ? " " + where : "");
}

/* The three tables, each a list of records — so each sorts on every column.
   Same column-def idiom as By slot's own table. */
const VX_ECOLS = [
  { k: "slot", h: "Slot", d0: 1, key: (x) => x.w.slot, cell: (x) => `<td>${esc(x.w.slot)}</td>` },
  { k: "item", h: "Item", d0: 1, key: (x) => x.w.row.name.toLowerCase(),
    cell: (x) => `<td class="iv-item vl-item">${x.w.rec ? itemSpan(x.w.row.name, true) : esc(x.w.row.name)}</td>` },
  /* The answer before the four socket chips: the chips are the widest cell on
     the row and pushed the column this table exists for off the edge. */
  { k: "fits", h: "Exaltations you own that fit an empty one", d0: -1, key: (x) => x.fits || null,
    cell: (x) => `<td>${x.es.filter((e) => e.fits.length).map((e) =>
      `<span class="dim">${esc(window.EQLExaltCore.TYPE[e.type].label)}:</span> ${e.fits.map((it) => vlFitHtml(it, e.type)).join(", ")}`).join("<br>")
      || (x.w.rec ? "" : `<span class="dim">no wiki page, so nothing can be fitted</span>`)}</td>` },
  { k: "sock", h: "Sockets", d0: -1, key: (x) => x.es.length, cell: (x) => `<td>${vlSockets(x.w)}</td>` },
];
const VX_ICOLS = [
  { k: "where", h: "Where", d0: 1, key: (it) => vlWhereKey(it.host ? it.host.row : it.row),
    cell: (it) => `<td>${vlBadge(it.row.loc)}${it.host ? `<br><span class="dim">in ${esc(it.host.row.name)}</span>` : ""}</td>` },
  { k: "stone", h: "Exaltation", d0: 1, key: (it) => vlStoneName(it.row).toLowerCase(),
    cell: (it) => `<td class="iv-item vl-item">${vlStoneLink(it)}</td>` },
  { k: "eff", h: "Effect", d0: 1, key: (it) => (it.defs[0] ? vlFxName(it.defs[0].effect).toLowerCase() : null),
    cell: (it) => `<td>${vlDefsHtml(it)}${it.maybe ? ` <span class="dim" title="The dump does not say which of its source's effects a loose exaltation holds.">one of these</span>` : ""}</td>` },
  { k: "empty", h: "Fits an empty socket", d0: -1, key: (it) => it.homes.empty.length || null,
    cell: (it) => `<td>${it.homes.empty.map((x) => `${vlWornLine(x.w)} <span class="dim">${esc(window.EQLExaltCore.TYPE[x.type].label)}</span>`).join("<br>")}</td>` },
  { k: "occ", h: "Would replace", d0: -1, key: (it) => it.homes.occupied.length || null,
    cell: (it) => `<td>${it.homes.occupied.map((x) => `${vlWornLine(x.w)} <span class="dim">${esc(window.EQLExaltCore.TYPE[x.type].label)}${x.current && x.current.stone ? ` · now ${esc(vlFxName(x.current.stone.effect))}` : ""}</span>`).join("<br>")}</td>` },
  { k: "later", h: "After an upgrade", d0: -1, key: (it) => it.homes.later.length || null,
    cell: (it) => `<td>${it.homes.later.map((x) => `${vlWornLine(x.w)} <span class="dim">${esc(window.EQLExaltCore.TYPE[x.type].label)} at +${x.needs}</span>`).join("<br>")}</td>` },
];
const VX_NCOLS = [
  VX_ICOLS[0], VX_ICOLS[1], VX_ICOLS[2],
  { k: "why", h: "Why", d0: 1, key: (it) => it.why || null, cell: (it) => `<td>${esc(it.why || "")}</td>` },
];
function vxTable(id, cols, rows, attr, sort, dir, rowCls, empty) {
  const col = cols.find((c) => c.k === sort);
  const list = col ? rows.slice().sort((a, b) => cmpNullLast(col.key(a), col.key(b), dir)) : rows;
  const arrow = (k) => (sort === k ? (dir > 0 ? " ▲" : " ▼") : "");
  $(id).innerHTML = `<table class="qtab ivt"><thead><tr>${cols.map((c) =>
    `<th class="is-sort" data-${attr}="${c.k}">${esc(c.h)}${arrow(c.k)}</th>`).join("")}</tr></thead><tbody>${
    list.length ? list.map((r) => `<tr class="${rowCls ? rowCls(r) : ""}">${cols.map((c) => c.cell(r)).join("")}</tr>`).join("")
      : `<tr><td colspan="${cols.length}">${empty}</td></tr>`}</tbody></table>`;
}
function renderValetExalt() {
  const a = VAUDIT;
  const byItem = new Map();
  for (const e of (a ? a.empty : [])) (byItem.get(e.w) || byItem.set(e.w, []).get(e.w)).push(e);
  const items = [...byItem.entries()].map(([w, es]) => ({ w, es, fits: es.reduce((n, e) => n + e.fits.length, 0) }))
    .sort((x, y) => y.fits - x.fits || x.es.length - y.es.length);
  vxTable("vlExEmpty", VX_ECOLS, items, "vlxesort", VS.xesort, VS.xedir,
    (x) => (x.fits ? "is-worn" : ""), "Every open socket on what you're wearing has something in it.");
  const all = a ? a.idle : [];
  const idle = all.filter((it) => it.homes.empty.length || it.homes.occupied.length || it.homes.later.length);
  const none = all.filter((it) => !idle.includes(it));
  $("vlExIdleN").textContent = idle.length ? `${idle.length}` : "";
  $("vlExNoneN").textContent = none.length ? `${none.length}` : "";
  vxTable("vlExIdle", VX_ICOLS, idle, "vlxisort", VS.xisort, VS.xidir, null,
    all.length ? "None of them fits anything you're wearing." : "Every exaltation you own is socketed into something you're wearing.");
  vxTable("vlExNone", VX_NCOLS, none, "vlxnsort", VS.xnsort, VS.xndir, null,
    "Every exaltation you own fits something you're wearing.");
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
    $("vlSlotView").hidden = true; $("vlExaltView").hidden = true; $("vlPetView").hidden = true; $("vlFlags").hidden = true;
    if (INV.problem) empty.textContent = INV.problem;
    meta.textContent = "";
    return;
  }
  empty.hidden = true;
  // the score-breakdown builders belong to whatever this render draws
  VL_POPS = new Map();
  meta.textContent = `${INV.file} · ${VINV.rows.length} items · ${VL.classes.join("/")} at ${VL.level}`;
  renderValetFlags();
  for (const b of $("vlViews").querySelectorAll("[data-vlview]")) b.classList.toggle("is-on", b.dataset.vlview === VS.view);
  $("vlSlotView").hidden = VS.view !== "slot"; $("vlExaltView").hidden = VS.view !== "exalt";
  $("vlPetView").hidden = VS.view !== "pet";
  run.hidden = true; done.hidden = true;
  if (VS.view === "slot") renderValetSlot();
  else if (VS.view === "exalt") renderValetExalt();
  else if (VS.view === "pet") renderValetPet();
  else if (VWALK.done()) { done.hidden = false; renderValetDone(); }
  else { run.hidden = false; renderValetRun(); }
}

/* The AC already assigned when the walk reaches a step — the base its own
   candidates were priced against. advance() accumulates it in step order, so
   walking the picks the same way reproduces it exactly, and a breakdown totals
   to the number printed on the card. */
function vlBaseAC(step) {
  const V = window.EQLValet;
  let ac = 0;
  for (const s of VWALK.steps) {
    if (s.key === step.key) break;
    const p = VWALK.picks[s.key];
    if (p) for (const it of p.items) ac += V.acOf(it.row.rec, it.row.tier);
  }
  return ac;
}
/* The worn socket record for a step's occupant. exalt-core walks the dump in
   the same order parseInventory does and normalises Finger/Ring the same way,
   so the nth worn entry for a slot is the nth equipped one. */
function vlWornAt(step) {
  if (!VEXALT) return null;
  const n = +(step.key.split("#")[1] || 1);
  return VEXALT.worn.filter((w) => w.slot === step.slot)[n - 1] || null;
}
/* Whoever is in the slot right now, priced in the candidates' own context —
   the same scorer call optionsFor makes, at the same AC base. Without it four
   scores are shown and the only number they are measured against is off
   screen. Not read off the option list: a worn piece an earlier step already
   claimed is not in the list for the step it is sitting in. */
function vlOccupant(step) {
  const now = VWALK.wearingAt(step);
  if (!now.length) return null;
  const e = now[0];
  return { e, w: vlWornAt(step),
           score: e.rec ? valetScorer().score(e.rec, e.tier, vlBaseAC(step), step.slot) : null };
}
/* A worn piece the plan puts on again at another step has not come off — it
   moves (Ear #2 to Ear #1, Back to Any Slot). Matched by row identity:
   valet-core hands each worn entry its dump row. A moved piece keeps its
   exaltations, so no strip chip; its gain arithmetic is unchanged (it is
   subtracted here and added back at the step that wears it). */
function vlMovedTo(step, occ) {
  if (!occ || !occ.e || !occ.e.row || !VWALK) return null;
  for (const s of VWALK.steps) {
    if (s.key === step.key) continue;
    const p = VWALK.picks[s.key];
    if (p && p.items.some(it => it.row === occ.e.row)) return s;
  }
  return null;
}
/* An item coming off takes its exaltations with it. The Inventory tab's own
   framing, on the row where the swap is being decided. */
function vlStripEffects(w) {
  if (!w || !w.sockets) return [];
  const X = window.EQLExaltCore, eff = [];
  for (const t of X.TYPES) {
    const s = w.sockets[t.key];
    if (!s || !s.filled) continue;
    eff.push(s.stone && s.stone.stone ? vlFxName(s.stone.stone.effect) : s.stone.row.base);
  }
  return eff;
}
const vlStripCount = (w) => vlStripEffects(w).length;
function vlStripHtml(w, names) {
  const eff = vlStripEffects(w);
  if (!eff.length) return "";
  const list = eff.join(" · ");
  return ` <span class="vl-strip" title="${esc(`${eff.length === 1 ? "Its exaltation comes" : "Its exaltations come"} off with it: ${list}`)}">✦ holds ${eff.length} exaltation${eff.length === 1 ? "" : "s"} — strip first</span>`
    + (names ? ` <span class="dim">${esc(list)}</span>` : "");
}
const vlGainHtml = (gain) => (gain == null ? `<span class="dim" title="What is on you now has no wiki page, so nothing here can be measured against it.">—</span>`
  : `<b class="${gain > 0 ? "up" : gain < 0 ? "down" : ""}">${gain > 0 ? "+" : ""}${Math.round(gain)}</b>`);

/* Why a score is that score. `#ivpop` already floats a panel beside the
   cursor off a data-pop attribute; this registry is what a Valet pop reads,
   rebuilt with the view. Site parity — /valet's `why` and `why2` tooltips
   exist because Kyle asked why 18 AC was worth less than he expected. */
let VL_POPS = new Map();
let VL_POP_N = 0;
function vlWhy(rec, tier, baseAC, slot, head) {
  const id = "v" + (++VL_POP_N);
  VL_POPS.set(id, () => {
    const b = window.EQLValet.breakdown(rec, tier, baseAC, slot, valetScorer());
    // the printed parts add up to the printed score: rounding residue lands on the largest part
    const shown = Math.round(head != null ? head : b.total);
    const rv = b.parts.map((p) => Math.round(p.v));
    const resid = shown - rv.reduce((a, x) => a + x, 0);
    if (rv.length && resid) { let big = 0; rv.forEach((x, i) => { if (Math.abs(x) > Math.abs(rv[big])) big = i; }); rv[big] += resid; }
    return `<div class="pop__head"><b>${esc(rec.n)}${tier ? ` +${tier}` : ""}</b> · score ${shown}</div>`
      + `<table class="pop__t pop__t--list"><tbody>${b.parts.map((p, i) =>
        `<tr><td>${esc(p.k)}</td><td class="pop__n">${p.n}</td><td class="pop__n">× ${p.w}</td><td class="pop__score">${rv[i]}</td><td class="dim">${
          p.w === 0 ? "worth nothing to this trio" : p.cap ? "past the AC softcap" : ""}</td></tr>`).join("")}</tbody></table>`
      + `<div class="pop__foot">HP-equivalents for ${esc(VL.classes.join("/"))} at ${VL.level}, against ${Math.round(baseAC)} AC already on. Change the weights under Stat priorities.</div>`;
  });
  return id;
}
/* A name inside a clickable row: the tooltip rides the name and the wiki page
   gets its own ↗ affordance, so clicking the row is only ever the row's own
   action (page-design 0f). */
function vlNameCell(name) {
  const ti = lookupLoose(TIDX, TIDX_L, name);
  const base = (TDATA && TDATA.base) || (DATA && DATA.base) || "";
  return `<span class="itn" data-tt="${esc(name)}">${esc(name)}</span>`
    + (ti && base ? ` <span class="vl-out" data-url="${esc(base + ti.t)}" title="Open ${esc(name)} on the wiki">↗</span>` : "");
}

function renderValetRun() {
  const step = VWALK.step(), all = VWALK.options(), opts = all.slice(0, 4);
  const baseAC = vlBaseAC(step);
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
  const occ = vlOccupant(step);
  const moved = vlMovedTo(step, occ);
  $("vlNow").innerHTML = occ
    ? "On you now: " + (occ.e.rec ? `<b>${itemSpan(occ.e.name, true)}</b>` : `<b>${esc(occ.e.name)}</b>`)
      + (occ.e.rec ? "" : ` <span class="warn">no wiki page — nothing here can be compared against it</span>`)
      + (occ.score != null ? ` <span class="vl-nowscore" data-pop="vlwhy:${vlWhy(occ.e.rec, occ.e.tier, baseAC, step.slot, occ.score)}">${Math.round(occ.score)}</span>` : "")
      + (moved ? ` <span class="dim">· this plan moves it to ${esc(moved.label)}</span>` : vlStripHtml(occ.w, true))
    : "nothing in this slot";
  $("vlCards").innerHTML = opts.map((o, n) => {
    const it0 = o.items[0];
    const gain = occ && occ.score != null ? o.score - occ.score : null;
    return `
    <div class="vlc" role="button" tabindex="0" data-vlopt="${n}">
      <div class="vlc__s" data-pop="vlwhy:${vlWhy(it0.row.rec, it0.row.tier, baseAC, it0.slot, o.score)}">${Math.round(o.score)}</div>
      ${occ ? `<div class="vlc__d ${gain > 0 ? "up" : gain < 0 ? "down" : ""}" title="${esc(`Against ${occ.e.name}${moved ? `, which this plan moves to ${moved.label}` : ""}, priced at the same AC base`)}">${
        gain == null ? "" : (gain > 0 ? "+" : "") + Math.round(gain)}</div>` : ""}
      ${o.items.map(it => `<div class="vlc__i">
        <div class="vlc__n">${vlNameCell(it.row.name)}</div>
        <div class="vlc__st">${vlStat(it.row.rec, it.row.tier)}</div>
        <div class="vlc__w">${vlBadge(it.row.loc)}${o.items.length > 1 ? ` <span class="dim">${esc(it.slot)}</span>` : ""}</div>
      </div>`).join("")}
    </div>`;
  }).join("") || `<p class="dim">Nothing you own fits here.</p>`;
  /* The four cards are the decision; everything else that fits is one click
     away as a sortable table. A cap that does not say it is a cap is a tool
     lying — on Any Slot the cards are 4 of 95. */
  $("vlAllWrap").hidden = all.length <= 4;
  $("vlAllToggle").textContent = VS.allOpen ? `Show the four best only` : `Show all ${all.length}`;
  $("vlAll").hidden = !VS.allOpen;
  if (VS.allOpen && all.length > 4) renderValetAll(all, occ, baseAC);
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

/* Every option for the open step, with the numbers the cards only summarise.
   Clicking a row picks it, same as clicking a card — so the item name carries
   a tooltip and its wiki page gets a separate ↗ (page-design 0f). */
const VA_COLS = [
  { k: "score", h: "Score", d0: -1, num: 1, key: (o) => o.score },
  { k: "gain", h: "Gain", d0: -1, num: 1, key: (o) => (o.__gain == null ? null : o.__gain) },
  { k: "item", h: "Item", d0: 1, key: (o) => o.items.map((it) => it.row.name).join(" + ").toLowerCase() },
  { k: "where", h: "Where", d0: 1, key: (o) => vlWhereKey(o.items[0].row) },
  { k: "tier", h: "Tier", d0: -1, num: 1, key: (o) => o.items[0].row.tier || null },
  ...["ac", "hp", "mana", "atk"].map((k) => ({ k, h: k.toUpperCase(), d0: -1, num: 1,
    key: (o) => window.EQLTier.statsAt(o.items[0].row.rec, o.items[0].row.tier)[k] || null })),
  { k: "ratio", h: "DMG/DLY", d0: -1, num: 1, key: (o) => { const r = o.items[0].row;
    return r.rec.dmg && r.rec.dly ? window.EQLTier.statAt(r.rec.dmg, r.tier) / r.rec.dly : null; } },
];
function renderValetAll(all, occ, baseAC) {
  for (const o of all) o.__gain = occ && occ.score != null ? o.score - occ.score : null;
  const col = VA_COLS.find((c) => c.k === VS.asort) || VA_COLS[0];
  const rows = all.slice().sort((a, b) => cmpNullLast(col.key(a), col.key(b), VS.adir));
  const arrow = (k) => (VS.asort === k ? (VS.adir > 0 ? " ▲" : " ▼") : "");
  const val = (c, o) => { const v = c.key(o); return v == null ? "" : c.k === "ratio" ? v.toFixed(2)
    : c.k === "score" || c.k === "gain" ? Math.round(v) : c.k === "tier" ? "+" + v : v; };
  $("vlAll").innerHTML = `<table class="qtab ivt vl-all"><thead><tr>${VA_COLS.map((c) =>
    `<th class="is-sort" data-vlasort="${c.k}">${esc(c.h)}${arrow(c.k)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((o) => {
      const n = all.indexOf(o), it0 = o.items[0];
      return `<tr data-vlopt="${n}" class="${it0.row.sec === "worn" ? "is-worn" : ""}">${VA_COLS.map((c) => {
        if (c.k === "score") return `<td class="num"><b data-pop="vlwhy:${vlWhy(it0.row.rec, it0.row.tier, baseAC, it0.slot, o.score)}">${Math.round(o.score)}</b></td>`;
        if (c.k === "gain") return `<td class="num">${o.__gain == null ? "" : vlGainHtml(o.__gain)}</td>`;
        if (c.k === "item") return `<td class="iv-item vl-item">${o.items.map((it) => vlNameCell(it.row.name)).join(` <span class="dim">+</span> `)}</td>`;
        if (c.k === "where") return `<td>${o.items.map((it) => vlBadge(it.row.loc)).join(" ")}</td>`;
        return `<td class="${c.num ? "num" : ""}">${val(c, o)}</td>`;
      }).join("")}</tr>`;
    }).join("")}</tbody></table>`;
}

/* The fetch list. Every column sorts, same rule as every other table here. */
const VL_COLS = [
  { k: "where", h: "Where it is", d0: 1, v: it => window.EQLValet.secRank(it.row.sec) * 1000 + (window.EQLGearScore.locBadge(it.row.loc).n || 0) },
  { k: "slot", h: "Slot", d0: 1, v: it => it.step.label },
  { k: "item", h: "Item", d0: 1, v: it => it.row.name.toLowerCase() },
  { k: "tier", h: "Tier", d0: -1, v: it => it.row.tier, num: 1 },
  /* Which worn piece each reach displaces, and what the reach is worth.
     Standing at the bank, ten rows saying "fetch" is not a priority order.
     Ahead of Stats: the stat line is the widest cell on the row and pushes
     everything after it off the edge (the Inventory tab's own receipt). */
  { k: "off", h: "Comes off", d0: 1, v: it => { const o = vlOccupant(it.step); return o ? o.e.name.toLowerCase() : "~"; } },
  { k: "gain", h: "Gain", d0: -1, num: 1, v: it => { const g = vlItemGain(it); return g == null ? -1e9 : g; } },
  { k: "do", h: "Do", d0: 1, v: it => (it.row.sec === "worn" ? 0 : 1) },
  { k: "stats", h: "Stats", d0: 1, v: it => it.row.name.toLowerCase() },
];
/* What one reach buys: the pick's score minus whatever it displaces, both
   priced at that step's own AC base. */
function vlItemGain(it) {
  const p = VWALK.picks[it.step.key];
  if (!p) return null;
  const occ = vlOccupant(it.step);
  if (!occ) return p.score;
  return occ.score == null ? null : p.score - occ.score;
}
/* Before and after, per stat. The score is one number and the trade behind it
   — 30 mana for 4 AC — is the thing you actually want to see. */
const VC_COLS = [
  { k: "stat", h: "Stat", d0: 1, key: (r) => r.k },
  { k: "now", h: "Wearing now", d0: -1, num: 1, key: (r) => r.a },
  { k: "new", h: "This loadout", d0: -1, num: 1, key: (r) => r.b },
  { k: "d", h: "Difference", d0: -1, num: 1, key: (r) => r.d },
];
/* The two kits' totals: the tier-scaled stats valet-core sums, plus the
   resists and haste the scorer also reads — a kit can win on 40 resists, and
   a table that leaves them out would claim the opposite. SV VOID stays out
   (the upgrade-tier marker). */
function kitExtras(items) {
  const out = {};
  for (const it of items) {
    const rec = it.rec || (it.row && it.row.rec);
    if (!rec) continue;
    for (const k in rec.sv || {}) if (k !== "v" && rec.sv[k]) out["sv " + (window.EQLGearScore.SV_NAMES[k] || k)] = (out["sv " + (window.EQLGearScore.SV_NAMES[k] || k)] || 0) + rec.sv[k];
    if (rec.haste) out["haste %"] = Math.max(out["haste %"] || 0, rec.haste);   // haste does not stack across items
  }
  return out;
}
function renderValetCmp(cur, plan) {
  const ca = kitExtras(cur.items || []), pa = kitExtras(plan.items || []);
  const keys = SKY_STAT_KEYS.filter((k) => cur.st[k] || plan.st[k]);
  const extra = [...new Set([...Object.keys(ca), ...Object.keys(pa)])].sort();
  const rows = keys.map((k) => ({ k: k.toUpperCase(), a: cur.st[k] || 0, b: plan.st[k] || 0,
    d: (plan.st[k] || 0) - (cur.st[k] || 0) }))
    .concat(extra.map((k) => ({ k: k.toUpperCase(), a: ca[k] || 0, b: pa[k] || 0, d: (pa[k] || 0) - (ca[k] || 0) })));
  const col = VC_COLS.find((c) => c.k === VL.csort) || VC_COLS[0];
  rows.sort((a, b) => cmpNullLast(col.key(a), col.key(b), VL.cdir));
  const arrow = (k) => (VL.csort === k ? (VL.cdir > 0 ? " ▲" : " ▼") : "");
  $("vlCmp2").innerHTML = rows.length ? `<table class="qtab ivt"><thead><tr>${VC_COLS.map((c) =>
    `<th class="is-sort" data-vlcsort="${c.k}">${esc(c.h)}${arrow(c.k)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr><td>${esc(r.k)}</td><td class="num">${r.a || ""}</td><td class="num">${r.b || ""}</td>
      <td class="num ${r.d > 0 ? "up" : r.d < 0 ? "down" : ""}">${r.d ? (r.d > 0 ? "+" : "") + r.d : ""}</td></tr>`).join("")
    }</tbody></table>` : `<p class="dim">Nothing you are wearing or picking has a stat the wiki lists.</p>`;
}
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
    const occ = vlOccupant(it.step);
    const same = occ && occ.e.rec === it.row.rec && occ.e.tier === it.row.tier;
    const moved = same ? null : vlMovedTo(it.step, occ);
    return `<tr class="${worn ? "is-dim" : ""}">
      <td>${vlBadge(it.row.loc)}</td>
      <td>${esc(it.step.label)}</td>
      <td class="iv-item">${itemSpan(it.row.name, true)}</td>
      <td>${it.row.tier ? "+" + it.row.tier : ""}</td>
      <td class="iv-item">${occ && !same
        ? (occ.e.rec ? itemSpan(occ.e.name, true) : esc(occ.e.name)) + (moved ? ` <span class="dim">moves to ${esc(moved.label)}</span>` : vlStripHtml(occ.w))
        : `<span class="dim">${occ ? "" : "nothing"}</span>`}</td>
      <td class="num">${same ? "" : vlGainHtml(vlItemGain(it))}</td>
      <td>${worn ? `<span class="dim">already on</span>` : "<b>fetch</b>"}</td>
      <td>${vlStat(it.row.rec, it.row.tier)}</td>
    </tr>`;
  }).join("") + plan.kept.map(k => `<tr class="is-dim">
      <td>${vlBadge(k.slot)}</td>
      <td>${esc(k.step.label)}</td>
      <td class="iv-item">${k.e.rec ? itemSpan(k.e.name, true) : esc(k.e.name)}</td>
      <td></td>
      <td></td>
      <td class="num"></td>
      <td><span class="dim">keep</span></td>
      <td><span class="dim">${k.e.rec ? "not scored here" : "no wiki page — can't be scored"}</span></td>
    </tr>`).join("")}</tbody></table>`;
  renderValetCmp(cur, plan);
}

/* What crosses to the overlay: the pull list, and nothing you are already
   wearing. Same shape discipline as pushSky — build it here, send only on
   change, and keep it small enough to redraw a 340px panel. */
let lastValetJson = "";
/* The pet plan as pet-core computes it for the current selection, or null
   when there is nothing to summon. pushValet sends it to the overlay whether
   or not the Pet view is open — handing gear to the pet happens at the bank,
   which is where the overlay is read. */
function vlPetPlan() {
  const P = window.EQLPetCore;
  if (!PETD || !P || !VINV) return null;
  const lines = P.linesFor(PETD, VL.classes);
  if (!lines.length) return null;
  const lineKey = lines.some((l) => l.key === VS.petLine) ? VS.petLine : lines[0].key;
  const rank = Math.min(10, Math.max(0, VS.petRank | 0));
  const pet = P.petAt(PETD, lineKey, VL.classes, VL.level, rank);
  if (!pet) return null;
  const DP = P.dressPet({ rows: VINV.rows, taken: vlAutoPlanTaken(), trio: VL.classes, pet, PD: PETD, effects: GDATA && GDATA.effects });
  return { pet, DP };
}
function pushValet() {
  if (!VWALK) { if (lastValetJson !== "null") { lastValetJson = "null"; window.companion.sendValet(null); } return; }
  const plan = VWALK.planLoadout(), cur = VWALK.currentLoadout();
  const all = window.EQLValet.fetchOrder(plan.items);
  const p = {
    trio: `${VL.classes.join("/")} at ${VL.level}`,
    gain: Math.round(plan.score - cur.score),
    worn: all.filter(it => it.row.sec === "worn").length,
    ready: VWALK.done(),
    /* the two exaltation flags, and the exaltations that fit an empty socket
       on what is worn — the bank-side question the overlay exists for */
    flags: VAUDIT ? { usable: VAUDIT.summary.usable, fillable: VAUDIT.summary.fillable, empty: VAUDIT.summary.empty, worn: VAUDIT.summary.wornWithEmpty,
      fits: VAUDIT.idle.filter(it => it.homes.empty.length).slice(0, 20).map(it => {
        const b = window.EQLGearScore.locBadge(it.row.loc);
        return { n: it.row.name.replace(/\s*\(Exaltation\)\*?$/, ""), host: it.host ? it.host.row.name : null,
                 loc: { k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title },
                 into: it.homes.empty.map(h => `${h.w.slot} · ${h.w.row.name} (${h.type})`) };
      }) } : null,
    fetch: all.filter(it => it.row.sec !== "worn").map(it => {
      const b = window.EQLGearScore.locBadge(it.row.loc);
      const ref = skyRef(it.row.name);
      // what each reach displaces and what it is worth — a half-finished trip
      // is otherwise unprioritised, and you cannot see which piece comes off
      const occ = vlOccupant(it.step);
      const moved = vlMovedTo(it.step, occ);
      const g = vlItemGain(it);
      return { slot: it.step.label, n: it.row.name, url: ref.url, sb: ref.sb,
               off: occ ? occ.e.name : null, moves: moved ? moved.label : null, gain: g == null ? null : Math.round(g),
               strip: occ && occ.w && !moved ? vlStripCount(occ.w) : 0,
               loc: { k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title } };
    }),
  };
  const pp = vlPetPlan();
  p.pet = pp ? {
    line: `${pp.pet.line.label} — ${pp.pet.cls.join("/")}, level ${pp.pet.level}`,
    slots: pp.DP.slotMath.count,
    haste: (pp.DP.notes.find((n) => n.k === "hasteBuff") || {}).buff || null,
    items: pp.DP.picks.map((pk) => {
      const b = window.EQLGearScore.locBadge(pk.row.loc);
      const ref = skyRef(pk.row.name);
      return { slot: pk.slot, n: pk.row.name, url: ref.url, sb: ref.sb, worn: pk.row.sec === "worn",
               loc: { k: b.kind, n: b.n, sub: b.sub, w: b.word, t: b.title } };
    }),
  } : null;
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
    // Rank's headline tie-break and its popover's "your classes" line read the trio
    saveValetPrefs(); valetRestart(); renderValet(); pushValet(); pushSpare(); renderInv();
  }));
  $("vlLvl").addEventListener("change", () => {
    VL.level = Math.min(50, Math.max(1, $("vlLvl").value | 0 || 50));
    // every per-class scorer behind Gear and Spare is built at this level
    saveValetPrefs(); spareReload(); valetRestart();
    renderValet(); pushValet(); pushSpare(); renderInv();
  });
  $("vlRestart").addEventListener("click", () => { valetRestart(); renderValet(); pushValet(); pushSpare(); });
  // By slot / Get dressed / Exaltations, the flags, the slot picker, the two tables' sorts, the column picker
  const vsRedraw = () => { renderValet(); };
  const pickView = (v) => { VS.view = v; saveValetPrefs(); vsRedraw(); };
  $("vlViews").addEventListener("click", (e) => { const b = e.target.closest("[data-vlview]"); if (b) pickView(b.dataset.vlview); });
  $("vlFlags").addEventListener("click", (e) => { const b = e.target.closest("[data-vlview]"); if (b) pickView(b.dataset.vlview); });
  $("vlSlotPick").addEventListener("click", (e) => { const b = e.target.closest("[data-vlslot]"); if (!b) return; VS.slot = b.dataset.vlslot; saveValetPrefs(); vsRedraw(); });
  $("vlOwn").addEventListener("click", (e) => { const th = e.target.closest("[data-vlosort]"); if (!th) return; const k = th.dataset.vlosort; VS.dir = VS.sort === k ? -VS.dir : 1; VS.sort = k; vsRedraw(); });
  $("vlGap").addEventListener("click", (e) => { const th = e.target.closest("[data-vlgsort]"); if (!th) return; const k = th.dataset.vlgsort; VS.gdir = VS.gsort === k ? -VS.gdir : 1; VS.gsort = k; vsRedraw(); });
  $("vlPet").addEventListener("click", (e) => { const th = e.target.closest("[data-vlpsort]"); if (!th) return; const k = th.dataset.vlpsort; VS.pdir = VS.psort === k ? -VS.pdir : 1; VS.psort = k; renderValetPet(); });
  $("vlPetLine").addEventListener("change", () => { VS.petLine = $("vlPetLine").value; saveValetPrefs(); renderValetPet(); });
  $("vlPetRank").addEventListener("change", () => { VS.petRank = +$("vlPetRank").value; saveValetPrefs(); renderValetPet(); });
  // the Exaltations view's three tables, one handler each
  for (const [id, attr, cols, sk, dk] of [["vlExEmpty", "vlxesort", VX_ECOLS, "xesort", "xedir"],
                                          ["vlExIdle", "vlxisort", VX_ICOLS, "xisort", "xidir"],
                                          ["vlExNone", "vlxnsort", VX_NCOLS, "xnsort", "xndir"]]) {
    $(id).addEventListener("click", (e) => {
      const th = e.target.closest("[data-" + attr + "]");
      if (!th) return;
      const k = th.dataset[attr], c = cols.find((x) => x.k === k);
      VS[dk] = VS[sk] === k ? -VS[dk] : (c ? c.d0 : 1);
      VS[sk] = k; saveValetPrefs(); vsRedraw();
    });
  }
  $("vlGapAll").addEventListener("click", () => { VS.gapAll = !VS.gapAll; saveValetPrefs(); vsRedraw(); });
  $("vlOwnCols").addEventListener("change", (e) => {
    const inp = e.target.closest("[data-vlcol]"); if (!inp) return;
    const on = new Set(vsCols().map((c) => c.k)); if (inp.checked) on.add(inp.dataset.vlcol); else on.delete(inp.dataset.vlcol);
    VS.cols = VS_COLS.filter((c) => !c.fixed && on.has(c.k)).map((c) => c.k); saveValetPrefs(); vsRedraw();
  });
  $("vlOwnCols").addEventListener("click", (e) => { if (!e.target.closest("#vlColsReset")) return; VS.cols = null; saveValetPrefs(); vsRedraw(); });
  if (window.EQLPriorities && VL_PRIO) {
    window.EQLPriorities.mount($("vlPrio"), {
      store: VL_PRIO, scorer: valetScorer, summary: $("vlPrioSummary"), btnClass: "btn btn--sm",
      note: PRIO_NOTE,
      onChange: () => { valetRestart(); renderValet(); pushValet(); },
    });
    /* The Settings copy carries no onChange: a write fires the event at BOTH
       mounts, so the Valet one already redraws the tab. */
    window.EQLPriorities.mount($("setPrio"), {
      store: VL_PRIO, scorer: valetScorer, btnClass: "btn btn--sm", note: PRIO_NOTE,
    });
  }
  $("vlSkip").addEventListener("click", () => { VWALK.skip(); renderValet(); pushValet(); pushSpare(); });
  $("vlBack").addEventListener("click", () => { if (VWALK.back()) { renderValet(); pushValet(); pushSpare(); } });
  $("vlAuto").addEventListener("click", (e) => {
    if (!e.target.closest("#vlClearMem")) return;
    delete VL.mem[vlTrioKey()]; saveValetPrefs(); valetRestart(); renderValet(); pushValet(); pushSpare();
  });
  const take = (e) => {
    // a wiki link inside the tile is not the tile's action (page-design 0f)
    if (e.target.closest("a, [data-url], [data-wiki]")) return;
    const b = e.target.closest("[data-vlopt]");
    if (!b || !VWALK) return;
    const st = VWALK.step();
    if (!st) return;   // the walk is done; a card left on screen picks nothing
    VWALK.pick(st.key, VWALK.options()[+b.dataset.vlopt], $("vlRemember").checked);
    renderValet(); pushValet(); pushSpare();
  };
  $("vlCards").addEventListener("click", take);
  $("vlCards").addEventListener("keydown", (e) => {
    if ((e.key !== "Enter" && e.key !== " ") || !e.target.closest(".vlc")) return;
    e.preventDefault(); take(e);
  });
  // every option for the open step: the toggle, the sorts, and the same pick
  $("vlAllToggle").addEventListener("click", () => { VS.allOpen = !VS.allOpen; saveValetPrefs(); vsRedraw(); });
  $("vlAll").addEventListener("click", (e) => {
    const th = e.target.closest("[data-vlasort]");
    if (th) {
      const k = th.dataset.vlasort, c = VA_COLS.find((x) => x.k === k);
      VS.adir = VS.asort === k ? -VS.adir : (c ? c.d0 : -1);
      VS.asort = k; saveValetPrefs(); vsRedraw(); return;
    }
    take(e);
  });
  $("vlFetch").addEventListener("click", (e) => {
    const th = e.target.closest("[data-vlsort]");
    if (!th) return;
    const k = th.dataset.vlsort, c = VL_COLS.find(x => x.k === k);
    if (VL.sort === k) VL.dir = -VL.dir; else { VL.sort = k; VL.dir = (c && c.d0) || 1; }
    renderValetDone();
  });
  $("vlCmp2").addEventListener("click", (e) => {
    const th = e.target.closest("[data-vlcsort]");
    if (!th) return;
    const k = th.dataset.vlcsort, c = VC_COLS.find(x => x.k === k);
    if (VL.csort === k) VL.cdir = -VL.cdir; else { VL.csort = k; VL.cdir = (c && c.d0) || 1; }
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
    sources: a.sources.slice(0, 14).map(s => ({ name: s.name, side: s.side, hits: s.hits, dmg: s.dmg, max: s.max, crit: s.crit, res: s.res })),
    takenBy: a.takenBy.slice(0, 10).map(t => ({ src: t.src, name: t.name, hits: t.hits, dmg: t.dmg, max: t.max, res: t.res })),
    taken: a.taken.dmg, avoid: a.taken.avoid,
    healTot: a.healTot, healInTot: a.healInTot, petTaken: a.petTaken,
    swings: a.swings,
  };
}
function combatDetailFor(f, r) { return combatSliceDetail(new Set([f.mob]), f.start, f.end, r); }

/* One ENCOUNTER = one pull, which is usually several fights. The engine owns
   the rule (E.buildEncounters, log-parser/engine.js): it cuts where combat
   stopped, and a mob still on you across the cut splits its damage between
   the two pulls instead of welding them into one row. */
const encounterize = fights => E.buildEncounters(fights);

// same identity rule as fkey: (start second, first mob) survives re-parses
function encRow(g, r) {
  const mobs = g.mobs.map(m => ({
    mob: m.mob, kills: m.kills, killed: m.kills > 0,
    // credit is asked of the fight that produced the kill, so a pull that
    // only holds the tail of a mob's fight claims nothing
    team: m.kills > 0 && m.fights.some(f => teamKill(f, r)),
    dmg: m.total, taken: m.taken, xp: Math.round(m.xp * 10) / 10, coin: m.coin,
  }));
  return {
    key: g.key, ts: g.start, secs: Math.max(1, g.secs),
    mobs, total: g.total, taken: g.taken,
    xp: Math.round(g.xp * 10) / 10, coin: g.coin,
    kills: g.kills,
    team: mobs.some(m => m.team),
    detail: null, raid: null,
  };
}
const encDetail = (g, r) => combatSliceDetail(g.names, g.start, g.end, r);
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
/* ── the inventory popovers ───────────────────────────────────────────────
   A second floating panel for the Rank, Copies and Exalt-inside cells: a
   small table rather than the item window's lines. Same placement rule as the
   item tooltip; built from the row the cursor is over, so a re-render under
   the cursor redraws the right one. */
let popEl = null;
const IV_POPS = {
  rank: v => { const b = rankOf(v); const x = b && rankTrio(b); return x ? rankTable(v, b, x) : ""; },
  rankany: v => { const b = rankOf(v); const x = b && rankAny(b); return x ? rankTable(v, b, x) : ""; },
  copies: v => { const g = COPIES.get(v.r); return g ? copiesPop(v, g) : ""; },
  xkeep: v => { const u = uniqOf(v); return u ? xkeepPop(v, u) : ""; },
};
function repop() {
  if (!popEl) return;
  const el = document.elementFromPoint(MX, MY);
  const t = el && el.closest ? el.closest("[data-pop]") : null;
  if (!t) { popEl.hidden = true; return; }
  const [kind, id] = t.dataset.pop.split(":");
  // the Valet tab hangs a score breakdown off the same panel; its rows are
  // not inventory views, so it registers a builder instead
  let html = "";
  if (kind === "vlwhy") { const f = VL_POPS.get(id); html = f ? f() : ""; }
  else { const v = IV_BYID.get(+id); html = v && IV_POPS[kind] ? IV_POPS[kind](v) : ""; }
  if (!html) { popEl.hidden = true; return; }
  popEl.innerHTML = html;
  popEl.hidden = false;
  placeAt(popEl);
}
function initTip() {
  tipEl = document.createElement("div");
  tipEl.id = "eqtip"; tipEl.hidden = true;
  document.body.appendChild(tipEl);
  popEl = document.createElement("div");
  popEl.id = "ivpop"; popEl.hidden = true;
  document.body.appendChild(popEl);
  document.addEventListener("mousemove", ev => { MX = ev.clientX; MY = ev.clientY; if (!tipEl.hidden) moveTip(); if (!popEl.hidden) placeAt(popEl); });
  document.addEventListener("mouseover", ev => { MX = ev.clientX; MY = ev.clientY; retip(); repop(); });
  document.addEventListener("scroll", () => { retip(); repop(); }, true);
}
function placeAt(el) {
  const pad = 14, r = el.getBoundingClientRect();
  let x = MX + pad, y = MY + pad;
  if (x + r.width > innerWidth - 8) x = Math.max(8, MX - r.width - pad);
  if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
  el.style.left = x + "px"; el.style.top = y + "px";
}
const moveTip = () => placeAt(tipEl);

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
  loadFolds();
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
    flushQuests(); // Quests skips drawing while it is off screen
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
  $("invFocus").addEventListener("change", e => { IV.focus = e.target.value; renderInv(); });
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
  // the overlay sends the row's requirement, same as the local tick above
  window.companion.onMarkHeld((n, c) => toggleHeld(n, c));
  window.companion.onStatsReset(on => on ? raidResetNow() : setRaidZero(null));
  /* The widget asked for a different Sky grouping. It writes through to the
     same widget option the Sky tab draws, so the select down there follows —
     the two are one setting, and a boss board can only be built here. */
  window.companion.onSkyView(v => {
    if (SKYP.wid.view === v) return;
    SKYP.wid.view = v;
    saveSkyPrefs(); renderSkyWidget(); pushSky();
  });
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

  $("skySearch").addEventListener("input", () => renderSky());
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
    const rs = e.target.closest("[data-skrsort]");
    if (rs) {
      const k = rs.dataset.skrsort, c = SKR_COLS.find(x => x.k === k);
      SKYP.rdir = SKYP.rsort === k ? -SKYP.rdir : (c ? c.d0 : -1);
      SKYP.rsort = k; saveSkyPrefs(); renderSky(); return;
    }
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
  /* Typed filters redraw on a pause, not on a keystroke. The browser is 2,004
     rows over 924 quests and drawing them costs ~200ms, so "bard" used to buy
     four full redraws and the box swallowed letters. The selects and the level
     boxes are one gesture each and stay immediate. */
  const typed = (id, fn) => {
    let t = null;
    $(id).addEventListener("input", e => {
      const v = e.target.value;
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn(v); }, 140);
    });
  };
  typed("tiSearch", v => { TURNIN.q = v; renderTurnins(); });
  $("qReadyOnly").addEventListener("change", e => { TURNIN.readyOnly = e.target.checked; renderTurnins(); });
  typed("qSearch", v => { QB.q = v; renderQuestBrowser(); });
  $("qbClass").addEventListener("change", e => { QB.cls = e.target.value; renderQuestBrowser(); });
  $("qbZone").addEventListener("change", e => { QB.zone = e.target.value; renderQuestBrowser(); });
  $("qbEra").addEventListener("change", e => { QB.era = e.target.value; populateQuestFilters(); renderQuestBrowser(); });
  typed("qbLvlMin", v => { QB.lvlMin = v; renderQuestBrowser(); });
  typed("qbLvlMax", v => { QB.lvlMax = v; renderQuestBrowser(); });
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
    /* the same chain onDataUpdated runs: a new gear dataset is a new set of
       record objects, and every analysis keyed on the old ones (Valet,
       Spare, Exalt, Rank's OWNED index) has to be rebuilt or it answers
       "you hold none of these" for items sitting in the bank */
    renderTracker(); renderData(); populateZoneSel(); renderZoneTab(); populateInvFilters(); valetReload(); renderInv();
    populateQuestFilters(); renderQuests(); populateSkyFilters(); renderSky(); pushZone(); pushQuests(); pushSky();
    renderValet(); pushValet(); pushSpare();
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
    const fd = e.target.closest("[data-fold]");
    if (fd) {
      const set = fd.dataset.fold === "z" ? QFOLD.z : QFOLD.q;
      const k = fd.dataset.foldkey;
      set.has(k) ? set.delete(k) : set.add(k);
      saveFolds(); renderQuests(); return;
    }
    const fa = e.target.closest("[data-foldall]");
    if (fa) { foldAll(fa.dataset.foldall); renderQuests(); return; }
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
/* main() builds every index and wires every listener before anything is
   interactive, so a throw in it leaves the static chrome painted and the whole
   app dead — with nothing on screen saying so, and no way to tell that apart
   from a window that never loaded at all. Say it, in the page. */
main().catch(err => {
  console.error("companion: startup failed", err);
  const box = document.createElement("div");
  box.style.cssText = "padding:16px;margin:16px;border:1px solid var(--warn,#c66);border-radius:6px;font:13px/1.5 system-ui";
  box.innerHTML = `<b>The app failed to start.</b><br>Close and reopen it. If it keeps happening, this is the reason:<br>
    <code style="display:block;margin-top:8px;white-space:pre-wrap">${String((err && err.stack) || err).slice(0, 600).replace(/[<&]/g, c => (c === "<" ? "&lt;" : "&amp;"))}</code>`;
  document.body.prepend(box);
});
