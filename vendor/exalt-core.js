/* DO NOT EDIT — generated copy of public/exalt/exalt-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Exaltation finder — the catalog, the fitting rule, and the dump reading.

   One implementation for three surfaces: the /exalt page, the companion app's
   Inventory → Exalt mode, and the overlay's Exalt view. The app vendors this
   file (companion/scripts/sync-vendor.mjs); edit here, never fork.

   ── what an exaltation is ─────────────────────────────────────────────────
   Every item's Focus / Click / Worn / Proc effect becomes a removable stone
   once the item reaches +1 / +2 / +3 / +4, and the stone can be socketed into
   any other item that has that socket open (same tiers) — wiki "Exaltations",
   confirmed by the dev Insights episode (focus at +1, proc at +4) and by the
   reference dump, where the socket ids present on all 23 worn items are fully
   determined by tier (public/_shared/exalt-slots.js). Ornaments (looks) are a
   fifth kind that carries no effect and no restriction; they are not in the
   catalog. Haste is a stat, not an exaltation ("Haste is not an exalt" — dev,
   2026-05-04).

   ── the fitting rule ──────────────────────────────────────────────────────
   A stone keeps its source item's class list and slot list, and the host item
   takes on the INTERSECTION of both when the stone goes in (wiki
   "Exaltations" §Restrictions; the in-game refusal is "The result of this
   combine would produce an unusable item."; players have posted before/after
   class lists — a WAR/CLR/PAL/RNG/SHD/DRU/MNK/BRD/ROG/SHM/BST/BER tunic with
   the Spiky Splintmail click in it reads WAR/RNG/SHD/SHM/BER). So:

     fits(stone, host)  ⇔  classes(stone) ∩ classes(host) ≠ ∅
                        ∧  slots(stone)   ∩ slots(host)   ≠ ∅
     result classes = the class intersection; result slots = the slot one.

   A two-hander is Primary-only, so its proc makes a one-hander Primary-only
   too — you can still put it in a 1H, you just cannot put that 1H in your
   off hand. Deity restrictions carry as well (patch note 2026-06-23); the
   data marks them, it does not resolve them. Whether YOU can wear the result
   is a separate question: one of your three classes must be in the result.

   ── the dump ──────────────────────────────────────────────────────────────
   "/outputfile inventory" nests a socketed stone under its host as
   "<Slot>-Slot<N>" where N is the socket TYPE (7 focus, 8 click, 9 worn,
   10 proc; 1/2 ornament), lists loose stones under "Augmentation", and names
   every stone after the item it was rendered from, "(Exaltation)" appended.
   The stone's item ID equals its source item's ID. A stone is ONE effect of
   its source; a loose one does not say which, so it is shown with every
   effect the source could yield.

   Requires: window.EQLGearScore (rows, WORN_RX, TWO_H, baseName),
             window.EQLExalt (socket types). */
(function () {
  "use strict";
  const GS = window.EQLGearScore;
  const EX = window.EQLExalt;
  const CLASSES = ["WAR", "CLR", "PAL", "RNG", "SHD", "DRU", "MNK", "BRD",
                   "ROG", "SHM", "NEC", "WIZ", "MAG", "ENC", "BST", "BER"];

  /* The four effect kinds, in socket-unlock order. `at` is the tier that
     opens the socket AND the tier the source item needs before the effect can
     be pulled out; `n` is the dump's socket id. */
  const TYPES = [
    { key: "focus", label: "Focus", at: 1, n: 7,
      what: "A passive focus effect — spell damage, cast speed, duration, healing, an instrument's resonance." },
    { key: "click", label: "Click", at: 2, n: 8,
      what: "A clickable spell. Some need the item worn to click; some work from a bag or the Activated Items storage." },
    { key: "worn",  label: "Worn",  at: 3, n: 9,
      what: "A passive effect that is on while the item is worn." },
    { key: "proc",  label: "Proc",  at: 4, n: 10,
      what: "A chance-on-hit spell." },
  ];
  const TYPE = {};
  TYPES.forEach((t) => { TYPE[t.key] = t; });

  /* ── classes and slots ────────────────────────────────────────────── */
  /* An item record's class list as an array of codes; null means "any class"
     (the wiki's ALL). {all:1, x:[..]} is "all except". {none:1} → []. */
  function classesOf(rec) {
    const c = rec && rec.cls;
    if (!c) return null;
    if (c.none) return [];
    if (c.all) return c.x && c.x.length ? CLASSES.filter((k) => !c.x.includes(k)) : null;
    return (c.c || []).filter((k) => CLASSES.includes(k));
  }
  const clsInter = (a, b) => (a === null ? b : b === null ? a : a.filter((k) => b.includes(k)));
  const clsHas = (list, trio) => list === null || (trio || []).some((k) => list.includes(k));
  const clsSort = (list) => list.slice().sort((a, b) => CLASSES.indexOf(a) - CLASSES.indexOf(b));
  const clsText = (list) => (list === null ? "ALL" : list.length ? clsSort(list).join(" ") : "none");

  const slotsOf = (rec) => ((rec && rec.sl) || []).slice();
  const slotInter = (a, b) => a.filter((s) => b.includes(s));

  /* ── the effect kind of a wiki effect record ─────────────────────── */
  function kindOf(e) {
    if (!e) return null;
    if (e.k === "focus") return "focus";
    if (e.m === "combat" || e.k === "combat_eff") return "proc";
    if (e.m === "worn" || e.k === "worn_eff") return "worn";
    if (e.m === "clicky" || e.m === "must_equip" || e.k === "click" || e.ct) return "click";
    return null;                       // the wiki tagged nothing — not claimed
  }

  /* ── the catalog ──────────────────────────────────────────────────── */
  /* Every effect every item could yield, one entry per (item, effect). Items
     with a class list of "none" and items with no slot are skipped (nothing
     can wear them, so nothing can hold their stone). */
  function build(DATA) {
    const stones = [];
    const byKey = new Map();          // item key -> [stones of that item]
    const effects = (DATA && DATA.effects) || {};
    if (!DATA || !DATA.items) return { stones, byKey, effects };
    for (const key of Object.keys(DATA.items)) {
      const rec = DATA.items[key];
      const cls = classesOf(rec);
      const sl = slotsOf(rec);
      if (!sl.length || (cls && !cls.length)) continue;
      const list = [];
      const push = (type, effect, eff) => {
        const s = {
          id: `${key}|${type}|${effect}`,
          key, item: rec.n, rec, type, effect, eff: eff || null,
          at: TYPE[type].at, cls, sl,
          twoH: GS.TWO_H(rec), oe: !!rec.oe, era: rec.era || null,
          deity: rec.deity || null,
          fx: effects[effect] || null,
          untyped: false,
        };
        list.push(s);
      };
      if (rec.foc) push("focus", rec.foc, null);
      // an instrument's resonance is a focus effect (see header); an item
      // whose focus_effect field already names it is not counted twice
      for (const kind of rec.inst || []) {
        // "Brass Instruments: 10" on a Horn Mouthpiece is a tradeskill line,
        // not a resonance; only "<Kind> Resonance" is an instrument mod
        if (!/Resonance$/.test(kind)) continue;
        const v = (rec.ex || {})[kind];
        if (!v || String(v) === "0") continue;
        const name = `${kind} ${v}`;
        if (rec.foc === name) continue;
        push("focus", name, { k: "focus", n: name });
      }
      for (const e of rec.eff || []) {
        const kind = kindOf(e);
        if (kind === "focus" && rec.foc === e.n) continue;
        if (kind) push(kind, e.n, e);
        else {
          // the wiki lists an effect without saying what kind it is; it is
          // shown, filed under no socket, and never counted as fitting one
          list.push({
            id: `${key}|?|${e.n}`, key, item: rec.n, rec, type: null,
            effect: e.n, eff: e, at: null, cls, sl, twoH: GS.TWO_H(rec),
            oe: !!rec.oe, era: rec.era || null, deity: rec.deity || null,
            fx: effects[e.n] || null, untyped: true,
          });
        }
      }
      if (list.length) {
        byKey.set(key, list);
        stones.push(...list);
      }
    }
    return { stones, byKey, effects };
  }

  /* ── the fitting rule ─────────────────────────────────────────────── */
  /* host = { cls: array|null, sl: array, tier: int|null }
     Returns the verdict and the item that would result. `open` is null when
     the host's tier is unknown (a catalog item, not a worn one). */
  function fit(stone, host) {
    const cls = clsInter(stone.cls, host.cls === undefined ? null : host.cls);
    const sl = slotInter(stone.sl, host.sl || []);
    const why = [];
    if (cls !== null && !cls.length) why.push("no shared class");
    if (!sl.length) why.push("no shared slot");
    const open = stone.at === null ? false
      : (host.tier === null || host.tier === undefined) ? null : host.tier >= stone.at;
    if (stone.type === null) why.push("kind of effect not stated on the wiki");
    return {
      ok: !why.length, why, cls, sl, open,
      narrowsCls: cls !== null && (host.cls === null || (host.cls && cls.length < host.cls.length)),
      narrowsSl: (host.sl || []).length > sl.length,
    };
  }

  /* Can this trio wear an item with this class list? */
  const usableBy = (cls, trio) => clsHas(cls, trio);

  /* ── the dump ─────────────────────────────────────────────────────── */
  /* rows: GS.parseRows(text). DATA: gear-data. Returns what the finder needs
     to say about what you own:
       worn     — every worn item with its tier, record, and sockets
       loose    — stones in the Augmentation bin / Exaltation key ring
       sources  — items you own (anywhere) whose record yields a stone,
                  with the tier they are at and the tier each stone needs
     Every stone row resolves its source item through DATA.names, same as
     /gear resolves worn items. */
  function readDump(rows, DATA, cat) {
    const names = (DATA && DATA.names) || {};
    const resolve = (base) => {
      const keys = names[String(base).toLowerCase()];
      const key = keys ? keys[0] : null;
      return { key, rec: key ? DATA.items[key] : null };
    };
    const byLoc = new Map(rows.map((r) => [r.loc, r]));
    const yieldsOf = (key) => (key && cat.byKey.get(key)) || [];
    /* The four sockets of an item row, read off its "-SlotN" children. A
       storage-bin row (3 columns, no children) reports every socket as
       unknown rather than empty. */
    function socketsOf(r) {
      const sockets = {};
      let seen = false;
      for (const t of TYPES) {
        const sub = byLoc.get(`${r.loc}-Slot${t.n}`);
        if (sub) seen = true;
        const filled = sub && sub.exalt ? sub : null;
        let stone = null;
        if (filled) {
          const fs = resolve(filled.base);
          const list = yieldsOf(fs.key);
          // the socket type says which of the source's effects this is
          stone = { row: filled, key: fs.key, rec: fs.rec,
                    stone: list.find((s) => s.type === t.key) || null, yields: list };
        }
        sockets[t.key] = { open: r.tier >= t.at, filled: !!filled, stone };
      }
      return { sockets, known: seen };
    }
    const worn = [], loose = [], sources = [];
    for (const r of rows) {
      if (EX.socketAt(r.loc)) continue;      // socketed stones ride on their host
      const isWorn = GS.WORN_RX.test(r.loc);
      const rs = resolve(r.base);
      if (r.exalt) {
        // a loose stone: the Augmentation bin / Exaltation key ring, or lying
        // in a bag or the bank
        loose.push({ row: r, key: rs.key, rec: rs.rec, yields: yieldsOf(rs.key) });
        continue;
      }
      const yields = yieldsOf(rs.key);
      const sk = socketsOf(r);
      const cls = rs.rec ? classesOf(rs.rec) : null, sl = rs.rec ? slotsOf(rs.rec) : [];
      if (isWorn) {
        let slot = GS.WORN_RX.exec(r.loc)[1];
        if (slot === "Finger" || slot === "Ring") slot = "Fingers";
        worn.push({ row: r, slot, key: rs.key, rec: rs.rec, tier: r.tier, cls, sl,
                    sockets: sk.sockets, yields });
      }
      if (yields.length || Object.values(sk.sockets).some((s) => s.filled)) {
        sources.push({ row: r, key: rs.key, rec: rs.rec, tier: r.tier, worn: isWorn, cls, sl,
                       yields, sockets: sk.sockets, socketsKnown: sk.known });
      }
    }
    return { worn, loose, sources };
  }

  /* Which of the worn items a stone can go into right now, and which it could
     go into after an upgrade. */
  function homesFor(stone, worn) {
    const now = [], later = [], never = [];
    for (const w of worn) {
      if (!w.rec) continue;
      const f = fit(stone, { cls: w.cls, sl: w.sl, tier: w.tier });
      if (!f.ok) { never.push({ w, f }); continue; }
      const sock = stone.type ? w.sockets[stone.type] : null;
      if (sock && sock.open) now.push({ w, f, occupied: sock.filled });
      else later.push({ w, f, needs: stone.at });
    }
    return { now, later, never };
  }

  /* Stones that could sit in an item worn in this slot — the by-slot view.
     `trio` narrows to stones one of your classes could still use; null
     keeps everything. Untyped effects are left out (they fit no socket). */
  function forSlot(stones, slot, trio, opts) {
    const o = opts || {};
    return stones.filter((s) => {
      if (s.type === null) return false;
      if (!s.sl.includes(slot)) return false;
      if (o.hideOE && s.oe) return false;
      if (trio && trio.length && !usableBy(s.cls, trio)) return false;
      return true;
    });
  }

  /* One line for a source, for a table cell: "Lower Guk · a froglok shaman
     (+3 more)". Everything is in `rec.src`. */
  /* Zones the wiki's era switch marks locked (gear-data `zone_oe`) are
     never named: an in-era item can list a Kunark mob among its sources. */
  let LOCKED = new Set();
  const setLockedZones = (list) => { LOCKED = new Set(list || []); };
  const drops = (rec) => (((rec && rec.src) || {}).d || []).filter(([zone]) => !LOCKED.has(zone));

  function sourceText(rec) {
    const s = (rec && rec.src) || {};
    const parts = [];
    let firstZone = null, mobs = 0;
    for (const [zone, ms] of drops(rec)) {
      if (!firstZone) firstZone = { zone, mob: ms[0] ? ms[0][0] : null };
      mobs += ms.length;
    }
    if (firstZone) {
      let t = firstZone.zone + (firstZone.mob ? ` · ${firstZone.mob}` : "");
      if (mobs > 1) t += ` (+${mobs - 1} more)`;
      parts.push(t);
    }
    if (s.q) parts.push("quest");
    if (s.c) parts.push("crafted");
    if (s.s) parts.push("sold");
    if (s.f) parts.push("foraged");
    if (s.v) parts.push("various");
    return parts.join(" · ");
  }
  function sourceLines(rec) {
    const s = (rec && rec.src) || {};
    const out = [];
    for (const [zone, ms] of drops(rec))
      for (const m of ms) out.push(`${zone} — ${m[0]}${m[1] ? ` (${m[1]})` : ""}${m[2] ? `, ${m[2]}` : ""}`);
    if (s.q) out.push("Quest reward");
    if (s.c) out.push("Crafted");
    if (s.s) out.push("Sold by a vendor");
    if (s.f) out.push("Foraged");
    if (s.v) out.push("Various sources");
    return out;
  }

  window.EQLExaltCore = {
    TYPES, TYPE, CLASSES,
    classesOf, clsInter, clsHas, clsSort, clsText, slotsOf, slotInter, kindOf,
    build, fit, usableBy, readDump, homesFor, forSlot, sourceText, sourceLines, setLockedZones,
  };
})();
