/* DO NOT EDIT — generated copy of public/valet/pet-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Pet valet — the measurement layer for dressing the pet, shared by /valet
   and the companion app the way valet-core.js is. DOM-free, no state.

   The player is dressed FIRST; the pet considers only rows the player's plan
   did not take (Kyle's rule, 2026-08-30). The pet's set is chosen the way the
   player's is — a walk, one step at a time, ranked cards, remembered
   decisions — makePetWalk mirrors valet-core's makeWalk contract so the same
   UI idioms drive both.

   What this file knows about pets it knows from the 2026-08 corpus study
   (durable summary: docs/tools/valet.md §Pet; receipted fact tables in
   pipeline/scripts/build_pet_data.py):

   - The pet inventory holds 4 + per-owner-class-bonus items (pet-data.json
     `slots`). Each item auto-equips into a player-style equipment slot, ONE
     of each — no second chest, no Any slots.
   - Legality is the union: anything usable by the owner's three classes OR
     the pet's own two. The item's level requirement gates against the PET's
     level (dev). Lore-Equip is per-holder: one copy on you AND one on the
     pet is legal; the pet itself still holds at most one.
   - What measurably works on a pet: +HP and +mana items, HP/mana regen,
     worn haste (to a LOW level-scaled cap), single-target weapon procs
     (gated by the pet's BASE level, firing even when the weapon is ignored
     for damage), shield AC for bash. STR is small (+6 ATK per 10), AGI tiny
     (+1 AC per 10). STA/WIS/INT/CHA do NOTHING — a pet's pools do not come
     from stats. Focus effects are dead. AE procs never fire.
   - WEAPONS RANK BY RATIO. A weapon replaces the pet's own swing only when
     it beats the pet's innate (player rule of thumb: a 1H needs ~40+ damage
     at 50; a weaker weapon costs the pet its spell damage bonus), and once
     it swings, damage over delay is the number that moves. Procs are NOT a
     reason to rank one weapon over another: a proc is an exaltation, and an
     exaltation moves to whichever weapon the pet ends up holding — the proc
     is a separate decision, made after the hands (petProcs below). An
     innate proc the pet can fire is stated on the card, not scored.
   - Pets dual wield, and hold two-handers. Dev patch note 2026-06-09
     (brasse): the game equips pet weapons by its own score; "a 1H weapon
     given to a dual wield capable pet that already has a 2H weapon equipped
     will always replace the 2H weapon to allow dual wielding", and a 2H
     replaces a 1H only when the secondary is empty. So the Main hand step
     states the 2H-vs-pair question the way the player's walk does.

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

  /* The pet panel's rows — its own model, so its own list (the player's
     STAT_DEFS carries ratio and trio-derived stats that mean nothing here).
     The dead stats are listed on purpose: seeing WIS at 0 with the receipt
     on hover is the answer to "why doesn't the pet want my caster gear". */
  const PET_STAT_DEFS = [
    ["hp", "HP"], ["mana", "Mana"], ["ac", "AC"],
    ["str", "STR"], ["agi", "AGI"], ["dex", "DEX"],
    ["svf", "SV Fire"], ["svc", "SV Cold"], ["svm", "SV Magic"],
    ["svd", "SV Disease"], ["svp", "SV Poison"],
    ["haste", "Haste (per 1%)"],
    ["sta", "STA"], ["wis", "WIS"], ["int", "INT"], ["cha", "CHA"],
    ["atk", "Attack"], ["end", "Endurance"],
  ];
  const SV_KEYS = ["svf", "svc", "svm", "svd", "svp"];

  /* ── the pet scorer ──────────────────────────────────────────────────────
     Not the player scorer, on purpose: the player model converts STA to HP
     and INT/WIS to mana through the trio's pools, and a pet has neither
     conversion — its measured levers are the item's own +HP/+mana, small
     STR/AGI, haste and procs. Weights are HP-equivalents like everywhere
     else; the receipts are the 50-hour parse (broken_stoic 2026-08-07) and
     the codex cross-check, and each weight's `why` carries its own.
     `opts.overrides` are the pet priorities panel's edits, same contract as
     the player scorer's; `computed` is the model before them. */
  function petScorer(petCls, opts) {
    opts = opts || {};
    const second = (petCls || []).find((c) => c !== "WAR") || null;
    const buff = opts.buff || null;
    const pair = (petCls || []).join("/");
    const w = {}, why = {};
    const parse = `the 50-hour pet parse (broken_stoic, 2026-08-07) and its cross-checks — player measurement, no dev statement`;

    w.hp = 1;
    why.hp = `<h5>HP — the unit</h5><p>Every weight is HP-equivalents: +1 HP on an item is worth exactly 1, and item +HP measurably raises a pet's pool (${parse}).</p>`;
    w.mana = second === "WIZ" ? 0.5
      : ["SHD", "PAL", "BST", "RNG"].includes(second) ? 0.25 : 0;
    why.mana = `<h5>Mana</h5><p>Item +mana feeds what the pet casts, so the weight follows its non-Warrior half: ${
      second === "WIZ" ? `this ${pair} pet's WIZ half nukes — 0.5`
        : ["SHD", "PAL", "BST", "RNG"].includes(second) ? `this ${pair} pet's ${second} half casts a little (lifetaps, heals, utility) — 0.25`
        : `a ${pair} pet casts nothing, so its bar feeds nothing — 0`}. From ${parse}.</p>`;
    w.ac = 0.3;
    why.ac = `<h5>AC</h5><p>The pet window's AC moves with worn AC, and shield AC raises bash damage (${parse}) — but what pet mitigation buys at endgame is unmeasured, so 0.3 is a judgment call, not a rate.</p>`;
    w.str = 0.6;
    why.str = `<h5>STR</h5><p>10 STR reads as +6 ATK on the pet window, and the damage effect shows against armored targets (${parse}). 0.6 per point prices that ATK.</p>`;
    w.agi = 0.1;
    why.agi = `<h5>AGI</h5><p>10 AGI reads as +1 AC on the pet window (${parse}) — a tenth of a small stat.</p>`;
    w.dex = 0.1;
    why.dex = `<h5>DEX</h5><p>Untested on pets. 0.1 is a nudge so a DEX item can break a tie, not a measurement.</p>`;
    for (const k of SV_KEYS) {
      w[k] = 0.1;
      why[k] = `<h5>SV ${k.slice(2).toUpperCase()}</h5><p>Resists are unmeasured on pets — nothing shows whether worn SV reaches a pet's resist table at all. 0.1 is a nudge, not a measurement. SV VOID is never scored.</p>`;
    }
    /* Worn haste is real but capped low, and a trio pet-haste buff reaches
       most of that cap on its own — with one in the trio, item haste on the
       pet is dead weight and must not buy a slot (the first build credited a
       41% haste wrist 82 points a Beastlord's Yekan's had already spent). */
    w.haste = opts.hasteCovered ? 0 : 2;
    why.haste = opts.hasteCovered
      ? `<h5>Haste</h5><p>Zeroed: ${buff ? `${buff.n} (${buff.pct}%) from your ${buff.cls}` : "a pet-haste buff in your trio"} already reaches most of the pet's low, level-scaled haste cap on its own. Whether a worn item stacks on top at all is disputed in the corpus, and the headroom is small either way.</p>`
      : `<h5>Haste</h5><p>Worn haste works on a pet, to a LOW level-scaled cap (~140 total at +1, ~170 at the top — corpus readings). With no pet-haste class in your trio, an item is the only way there — 2 per %.</p>`;
    for (const k of ["sta", "wis", "int", "cha"]) {
      w[k] = 0;
      why[k] = `<h5>${k.toUpperCase()}</h5><p>Does nothing for a pet: its pools do not come from stats (${parse}). Zero — and this is why the pet does not want your caster gear.</p>`;
    }
    w.atk = 0;
    why.atk = `<h5>Attack</h5><p>Worn ATK is unmeasured on pets; STR's +6-per-10 is the only ATK lever the pet window shows. Zero until someone measures it.</p>`;
    w.end = 0;
    why.end = `<h5>Endurance</h5><p>Nothing shows a pet spending endurance. Zero.</p>`;

    const computed = Object.assign({}, w);
    /* Same legacy shape the player scorer accepts: one {sv} spreads to every
       school not set individually. */
    const ov = Object.assign({}, opts.overrides || {});
    if (ov.sv != null) {
      for (const k of SV_KEYS) if (!(k in ov)) ov[k] = ov.sv;
      delete ov.sv;
    }
    Object.assign(w, ov);

    function score(rec, tier) {
      if (!rec) return 0;
      let sum = 0;
      const st = statsAt(rec, tier);
      for (const k in st) sum += (w[k] || 0) * st[k];
      for (const k in rec.sv || {}) if (k !== "v") sum += (w["sv" + k] || 0) * rec.sv[k];
      if (rec.haste) sum += w.haste * rec.haste;
      return sum;
    }
    return { w, computed, why, score };
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

  /* The weapon's own (innate) proc, if it has one: a combat effect whose
     level requirement the pet's BASE level meets (mote levels don't count —
     sebelious_seb/sepptb, 2026-08). AE procs never fire. Stated on the card
     as a fact about the item; never a reason it outranks another weapon. */
  function procOf(rec, petBase, effects) {
    for (const e of rec.eff || []) {
      if (e.m !== "combat") continue;
      if (isAE(e.n, effects)) return { n: e.n, ae: true };
      return { n: e.n, ok: !e.l || e.l <= petBase, l: e.l || 0 };
    }
    return null;
  }

  const ratioOf = (rec, tier) =>
    rec && rec.dmg && rec.dly ? statAt(rec.dmg, tier) / rec.dly : 0;

  // Identity for a remembered decision — item at tier, valet-core's rule.
  const itemId = (row) => (row.key || row.base.toLowerCase()) + "+" + row.tier;

  /* Is this weapon worth a hand at all, for the AUTO-run (overlay, the
     companion's summary): an innate proc the pet can fire, stats the scorer
     prices, or damage near the innate bar. The interactive walk shows
     everything and lets Kyle decide; this gate only keeps the unattended
     plan from equipping junk that costs the pet its spell damage bonus. */
  function wepWorth(r, petBase, effects, psc) {
    const p = procOf(r.rec, petBase, effects);
    if (p && p.ok && !p.ae) return true;
    if (psc.score(r.rec, r.tier) > 0) return true;
    return statAt(r.rec.dmg || 0, r.tier) >= 40;
  }

  /* ── the pet walk ────────────────────────────────────────────────────────
     makePetWalk({ rows, taken, trio, pet, PD, effects, mem })
       rows    – readInventory().rows
       taken   – Set of row indexes the PLAYER's plan holds (picks + kept)
       trio    – the owner's three class codes
       pet     – petAt() result
       PD      – pet-data.json
       effects – gear-data effects map (AE detection)
       mem     – { get(stepKey), set(stepKey, rec), del(stepKey) }; the host
                 scopes keys (per trio AND per summon line). Pass a no-op
                 memory to run without one.

     Same contract as valet-core's makeWalk: steps / i / picks / auto / ctx /
     options() / pick() / skip() / back() / restart() / autoSummary() /
     weaponCompare() / done(). Differences a host must know:

     - Steps are Main hand, Off hand, then ONE STEP PER REMAINING CELL, not
       one per slot type: the pet holds cap.count items across 14 possible
       slots, so each cell offers the best of everything still unplaced,
       each card naming the slot it would fill. Fixed body order would spend
       questions on slots with junk while the cap eats the good ones.
     - There is no "wearing now": the dump cannot see the pet's inventory,
       so no flat state and no deltas — a card's score stands alone.
     - Hands sort by DMG/DLY at the row's tier; everything else by pet score. */
  function makePetWalk(o) {
    const PD = o.PD, pet = o.pet, trio = o.trio;
    const allCls = Array.from(new Set(trio.concat(pet.cls)));
    const cap = slots(PD, trio);
    const buff = hasteBuffOf(PD, trio);
    const psc = petScorer(pet.cls, { hasteCovered: !!buff, buff, overrides: o.overrides });
    const FX = o.effects || null;
    const mem = o.mem || { get: () => null, set: () => {}, del: () => {} };

    const pool = (o.rows || []).filter((r) => r.rec && !r.exalt
      && !o.taken.has(r.i) && petLegal(r.rec, allCls, pet.level));

    const W = { steps: [], i: 0, picks: {}, opts: {}, auto: {}, ctx: {}, skipped: new Set() };

    /* Hands first (Kyle's order), then the leftover cells. A 2H is one item,
       so it costs one cell and the off hand simply cannot be filled. */
    function buildSteps() {
      const steps = [
        { key: "Primary#1", kind: "primary", slot: "Primary", label: "Main hand" },
        { key: "Secondary#1", kind: "secondary", slot: "Secondary", label: "Off hand" },
      ];
      let used = 0;
      for (const k of ["Primary#1", "Secondary#1"]) if (W.picks[k]) used++;
      for (let n = used + 1; n <= cap.count; n++)
        steps.push({ key: "Cell#" + n, kind: "cell", slot: null,
                     label: `Item ${n} of ${cap.count}`, chip: String(n) });
      return steps;
    }

    const isLore = (row) => row.key && (row.rec.fl || []).includes("lore");

    /* Weapon chips: facts about the item, none of them the ranking. */
    function wepChips(r) {
      const out = [];
      const p = procOf(r.rec, pet.base, FX);
      if (p && p.ae) out.push({ k: "ae", n: p.n });
      else if (p && p.ok) out.push({ k: "proc", n: p.n });
      else if (p) out.push({ k: "proclvl", n: p.n, l: p.l });
      if (GS.TWO_H(r.rec)) out.push({ k: "twoh" });
      if (!r.rec.dmg && r.rec.st && r.rec.st.ac) out.push({ k: "bash" });
      return out;
    }

    const mkOpt = (row, slot) => ({
      id: itemId(row) + "@" + slot, items: [{ row, slot }],
      score: psc.score(row.rec, row.tier), ratio: ratioOf(row.rec, row.tier),
      chips: slot === "Primary" || slot === "Secondary" ? wepChips(row) : [],
    });

    /* Two copies of one item at one tier are the same offer; keep one. */
    function dedupe(list) {
      const seen = new Set(), out = [];
      for (const opt of list) {
        if (seen.has(opt.id)) continue;
        seen.add(opt.id); out.push(opt);
      }
      return out;
    }

    /* Hands: damage weapons by ratio, then no-damage items (shields, stat
       sticks) by pet score. The same list a card row and the show-all table
       both read. */
    const handSort = (a, b) => {
      const da = a.items[0].row.rec.dmg ? 1 : 0, db = b.items[0].row.rec.dmg ? 1 : 0;
      if (da !== db) return db - da;
      if (da) return b.ratio - a.ratio || b.score - a.score;
      return b.score - a.score || b.ratio - a.ratio;
    };

    function optionsFor(step, taken, loreTaken, freeSlots) {
      const usable = (r) => !taken.has(r.i) && !(r.key && isLore(r) && loreTaken.has(r.key));
      if (step.kind === "primary") {
        return dedupe(pool.filter((r) => usable(r) && (r.rec.sl || []).includes("Primary"))
          .map((r) => mkOpt(r, "Primary")).sort(handSort));
      }
      if (step.kind === "secondary") {
        return dedupe(pool.filter((r) => usable(r) && (r.rec.sl || []).includes("Secondary")
          && !GS.TWO_H(r.rec)).map((r) => mkOpt(r, "Secondary")).sort(handSort));
      }
      /* A cell: the best of everything still unplaced, across every free pet
         slot. The slot on the option is provisional — pickSlot() settles it
         when the item is taken. Zero-score rows are not offered: with no
         "wearing now" to keep, a card the scorer cannot price is a coin
         flip wearing a rank. */
      const list = [];
      for (const r of pool) {
        if (!usable(r)) continue;
        const fits = (r.rec.sl || []).filter((s) => freeSlots.has(s));
        if (!fits.length) continue;
        const opt = mkOpt(r, fits[0]);
        if (opt.score <= 0) continue;
        opt.slots = fits;
        opt.id = itemId(r);          // one offer per item, whichever slot
        list.push(opt);
      }
      return dedupe(list.sort((a, b) => b.score - a.score || b.items[0].row.tier - a.items[0].row.tier));
    }

    /* When a flexible item is taken, give it the free slot that blocks the
       least: the one whose best remaining alternative is weakest. */
    function pickSlot(opt, taken, loreTaken, freeSlots) {
      const fits = (opt.slots || [opt.items[0].slot]).filter((s) => freeSlots.has(s));
      if (fits.length <= 1) return fits[0] || opt.items[0].slot;
      let best = fits[0], bestRival = Infinity;
      for (const s of fits) {
        let rival = 0;
        for (const r of pool) {
          if (taken.has(r.i) || r === opt.items[0].row) continue;
          if (r.key && isLore(r) && loreTaken.has(r.key)) continue;
          if (!(r.rec.sl || []).includes(s)) continue;
          rival = Math.max(rival, psc.score(r.rec, r.tier));
        }
        if (rival < bestRival) { bestRival = rival; best = s; }
      }
      return best;
    }

    /* Remembered decisions — valet-core's floor rule, verbatim: the pick, the
       four ids it beat, the fourth one's score. Reopens when the field moves. */
    function remember(stepKey, list, pick) {
      const top = list.slice(0, 4);
      mem.set(stepKey, { pick: pick.id, set: top.map((x) => x.id),
                         floor: top.length ? top[top.length - 1].score : 0 });
    }
    function memApply(stepKey, list) {
      const m = mem.get(stepKey);
      if (!m) return null;
      const pick = list.find((x) => x.id === m.pick);
      if (!pick) return null;
      const set = new Set(m.set);
      return list.some((x) => !set.has(x.id) && x.score > m.floor) ? null : pick;
    }

    /* The 2H-vs-pair question for the Main hand step, in combined ratio: a
       2H's ratio is its hands total; a 1H carries the best off-hand WEAPON
       still free behind it and the two ratios add. (Both hands swing on
       their own delay — the off hand's exact share of a pet's swings is
       unmeasured, so the sum is the honest upper line, and it is the same
       arithmetic on both sides.) */
    function weaponCompare(taken, loreTaken) {
      const prim = optionsFor({ kind: "primary" }, taken, loreTaken, null);
      const twoH = prim.filter((x) => GS.TWO_H(x.items[0].row.rec));
      const pairs = [];
      for (const p of prim) {
        const row = p.items[0].row;
        if (GS.TWO_H(row.rec)) continue;
        if (!row.rec.dmg) continue;
        const after = new Set(taken); after.add(row.i);
        const lore2 = new Set(loreTaken); if (isLore(row)) lore2.add(row.key);
        const secs = optionsFor({ kind: "secondary" }, after, lore2, null);
        const off = secs.length ? secs[0] : null;
        pairs.push({ opt: p, main: row, partner: off ? off.items[0].row : null,
                     partnerOpt: off, total: p.ratio + (off ? off.ratio : 0),
                     offCount: secs.length });
      }
      pairs.sort((a, b) => b.total - a.total || b.opt.ratio - a.opt.ratio);
      return { best2H: twoH[0] || null, bestPair: pairs[0] || null, twoH, pairs };
    }

    /* Same contract as valet-core's advance: picks SURVIVE a change to an
       earlier step while the item is still available — editing one cell must
       not re-ask the rest — and `stopAt` forces that step open (a forward
       jump leaves earlier open steps for the way back; the forced step's own
       settling is bypassed, because you came to change it). */
    function advance(stopAt) {
      W.steps = buildSteps();
      const taken = new Set(), loreTaken = new Set();
      const freeSlots = new Set(PET_SLOTS);
      W.opts = {}; W.auto = {}; W.ctx = {};
      let stop = -1;
      for (let i = 0; i < W.steps.length; i++) {
        const st = W.steps[i];
        const forced = i === stopAt;
        const list = optionsFor(st, taken, loreTaken, freeSlots);
        W.opts[st.key] = list;
        W.ctx[st.key] = { taken: new Set(taken), lore: new Set(loreTaken), free: new Set(freeSlots) };

        let chosen = W.picks[st.key] || null;
        if (chosen && !list.some((x) => x.id === chosen.id)) chosen = null;
        const mainPick = W.picks["Primary#1"];
        if (st.kind === "secondary" && mainPick && GS.TWO_H(mainPick.items[0].row.rec)) {
          W.auto[st.key] = "twoh";
          W.picks[st.key] = null;
          continue;
        }
        if (!chosen && !forced) {
          if (!list.length) W.auto[st.key] = "none";
          else if (list.length === 1) { W.auto[st.key] = "only"; chosen = list[0]; }
          else {
            const m = memApply(st.key, list);
            if (m) { W.auto[st.key] = "mem"; chosen = m; }
          }
          if (!chosen && W.skipped.has(st.key)) W.auto[st.key] = "skip";
        }
        if (!chosen && !W.auto[st.key] && (forced || list.length > 1)) {
          W.picks[st.key] = null;
          if (stop < 0) stop = i;
          if (forced) { W.i = i; return; }
          if (stopAt == null) { W.i = i; return; }
          continue;
        }
        if (chosen && st.kind === "cell") {
          /* Settle the provisional slot against what is actually free. */
          const slot = pickSlot(chosen, taken, loreTaken, freeSlots);
          chosen = Object.assign({}, chosen, { items: [{ row: chosen.items[0].row, slot }] });
          freeSlots.delete(slot);
        }
        W.picks[st.key] = chosen || null;
        if (chosen) {
          const row = chosen.items[0].row;
          taken.add(row.i);
          if (isLore(row)) loreTaken.add(row.key);
        }
      }
      W.i = stop >= 0 ? stop : W.steps.length;
    }

    /* The finished set — one shape for the plan table, the overlay fold and
       petStats. */
    function planPet() {
      const picks = [], notes = [];
      for (const st of W.steps) {
        const p = W.picks[st.key];
        if (!p) continue;
        const it = p.items[0];
        picks.push({ slot: it.slot, row: it.row, score: p.score, ratio: p.ratio,
                     kind: st.kind === "cell" ? "fill" : "weapon", chips: p.chips || [] });
      }
      if (buff) notes.push({ k: "hasteBuff", buff });
      if (W.picks["Primary#1"] && GS.TWO_H(W.picks["Primary#1"].items[0].row.rec))
        notes.push({ k: "twoh" });
      if (!W.picks["Primary#1"] && !W.picks["Secondary#1"]
          && (W.auto["Primary#1"] === "none" || W.skipped.has("Primary#1")))
        notes.push({ k: "nowep" });
      let weight = 0;
      for (const p of picks) weight += (p.row.rec.wt || 0);
      const order = ["Primary", "Secondary"].concat(PET_SLOTS);
      picks.sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
      return {
        picks, notes, pool: pool.length,
        weight: Math.round(weight * 10) / 10,
        weightCap: pet.cls.includes("MNK") ? 18 : null,
        slotMath: cap, allCls,
      };
    }

    advance();

    const api = {
      get steps() { return W.steps; },
      get i() { return W.i; },
      get picks() { return W.picks; },
      get auto() { return W.auto; },
      pet, allCls, hasteBuff: buff, scorer: psc, poolSize: pool.length,
      done: () => W.i >= W.steps.length,
      step: () => (W.i < W.steps.length ? W.steps[W.i] : null),
      options: (key) => W.opts[key || (W.steps[W.i] || {}).key] || [],
      ctx: (key) => W.ctx[key || (W.steps[W.i] || {}).key] || null,
      weaponCompare(key) {
        const k = key || (W.steps[W.i] || {}).key;
        const c = W.ctx[k];
        if (k !== "Primary#1" || !c) return null;
        return weaponCompare(c.taken, c.lore);
      },
      pick(stepKey, opt, keep) {
        W.picks[stepKey] = opt;
        if (keep) remember(stepKey, W.opts[stepKey] || [], opt); else mem.del(stepKey);
        advance();
      },
      skip() {
        const at = W.i;
        W.skipped.add(W.steps[at].key);
        advance();
        if (W.i === at) W.i = at + 1;
      },
      /* Jump to a step from anywhere — the finished set included — and
         re-open it; every other pick survives the edit. Only the off hand
         under a two-hander refuses: that is the two-hander's cell. */
      goTo(stepKey) {
        const j = W.steps.findIndex((s) => s.key === stepKey);
        if (j < 0 || W.auto[stepKey] === "twoh") return false;
        mem.del(stepKey);
        W.skipped.delete(stepKey);
        W.picks[stepKey] = null;
        advance(j);
        return true;
      },
      /* Back goes to the previous step that was a real choice; landing on a
         remembered step forgets it — you came back to change it. A step the
         walk settled for itself is not a stop: the off hand under a
         two-hander has candidates in its list, but landing there just
         re-settles it and the walk bounces back to where Back was pressed. */
      back() {
        for (let j = W.i - 1; j >= 0; j--) {
          if (W.auto[W.steps[j].key] === "twoh") continue;
          if ((W.opts[W.steps[j].key] || []).length > 1) return api.goTo(W.steps[j].key);
        }
        return false;
      },
      restart() { W.picks = {}; W.skipped = new Set(); advance(); },
      autoSummary() {
        const kinds = { none: [], only: [], mem: [], skip: [], twoh: [] };
        for (const s of W.steps) if (W.auto[s.key]) kinds[W.auto[s.key]].push(s.label);
        return kinds;
      },
      planPet,
      /* Run to completion unattended — the overlay fold and the companion's
         summary. Remembered decisions apply (the mem the walk was built with
         should be read-only there); open hands take the top option only when
         it earns the cell, open cells take their top card. */
      autoRun() {
        let guard = 0;
        while (W.i < W.steps.length && guard++ < 40) {
          const st = W.steps[W.i], list = W.opts[st.key] || [];
          const top = list[0];
          const worth = top && (st.kind === "cell"
            || wepWorth(top.items[0].row, pet.base, FX, psc));
          if (worth) api.pick(st.key, top, false);
          else api.skip();
        }
        return planPet();
      },
    };
    return api;
  }

  /* ── the proc decision ───────────────────────────────────────────────────
     Separate from the weapon decision, because a proc is an exaltation and
     an exaltation moves: rank the weapon by what it swings, then put the
     best proc the pet can fire into whichever weapon won.

     petProcs({ picks, exalt, X, taken, pet, allCls, effects })
       picks   – planPet().picks
       exalt   – EQLExaltCore.readDump() over the same dump rows
       X       – window.EQLExaltCore
       taken   – the PLAYER plan's row set (a stone in a planned item is his)
       pet     – petAt() result
       allCls  – trio ∪ pet classes
       effects – gear-data effects map

     Returns { hands, stones }:
       hands  – each hand pick with its proc-socket state: opensAt 4, open
                (tier ≥ 4), known (this copy's sockets visible in the dump),
                inIt (the stone already socketed, with its fire gate), innate
                (procOf — the weapon's own effect)
       stones – every movable proc exaltation you own that fits a chosen
                hand: loose ones, and ones socketed in items neither plan
                uses. fire.ok gates on the pet's BASE level; AE never fires.
                Sorted by the nuke the effect text states, biggest first,
                unparsed last — dmg is that parse, not a measurement. */
  function petProcs(o) {
    const X = o.X, exalt = o.exalt, pet = o.pet, FX = o.effects || {};
    const hands = [], stones = [], rejected = [];
    if (!X || !exalt) return { hands, stones, rejected };
    const handPicks = (o.picks || []).filter((p) => p.slot === "Primary" || p.slot === "Secondary");
    if (!handPicks.length) return { hands, stones, rejected };

    const petRows = new Set((o.picks || []).map((p) => p.row));
    const srcOf = new Map();
    for (const s of exalt.sources) srcOf.set(s.row, s);

    for (const p of handPicks) {
      const src = srcOf.get(p.row);
      const sk = src && src.socketsKnown ? src.sockets.proc : null;
      hands.push({
        pick: p, open: p.row.tier >= 4, opensAt: 4,
        known: !!(src && src.socketsKnown),
        inIt: sk && sk.filled && sk.stone && sk.stone.stone ? {
          stone: sk.stone.stone,
          fire: fireGate(sk.stone.stone, pet, FX),
        } : null,
        innate: procOf(p.row.rec, pet.base, FX),
      });
    }

    function fireGate(stone, pet2, fx) {
      const e = stone.eff || {};
      if (isAE(stone.effect, fx)) return { ok: false, ae: true };
      return { ok: !e.l || e.l <= pet2.base, l: e.l || 0 };
    }

    const consider = (stone, from, host, srcRow) => {
      if (!stone || stone.type !== "proc") return;
      const fits = [];
      let slotOk = false, clsOk = false;
      for (const h of hands) {
        const f = X.fit(stone, { cls: X.classesOf(h.pick.row.rec), sl: h.pick.row.rec.sl, tier: h.pick.row.tier });
        if (!f.why.includes("no shared slot")) slotOk = true;
        if (!f.why.includes("no shared class")) clsOk = true;
        if (!f.ok) continue;
        if (!X.usableBy(f.cls, o.allCls)) continue;
        fits.push({ hand: h, open: f.open });
      }
      if (!fits.length) {
        /* An empty table that knows why must say why: the stone's own class
           list when class is the block, its slot list when the slot is. */
        const why = !slotOk ? `fits ${stone.sl.join("/")} only`
          : !clsOk || stone.cls ? `${X.clsText(stone.cls)} only` : "no fit";
        rejected.push({ stone, from, why });
        return;
      }
      stones.push({ stone, from, host: host || null, srcRow: srcRow || null, fits,
                    fire: fireGate(stone, pet, FX), dmg: nukeOf(stone, FX) });
    };
    /* A loose stone whose source yields several effects is a MAYBE — the dump
       does not say which one it holds (exalt-core's rule); every proc the
       source could yield is offered and the row says so. */
    for (const l of exalt.loose) {
      const procs = (l.yields || []).filter((y) => y.type === "proc");
      for (const y of procs) consider(Object.assign({}, y, { maybe: l.yields.length > 1 }), "loose", null, l.row);
    }
    for (const src of exalt.sources) {
      if (o.taken && o.taken.has(src.row.i)) continue;   // the player's plan holds it
      if (petRows.has(src.row)) continue;                // already part of the pet's set
      const sk = src.sockets.proc;
      if (sk && sk.filled && sk.stone && sk.stone.stone) consider(sk.stone.stone, "socketed", src, src.row);
    }
    /* Biggest stated nuke first; the parse reads "Decrease Hitpoints by N"
       off the effect text, so an effect that states no number sorts last,
       not at zero damage. */
    stones.sort((a, b) => (b.fire.ok ? 1 : 0) - (a.fire.ok ? 1 : 0)
      || (b.dmg || -1) - (a.dmg || -1)
      || String(a.stone.effect).localeCompare(String(b.stone.effect)));
    return { hands, stones, rejected };

    function nukeOf(stone, fx) {
      const rec = fx[stone.effect];
      for (const s of (rec && rec.s) || []) {
        const m = /Decrease Hitpoints by (\d+)/i.exec(s);
        if (m) return +m[1];
      }
      return null;
    }
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
    PET_SLOTS, PET_STAT_DEFS, slots, linesFor, petAt, hasteBuffOf, petScorer,
    petLegal, procOf, ratioOf, makePetWalk, petProcs, petStats,
  };
})();
