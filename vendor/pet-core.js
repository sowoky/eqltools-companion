/* DO NOT EDIT — generated copy of public/valet/pet-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Pet valet — the measurement layer for dressing the pet, shared by /valet
   and the companion app the way valet-core.js is. DOM-free, no state.

   The player is dressed FIRST; the pet considers only rows the player's plan
   did not take (Kyle's rule, 2026-08-30). Exaltations are not considered for
   the pet yet.

   What this file knows about pets it knows from the 2026-08 corpus study
   (workflow receipts in the session journal; the durable summary is
   docs/tools/valet.md §Pet):

   - The pet inventory holds 4 + per-owner-class-bonus items (pet-data.json
     `slots`; player consensus, cross-checked against six reported loadouts,
     never contradicted). The PET's own classes add nothing to the count.
   - Each item auto-equips into a player-style equipment slot, ONE of each —
     no second chest, no Any slots. First cell is the primary hand, second
     the secondary.
   - Legality is the union: anything usable by the owner's three classes OR
     the pet's own two (consensus, no dev post). The item's level requirement
     gates against the PET's level (dev). There is no worn-legality escape
     here — the walk's rule exists because the game proved the wiki wrong by
     equipping the PLAYER; nothing proves it for the pet.
   - Lore-Equip is per-holder: one copy on you AND one on the pet is legal
     (eldarmark, 2026-08). The pet itself still holds at most one.
   - What measurably works on a pet: +HP and +mana items, HP/mana regen,
     worn haste (to a LOW level-scaled cap), single-target weapon procs
     (gated by the pet's BASE level, firing even when the weapon is ignored
     for damage), shield AC for bash. STR is small (+6 ATK per 10), AGI tiny
     (+1 AC per 10). STA/WIS/INT/CHA do NOTHING — a pet's pools do not come
     from stats. Focus effects are dead. AE procs never fire.
   - Weapons are conditional: a weapon only beats the pet's own swing when
     its damage/ratio clears the pet's innate (rule of thumb at 50: a 1H
     needs ~40+ damage), and a weak weapon LOSES the pet-spell damage bonus.
     The dev said the model is being rewritten (2026-08-22 roundtable), so
     weapons here are ranked as proc/stat sticks first and the copy says why.

   Requires: window.EQLGearScore, window.EQLTier. */
(function () {
  "use strict";
  const GS = window.EQLGearScore;
  const statAt = window.EQLTier.statAt, statsAt = window.EQLTier.statsAt;

  /* The slots a pet is known to fill. Range, Ammo, Charm and Power Source are
     left out: no corpus statement, window, or patch note shows a pet using
     any of them, and a slot the game may refuse would strand a real
     recommendation. Ear/Wrist/Fingers are NOT paired — "One of each slot"
     (demonspawn_, 2026-08-26). */
  const PET_SLOTS = ["Head", "Face", "Ear", "Neck", "Shoulders", "Arms", "Back",
    "Wrist", "Hands", "Chest", "Legs", "Feet", "Waist", "Fingers"];

  /* AE procs never fire from a summoned pet (theflammhammer/alebrije_xiote,
     2026-08). The catalogue's own effects map says which procs are AE
     (`effects[name].tgt` carries "AE" — 19 item records today); the list here
     is only the fallback for records the map is missing. */
  const AE_PROCS = ["Earthquake"];
  const isAE = (name, effects) => {
    const fx = effects && effects[name];
    if (fx && fx.tgt) return /AE/i.test(fx.tgt);
    return AE_PROCS.includes(name);
  };

  function slots(PD, trio) {
    const parts = [{ label: "base", n: PD.slots.base }];
    let count = PD.slots.base;
    for (const c of trio) {
      const b = PD.slots.bonus[c];
      if (b) { parts.push({ label: c, n: b }); count += b; }
    }
    return { count, parts };
  }

  const linesFor = (PD, trio) =>
    PD.lines.filter((l) => trio.some((c) => l.owners[c]));

  /* The pet a given summon produces: the highest tier the owner's level has
     learned, plus the spell's rank, capped at owner level − 1 but never
     below the tier's own base (a freshly learned pet is not summoned weaker
     than its spell). */
  function petAt(PD, lineKey, trio, ownerLevel, rank) {
    const line = PD.lines.find((l) => l.key === lineKey);
    if (!line) return null;
    const owner = trio.find((c) => line.owners[c]);
    if (!owner) return null;
    const ladder = line.owners[owner];
    let tier = null;
    for (const t of ladder) if (t.o <= ownerLevel) tier = t;
    if (!tier) return null;
    const level = Math.max(tier.b, Math.min(tier.b + (rank || 0), ownerLevel - 1));
    return { line, owner, cls: line.cls, tier, base: tier.b, level, rank: rank || 0 };
  }

  /* Trio classes whose pet-haste buff caps the pet without a worn item. */
  const hasteBuffOf = (PD, trio) => {
    let best = null;
    for (const c of trio) {
      const h = PD.petHaste[c];
      if (h && (!best || h.pct > best.pct)) best = Object.assign({ cls: c }, h);
    }
    return best;
  };

  /* ── the pet scorer ──────────────────────────────────────────────────────
     Not the player scorer, on purpose: the player model converts STA to HP
     and INT/WIS to mana through the trio's pools, and a pet has neither
     conversion — its measured levers are the item's own +HP/+mana, small
     STR/AGI, haste and procs. Weights are HP-equivalents like everywhere
     else; the receipts are the 50-hour parse (broken_stoic 2026-08-07) and
     the codex cross-check. Fixed in v1 — a slider panel over five mostly-
     dead stats would be knobs for the sake of knobs. */
  function petScorer(petCls, opts) {
    const second = (petCls || []).find((c) => c !== "WAR") || null;
    const w = {
      hp: 1,
      /* Mana feeds what the pet casts. A WIZ-half nukes, the hybrid halves
         (SHD lifetaps, PAL heals, BST/RNG utility) sip, a ROG/MNK/WAR-only
         pet's bar feeds nothing. */
      mana: second === "WIZ" ? 0.5
        : ["SHD", "PAL", "BST", "RNG"].includes(second) ? 0.25 : 0,
      str: 0.6,   // 10 STR → +6 ATK on the pet window; effect shows vs armored targets
      agi: 0.1,   // 10 AGI → +1 AC
      ac: 0.3,    // the sheet moves; the endgame damage effect is unmeasured
      dex: 0.1,   // untested on pets
      sv: 0.1,    // unmeasured on pets
      /* Worn haste is real but capped low, and a trio pet-haste buff reaches
         most of that cap on its own — with one in the trio, item haste on the
         pet is dead weight and must not buy a slot (the first build credited a
         41% haste wrist 82 points a Beastlord's Yekan's had already spent). */
      haste: opts && opts.hasteCovered ? 0 : 2,
      sta: 0, wis: 0, int: 0, cha: 0, end: 0, atk: 0,
    };
    function score(rec, tier) {
      if (!rec) return 0;
      let sum = 0;
      const st = statsAt(rec, tier);
      for (const k in st) sum += (w[k] || 0) * st[k];
      for (const k in rec.sv || {}) if (k !== "v") sum += w.sv * rec.sv[k];
      if (rec.haste) sum += w.haste * rec.haste;
      return sum;
    }
    return { w, score };
  }

  /* Legality for the pet: union of the owner's trio and the pet's own pair,
     level-gated by the PET's level. */
  function petLegal(rec, allCls, petLevel) {
    if (!rec) return false;
    if (rec.req && rec.req > petLevel) return false;
    const c = rec.cls;
    if (!c) return true;
    if (c.none) return false;
    if (c.all) return !c.x || allCls.some((cl) => !c.x.includes(cl));
    return allCls.some((cl) => (c.c || []).includes(cl));
  }

  /* The weapon's proc, if the pet can fire it: a combat effect whose own
     level requirement the pet's BASE level meets (mote levels don't count —
     sebelious_seb/sepptb, 2026-08). AE procs never fire. */
  function procOf(rec, petBase, effects) {
    for (const e of rec.eff || []) {
      if (e.m !== "combat") continue;
      if (isAE(e.n, effects)) return { n: e.n, ae: true };
      return { n: e.n, ok: !e.l || e.l <= petBase, l: e.l || 0 };
    }
    return null;
  }

  /* ── dressing the pet ────────────────────────────────────────────────────
     dressPet({ rows, taken, trio, pet, PD })
       rows  – readInventory().rows
       taken – Set of row indexes the PLAYER's plan holds (picks + kept)
       trio  – the owner's three class codes
       pet   – petAt() result
       PD    – pet-data.json

     Returns { picks, notes, hasteBuff, weight, weightCap, slotMath, pool }.
     Each pick: { slot, row, score, kind: weapon|haste|fill, chips[] }.

     Order of decisions is Kyle's: weapons, haste, then the best of what is
     left — except the haste slot is only spent when no trio class carries a
     pet-haste buff, because the buff reaches most of the pet's low haste cap
     on its own (whether a worn item stacks on top at all is disputed in the
     corpus; the headroom is small either way). */
  function dressPet(o) {
    const PD = o.PD, pet = o.pet, trio = o.trio;
    const allCls = Array.from(new Set(trio.concat(pet.cls)));
    const cap = slots(PD, trio);
    const buff = hasteBuffOf(PD, trio);
    const psc = petScorer(pet.cls, { hasteCovered: !!buff });
    const notes = [];

    const usable = (r) => r.rec && !r.exalt && !o.taken.has(r.i)
      && petLegal(r.rec, allCls, pet.level);
    const pool = o.rows.filter(usable);

    /* One physical copy fills one cell; LORE is per-holder, so the pet's own
       lore set starts empty — a lore ring on you AND in the pet tab is legal,
       two in the pet tab is not. */
    const petLore = new Set();
    const takenRows = new Set();
    const free = new Set(PET_SLOTS);
    const picks = [];
    const loreOk = (r) => !(r.key && (r.rec.fl || []).includes("lore") && petLore.has(r.key));
    const place = (slot, row, score, kind, chips) => {
      picks.push({ slot, row, score, kind, chips: chips || [] });
      takenRows.add(row.i);
      free.delete(slot);
      if (row.key && (row.rec.fl || []).includes("lore")) petLore.add(row.key);
    };

    /* Weapons first. Ranked as what they measurably are for a pet: a proc it
       can fire, then the stats on the stick, then the ratio (the conditional
       damage case, chipped rather than scored — the innate threshold is
       contested and the dev is rewriting the model).

       EMPTY HANDS ARE A REAL ANSWER. A weak weapon costs the pet its
       spell-rank damage bonus ("200 dps without weapons, 70-90 with"), so a
       hand is only filled by a weapon that earns the cell: a proc the pet can
       fire, stats the scorer prices, or damage clearing the ~40 bar. Nothing
       qualifying → the hand stays empty and a note says why. */
    const FX = o.effects || null;
    const wepRank = (a, b) => {
      const pa = procOf(a.rec, pet.base, FX), pb = procOf(b.rec, pet.base, FX);
      const fa = pa && pa.ok ? 1 : 0, fb = pb && pb.ok ? 1 : 0;
      if (fa !== fb) return fb - fa;
      const sa = psc.score(a.rec, a.tier), sb = psc.score(b.rec, b.tier);
      if (sa !== sb) return sb - sa;
      return statAt(b.rec.dmg || 0, b.tier) / (b.rec.dly || 30)
        - statAt(a.rec.dmg || 0, a.tier) / (a.rec.dly || 30);
    };
    const wepWorth = (r) => {
      const p = procOf(r.rec, pet.base, FX);
      if (p && p.ok && !p.ae) return true;
      if (psc.score(r.rec, r.tier) > 0) return true;
      return statAt(r.rec.dmg || 0, r.tier) >= 40;
    };
    const wepChips = (r) => {
      const out = [];
      const p = procOf(r.rec, pet.base, FX);
      if (p && p.ae) out.push({ k: "ae", n: p.n });
      else if (p && p.ok) out.push({ k: "proc", n: p.n });
      else if (p) out.push({ k: "proclvl", n: p.n, l: p.l });
      if (r.rec.dmg && statAt(r.rec.dmg, r.tier) >= 40 && !GS.TWO_H(r.rec)) out.push({ k: "hits" });
      if (GS.TWO_H(r.rec)) out.push({ k: "twoh" });
      return out;
    };
    const prims = pool.filter((r) => !takenRows.has(r.i) && loreOk(r)
      && (r.rec.sl || []).includes("Primary") && r.rec.dmg && wepWorth(r)).sort(wepRank);
    if (prims.length) place("Primary", prims[0], psc.score(prims[0].rec, prims[0].tier), "weapon", wepChips(prims[0]));
    else notes.push({ k: "nowep" });
    const mainIs2H = picks.length && picks[0].slot === "Primary" && GS.TWO_H(picks[0].row.rec);
    if (mainIs2H) {
      /* Dev, 2026-08-18: a pet holding a two-hander refuses secondary-only
         items — so the tool does not offer the off hand either. */
      notes.push({ k: "twoh" });
    } else {
      /* A shield is a real off-hand pick — its AC raises the pet's bash
         damage (broken_stoic's parse) — so the off hand is not gated on
         dmg the way the main hand is; it still has to earn the cell. */
      const secs = pool.filter((r) => !takenRows.has(r.i) && loreOk(r)
        && (r.rec.sl || []).includes("Secondary") && !GS.TWO_H(r.rec) && wepWorth(r)).sort(wepRank);
      if (secs.length) {
        const r = secs[0], chips = wepChips(r);
        if (!r.rec.dmg && r.rec.st && r.rec.st.ac) chips.push({ k: "bash" });
        place("Secondary", r, psc.score(r.rec, r.tier), "weapon", chips);
      }
    }

    /* The haste slot. */
    if (buff) {
      notes.push({ k: "hasteBuff", buff });
    } else {
      const hastes = pool.filter((r) => !takenRows.has(r.i) && loreOk(r) && r.rec.haste
        && (r.rec.sl || []).some((s) => free.has(s)))
        .sort((a, b) => b.rec.haste - a.rec.haste || psc.score(b.rec, b.tier) - psc.score(a.rec, a.tier));
      if (hastes.length) {
        const r = hastes[0];
        const slot = (r.rec.sl || []).find((s) => free.has(s));
        place(slot, r, psc.score(r.rec, r.tier), "haste", [{ k: "haste", n: r.rec.haste }]);
      }
    }

    /* Fill what is left, best first, one item per slot type, up to the cell
       count. Assignment is score-descending with augmenting paths (Kuhn):
       when a better item's slots are all taken, an occupant that can move to
       another of ITS slots moves — so a Head-or-Neck ring never evicts a
       Head-only helm from the table by taking Head. */
    const fillPool = pool.filter((r) => !takenRows.has(r.i)
      && (r.rec.sl || []).some((s) => PET_SLOTS.includes(s)))
      .map((r) => ({ r, score: psc.score(r.rec, r.tier) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || b.r.tier - a.r.tier);
    const heldBy = {};                       // slot -> fill candidate
    const slotsOf = (c) => (c.r.rec.sl || []).filter((s) => free.has(s) || heldBy[s]);
    function augment(c, seen) {
      for (const s of slotsOf(c)) {
        if (seen.has(s)) continue;
        seen.add(s);
        if (!heldBy[s] || augment(heldBy[s], seen)) { heldBy[s] = c; return true; }
      }
      return false;
    }
    const seenLore = new Set(petLore);
    for (const c of fillPool) {
      if (Object.keys(heldBy).length >= cap.count - picks.length) break;
      const isLore = c.r.key && (c.r.rec.fl || []).includes("lore");
      if (isLore && seenLore.has(c.r.key)) continue;
      if (augment(c, new Set()) && isLore) seenLore.add(c.r.key);
    }
    for (const s in heldBy) place(s, heldBy[s].r, heldBy[s].score, "fill");

    /* The pet wears what it wears; weight only matters to the monk-classed
       air pet (~18 before its AC penalty — riptoes, 2026-08-03). */
    let weight = 0;
    for (const p of picks) weight += (p.row.rec.wt || 0);
    const weightCap = pet.cls.includes("MNK") ? 18 : null;

    const order = ["Primary", "Secondary"].concat(PET_SLOTS);
    picks.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
    return {
      picks, notes, pool: pool.length,
      weight: Math.round(weight * 10) / 10, weightCap,
      slotMath: cap, allCls,
    };
  }

  /* Stat sums for the picks, restricted to what does something for a pet, so
     the table never advertises dead INT. */
  function petStats(picks) {
    const st = {};
    let haste = 0;
    for (const p of picks) {
      const s = statsAt(p.row.rec, p.row.tier);
      for (const k of ["hp", "mana", "ac", "str", "agi", "dex"]) if (s[k]) st[k] = (st[k] || 0) + s[k];
      if (p.row.rec.haste) haste = Math.max(haste, p.row.rec.haste);
    }
    return { st, haste };
  }

  window.EQLPetCore = {
    PET_SLOTS, slots, linesFor, petAt, hasteBuffOf, petScorer, petLegal,
    procOf, dressPet, petStats,
  };
})();
