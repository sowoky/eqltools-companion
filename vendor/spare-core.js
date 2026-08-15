/* DO NOT EDIT — generated copy of public/_shared/spare-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Spare — "which of the things I own does nobody need any more".

   The third question about one `/outputfile inventory` dump. /gear asks what to
   go kill for (corpus: the whole wiki catalogue). /valet asks what to put on
   (corpus: what you own, one slot at a time). This asks what you can stop
   carrying, over the same owned corpus, and it is the only one of the three
   that answers for ALL SIXTEEN CLASSES rather than for your trio — the reason
   to keep a beaten item is almost always that somebody else can still use it.

   DOM-free, no state of its own, shared by the site and the companion app —
   same contract as gear-score.js, tier.js and valet-core.js. Edit here; never
   fork.

   ── the rule ────────────────────────────────────────────────────────────────
   Kyle stated it as a trump relation (2026-08-14):

     "an item usable by many classes can trump an item usable by a subset of
      those classes … an item used by a set of classes can't trump an item which
      can be used by classes not in that set"

   What is implemented is the per-class form of exactly that, because the
   pairwise form misses the case where two items between them cover a third.
   An item is beaten in a NICHE — one (class, slot) pair — when other things you
   own are better there for that class. It is spare only when every one of its
   niches is full, and a niche is full when the number of items ahead of it
   reaches the number of positions the slot has (Ear, Wrist, Fingers and Any
   Slot hold two, so second-best is still worn).

   Both of Kyle's rules fall out of that and are not coded separately:
     - an item usable by more classes competes in more niches, so it beats more;
     - an item whose classes are a subset can never empty the niches belonging
       to the classes it does not cover, so it can never trump on its own.

   Race, deity and level requirement are gated the same way as class, pairwise:
   a Human-only ring does not obsolete an any-race ring, because the character
   holding the niche may not be Human.

   ── the fair comparison ─────────────────────────────────────────────────────
   Kyle: "it is not fair to compare an item if its level is lower. However, if
   the current items ahead of it are at equal or lower item level, then it's
   fair … you must scale the item to be considered up to the same level as the
   currently better items … we must indicate though that it requires upgrades to
   equal parity."

   So every pair is compared at max(tier(mine), tier(theirs)): the challenger is
   scaled UP to the rival's upgrade rank, the rival is never scaled down. Two
   counts come out of it and both are reported, because they answer different
   questions:

     ahead      — at parity. The fair number, and the sort key.
     aheadAsIs  — at the tiers the items are actually at. Today's truth.

   An item that survives only at parity is not junk and is not ready either; it
   carries `upgradeTo`, the rank it has to reach before the parity verdict is
   real. Scaling is monotone (statAt never decreases with rank and weights are
   never negative), so aheadAsIs >= ahead always, and the score-sorted scan can
   stop early — no rival below a challenger's UNSCALED score can beat it at any
   rank.

   ── what the scorer cannot see, and why that is stated on the item ──────────
   gear-score prices stats, resists, AC, haste and weapon ratio. It has no term
   for a click, a proc, a worn effect or a bard's song resonance. On the first
   run of this file against the reference dump, the two most-beaten items in the
   whole inventory were Kelin's Seven Stringed Lute and the Efreeti War Horn:
   the model had read a bard's instruments as bad jewellery, because everything
   an instrument is for lives in a field it does not price.

   A ranking that cannot see an item's whole point must not quietly recommend
   destroying it. So every item carries `unscored` — the reasons the number
   under it is incomplete (`inst`, `effect`, `charges`) — the verdict stays a
   stat verdict, and the surfaces show the caveat next to the count. 1093 of the
   6888 wiki gear records carry an effect and 42 are instruments, so this is not
   an edge case.

   Exaltation stones are excluded outright (Kyle, 2026-08-14: out of v1) for the
   same reason taken one step further — a stone has essentially nothing BUT the
   unscored part. They go by `row.exalt`, the gate /valet and /sky already use.

   Quest turn-ins, keys and tradeskill components are NOT excluded here — the
   host decorates them (Kyle chose a warning chip over a separate section). The
   core answers the gear question and only the gear question.

   Requires: window.EQLGearScore, window.EQLTier, window.EQLChar. */
(function () {
  "use strict";
  const GS = window.EQLGearScore;
  const statAt = window.EQLTier.statAt;
  const ANY = GS.ANY;
  const ALL_CLASSES = window.EQLChar.CLASSES;

  /* ── who and what can use a thing ────────────────────────────────────────
     gear-data ships a class/race set as one of four shapes. A record with NO
     cls field at all is unrestricted — the wiki page simply had no Class:
     line — and gear-score's legal() already reads it that way. */
  function expandSet(spec, universe) {
    if (!spec) return universe.slice();
    if (spec.none) return [];
    if (spec.all) return spec.x && spec.x.length
      ? universe.filter((c) => !spec.x.includes(c)) : universe.slice();
    return (spec.c || []).filter((c) => universe.includes(c));
  }
  const classesOf = (rec) => expandSet(rec && rec.cls, ALL_CLASSES);

  /* Races are gated as a SUBSET TEST, never enumerated, so the race vocabulary
     never has to be kept in sync with the client. `all` with an exclusion list
     is a superset of any explicit list unless it excludes something that list
     names; two explicit lists compare directly. */
  function raceCovers(a, b) {            // does a's race set contain b's?
    const A = a && a.rc, B = b && b.rc;
    if (!B || B.all) {                   // b is any-race (or unstated)
      if (!A || (A.all && !(A.x || []).length)) return true;
      if (A && A.all) return !(B && B.x) ? false : (A.x || []).every((r) => (B.x || []).includes(r));
      return false;                      // an explicit list can't cover all races
    }
    if (B.none) return true;             // nobody can wear b; anything covers it
    const bl = B.c || [];
    if (!A || (A.all && !(A.x || []).length)) return true;
    if (A.all) return !bl.some((r) => (A.x || []).includes(r));
    return bl.every((r) => (A.c || []).includes(r));
  }
  /* A deity-locked item cannot obsolete an unlocked one. 448 items carry a
     deity line; none of them is a filter anywhere else on the site yet, so this
     stays a coarse "restricted vs not" test rather than a deity set. */
  const deityCovers = (a, b) => !a.deity || !!b.deity;
  const reqCovers = (a, b) => !(a.req || 0) || (a.req || 0) <= (b.req || 0);

  /* ── the niches ──────────────────────────────────────────────────────────
     An item's real slots, plus Any Slot handled separately (see below). Wiki
     records never name Any Slot — it is a placement, not an item property. */
  const slotsOf = (rec) => (rec.sl || []).filter((s) => GS.WORN_SLOTS.includes(s));
  const capOf = (slot) => GS.PAIRED[slot] || 1;

  /* analyze({ rows, level, D, classes, race })
       rows    – EQLValet.readInventory().rows (dump rows with .rec attached)
       level   – the character's level; every class is priced at it
       D       – window.EQL_DATA, for the AC softcaps. Passing null quarters
                 every AC on the board (gear-score's effAC falls back to a zero
                 cap at 0.25×), so hosts must vendor /combat/data.js.
       classes – restrict the analysis to these class codes (default all 16)
       race    – unused for scoring on purpose: every class is priced with no
                 race and nothing already equipped, so a niche's ranking is a
                 fact about the CLASS and does not move when you change a ring.
                 The same anti-circularity rule gear-score's poolSelection got. */
  function analyze(opts) {
    const level = opts.level || 50;
    const D = opts.D || null;
    const universe = (opts.classes && opts.classes.length ? opts.classes : ALL_CLASSES)
      .filter((c) => ALL_CLASSES.includes(c));

    /* One scorer per class, built once. Single-class scoring is the coarse
       instrument gear-score documents at its top — it ranks candidates
       sensibly, it is not a precise per-class model — and that is exactly what
       a niche needs: an ordering, not a number to publish. */
    const scorers = {};
    for (const c of universe) {
      scorers[c] = GS.make({ classes: [c], level, race: null, equipped: null, D });
    }

    /* Every owned copy that is a wearable the wiki knows. A ROW is a physical
       copy: three of the same mask are three rows and the third one is the one
       you can let go of. */
    const items = [];
    for (const r of opts.rows || []) {
      if (r.exalt || !r.rec) continue;
      const sl = slotsOf(r.rec);
      if (!sl.length) continue;
      const cls = classesOf(r.rec).filter((c) => universe.includes(c));
      const unscored = [];
      if (r.rec.inst && r.rec.inst.length) unscored.push("inst");
      if (r.rec.eff && r.rec.eff.length) unscored.push("effect");
      if (r.rec.charges) unscored.push("charges");
      items.push({
        row: r, rec: r.rec, tier: r.tier, i: r.i,
        key: r.key || r.base.toLowerCase(),
        slots: sl, classes: cls, unscored,
        niches: [], ahead: 0, aheadAsIs: 0, spare: true, spareAsIs: true,
        bis: [], best: null, upgradeTo: null,
      });
    }

    /* score(item, class, slot, tier), memoised. The AC base is 0 for every
       candidate rather than the character's worn AC: a niche compares items
       against each other, and pricing both sides at the same softcap position
       is the only thing that matters. Using a real worn total would make the
       answer depend on what the character happens to have on, which is the
       circularity gear-score already had to remove once. */
    const memo = new Map();
    function score(it, cls, slot, tier) {
      const k = it.i + "|" + cls + "|" + slot + "|" + tier;
      let v = memo.get(k);
      if (v === undefined) {
        v = scorers[cls].score(it.rec, tier, 0, slot);
        memo.set(k, v);
      }
      return v;
    }

    /* Can `b` stand in for `a` at all — the pairwise gates that have nothing to
       do with how good either one is. Class is not among them: both items are
       already in the same class's bucket by construction. */
    const covers = (b, a) => raceCovers(b.rec, a.rec)
      && deityCovers(a.rec, b.rec) && reqCovers(a.rec, b.rec);

    /* A TIE IS NOT A REASON TO GET UP. Two different items on the same score
       have not been ranked — the scorer just has nothing to separate them —
       and breaking that tie on dump order would have told you to throw away
       four of your five kinds of arrow, because nothing in the model reads an
       arrow and every quiver in the game scores exactly zero. (/valet already
       refuses to ask about a slot for this reason; its `flat` case.)

       So only a strictly better item is ahead — except between COPIES OF THE
       SAME ITEM, where a tie is real information: you own three of these and
       you need one. Copies rank by upgrade rank first and dump order second,
       so copy #2 has exactly one thing ahead of it and copy #3 has two,
       without a separate duplicate rule that would then have to learn about
       paired slots. */
    const sameItem = (b, a) => b.key && b.key === a.key;
    const beats = (bs, b, as, a) => bs > as
      || (bs === as && sameItem(b, a) && (b.tier > a.tier || (b.tier === a.tier && b.i < a.i)));

    /* How many things are ahead of `a` in one niche, at a stated rank for `a`.
       `bucket` is pre-sorted by unscaled score, descending, so the scan can
       stop as soon as a rival scores BELOW a's unscaled score: scaling only
       ever raises a, so nothing further down can beat it. The equal-score run
       is walked to the end rather than broken out of, because a duplicate of
       `a` sits inside it. */
    function aheadIn(bucket, a, cls, slot, aTier, scale) {
      const floor = score(a, cls, slot, a.tier);
      const list = [];
      for (const b of bucket) {
        if (b === a) continue;
        const bs = score(b, cls, slot, b.tier);
        if (bs < floor) break;
        if (!covers(b, a)) continue;
        const at = scale ? Math.max(aTier, b.tier) : aTier;
        if (beats(bs, b, score(a, cls, slot, at), a)) list.push({ item: b, score: bs, at });
      }
      return list;
    }

    /* Who can hold what in the off hand. A damaging off hand requires Dual
       Wield, which knight, priest and caster classes do not have, and a
       two-hander is never an off hand at all — the same gate /valet applies.
       Without it a Cleric's Secondary niche fills up with every one-hander in
       the bags and the shield sitting in it reads as beaten. */
    const dw = {};
    for (const c of universe) dw[c] = scorers[c].dualWieldCap() > 0;
    const canPlace = (it, cls, slot) => slot !== "Secondary"
      || (!GS.TWO_H(it.rec) && (dw[cls] || !it.rec.dmg));

    /* ── pass 1: the real slots ─────────────────────────────────────────── */
    const buckets = new Map();           // "CLS|Slot" -> items, score-sorted
    for (const c of universe) {
      for (const s of GS.SLOTS) {
        const pool = items.filter((it) => it.classes.includes(c) && it.slots.includes(s)
          && canPlace(it, c, s));
        if (!pool.length) continue;
        pool.sort((x, y) => score(y, c, s, y.tier) - score(x, c, s, x.tier) || x.i - y.i);
        buckets.set(c + "|" + s, pool);
      }
    }
    for (const [key, pool] of buckets) {
      const [c, s] = key.split("|");
      const cap = capOf(s);
      for (const a of pool) {
        const par = aheadIn(pool, a, c, s, a.tier, true);
        const asIs = aheadIn(pool, a, c, s, a.tier, false);
        a.niches.push({ cls: c, slot: s, cap, ahead: par.length, aheadAsIs: asIs.length,
                        by: par.slice(0, 8), byAsIs: asIs.slice(0, 8) });
      }
    }

    /* ── pass 2: Any Slot, over the leftovers ───────────────────────────────
       Any Slot carries no slot restriction, so ranking it as an independent
       slot would hand its two positions to the two best items you own — items
       that are already first pick in a slot of their own and would never
       actually sit there. It is what is LEFT after every dedicated slot is
       filled (Kyle, 2026-08-14: "it's ideal for high stat items, shields, extra
       chest pieces, whatever your best gear is after filling all the other
       slots"), which is also why /valet walks it last.

       So the Any Slot bucket for a class is only the items that hold no
       position in any of their own slots for that class. Scored AS Any Slot:
       a weapon parked there does not swing, and score() drops the ratio term
       for any placement that is not a hand or the range slot. */
    const heldSomewhere = (it, c) => it.niches.some((n) =>
      n.cls === c && n.ahead < n.cap);
    for (const c of universe) {
      const pool = items.filter((it) => it.classes.includes(c) && !heldSomewhere(it, c));
      if (!pool.length) continue;
      pool.sort((x, y) => score(y, c, ANY, y.tier) - score(x, c, ANY, x.tier) || x.i - y.i);
      buckets.set(c + "|" + ANY, pool);
      const cap = capOf(ANY);
      for (const a of pool) {
        const par = aheadIn(pool, a, c, ANY, a.tier, true);
        const asIs = aheadIn(pool, a, c, ANY, a.tier, false);
        a.niches.push({ cls: c, slot: ANY, cap, ahead: par.length, aheadAsIs: asIs.length,
                        by: par.slice(0, 8), byAsIs: asIs.slice(0, 8) });
      }
    }

    /* ── the verdict per item ────────────────────────────────────────────── */
    for (const a of items) {
      if (!a.niches.length) {            // nobody in the analysed class set can wear it
        a.spare = true; a.spareAsIs = true; a.ahead = 0; a.aheadAsIs = 0;
        a.best = null; a.noClass = true;
        continue;
      }
      /* The niche to report is the one where the item comes CLOSEST to being
         worn — most slack first, then fewest ahead. An item is kept if any
         single niche still has room for it. */
      const rank = (n) => [n.cap - n.ahead, -n.ahead];
      a.niches.sort((x, y) => rank(y)[0] - rank(x)[0] || rank(y)[1] - rank(x)[1]);
      const best = a.niches[0];
      a.best = best;
      a.ahead = best.ahead;
      a.aheadAsIs = best.aheadAsIs;
      a.spare = best.ahead >= best.cap;
      a.spareAsIs = a.niches.every((n) => n.aheadAsIs >= n.cap);
      a.bis = [...new Set(a.niches.filter((n) => n.ahead < n.cap).map((n) => n.cls))];
      a.bisAsIs = [...new Set(a.niches.filter((n) => n.aheadAsIs < n.cap).map((n) => n.cls))];

      /* "requires upgrades to equal parity" — the rank this item has to reach
         before the parity verdict above is something you actually own. Only
         meaningful when parity is what saved it (or would save it): search
         upward from its current rank for the first one that empties a niche
         at the items' REAL tiers. */
      if (a.spareAsIs && a.tier < 10) {
        for (let t = a.tier + 1; t <= 10 && a.upgradeTo === null; t++) {
          for (const n of a.niches) {
            const pool = buckets.get(n.cls + "|" + n.slot);
            if (!pool) continue;
            if (aheadIn(pool, a, n.cls, n.slot, t, false).length < n.cap) {
              a.upgradeTo = t; a.upgradeNiche = n; break;
            }
          }
        }
      }
    }

    /* Kyle: "we sort items based on how many items are better than it. most
       items better than it at the top." The count is the one from the item's
       best remaining niche — the most generous reading of its own case. */
    const ranked = items.slice().sort((x, y) =>
      y.ahead - x.ahead
      || (y.niches.reduce((s, n) => s + n.ahead, 0) - x.niches.reduce((s, n) => s + n.ahead, 0))
      || x.i - y.i);

    return {
      items, ranked, universe, level,
      spare: ranked.filter((it) => it.spare),
      /* The stat verdict, split by whether the number under it is the whole
         story. `clean` is beaten on everything the model can read; `caveat` is
         beaten on stats while carrying a click, a proc or a resonance the model
         cannot read at all. A surface that merges these is telling a bard to
         bin their instruments. */
      spareClean: ranked.filter((it) => it.spare && !it.unscored.length),
      spareCaveat: ranked.filter((it) => it.spare && it.unscored.length),
      /* Rows the dump holds that this analysis could not look at, so a host can
         say so instead of quietly shortening the list. */
      skipped: {
        exalt: (opts.rows || []).filter((r) => r.exalt).length,
        unknown: (opts.rows || []).filter((r) => !r.exalt && !r.rec).length,
        notWearable: (opts.rows || []).filter((r) => !r.exalt && r.rec && !slotsOf(r.rec).length).length,
      },
      noSoftcaps: !D,
    };
  }

  window.EQLSpare = {
    ALL_CLASSES, analyze, classesOf, slotsOf, capOf, raceCovers,
  };
})();
