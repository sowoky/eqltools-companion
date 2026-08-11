"use strict";
/* EQ Legends Combat Log Parser — the PAGE. Reads an eqlog_<char>_<server>.txt
   in the browser. No upload, no LLM. All parsing/attribution lives in
   engine.js, loaded first by index.html; classic scripts share the global
   scope, so its declarations (parse, buildClaims, analyze, dayKey, …) are
   used here directly — no aliasing, which would collide with them. This file
   is the controls, rendering, tooltips, intake, live watch, and the
   Companion embed. Player-facing honesty notes live in index.html's footer. */

const MIN_RATE_SEC = 5; // below this, a window is too short to quote a DPS for
const rateDps = (dmg, sec) => sec >= MIN_RATE_SEC ? fmt(dmg / sec) : "—";

/* ─── icons / colors ──────────────────────────────────────────────────────*/
const ELEM_HUE = { fire: "var(--ember)", physical: "var(--gold)", magic: "var(--arcane)", cold: "#5aa9d6", poison: "#7fae4b", disease: "#8a9a4b", unresistable: "#cfc8b6" };
function gemFor(s) {
  // physical rows never consult the spell-icon index — skill verbs collide
  // with real spell NAMES (EQL has spells literally called Strike, Frenzy,
  // Smite) and a kick row wearing a cleric nuke's gem reads as a data error
  if (s.cat === "melee") return `<span class="gem gem-melee" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5.5 20 19.5"/><path d="M26 5.5 12 19.5"/><path d="M20 19.5 25.5 25M12 19.5 6.5 25"/></svg></span>`;
  if (s.cat === "ranged") return `<span class="gem gem-melee" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 A 21 21 0 0 1 7 28"/><path d="M7 4 7 28"/><path d="M7 16 27 16"/><path d="M27 16l-5.5-3.5M27 16l-5.5 3.5"/></svg></span>`;
  const ic = spellIcon((s.name || "").toLowerCase());
  if (ic != null) return `<img class="gem" src="/spellmaster/icons/${ic}.png" alt="" loading="lazy" onerror="this.replaceWith(mkDot(${JSON.stringify(s.elem)}))">`;
  return `<span class="gem gem-dot" style="--h:${ELEM_HUE[s.elem] || 'var(--ink-dim)'}" aria-hidden="true"></span>`;
}
window.mkDot = elem => { const s = document.createElement("span"); s.className = "gem gem-dot"; s.style.setProperty("--h", ELEM_HUE[elem] || "var(--ink-dim)"); return s; };

/* ─── render helpers ──────────────────────────────────────────────────────*/
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
// Display only. othermob folds into "other": the label comes from the actor's
// LAST swing, so a mob that fought both you and another mob would flip between
// two labels arbitrarily. What a reader acts on is mine vs not-mine.
const SIDE_LABEL = { you: "you", pet: "your pet", charm: "your charm", othermob: "other", other: "other" };
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const fmt = n => Math.round(n).toLocaleString();
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "—";
const dt = d => d ? d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const tShort = d => d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
const dtShort = d => d ? `${d.toLocaleString(undefined, { month: "short", day: "numeric" })} · ${tShort(d)}` : "—";
const dayLabel = k => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, y === new Date().getFullYear()
    ? { weekday: "short", month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric", year: "numeric" });
};
const fmtCopper = cu => {
  if (!cu) return "—";
  cu = Math.round(cu);
  const p = Math.floor(cu / 1000), g = Math.floor(cu % 1000 / 100), s = Math.floor(cu % 100 / 10), c = cu % 10;
  if (p >= 100) return `${fmt(p)}p`;
  if (p) return `${fmt(p)}p ${g}g`;
  if (g) return `${g}g ${s}s`;
  return `${s}s ${c}c`;
};
let SHOW_ALL_MOBS = false, SHOW_ALL_LOOT = false;
const EXPANDED = new Set(); // mob rows the player has opened
const EXPANDED_SRC = new Set(); // grouped source rows (pet/charm) opened to their per-verb split
function bar(frac, color) { const w = Math.max(0, Math.min(100, frac * 100)); return `<span class="mtrack"><span class="mfill" style="width:${w}%;background:${color}"></span></span>`; }

let STATE = null;

// A band chip narrower than ~4 characters drops its label (color + hover only)
// — a 1-2 character fragment reads as a glitch, not truncation. Measured after
// every render and again on resize, since chip widths are percentages.
function fitLanes() {
  document.querySelectorAll(".lane-seg").forEach(el => {
    el.classList.toggle("lane-tight", !el.classList.contains("lane-sliver") && el.clientWidth < 34);
  });
}
let fitLanesT = null;
window.addEventListener("resize", () => { clearTimeout(fitLanesT); fitLanesT = setTimeout(fitLanes, 150); });

/* ─── DPS-over-time sparkline (6s buckets, SVG area) ───────────────────────*/
function dpsChart(P, events, side, stanceTl, invokeTl) {
  const team = new Set(["you", "pet", "charm"]);
  const dmg = events.filter(e => e.k === "dmg" && team.has(side(e)) && P.mobSet.has(e.tgt));
  if (dmg.length < 4) return `<p class="sub">Not enough of a fight in this slice to chart.</p>`;
  // Idle compression: plotted on wall-clock, a multi-day log is a flatline
  // with one spike at the end (2678m of axis for 45m of combat). Gaps over
  // 60s between team damage events collapse to 12s of axis; stance markers
  // ride the same piecewise mapping so they still land on their fights.
  const GAP_MAX = 60, GAP_SHOWN = 12;
  const sec = ts => ts.getTime() / 1000;
  const knotsR = [], knotsC = [];
  let comp = 0, prevT = null, gaps = 0;
  const pts = dmg.map(e => {
    const t = sec(e.ts);
    if (prevT != null) {
      const d = t - prevT;
      if (d > GAP_MAX) { gaps++; comp += GAP_SHOWN; } else comp += d;
    }
    prevT = t;
    knotsR.push(t); knotsC.push(comp);
    return { c: comp, amt: e.amt };
  });
  const span = Math.max(comp, 1);
  const compress = t => {
    if (t <= knotsR[0]) return 0;
    let lo = 0, hi = knotsR.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (knotsR[mid] <= t) lo = mid; else hi = mid - 1; }
    // between damage events time flows 1:1, capped at the next knot
    const c = knotsC[lo] + (t - knotsR[lo]);
    return Math.min(c, lo + 1 < knotsC.length ? knotsC[lo + 1] : span);
  };
  // widen buckets on long slices so a whole log stays readable (~300 bars max)
  const B = Math.max(6, Math.ceil(span / 300 / 6) * 6);
  const n = Math.max(1, Math.ceil(span / B)), buckets = new Array(n).fill(0);
  for (const p of pts) buckets[Math.min(n - 1, Math.floor(p.c / B))] += p.amt;
  const dps = buckets.map(v => v / B), peak = Math.max(...dps, 1);
  const W = 900, H = 120, pad = 4;
  const x = i => pad + (W - 2 * pad) * (i / Math.max(1, n - 1));
  const y = v => H - pad - (H - 2 * pad) * (v / peak);
  let path = `M ${x(0)} ${y(dps[0])}`; for (let i = 1; i < n; i++) path += ` L ${x(i)} ${y(dps[i])}`;
  const area = `${path} L ${x(n - 1)} ${H - pad} L ${x(0)} ${H - pad} Z`;
  // Stances and invocations render as BANDS above and below the chart —
  // every segment is a labeled span on the same idle-compressed axis, in
  // HTML so labels never collide, distort, or get dropped; a segment too
  // narrow to read still ellipsizes and answers on hover (EQLTip). Thin
  // ticks inside the chart mark the exact transition moments.
  const laneSegs = tl => {
    const segs = [];
    let cur = null, curC = 0, curR = dmg[0].ts;
    for (const [ts, name] of tl) {
      const t = sec(ts);
      if (t <= knotsR[0]) { cur = name; continue; }
      if (t > prevT) break;
      const c = compress(t);
      if (cur) segs.push({ name: cur, c0: curC, c1: c, r0: curR, r1: ts });
      cur = name; curC = c; curR = ts;
    }
    if (cur) segs.push({ name: cur, c0: curC, c1: span, r0: curR, r1: dmg[dmg.length - 1].ts });
    return segs;
  };
  if (TIPCTX) TIPCTX.lanes = { s: [], i: [] };
  const lane = (tl, cls, laneKey) => {
    const segs = laneSegs(tl || []);
    if (!segs.length) return "";
    if (TIPCTX) TIPCTX.lanes[laneKey] = segs;
    // a segment too narrow for text (a stance toggled for seconds) renders
    // as a 2px sliver — no padding, no label — but still answers on hover.
    // Labels live in .lane-txt so fitLanes() can suppress fragments: a chip
    // too narrow for ~4 characters shows color only, never "o." noise.
    return `<div class="lane ${cls}">` + segs.map((s, i) => {
      const w = 100 * (s.c1 - s.c0) / span;
      const sliver = w < 0.15;
      return `<span class="lane-seg${sliver ? " lane-sliver" : ""}" data-tip="lp:lane:${laneKey}${i}" style="left:${(100 * s.c0 / span).toFixed(3)}%;width:${w.toFixed(3)}%">${sliver ? "" : `<span class="lane-txt">${esc(s.name)}</span>`}</span>`;
    }).join("") + `</div>`;
  };
  const ticks = (tl, col) => {
    let out = "";
    for (const [ts] of tl || []) {
      const t = sec(ts);
      if (t < knotsR[0] || t > prevT) continue;
      const mx = x(compress(t) / B);
      out += `<line x1="${mx}" y1="${pad}" x2="${mx}" y2="${H - pad}" stroke="${col}" stroke-width="1" stroke-dasharray="2 3" opacity=".35"/>`;
    }
    return out;
  };
  const marks = ticks(stanceTl, "var(--gold)") + ticks(invokeTl, "var(--arcane)");
  return lane(stanceTl, "lane-stance", "s") +
    `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none" role="img" aria-label="damage per second over time">
    <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ember)" stop-opacity=".5"/><stop offset="1" stop-color="var(--ember)" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#dg)"/><path d="${path}" fill="none" stroke="var(--ember-hot,#ff8a3d)" stroke-width="1.6"/>${marks}
  </svg>` + lane(invokeTl, "lane-invoke", "i") +
    `<p class="sub">Peak ${fmt(peak)} DPS over a ${B}-second window · ${Math.round(span / 60)}m of combat${gaps ? " — idle time between fights cut out" : ""}</p>`;
}

/* ─── tooltips: the raw numbers behind every rounded value ─────────────────
   /_shared/tip.js provides the engine; this provider serves "lp:*" specs.
   Content is rebuilt from TIPCTX on every render, so a tip always shows the
   numbers of the slice on screen. */
let TIPCTX = null;
// Skill rows are named by the verb the log prints, and the log collapses
// families — these tips say so where it matters. Kick/strike collapses were
// observed in game (2026-07-11); the log never names the skill.
const VERB_TIP = {
  kick: "Kick and Round Kick both print “kick” in the log, so they share this row. The log never names the skill.",
  strike: "Strike-family skills print “strike” — Tiger Claw among them. The log never names the skill.",
  ranged: "Bow shots print “shoot” in the log.",
  auto: "Weapon swings, split by the verb the log prints — the verb is the weapon's damage type (slash, crush, pierce…). With a different weapon type in each hand, these rows are your two hands. The log never says which hand.",
  punch: "Bare-handed swings print “punch” — a punch-family skill like Dragon Punch would print the same verb, so they can't be split.",
};
function tipProvider(arg) {
  if (!TIPCTX) return null;
  const i = arg.indexOf(":");
  const key = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? null : arg.slice(i + 1);
  const idx = rest == null ? null : +rest;
  const a = TIPCTX.a;
  switch (key) {
    case "verb": return VERB_TIP[rest] ? `<h5>${rest === "ranged" ? "Ranged" : rest === "auto" ? "Auto-attack" : rest}</h5><p>${VERB_TIP[rest]}</p>` : null;
    case "lane": {
      const segs = TIPCTX.lanes && TIPCTX.lanes[rest[0]];
      const s = segs && segs[+rest.slice(1)];
      if (!s) return null;
      return `<h5>${esc(s.name)}</h5><p>${rest[0] === "s" ? "Stance" : "Invocation"} · ${dtShort(s.r0)} → ${dtShort(s.r1)}</p>`;
    }
    case "mend": return `<h5>Mend</h5><p>The log says you mended — “You mend your wounds and heal some damage.” — but never prints the amount, so mend is counted, not totaled.</p>`;
    case "damage": return `<h5>Damage</h5><p>Only hits that landed on mobs count. You <b>${fmt(a.tot.you)}</b> · pets <b>${fmt(a.tot.pet)}</b> · charm <b>${fmt(a.tot.charm)}</b>.</p>`;
    case "dps": return `<h5>Est. DPS</h5><p>${fmt(a.total)} damage ÷ ${fmt(a.combatSec)}s of combat = <b>${fmt(a.combatSec ? a.total / a.combatSec : 0)}</b>. Combat time strings your side's damage together and skips gaps over 30s. Log timestamps are whole seconds, so short windows round hard.</p>`;
    case "combat": return `<h5>Combat time</h5><p>${fmt(a.combatSec)}s fighting inside ${fmt(a.wallSecs)}s of log — ${pct(a.combatSec, a.wallSecs)} of the time.</p>`;
    case "kills": return `<h5>Kills</h5><p><b>${TIPCTX.kills}</b> credited to you, your pets, or your charm.${TIPCTX.killedSeen > TIPCTX.kills ? ` ${TIPCTX.killedSeen - TIPCTX.kills} more deaths happened in fights someone else finished.` : ""}</p>`;
    case "deaths": return `<h5>Deaths</h5>` + (a.deaths.length ? `<p>${a.deaths.map(x => `${dtShort(x.ts)} — ${x.by}`).join("<br>")}</p>` : `<p>None in this slice.</p>`);
    case "xp": return `<h5>XP gained</h5><p><b>${a.xp.toFixed(2)}%</b> over ${TIPCTX.xpLines} experience lines${TIPCTX.kills ? ` — ${(a.xp / TIPCTX.kills).toFixed(2)}% per credited kill` : ""}. The log prints percentages only; 100% is one level.</p>`;
    case "coin": return `<h5>Coin</h5><p>Corpse coin <b>${fmtCopper(TIPCTX.corpseCu)}</b> + auto-sold loot <b>${fmtCopper(TIPCTX.vendorCu)}</b>${a.vendorSaleCu ? ` + vendor sales <b>${fmtCopper(a.vendorSaleCu)}</b>` : ""}${a.miscCu ? ` + quest and salvage coin <b>${fmtCopper(a.miscCu)}</b>` : ""}. Per-mob averages only count coin the kill burst tied to a fight.</p>`;
    case "aa": return `<h5>AA points</h5><p>${a.aa} ability-point line${a.aa === 1 ? "" : "s"} in this slice${a.aaNow != null ? ` — the last one said you have <b>${a.aaNow}</b>` : ""}. The log doesn't say where you spent them.</p>`;
    case "pace": return `<h5>Per hour of play</h5><p>Everything ÷ <b>${TIPCTX.activeH.toFixed(2)}h</b> of active time — the event timeline with gaps over 30 minutes cut out, so camp breaks and logouts don't dilute the rate. The level estimate is 100% ÷ your XP rate — 100% is one level at your current level's cost.</p>`;
    case "swap": return `<h5>Loadout swap</h5><p>Swapping class loadouts changes your level and the log prints nothing. This log's considers stopped matching the known level here, so fights between the last agreeing con and the next level-up or /who line are filed under <b>Level unknown</b> instead of guessed. Typing <code>/who</code> after a swap re-anchors immediately.</p>`;
    case "pets": {
      const ns = TIPCTX.side.claims.names;
      if (!ns.length) return `<h5>Pets</h5><p>Nothing answered you with ", Master." in this log, and no charm of yours landed. A pet identifies itself the first time you order it — one <code>/pet attack</code> and it counts.</p>`;
      // tells === 0 can only be a charm grant: those are the two ways in
      return `<h5>Your pets</h5><p>Claimed by their own tells, which the client only ever shows you for your own pet — or, for a charm, by the broadcast landing as your own cast finished.</p><p>${ns.map(c => `<b>${c.name}</b> (${c.kind}) — ${c.tells ? `${c.tells} tell${c.tells === 1 ? "" : "s"}` : "your charm cast"}, ${dtShort(c.from)} → ${dtShort(c.to)}`).join("<br>")}</p>`;
    }
    case "droprate": return `<h5>Observed drop rate</h5><p>Loot lines ÷ kills seen. The log has no line for opening an empty corpse, so a corpse you never looted still counts as a kill — the rate here can only run low, never high.</p>`;
    case "enchp": return `<h5>HP this fight</h5><p>Bracketed by overkill: the mob took some total damage, and the killing blow either landed in full or was capped by whatever HP was left — so its HP sits between total−lastblow+1 and total. Heals it received subtract. A trailing <b>?</b> means another same-name mob was in the fray; the log can't tell two of a name apart, so that bracket is unreliable and stays out of the mob's HP.</p>`;
    case "srcrow": {
      const s = a.sources[idx];
      if (!s || !s.actors) return null;
      return `<h5>${s.name}</h5><p>${[...s.actors.entries()].sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${fmt(v)}`).join(" · ")}</p>`;
    }
    case "mobxp": case "mobcoin": case "mobkills": case "moblvl": case "mobhp": case "mobdps": {
      const g = TIPCTX.mobs && TIPCTX.mobs[idx];
      if (!g) return null;
      if (key === "mobhp") return `<h5>${g.mob} — HP</h5><p>Each kill brackets HP between the total damage the mob took (minus heals it received) and that total minus the last blow — the killing hit can overshoot. ${g.hp[2]} clean kill${g.hp[2] === 1 ? "" : "s"} narrow${g.hp[2] === 1 ? "s" : ""} it to <b>${fmt(g.hp[0])}–${fmt(g.hp[1])}</b>.${g.hp[3] ? " Marked <b>mixed</b>: the kills disagree — same-name mobs spawn in more than one variant, and this bracket fits the most kills." : ""} Kills with another same-name mob nearby are left out.</p>`;
      if (key === "mobdps") return `<h5>${g.mob} — their DPS</h5><p><b>${fmt(g.offSum)}</b> damage it dealt — melee, spells, DoTs, damage shield, at anyone — over <b>${fmt(g.offSecsSum)}s</b> on the attack. Biggest melee hit: <b>${fmt(g.maxHit)}</b>.</p>`;
      if (key === "mobxp") return `<h5>${g.mob} — XP</h5><p>${g.xp.toFixed(2)}% total over ${g.kills} kill${g.kills === 1 ? "" : "s"}; ${g.xpKills} printed an XP line. The average divides by all kills${g.rollKills ? `, minus ${g.rollKills} that crossed a level — those print only the leftover past the ding, so they'd drag the average down` : ""}.</p>`;
      if (key === "mobcoin") return `<h5>${g.mob} — coin</h5><p>${fmtCopper(g.coin)} total over ${g.kills} kill${g.kills === 1 ? "" : "s"}; ${g.coinKills} dropped coin.</p>`;
      if (key === "moblvl") return `<h5>${g.mob} — level</h5><p>From ${g.lvls.n} of your own /con line${g.lvls.n === 1 ? "" : "s"} — the only place the log states a level. Same-name spawns can span levels, so a range is real, not noise.</p>`;
      return `<h5>${g.mob}</h5><p>${g.kills} killed${g.fights > g.kills ? ` · ${g.fights - g.kills} fought with no death seen — it fled, reset, or someone else finished it` : ""}.</p>`;
    }
  }
  return null;
}

function render() {
  const { P, seg, side } = STATE;
  const selDay = currentDay(), selSess = currentSession(), selLevels = currentLevels(), selCombo = $("comboSel").value, selFight = $("fightSel").value;
  let events = P.events;
  const focus = selFight === "*" ? null : seg.fights.find(f => fkey(f) === selFight) || null;
  if (focus) {
    // a focused fight IS the slice — day/session/level/combo filters don't
    // stack on top, or focusing a fight outside the current slice shows an
    // empty page
    const t0 = focus.start - 2000, t1 = focus.end.getTime() + 2000;
    events = events.filter(e => e.ts >= t0 && e.ts <= t1 &&
      (e.src === focus.mob || e.tgt === focus.mob || (e.k !== "dmg" && e.k !== "miss")));
  } else {
    if (selDay) events = events.filter(e => e.day === selDay);
    if (selSess != null) events = events.filter(e => e.zv === selSess);
    if (selLevels) events = events.filter(e => selLevels.has(e.lvl));
    if (selCombo !== "*") events = events.filter(e => e.combo === selCombo);
  }
  const oc = P.who ? P.who.classes.split("/") : null;
  const a = analyze(P, events, side, oc);

  // kills come from fights (a kill is credited only if we actually fought the
  // mob, and only to you or an actor claimed at the time), sliced the same
  // way the mob table is
  let fightsInSlice = focus ? [focus] : seg.fights.filter(f => f.total > 0 || f.taken > 0);
  if (!focus && selDay) fightsInSlice = fightsInSlice.filter(f => dayKey(f.start) === selDay);
  if (!focus && selSess != null) fightsInSlice = fightsInSlice.filter(f => f.zv === selSess);
  if (!focus && selLevels) fightsInSlice = fightsInSlice.filter(f => selLevels.has(f.lvl));
  // the kills number must share its population with the combo-filtered events
  // or the pace line divides one slice's kills by another slice's hours
  if (!focus && selCombo !== "*") fightsInSlice = fightsInSlice.filter(f => f.combo === selCombo);
  const killedSeen = fightsInSlice.filter(f => f.killed);
  const kills = killedSeen.filter(f => f.killer === P.owner || side.claims.at(f.killer, f.end)).length;

  let corpseCu = 0, vendorCu = 0;
  for (const e of events) { if (e.k === "coin") corpseCu += inCopper(e); if (e.k === "loot" && e.sold) vendorCu += inCopper(e.sold); }
  TIPCTX = { a, side, kills, killedSeen: killedSeen.length, corpseCu, vendorCu,
             xpLines: events.filter(e => e.k === "xp").length, mobs: null };

  // plaques
  const pl = $("plaques"); pl.innerHTML = "";
  const dps = a.combatSec ? a.total / a.combatSec : 0;
  const plq = [["Damage", fmt(a.total), "damage", "hero"], ["Est. DPS", a.combatSec >= MIN_RATE_SEC ? fmt(dps) : "—", "dps"],
    ["Combat time", `${Math.round(a.combatSec / 60)}m`, "combat"], ["Kills", kills, "kills"], ["Deaths", a.deaths.length, "deaths"]];
  if (a.xp > 0) plq.push(["XP gained", a.xp >= 100 ? `${(a.xp / 100).toFixed(1)} lvls` : `${a.xp.toFixed(1)}%`, "xp"]);
  if (a.copper > 0) plq.push(["Coin gained", fmtCopper(a.copper), "coin"]);
  if (a.aa > 0) plq.push(["AA points", a.aa, "aa"]);
  plq.forEach(([l, n, key, cls]) => {
    const d = el("div", "plaque" + (cls ? " " + cls : ""), `<span class="pn">${n}</span><span class="pl">${l}</span>`);
    d.dataset.tip = "lp:" + key;
    pl.append(d);
  });

  // pace: per-hour rates over active time (gaps over 30m cut out). One line,
  // only when the slice is long enough for a rate to mean anything.
  const paceEl = $("paceLine");
  const activeH = a.activeSecs / 3600;
  TIPCTX.activeH = activeH;
  if (!focus && activeH >= 1 / 6 && (a.xp > 0 || kills > 0 || a.copper > 0)) {
    const parts = [];
    if (kills) parts.push(`${(kills / activeH).toFixed(kills / activeH < 10 ? 1 : 0)} kills`);
    if (a.xp > 0) parts.push(`${(a.xp / activeH).toFixed(1)}% XP`);
    if (a.copper > 0) parts.push(fmtCopper(a.copper / activeH));
    if (a.aa > 0) parts.push(`${(a.aa / activeH).toFixed(1)} AA`);
    const lvlH = a.xp > 0 ? 100 / (a.xp / activeH) : null;
    paceEl.hidden = false;
    paceEl.innerHTML = `<span class="tipv" data-tip="lp:pace">Per hour of play</span>: ${parts.join(" · ")}` +
      (lvlH && lvlH < 200 ? ` — a level every ~${lvlH < 10 ? lvlH.toFixed(1) : Math.round(lvlH)}h at this rate` : "");
  } else paceEl.hidden = true;

  // biggest-hit tiles
  const bh = $("bigHits"); bh.innerHTML = "";
  const tiles = [["biggest nuke", a.big.spell], ["biggest swing", a.big.melee], ["biggest DoT tick", a.big.dot]];
  if (a.big.ranged) tiles.push(["biggest shot", a.big.ranged]);
  if (a.big.heal) tiles.push(["biggest heal", a.big.heal]);
  for (const [lab, b] of tiles) if (b) bh.append(el("div", "bigtile", `<span class="bt-n">${fmt(b.amt)}</span><span class="bt-src">${b.name}${b.crit ? " <em>crit</em>" : ""}</span><span class="bt-lab">${lab}</span>`));

  // dps over time
  $("dpsChart").innerHTML = dpsChart(P, events, side, seg.stanceTl, seg.invokeTl);
  fitLanes();

  // damage by source
  const t = $("sourceTable");
  t.innerHTML = `<thead><tr><th></th><th>Source</th><th></th><th>Element</th><th>Hits</th><th>Total</th><th>%</th><th>Avg</th><th>Max</th><th>Crit</th></tr></thead>`;
  const tb = el("tbody");
  const TAGS = { you: `<span class="tag-you">you</span>`, pet: `<span class="tag-pet">pet</span>`, charm: `<span class="tag-charm">charm</span>` };
  a.sources.forEach((s, i) => {
    const vtip = s.side !== "you" ? null
      : s.name === "auto-attack (punch)" ? "punch"
      : s.name.startsWith("auto-attack (") ? "auto"
      : VERB_TIP[s.name] ? s.name : null;
    const nameCell = s.actors ? `<span class="tipv" data-tip="lp:srcrow:${i}">${s.name}</span>`
      : vtip ? `<span class="tipv" data-tip="lp:verb:${vtip}">${s.name}</span>` : s.name;
    // grouped pet/charm rows expand to their per-verb (and per-spell) split —
    // grouping is presentation, never lost detail
    const expandable = s.sub && s.sub.size >= 2;
    const srcKey = `${s.side}|${s.name}`;
    const isOpen = expandable && EXPANDED_SRC.has(srcKey);
    const critCell = s.cat === "melee" || s.cat === "ranged" || s.cat === "spell" || s.cat === "proc" ? pct(s.crit, s.hits) : "—";
    const tr = el("tr", expandable ? "src-row" + (isOpen ? " open" : "") : null,
      `<td class="c-gem">${gemFor(s)}</td><td class="c-name">${expandable ? `<span class="m-caret" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>` : ""}${nameCell}</td><td>${TAGS[s.side] || ""}</td><td class="c-el">${s.elem}</td><td>${fmt(s.hits)}</td><td class="c-dmg">${fmt(s.dmg)}</td><td>${pct(s.dmg, a.total)}</td><td>${fmt(s.dmg / s.hits)}</td><td>${fmt(s.max)}</td><td>${critCell}</td>`);
    if (expandable) tr.addEventListener("click", ev => {
      if (ev.target.closest("[data-tip]")) return; // the tip owns that click
      if (EXPANDED_SRC.has(srcKey)) EXPANDED_SRC.delete(srcKey); else EXPANDED_SRC.add(srcKey);
      render();
    });
    tb.append(tr);
    if (isOpen) for (const sub of [...s.sub.values()].sort((x, y) => y.dmg - x.dmg)) {
      tb.append(el("tr", "src-sub", `<td class="c-gem"></td><td class="c-name">${esc(sub.name)}</td><td></td><td class="c-el"></td><td>${fmt(sub.hits)}</td><td class="c-dmg">${fmt(sub.dmg)}</td><td>${pct(sub.dmg, a.total)}</td><td>${fmt(sub.dmg / sub.hits)}</td><td>${fmt(sub.max)}</td><td>${pct(sub.crit, sub.hits)}</td>`));
    }
  });
  t.append(tb);
  if (!a.sources.length) t.append(el("tbody", null, `<tr><td colspan="10" class="empty">No damage from your side in this slice.</td></tr>`));

  // swing intervals — how often each actor swings, per verb. The range is the
  // point: two fights whose ranges overlap have not measurably changed, which
  // is what a weapon swap actually has to beat to be worth anything.
  const sp = $("swingPanel");
  if (a.swings.length) {
    sp.hidden = false;
    const st = $("swingTable");
    st.innerHTML = `<thead><tr><th>Swinging</th><th>Side</th><th>Attack</th><th>Swings</th><th>Engaged</th><th>Every</th><th>95% range</th></tr></thead>`;
    const stb = el("tbody");
    for (const r of a.swings) {
      stb.append(el("tr", null,
        `<td class="c-name">${mobCell(r.actor)}</td><td class="c-side">${esc(SIDE_LABEL[r.side] || r.side)}</td>` +
        `<td class="c-name">${esc(r.verb)}</td><td>${fmt(r.swings)}</td><td data-sort="${r.engaged}">${fmt(r.engaged)}s</td>` +
        `<td class="c-dmg" data-sort="${r.interval}">${r.interval.toFixed(2)}s</td>` +
        `<td data-sort="${r.lo}">${r.lo.toFixed(2)}–${r.hi == null ? "?" : r.hi.toFixed(2)}s</td>`));
    }
    st.append(stb);
    if (window.EQLSortable) window.EQLSortable.bindAll();
  } else sp.hidden = true;

  // what hit you — incoming damage per (mob, ability), full resists joined
  const tp = $("takenPanel");
  if (a.takenBy.length) {
    tp.hidden = false;
    const tt = $("takenTable");
    tt.innerHTML = `<thead><tr><th></th><th>Mob</th><th>Ability</th><th>Element</th><th>Hits</th><th>Total</th><th>%</th><th>Avg</th><th>Max</th><th>Resisted</th></tr></thead>`;
    const ttb = el("tbody");
    for (const r of a.takenBy) {
      const ability = r.cat === "melee" || r.cat === "ranged" ? esc(r.name)
        : r.cat === "dot" ? `${esc(r.name)} <span class="h2sub">DoT</span>` : esc(r.name);
      ttb.append(el("tr", null,
        `<td class="c-gem">${gemFor(r)}</td><td class="c-name">${mobCell(r.src)}</td><td class="c-name">${ability}</td>` +
        `<td class="c-el">${esc(r.elem)}</td><td>${fmt(r.hits)}</td><td class="c-dmg">${fmt(r.dmg)}</td>` +
        `<td>${pct(r.dmg, a.taken.dmg)}</td><td>${r.hits ? fmt(r.dmg / r.hits) : "—"}</td>` +
        `<td>${r.hits ? fmt(r.max) : "—"}</td><td>${r.res ? fmt(r.res) : "—"}</td>`));
    }
    tt.append(ttb);
  } else tp.hidden = true;

  // composition + by-class
  const comp = $("composition"); comp.innerHTML = "";
  for (const [k, lab, col] of [["melee", "auto-attack", "var(--c-melee)"], ["skill", "combat skills", "var(--c-skill)"], ["ranged", "ranged", "var(--c-ranged)"], ["cast", "cast spells", "var(--c-cast)"], ["proc", "procs / passives", "var(--c-proc)"], ["dot", "damage over time", "var(--c-dot)"], ["ds", "damage shield", "var(--c-ds)"], ["pet", "pets", "var(--c-pet)"], ["charm", "charmed mobs", "var(--c-charm)"]]) {
    const v = a.buckets[k] || 0; if (!v) continue;
    comp.append(el("div", "meter", `<span class="mlab">${lab}</span>${bar(v / (a.total || 1), col)}<span class="mval">${pct(v, a.total)} · ${fmt(v)}</span>`));
  }
  comp.append(el("p", "sub", "Elements: " + (a.elem.map(([e, v]) => `${e} ${pct(v, a.total)}`).join(" · ") || "—")));
  const bc = $("byClass"); bc.innerHTML = "";
  if (oc && a.byClass.length > 1) {
    bc.append(el("h3", "mini-h", "By class"));
    for (const [c, v] of a.byClass) bc.append(el("div", "meter small", `<span class="mlab">${c}</span>${bar(v / (a.total || 1), c === "pet" || c === "charm" ? "var(--arcane)" : "var(--gold)")}<span class="mval">${pct(v, a.total)}</span>`));
  }

  // casting & melee
  const r = $("rates"); r.innerHTML = "";
  const row = (k, v, warn) => r.append(el("div", "statrow", `<span class="k">${k}</span><span class="v${warn ? " warn" : ""}">${v}</span>`));
  const hr = a.melee.landed + a.melee.missed;
  row("melee swings", `${fmt(a.melee.landed)} landed / ${fmt(a.melee.missed)} missed`);
  row("hit rate", pct(a.melee.landed, hr), hr > 100 && a.melee.landed / hr < .7);
  row("avg / biggest hit", `${fmt(a.melee.avg)} / ${fmt(a.melee.max)}`);
  if (a.melee.riposte) row("riposte hits", fmt(a.melee.riposte));
  if (a.weapons.length >= 2) for (const w of a.weapons) {
    row(`<span class="tipv" data-tip="lp:verb:auto">auto-attack (${w.verb})</span>`, `${fmt(w.landed)} landed / ${fmt(w.missed)} missed · avg ${w.landed ? fmt(w.dmg / w.landed) : "—"}`);
  }
  for (const sk of a.skills) {
    const tip = VERB_TIP[sk.verb] ? ` class="tipv" data-tip="lp:verb:${sk.verb}"` : "";
    row(`<span${tip}>${sk.verb}</span>`, `${fmt(sk.landed)} landed / ${fmt(sk.missed)} missed · avg ${sk.landed ? fmt(sk.dmg / sk.landed) : "—"}`);
  }
  if (a.ranged.landed || a.ranged.missed) {
    row(`<span class="tipv" data-tip="lp:verb:ranged">ranged shots</span>`, `${fmt(a.ranged.landed)} landed / ${fmt(a.ranged.missed)} missed` + (a.ranged.landed ? ` · avg ${fmt(a.ranged.dmg / a.ranged.landed)}` : ""));
  }
  if (a.mend.ok || a.mend.fail) row(`<span class="tipv" data-tip="lp:mend">mend</span>`, `${a.mend.ok} mended` + (a.mend.fail ? ` / ${a.mend.fail} failed` : ""));
  row("casts", fmt(a.casts));
  row("interrupted", `${fmt(a.interrupts)} (${pct(a.interrupts, a.casts)})`, a.casts && a.interrupts / a.casts >= .05);
  row("resisted", `${fmt(a.resists)} (${pct(a.resists, a.casts)})`, a.casts && a.resists / a.casts >= .04);
  if (a.fizzles) row("fizzled", `${fmt(a.fizzles)} (${pct(a.fizzles, a.casts)})`, a.casts && a.fizzles / a.casts >= .1);
  if (a.petResists) row("pet spells resisted", fmt(a.petResists));
  if (a.resistIn) row("spells you resisted", fmt(a.resistIn));
  if (a.taken.landed || a.taken.avoid.length) { const av = a.taken.avoid.reduce((x, [, n]) => x + n, 0);
    row("damage taken", `${fmt(a.taken.dmg)} over ${fmt(a.taken.landed)} hits`);
    row("avoided", av ? `${fmt(av)} (${a.taken.avoid.map(([k, n]) => `${k} ${n}`).join(", ")})` : "—"); }
  if (a.summons) row("times summoned", fmt(a.summons));
  if (a.petTaken) row("your pets took", fmt(a.petTaken));

  // healing — what you cast, and what landed on you (same lines, both ends)
  const hp = $("healPanel");
  if (a.healTot > 0 || a.healInTot > 0) {
    hp.hidden = false;
    const ht = $("healTable"), hb = $("healOutBlock");
    hb.hidden = !(a.healTot > 0);
    if (a.healTot > 0) {
      ht.innerHTML = `<thead><tr><th>Heal</th><th>Casts</th><th>Healed</th><th>Overheal</th><th>Crit</th></tr></thead>`;
      const htb = el("tbody");
      for (const h of a.heals) htb.append(el("tr", null, `<td class="c-name">${h.spell}</td><td>${fmt(h.hits)}</td><td class="c-dmg">${fmt(h.real)}</td><td>${pct(h.over, h.real + h.over)}</td><td>${pct(h.crit, h.hits)}</td>`));
      htb.append(el("tr", "tot", `<td class="c-name">total</td><td></td><td class="c-dmg">${fmt(a.healTot)}</td><td>${pct(a.overTot, a.healTot + a.overTot)} wasted</td><td></td>`));
      ht.append(htb);
    }
    const hrb = $("healInBlock");
    hrb.hidden = !(a.healInTot > 0);
    if (a.healInTot > 0) {
      const hrt = $("healRecvTable");
      hrt.innerHTML = `<thead><tr><th>Healer</th><th>Casts</th><th>Amount</th></tr></thead>`;
      const hrtb = el("tbody");
      for (const h of a.healsIn) hrtb.append(el("tr", null, `<td class="c-name">${esc(h.by)}</td><td>${fmt(h.hits)}</td><td class="c-dmg">${fmt(h.amt)}</td>`));
      hrtb.append(el("tr", "tot", `<td class="c-name">total</td><td></td><td class="c-dmg">${fmt(a.healInTot)}</td>`));
      hrt.append(hrtb);
    }
  } else hp.hidden = true;

  // stance/invocation A/B — per-combo stats over the day+session+level slice
  // (ignore combo filter)
  let comboEvents = P.events;
  if (selDay) comboEvents = comboEvents.filter(e => e.day === selDay);
  if (selSess != null) comboEvents = comboEvents.filter(e => e.zv === selSess);
  if (selLevels) comboEvents = comboEvents.filter(e => selLevels.has(e.lvl));
  const comboNames = [...new Set(comboEvents.filter(e => e.k === "dmg" && side(e) === "you").map(e => e.combo))];
  const ctab = $("comboTable");
  ctab.innerHTML = `<thead><tr><th>Stance · invocation</th><th>Time</th><th>Damage</th><th>Est. DPS</th><th>Melee avg</th><th>Hit%</th><th>Crit%</th></tr></thead>`;
  const ctb = el("tbody"); const totalComboSec = comboNames.reduce((s, c) => s + combatSecondsOf(comboEvents.filter(e => e.combo === c), side), 0) || 1;
  const comboRows = comboNames.map(c => { const ce = comboEvents.filter(e => e.combo === c); const ca = analyze(P, ce, side, oc); const sec = combatSecondsOf(ce, side); return { c, ca, sec }; }).sort((x, y) => y.ca.total - x.ca.total);
  for (const { c, ca, sec } of comboRows) {
    const hrr = ca.melee.landed + ca.melee.missed;
    ctb.append(el("tr", null, `<td class="c-name">${c}</td><td>${bar(sec / totalComboSec, "var(--line-hot,#5c4630)")}<span class="inlpct">${pct(sec, totalComboSec)}</span></td><td class="c-dmg">${fmt(ca.total)}</td><td>${rateDps(ca.total, sec)}</td><td>${ca.melee.landed ? fmt(ca.melee.avg) : "—"}</td><td>${pct(ca.melee.landed, hrr)}</td><td>${pct(ca.sources.reduce((x, s) => x + s.crit, 0), ca.sources.reduce((x, s) => x + s.hits, 0))}</td>`));
  }
  ctab.append(ctb);
  if (comboRows.length <= 1) ctab.append(el("tbody", null, `<tr><td colspan="7" class="empty">Only one stance/invocation combo in this slice — switch them in game and the comparison fills in.</td></tr>`));

  renderMobs(selDay, selSess, selLevels, selFight);
  renderProgress(a);
  renderLoot(a);

  // death recap
  const dp = $("deathPanel"), dd = $("deaths");
  if (a.deaths.length) {
    dp.hidden = false; dd.innerHTML = "";
    for (const d of a.deaths) {
      const w0 = new Date(d.ts - 15000);
      const window = P.events.filter(e => e.k === "dmg" && e.tgt === P.owner && e.ts >= w0 && e.ts <= d.ts);
      const bySrc = new Map(); let totIn = 0;
      for (const e of window) { const key = (e.src || "unknown") + (e.spell ? ` (${e.spell})` : ""); bySrc.set(key, (bySrc.get(key) || 0) + e.amt); totIn += e.amt; }
      const lines = [...bySrc.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ");
      dd.append(el("div", "death", `<span class="d-when">${dt(d.ts)}</span> slain by <b>${mobCell(d.by)}</b> — last 15s: took ${fmt(totIn)}${lines ? ` (${lines})` : " (nothing logged incoming — likely a big hit or environmental)"}`));
    }
  } else dp.hidden = true;

  // unparsed honesty
  const uEl = $("unparsed"), up = P.unparsedCombat;
  const parsedCombat = P.events.filter(e => e.k === "dmg" || e.k === "miss" || e.k === "heal" || e.k === "kill").length;
  const upPct = (parsedCombat + up) ? up / (parsedCombat + up) : 0;
  if (!up) { uEl.textContent = ""; uEl.classList.remove("warn-banner"); }
  else {
    uEl.textContent = `${fmt(up)} combat lines (~${(upPct * 100).toFixed(1)}%) weren't recognized` +
      (upPct >= 0.1 ? " — a large share, so totals are likely missing real damage (probably a new EQL line the parser hasn't learned)." : upPct >= 0.03 ? " — enough to pull totals down a little." : ", so totals may run a hair low.");
    uEl.classList.toggle("warn-banner", upPct >= 0.03);
  }

  if (window.EQLTip) EQLTip.decorate();
}

/* ─── wiki item links ──────────────────────────────────────────────────────
   Lazy: the ~10.7k-title index only fetches the first time a drops or loot
   table is actually about to render, and only once (the promise is memoized).
   If it lands after that first paint, its own .then re-runs the normal
   render() — same pipeline every control change already uses — so linked
   items just appear on the next redraw rather than needing new machinery. */
let wikiItemsPromise = null, WIKI_ITEMS = null;
function loadWikiItems() {
  if (wikiItemsPromise) return wikiItemsPromise;
  wikiItemsPromise = fetch("/log-parser/data/wiki-items.json")
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      WIKI_ITEMS = d && d.titles ? { base: d.base, set: new Set(d.titles) } : null;
      if (STATE) render();
    })
    .catch(() => { WIKI_ITEMS = null; });
  return wikiItemsPromise;
}
function itemCell(name) {
  if (WIKI_ITEMS && WIKI_ITEMS.set.has(name))
    return `<a class="loot-wiki" href="${WIKI_ITEMS.base + encodeURIComponent(name.replace(/ /g, "_"))}" target="_blank" rel="noopener">${esc(name)}</a>`;
  return esc(name);
}
// Mob pages match case-insensitively: the log lowercases leading articles
// ("a Pickclaw Arroweater") while the wiki capitalizes them, so the index maps
// lowercased title -> the page's own casing.
let wikiMobsPromise = null, WIKI_MOBS = null;
function loadWikiMobs() {
  if (wikiMobsPromise) return wikiMobsPromise;
  wikiMobsPromise = fetch("/log-parser/data/wiki-mobs.json")
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      WIKI_MOBS = d && d.titles ? { base: d.base, map: new Map(d.titles.map(t => [t.toLowerCase(), t])) } : null;
      if (STATE) render();
    })
    .catch(() => { WIKI_MOBS = null; });
  return wikiMobsPromise;
}
function mobCell(name) {
  const t = WIKI_MOBS && WIKI_MOBS.map.get(String(name).toLowerCase());
  if (t) return `<a class="loot-wiki" href="${WIKI_MOBS.base + encodeURIComponent(t.replace(/ /g, "_"))}" target="_blank" rel="noopener">${esc(name)}</a>`;
  return esc(name);
}

/* ─── mobs & fights: one table, per-mob rows that open into encounters ─────*/
function renderMobs(selDay, selSess, selLevels, selFight) {
  const { P, seg } = STATE;
  let fights = seg.fights.filter(f => f.total > 0 || f.taken > 0);
  if (selDay) fights = fights.filter(f => dayKey(f.start) === selDay);
  if (selSess != null) fights = fights.filter(f => f.zv === selSess);
  if (selLevels) fights = fights.filter(f => selLevels.has(f.lvl));
  let lootEv = P.events.filter(e => e.k === "loot");
  if (selDay) lootEv = lootEv.filter(e => e.day === selDay);
  if (selSess != null) lootEv = lootEv.filter(e => e.zv === selSess);
  if (selLevels) lootEv = lootEv.filter(e => selLevels.has(e.lvl));
  let conEv = P.events.filter(e => e.k === "con");
  if (selDay) conEv = conEv.filter(e => e.day === selDay);
  if (selSess != null) conEv = conEv.filter(e => e.zv === selSess);
  if (selLevels) conEv = conEv.filter(e => selLevels.has(e.lvl));
  const rows = buildMobStats(fights, lootEv, conEv);
  if (rows.length) loadWikiMobs();
  const focusFight = selFight === "*" ? null : seg.fights.find(f => fkey(f) === selFight) || null;
  if (focusFight) EXPANDED.add(focusFight.mob);
  const shown = SHOW_ALL_MOBS ? rows : rows.slice(0, 20);
  TIPCTX.mobs = shown;
  // the level column exists only when the player actually conned something —
  // levels come from their own /con lines, nowhere else
  const hasLvls = rows.some(g => g.lvls);
  const nCols = 9 + (hasLvls ? 1 : 0);
  const tierTxt = g => { if (!g.tiers || !g.tiers.size || (g.tiers.size === 1 && g.tiers.has(0))) return "";
    const ts = [...g.tiers].sort((x, y) => x - y); return ` · D${ts[0]}${ts.length > 1 ? `–D${ts[ts.length - 1]}` : ""}`; };
  const mt = $("mobTable");
  mt.innerHTML = `<thead><tr><th>Mob</th>${hasLvls ? "<th>Level</th>" : ""}<th>Kills</th><th>Avg fight</th><th>Avg XP</th><th>Avg coin</th><th>Damage</th><th>HP</th><th>Their DPS</th><th>Drops</th></tr></thead>`;
  const tb = el("tbody");
  shown.forEach((g, i) => {
    const isOpen = EXPANDED.has(g.mob);
    const items = g.drops.size;
    const lvlCell = !hasLvls ? "" :
      `<td>${g.lvls ? `<span class="tipv" data-tip="lp:moblvl:${i}">${g.lvls.lo === g.lvls.hi ? g.lvls.lo : `${g.lvls.lo}–${g.lvls.hi}`}</span>` : "—"}</td>`;
    const tr = el("tr", "mob-row" + (isOpen ? " open" : ""),
      `<td class="c-name"><span class="m-caret" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>${mobCell(g.mob)}${g.rare ? ` <span class="m-rare">rare</span>` : ""}${g.zone ? ` <span class="m-zone">${g.zone}${tierTxt(g)}</span>` : ""}</td>` +
      lvlCell +
      `<td><span class="tipv" data-tip="lp:mobkills:${i}">${g.kills}${g.fights > g.kills ? ` <span class="f-open">+${g.fights - g.kills}</span>` : ""}</span></td>` +
      `<td>${g.fights ? Math.round(g.secs / g.fights) + "s" : "—"}</td>` +
      `<td>${g.xpKills && g.xp ? `<span class="tipv" data-tip="lp:mobxp:${i}">${(g.xp / Math.max(1, g.kills - g.rollKills)).toFixed(2)}%</span>` : "—"}</td>` +
      `<td>${g.kills && g.coin ? `<span class="tipv" data-tip="lp:mobcoin:${i}">${fmtCopper(g.coin / g.kills)}</span>` : "—"}</td>` +
      `<td class="c-dmg">${fmt(g.dmg)}</td>` +
      `<td>${g.hp ? `<span class="tipv" data-tip="lp:mobhp:${i}">${g.hp[0] === g.hp[1] ? fmt(g.hp[0]) : `${fmt(g.hp[0])}–${fmt(g.hp[1])}`}${g.hp[3] ? ` <span class="f-open">mixed</span>` : ""}</span>` : "—"}</td>` +
      `<td>${g.offSum ? `<span class="tipv" data-tip="lp:mobdps:${i}">${(g.offSum / Math.max(1, g.offSecsSum)).toFixed(1)}</span>` : "—"}</td>` +
      `<td>${items ? `${items} item${items === 1 ? "" : "s"}` : "—"}</td>`);
    tr.addEventListener("click", ev => {
      if (ev.target.closest("[data-tip], a")) return; // tips and wiki links own their clicks
      if (EXPANDED.has(g.mob)) EXPANDED.delete(g.mob); else EXPANDED.add(g.mob);
      render();
    });
    tb.append(tr);
    if (!isOpen) return;
    const drops = [...g.drops.values()].sort((x, y) => y.times - x.times);
    if (drops.length) loadWikiItems();
    const dropRows = drops.map(d =>
      `<tr><td class="c-name">${itemCell(d.item)}</td><td>${d.times} of ${g.kills || "?"}</td><td>${g.kills ? (100 * d.times / g.kills).toFixed(1) + "%" : "—"}</td><td>${d.qty > d.times ? (d.qty / d.times).toFixed(1) : "1"}</td></tr>`).join("");
    const encs = g.enc.slice().sort((x, y) => y.start - x.start);
    const encShown = encs.slice(0, 15);
    const encRows = encShown.map(f => {
      const dur = Math.max((f.end - f.start) / 1000, 1);
      return `<tr class="enc-row${selFight === fkey(f) ? " on" : ""}">` +
        `<td class="c-name">${dtShort(f.start)}${f.killed ? "" : ` <span class="f-open">unfinished</span>`}</td>` +
        `<td>${Math.round(dur)}s</td><td class="c-dmg">${fmt(f.total)}</td><td>${rateDps(f.total, dur)}</td>` +
        `<td>${f.taken ? fmt(f.taken) : "—"}</td>` +
        `<td>${f.killed && f.hpMin != null ? `<span class="tipv" data-tip="lp:enchp">${fmt(f.hpMin)}–${fmt(f.hpMax)}${f.tainted ? "?" : ""}</span>` : "—"}</td>` +
        `<td>${f.xp ? f.xp.toFixed(2) + "%" : "—"}</td><td>${f.coin ? fmtCopper(f.coin) : "—"}</td>` +
        `<td class="c-foc">${selFight === fkey(f) ? "focused" : "focus"}</td></tr>`;
    }).join("");
    const detail = el("tr", "mob-detail", `<td colspan="${nCols}"><div class="detail-grid">` +
      (drops.length ? `<div class="d-block"><h4>Drops</h4><table class="mini-tbl"><thead><tr><th>Item</th><th>Dropped</th><th><span class="tipv" data-tip="lp:droprate">Rate</span></th><th>Per drop</th></tr></thead><tbody>${dropRows}</tbody></table></div>` : "") +
      `<div class="d-block"><h4>Fights${encs.length > encShown.length ? ` <span class="f-open">newest ${encShown.length} of ${encs.length}</span>` : ""}</h4><div class="tblwrap"><table class="mini-tbl enc-tbl"><thead><tr><th>When</th><th>Length</th><th>Damage</th><th>Est. DPS</th><th>Took</th><th>HP</th><th>XP</th><th>Coin</th><th></th></tr></thead><tbody>${encRows}</tbody></table></div></div>` +
      `</div></td>`);
    detail.querySelectorAll(".enc-row").forEach((rr, ri) => rr.addEventListener("click", ev2 => {
      ev2.stopPropagation();
      const fid = fkey(encShown[ri]);
      $("fightSel").value = selFight === fid ? "*" : fid;
      render();
    }));
    tb.append(detail);
  });
  mt.append(tb);
  if (!rows.length) mt.append(el("tbody", null, `<tr><td colspan="${nCols}" class="empty">No fights in this slice.</td></tr>`));
  const more = $("mobMore");
  if (rows.length > 20) { more.hidden = false; more.textContent = SHOW_ALL_MOBS ? "Show top 20" : `Show all ${rows.length} mobs`; }
  else more.hidden = true;
  $("mobPanel").hidden = !rows.length;
}

function renderLoot(a) {
  const lp = $("lootPanel");
  if (!a.loot.length && !a.copper) { lp.hidden = true; return; }
  lp.hidden = false;
  if (a.loot.length) loadWikiItems();
  const lt = $("lootTable");
  lt.innerHTML = `<thead><tr><th>Item</th><th>Count</th><th>Where it went</th><th>Vendor coin</th></tr></thead>`;
  const tb = el("tbody");
  const rows = SHOW_ALL_LOOT ? a.loot : a.loot.slice(0, 12);
  for (const l of rows) {
    const dest = [l.kept ? `kept ${l.kept}` : "", l.depot ? `depot ${l.depot}` : "", l.sold ? "auto-sold" : ""].filter(Boolean).join(" · ") || "—";
    tb.append(el("tr", null, `<td class="c-name">${itemCell(l.item)}</td><td>${fmt(l.qty)}</td><td class="c-el">${dest}</td><td class="c-dmg">${l.sold ? fmtCopper(l.sold) : "—"}</td>`));
  }
  lt.append(tb);
  const more = $("lootMore");
  if (a.loot.length > 12) { more.hidden = false; more.textContent = SHOW_ALL_LOOT ? "Show top 12" : `Show all ${a.loot.length} items`; }
  else more.hidden = true;
}

/* ─── skill-ups & faction: the log's other progression lines ──────────────*/
function renderProgress(a) {
  const panel = $("progressPanel");
  const hasSkills = a.skillups.length > 0, hasFaction = a.faction.length > 0;
  const hasMerges = a.merges.length > 0 || a.mergeFails > 0;
  if (!hasSkills && !hasFaction && !hasMerges) { panel.hidden = true; return; }
  panel.hidden = false;
  const mb = $("mergeBlock");
  mb.hidden = !hasMerges;
  if (hasMerges) {
    const mt = $("mergeTable");
    mt.innerHTML = `<thead><tr><th>Item created</th><th>Merges</th></tr></thead>`;
    const mtb = el("tbody");
    for (const [item, n] of a.merges) mtb.append(el("tr", null, `<td class="c-name">${esc(item)}</td><td>${n}</td>`));
    if (a.mergeFails) mtb.append(el("tr", null, `<td class="c-name dim">failed attempts</td><td>${a.mergeFails}</td>`));
    mt.append(mtb);
  }
  const sb = $("skillBlock");
  sb.hidden = !hasSkills;
  if (hasSkills) {
    const st = $("skillTable");
    st.innerHTML = `<thead><tr><th>Skill</th><th>Ups</th><th>Now at</th></tr></thead>`;
    const stb = el("tbody");
    for (const s of a.skillups) stb.append(el("tr", null, `<td class="c-name">${esc(s.skill)}</td><td>${s.ups}</td><td>${s.val}</td>`));
    st.append(stb);
  }
  const fb = $("factionBlock");
  fb.hidden = !hasFaction;
  if (hasFaction) {
    const ft = $("factionTable");
    ft.innerHTML = `<thead><tr><th>Faction</th><th>Changes</th><th>Net</th></tr></thead>`;
    const ftb = el("tbody");
    for (const f of a.faction) {
      const net = f.net > 0 ? `+${f.net}` : f.net < 0 ? `${f.net}` : f.capped ? "" : "0";
      // "capped" = the could-not-possibly-get-any-better/worse line: standing
      // moved to (or sat at) its floor or ceiling, amount unknown
      ftb.append(el("tr", null, `<td class="c-name">${esc(f.fac)}</td><td>${f.hits}</td><td class="c-dmg">${net}${f.capped ? `${net ? " · " : ""}at the cap ×${f.capped}` : ""}</td>`));
    }
    ft.append(ftb);
  }
}

function currentLevels() {
  const v = $("levelSel").value;
  if (v === "*") return null;
  // "?" = the unknown-level bucket: events between a detected loadout swap
  // and the next ding or /who. A null level is NOT a wildcard — it only
  // shows under "All levels" and here.
  if (v === "?") return { has: l => l == null };
  const lv = +v;
  return { has: l => l === lv };
}
/* Day + zone-session slice. A zone session runs from one "You have entered"
   line to the next — the boundary that matters, because a loadout swap (which
   silently changes the level) can only happen in cities and lowbie zones, i.e.
   between the sessions worth parsing, never inside one. Session options carry
   the session's entry-second key, not its index — indices renumber when the
   40 MB live-watch window slides; a stale key resolves to -1 and matches
   nothing. */
function currentDay() { const v = $("daySel").value; return v === "*" ? null : v; }
function currentSession() {
  const v = $("sessSel").value;
  if (v === "*") return null;
  const vv = STATE.seg.visits.find(x => String(x.ts.getTime()) === v);
  return vv ? vv.id : -1;
}
// session and level options cascade from the day: the session list shows only
// that day's zone entries, the level list only levels that exist in the slice —
// so two loadouts' level ranges stop appearing where they didn't happen
function syncSliceControls(keep) {
  const { P, seg } = STATE;
  const selDay = $("daySel").value;
  const ss = $("sessSel"), prevS = keep ? ss.value : "*";
  const vlist = seg.visits.filter(v => selDay === "*" || v.days.has(selDay));
  ss.innerHTML = ""; ss.append(new Option("All zone sessions", "*"));
  for (const v of [...vlist].reverse())
    ss.append(new Option(`${v.name} · D${v.tier}${v.raid ? ` · ${v.raid} raid` : ""} · ${selDay === "*" ? dtShort(v.ts) : tShort(v.ts)}`, String(v.ts.getTime())));
  $("sessCtl").hidden = vlist.length === 0;
  if ([...ss.options].some(o => o.value === prevS)) ss.value = prevS;
  const selSess = currentSession();
  const evs = P.events.filter(e => (selDay === "*" || e.day === selDay) && (selSess == null || e.zv === selSess));
  const levels = [...new Set(evs.map(e => e.lvl).filter(l => l != null))].sort((a, b) => a - b);
  const ls = $("levelSel"), prevL = keep ? ls.value : "*";
  ls.innerHTML = ""; ls.append(new Option("All levels", "*"));
  for (const lv of [...levels].reverse()) ls.append(new Option(`Level ${lv}`, String(lv)));
  if (evs.some(e => e.lvl == null) && levels.length) ls.append(new Option("Level unknown", "?"));
  if ([...ls.options].some(o => o.value === prevL)) ls.value = prevL;
}
function buildControls(keepSelections) {
  const { P, seg, side } = STATE;
  const w = P.who;
  const prevCombo = keepSelections ? $("comboSel").value : null;
  const pets = [...new Set(side.claims.names.filter(c => c.kind === "pet").map(c => c.name))];
  const charms = [...new Set(side.claims.names.filter(c => c.kind === "charm").map(c => c.name))];
  $("whoLine").innerHTML = `<span class="who-name">${P.owner}</span>` +
    (w ? `<span class="who-meta">${w.race} · ${w.classes} · ${w.zone}</span>` : "") +
    (pets.length ? `<span class="who-pet tipv" data-tip="lp:pets">pets: ${pets.slice(0, 4).join(", ")}${pets.length > 4 ? "…" : ""}</span>` : `<span class="who-pet dim tipv" data-tip="lp:pets">no pet detected</span>`) +
    (charms.length ? `<span class="who-pet tipv" data-tip="lp:pets">charm: ${charms.slice(0, 3).join(", ")}${charms.length > 3 ? "…" : ""}</span>` : "") +
    (seg.levels.length ? `<span class="who-lvl">levels ${seg.levels[0]}–${seg.levels[seg.levels.length - 1]}</span>` : "") +
    (seg.swapAt ? `<span class="who-swap tipv" data-tip="lp:swap">loadout swap? ${dtShort(seg.swapAt)}</span>` : "");
  const prevDay = keepSelections ? $("daySel").value : null;
  const ds = $("daySel"); ds.innerHTML = "";
  const days = [...new Set(P.events.map(e => e.day))];
  ds.append(new Option("All days", "*"));
  for (const k of [...days].reverse()) ds.append(new Option(dayLabel(k), k));
  // default: today when the log has it, else the newest day it does have.
  // On a keep re-parse a day that slid out of the 40 MB window falls back to
  // All days, never to a different day — same stale-key rule as every other
  // control (remapping would silently swap the data mid-review)
  const today = dayKey(new Date());
  ds.value = prevDay ? ([...ds.options].some(o => o.value === prevDay) ? prevDay : "*")
    : days.includes(today) ? today
    : days.length ? days[days.length - 1] : "*";
  syncSliceControls(keepSelections);
  const combos = [...new Set(P.events.filter(e => e.k === "dmg").map(e => e.combo))];
  const cs = $("comboSel"); cs.innerHTML = ""; cs.append(new Option("All combos", "*")); for (const c of combos) cs.append(new Option(c, c));
  if (prevCombo && [...cs.options].some(o => o.value === prevCombo)) cs.value = prevCombo;
  // the select lists the SAME fights as the mob-table encounters (every
  // clickable row must have an option, or setting the value silently lands
  // on fight 0)
  const prevFight = keepSelections ? $("fightSel").value : null;
  const fs = $("fightSel"); fs.innerHTML = ""; fs.append(new Option("All fights", "*"));
  for (const f of seg.fights.filter(f => f.total > 0 || f.taken > 0).sort((x, y) => y.start - x.start)) fs.append(new Option(`${f.mob} · ${dtShort(f.start)} · ${fmt(f.total)} dmg`, fkey(f)));
  if (prevFight && [...fs.options].some(o => o.value === prevFight)) fs.value = prevFight;
}

/* ─── copy summary (for Discord / guild chat) ─────────────────────────────*/
function buildSummary() {
  const { P, seg, side } = STATE;
  const selLevels = currentLevels(), selFight = $("fightSel").value;
  const focus = selFight === "*" ? null : seg.fights.find(f => fkey(f) === selFight) || null;
  if (focus) {
    const dur = Math.max((focus.end - focus.start) / 1000, 1);
    return `${P.owner} vs ${focus.mob} — ${Math.round(dur)}s, ${fmt(focus.total)} damage` +
      (dur >= MIN_RATE_SEC ? ` (${rateDps(focus.total, dur)} DPS)` : "") +
      (focus.taken ? `, took ${fmt(focus.taken)}` : "") + (focus.xp ? `, ${focus.xp.toFixed(2)}% xp` : "") +
      `\nparsed in the browser at eqltools.com/log-parser`;
  }
  let events = P.events;
  const selDay = currentDay(), selSess = currentSession();
  if (selDay) events = events.filter(e => e.day === selDay);
  if (selSess != null) events = events.filter(e => e.zv === selSess);
  if (selLevels) events = events.filter(e => selLevels.has(e.lvl));
  const selCombo = $("comboSel").value;
  if (selCombo !== "*") events = events.filter(e => e.combo === selCombo);
  const oc = P.who ? P.who.classes.split("/") : null;
  const a = analyze(P, events, side, oc);
  const dps = a.combatSec >= MIN_RATE_SEC ? `${fmt(a.total / a.combatSec)} DPS over ${Math.round(a.combatSec / 60)}m` : "—";
  let fightsInSlice = seg.fights.filter(f => f.total > 0 || f.taken > 0);
  if (selDay) fightsInSlice = fightsInSlice.filter(f => dayKey(f.start) === selDay);
  if (selSess != null) fightsInSlice = fightsInSlice.filter(f => f.zv === selSess);
  if (selLevels) fightsInSlice = fightsInSlice.filter(f => selLevels.has(f.lvl));
  if (selCombo !== "*") fightsInSlice = fightsInSlice.filter(f => f.combo === selCombo);
  const kills = fightsInSlice.filter(f => f.killed && (f.killer === P.owner || side.claims.at(f.killer, f.end))).length;
  const share = [["you", a.tot.you], ["pets", a.tot.pet], ["charm", a.tot.charm]].filter(([, v]) => v)
    .map(([k, v]) => `${k} ${pct(v, a.total)}`).join(" · ");
  const top = a.sources.slice(0, 3).map(s => `${s.name} ${fmt(s.dmg)}`).join(" · ");
  const slice = [
    selDay ? $("daySel").selectedOptions[0].textContent : "whole log",
    selSess != null ? $("sessSel").selectedOptions[0].textContent : null,
    selLevels ? $("levelSel").selectedOptions[0].textContent : null,
  ].filter(Boolean).join(" · ");
  const activeH = a.activeSecs / 3600;
  const paceTxt = activeH >= 1 / 6 && a.xp > 0 ? `\n${(a.xp / activeH).toFixed(1)}% xp/hr over ${activeH.toFixed(1)}h active` : "";
  return `${P.owner}${P.who ? ` (${P.who.classes})` : ""} — ${slice}\n` +
    `${fmt(a.total)} damage · ${dps} · ${kills} kills · ${a.deaths.length} deaths` +
    (a.xp ? ` · ${a.xp >= 100 ? (a.xp / 100).toFixed(1) + " levels" : a.xp.toFixed(1) + "% xp"}` : "") +
    (a.copper ? ` · ${fmtCopper(a.copper)}` : "") +
    `\n${share}\ntop: ${top}${paceTxt}\nparsed in the browser at eqltools.com/log-parser`;
}

/* ─── intake ──────────────────────────────────────────────────────────────*/
const CAP = 40 * 1024 * 1024;
async function handleFile(file, opts = {}) {
  $("err").hidden = true;
  try {
    await Promise.all([loadSpellData(), loadConBands()]);
    const truncated = file.size > CAP;
    const blob = truncated ? file.slice(file.size - CAP) : file;
    let text = await blob.text();
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
    const ownerFromName = (file.name.match(/eqlog_([^_]+)_/) || [])[1];
    const P = parse(text, ownerFromName);
    if (!P.events.some(e => e.k === "dmg")) { showErr("No combat found — is this an EQ Legends log with logging on (/log on)?"); return; }
    const claims = buildClaims(P);
    STATE = { P, claims, side: mkSide(P, claims) };
    STATE.seg = buildSegments(P, STATE.side);
    buildControls(opts.keepSelections);
    $("intake").hidden = true; $("report").hidden = false;
    const tn = $("truncNote");
    if (truncated) { tn.hidden = false; tn.textContent = `Large file — read the last 40 MB (from ${dt(P.events[0].ts)}). Earlier history isn't shown.`; } else tn.hidden = true;
    render();
    if (!opts.keepSelections) $("report").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { showErr("Couldn't read that file: " + e.message); console.error(e); }
}
function showErr(msg) { const e = $("err"); e.hidden = false; e.textContent = msg; }

/* ─── live watch (Chromium: File System Access API re-reads the handle) ───*/
let WATCH = null; // { handle, size, timer }
async function startWatch() {
  stopWatch();
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "EQ Legends log", accept: { "text/plain": [".txt"] } }],
    });
    const file = await handle.getFile();
    await handleFile(file);
    WATCH = { handle, size: file.size, timer: setInterval(pollWatch, 5000) };
    $("watchNote").hidden = false;
  } catch (e) { if (e.name !== "AbortError") showErr("Couldn't watch that file: " + e.message); }
}
async function pollWatch() {
  if (!WATCH) return;
  try {
    const file = await WATCH.handle.getFile();
    if (file.size === WATCH.size) return;
    WATCH.size = file.size;
    await handleFile(file, { keepSelections: true });
    $("watchNote").hidden = false;
  } catch { stopWatch(); }
}
function stopWatch() {
  if (WATCH) { clearInterval(WATCH.timer); WATCH = null; }
  $("watchNote").hidden = true;
}

const dz = $("dropZone"), fi = $("logFile");
dz.addEventListener("click", () => fi.click());
fi.addEventListener("change", e => { const f = e.target.files[0]; if (f) { stopWatch(); handleFile(f); } });
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) { stopWatch(); handleFile(f); } });
["levelSel", "comboSel", "fightSel"].forEach(id => $(id).addEventListener("change", render));
$("daySel").addEventListener("change", () => { syncSliceControls(false); render(); });
$("sessSel").addEventListener("change", () => { syncSliceControls(true); render(); });
$("mobMore").addEventListener("click", () => { SHOW_ALL_MOBS = !SHOW_ALL_MOBS; render(); });
$("lootMore").addEventListener("click", () => { SHOW_ALL_LOOT = !SHOW_ALL_LOOT; render(); });
$("btnReset").addEventListener("click", () => { stopWatch(); STATE = null; $("report").hidden = true; $("intake").hidden = false; fi.value = ""; window.scrollTo({ top: 0, behavior: "smooth" }); });
$("btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(buildSummary()); const b = $("btnCopy"); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy summary"; }, 1500); }
  catch { showErr("Couldn't reach the clipboard — your browser may be blocking it."); }
});
if (window.showOpenFilePicker) {
  $("btnWatch").hidden = false;
  $("btnWatch").addEventListener("click", startWatch);
}
if (window.EQLTip) { EQLTip.provider("lp", tipProvider); EQLTip.init(); }

/* ─── embedded intake (EQL Tools Companion iframe) ────────────────────────
   ?embed=1 drops the site chrome and the file intake; the embedder tails the
   log itself and posts {type:"eqlt-log", text, name, keep}. A File keeps
   handleFile's single intake path, and parsing stays local either way. Not
   an attribution/grammar change — logparse_ref.py intentionally untouched.
   typeof-guarded: the verification harness runs this file without a DOM. */
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("embed")) {
  document.body.classList.add("embed");
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.type === "eqlt-log" && typeof d.text === "string")
      handleFile(new File([d.text], String(d.name || "eqlog.txt")), { keepSelections: !!d.keep });
  });
}

