/* Overlay renderer — a dumb display. The main window resolves quests and
   credit; this window just draws what it's told and stays readable over the
   game.

   Click-through ("pinned") uses forward:true, so mousemove still reaches us
   even while clicks fall through to the game. Anything actionable — the pin
   button AND quest links — is a HOTSPOT: hovering it tells main to make the
   window interactive for just that moment, so pinned overlays keep working
   links (Kyle, 2026-07-31: "why can't i click links in the overlay").

   Transparent frameless windows have no native resize borders on Windows;
   the corner grip resizes through main instead. */
"use strict";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const feedEl = document.getElementById("feed");
const questsEl = document.getElementById("quests");
const zoneEl = document.getElementById("zoneLine");
const lockEl = document.getElementById("lockTag");
const gripEl = document.getElementById("grip");
const panelEl = document.getElementById("panel");
let THROUGH = false;
let PREFS = { fontScale: 1, showKills: true, questOnly: false, view: "loot",
              views: ["tracked", "loot", "stats", "sky", "valet"], collapsed: false,
              statsScope: "fights", statsWindow: 0 };
const FEED_CAP = 50; // matches main's relay ring; the window scrolls, not truncates

/* Five views, tab-switched: Tracked (quest working lists), Loot (the feed),
   Parser (session + fights + the meter; the pref key is still `stats`),
   Sky (the Plane of Sky quest room — what you
   can hand in and where each piece is), Valet (the fetch list for the loadout
   you picked in the app: what to pull, and out of which bag or bank slot). The choice persists through main's
   prefs like every other overlay pref, which means main.js's overlay:prefs
   allowlist has to name every one of them. */
const filtersEl = document.getElementById("filters");
const statsEl = document.getElementById("ostats");
const skyEl = document.getElementById("osky");
const valetEl = document.getElementById("ovalet");
const spareEl = document.getElementById("ospare");
const exaltEl = document.getElementById("oexalt");
const VIEWS = { tracked: "otTracked", loot: "otLoot", stats: "otStats", sky: "otSky",
                valet: "otValet", spare: "otSpare", exalt: "otExalt" };
/* Which tabs this window carries at all — chosen in the app's Settings, not
   here: four tabs is a lot of chrome in a 340px window, and the ones a player
   never opens are pure clutter (Kyle, 2026-08-13). */
const shownViews = () => {
  const on = (PREFS.views || []).filter(v => VIEWS[v]);
  return on.length ? on : Object.keys(VIEWS);
};
function applyView() {
  const on = shownViews();
  const v = on.includes(PREFS.view) ? PREFS.view : on[0];
  questsEl.hidden = v !== "tracked";
  feedEl.hidden = v !== "loot";
  filtersEl.hidden = v !== "loot";
  statsEl.hidden = v !== "stats";
  skyEl.hidden = v !== "sky";
  valetEl.hidden = v !== "valet";
  spareEl.hidden = v !== "spare";
  exaltEl.hidden = v !== "exalt";
  for (const [name, id] of Object.entries(VIEWS)) {
    const b = document.getElementById(id);
    b.hidden = !on.includes(name);
    b.classList.toggle("on", name === v);
  }
  // one tab is not a choice — the row is just a label then, so drop it
  document.getElementById("otabs").classList.toggle("is-single", on.length < 2);
  // the grouping toggle belongs to Tracked; renderQuests also hides it when
  // the payload carries no zones to group by
  const qv = document.getElementById("qView");
  if (qv) qv.hidden = v !== "tracked" || !(TRACKED.zones || []).length;
}
document.getElementById("otabs").addEventListener("click", e => {
  const b = e.target.closest("[data-oview]");
  if (!b || PREFS.view === b.dataset.oview) return;
  PREFS.view = b.dataset.oview;
  window.companion.setOverlayPrefs({ view: PREFS.view });
  applyView();
});

/* Rolled up: the window shrinks to this bar, which main does — the body is
   hidden here so the collapsed strip draws nothing behind the button. */
const rollEl = document.getElementById("btnRoll");
function applyRoll() {
  document.body.classList.toggle("rolled", !!PREFS.collapsed);
  rollEl.textContent = PREFS.collapsed ? "+" : "–";
  rollEl.title = PREFS.collapsed ? "Open it back up" : "Roll up to this bar";
}
rollEl.addEventListener("click", () => {
  PREFS.collapsed = !PREFS.collapsed;
  applyRoll();
  window.companion.setOverlayPrefs({ collapsed: PREFS.collapsed });
});

function wanted(ev) {
  if (ev.kind === "kill") return PREFS.showKills;
  if (ev.kind === "loot") return !PREFS.questOnly || (ev.quests && ev.quests.length > 0);
  return false;
}

/* Item refs {n, url, sb} arrive pre-resolved from the main renderer. sb (the
   EQ item-window lines) rides on the element itself for the mini tooltip. */
function itemSpan(name, url, sb, cls) {
  const s = document.createElement("span");
  s.className = cls + (url ? " is-link" : "");
  s.textContent = name;
  if (url) s.dataset.url = url;
  if (sb) s._sb = { n: name, sb };
  return s;
}

/* Raw events kept locally so a filter change re-filters HISTORY instead of
   rebuilding from main's 50-item relay ring and losing older rows. */
let EVENTS = [];
const EVENT_CAP = 200;

function addEvent(ev) {
  EVENTS.push(ev);
  if (EVENTS.length > EVENT_CAP) EVENTS.shift();
  if (wanted(ev)) { prependRow(ev); rehotspot(); }
}

function rebuildFeed() {
  feedEl.innerHTML = "";
  for (const ev of EVENTS.filter(wanted).slice(-FEED_CAP)) prependRow(ev);
}

function prependRow(ev) {
  const li = document.createElement("li");
  if (ev.kind === "loot") {
    const qty = ev.qty > 1 ? ` ×${ev.qty}` : "";
    if (ev.quests && ev.quests.length) {
      li.className = "quest";
      // an in-era quest outranks out-of-era ones for the single shown slot
      const q = ev.quests.find(x => !x.oe) || ev.quests[0];
      li.append(itemSpan(ev.item + qty, ev.url, ev.sb, "itm"));
      li.insertAdjacentHTML("beforeend", ` — <span class="qn" data-url="${esc(q.url || "")}">${esc(q.n)}</span>`);
      if (q.oe) li.insertAdjacentHTML("beforeend", ` <span class="oe">out of era</span>`);
      if (ev.quests.length > 1) li.insertAdjacentHTML("beforeend", ` <span class="dim">+${ev.quests.length - 1}</span>`);
      if (q.rewards && q.rewards.length) {
        const r = document.createElement("span");
        r.className = "rew"; r.append(" → ");
        q.rewards.forEach((ref, i) => {
          if (i) r.append(", ");
          r.append(itemSpan(ref.n, ref.url, ref.sb, "ri"));
        });
        li.append(r);
      }
    } else {
      li.className = "loot";
      li.append(itemSpan(ev.item + qty, ev.url, ev.sb, "itm itm--plain"));
    }
  } else {
    li.className = "kill";
    li.append("✕ ");
    li.append(itemSpan(ev.n, ev.url, null, "mob"));
  }
  feedEl.prepend(li);
  while (feedEl.children.length > FEED_CAP) feedEl.lastChild.remove();
}

/* The filter row drives the same prefs as Settings; main echoes the change
   back through overlay:init, which rebuilds the feed under the new filters. */
const fKills = document.getElementById("fKills");
const fQuestOnly = document.getElementById("fQuestOnly");
function renderFilters() { fKills.checked = PREFS.showKills; fQuestOnly.checked = PREFS.questOnly; }
fKills.addEventListener("change", () => window.companion.setOverlayPrefs({ showKills: fKills.checked }));
fQuestOnly.addEventListener("change", () => window.companion.setOverlayPrefs({ questOnly: fQuestOnly.checked }));

/* Tracked view — pre-resolved by the main renderer, which owns every dataset:
     {zones: [{z, url, left, items}],
      quests: [{n, url, got, need, done, oe, zones: […], parts: […]}]}
   with each item {n, have, want, url, mobs: [name], note?, tag?} — `note` when
   the zone sells or forages the item instead of dropping it.

   The whole working list: every item with a held mark and its count, wiki links
   on the item, and the mobs that drop it IN the zone you are reading (Kyle,
   2026-07-31: "I need to see the list of things i need. i need to see what zone
   and mob. i need to be able to click all of those things"). Two groupings,
   toggled in the header: pooled by zone across every tracked quest — the one
   you read while standing somewhere — or by quest. Inside a quest the items
   still group by zone, so clearing a zone never leaves something behind. */
let TRACKED = { zones: [], quests: [] };
let QVIEW = "zone";
const link = (text, url, cls) => {
  const a = document.createElement("span");
  a.className = cls; a.textContent = text;
  if (url) a.dataset.url = url;
  return a;
};

function itemLi(it) {
  const done = it.have >= it.want;
  const cl = document.createElement("li");
  cl.className = `${done ? "is-have" : ""} ${it.mk ? "is-marked" : ""}`.trim();
  /* The tick is the "I have this" switch, because the two ways to already
     own something — bought from a merchant, parked on your pet — reach no
     log line and no dump, so the app can never see them on its own. */
  const tick = document.createElement("span");
  tick.className = "tqc__tick"; tick.textContent = done ? "✓" : "·";
  tick.dataset.hold = it.n;
  tick.title = it.mk ? "Marked as held — click to clear"
    : "Mark as held (bought it, or it's on your pet)";
  cl.append(tick, link(it.n, it.url, "tqc__n"));
  if (it.want > 1 || it.have) {
    const x = document.createElement("span");
    x.className = "tqc__ct"; x.textContent = `${it.have}/${it.want}`;
    cl.append(x);
  }
  if (it.tag) {
    const t = document.createElement("span");
    t.className = "tqc__tag"; t.textContent = it.tag;
    if (it.tt) t.title = it.tt;   // hover: what the quest(s) pay
    cl.append(t);
  }
  // note AND mobs: 'Isle 6 · Bazzt Zzzt' — the island rides alongside the boss
  const src = it.mk ? "marked held"
    : !done && [it.note, it.mobs && it.mobs.join(", ")].filter(Boolean).join(" · ");
  if (src) {
    const s = document.createElement("span");
    s.className = "tqc__src"; s.textContent = src;
    cl.append(s);
  }
  return cl;
}

function zoneLi(g) {
  const li = document.createElement("li");
  li.className = g.left ? "tz" : "tz is-done";
  const h = document.createElement("div");
  h.className = "tz__h";
  h.append(link(g.z, g.url, "tz__n"));
  // a wiki city page ('Freeport') covers several client zones — it is not
  // somewhere you can stand, so say the data is vague instead of naming it
  if (g.umb) {
    const u = document.createElement("span");
    u.className = "tz__umb"; u.textContent = "which zone?";
    h.append(u);
  }
  const c = document.createElement("span");
  c.className = "tz__c"; c.textContent = g.left ? `${g.left} to get` : "all held";
  h.append(c);
  li.append(h);
  const ul = document.createElement("ul");
  ul.className = "tqc";
  for (const it of g.items) ul.append(itemLi(it));
  li.append(ul);
  return li;
}

/* Held counts are only ever as fresh as the last `/outputfile inventory`.
   Nothing you buy or hand to your pet shows up until you dump again, so once
   the dump is old enough to be misleading the list says how old — silence
   here reads as "you definitely still need this". */
const INV_STALE_MS = 10 * 60 * 1000;
function invAge() {
  const inv = TRACKED.inv;
  const li = document.createElement("li");
  li.className = "tq-inv";
  if (!inv) { li.textContent = "No inventory dump yet — /outputfile inventory"; return li; }
  if (inv.age < INV_STALE_MS) return null;
  const m = Math.round(inv.age / 60000);
  li.textContent = `Inventory is ${m < 60 ? `${m}m` : `${Math.round(m / 60)}h`} old — /outputfile inventory to refresh`;
  return li;
}

function renderQuests() {
  questsEl.innerHTML = "";
  const quests = TRACKED.quests || [];
  if (!quests.length) {
    const li = document.createElement("li");
    li.className = "tq-none";
    li.textContent = "Nothing tracked — hit Track on a quest in the app.";
    questsEl.append(li);
    return;
  }
  // no zones in the payload means the main window had no source table to group
  // by (older dataset); fall back to the flat list rather than an empty panel
  const grouped = (TRACKED.zones || []).length > 0;
  if (qViewEl) qViewEl.hidden = !grouped || PREFS.view !== "tracked";
  const stale = invAge();
  if (stale) questsEl.append(stale);
  if (QVIEW === "zone" && grouped) {
    for (const g of TRACKED.zones) questsEl.append(zoneLi(g));
    return;
  }
  for (const q of quests) {
    const li = document.createElement("li");
    li.className = q.done ? "tq is-done" : "tq";
    const nm = link(q.n, q.url, "tq__n");
    if (q.rew) nm.title = `reward: ${q.rew}`;
    li.append(nm);
    if (q.oe) {
      const o = document.createElement("span");
      o.className = "oe"; o.textContent = "out of era";
      li.append(o);
    }
    const c = document.createElement("span");
    c.className = "tq__c"; c.textContent = q.done ? `✓ ${q.got}/${q.need}` : `${q.got}/${q.need}`;
    li.append(c);
    if (q.next) {
      // the one thing to do next on this quest, resolved by the main window
      const nx = document.createElement("div");
      nx.className = "tq__next"; nx.textContent = `next: ${q.next}`;
      li.append(nx);
    }
    const ul = document.createElement("ul");
    if ((q.zones || []).length) {
      ul.className = "tzs";
      for (const g of q.zones) ul.append(zoneLi(g));
    } else {
      ul.className = "tqc";
      for (const it of q.comps || []) ul.append(itemLi(it));
    }
    li.append(ul);
    questsEl.append(li);
  }
}

const qViewEl = document.getElementById("qView");
if (qViewEl) qViewEl.addEventListener("click", () => {
  QVIEW = QVIEW === "zone" ? "quest" : "zone";
  qViewEl.textContent = QVIEW === "zone" ? "by zone" : "by quest";
  renderQuests(); rehotspot();
});

// older main windows sent a bare array of quests; keep reading it
const asTracked = q => Array.isArray(q) ? { zones: [], quests: q, inv: null }
  : (q || { zones: [], quests: [], inv: null });
window.companion.onFeedQuests(q => { TRACKED = asTracked(q); renderQuests(); rehotspot(); });

/* Parser view — session numbers for the current zone visit, then the SCOPE
   row, which is one question asked over five stretches of play:

     fights          the encounters — the pull plus its adds — each expandable
                     to the full drill-down, including who else swung at it
     5m · 10m · 15m  everyone's damage over the last N minutes
     all             everyone's damage for the whole visit, which is the whole
                     instance when you are in one

   The rolling windows exist because a whole-instance meter is the wrong
   comparison for anyone who joined late (Kyle, 2026-08-14: "not fair to
   compare whole instance for new people"). A window shorter than the combat
   we hold is the only kind offered — the main renderer sends the list.

   All numbers arrive pre-resolved from the main renderer's engine run; this
   window only draws and remembers which rows are open. */
let STATS = null, OSEL = null, ORSEL = null;
const n = v => Math.round(v).toLocaleString();
// a 5-minute window can hold 40 seconds of fighting, and "1m" for that is a lie
const fmtMins = s => s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`;
const fmtCu = cu => {
  cu = Math.round(cu);
  const p = Math.floor(cu / 1000), g = Math.floor(cu % 1000 / 100), s = Math.floor(cu % 100 / 10);
  return p ? `${n(p)}p ${g}g` : g ? `${g}g ${s}s` : `${s}s ${cu % 10}c`;
};
const SIDE_LBL = { you: "you", pet: "your pet", charm: "charm" };
// no "mob" tag: see RAID_TAG in the main renderer — a raider who took a hit is
// in the engine's mobSet, so that label was false on real players' rows
const RAID_LBL = { you: "you", pet: "your pet", charm: "your charm" };

function osrcRows(rows) {
  return rows.map(s =>
    `<tr><td class="os-tn">${esc(s.name)}</td><td>${s.hits}×</td>` +
    `<td class="os-td">${n(s.dmg)}</td><td>${n(s.max)} max</td><td>${s.crit ? s.crit + " crit" : ""}</td></tr>`).join("");
}

/* Everyone's damage over one stretch — the meter's rows, shared by the pull
   drill-down and the windowed views. */
function ometerRows(rt) {
  const secs = Math.max(1, rt.secs);
  return rt.actors.map(a =>
    `<tr><td class="os-tn">${esc(a.name)}${RAID_LBL[a.who] ? ` <span class="os-d">${RAID_LBL[a.who]}</span>` : ""}</td>` +
    `<td>${(a.dmg / rt.total * 100).toFixed(0)}%</td><td class="os-td">${n(a.dmg)}</td>` +
    `<td>${n(a.dmg / secs)} dps</td></tr>`).join("");
}

function encDetailHtml(f) {
  const d = f.detail;
  let h = `<div class="os-x">`;
  if (f.mobs && f.mobs.length > 1) {
    h += `<table class="os-t">` + f.mobs.map(m =>
      `<tr><td class="os-tn">${m.killed ? (m.team ? "✓ " : "✕ ") : ""}${esc(m.mob)}</td>` +
      `<td class="os-td">${n(m.dmg)}</td><td>${m.taken ? n(m.taken) + " to you" : ""}</td>` +
      `<td>${m.xp ? m.xp + "% xp" : ""}</td></tr>`).join("") + `</table>`;
  }
  // who else was on this pull — the meter, bounded by this encounter. Absent
  // when you fought it alone, where the row above already said it.
  if (f.raid && f.raid.actors.length > 1) {
    h += `<div class="os-h os-rd">everyone · ${n(f.raid.total)}</div>` +
      `<table class="os-t">${ometerRows(f.raid)}</table>`;
  }
  if (d) {
    for (const side of ["you", "pet", "charm"]) {
      const rows = d.sources.filter(s => s.side === side);
      if (!rows.length) continue;
      h += `<div class="os-h os-${side}">${SIDE_LBL[side]} · ${n(d.tot[side])}</div>` +
        `<table class="os-t">${osrcRows(rows)}</table>`;
    }
    if (d.takenBy && d.takenBy.length) {
      h += `<div class="os-h os-tk">hit you · ${n(d.taken)}</div><table class="os-t">` +
        d.takenBy.map(t =>
          `<tr><td class="os-tn">${esc(t.src)} <span class="os-d">${esc(t.name)}</span></td><td>${t.hits}×</td>` +
          `<td class="os-td">${n(t.dmg)}</td><td>${n(t.max)} max</td><td>${t.res ? t.res + " resisted" : ""}</td></tr>`).join("") + `</table>`;
    }
    const bits = [];
    for (const [how, c] of d.avoid || []) bits.push(`${how} ×${c}`);
    if (d.healTot) bits.push(`healed ${n(d.healTot)}`);
    if (d.healInTot) bits.push(`took heals ${n(d.healInTot)}`);
    if (d.petTaken) bits.push(`pet took ${n(d.petTaken)}`);
    if (f.coin) bits.push(fmtCu(f.coin));
    if (bits.length) h += `<div class="os-d os-foot">${bits.join(" · ")}</div>`;
  }
  return h + `</div>`;
}

function renderOStats() {
  if (!STATS || !STATS.session) { statsEl.innerHTML = `<div class="os-none">No combat yet.</div>`; return; }
  const s = STATS.session;
  const bits = [];
  if (s.mins) bits.push(`<b>${s.mins}m</b> active`);
  bits.push(`<b>${n(s.dmg)}</b> dmg`);
  if (s.dps != null) bits.push(`<b>${n(s.dps)}</b> dps`);
  bits.push(`<b>${s.kills}</b> kills`);
  if (s.xp) bits.push(`<b>${s.xp}%</b> xp`);
  if (s.kph != null && s.kills) bits.push(`<b>${s.kph}</b> kills/h`);
  if (s.xph != null && s.xp) bits.push(`<b>${s.xph}%</b> xp/h`);
  if (s.taken) bits.push(`<b>${n(s.taken)}</b> taken`);
  if (s.coin) bits.push(`<b>${fmtCu(s.coin)}</b>`);
  let h = `<div class="os-sess">${s.zone ? `<span class="os-zone">${esc(s.zone)}</span>` : ""}` +
    bits.map(b => `<span class="os-c">${b}</span>`).join("") + `</div>`;
  const raid = STATS.raid && STATS.raid.actors && STATS.raid.actors.length > 1 ? STATS.raid : null;
  const view = raid && PREFS.statsScope === "meter" ? "meter" : "fights";
  {
    // the same clamp the main renderer applies before it computes, so the lit
    // button and the numbers under it can't disagree while the pref round-trips
    const wins = (STATS.wins || []).concat([0]);
    const win = wins.includes(+PREFS.statsWindow) ? +PREFS.statsWindow : 0;
    h += `<div class="os-sub">` +
      `<button data-osub="fights" class="${view === "fights" ? "on" : ""}">fights</button>` +
      (raid ? wins.map(m => `<button data-osub="meter" data-owin="${m}" ` +
        `class="${view === "meter" && win === m ? "on" : ""}">${m ? m + "m" : (STATS.allLabel || "all")}</button>`).join("") : "") +
      // reset is offered whether or not you're in a group — it governs the
      // session line too — and the ✕ is the way back out of one
      `<button data-oreset="1" class="os-rs" title="Count from now">reset</button>` +
      (STATS.zero ? `<button data-oreset="0" class="os-rs" title="Count from the start of the visit again">✕</button>` : "") +
      `</div>`;
  }
  if (STATS.zero && !raid && !(STATS.fights && STATS.fights.length))
    h += `<div class="os-none">Nothing since the reset.</div>`;
  if (view === "meter") {
    const secs = Math.max(1, raid.secs);
    h += `<div class="os-d os-rline">${n(raid.total)} dmg · ${n(raid.total / secs)} dps · ${fmtMins(secs)} of combat</div>` +
      `<ul class="os-fights">` + raid.actors.map(a => {
        const tag = RAID_LBL[a.who] ? ` <span class="os-d">${RAID_LBL[a.who]}</span>` : "";
        let li = `<li data-ract="${esc(a.name)}"><span class="os-mob">${esc(a.name)}${tag}</span>` +
          `<span class="os-nums">${(a.dmg / raid.total * 100).toFixed(0)}% · ${n(a.dmg)} · ${n(a.dmg / secs)} dps</span></li>`;
        if (ORSEL === a.name)
          li += `<li class="os-xrow"><div class="os-x"><table class="os-t">${osrcRows(a.sources)}</table></div></li>`;
        return li;
      }).join("") + `</ul>`;
  } else if (STATS.fights && STATS.fights.length) {
    h += `<ul class="os-fights">` + STATS.fights.map(f => {
      const label = f.mobs && f.mobs.length
        ? esc(f.mobs[0].mob) + (f.mobs.length > 1 ? ` <span class="os-d">+${f.mobs.length - 1}</span>` : "")
        : esc(f.mob || "?");
      const marks = f.kills > 1 ? `${f.team ? "✓" : "✕"}×${f.kills} ` : f.kills ? (f.team ? "✓ " : "✕ ") : "";
      let li = `<li data-enc="${esc(f.key || "")}"${f.team ? "" : ` class="os-dim"`}>` +
        `<span class="os-mob">${marks}${label}</span>` +
        `<span class="os-nums">${f.secs}s · ${n(f.dmg)} · ${n(f.dps)} dps${f.taken ? ` · ${n(f.taken)} tkn` : ""}${f.xp ? ` · ${f.xp}%` : ""}</span></li>`;
      if (OSEL && OSEL === f.key) li += `<li class="os-xrow">${encDetailHtml(f)}</li>`;
      return li;
    }).join("") + `</ul>`;
  }
  statsEl.innerHTML = h;
}
statsEl.addEventListener("click", e => {
  const rs = e.target.closest("[data-oreset]");
  if (rs) { window.companion.statsReset(rs.dataset.oreset === "1"); return; }
  const sb = e.target.closest("[data-osub]");
  if (sb) {
    PREFS.statsScope = sb.dataset.osub;
    const patch = { statsScope: PREFS.statsScope };
    if (sb.dataset.owin !== undefined) patch.statsWindow = PREFS.statsWindow = +sb.dataset.owin;
    // main persists it and hands the window to the renderer, which is what
    // computes the meter — the app's Combat tab reads the same value
    window.companion.setOverlayPrefs(patch);
    renderOStats(); rehotspot(); return;
  }
  const en = e.target.closest("[data-enc]");
  if (en) { OSEL = OSEL === en.dataset.enc ? null : en.dataset.enc; renderOStats(); rehotspot(); return; }
  const ra = e.target.closest("[data-ract]");
  if (ra) { ORSEL = ORSEL === ra.dataset.ract ? null : ra.dataset.ract; renderOStats(); rehotspot(); }
});
window.companion.onFeedStats(s => { STATS = s; renderOStats(); rehotspot(); });

/* Locked = the game gets the mouse. There is no button for it any more (Kyle,
   2026-08-13: "i don't think pin is useful. there's no value in locking it
   down") — it lives in the bar's right-click menu and on Ctrl+Shift+L. The word
   in the bar is the only thing that says which state you're in, so it stays. */
function setMode(clickThrough, opacity) {
  THROUGH = !!clickThrough;
  if (opacity !== undefined) document.body.style.opacity = opacity;
  document.body.classList.toggle("through", THROUGH);
  lockEl.hidden = !THROUGH;
}

/* ── Valet ───────────────────────────────────────────────────────────────
   The RESULT of the app's Valet walk and nothing else: what to pull, and out of
   which bag or bank slot. Picking twenty-three slots through a 340px panel is
   not a thing anyone would do with a corpse on the floor — that happens in the
   app window, and this is what you read standing at the banker.

   Rows already on your body are not listed. They are the rows with nothing to
   do, and the header states how many there are so their absence is a fact
   rather than a gap. */
let VALET = null;
const VAL_CLOSED = new Set();
function renderValet() {
  valetEl.innerHTML = "";
  if (!VALET) {
    valetEl.innerHTML = `<div class="osk-none">Open the app's Valet tab and pick a loadout.</div>`;
    return;
  }
  const head = document.createElement("div");
  head.className = "osk-head";
  head.textContent = VALET.fetch.length
    ? `${VALET.fetch.length} to pull · ${VALET.worn} already on` + (VALET.gain ? ` · ${VALET.gain > 0 ? "+" : ""}${VALET.gain}` : "")
    : `nothing to pull · ${VALET.worn} already on`;
  if (VALET.trio) head.title = VALET.trio;
  valetEl.append(head);
  if (!VALET.ready) {
    const w = document.createElement("div");
    w.className = "osk-warn";
    w.textContent = "Walk isn't finished — this is what you've picked so far.";
    valetEl.append(w);
  }
  // one fold per place, in the order the app already sorted them
  const groups = [];
  for (const r of VALET.fetch) {
    const key = r.loc.k === "word" ? r.loc.w : `${r.loc.k} ${r.loc.n}`;
    let g = groups.length && groups[groups.length - 1].key === key ? groups[groups.length - 1] : null;
    if (!g) groups.push(g = { key, loc: r.loc, rows: [] });
    g.rows.push(r);
  }
  for (const g of groups) {
    const sec = document.createElement("section");
    sec.className = "ovg";
    const h = document.createElement("button");
    h.type = "button"; h.className = "ovg__h"; h.dataset.ovalet = g.key;
    h.append(skyLocEl(g.loc));
    const c = document.createElement("span");
    c.className = "ovg__c"; c.textContent = g.rows.length;
    h.append(c);
    sec.append(h);
    if (!VAL_CLOSED.has(g.key)) {
      const ul = document.createElement("ul");
      ul.className = "ovl";
      for (const r of g.rows) {
        const li = document.createElement("li");
        li.className = "ovi";
        const sl = document.createElement("span");
        sl.className = "ovi__s"; sl.textContent = r.slot;
        li.append(sl, itemSpan(r.n, r.url, r.sb, "ovi__n"));
        if (r.loc.sub) {
          const sub = document.createElement("span");
          sub.className = "ovi__sub"; sub.textContent = "slot " + r.loc.sub;
          li.append(sub);
        }
        ul.append(li);
      }
      sec.append(ul);
    }
    valetEl.append(sec);
  }
}
valetEl.addEventListener("click", (e) => {
  const h = e.target.closest("[data-ovalet]");
  if (!h) return;
  const k = h.dataset.ovalet;
  VAL_CLOSED.has(k) ? VAL_CLOSED.delete(k) : VAL_CLOSED.add(k);
  renderValet();
});

/* ── Spare ────────────────────────────────────────────────────────────────
   The bank-trip half of the same dump the Valet view reads. Valet says what to
   pull out; this says what can go back in, or go. It is one flat list — the
   most-beaten first, with where it is sitting — because the decision at a
   banker is per item and there is nothing to fold.

   Off by default (Kyle, 2026-08-14) — this is not a thing you read mid-fight.
   The chip on a row is the one thing the ranking cannot see: an item whose
   whole point is a click, a proc or a bard resonance is beaten on stats and
   still worth keeping, and a 340px window has no room to explain that twice. */
let SPARE = null;
function renderSpare() {
  spareEl.innerHTML = "";
  if (!SPARE) {
    spareEl.innerHTML = `<div class="osk-none">Load an inventory dump in the app — type <code>/out inventory</code> in game.</div>`;
    return;
  }
  const head = document.createElement("div");
  head.className = "osk-head";
  head.textContent = SPARE.rows.length
    ? `${SPARE.n} beaten of ${SPARE.total}`
    : `nothing beaten of ${SPARE.total}`;
  spareEl.append(head);
  if (!SPARE.rows.length) return;
  const ul = document.createElement("ul");
  ul.className = "ovl";
  for (const r of SPARE.rows) {
    const li = document.createElement("li");
    li.className = "ovi";
    const n = document.createElement("span");
    n.className = "ovi__s"; n.textContent = r.ahead;
    n.title = `${r.ahead} of the things you own beat it for a ${r.cls} in ${r.slot}`;
    li.append(n, itemSpan(r.n, r.url, r.sb, "ovi__n"));
    if (r.warn) {
      const w = document.createElement("span");
      w.className = "ovi__warn"; w.textContent = r.warn;
      w.title = "Not part of the score.";
      li.append(w);
    }
    li.append(skyLocEl(r.loc));
    ul.append(li);
  }
  spareEl.append(ul);
}

/* ── Exalt ────────────────────────────────────────────────────────────────
   The loose exaltations in your storage that would go into something you are
   wearing right now — socket open, class and slot shared — one line each,
   with the worn item it fits. The verdicts are the app's (vendor/exalt-core.js
   over the same dump the Inventory tab reads); this window only lists them.
   Off by default like Spare: it is a banker's-desk read, not a fight read. */
let EXALT = null;
function renderExalt() {
  exaltEl.innerHTML = "";
  if (!EXALT) {
    exaltEl.innerHTML = `<div class="osk-none">Load an inventory dump in the app — type <code>/out inventory</code> in game.</div>`;
    return;
  }
  const head = document.createElement("div");
  head.className = "osk-head";
  head.textContent = EXALT.rows.length
    ? `${EXALT.rows.length} of ${EXALT.loose} loose fit what you wear`
    : `${EXALT.loose} loose · none fit what you wear`;
  exaltEl.append(head);
  if (!EXALT.rows.length) return;
  const ul = document.createElement("ul");
  ul.className = "ovl";
  for (const r of EXALT.rows) {
    const li = document.createElement("li");
    li.className = "ovi";
    const k = document.createElement("span");
    k.className = "ovi__s"; k.textContent = r.kind;
    li.append(k, itemSpan(r.n, r.url, r.sb, "ovi__n"));
    const to = document.createElement("span");
    to.className = "ovi__warn"; to.textContent = `→ ${r.into}`;
    to.title = r.effect + (r.more ? ` · also fits ${r.more}` : "");
    li.append(to);
    ul.append(li);
  }
  exaltEl.append(ul);
}

window.companion.onOverlayInit(({ opacity, clickThrough, prefs, feed, zone, quests, stats, sky, valet, spare, exalt }) => {
  if (prefs) PREFS = { ...PREFS, ...prefs };
  panelEl.style.zoom = PREFS.fontScale;
  setMode(clickThrough, opacity);
  renderFilters();
  // a fresh window seeds from main's ring; a prefs re-init keeps the richer
  // local history and just re-filters it
  if (!EVENTS.length) EVENTS = (feed || []).slice(-EVENT_CAP);
  rebuildFeed();
  setZone(zone);
  TRACKED = asTracked(quests);
  renderQuests();
  if (stats) STATS = stats;
  renderOStats();
  if (sky) SKYP = sky;
  renderSky();
  if (valet) VALET = valet;
  renderValet();
  if (spare) SPARE = spare;
  renderSpare();
  if (exalt) EXALT = exalt;
  renderExalt();
  applyView(); applyRoll();
});
window.companion.onOverlayMode(({ clickThrough, opacity }) => setMode(clickThrough, opacity));
window.companion.onFeedEvent(addEvent);
window.companion.onFeedZone(setZone);

function setZone(z) {
  zoneEl.textContent = z ? `${z.name} ${z.done}/${z.total}` : "EQL Tools Companion";
}

/* The bar's own menu — every overlay setting, drawn by the OS so it can paint
   outside a 26px-tall window. */
const barEl = document.getElementById("bar");
barEl.addEventListener("contextmenu", e => {
  e.preventDefault();
  window.companion.overlayMenu();
});

/* …and the bar moves the window itself, because it is no longer an app-region
   (a Windows caption hit-test would eat the right-click above).

   ONE gesture implementation for the bar and the corner grip. Every event
   hands main its own screen position, and main works in the difference from
   the one below — which is why these are screen coordinates and not clientX:
   client coordinates move with the window, so a drag would be reading its own
   output back. */
function dragsWindow(el, kind) {
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    window.companion.overlayDragStart(kind, e.screenX, e.screenY);
    const move = ev => window.companion.overlayDragMove(ev.screenX, ev.screenY);
    let done = false;
    /* Every way the gesture can end has to detach `move`. A pointerup can go
       missing — the OS can take the capture away mid-drag — and a `move` left
       attached keeps dragging the window around with no button held. */
    const up = () => {
      if (done) return;
      done = true;
      el.removeEventListener("pointermove", move);
      try { el.releasePointerCapture(e.pointerId); } catch {}
      window.companion.overlayDragEnd();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
    el.addEventListener("lostpointercapture", up, { once: true });
  });
}
dragsWindow(barEl, "move");

/* Mini EQ item tooltip — the sb lines ride on the hovered element. Works
   pinned too (forward:true keeps mousemove flowing). */
/* Sky view — the quest room, on top of the game. Everything arrives resolved
   from the main window (this window holds no datasets): which tests the widget
   options let through, what you hold, and where each piece is sitting. What it
   shows is chosen on the app's Sky tab, not here — the overlay is 340px wide
   and a filter row for sixteen classes would eat it. */
let SKYP = null;
const SKY_CLOSED = new Set();   // folds the player collapsed, this session
const SKY_BAG = `<svg class="oskl__i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.6 5.5h8.8l-.9 7.4a1 1 0 0 1-1 .9H5.5a1 1 0 0 1-1-.9z"/><path d="M6 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>`;
const SKY_COIN = `<svg class="oskl__i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.2"/><circle cx="8" cy="8" r="1.9"/></svg>`;
function skyLocEl(b) {
  const s = document.createElement("span");
  s.className = "oskl oskl--" + b.k;
  s.title = b.t || "";
  if (b.k === "word") { s.textContent = b.w; return s; }
  s.innerHTML = (b.k === "bag" ? SKY_BAG : SKY_COIN) + `<b>${b.n}</b>` +
    (b.sub ? `<span class="oskl__s">·${b.sub}</span>` : "");
  return s;
}
function skyItemLi(it) {
  const done = it.have >= it.need;
  const li = document.createElement("li");
  li.className = `oski ${done ? "is-have" : ""} ${it.rune ? "is-rune" : ""}`.trim();
  const tick = document.createElement("span");
  tick.className = "oski__t"; tick.textContent = done ? "✓" : "·";
  tick.dataset.hold = it.n;
  tick.title = done ? "" : "Mark as held (bought it, or it's on your pet)";
  li.append(tick, itemSpan(it.n, it.url, it.sb, "oski__n"));
  if (it.star) {
    const s = document.createElement("span");
    s.className = "oski__star"; s.textContent = "★";
    s.title = "Another Sky test wants this one too";
    li.append(s);
  }
  const c = document.createElement("span");
  c.className = "oski__c"; c.textContent = `${it.have}/${it.need}`;
  li.append(c);
  for (const b of it.locs || []) li.append(skyLocEl(b));
  if (it.isl) {
    const s = document.createElement("span");
    s.className = "oski__src"; s.textContent = it.isl;
    li.append(s);
  }
  return li;
}
function renderSky() {
  skyEl.innerHTML = "";
  if (!SKYP || !SKYP.groups) {
    skyEl.innerHTML = `<div class="osk-none">Waiting for the app to read your log.</div>`;
    return;
  }
  const head = document.createElement("div");
  head.className = "osk-head";
  const dr = SKYP.drop || { n: 0, give: 0 };
  head.textContent = SKYP.view === "boss"
    ? `${SKYP.loot || 0} pieces to loot · ${SKYP.done}/${SKYP.tests} done`
    : SKYP.view === "drop"
    ? `${dr.n} to clear out${dr.give ? ` · ${dr.give} sellable` : ""} · ${SKYP.done}/${SKYP.tests} done`
    : `${SKYP.ready} ready · ${SKYP.done}/${SKYP.tests} done`;
  skyEl.append(head);
  if (!SKYP.inv) {
    const w = document.createElement("div");
    w.className = "osk-note"; w.textContent = "No inventory dump — /out inventory to see where each piece is";
    skyEl.append(w);
  } else if (SKYP.inv.age > 10 * 60 * 1000) {
    const m = Math.round(SKYP.inv.age / 60000);
    const w = document.createElement("div");
    w.className = "osk-note";
    w.textContent = `Inventory is ${m < 60 ? `${m}m` : `${Math.round(m / 60)}h`} old — /out inventory to refresh`;
    skyEl.append(w);
  }
  if (SKYP.view === "boss") { renderSkyBoss(); return; }
  if (SKYP.view === "drop") { renderSkyDrops(); return; }
  if (!SKYP.groups.length) {
    const d = document.createElement("div");
    d.className = "osk-none";
    d.textContent = "Nothing to hand in. Widen the widget options on the app's Sky tab.";
    skyEl.append(d);
    return;
  }
  for (const g of SKYP.groups) {
    const sec = document.createElement("div");
    sec.className = "osg";
    const h = document.createElement("div");
    h.className = "osg__h"; h.dataset.osky = g.code;
    const open = !SKY_CLOSED.has(g.code);
    h.title = `${g.tests.length} test${g.tests.length === 1 ? "" : "s"} shown for ${g.name}`;
    h.innerHTML = `<span class="osg__k">${open ? "▾" : "▸"}</span>` +
      `<span class="osg__n">${esc(g.name)}</span><span class="osg__g">${esc(g.giver)}</span>` +
      `<span class="osg__c">${g.ready ? `${g.ready} ready` : `${g.tests.length} test${g.tests.length === 1 ? "" : "s"}`}</span>`;
    sec.append(h);
    if (open) {
      for (const t of g.tests) {
        const d = document.createElement("div");
        d.className = "ost" + (t.ready ? " is-ready" : "") + (t.done || t.ach ? " is-done" : "");
        const th = document.createElement("div");
        th.className = "ost__h";
        th.innerHTML = `<span class="ost__n">${esc(t.n)}</span>` +
          (t.say ? `<span class="ost__say">say <b>${esc(t.say)}</b></span>` : "") +
          (t.ready ? `<span class="ost__st">ready</span>`
            : t.done ? `<span class="ost__st is-done">✓${t.done}</span>`
            // The achievement record witnessed it, this log didn't — no count
            // to print, so the tick stands alone.
            : t.ach ? `<span class="ost__st is-done">✓</span>`
            : `<span class="ost__st is-miss">${t.missing} left</span>`);
        d.append(th);
        const ul = document.createElement("ul");
        ul.className = "oskl-list";
        for (const it of t.items) ul.append(skyItemLi(it));
        d.append(ul);
        if (t.rew && t.rew.n) {
          const r = document.createElement("div");
          r.className = "ost__rew"; r.append("→ ");
          r.append(itemSpan(t.rew.n, t.rew.url, t.rew.sb, "ri"));
          d.append(r);
        }
        sec.append(d);
      }
    }
    skyEl.append(sec);
  }
}
/* The cleanout list — the view you want standing at the bank with eight bags
   open. Every row is one Sky item you ticked skip on and are still carrying:
   how many, where, which tests you skipped, and which of the two disposals it
   is. A row that says "sell" is not NO DROP, and a merchant is the wrong place
   for it.

   The app decides all of it; this window only draws. */
function renderSkyDrops() {
  const d = SKYP.drop || { rows: [], n: 0, total: 0, skips: 0 };
  if (!d.rows.length) {
    const n = document.createElement("div");
    n.className = "osk-none";
    n.textContent = d.skips
      ? `Nothing skipped is in your bags. ${d.skips} test${d.skips === 1 ? "" : "s"} worth skipping on the app's Sky tab.`
      : "Nothing in your bags belongs to a test you've skipped.";
    skyEl.append(n);
    return;
  }
  for (const r of d.rows) {
    const row = document.createElement("div");
    row.className = "oskd";
    const top = document.createElement("div");
    top.className = "oskd__h";
    const c = document.createElement("span");
    c.className = "oskd__c"; c.textContent = "×" + r.count;
    top.append(c, itemSpan(r.n + (r.tier ? " +" + r.tier : ""), r.url, r.sb, "oskd__n"));
    const how = document.createElement("span");
    how.className = "oskd__how " + (r.give === true ? "is-give" : r.give === false ? "is-nd" : "is-unk");
    how.textContent = r.give === true ? "sell" : r.give === false ? "destroy" : "?";
    how.title = r.give === true ? "Not NO DROP — another player can take it"
      : r.give === false ? "NO DROP — destroying it is what frees the slot"
      : "No item page on the wiki, so nothing here knows whether it is NO DROP";
    top.append(how);
    row.append(top);
    const why = document.createElement("div");
    why.className = "oskd__w";
    for (const b of r.locs || []) why.append(skyLocEl(b));
    why.append(r.why);
    row.append(why);
    skyEl.append(row);
  }
  if (d.total > d.rows.length) {
    const m = document.createElement("div");
    m.className = "osk-note";
    m.textContent = `${d.total - d.rows.length} more on the app's Sky tab`;
    skyEl.append(m);
  }
}

/* The same board arranged by what drops it — the view you want with a corpse on
   the floor. Only mobs that still owe you something are sent, so an empty board
   here means the islands have nothing left for you.

   `have` and `need` are the two numbers: what you are holding, and how many
   more this piece owes across every test that still wants it. A starred row is
   a test you are tracking, and those come first. */
function renderSkyBoss() {
  const list = SKYP.bosses || [];
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "osk-none";
    d.textContent = "No island still owes you a piece.";
    skyEl.append(d);
    return;
  }
  for (const b of list) {
    const key = "b:" + b.isl + b.n;
    const sec = document.createElement("div");
    sec.className = "osg";
    const h = document.createElement("div");
    h.className = "osg__h"; h.dataset.osky = key;
    const open = !SKY_CLOSED.has(key);
    h.title = `${b.isle} (island ${b.isl}) — ${b.role}`;
    h.innerHTML = `<span class="osg__k">${open ? "▾" : "▸"}</span>` +
      `<span class="osg__n">${esc(b.n)}</span><span class="osg__g">I${esc(b.isl)}</span>` +
      `<span class="osg__c">${b.track ? `<b class="osg__star">★${b.track}</b> · ` : ""}${b.need} to loot</span>`;
    sec.append(h);
    if (open) {
      const ul = document.createElement("ul");
      ul.className = "oskl-list";
      for (const it of b.drops) {
        const li = document.createElement("li");
        li.className = "oski osb" + (it.track ? " is-track" : "") + (it.have ? " is-have" : "");
        const star = document.createElement("span");
        star.className = "oski__t osb__star";
        star.textContent = it.track ? "★" : "·";
        star.title = it.track ? "A test you're tracking wants this" : "";
        li.append(star, itemSpan(it.n, it.url, it.sb, "oski__n"));
        const c = document.createElement("span");
        c.className = "oski__c";
        c.textContent = `${it.have}/${it.have + it.need}`;
        c.title = `Holding ${it.have}; ${it.need} more to finish every test that wants it`;
        li.append(c);
        for (const bd of it.locs || []) li.append(skyLocEl(bd));
        if (it.buys && it.buys.length) {
          const s = document.createElement("span");
          s.className = "oski__src";
          // a bare "+1" would read as the item's upgrade tier, which is a
          // real thing here — say what the number counts
          s.textContent = it.buys[0] +
            (it.buys.length > 1 ? ` \u00b7 ${it.buys.length} tests` : "");
          s.title = it.buys.join("\n");
          li.append(s);
        }
        ul.append(li);
      }
      sec.append(ul);
    }
    skyEl.append(sec);
  }
}

skyEl.addEventListener("click", e => {
  const h = e.target.closest("[data-osky]");
  if (!h) return;
  const c = h.dataset.osky;
  SKY_CLOSED.has(c) ? SKY_CLOSED.delete(c) : SKY_CLOSED.add(c);
  renderSky(); rehotspot();
});
window.companion.onFeedSky(s => { SKYP = s; renderSky(); rehotspot(); });
window.companion.onFeedValet(v => { VALET = v; renderValet(); rehotspot(); });
window.companion.onFeedSpare(v => { SPARE = v; renderSpare(); rehotspot(); });
window.companion.onFeedExalt(v => { EXALT = v; renderExalt(); rehotspot(); });

const tipEl = document.createElement("div");
tipEl.id = "otip"; tipEl.hidden = true;
document.body.appendChild(tipEl);
function moveTip(x, y) {
  const r = tipEl.getBoundingClientRect();
  let tx = x + 10, ty = y + 10;
  if (tx + r.width > innerWidth - 4) tx = Math.max(4, x - r.width - 10);
  if (ty + r.height > innerHeight - 4) ty = Math.max(4, innerHeight - r.height - 4);
  tipEl.style.left = tx + "px"; tipEl.style.top = ty + "px";
}
let MX = 0, MY = 0;
document.addEventListener("mousemove", e => {
  MX = e.clientX; MY = e.clientY;
  if (!tipEl.hidden) moveTip(e.clientX, e.clientY);
});

/* A rebuild can swap the DOM out from under a pinned cursor — the hotspot
   state must track what is under the pointer NOW, or the next game click
   gets swallowed by a window that thinks it's still over a link. */
// everything actionable while pinned — quest links, controls, and the Stats
// drill-down rows (fights, raid actors, the sub-view switch)
/* While locked, the whole title bar is a hotspot, not just its buttons: the
   right-click menu is the way back out, so the bar has to be able to hear a
   click. The cost is that dragging the pointer across that one thin strip takes
   the mouse from the game for as long as it is over it. */
const HOTSPOT_SEL = "#bar, [data-url], [data-hold], #btnRoll, #filters, #otabs, [data-enc], [data-ract], [data-osub], [data-osky]";
function rehotspot() {
  if (!THROUGH) return;
  const el = document.elementFromPoint(MX, MY);
  const hot = el && el.closest ? el.closest(HOTSPOT_SEL) : null;
  window.companion.overlayHotspot(!!hot);
}

/* Hotspot tracking: while pinned, hovering anything actionable makes the
   window interactive; leaving it hands the mouse back to the game. Shares
   the mouseover pass with the tooltip. */
document.addEventListener("mouseover", e => {
  let tip = null;
  for (let el = e.target; el && el !== document.body; el = el.parentElement)
    if (el._sb) { tip = el._sb; break; }
  if (tip) {
    tipEl.innerHTML = `<div class="ot__name">${esc(tip.n)}</div>` +
      tip.sb.map(l => `<div>${esc(l)}</div>`).join("");
    tipEl.hidden = false; moveTip(e.clientX, e.clientY);
  } else tipEl.hidden = true;
  if (!THROUGH) return;
  const hot = e.target.closest ? e.target.closest(HOTSPOT_SEL) : null;
  window.companion.overlayHotspot(!!hot);
});
document.addEventListener("mouseout", e => {
  if (THROUGH && !e.relatedTarget) window.companion.overlayHotspot(false);
});

document.addEventListener("click", e => {
  const h = e.target.closest("[data-hold]");
  if (h) { window.companion.markHeld(h.dataset.hold); return; }
  const q = e.target.closest("[data-url]");
  if (q && q.dataset.url) window.companion.openWiki(q.dataset.url);
});

/* Corner resize grip — same gesture as the title bar, sized from the window's
   own top-left instead of moving it. Pointer capture keeps the drag alive when
   the cursor leaves this small window. */
dragsWindow(gripEl, "resize");
