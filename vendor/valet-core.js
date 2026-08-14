/* DO NOT EDIT — generated copy of public/valet/valet-core.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Valet — the measurement layer, shared by /valet and the companion app.

   This file owns the slot order, the candidate search, the walk, the
   remembered-decision rule and the loadout arithmetic. It is DOM-free and holds
   no state of its own, so both surfaces run ONE implementation — the same
   contract as gear-score.js, tier.js, sky-core.js and log-parser/engine.js.
   Edit here; never fork.

   The two hosts differ in exactly two places, and both are injected:

     - the SCORER, because the site takes a trio from the shared EQLChar store
       and the app has its own picker;
     - the MEMORY, because a decision cannot be shared. The app and the site are
       different origins, so /valet's localStorage is invisible to the app —
       the same reason Sky's skip marks can't be shared (see SKY_DEF in the
       companion renderer). Each host passes a {get,set,del} over its own store.

   Requires: window.EQLGearScore, window.EQLTier. */
(function () {
  "use strict";
  const GS = window.EQLGearScore;
  const statAt = window.EQLTier.statAt, statsAt = window.EQLTier.statsAt;
  const ANY = GS.ANY;

  /* ── the order ───────────────────────────────────────────────────────────
     Body order down the character sheet, then the weapon hands as ONE decision,
     then the two Any Slot positions.

     Any Slot goes last because that is what it is for: it carries no slot
     restriction at all, only the class one, so the right occupant is whatever
     is left over once every dedicated slot is filled (Kyle, 2026-08-14). Ranked
     earlier it would eat the best chest piece and leave Chest empty. */
  const ORDER = ["Head", "Face", "Ear", "Ear", "Neck", "Shoulders", "Arms", "Back",
    "Wrist", "Wrist", "Hands", "Chest", "Legs", "Feet", "Waist",
    "Fingers", "Fingers", "Charm", "Range", "Ammo"];

  /* Reading order for a fetch list: the trip first, the things already on your
     body last, because those are the rows with nothing to do. Kyle's order —
     "bags, storage, bank, equipped". */
  const SEC_ORDER = ["bags", "storage", "bank", "shared", "depot", "hoard", "other", "worn"];

  function buildSteps() {
    const steps = [], seen = {};
    for (const slot of ORDER) {
      seen[slot] = (seen[slot] || 0) + 1;
      steps.push({ key: `${slot}#${seen[slot]}`, kind: "slot", slot,
                   label: seen[slot] > 1 ? `${slot} (${seen[slot]})` : slot });
    }
    steps.push({ key: "hands", kind: "weapons", slot: "Primary", label: "Weapons" });
    steps.push({ key: `${ANY}#1`, kind: "any", slot: ANY, label: "Any Slot (1)" });
    steps.push({ key: `${ANY}#2`, kind: "any", slot: ANY, label: "Any Slot (2)" });
    return steps;
  }

  /* ── the owned corpus ────────────────────────────────────────────────────
     Every row the dump holds, with its gear record attached. A row IS a
     physical copy — two Six Note Blades in storage are two rows and can fill
     two slots; one is one. Exaltation stones never resolve: a stone is named
     after the item it was rendered from, so "Shining Metallic Robes
     (Exaltation)" would resolve to the robe and be offered as a chest piece you
     do not own. */
  function readInventory(text, DATA) {
    const equipped = GS.parseInventory(text);
    for (const s of GS.WORN_SLOTS) {
      for (const e of equipped[s]) {
        const keys = DATA.names[e.base.toLowerCase()];
        e.key = keys ? keys[0] : null;
        e.rec = e.key ? DATA.items[e.key] : null;
      }
    }
    const rows = GS.parseRows(text).map((r, i) => {
      const keys = r.exalt ? null : DATA.names[r.base.toLowerCase()];
      const key = keys ? keys[0] : null;
      return Object.assign({ i, key, rec: key ? DATA.items[key] : null }, r);
    });
    /* Gear the wiki has no record of cannot be scored, so it is not a candidate
       for anything. Reported rather than dropped: the dangerous ones are the
       pieces you are WEARING, because the walk will cheerfully suggest swapping
       one out for something it can put a number on. */
    const unmatched = rows.filter((r) => !r.exalt && !r.rec);
    const wornUnknown = [];
    for (const s of GS.WORN_SLOTS) for (const e of equipped[s] || []) if (!e.rec) wornUnknown.push({ slot: s, name: e.name });
    return { rows, equipped, unmatched, wornUnknown };
  }

  // Identity for a remembered decision: the ITEM, at its tier. Row order changes
  // with every new dump; "Belt of Virtue +3" does not.
  const itemId = (row) => (row.key || row.base.toLowerCase()) + "+" + row.tier;
  const acOf = (rec, tier) => (rec && rec.st && rec.st.ac > 0 ? statAt(rec.st.ac, tier) : 0);

  /* ── the walk ────────────────────────────────────────────────────────────
     makeWalk({ rows, equipped, scorer, mem })

     scorer – an EQLGearScore.make() result
     mem    – { get(stepKey), set(stepKey, rec), del(stepKey) } over the host's
              own store; rec is { pick, set:[ids], floor }. Pass a no-op memory
              to run the walk without one. */
  function makeWalk(opts) {
    const rows = opts.rows || [];
    const equipped = opts.equipped || null;
    const sc = opts.scorer;
    const mem = opts.mem || { get: () => null, set: () => {}, del: () => {} };

    const steps = buildSteps();
    const W = { steps, i: 0, picks: {}, opts: {}, auto: {}, skipped: new Set() };

    /* Two copies of the same item at the same tier are the same offer; keep one.

       Ties break toward what you already have on. Ammo is the case that proves
       the need: nothing in the scorer reads an arrow, so every quiver you own
       scores exactly 0 and the sort order alone decided which one to go dig out
       of the bank. A tie is not a reason to get up. */
    function dedupe(list) {
      const seen = new Set(), out = [];
      const onYou = (o) => o.items.some((it) => it.row.sec === "worn");
      const sorted = list.sort((a, b) => b.score - a.score
        || (onYou(b) ? 1 : 0) - (onYou(a) ? 1 : 0)
        || b.items[0].row.tier - a.items[0].row.tier);
      for (const o of sorted) {
        if (seen.has(o.id)) continue;
        seen.add(o.id); out.push(o);
      }
      return out;
    }

    /* Options for one step, given what earlier steps already took.

       baseAC is the AC assigned so far, not the AC currently worn: each
       candidate prices its own AC against the softcap position the loadout being
       built will actually reach, or the twelfth piece is credited at the first
       piece's rate. That makes the walk order-dependent, which is why the order
       is fixed and written down rather than chosen per run. */
    function optionsFor(step, taken, loreTaken, baseAC) {
      const dw = sc.dualWieldCap() > 0;
      const usable = (r) => r.rec && !taken.has(r.i) && !(r.key && loreTaken.has(r.key)) && sc.legal(r.rec);
      const mk = (items) => {
        let ac = baseAC, score = 0;
        for (const it of items) {
          score += sc.score(it.row.rec, it.row.tier, ac, it.slot);
          ac += acOf(it.row.rec, it.row.tier);
        }
        return { id: items.map((it) => itemId(it.row)).sort().join(" | "), items, score };
      };

      if (step.kind === "weapons") {
        /* One decision, not two: a two-hander takes both hands, so "best
           Primary" and "best Secondary" chosen separately cannot see the trade.
           The options are whole loadouts — a 2H alone, or a main hand with an
           off hand — ranked against each other. An off hand that deals damage
           needs Dual Wield; a shield or any no-damage item can always go there. */
        const prim = rows.filter((r) => usable(r) && r.rec.sl.includes("Primary"));
        const secs = rows.filter((r) => usable(r) && r.rec.sl.includes("Secondary")
          && !GS.TWO_H(r.rec) && (dw || !r.rec.dmg));
        const out = [];
        for (const p of prim) {
          if (GS.TWO_H(p.rec)) { out.push(mk([{ row: p, slot: "Primary" }])); continue; }
          let paired = false;
          for (const s of secs) {
            if (s.i === p.i) continue;
            if (p.key && s.key === p.key && (p.rec.fl || []).includes("lore")) continue;
            out.push(mk([{ row: p, slot: "Primary" }, { row: s, slot: "Secondary" }]));
            paired = true;
          }
          if (!paired) out.push(mk([{ row: p, slot: "Primary" }]));
        }
        return dedupe(out);
      }

      /* Any Slot takes anything the trio can equip — the only gate is class, so
         the pool is every wearable thing still unassigned.

         It is scored AS Any Slot, not as the slot the item normally goes in, and
         that matters for weapons: a sword parked there is not in a hand and does
         not swing, so its damage-over-delay must not be credited. Kyle's own
         description of the slot is stats — "high stat items, shields, extra
         chest pieces" — and the one class exception he named is a Rogue's
         piercer ENABLING backstab, which is the game reading the item's type,
         not swinging it. Everything else on the item (AC, HP, haste, resists)
         counts normally, because a worn item's stats are worn. */
      const pool = step.kind === "any"
        ? rows.filter((r) => usable(r) && r.rec.sl && r.rec.sl.length)
        : rows.filter((r) => usable(r) && r.rec.sl.includes(step.slot));
      return dedupe(pool.map((r) => mk([{ row: r, slot: step.slot }])));
    }

    /* Kyle's rule: "remember this item beats the others" means the slot stops
       asking until an item that beats at least one of those four turns up. The
       four are stored by item id and so is the fourth one's score; a decision
       stands while the pick is still owned and nothing outside the remembered
       four scores above that floor. Anything else re-opens the slot, because the
       thing the memory was asserting — that these four were the field — stopped
       being true. */
    function remember(stepKey, list, pick) {
      const top = list.slice(0, 4);
      mem.set(stepKey, { pick: pick.id, set: top.map((o) => o.id),
                         floor: top.length ? top[top.length - 1].score : 0 });
    }
    function memApply(stepKey, list) {
      const m = mem.get(stepKey);
      if (!m) return null;
      const pick = list.find((o) => o.id === m.pick);
      if (!pick) return null;                    // you no longer own it
      const set = new Set(m.set);
      return list.some((o) => !set.has(o.id) && o.score > m.floor) ? null : pick;
    }

    /* Whichever occupants of this step's slot the dump reports. The step key
       carries the position ("Wrist#2"), so a paired slot asks about one wrist at
       a time and shows that wrist. */
    function wearingAt(step) {
      if (!equipped) return [];
      if (step.kind === "weapons") return (equipped.Primary || []).concat(equipped.Secondary || []);
      const n = +(step.key.split("#")[1] || 1);
      const e = (equipped[step.slot] || [])[n - 1];
      return e ? [e] : [];
    }

    /* Recompute every step from the first, because a pick changes what is left
       for every later one. Steps that need no decision are settled in passing.
       The walk stops at the first step that is a real, still-open choice. */
    function advance(from) {
      const taken = new Set(), lore = new Set();
      let baseAC = 0;
      W.opts = {}; W.auto = {};
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const list = optionsFor(st, taken, lore, baseAC);
        W.opts[st.key] = list;

        let chosen = i < from ? W.picks[st.key] : null;
        if (chosen && !list.some((o) => o.id === chosen.id)) chosen = null;
        if (!chosen) {
          if (!list.length) W.auto[st.key] = "none";
          /* Nothing the scorer reads: every candidate comes out at zero, so the
             ranking is arbitrary and a swap cannot be an improvement. Ammo is
             the whole class of this. Keep what is on and say so; four cards of
             coin-flip is worse than silence. */
          else if (list[0].score <= 0 && wearingAt(st).length) W.auto[st.key] = "flat";
          else if (list.length === 1) { W.auto[st.key] = "only"; chosen = list[0]; }
          else {
            const m = memApply(st.key, list);
            if (m) { W.auto[st.key] = "mem"; chosen = m; }
          }
        }
        if (!chosen && W.skipped.has(st.key)) W.auto[st.key] = "skip";
        // Stop only on a step nothing above settled. A step the walk decided for
        // itself is marked in auto whether or not it ends up holding an item,
        // and a marked step must not then be asked about anyway.
        if (!chosen && !W.auto[st.key] && list.length > 1) {
          W.picks[st.key] = null;
          W.i = i;
          return;
        }
        W.picks[st.key] = chosen || null;
        if (chosen) {
          for (const it of chosen.items) {
            taken.add(it.row.i);
            if (it.row.key && (it.row.rec.fl || []).includes("lore")) lore.add(it.row.key);
            baseAC += acOf(it.row.rec, it.row.tier);
          }
        }
      }
      W.i = steps.length;   // done
    }

    /* ── loadout arithmetic ──────────────────────────────────────────────
       Both sides walk the same slot list with AC accumulating in the same
       order, which is what makes "wearing now" and "this loadout" comparable
       numbers rather than two sums. */
    /* `kept` is every step the walk could not fill that already has something on
       it — almost always a worn piece with no wiki page, which cannot be a
       candidate for anything. Without it the fetch list simply omits the slot,
       which reads as "wear nothing there". It carries no score, because an item
       with no record cannot be priced on either side of the comparison. */
    function planLoadout() {
      let ac = 0, score = 0;
      const items = [], kept = [], st = {};
      for (const step of steps) {
        const p = W.picks[step.key];
        if (!p) {
          for (const e of wearingAt(step)) kept.push({ step, slot: step.slot, e });
          continue;
        }
        for (const it of p.items) {
          score += sc.score(it.row.rec, it.row.tier, ac, it.slot);
          ac += acOf(it.row.rec, it.row.tier);
          items.push({ step, slot: it.slot, row: it.row });
          const s = statsAt(it.row.rec, it.row.tier);
          for (const k in s) st[k] = (st[k] || 0) + s[k];
        }
      }
      return { score, st, items, kept };
    }
    function currentLoadout() {
      if (!equipped) return { score: 0, st: {}, items: [] };
      let ac = 0, score = 0;
      const items = [], st = {}, used = {};
      for (const slot of ORDER.concat(["Primary", "Secondary", ANY, ANY])) {
        const idx = (used[slot] = used[slot] || 0);
        const e = (equipped[slot] || [])[idx];
        used[slot] = idx + 1;
        if (!e || !e.rec) continue;
        score += sc.score(e.rec, e.tier, ac, slot);
        ac += acOf(e.rec, e.tier);
        items.push({ slot, name: e.name, rec: e.rec, tier: e.tier });
        const s = statsAt(e.rec, e.tier);
        for (const k in s) st[k] = (st[k] || 0) + s[k];
      }
      return { score, st, items };
    }

    advance(0);

    return {
      steps, wearingAt, planLoadout, currentLoadout,
      get i() { return W.i; },
      get picks() { return W.picks; },
      get auto() { return W.auto; },
      done: () => W.i >= steps.length,
      step: () => (W.i < steps.length ? steps[W.i] : null),
      options: (key) => W.opts[key || (steps[W.i] || {}).key] || [],
      pick(stepKey, opt, keep) {
        const i = steps.findIndex((s) => s.key === stepKey);
        W.picks[stepKey] = opt;
        if (keep) remember(stepKey, W.opts[stepKey] || [], opt); else mem.del(stepKey);
        advance(i + 1);
      },
      /* Leaving a slot empty is a decision the walk has to honour, so the
         skipped step is recorded and the walk resumes AFTER it. */
      skip() {
        const at = W.i;
        W.skipped.add(steps[at].key);
        advance(at + 1);
        if (W.i === at) W.i = at + 1;
      },
      /* Back goes to the previous step that was a real choice — stepping onto
         one the walk settled by itself only to have it settle again is a dead
         button. Landing on a remembered step forgets it; you came back to
         change it. */
      back() {
        for (let j = W.i - 1; j >= 0; j--) {
          if ((W.opts[steps[j].key] || []).length > 1) {
            mem.del(steps[j].key);
            advance(j);
            return true;
          }
        }
        return false;
      },
      restart() { W.picks = {}; W.skipped = new Set(); advance(0); },
      // What the walk settled without asking, so a slot it never showed you
      // does not read as a slot it forgot.
      autoSummary() {
        const kinds = { none: [], only: [], mem: [], skip: [], flat: [] };
        for (const s of steps) if (W.auto[s.key]) kinds[W.auto[s.key]].push(s.label);
        return kinds;
      },
    };
  }

  /* One container at a time: everything in bank slot 12 comes out in one reach,
     so the rows for it sit together. */
  function fetchOrder(items) {
    const rank = (it) => SEC_ORDER.indexOf(it.row.sec);
    return items.slice().sort((a, b) =>
      rank(a) - rank(b)
      || (GS.locBadge(a.row.loc).n || 0) - (GS.locBadge(b.row.loc).n || 0)
      || (GS.locBadge(a.row.loc).sub || 0) - (GS.locBadge(b.row.loc).sub || 0));
  }
  const secRank = (sec) => SEC_ORDER.indexOf(sec);

  window.EQLValet = {
    ORDER, SEC_ORDER, ANY,
    buildSteps, readInventory, itemId, acOf, makeWalk, fetchOrder, secRank,
  };
})();
