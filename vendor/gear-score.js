/* DO NOT EDIT — generated copy of public/_shared/gear-score.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Gear scoring — the ONE implementation, loaded by /gear and /sky.
   Edit here; never fork. (Same contract as tier.js and spell-engine.js.)

   Every weight is DERIVED — from the classes, the level, and (with a race set)
   the character's own current stat totals — and each carries a hover
   justification. Per-point conversion rates are the ancestral model (the live-EQ
   lineage EQL runs on); EQL's exact constants are unpublished, so every rate
   names its basis in the tooltip and stays overridable.

   Scores are HP-equivalents: +1 HP on an item is worth exactly 1.

   NOTE ON ONE-CLASS SCORING: the pool math is best-2-of-3, built for a trio.
   Called with a single class (as /sky does, to ask "is this good for a
   Beastlord"), it still returns a defined answer — one HP pool, one mana pool —
   but it is a coarser instrument than the trio case it was designed for. It
   ranks candidates sensibly; it is not a precise single-class model.

   Requires: window.EQL_ATTRIBUTES (/attributes/data.js), window.EQLTier
   (/gear/tier.js), and a `D` (window.EQL_DATA, /combat/data.js) for softcaps. */
(function () {
  "use strict";
  const A = window.EQL_ATTRIBUTES;
  const statAt = window.EQLTier.statAt, statsAt = window.EQLTier.statsAt;

  /* ── slots ───────────────────────────────────────────────────────────────
     SLOTS is the placement vocabulary — the slot names the wiki puts on an
     item, and the only slots a candidate can be assigned to.

     ANY ("Any Slot") is worn but is NOT a placement the item data can name:
     it takes anything the character's classes can equip, so no item record
     ever says "Any Slot". Two positions, and they are where the best gear
     left over after every other slot is filled goes (Kyle, 2026-08-14).
     WORN_SLOTS is therefore what the DUMP can report you wearing, and it is
     what worn AC and worn stat totals must be summed over — reading only
     SLOTS silently dropped both of Kyle's equipped shields. */
  const ANY = "Any Slot";
  const SLOTS = ["Charm", "Ear", "Head", "Face", "Neck", "Shoulders", "Arms",
    "Back", "Wrist", "Range", "Hands", "Primary", "Secondary", "Fingers",
    "Chest", "Legs", "Feet", "Waist", "Ammo", "Power Source"];
  const WORN_SLOTS = SLOTS.concat([ANY]);
  const PAIRED = { Ear: 2, Wrist: 2, Fingers: 2, [ANY]: 2 };
  const WORN_RX = /^(Charm|Ear|Head|Face|Neck|Shoulders|Arms|Back|Wrist|Range|Hands|Primary|Secondary|Fingers?|Ring|Chest|Legs|Feet|Waist|Ammo|Power Source|Any Slot)$/;
  const TWO_H = (rec) => /^2H|Two/i.test((rec && rec.skill) || "");

  /* ── class mechanics ─────────────────────────────── */
  const MANA_STAT = { BRD: "int", SHD: "int", NEC: "int", WIZ: "int", MAG: "int", ENC: "int",
                      PAL: "wis", RNG: "wis", CLR: "wis", DRU: "wis", SHM: "wis", BST: "wis" };
  const FULL_CASTER = ["CLR", "DRU", "SHM", "NEC", "WIZ", "MAG", "ENC"];
  const PURE_MELEE = ["WAR", "MNK", "ROG", "BER"];
  const TANKS = ["WAR", "PAL", "SHD"];

  const STAT_DEFS = [
    ["ac",    "AC"], ["hp", "HP"], ["mana", "Mana"], ["end", "Endurance"],
    ["str",   "STR"], ["sta", "STA"], ["agi", "AGI"], ["dex", "DEX"],
    ["wis",   "WIS"], ["int", "INT"], ["cha", "CHA"], ["atk", "Attack"],
    ["sv",    "Resists (each; SV VOID unscored)"], ["haste", "Haste (per 1%)"],
    ["ratio", "Weapon ratio (dmg/dly ×10)"],
  ];
  // Derivation inputs (the sliders override the resulting WEIGHTS, not these).
  // lm: the ancestral per-class HP factor at 50 (EQEmu GetClassLevelFactor,
  // transcribed on the wiki's Game Mechanics page) — marginal HP per STA for
  // one class pool = level × lm / 3000, HALVED above STA 255.
  // Mana: the EQL-measured piecewise formula (theory-crafting 2026-06,
  // cross-validated against a live character): converted-stat marginal is
  // 1/pt to 100, 2.5/pt to 200, 1.25/pt to 510, 0 past the 510 stat cap —
  // × the level-50 scaler 4.5. Hybrids reportedly get the SAME rate as full
  // casters in EQL ("variance has always been from itemization").
  const RATES = {
    lm: { WAR: 270, SHD: 230, PAL: 230, BER: 230, RNG: 200, MNK: 180,
          BRD: 180, ROG: 180, BST: 180, CLR: 150, DRU: 150, SHM: 150,
          MAG: 120, WIZ: 120, NEC: 120, ENC: 120 },
    manaFac50: 4.5,
    statCap: 510,      // with-gear attribute cap (player-measured)
    staDR: 255,        // STA half-rate breakpoint (player-confirmed)
  };

  const seals = (t) => `<span class="fine">${t}</span>`;

  /* ── inventory ───────────────────────────────────────────────────────────
     ONE read of `/outputfile inventory`, for every surface that takes one:
     /gear (worn slots), /sky (held counts and where a piece is), /valet (the
     whole owned corpus) and the companion app. Edit here; never fork.

     The dump is tab-separated, CRLF, with "Empty" placeholder rows and TWO
     header rows (the KeyRing table repeats Location/Name/ID) — both skipped by
     shape, not by first column. Names carry the tier ("Giant Snake Fang +4",
     same item ID as +0) and exaltation stones carry a "(Exaltation)" suffix.

     STORAGE rows are three columns where the rest are five (no Count, no
     Slots), which is exactly how the storage bins can be told apart. They were
     undocumented until 2026-08-14 and every agent asked said the export did not
     carry them; it does — 113 rows on the reference dump. */
  const TIER_RX = /\s\+(\d+)$/;
  const EXALT_RX = /\s*\(Exaltation\)$/;
  function baseName(name) {
    const plain = String(name).replace(/\*+$/, "");   // the dump stars some items
    const m = TIER_RX.exec(plain);
    return m ? { base: plain.slice(0, m.index), tier: Math.min(10, +m[1]) }
             : { base: plain, tier: 0 };
  }

  /* A location string is a chain: "General 8-Slot6-Slot7" is a thing inside a
     thing inside bag 8. The root decides which place you walk to. */
  const rootLoc = (loc) => String(loc).replace(/(-Slot\d+)+$/, "");
  /* The client writes "General 1" WITH a space and "Bank1" without, so every
     matcher takes an optional one. Anything nothing matches lands in
     "elsewhere" rather than vanishing. */
  const LOC_SECTIONS = [
    ["worn",    "Worn",           (r) => WORN_RX.test(r)],
    ["bags",    "Bags",           (r) => /^(General ?\d+|Held)$/.test(r)],
    ["storage", "Storage",        (r) => /^(Equipment|Activated|Augmentation)$/.test(r)],
    ["bank",    "Bank",           (r) => /^Bank ?\d+$/.test(r)],
    ["shared",  "Shared bank",    (r) => /^SharedBank ?\d*$/.test(r)],
    ["depot",   "Depot",          (r) => /^Personal-Depot/.test(r)],
    ["hoard",   "Dragon's hoard", (r) => /^Dragon/i.test(r)],
    ["keyring", "Key ring",       (r) => /^KeyRing/.test(r)],
    ["other",   "Elsewhere",      () => true],
  ];
  const SECTION_LABEL = {};
  LOC_SECTIONS.forEach(([k, label]) => { SECTION_LABEL[k] = label; });
  const locSection = (loc) => LOC_SECTIONS.find(([, , t]) => t(rootLoc(loc)))[0];

  /* Every non-empty row the dump holds, at full granularity — the grouping is
     the caller's. `sub` is a row nested inside another (a bag's contents, or a
     stone socketed into a worn item); `exalt` is an exaltation stone, which
     names itself after the item it was rendered from ("Shining Metallic Robes
     (Exaltation)") and would otherwise resolve to that item's gear record and
     be scored as if it were the robe. */
  function parseRows(text) {
    const rows = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const f = raw.replace(/\r$/, "").split("\t");
      if (f.length < 3 || (f[1] === "Name" && f[2] === "ID")) continue;
      const loc = f[0], name = f[1];
      if (!name || name === "Empty") continue;
      const exalt = EXALT_RX.test(name);
      const b = baseName(name.replace(EXALT_RX, ""));
      rows.push({
        loc, root: rootLoc(loc), sec: locSection(loc),
        name, base: b.base, tier: b.tier, exalt,
        sub: /-Slot\d+$/.test(loc),
        itemId: +f[2] || 0,
        count: f.length > 3 ? (parseInt(f[3], 10) || 1) : 1,
      });
    }
    return rows;
  }

  /* Where to walk, as data. Bags and bank get a container number and a slot
     number because that is what gets your hand on the item; everywhere else a
     number means nothing, so it gets a word. Kyle, 2026-08-10: "a little bag
     icon with a number indicating the slot number 1-8, or a coin number showing
     1-16. that helps people find that item." Rendering is the caller's — the
     site and the app draw different chips off the same answer. */
  const LOC_WORD = [
    [/^SharedBank ?(\d+)?/, "shared bank"],
    [/^Personal-Depot/, "depot"],
    [/^Dragon/i, "hoard"],
    [/^KeyRing/, "key ring"],
    [/^Cursor/, "cursor"],
    [/^Equipment/, "storage"],
    [/^Activated/, "activated"],
    [/^Augmentation/, "exaltation"],
  ];
  function locBadge(loc) {
    let m;
    if ((m = /^General ?(\d+)(?:-Slot(\d+))?/.exec(loc)))
      return { kind: "bag", n: +m[1], sub: m[2] ? +m[2] : null,
               title: `Bag ${m[1]}${m[2] ? `, slot ${m[2]}` : ""}` };
    if ((m = /^Bank ?(\d+)(?:-Slot(\d+))?/.exec(loc)))
      return { kind: "bank", n: +m[1], sub: m[2] ? +m[2] : null,
               title: `Bank slot ${m[1]}${m[2] ? `, slot ${m[2]}` : ""}` };
    for (const [rx, word] of LOC_WORD) if (rx.test(loc)) return { kind: "word", word, title: loc };
    if (WORN_RX.test(rootLoc(loc))) return { kind: "word", word: "worn", title: `Worn — ${loc}` };
    return { kind: "word", word: loc.toLowerCase(), title: loc };
  }

  /* The worn slots only, in the shape /gear's scorer wants. */
  function parseInventory(text) {
    const slots = {};
    WORN_SLOTS.forEach((s) => { slots[s] = []; });
    for (const r of parseRows(text)) {
      if (r.sub) continue;                    // -SlotN augs are not the worn item
      const m = WORN_RX.exec(r.loc);
      if (!m) continue;                       // bags, bank, storage, cursor
      let slot = m[1];
      if (slot === "Finger" || slot === "Ring") slot = "Fingers";
      slots[slot].push({ name: r.name, base: r.base, tier: r.tier });
    }
    return slots;
  }

  /* ── the scorer ──────────────────────────────────── */
  /* make({ classes, level, race, equipped, D, overrides })
     classes  – array of class codes; one entry is legal (see note above)
     equipped – parseInventory() output with .rec resolved, or null
     D        – window.EQL_DATA (softcaps + skill caps); may be null
     overrides– explicit weight overrides (the /gear sliders) */
  function make(opts) {
    const classes = opts.classes || [];
    const level = opts.level || 1;
    const race = opts.race || null;
    const equipped = opts.equipped || null;
    const D = opts.D || null;
    const overrides = opts.overrides || {};

    function softcap() {
      let v = 0, mult = 0.25;
      for (const c of classes) {
        const sc = D && D.softcaps && D.softcaps[c];
        if (!sc) continue;
        const capv = sc.caps[Math.min(level, D.maxLevel) - 1];
        if (capv > v) { v = capv; mult = sc.mult; }
      }
      return { v, mult };
    }
    function dualWieldCap() {
      const per = D && D.skillCaps && D.skillCaps["Dual Wield"];
      if (!per) return 0;
      let v = 0;
      for (const c of classes) {
        const arr = per[c];
        if (arr) v = Math.max(v, arr[Math.min(level, D.maxLevel) - 1] || 0);
      }
      return v;
    }
    function hpPerSta(cur) {
      // STA feeds the two counted HP pools (best-2-of-3 = the two highest-lm
      // classes), each gaining level×lm/3000 per point
      const ranked = classes.slice().sort((a, b) => RATES.lm[b] - RATES.lm[a]);
      const counted = ranked.slice(0, 2);
      let rate = level * counted.reduce((s, c) => s + (RATES.lm[c] || 0), 0) / 3000;
      let note = "";
      if (cur && cur.sta >= RATES.statCap) { rate = 0; note = "cap"; }
      else if (cur && cur.sta >= RATES.staDR) { rate /= 2; note = "dr"; }
      return { rate: Math.round(rate * 10) / 10, counted, note };
    }
    function manaMarginal(statVal) {
      // per point, per counted pool, at the character's position in the bands
      const s = statVal == null ? 150 : statVal;   // most geared chars sit 100–200
      const d = s >= RATES.statCap ? 0 : s > 200 ? 1.25 : s > 100 ? 2.5 : 1;
      return RATES.manaFac50 * d;
    }
    function nakedStats() {
      if (!race || !A) return null;
      const r = (A.races || []).find((x) => x.name === race);
      if (!r) return null;
      const byName = {};
      (A.classes || []).forEach((c) => { byName[c.name] = c.mod || {}; });
      const out = {};
      for (const s of ["STR", "STA", "AGI", "DEX", "WIS", "INT", "CHA"]) {
        let v = (r.base[s] || 0);
        for (const code of classes) v += (byName[window.EQLChar.name(code)] || {})[s] || 0;
        out[s.toLowerCase()] = Math.min(v, A.nakedCap || 150);
      }
      return out;
    }
    function wornStats() {
      const out = {};
      if (!equipped) return out;
      for (const s of WORN_SLOTS) for (const e of equipped[s] || []) {
        if (!e.rec || !e.rec.st) continue;
        for (const k in e.rec.st) out[k] = (out[k] || 0) + statAt(e.rec.st[k], e.tier);
      }
      return out;
    }
    function currentStats() {
      const nk = nakedStats();
      if (!nk) return null;
      const worn = wornStats();
      const out = {};
      for (const k in nk) out[k] = nk[k] + (worn[k] || 0);
      return out;
    }
    function wornAC() {
      if (!equipped) return 0;
      let total = 0;
      for (const s of WORN_SLOTS) for (const e of equipped[s] || []) {
        if (e.rec && e.rec.st && e.rec.st.ac > 0) total += statAt(e.rec.st.ac, e.tier);
      }
      return total;
    }

    // best-2-of-3 mana pools. EQL players report the per-point rate is the SAME
    // for hybrids and full casters, so pool size tracks the STAT — rank by the
    // character's own totals when known, else majority stat, with full-caster
    // status only as the final tiebreak (classic lore says hybrids run smaller
    // pools; EQL's one direct claim says they don't — unresolved).
    function poolSelection(cur) {
      const pools = classes
        .filter((c) => MANA_STAT[c])
        .map((c) => ({ c, stat: MANA_STAT[c], full: FULL_CASTER.includes(c) }));
      const statCount = {};
      pools.forEach((p) => { statCount[p.stat] = (statCount[p.stat] || 0) + 1; });
      const rank = (p) => (cur ? (cur[p.stat] || 0) : 0) * 10
        + (statCount[p.stat] > 1 ? 5 : 0)
        + (p.full ? 1 : 0);
      pools.sort((a, b) => rank(b) - rank(a));
      return { pools, counted: pools.slice(0, 2) };
    }

    const sc = softcap();
    const worn = wornAC();

    function computedWeights() {
      const t = classes;
      const has = (list) => t.some((c) => list.includes(c));
      const cur = currentStats();
      const wornAc = worn;
      const noRace = cur ? "" : "<p>Set your race and the numbers run from your character's own totals (naked base is client data; worn stats come from your inventory).</p>";
      const pos = (k) => cur ? `Your ${k.toUpperCase()}: <b>${cur[k]}</b> (${nakedStats()[k]} naked + ${(wornStats()[k] || 0)} worn). ` : "";
      const grp = t.length > 1 ? "trio" : "class";

      const sel = poolSelection(cur);
      // cast-heavy = lives on the cast bar: 2+ FULL casters and nobody who
      // mainly swings. Three melee hybrids (RNG/BST/BRD) are a melee trio no
      // matter how many mana pools they carry. With ONE class, a full caster
      // is cast-heavy on its own — there is no second pool to require.
      const fullCount = t.filter((c) => FULL_CASTER.includes(c)).length;
      const castHeavy = fullCount >= (t.length > 1 ? 2 : 1) && !has(PURE_MELEE);
      const tank = has(TANKS);
      const melee = has(PURE_MELEE) || has(["RNG", "BRD", "BST"]);

      const w = {}, why = {};

      w.hp = 1;
      why.hp = `<h5>HP — the unit</h5><p>Every weight is HP-equivalents: +1 HP on an item is worth exactly 1. Change it and everything scales.</p>`;

      // A point of mana is only worth something if the classes that OWN the
      // counted pools live on mana. Two full casters/priests: mana is the
      // constraint. Two hybrids (RNG/BST/BRD): the pools are utility bars — a
      // buff here and there — and a mana point is nearly worthless.
      const fullPools = sel.counted.filter((p) => p.full).length;
      const poolMax = Math.min(2, t.length);
      w.mana = !sel.counted.length ? 0
        : fullPools >= poolMax ? 1.1 : fullPools >= 1 ? 0.6 : 0.15;
      why.mana = `<h5>Mana</h5><p>${sel.counted.length
        ? `Counted pools (best ${poolMax > 1 ? "2 of 3" : "of 1"}): <b>${sel.counted.map((p) => p.c).join(" + ")}</b> — ${fullPools >= poolMax
          ? `full casting. Mana is this ${grp}'s constraint (EQL's design center is mana sustain, not death risk), so a mana point is worth slightly more than an HP.`
          : fullPools >= 1
            ? "part full casting, part hybrid. Mana matters, but half the counted pool belongs to a class that mostly swings — valued at 0.6 HP per point."
            : "hybrid pools only. These are utility bars, not a casting rotation — a mana point is nearly worthless to something that kills with melee. Valued at 0.15 HP per point."}`
        : `No class here has a mana pool — mana on gear is dead weight.`} ${seals("(the pool math is measured; this HP-per-mana exchange rate is the judgment call)")}</p>`;

      // STA -> HP through the counted HP pools
      const hs = hpPerSta(cur);
      w.sta = hs.rate * w.hp;
      const per = (c) => Math.round(level * RATES.lm[c] / 300) / 10;
      why.sta = `<h5>STA → HP</h5><p>${pos("sta")}Counted HP pool${hs.counted.length > 1 ? "s (best 2 of 3)" : ""}: <b>${hs.counted.join(" + ")}</b>; each gains level × class factor / 3000 HP per STA — at ${level}: ${hs.counted.map((c) => `${c} ${per(c)}`).join(" + ")} = <b>${hs.note === "cap" ? "0 — you're at the 510 stat cap" : hs.note === "dr" ? `${hs.rate} HP per STA (halved — you're past the 255 breakpoint)` : `${hs.rate} HP per STA`}</b>. The class factors are the ancestral table (WAR 270 … INT casters 120); players confirmed the past-255 halving holds in EQL. Weight = rate × HP weight.</p>${noRace}`;

      // INT/WIS through the counted pools only — the EQL-measured mana bands
      for (const stat of ["int", "wis"]) {
        const mine = sel.counted.filter((p) => p.stat === stat);
        const dropped = sel.pools.filter((p) => p.stat === stat && !mine.includes(p));
        const sv = cur ? cur[stat] : null;
        const perPool = manaMarginal(sv);
        const v = perPool * mine.length * w.mana;
        w[stat] = Math.round(v * 10) / 10;
        const band = sv == null ? "assuming the 101–200 band (set your race for your real position)"
          : sv >= RATES.statCap ? "past the 510 cap — worth nothing"
          : sv > 200 ? "in the 201+ band (diminished: 1.25 converted/pt)"
          : sv > 100 ? "in the 101–200 band (best: 2.5 converted/pt)"
          : "under 100 (1 converted/pt)";
        why[stat] = `<h5>${stat.toUpperCase()} → mana</h5><p>${pos(stat)}Counted pools: <b>${sel.counted.map((p) => `${p.c}·${p.stat.toUpperCase()}`).join(" + ") || "none"}</b>${cur ? "" : " — set your race and ties break on your own totals"}.</p><p>${mine.length
          ? `${stat.toUpperCase()} feeds ${mine.map((p) => p.c).join(" and ")}: you're ${band}, × the measured level-50 scaler 4.5 ≈ <b>${perPool} mana per point per pool</b>${mine.length > 1 ? ` × ${mine.length} pools` : ""} × the Mana weight. The band formula is player-derived and checked against a real character's exact total; hybrids reportedly gain the same per-point rate as full casters.`
          : dropped.length
            ? `${dropped.map((p) => p.c).join("+")} draws from ${stat.toUpperCase()}, but ${dropped.length === 1 ? "its pool is the dropped third" : "those pools are dropped"} — the stat adds nothing here.`
            : `Nothing here draws mana from ${stat.toUpperCase()}.`}</p>${noRace}`;
      }

      w.ac = tank ? 3 : melee ? 2 : 1.2;
      why.ac = `<h5>AC</h5><p>Worn AC feeds Mitigation, softcapped: the cap is <b>${sc.v}</b> at ${level} (client table${t.length > 1 ? ", best of your three" : ""}), then ×${sc.mult} past it — the scorer already credits candidate AC that lands past the cap at that rate${equipped ? `, from your current ≈<b>${wornAc}</b> worn AC` : ""}. The weight itself is the judgment call: ${tank ? `a tank ${grp} lives on mitigation — 3 HP-equivalents per AC` : melee ? `a melee ${grp} takes hits but isn't the wall — 2 per AC` : `the lowest softcap band and Channeler stance mitigation make AC the weakest defensive buy here — 1.2 per AC`} ${seals("(model; players have no agreed AC:HP rate — one unsourced corpus post says 1 AC ≈ 10 HP)")}</p>`;

      w.atk = melee ? 3 : tank ? 2 : 0.3;
      why.atk = `<h5>Attack</h5><p>Worn ATK is a flat add to Offense, which pushes every swing's damage roll toward max. ${melee ? `For something that kills with melee, throughput IS the build — 3 HP-equivalents per point` : tank ? `Real value, but this ${grp}'s job is holding, not racing — 2 per point` : `This ${grp} barely swings — 0.3 per point`} ${seals("(the offense mechanics are the /combat model; the HP-per-offense exchange rate is the judgment call)")}</p>`;

      const curStr = cur ? cur.str : null;
      const strDead = curStr !== null && curStr < 75;
      w.str = strDead ? Math.round(w.atk * 0.1 * 10) / 10 : Math.round(0.67 * w.atk * 10) / 10;
      why.str = `<h5>STR → Offense</h5><p>${pos("str")}Above 75, each STR is worth ⅔ of an Offense point (the /combat curve) — so the weight is ⅔ × the Attack weight. Nothing below 75. ${strDead ? "<b>You are below 75 — STR barely matters until you cross it.</b>" : ""}</p>${noRace}`;

      const agiRate = 0.222;  // evasion/pt above 40, the /combat model curve
      w.agi = Math.round(agiRate * w.ac * 10) / 10 || 0.1;
      why.agi = `<h5>AGI → Evasion</h5><p>${pos("agi")}≈${agiRate} Evasion per AGI above 40 — the /combat page's model curve is <b>linear, with no 75 knee</b>; the famous 75 cliff traces to P99, unverified for EQL. Valued at the AC weight (evasion is AC's other half): ${agiRate} × ${w.ac}.</p>${noRace}`;

      w.dex = melee ? 0.8 : 0.1;
      why.dex = `<h5>DEX</h5><p>Weapon proc rate (≈DEX/170 + 0.5 procs/min main-hand, model), melee skill-ups, bard note fizzles. A melee lever${melee ? "" : " — and this isn't one"}.</p>`;

      w.cha = has(["ENC", "BRD"]) ? 0.3 : 0.05;
      why.cha = `<h5>CHA</h5><p>Vendor prices and faction; charm behavior in the ancestral model${has(["ENC", "BRD"]) ? " — with ENC/BRD here, charm gives it a small real value" : ""}. Zero combat presence.</p>`;

      w.end = melee ? 0.3 : 0.1;
      why.end = `<h5>Endurance</h5><p>Fuels stances and melee abilities. No published pool math; kept small.</p>`;

      w.sv = 0.4;
      why.sv = `<h5>Resists</h5><p>Fire/Cold/Magic/Disease/Poison, weighted equally — resist value is actively disputed in the player corpus (one parse credited +100 resist with only ≈1600 damage over a whole fight), so the default stays modest. <b>SV VOID is never scored</b> — players are unanimous it's the upgrade-tier marker with no combat effect yet.</p>`;

      w.haste = castHeavy ? 0 : melee ? 3 : 1.5;
      why.haste = `<h5>Haste</h5><p>${castHeavy
        ? "Zeroed: the swing timer is gated by the cast bar, and this is cast-heavy — attack haste is nearly worthless for it. (Spell-haste focus effects are a different stat; they show on items but aren't scored.)"
        : "A real melee lever, but capped and reached by gear alone at endgame — worth buying once, not stacking."}</p>`;

      w.ratio = castHeavy ? 1 : melee ? 15 : 8;
      why.ratio = `<h5>Weapon ratio</h5><p>DMG/delay ×10 for Primary/Secondary/Range. Corpus-corroborated as the melee comparison stat; 2H weapons carry double ratio in EQL (chat). Tier raises DMG only — delay never changes.</p>`;

      return { w, why };
    }

    const cw = computedWeights();
    const w = Object.assign({}, cw.w, overrides);

    function effAC(raw) { return raw <= sc.v ? raw : sc.v + (raw - sc.v) * sc.mult; }

    // Score one item at a tier, in the context of the slot it would occupy:
    // baseAC = worn AC minus the AC of whatever it replaces, so both sides of a
    // comparison price their AC against the same softcap position.
    function score(rec, tier, baseAC, placement) {
      if (!rec) return 0;
      let sum = 0;
      const st = statsAt(rec, tier);
      for (const k in st) {
        if (k === "ac") continue;
        sum += (w[k] || 0) * st[k];
      }
      if (st.ac) sum += w.ac * (effAC(baseAC + st.ac) - effAC(baseAC));
      // SV VOID ("v") is displayed but never scored — player consensus is it's
      // the upgrade-tier marker, with no combat effect yet
      for (const k in rec.sv || {}) if (k !== "v") sum += w.sv * rec.sv[k];
      if (rec.haste) sum += w.haste * rec.haste;
      // A weapon's ratio only counts where it can swing. Two-handers deal
      // double damage and double ratio in EQL (dannuic, chat — combat-stats.md
      // "EQL-specific"), so the ratio term doubles for them; without that a 2H
      // read as a strictly worse 1H and could never win a weapon comparison.
      if (rec.dmg && rec.dly && (placement === "Primary" || placement === "Secondary" || placement === "Range")) {
        sum += w.ratio * 10 * statAt(rec.dmg, tier) / rec.dly * (TWO_H(rec) ? 2 : 1);
      }
      return sum;
    }

    function legal(rec) {
      if (rec.req && rec.req > level) return false;
      const c = rec.cls;
      if (!c) return true;
      if (c.none) return false;
      if (c.all) return !c.x || classes.some((cl) => !c.x.includes(cl));
      return classes.some((cl) => (c.c || []).includes(cl));
    }

    // The weaker equipped occupant of a placement (paired slots hold two).
    function weakestEq(placement) {
      const list = (equipped && equipped[placement]) || [];
      const n = PAIRED[placement] || 1;
      const scored = list.map((e) => {
        const baseAC = worn - (e.rec && e.rec.st && e.rec.st.ac > 0 ? statAt(e.rec.st.ac, e.tier) : 0);
        return { e, s: e.rec ? score(e.rec, e.tier, baseAC, placement) : 0, baseAC };
      });
      while (scored.length < n) scored.push({ e: null, s: 0, baseAC: worn });
      scored.sort((a, b) => a.s - b.s);
      return scored[0];
    }

    return {
      w, why: cw.why, computed: cw.w, sc, worn,
      dualWieldCap, score, legal, weakestEq,
      nakedStats, wornStats, currentStats, poolSelection,
    };
  }

  window.EQLGearScore = {
    SLOTS, WORN_SLOTS, ANY, PAIRED, WORN_RX, TWO_H, STAT_DEFS, RATES,
    MANA_STAT, FULL_CASTER, PURE_MELEE, TANKS,
    LOC_SECTIONS, SECTION_LABEL, rootLoc, locSection, locBadge,
    baseName, parseRows, parseInventory, make,
  };
})();
