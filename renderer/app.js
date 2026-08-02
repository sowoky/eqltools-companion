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
let QIDX_L = new Map(), TIDX_L = new Map(), QSRC_L = {}, QDROPS_L = {};
let TDATA = null;     // item-tooltips.json
let TIDX = new Map(); // normName(item) -> {n, t, ic, sb: [lines]}

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
  }
  const td = datasets["item-tooltips.json"];
  TDATA = td ? td.data : null;
  SOURCES.tooltips = td ? td.source : "none";
  TIDX = new Map();
  if (TDATA) for (const [nk, e] of Object.entries(TDATA.items)) TIDX.set(nk, e);
  QIDX_L = looseIndex(QIDX); TIDX_L = looseIndex(TIDX);
  QSRC_L = looseObj(QSRC); QDROPS_L = looseObj(QDROPS);
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
  renderStatus(); renderTracker(); pushZone();
}

let lastStreamZone = "?";
function onLines({ file, lines }) {
  if (file !== currentFile || !stream) return;
  LINES_SEEN += lines.length;
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

/* ── inventory tab ────────────────────────────────────────────────────────
   /out inventory writes a TSV — header Location/Name/ID/Count/Slots, CRLF,
   "Empty" placeholder rows — validated against a real live-play dump.
   Main ships the newest file whenever it changes; rows keep their raw
   Location (collect full), the section grouping is display-only. */
const INV = { file: null, mtime: 0, rows: null };
const WORN_RX = /^(Charm|Ear|Head|Face|Neck|Shoulders|Arms|Back|Wrist|Range|Hands|Primary|Secondary|Fingers?|Ring|Chest|Legs|Feet|Waist|Ammo|Power Source)(-Slot\d+)?$/;
const INV_SECTIONS = [
  ["Worn", loc => WORN_RX.test(loc)],
  ["Held", loc => /^(Held|Any Slot)$/.test(loc)],
  ["Carried", loc => /^General ?\d+/.test(loc)],
  // the client writes "General 1" WITH a space but "Bank1" without — both
  // matchers take an optional space so a format nudge doesn't reclassify
  ["Bank", loc => /^Bank ?\d+/.test(loc)],
  ["Shared bank", loc => /^SharedBank/.test(loc)],
  ["Depot", loc => /^Personal-Depot/.test(loc)],
  ["Key ring", loc => /^KeyRing/.test(loc)],
];

function parseInventory(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const f = raw.replace(/\r$/, "").split("\t");
    // The dump is two concatenated tables: Location/Name/ID/Count/Slots, then
    // a 3-column KeyRing/Name/ID table with its own header — skip BOTH header
    // rows by shape, not by first column.
    if (f.length < 3 || (f[1] === "Name" && f[2] === "ID")) continue;
    const name = f[1];
    if (!name || name === "Empty") continue;
    // id joins the FEED_OPEN chip-expand space; itemId is the client's item ID
    rows.push({ loc: f[0], name, itemId: +f[2] || 0, count: +f[3] || 1, id: ++FEED_ID });
  }
  return rows;
}

function onInvFile({ file, mtime, text }) {
  INV.file = file; INV.mtime = mtime;
  INV.rows = parseInventory(text);
  LIVE_HAVE = new Map(); // the dump holds everything looted before it
  renderInv(); renderQuests(); pushQuests();
}

function onInvStatus({ problem }) {
  INV.problem = problem;
  renderInv(); renderQuests();
}

function renderInv() {
  const body = $("invBody"), empty = $("invEmpty");
  if (!INV.rows) {
    $("invMeta").textContent = "";
    body.innerHTML = "";
    empty.textContent = INV.problem || "No inventory dump found beside the log folder yet.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  $("invMeta").textContent = `${INV.file} · dumped ${new Date(INV.mtime).toLocaleString()}`;
  // Quest matches resolve at render time from the live QIDX, so a dataset
  // refresh re-chips the same dump.
  const qOnly = $("invQuestOnly").checked;
  const iNeedle = $("invSearch").value.trim().toLowerCase();
  const rows = INV.rows.map(r => ({ ...r, quests: questRefsFor(r.name) }))
    .filter(r => !qOnly || r.quests.length)
    .filter(r => !iNeedle || r.name.toLowerCase().includes(iNeedle) || r.loc.toLowerCase().includes(iNeedle));
  const buckets = INV_SECTIONS.map(([label]) => ({ label, rows: [] }));
  const other = { label: "Elsewhere", rows: [] };
  for (const r of rows) {
    const i = INV_SECTIONS.findIndex(([, test]) => test(r.loc));
    (i === -1 ? other : buckets[i]).rows.push(r);
  }
  buckets.push(other);
  body.innerHTML = buckets.filter(b => b.rows.length).map(b => `
    <h3>${b.label} (${b.rows.length})</h3>
    <ul class="feed">${b.rows.map(r => `
      <li class="ev ev--loot ${r.quests.length ? "is-quest" : ""}">
        <span class="ev__t ev__t--loc">${esc(r.loc)}</span>
        <span class="ev__body">${itemSpan(r.name, true)}${r.count > 1 ? ` ×${r.count}` : ""}${questChips(r.quests, r.id)}</span></li>`).join("")}
    </ul>`).join("");
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
  const rows = (q.need && q.need.length ? q.need : (q.items || []).map(n => [n, 1]))
    .map(([n, want]) => ({ n, want, have: held(n) }));
  const got = rows.filter(c => c.have >= c.want).length;
  return { q, comps: rows, got, need: rows.length, done: rows.length > 0 && got === rows.length };
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
// there would be a lie of omission.
const KIND_LABEL = { vendor: "from a merchant", forage: "forage" };
function sourceIn(name, zone) {
  const s = srcFor(name);
  if (!s) return { mobs: [] };
  const mobs = (s.m && s.m[zone]) || [];
  if (mobs.length) return { mobs };
  const i = (s.z || []).indexOf(zone);
  const kind = i >= 0 && s.k ? s.k[i] : null;
  return { mobs: [], note: KIND_LABEL[kind] || "" };
}

/* rows [{n, want, have, tag?}] -> ordered zone buckets. Zones with something
   still outstanding sort first (that is the reason you are reading the list),
   then by how much is left, then alphabetically; the two catch-all buckets sit
   at the bottom whatever they hold. */
function zoneBuckets(rows) {
  const by = new Map();
  for (const r of rows) {
    for (const z of bucketsFor(r.n)) {
      if (!by.has(z)) by.set(z, []);
      by.get(z).push(r);
    }
  }
  const out = [...by.entries()].map(([z, items]) => {
    items.sort((a, b) => (a.have >= a.want) - (b.have >= b.want) ||
      (a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1));
    return { z, items, left: items.filter(r => r.have < r.want).length };
  });
  out.sort((a, b) => {
    const ca = a.z in BUCKET_LABEL, cb = b.z in BUCKET_LABEL;
    return (ca - cb) || ((b.left > 0) - (a.left > 0)) || (b.left - a.left) ||
      (a.z < b.z ? -1 : 1);
  });
  return out;
}

const zoneLink = z => BUCKET_LABEL[z]
  ? `<span class="zg__name is-catch">${esc(BUCKET_LABEL[z])}</span>`
  : (QZONES[z] ? `<a class="wk zg__name" data-wiki="${esc(QZONES[z])}">${esc(z)}</a>`
    : `<span class="zg__name">${esc(z)}</span>`);

// one item row inside a zone bucket: held/needed, and who drops it here
function zoneItemRow(r, zone) {
  const done = r.have >= r.want;
  const src = done ? { mobs: [] } : sourceIn(r.n, zone);
  const count = r.want > 1 || r.have
    ? `<span class="qct ${done ? "is-ok" : ""}">${r.have}/${r.want}</span>` : "";
  const who = src.mobs.slice(0, 3).map(m => {
    const t = mobPath(r.n, m);
    return t ? `<a class="wk" data-wiki="${esc(t)}">${esc(m)}</a>` : esc(m);
  }).join(", ") || esc(src.note || "");
  return `<li class="qc ${done ? "is-have" : ""}"><span class="kchk"></span>${itemSpan(r.n)}${count}
    ${r.tag ? `<span class="qtag">${esc(r.tag)}</span>` : ""}
    ${who ? `<span class="qsrc dim">${who}</span>` : ""}</li>`;
}

// the pre-zone-grouping rendering, kept for datasets that predate `src`:
// item, held/needed, and the lowest-level droppers with their zone
function flatCompsHtml(rows) {
  return `<ul class="qcomps">${rows.map(r => {
    const done = r.have >= r.want;
    const d = done ? [] : dropsFor(r.n).slice(0, 2);
    const src = d.map(([mn, mt, zn, zt]) =>
      `<a class="wk" data-wiki="${esc(mt)}">${esc(mn)}</a>${zn ? ` <span class="dim">·</span> <a class="wk" data-wiki="${esc(zt)}">${esc(zn)}</a>` : ""}`).join(", ");
    return `<li class="qc ${done ? "is-have" : ""}"><span class="kchk"></span>${itemSpan(r.n)}
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
  const plans = TRACKED.map(t => T2Q.get(t)).filter(Boolean).map(q => compsFor(q, have));

  const packRow = (c, zone) => {
    const s = c.have >= c.want ? { mobs: [] } : sourceIn(c.n, zone);
    return {
      n: c.n, have: c.have, want: c.want, url: itemUrl(c.n),
      mobs: s.mobs.slice(0, 3), ...(s.note ? { note: s.note } : {}),
      ...(c.tag ? { tag: c.tag } : {}),
    };
  };
  // no source table (a dataset older than this app) means no zone answer at
  // all — send the flat list instead of one bucket claiming the wiki is silent
  const packZones = rows => !hasSrc() ? [] : zoneBuckets(rows).map(g => ({
    z: BUCKET_LABEL[g.z] || g.z, url: QZONES[g.z] && base ? base + QZONES[g.z] : "",
    left: g.left, items: g.items.map(c => packRow(c, g.z)),
  }));
  const packFlat = rows => rows.map(c => ({
    ...packRow(c, null),
    mobs: c.have >= c.want ? [] : dropsFor(c.n).slice(0, 2).map(([mn, , zn]) => zn ? `${mn} · ${zn}` : mn),
  }));

  // one item two quests want is one thing to farm — same merge the main window
  // does, so the two views can never disagree about what is left
  const merged = new Map();
  for (const p of plans) {
    for (const c of p.comps) {
      const k = itemKey(c.n), cur = merged.get(k);
      if (cur) { cur.want = Math.max(cur.want, c.want); cur.quests.add(p.q.n); }
      else merged.set(k, { n: c.n, want: c.want, have: c.have, quests: new Set([p.q.n]) });
    }
  }
  const pooled = [...merged.values()].map(r => ({
    ...r, tag: r.quests.size > 1 ? `${r.quests.size} quests` : [...r.quests][0],
  }));

  window.companion.sendQuests({
    zones: packZones(pooled),
    quests: plans.map(p => ({
      n: p.q.n, url: base ? base + p.q.t : "",
      got: p.got, need: p.need, done: p.done, oe: !!p.q.oe,
      zones: packZones(p.comps),
      ...(hasSrc() ? {} : { comps: packFlat(p.comps) }),
      parts: (p.q.parts || []).map(pt => ({
        n: pt.n, g: pt.g || "",
        c: pt.c.map(([n, want]) => ({
          n, want, have: heldCount(have, n),
        })),
      })),
    })),
  });
}

// facts line shared by full rows and stubs; the chain note only applies to
// quests that DO list components (see questRow's comment). Out of era leads —
// it changes what the whole row means.
function questFacts(q, chain) {
  const oe = q.oe ? `out of era — ${String(q.era || "").replace(/\s*Era$/i, "") || "?"}` : "";
  return [oe, q.lvl ? `lvl ${q.lvl}` : "", (q.classes || []).filter(c => c && c !== "?").join("/"),
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
    return `<li class="qpart ${got === cs.length ? "is-ready" : ""}">
      <div class="qpart__head">
        <span class="qpart__n">${esc(p.n || "Also listed on this page")}</span>
        ${p.g ? `<span class="dim">→ ${esc(p.g)}</span>` : ""}
        <span class="qprog">${got}/${cs.length}</span>
      </div>
      <ul class="qcomps">${cs.map(c => `<li class="qc ${c.have >= c.want ? "is-have" : ""}">
        <span class="kchk"></span>${itemSpan(c.n)}${c.want > 1 || c.have ? `<span class="qct ${c.have >= c.want ? "is-ok" : ""}">${c.have}/${c.want}</span>` : ""}</li>`).join("")}</ul>
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
  const comps = zoneGroupsHtml(p.comps) + (have ? partsHtml(q, have) : "");
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
  return `<li class="qrow ${p.done ? "is-ready" : ""} ${tracked ? "is-tracked" : ""}">
    <div class="qrow__head">
      <a class="wk" data-wiki="${esc(q.t || "")}">${esc(q.n)}</a>
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
  const chain = q.split ? `${parts} turn-ins`
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
  const rows = QDATA.quests.filter(qbMatch).map(q => compsFor(q, have));
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
  const tracked = TRACKED.map(t => T2Q.get(t)).filter(Boolean);
  empty.hidden = tracked.length > 0;
  if (head) head.hidden = tracked.length < 1;
  // the by-zone view needs the source table; offering the toggle without it
  // would switch to an empty answer
  const seg = document.querySelector(".seg");
  if (seg) seg.hidden = !hasSrc();
  banner.hidden = hasSrc();
  if (!hasSrc()) banner.textContent = STALE_DATA_NOTE;
  if (!tracked.length) { body.innerHTML = ""; return; }
  const have = haveMap();
  const plans = tracked.map(q => compsFor(q, have));

  if (TRACK_VIEW === "zone" && hasSrc() && tracked.length > 1) {
    // one item wanted by two quests is one thing to farm, so the rows merge and
    // carry the largest requirement; the tag names every quest waiting on it
    const merged = new Map();
    for (const p of plans) {
      for (const c of p.comps) {
        const k = itemKey(c.n);
        const cur = merged.get(k);
        if (cur) { cur.want = Math.max(cur.want, c.want); cur.quests.add(p.q.n); }
        else merged.set(k, { n: c.n, want: c.want, have: c.have, quests: new Set([p.q.n]) });
      }
    }
    const rows = [...merged.values()].map(r => ({
      ...r, tag: r.quests.size > 1 ? `${r.quests.size} quests` : [...r.quests][0],
    }));
    const left = rows.filter(r => r.have < r.want).length;
    $("trackedMeta").textContent =
      `${rows.length} item${rows.length === 1 ? "" : "s"} across ${tracked.length} quests · ${left} still to get`;
    body.innerHTML = zoneGroupsHtml(rows);
  } else {
    const ready = plans.filter(p => p.done).length;
    $("trackedMeta").textContent = tracked.length > 1
      ? `${tracked.length} quests · ${ready} ready to hand in` : "";
    body.innerHTML = `<ul class="qlist">${plans.map(p => questRow(p, true, have)).join("")}</ul>`;
  }
  retip();
}

function renderQuests() { renderTurnins(); renderTrackedTab(); renderQuestBrowser(); }

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

function renderOverlayState(o) {
  $("btnOverlay").textContent = o.shown ? "Hide overlay" : "Overlay";
  $("btnOverlay2").textContent = o.shown ? "Hide overlay" : "Show overlay";
  $("setClickThrough").checked = o.clickThrough;
  $("setOpacity").value = o.opacity;
  if (o.prefs) {
    $("setOvScale").value = o.prefs.fontScale;
    $("setOvKills").checked = o.prefs.showKills;
    $("setOvQuestOnly").checked = o.prefs.questOnly;
  }
}

/* ── wiring ───────────────────────────────────────────────────────────────*/
async function main() {
  const init = await window.companion.init();
  buildIndexes(init.datasets);
  STATE = K.load();
  loadTracked();
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
  populateZoneSel(); renderZoneTab(); populateQuestFilters(); renderQuests(); initTip();

  window.companion.onBootstrap(onBootstrap);
  window.companion.onLines(onLines);
  window.companion.onLogStatus(st => { LOGSTATUS = st; renderStatus(); });
  window.companion.onInvFile(onInvFile);
  window.companion.onInvStatus(onInvStatus);
  window.companion.onDataUpdated(d => { buildIndexes(d); if (STATE && K.reclassify(STATE, NAMEZONES)) K.save(STATE); renderTracker(); renderData(); populateZoneSel(); renderZoneTab(); renderInv(); populateQuestFilters(); renderQuests(); pushZone(); pushQuests(); });
  window.companion.onOverlayState(renderOverlayState);
  window.companion.onUpdate(renderUpdate);
  renderUpdate(await window.companion.getUpdate());
  window.companion.ready(); // listeners live — main may start tailing now
  pushQuests(); // a fresh overlay shouldn't wait for the next loot to learn the tracked list

  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.toggle("on", x === b));
    document.querySelectorAll(".pane").forEach(p => p.classList.toggle("on", p.id === "tab-" + b.dataset.tab));
    parserTabActive(b.dataset.tab === "parser");
  }));

  $("onlyQuest").addEventListener("change", renderFeed);
  $("feedFilter").addEventListener("input", renderFeed);
  $("invQuestOnly").addEventListener("change", renderInv);
  $("invSearch").addEventListener("input", renderInv);
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
    const sh = e.target.closest("[data-qsort]");
    if (sh) {
      const k = sh.dataset.qsort;
      if (QB.sort === k) QB.dir = -QB.dir; else { QB.sort = k; QB.dir = 1; }
      renderQuestBrowser(); return;
    }
    const mo = e.target.closest("[data-open]");
    if (mo) { FEED_OPEN.add(+mo.dataset.open); renderFeed(); renderInv(); return; }
    const u = e.target.closest("[data-url]");
    if (u && u.dataset.url) { window.companion.openWiki(u.dataset.url); return; }
    const w = e.target.closest("[data-wiki]");
    const base = (DATA && DATA.base) || (QDATA && QDATA.base);
    if (w && base) { window.companion.openWiki(base + w.dataset.wiki); return; }
    // anywhere else on a browser row toggles its detail (links handled above)
    const qr = e.target.closest("tr.qbr");
    if (qr) {
      const t = qr.dataset.qx;
      QEXPANDED.has(t) ? QEXPANDED.delete(t) : QEXPANDED.add(t);
      renderQuestBrowser(); return;
    }
    const zh = e.target.closest("[data-zone]");
    if (zh) { const k = zh.dataset.zone; EXPANDED.has(k) ? EXPANDED.delete(k) : EXPANDED.add(k); renderTracker(); }
  });
}
main();
