/* DO NOT EDIT — generated copy of public/kills/parse.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* EQLKillsParse — the /kills log grammar, split out so a Node/Electron
   companion can reuse it verbatim. Environment-neutral: no DOM, no
   localStorage, no fetch. Browser attaches window.EQLKillsParse; under node,
   module.exports. Constants/parseLog/ingest are byte-identical to what
   shipped inline in app.js before this split — equivalence is pinned by
   pipeline/scripts/check_kills_parse.mjs against a frozen copy of the old
   code. Line grammar is the same proven set as /log-parser
   (pipeline/scripts/logparse_ref.py is that tool's reference); the loot
   pattern is lifted from there too (public/log-parser/app.js RX.loot). */
(function (root) {
"use strict";

/* ─── grammar ────────────────────────────────────────────────────────────*/
const TS = String.raw`^\[(\w{3}) (\w{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})\] `;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const RX = {
  slain_you: new RegExp(TS + String.raw`You have slain (.+?)!$`),
  slain_by:  new RegExp(TS + String.raw`(.+?) has been slain by (.+?)!$`),
  died:      new RegExp(TS + String.raw`(.+?) died\.$`),
  xp:        new RegExp(TS + String.raw`You gain (?:party |group )?experience! \((\d+(?:\.\d+)?)%\)$`),
  zone:      new RegExp(TS + String.raw`You have entered (.+?)\.$`),
  // Same loot line proven in /log-parser and logparse_ref.py. Groups after
  // TS's own 7: m[8] qty (optional), m[9] item, m[10] mob, m[11] the tail
  // alternation (undefined = plain "...corpse." — kept), m[12] the coin
  // string when the tail is a sale.
  loot:      new RegExp(TS + String.raw`You looted (?:an? |(\d+) )?(.+?) from (.+?)'s corpse(?:\.| (and stored it in your tradeskill depot|and sold it for free\.|and sold it for (.+?)\.|to create an? .+))?$`),
  // MANUAL loot (corpse window) prints a different line than auto-loot:
  // "--You have looted a Charcoal from an earth elemental's corpse.--".
  // Observed 2026-07-31, 309 lines in eqlog_Ravlin_oggok: always --wrapped,
  // article precedes even plural item names ("a Bone Chips"), stacks print a
  // count ("2 Bone Chips"), items may contain apostrophes ("Rambunctious
  // Pet's Skull from a rambunctious pet's corpse" — the lazy item group stops
  // at the first " from "). No sell/depot tail exists on manual loot.
  // Groups mirror RX.loot: m[8] qty, m[9] item, m[10] mob.
  lootManual: new RegExp(TS + String.raw`--You have looted (?:an? |(\d+) )?(.+?) from (.+?)'s corpse\.--$`),
};
const ZONE_SKIP = /^(an area|an Arena|the Drunken Monkey)/;
const ZONE_TIER = /^(.*) [1-4] \((?:Awakened|Adaptive|Fused|Refined)\)$/;
const toSec = m => Date.UTC(+m[7], MONTHS[m[2]] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;

// disp from RX.loot's tail group (m[11]/m[12]): "kept" (bare period or
// nothing after 'corpse'), "depot", "sold_free", "sold" (soldFor carries the
// coin string), "created" (tradeskill combine).
function lootDisp(m) {
  if (!m[11]) return "kept";
  if (/tradeskill depot/.test(m[11])) return "depot";
  if (/sold it for free/.test(m[11])) return "sold_free";
  if (m[12] != null) return "sold";
  return "created";
}

/* ─── KillStream — stateful line-at-a-time parser for live tailing ─────────
   Same event semantics as the old batch parseLog (credit rules, zone
   tracking with tier folding and ZONE_SKIP, the ±2s xp correlation) but
   resolved incrementally so a tail -f caller gets kills as soon as they're
   decidable, not just at EOF.

   A kill candidate's credit is knowable immediately for "You have slain"
   (blow) but for "has been slain by"/"died." it depends on whether an xp
   line lands within ±2s — which can be a line that hasn't arrived yet. A
   candidate can only be reported once no future xp line could still land in
   its window, i.e. once the stream has seen ANY later timestamp (ts is
   monotonic across a real log), or at flush(). Candidates are drained
   strictly in creation order (FIFO) — even a "blow" candidate waits its turn
   behind an older undecided one — so the emitted array position always
   matches the old parseLog's cand-array order, never resolution order. */
class KillStream {
  constructor({ name2key, normName }) {
    this._name2key = name2key;
    this._normName = normName;
    this.zone = "?";
    // Old parseLog semantics EXACTLY: only the 5 kill-relevant patterns
    // advance this (it becomes parsed.lastTs, the file's high-water mark) —
    // a loot line must not move it, or a re-dropped log could silently skip
    // a kill sharing its second.
    this.lastTs = 0;
    this.lines = 0;
    this._pending = [];   // candidates in creation order; credit may be null
    this._head = 0;       // index of the next candidate to emit
    this._xpTs = [];      // xp timestamps seen so far, append-only
    // Forward pointer into _xpTs — only ever advances, same one-forward-
    // pointer logic as the old batch resolution loop (walked only by
    // null-credit candidates).
    this._xpI = 0;
    // Internal only: latest ts from ANY recognized line (loot included) —
    // what "resolvable yet?" checks against; ts is monotonic across a real
    // log, so this is always >= this.lastTs.
    this._seenTs = 0;
  }

  feed(rawLine) {
    const out = [];
    if (rawLine.length < 28) return out;
    this.lines++;
    let m;
    if ((m = RX.zone.exec(rawLine))) {
      if (!ZONE_SKIP.test(m[8])) {
        const t = ZONE_TIER.exec(m[8]);
        this.zone = this._name2key.get((t ? t[1] : m[8]).toLowerCase()) || "?";
        this._seenTs = this.lastTs = toSec(m);
      }
    } else if ((m = RX.slain_you.exec(rawLine))) {
      this._seenTs = this.lastTs = toSec(m);
      this._pending.push({ ts: this.lastTs, zone: this.zone, n: this._normName(m[8]), credit: "blow" });
    } else if ((m = RX.slain_by.exec(rawLine))) {
      this._seenTs = this.lastTs = toSec(m);
      this._pending.push({ ts: this.lastTs, zone: this.zone, n: this._normName(m[8]), credit: null });
    } else if ((m = RX.died.exec(rawLine))) {
      if (m[8] !== "You") {
        this._seenTs = this.lastTs = toSec(m);
        this._pending.push({ ts: this.lastTs, zone: this.zone, n: this._normName(m[8]), credit: null });
      }
    } else if ((m = RX.xp.exec(rawLine))) {
      this._seenTs = this.lastTs = toSec(m);
      this._xpTs.push(this.lastTs);
      // Also surfaced as an event: live consumers (the companion's session
      // strip) sum these. Percent-of-current-level, same as the line prints.
      out.push({ kind: "xp", ts: this.lastTs, pct: +m[8] });
    } else if ((m = RX.loot.exec(rawLine))) {
      const ts = toSec(m);
      this._seenTs = ts;
      const disp = lootDisp(m);
      out.push({ kind: "loot", ts, zone: this.zone,
        qty: +(m[8] || 1), item: m[9], mob: m[10], disp,
        ...(disp === "sold" ? { soldFor: m[12] } : {}) });
    } else if ((m = RX.lootManual.exec(rawLine))) {
      const ts = toSec(m);
      this._seenTs = ts;
      out.push({ kind: "loot", ts, zone: this.zone,
        qty: +(m[8] || 1), item: m[9], mob: m[10], disp: "kept" });
    }
    this._drain(out, false);
    return out;
  }

  // Resolves every remaining pending candidate as if the log ended here.
  flush() {
    const out = [];
    this._drain(out, true);
    return out;
  }

  _drain(out, final) {
    while (this._head < this._pending.length) {
      const c = this._pending[this._head];
      if (c.credit == null) {
        if (!final && !(this._seenTs > c.ts + 2)) break; // not decidable yet; nothing behind it can go either
        while (this._xpI < this._xpTs.length && this._xpTs[this._xpI] < c.ts - 2) this._xpI++;
        c.credit = (this._xpI < this._xpTs.length && this._xpTs[this._xpI] <= c.ts + 2) ? "xp" : "wit";
      }
      out.push({ kind: "kill", ts: c.ts, zone: c.zone, n: c.n, credit: c.credit });
      this._head++;
    }
  }
}

// -> {kills: [{ts, zone, n, credit}], lastTs, lines} — the old parseLog's
// exact shape. credit: 'blow' (your killing blow), 'xp' (someone else's
// blow, an xp line within ±2s — group or pet kill), 'wit' (witnessed, no
// xp). zone is an atlas key or '?' before the first "You have entered" line
// resolves.
function parseLog(text, name2key, normName) {
  const ks = new KillStream({ name2key, normName });
  const kills = [];
  for (const raw of text.split(/\r?\n/))
    for (const ev of ks.feed(raw)) if (ev.kind === "kill") kills.push({ ts: ev.ts, zone: ev.zone, n: ev.n, credit: ev.credit });
  for (const ev of ks.flush()) if (ev.kind === "kill") kills.push({ ts: ev.ts, zone: ev.zone, n: ev.n, credit: ev.credit });
  return { kills, lastTs: ks.lastTs, lines: ks.lines };
}

/* ─── merge into state ────────────────────────────────────────────────────*/
const bump = (bucket, z, n, ts) => {
  const zb = bucket[z] || (bucket[z] = {});
  if (zb[n]) { zb[n].c++; if (ts < zb[n].t) zb[n].t = ts; }
  else zb[n] = { c: 1, t: ts };
};

// indexes: {nameZones} — the NAMEZONES Map (lowercase mob name -> Set(zone
// keys)), used for the unique-zone inference and the known/unmatched split.
// opts.hwm === false skips the high-water-mark gate below for this call
// (default: gated, matching the /kills page's re-drop-safe behavior — a
// growing log dropped again must not double-count what it already counted).
// A live-tailing consumer (KillStream, fed each line exactly once — its own
// byte-offset dedup already prevents replay) batches resolved kills and
// flushes them on a timer; the hwm gate would wrongly drop a candidate that
// KillStream resolves one flush later than an earlier candidate sharing its
// exact second. files[fileName] bookkeeping (the high-water mark itself, and
// the line count) is written the same way regardless of the flag — hwm:false
// only changes what gates the per-event skip.
function ingest(state, indexes, fileName, parsed, opts) {
  const nameZones = indexes.nameZones;
  const useHwm = !opts || opts.hwm !== false;
  const hwm = (state.files[fileName] && state.files[fileName].ts) || 0;
  let added = 0;
  for (const ev of parsed.kills) {
    if (useHwm && ev.ts <= hwm) continue;
    let z = ev.zone;
    // A kill before any zone line still lands if the mob exists in exactly
    // one EQL zone; otherwise it waits in the unplaced bucket.
    if (z === "?" && nameZones.has(ev.n) && nameZones.get(ev.n).size === 1)
      z = nameZones.get(ev.n).values().next().value;
    // `kills` holds any mob the dataset knows ANYWHERE — a named wanderer
    // killed off its wiki zone still has to feed the cross-zone credit pool.
    // `unmatched` is only for names no zone lists (players, wiki gaps).
    const known = nameZones.has(ev.n);
    if (ev.credit === "wit") {
      if (known) { bump(state.wit, z, ev.n, ev.ts); added++; }
      // witnessed unknown-name deaths are mostly other players — dropped
    } else if (known) {
      bump(state.kills, z, ev.n, ev.ts); added++;
    } else if (!/ pet$/.test(ev.n)) {
      // NPC pets die as "<owner mob> pet" ("A Pickclaw Foechopper pet has
      // been slain") — noise, not a completionist target. Only unknown names
      // are dropped: the wiki does track a few specific pets (Summoned Pet,
      // Kizdean Gix Pet), and those took the `known` branch above.
      const zb = state.unmatched[z] || (state.unmatched[z] = {});
      zb[ev.n] = (zb[ev.n] || 0) + 1; added++;
    }
  }
  const ch = (fileName.match(/eqlog_([^_]+)_/) || [])[1];
  if (ch && !state.chars.includes(ch)) state.chars.push(ch);
  state.files[fileName] = { ts: parsed.lastTs, n: parsed.lines };
  return added;
}

const api = { TS, MONTHS, RX, ZONE_SKIP, ZONE_TIER, toSec, KillStream, parseLog, ingest, bump };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else root.EQLKillsParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
