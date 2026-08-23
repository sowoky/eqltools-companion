/* DO NOT EDIT — generated copy of public/_shared/inventory-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Inventory — three questions about what you are carrying that no other core
   answers, shared by the companion app's Inventory tab and any site page that
   reads the same dump. DOM-free, no state of its own — the same contract as
   gear-score.js, spare-core.js and exalt-core.js. Edit here; never fork
   (companion/scripts/sync-vendor.mjs copies it).

   ── 1. catalog rank ───────────────────────────────────────────────────────
   How strong an item is for a class: its place among EVERY in-era item that
   class can wear in the slot, the whole wiki catalogue — gear-score, one
   scorer per class, every candidate at +0. It is the measure /sky's
   "Just that class" view uses for a reward ("4 of 212"), over all of
   gear-data: /sky's own pool drops the Sky rewards and components from the
   comparison and its default view scores for the whole trio, so the two
   numbers are close, not identical. /valet and /spare compare against what
   you OWN; this compares against what EXISTS, which is the question when
   deciding whether a thing is worth keeping at all.

     makeRanker({ D, level, combat }) -> ranker
       ranker.pool(cls, slot)            -> [{ key, rec, s }] score-sorted, memoised
       ranker.rank(rec, cls, slot, tier) -> { rank, of, score, better:[…] } | null
       ranker.best(rec, opts)            -> { best, all:[{cls, slot, rank, of}], trio }

   `best` is the (class, slot) where the item ranks highest, across every
   class the wiki says can wear it; `trio` is the same list kept to the
   caller's own classes. Rank is computed at +0 — the item's own worth, the
   same for every copy you hold whatever tier each is at — and `rank(…, tier)`
   answers the "at the tier I actually have it" question on demand.

   ── 2. copies ─────────────────────────────────────────────────────────────
   The same item in more than one place. Identity is the client item ID the
   dump prints (ten different `Old Silver Coin` are ten different IDs); the
   base name only when the row has no ID. Exaltation stones are never copies
   of anything (a stone is named after its source item, it is not one), nor
   are ornaments or containers.

   What merging pays comes from /learn/upgrades: a tier-t duplicate donates
   2^t exp, tier T needs 2^T − 1 in total. Two +2 copies make a +3; a +0
   merged into a +6 is still +6 with 1 of the 64 exp to +7. The dump names a
   copy's tier, not its exp within it, so a landing tier is a floor.

   A stack split across slots (292 + 68 + 1000 Steel Fletch) is a copy too,
   and the gain is slots: the biggest stack you hold is the lowest the cap can
   be, so ceil(total / biggest) is the most slots the lot can need, and the
   saving reported is a floor.

   Two copies worn in a paired slot (both Ears, both Fingers) are not a merge
   candidate — merging them costs the slot. They are reported with no action.
   A storage-bin row (Equipment / Activated / Augmentation) is a real item in
   a real bin and merges with one in your bags like any other. A pair that
   is not gear at all (opts.isGear says no: a quest component, a tradeskill
   drop) has no tier to merge into and is reported as places, not a merge.

   ── 3. exaltations nobody else holds ──────────────────────────────────────
   An item about to leave your bags may carry a socketed stone that nothing
   else you own can replace. A stone is covered when another stone rendered
   from the SAME source item, holding the same effect, sits anywhere else —
   socketed or loose — or when another copy of its source item you own is at
   the tier that yields it and has not had that effect pulled out (an Empty
   socket, or one holding some other item's stone, says it has). Same effect
   from a different source is not cover: a stone keeps its source's class and
   slot lines, so it is not a drop-in replacement. A loose stone whose source
   yields more than one effect is a MAYBE: the dump does not say which effect
   a loose stone holds (exalt-core's rule), so it is named, not counted.

   Requires: window.EQLGearScore, window.EQLTier, window.EQLChar, and the
   host's EQLExaltCore.readDump() result for question 3. */
(function () {
  "use strict";
  const GS = window.EQLGearScore;
  const CLASSES = window.EQLChar.CLASSES;
  const MAX_TIER = 10;

  /* ── catalog rank ────────────────────────────────────────────────────── */
  function scorable(rec) {
    return !!(rec && (rec.st || rec.sv || rec.haste || rec.dmg));
  }
  /* gear-data's four class-set shapes, as the list of codes that can wear it;
     null is "any class" (a record with no cls line at all, or the wiki's ALL). */
  function classesOf(rec) {
    const c = rec && rec.cls;
    if (!c) return null;
    if (c.none) return [];
    if (c.all) return c.x && c.x.length ? CLASSES.filter((k) => !c.x.includes(k)) : null;
    return (c.c || []).filter((k) => CLASSES.includes(k));
  }
  const realSlots = (rec) => ((rec && rec.sl) || []).filter((s) => GS.SLOTS.includes(s));

  function makeRanker(opts) {
    const D = opts.D;
    const level = opts.level || 50;
    const combat = opts.combat || null;
    const scorers = {}, pools = new Map(), dw = {};
    const scorer = (cls) => scorers[cls] || (scorers[cls] = GS.make({
      classes: [cls], level, race: null, equipped: null, D: combat }));
    const dualWields = (cls) => {
      if (dw[cls] === undefined) dw[cls] = scorer(cls).dualWieldCap() > 0;
      return dw[cls];
    };
    /* The off hand: a two-hander never goes there, and a damaging one-hander
       only for a class that can Dual Wield — the gate /valet and spare-core
       apply, without which a Cleric's Secondary pool is every 1H in the game. */
    const canPlace = (rec, cls, slot) => slot !== "Secondary"
      || (!GS.TWO_H(rec) && (dualWields(cls) || !rec.dmg));

    function pool(cls, slot) {
      const k = cls + "|" + slot;
      let p = pools.get(k);
      if (p) return p;
      const sc = scorer(cls);
      p = [];
      if (D && D.items) for (const key of Object.keys(D.items)) {
        const rec = D.items[key];
        if (rec.oe || !scorable(rec)) continue;
        if (!(rec.sl || []).includes(slot)) continue;
        if (!sc.legal(rec) || !canPlace(rec, cls, slot)) continue;
        p.push({ key, rec, s: sc.score(rec, 0, 0, slot) });
      }
      p.sort((a, b) => b.s - a.s || a.rec.n.localeCompare(b.rec.n));
      pools.set(k, p);
      return p;
    }
    /* 1 + the number scoring strictly above: ties share a rank, and an item
       never counts itself. An out-of-era item is not in the catalogue and
       gets no rank; everything else that passes the gates below is in its
       own pool, so `of` is the pool. */
    function rank(rec, cls, slot, tier) {
      if (!rec || rec.oe || !scorable(rec)) return null;
      const sc = scorer(cls);
      if (!sc.legal(rec) || !canPlace(rec, cls, slot)) return null;
      const p = pool(cls, slot);
      const s = sc.score(rec, tier || 0, 0, slot);
      let lo = 0, hi = p.length;          // first index with score <= s
      while (lo < hi) { const m = (lo + hi) >> 1; if (p[m].s > s) lo = m + 1; else hi = m; }
      return { rank: lo + 1, of: p.length, score: s,
               better: p.slice(0, Math.min(lo, 3)).map((e) => e.rec) };
    }
    /* Every (class, slot) the item can be ranked in, best first. */
    function best(rec, o) {
      const opt = o || {};
      const cls = classesOf(rec);
      const universe = cls === null ? CLASSES : cls;
      const all = [];
      for (const c of universe) for (const slot of realSlots(rec)) {
        const r = rank(rec, c, slot, 0);
        if (r) all.push({ cls: c, slot, rank: r.rank, of: r.of, score: r.score });
      }
      const own = opt.classes || [];
      /* best = lowest rank; a tie goes to one of the caller's own classes,
         then to the bigger pool (a 4th of 212 says more than a 4th of 9). */
      all.sort((a, b) => a.rank - b.rank
        || (own.includes(b.cls) - own.includes(a.cls))
        || b.of - a.of
        || CLASSES.indexOf(a.cls) - CLASSES.indexOf(b.cls));
      /* A one-hander fits both hands, and the off-hand pool is the smaller
         one (no two-handers, no damaging weapons for classes without Dual
         Wield), so its Secondary rank is the lower NUMBER almost by
         construction. The headline is where it is swung: Primary, when the
         item has one. Secondary stays in `all`, and is the headline for a
         shield or anything else that is Secondary-only. */
      const slots = realSlots(rec);
      const head = slots.includes("Primary") && slots.includes("Secondary")
        ? all.filter((x) => x.slot !== "Secondary") : all;
      return {
        best: head[0] || all[0] || null, all,
        trio: all.filter((x) => own.includes(x.cls)),
        anyClass: cls === null,
      };
    }
    return { pool, rank, best, scorer, classesOf, level };
  }

  /* ── merges ──────────────────────────────────────────────────────────── */
  const expOfTier = (t) => Math.pow(2, t) - 1;         // total exp a tier needs
  const donation = (t) => Math.pow(2, t);              // what a tier-t duplicate gives
  /* Merge every donor into the host. The host's exp within its tier is
     unknown, so `exp` and `tier` are floors. */
  function mergeLanding(hostTier, donorTiers) {
    let exp = expOfTier(hostTier);
    for (const t of donorTiers) exp += donation(t);
    let tier = hostTier;
    while (tier < MAX_TIER && exp >= expOfTier(tier + 1)) tier++;
    const nextCost = tier < MAX_TIER ? expOfTier(tier + 1) - expOfTier(tier) : 0;
    return {
      exp, tier, rises: tier > hostTier,
      // progress toward the tier after `tier`, from `tier`'s own threshold
      toward: tier < MAX_TIER ? exp - expOfTier(tier) : 0, nextCost,
    };
  }

  /* ── copies ──────────────────────────────────────────────────────────── */
  const ORNAMENT_RX = /\(Ornamentation\)\*?$/;
  /* rows: any parse of the dump where each row carries
       loc, name, itemId, count, tier, exalt, and either `base` or a name the
       host strips through GS.baseName.
     opts.isContainer(row) — the host knows (a tooltip "Capacity:" line, a
       row with positional children); default: nothing is a container.
     opts.isGear(row)      — can it carry an upgrade tier (a gear record, a
       "Slot:" line, a +N on any copy); default: everything can.
     opts.isWorn(loc)      — default: gear-score's WORN_RX on the root, a
       socket is never worn.
     Returns Map(row -> group) for every row that is one of 2+ copies, where
     group = { id, base, rows, total, stack, cap, slotsMin, saves, host,
               donors, wornPair, gear, landing }. */
  function copies(rows, opts) {
    const o = opts || {};
    const isContainer = o.isContainer || (() => false);
    const isGear = o.isGear || (() => true);
    const isWorn = o.isWorn || ((loc) => !/-Slot\d+$/.test(loc) && GS.WORN_RX.test(GS.rootLoc(loc)));
    const groups = new Map();
    for (const r of rows || []) {
      if (!r || r.exalt || ORNAMENT_RX.test(r.name || "")) continue;
      if (isContainer(r)) continue;
      const base = r.base != null ? r.base : GS.baseName(r.name).base;
      const id = r.itemId ? "id:" + r.itemId : "n:" + String(base).toLowerCase();
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { id, base, rows: [] }));
      g.rows.push(r);
    }
    const out = new Map();
    for (const g of groups.values()) {
      if (g.rows.length < 2) continue;
      const worn = (r) => isWorn(r.loc);
      /* host first: the highest tier — a +9 in a bag takes the worn +5, not
         the other way round — then the worn copy, then dump order */
      g.rows.sort((a, b) => ((b.tier || 0) - (a.tier || 0)) || (worn(b) - worn(a)));
      g.total = g.rows.reduce((n, r) => n + (r.count || 1), 0);
      g.cap = Math.max(...g.rows.map((r) => r.count || 1));
      g.stack = g.cap > 1;
      g.wornRows = g.rows.filter(worn);
      g.host = g.rows[0];
      /* a worn copy other than the host is not a donor when the host is worn
         too (both Ears, both Fingers — merging them costs the slot); a worn
         copy IS a donor when the host is the better one in a bag, which is the
         "merge what you are wearing into it and wear that" case */
      g.donors = g.rows.slice(1).filter((r) => !(worn(r) && worn(g.host)));
      g.wornPair = g.wornRows.length >= 2 && g.donors.length === 0;
      g.gear = g.rows.some(isGear);
      if (g.stack) {
        g.slotsMin = Math.ceil(g.total / g.cap);
        g.saves = Math.max(0, g.rows.length - g.slotsMin);
        g.landing = null;
      } else if (!g.gear) {
        // nothing to merge into; whether it stacks is not the dump's to say
        g.slotsMin = g.rows.length;
        g.saves = 0;
        g.landing = null;
      } else {
        g.slotsMin = 1;
        g.saves = g.donors.length;
        g.landing = g.donors.length
          ? mergeLanding(g.host.tier || 0, g.donors.map((r) => r.tier || 0)) : null;
      }
      for (const r of g.rows) out.set(r, g);
    }
    return out;
  }

  /* ── exaltations nobody else holds ───────────────────────────────────── */
  /* exalt: EQLExaltCore.readDump() — { worn, loose, sources }. Every source
     row with a filled socket gets an entry:
       Map(sourceRow -> { stones: [{ type, effect, stone, id, unique,
                                    elsewhere:[{row, how}], maybe:[row], again:[row] }],
                          unique: n })
     how: "socketed" (in another item) | "loose" (in the Augmentation bin or a
     bag); `again` lists other copies of the source item at the yielding tier. */
  function uniqueExaltations(exalt) {
    const out = new Map();
    if (!exalt) return out;
    const idOf = (st, type) => st.stone ? st.stone.id : `${st.key || String(st.row.base).toLowerCase()}|${type}|?`;
    // every definite stone, where it is
    const have = new Map();   // id -> [{row, how, host}]
    const put = (id, e) => { (have.get(id) || have.set(id, []).get(id)).push(e); };
    for (const src of exalt.sources) for (const type of Object.keys(src.sockets)) {
      const sk = src.sockets[type];
      if (sk.filled) put(idOf(sk.stone, type), { row: sk.stone.row, how: "socketed", host: src.row });
    }
    const maybe = new Map();  // id -> [loose rows that might be it]
    for (const l of exalt.loose) {
      const ys = l.yields.filter((y) => y.type);
      if (ys.length === 1) put(ys[0].id, { row: l.row, how: "loose", host: null });
      else for (const y of ys) (maybe.get(y.id) || maybe.set(y.id, []).get(y.id)).push(l.row);
      if (!ys.length && l.key) put(`${l.key}|?|?`, { row: l.row, how: "loose", host: null });
    }
    // another copy of the source item that has reached the yielding tier
    const byKey = new Map();
    for (const src of exalt.sources) if (src.key) (byKey.get(src.key) || byKey.set(src.key, []).get(src.key)).push(src);

    for (const src of exalt.sources) {
      const stones = [];
      for (const type of Object.keys(src.sockets)) {
        const sk = src.sockets[type];
        if (!sk.filled) continue;
        const st = sk.stone, id = idOf(st, type);
        const elsewhere = (have.get(id) || []).filter((e) => e.row !== st.row);
        /* another copy of the source item that could still yield this effect:
           at the tier, and its socket of this type neither printed Empty
           (pulled out) nor holding a stone — its own stone is already counted
           in `elsewhere`, another item's means its own was pulled and replaced.
           A copy whose sockets the dump does not print (a storage-bin row)
           may still have it. */
        const again = st.key ? (byKey.get(st.key) || []).filter((s) => {
          if (s.row === src.row || !s.yields.some((y) => y.id === id && s.tier >= y.at)) return false;
          const o = s.sockets[type];
          return !(o && (o.empty || o.filled));
        }) : [];
        stones.push({
          type, stone: st, id,
          effect: st.stone ? st.stone.effect : null,
          own: st.key && st.key === src.key,        // the item's own effect, still in it
          elsewhere, maybe: (maybe.get(id) || []).slice(), again: again.map((s) => s.row),
          unique: !elsewhere.length && !again.length,
        });
      }
      if (stones.length) out.set(src.row, { stones, unique: stones.filter((s) => s.unique).length });
    }
    return out;
  }

  window.EQLInventory = {
    makeRanker, classesOf, scorable, realSlots,
    copies, mergeLanding, expOfTier, donation,
    uniqueExaltations,
  };
})();
