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
  const SEC_ORDER = ["bags", "storage", "exalts", "bank", "shared", "depot", "hoard", "other", "worn"];

  function buildSteps() {
    const steps = [], seen = {};
    for (const slot of ORDER) {
      seen[slot] = (seen[slot] || 0) + 1;
      steps.push({ key: `${slot}#${seen[slot]}`, kind: "slot", slot,
                   label: seen[slot] > 1 ? `${slot} (${seen[slot]})` : slot });
    }
    /* Two hands, two steps. They were ONE step showing whole loadouts, which is
       the right arithmetic and the wrong interface: a card holding two items
       reads as one recommendation, so picking a main hand never felt like it
       asked about the off hand (Kyle, 2026-08-14: "did not prompt me to choose
       offhand after i chose a mainhand"). The trade is still shown — the
       Primary step carries `weaponCompare()`, best two-hander against best
       main+off pair — and choosing a two-hander skips the off hand, because it
       is already holding it. */
    steps.push({ key: "Primary#1", kind: "primary", slot: "Primary", label: "Main hand" });
    steps.push({ key: "Secondary#1", kind: "secondary", slot: "Secondary", label: "Off hand" });
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
    /* The dump prints an open socket with nothing in it as an "Empty" row.
       Those are kept in `all` (flagged `empty`, in dump order) for
       exalt-core's readDump, which reads them as "the effect was pulled out"
       rather than "sockets unknown"; `rows` — what every other consumer
       walks — has no placeholders. The same row objects sit in both lists,
       so what readDump says about a worn item is said about THIS row. */
    const all = GS.parseRows(text, { keepEmpty: true }).map((r, i) => {
      const keys = r.exalt || r.empty ? null : DATA.names[r.base.toLowerCase()];
      const key = keys ? keys[0] : null;
      return Object.assign({ i, key, rec: key ? DATA.items[key] : null }, r);
    });
    const rows = all.filter((r) => !r.empty);
    /* Each worn entry points at ITS dump row (`e.row`): the entries and the
       rows come off the same parse in the same order, and a paired slot has
       two of each. A host that wants to know whether the thing in Ear #2 is
       the row the plan puts in Ear #1 compares row identity, not names. */
    {
      const seen = {};
      for (const r of rows) {
        if (r.sub || !GS.WORN_RX.test(r.loc)) continue;
        let slot = r.loc;
        if (slot === "Finger" || slot === "Ring") slot = "Fingers";
        const n = seen[slot] = (seen[slot] || 0);
        const e = (equipped[slot] || [])[n];
        if (e && e.name === r.name) e.row = r;
        seen[slot] = n + 1;
      }
    }
    /* Gear the wiki has no record of cannot be scored, so it is not a candidate
       for anything. Reported rather than dropped: the dangerous ones are the
       pieces you are WEARING, because the walk will cheerfully suggest swapping
       one out for something it can put a number on. */
    const unmatched = rows.filter((r) => !r.exalt && !r.rec);
    const wornUnknown = [];
    for (const s of GS.WORN_SLOTS) for (const e of equipped[s] || []) if (!e.rec) wornUnknown.push({ slot: s, name: e.name });
    return { rows, all, equipped, unmatched, wornUnknown };
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
    const W = { steps, i: 0, picks: {}, opts: {}, auto: {}, ctx: {}, skipped: new Set() };

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
      /* An item ON YOUR BODY is legal for you, whatever the wiki says. The class
         lists in gear-data are wrong often enough to matter: on the reference
         character SEVEN worn pieces are illegal for his own trio, including both
         Any Slot shields (Shield of the Stalwart Seas reads Paladin-only), and
         NO trio makes the whole set legal — so this is the wiki, not the trio.
         Filtering them out meant the walk refused to put back gear he is wearing
         right now, and left the off hand with no candidates at all (Kyle,
         2026-08-14: "it didn't want to put shield of stalward seas on my any
         slot. why not"). The game let him equip it; that outranks a wiki table. */
      const usable = (r) => r.rec && !taken.has(r.i) && !(r.key && loreTaken.has(r.key))
        && (sc.legal(r.rec) || r.sec === "worn");
      const mk = (items) => {
        let ac = baseAC, score = 0;
        for (const it of items) {
          score += sc.score(it.row.rec, it.row.tier, ac, it.slot);
          ac += acOf(it.row.rec, it.row.tier);
        }
        return { id: items.map((it) => itemId(it.row)).sort().join(" | "), items, score };
      };

      /* The off hand's damage gate has the same worn escape as the class one:
         the reference trio has no Dual Wield and an off hand holding a
         12-damage one-hander, so the game lets a hand hold what it cannot
         swing. Refusing it meant the walk would not put back what was on. */
      if (step.kind === "primary" || step.kind === "secondary") {
        const pool = step.kind === "primary"
          ? rows.filter((r) => usable(r) && r.rec.sl.includes("Primary"))
          : rows.filter((r) => usable(r) && r.rec.sl.includes("Secondary")
              && !GS.TWO_H(r.rec) && (dw || !r.rec.dmg || wornSlotOf(r.loc) === "Secondary"));
        return dedupe(pool.map((r) => mk([{ row: r, slot: step.slot }])));
      }

      /* Any Slot takes anything the trio can equip — the only gate is class, so
         the pool is every wearable thing still unassigned. It is scored AS Any
         Slot, so a weapon parked there gets no ratio: it is not in a hand and
         does not swing. */
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
       carries the position ("Wrist#2"), so a paired slot asks about one wrist
       at a time and shows that wrist. */
    function wearingAt(step) {
      if (!equipped) return [];
      const n = +(step.key.split("#")[1] || 1);
      const e = (equipped[step.slot] || [])[n - 1];
      return e ? [e] : [];
    }

    /* The two-hander question, answered once so the Main hand step can state
       it: the best 2H on its own against the best main+off pair. Both are
       priced by the same scorer at the same AC base, which is the only way the
       two numbers mean anything next to each other. */
    function weaponCompare(taken, lore, baseAC) {
      const prim = optionsFor({ kind: "primary", slot: "Primary", key: "Primary#1" }, taken, lore, baseAC);
      const best2H = prim.find((o) => GS.TWO_H(o.items[0].row.rec)) || null;
      let bestPair = null;
      for (const p of prim) {
        if (GS.TWO_H(p.items[0].row.rec)) continue;
        const after = new Set(taken); after.add(p.items[0].row.i);
        const secs = optionsFor({ kind: "secondary", slot: "Secondary", key: "Secondary#1" },
                                after, lore, baseAC + acOf(p.items[0].row.rec, p.items[0].row.tier));
        if (!secs.length) continue;
        const total = p.score + secs[0].score;
        if (!bestPair || total > bestPair.total)
          bestPair = { total, main: p.items[0].row, off: secs[0].items[0].row };
        break;   // prim is score-sorted; the best main hand fixes the best pair
      }
      return { best2H, bestPair };
    }

    /* Recompute every step from the first, because a pick changes what is left
       for every later one. Steps that need no decision are settled in passing.
       The walk stops at the first step that is a real, still-open choice. */
    function advance(from) {
      const taken = new Set(), lore = new Set();
      let baseAC = 0;
      W.opts = {}; W.auto = {}; W.ctx = {};
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        const list = optionsFor(st, taken, lore, baseAC);
        W.opts[st.key] = list;

        W.ctx[st.key] = { taken: new Set(taken), lore: new Set(lore), baseAC };

        let chosen = i < from ? W.picks[st.key] : null;
        if (chosen && !list.some((o) => o.id === chosen.id)) chosen = null;
        /* A two-hander occupies both hands, so the off-hand step is not a
           question — and it must not read as one the walk forgot. */
        const mainPick = W.picks["Primary#1"];
        if (st.kind === "secondary" && mainPick && GS.TWO_H(mainPick.items[0].row.rec)) {
          W.auto[st.key] = "twoh";
          W.picks[st.key] = null;
          continue;
        }
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
          /* Each piece carries the number it was priced at and the AC base it
             was priced against, so a host can say what the swap is worth
             without re-walking the loadout: the occupant it displaces has to
             be scored at that same base or the two numbers are not comparable. */
          const sIt = sc.score(it.row.rec, it.row.tier, ac, it.slot);
          score += sIt;
          items.push({ step, slot: it.slot, row: it.row, score: sIt, baseAC: ac });
          ac += acOf(it.row.rec, it.row.tier);
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
      /* The 2H-vs-pair line for the Main hand step, priced in that step's own
         context. Null anywhere else. */
      weaponCompare(key) {
        const k = key || (steps[W.i] || {}).key;
        const c = W.ctx[k];
        if (k !== "Primary#1" || !c) return null;
        return weaponCompare(c.taken, c.lore, c.baseAC);
      },
      /* What a step was priced in: the rows already spoken for, the LORE keys
         already used, and the AC the loadout carries when the step opens.
         A host needs the base to price the occupant of the slot against the
         candidates for it. */
      ctx: (key) => W.ctx[key || (steps[W.i] || {}).key] || null,
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
        const kinds = { none: [], only: [], mem: [], skip: [], flat: [], twoh: [] };
        for (const s of steps) if (W.auto[s.key]) kinds[W.auto[s.key]].push(s.label);
        return kinds;
      },
    };
  }

  /* Why a number is that number. The single score on a card is a ranking, and a
     ranking you cannot interrogate is a ranking you have to take on faith —
     "135 for midnight clad armbands but 41 for lustrous russet vambraces … ac
     doesn't count for much??" (Kyle, 2026-08-14). It does count; INT counts
     eight times more for a two-caster trio, because each point buys 22.5 mana
     across two counted pools. That is the model's opinion, and it is now
     readable per item and adjustable in the priorities panel. */
  function breakdown(rec, tier, baseAC, slot, sc) {
    const st = statsAt(rec, tier), out = [];
    let total = 0;
    for (const k in st) {
      if (k === "ac") continue;
      const v = (sc.w[k] || 0) * st[k];
      if (v) { out.push({ k: k.toUpperCase(), n: st[k], w: sc.w[k], v }); total += v; }
      else if (st[k]) out.push({ k: k.toUpperCase(), n: st[k], w: 0, v: 0 });
    }
    if (st.ac) {
      const eff = (raw) => (raw <= sc.sc.v ? raw : sc.sc.v + (raw - sc.sc.v) * sc.sc.mult);
      const v = sc.w.ac * (eff(baseAC + st.ac) - eff(baseAC));
      out.push({ k: "AC", n: st.ac, w: sc.w.ac, v, cap: baseAC + st.ac > sc.sc.v });
      total += v;
    }
    for (const k in rec.sv || {}) if (k !== "v") {
      const v = sc.w.sv * rec.sv[k];
      out.push({ k: "SV" + k.toUpperCase(), n: rec.sv[k], w: sc.w.sv, v }); total += v;
    }
    if (rec.haste) { const v = sc.w.haste * rec.haste; out.push({ k: "haste", n: rec.haste, w: sc.w.haste, v }); total += v; }
    if (rec.dmg && rec.dly && (slot === "Primary" || slot === "Secondary" || slot === "Range")) {
      const v = sc.w.ratio * 10 * statAt(rec.dmg, tier) / rec.dly * (GS.TWO_H(rec) ? 2 : 1);
      out.push({ k: "DMG/DLY", n: +(statAt(rec.dmg, tier) / rec.dly).toFixed(2), w: sc.w.ratio, v }); total += v;
    }
    out.sort((a, b) => b.v - a.v);
    return { parts: out, total };
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

  /* ── by slot ─────────────────────────────────────────────────────────────
     The walk asks one question per slot and takes an answer. This is the
     other way round: pick a slot and see the whole field for it — every copy
     you own that fits, where each one is, and how they rank — with no decision
     attached (Kyle, 2026-08-23: "go to a slot and see all the gear for that
     slot. where it is, what it's ranked").

     Twenty slots, in character-sheet order, the hands named as the walk names
     them. Power Source is not offered: no row on any dump has carried one. */
  const BROWSE = ORDER.filter((s, i) => ORDER.indexOf(s) === i)
    .map((slot) => ({ slot, label: slot }))
    .concat([{ slot: "Primary", label: "Main hand" }, { slot: "Secondary", label: "Off hand" },
             { slot: ANY, label: ANY }]);

  const wornSlotOf = (loc) => {
    const m = GS.WORN_RX.exec(GS.rootLoc(loc));
    if (!m) return null;
    return m[1] === "Finger" || m[1] === "Ring" ? "Fingers" : m[1];
  };
  const scorable = (rec) => !!(rec && (rec.st || rec.sv || rec.haste || rec.dmg));
  const fitsSlot = (rec, slot) => slot === ANY ? !!(rec.sl && rec.sl.length) : (rec.sl || []).includes(slot);
  /* The off hand's gate, the same one the walk and spare-core apply: never a
     two-hander, and a damaging one-hander only with Dual Wield. */
  const placeable = (rec, slot, dw) => slot !== "Secondary" || (!GS.TWO_H(rec) && (dw || !rec.dmg));

  /* The AC base for a slot is what /gear uses: the AC you are wearing minus
     the AC of what this slot holds, so every candidate — including the one
     already on — is priced as the thing that would sit there against the rest
     of the kit. A paired slot subtracts its weaker occupant, the one a new
     piece would displace. */
  function slotContext(equipped, sc, slot) {
    let wornAC = 0;
    if (equipped) for (const s of GS.WORN_SLOTS) for (const e of equipped[s] || []) wornAC += acOf(e.rec, e.tier);
    const now = ((equipped && equipped[slot]) || []).map((e) => {
      const ac = acOf(e.rec, e.tier);
      return { e, ac, score: e.rec ? sc.score(e.rec, e.tier, wornAC - ac, slot) : null };
    });
    const scored = now.filter((n) => n.score !== null);
    const vs = scored.length ? scored.reduce((a, b) => (b.score < a.score ? b : a)) : null;
    const baseAC = wornAC - (vs ? vs.ac : 0);
    /* Every occupant is then re-priced at the table's base, so the number in
       "on you now" is the number on the same item's row below it. On a
       paired slot the two bases differ for the stronger occupant, and past
       the AC softcap they gave two different scores for one item on one
       screen. */
    for (const n of now) if (n.score !== null) n.score = sc.score(n.e.rec, n.e.tier, baseAC, slot);
    return { wornAC, now, vs, baseAC };
  }

  /* slotView({ rows, equipped, scorer, slot, trio, ranker, exalt })
       rows/equipped – readInventory()
       scorer        – EQLGearScore.make() for the trio
       ranker        – EQLInventory.makeRanker() (optional): the catalogue rank
                       of each copy, "4 of 212", for the best of your classes,
                       at the tier you hold it
       exalt         – EQLExaltCore.readDump() over the same rows (optional):
                       the sockets of each worn copy
     Returns { slot, now, baseAC, owned, handsNow } where owned is every copy
     you own that fits, score-sorted, each with its rank among them (ties
     share), where it is, and whether it is the one on you in this slot. */
  function slotView(o) {
    const sc = o.scorer, slot = o.slot, rows = o.rows || [];
    const dw = sc.dualWieldCap() > 0;
    const ctx = slotContext(o.equipped, sc, slot);
    const socketsByRow = new Map();
    if (o.exalt) for (const w of o.exalt.worn) socketsByRow.set(w.row, w.sockets);
    /* What is worn IN THIS SLOT is a candidate for it whatever the wiki's
       class list, slot list or the Dual Wield gate say — the game put it
       there (the walk's rule, and the 2026-08-14 shield). Worn elsewhere,
       it is gated like anything else. */
    const usable = (r) => r.rec && !r.exalt && ((r.sec === "worn" && wornSlotOf(r.loc) === slot)
      || (fitsSlot(r.rec, slot) && placeable(r.rec, slot, dw) && (sc.legal(r.rec) || r.sec === "worn")));
    const owned = rows.filter(usable).map((r) => {
      const wornIn = r.sec === "worn" ? wornSlotOf(r.loc) : null;
      return {
        row: r, score: sc.score(r.rec, r.tier, ctx.baseAC, slot),
        wornHere: wornIn === slot, wornIn,
        twoH: GS.TWO_H(r.rec),
        catalog: catalogRank(o.ranker, r.rec, slot, 0, o.trio),   // the item's own worth, at +0
        sockets: socketsByRow.get(r) || null,
        unscored: unscoredOf(r.rec),
        legal: sc.legal(r.rec),
        placeable: fitsSlot(r.rec, slot) && placeable(r.rec, slot, dw),
      };
    });
    owned.sort((a, b) => b.score - a.score || (b.wornHere - a.wornHere) || b.row.tier - a.row.tier
      || a.row.name.localeCompare(b.row.name));
    let rank = 0;
    owned.forEach((c, i) => { if (i === 0 || c.score < owned[i - 1].score) rank = i + 1; c.rank = rank; });
    /* A two-hander in the main hand displaces both hands, so the number to
       beat for one is main + off together, not the main hand alone. */
    let handsNow = null;
    if (slot === "Primary" && o.equipped) {
      const off = slotContext(o.equipped, sc, "Secondary");
      handsNow = { main: ctx.now[0] || null, off: off.now[0] || null,
                   total: (ctx.now[0] && ctx.now[0].score || 0) + (off.now[0] && off.now[0].score || 0) };
    }
    /* The rank the catalogue gap is priced at: the highest you hold in this
       slot — the rank you have demonstrably reached here — not the tier of
       whichever copy scores best, which is +0 often enough to print two
       identical score columns. */
    const parTier = owned.reduce((m, c) => Math.max(m, c.row.tier), 0);
    return { slot, now: ctx.now, vs: ctx.vs, baseAC: ctx.baseAC, wornAC: ctx.wornAC, owned, handsNow, parTier };
  }

  /* Where the item stands in the whole in-era catalogue for the best of your
     classes, at +0 — its own worth, the same for every copy whatever rank
     each is at. The ranker's pool is scored at +0, so passing the held tier
     pinned every upgraded copy at rank 1. Any Slot has no catalogue of its own —
     an item parked there is ranked in its own best slot. "Best" is the best
     PERCENTILE, not the lowest number: 36 of 340 is a stronger standing than
     14 of 91, and the lowest-number rule was quoting the small catalogue. */
  function catalogRank(ranker, rec, slot, tier, trio) {
    if (!ranker || !rec) return null;
    const slots = slot === ANY ? (rec.sl || []).filter((s) => GS.SLOTS.includes(s)) : [slot];
    let best = null;
    const pct = (r) => r.rank / r.of;
    for (const cls of trio || []) for (const s of slots) {
      const r = ranker.rank(rec, cls, s, tier || 0);
      if (r && (!best || pct(r) < pct(best) || (pct(r) === pct(best) && r.of > best.of)))
        best = { cls, slot: s, rank: r.rank, of: r.of, better: r.better };
    }
    return best;
  }

  /* What the score cannot see, chipped on the item: an instrument's
     resonance, and a click that runs out. (The effects themselves get a
     column of their own, so they are not a chip.) */
  function unscoredOf(rec) {
    const out = [];
    if (rec.inst && rec.inst.some((k) => /Resonance$/.test(k))) out.push("inst");
    if (rec.charges) out.push("charges");
    return out;
  }

  /* slotGap({ scorer, slot, D, ownedKeys, baseAC, parTier })
     The catalogue side of the same slot: every in-era item your trio can wear
     there that no row of your dump is (Kyle: "gear i don't have yet for that
     slot for a selected trio"). Scored twice — at +0, which is what a drop is
     when it lands, and at `parTier`, the rank your best owned copy is at, so a
     +5 on your back and a +0 on the wiki are compared at the same rank
     (spare-core's parity rule). Items the wiki gives no stats are not listed:
     nothing on them can be priced, so nothing about them can be an upgrade.
     Out-of-era records never appear. */
  function slotGap(o) {
    const sc = o.scorer, slot = o.slot, D = o.D, owned = o.ownedKeys || new Set();
    const dw = sc.dualWieldCap() > 0, par = o.parTier || 0, baseAC = o.baseAC || 0;
    const items = [];
    if (D && D.items) for (const key of Object.keys(D.items)) {
      const rec = D.items[key];
      if (rec.oe || owned.has(key) || !scorable(rec)) continue;
      if (!fitsSlot(rec, slot) || !placeable(rec, slot, dw) || !sc.legal(rec)) continue;
      const s0 = sc.score(rec, 0, baseAC, slot);
      const sPar = par ? sc.score(rec, par, baseAC, slot) : s0;
      items.push({ key, rec, s0, sPar, twoH: GS.TWO_H(rec), unscored: unscoredOf(rec) });
    }
    items.sort((a, b) => b.sPar - a.sPar || b.s0 - a.s0 || a.rec.n.localeCompare(b.rec.n));
    /* A name the wiki files under several pages — deity variants of a crafted
       piece, mostly, with different stats — is several rows here, each a
       real record. The row carries the page's own qualifier so two
       "Imbued Dwarven Chain Gorget" at 85 and 39 can be told apart. */
    const byName = new Map();
    for (const it of items) (byName.get(it.rec.n) || byName.set(it.rec.n, []).get(it.rec.n)).push(it);
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      for (const it of group) {
        const suffix = it.key.slice(it.rec.n.toLowerCase().length).trim();
        it.variant = suffix || it.key;
        it.variants = group.length;
      }
    }
    return { slot, parTier: par, items };
  }
  /* Two records of one name are the same item when nothing the scorer or the
     fitting rule reads differs — the hyphen/no-hyphen pair — and different
     items when the stats do (deity variants of a crafted piece). */
  function sameItem(a, b) {
    const sig = (r) => JSON.stringify([r.st || null, r.sv || null, r.haste || 0, r.dmg || 0, r.dly || 0, r.sl || null, r.cls || null]);
    return sig(a) === sig(b);
  }
  /* Every item a dump holds at least one copy of, by record key. A stone is
     named after an item and is not one, so it never counts as owning it. A
     name the wiki files under more than one page (60 of them — "Slime Blood
     of Cazic-Thule" has a hyphenated page and a plain one, identical stats)
     counts as owning every record of that name: the dump prints the name,
     not the page, and the worn piece was turning up as something to go get. */
  function ownedKeys(rows, DATA) {
    const s = new Set();
    const names = (DATA && DATA.names) || {}, items = (DATA && DATA.items) || {};
    for (const r of rows || []) {
      if (r.exalt || !r.key) continue;
      s.add(r.key);
      const mine = items[r.key];
      for (const k of names[String(r.base).toLowerCase()] || [])
        if (k !== r.key && mine && items[k] && sameItem(mine, items[k])) s.add(k);
    }
    return s;
  }

  /* ── exaltations ─────────────────────────────────────────────────────────
     exaltAudit({ exalt, trio })
       exalt – EQLExaltCore.readDump() over the dump's rows
       trio  – your three class codes

     Two flags Kyle asked for (2026-08-23: "be flagged if i have empty
     exaltations and especially if i have exaltations somewhere i could be
     using"):

       empty – every socket on a worn item that its tier has opened and
               nothing is in. Sockets open by tier alone (exalt-slots.js,
               23 of 23 worn items), so an open socket with no "-SlotN" child
               row is an empty one.
       idle  – every exaltation that is NOT on your body: the Augmentation
               bin, a bag, the bank, or socketed into an item you are not
               wearing. For each, the worn items it fits RIGHT NOW through the
               fitting rule — an empty socket of its type (`homes.empty`), a
               full one it would replace (`homes.occupied`) — and the ones it
               fits once they reach the tier that opens the socket
               (`homes.later`). A home must leave the item wearable by one of
               your classes; a result none of your three could wear is not a
               home.

     A loose exaltation whose source yields more than one effect is a MAYBE:
     the dump does not say which effect it holds (exalt-core's rule), so every
     effect the source could yield is tried and the row says so. One whose
     source the wiki has no page for has no known effect and no homes. */
  function exaltAudit(o) {
    const X = window.EQLExaltCore, exalt = o.exalt, trio = o.trio || [];
    const empty = [], idle = [];
    if (!exalt || !X) return { empty, idle, summary: { empty: 0, wornWithEmpty: 0, fillable: 0, idle: 0, usable: 0, swaps: 0, later: 0 } };
    const emptyAt = new Map();   // worn item -> { type -> entry }
    for (const w of exalt.worn) for (const t of X.TYPES) {
      const s = w.sockets[t.key];
      if (s && !s.filled && (s.empty || s.open)) {
        const e = { w, type: t.key, at: t.at, fits: [] };
        empty.push(e);
        (emptyAt.get(w) || emptyAt.set(w, {}).get(w))[t.key] = e;
      }
    }
    const mk = (row, key, rec, defs, host, type) => {
      const homes = { empty: [], occupied: [], later: [] };
      /* Why a worn item refuses it, for the row that ends with no home at
         all, read in order: nothing worn shares its slot; or those that do
         all lack a shared class; or the result would be wearable by none of
         your three. Counting the commonest refusal across all twenty worn
         items was wrong — a ring's exaltation read "no shared slot" because
         eighteen worn items are not rings. */
      let slotOk = 0, clsOk = 0, trioNo = 0, sameFx = 0;
      for (const def of defs) {
        const h = X.homesFor(def, exalt.worn);
        for (const n of h.never) if (!n.f.why.includes("no shared slot")) slotOk++;
        for (const n of h.now.concat(h.later)) { slotOk++; clsOk++; if (!X.usableBy(n.f.cls, trio)) trioNo++; }
        for (const n of h.now) {
          if (!X.usableBy(n.f.cls, trio)) continue;
          const sock = n.w.sockets[def.type];
          if (n.occupied) {
            /* Replacing an effect with the same effect is not a swap: the
               reference dump had two such rows, a loose Diamondine Earring
               exaltation "replacing" the Affliction Efficiency I already in
               the worn earring. */
            const cur = sock && sock.stone && sock.stone.stone;
            if (cur && cur.effect === def.effect) { sameFx++; continue; }
            homes.occupied.push({ w: n.w, type: def.type, def, f: n.f, current: sock && sock.stone });
          } else homes.empty.push({ w: n.w, type: def.type, def, f: n.f });
        }
        for (const l of h.later) if (X.usableBy(l.f.cls, trio)) homes.later.push({ w: l.w, type: def.type, def, f: l.f, needs: l.needs });
      }
      let reason = null;
      if (!defs.length) reason = rec ? "the wiki lists no effect of a known kind on its source" : "no wiki page for its source";
      else if (!homes.empty.length && !homes.occupied.length && !homes.later.length) {
        reason = !slotOk ? "no worn item shares a slot with it"
          : !clsOk ? "no worn item in its slot shares a class with it"
          : trioNo ? "none of your classes could wear the result"
          : sameFx ? "the same effect is already in every socket it fits" : "nothing worn takes it";
      }
      const it = { row, key, rec, defs, host: host || null, type: type || (defs.length === 1 ? defs[0].type : null),
                   maybe: defs.length > 1, unknown: !defs.length, homes, why: reason,
                   deity: defs.some((d) => d.deity) };
      for (const h of homes.empty) {
        const e = emptyAt.get(h.w) && emptyAt.get(h.w)[h.type];
        if (e && !e.fits.includes(it)) e.fits.push(it);
      }
      idle.push(it);
    };
    for (const l of exalt.loose) mk(l.row, l.key, l.rec, l.yields.filter((y) => y.type), null, null);
    for (const src of exalt.sources) {
      if (src.worn) continue;
      for (const t of X.TYPES) {
        const sk = src.sockets[t.key];
        if (!sk || !sk.filled) continue;
        mk(sk.stone.row, sk.stone.key, sk.stone.rec, sk.stone.stone ? [sk.stone.stone] : [], src, t.key);
      }
    }
    /* The ones you could be using first, then the ones that would replace
       something, then the rest — and within a group, the bin before a bag
       before the bank, the order you would go and get them. */
    const tier = (it) => (it.homes.empty.length ? 0 : it.homes.occupied.length ? 1 : it.homes.later.length ? 2 : 3);
    idle.sort((a, b) => tier(a) - tier(b) || secRank(a.row.sec) - secRank(b.row.sec) || a.row.name.localeCompare(b.row.name));
    const summary = {
      empty: empty.length,
      wornWithEmpty: emptyAt.size,
      /* sockets that can be filled from what you own — the number of wins,
         where `usable` is the number of candidates competing for them */
      fillable: empty.filter((e) => e.fits.length).length,
      idle: idle.length,
      usable: idle.filter((it) => it.homes.empty.length).length,
      swaps: idle.filter((it) => !it.homes.empty.length && it.homes.occupied.length).length,
      later: idle.filter((it) => !it.homes.empty.length && !it.homes.occupied.length && it.homes.later.length).length,
    };
    return { empty, idle, summary };
  }

  window.EQLValet = {
    ORDER, SEC_ORDER, ANY, BROWSE,
    buildSteps, readInventory, itemId, acOf, makeWalk, fetchOrder, secRank, breakdown,
    slotView, slotGap, ownedKeys, catalogRank, exaltAudit, wornSlotOf,
  };
})();
