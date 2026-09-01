/* DO NOT EDIT — generated copy of public/exalt/exalt-wants.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* Exaltation relevance — who wants which effect, and what a dump is missing.

   One implementation for the /exalt page's "Missing" view and the companion's
   Valet → Exaltations "missing" table (companion/scripts/sync-vendor.mjs
   vendors this file; edit here, never fork).

   ── the model ─────────────────────────────────────────────────────────────
   Every exaltation effect FAMILY (name with any trailing rank numeral
   stripped: "Affliction Efficiency II" → "Affliction Efficiency") carries a
   gate: which trio capability makes it worth a socket. A trio is one
   character — the union of its three classes' capabilities (encyclopedia,
   trio-system) — so the gate passes when ANY of the three classes has the
   capability. A focus with no matching caster is dead weight; a proc needs
   weapon swings; a click that grants something a trio class already casts
   natively is a duplicate (best-wins: slows, hastes and same-line buffs do
   not stack, and there is only ever one pet).

   Tiers judge the effect at level 50, where stone magnitudes are fixed
   (effects do not scale with item tier): 1 = core, 2 = useful, 3 = minor
   (trivial magnitude or pure convenience). The class capability table and
   the per-family gates are analysis over the wiki's effect pages and
   docs/encyclopedia/ — model seal, receipts in the file's tables.

   Requires: window.EQLExaltCore. */
(function () {
  "use strict";
  const C = window.EQLExaltCore;

  /* ── per-class capabilities ───────────────────────────────────────────
     From docs/encyclopedia/ (trio-system, control, pets, sustain, per-class
     tables) with resist schools and pet types from the client spell data
     (public/spellmaster/data/spells.json). EQL rules, not classic lore:
     knights lost Block, BST never gets Double Attack, one pet total,
     slow/haste best-wins. `dot` is a real DoT line — CLR's undead-only DoT
     and BRD's trivial DoT songs do not make Affliction foci worth a socket.
     Target-restricted variants don't count either: animal-only pacify
     (RNG/DRU), undead-only slow (NEC), undead/animal-only fear, ROG's
     applied poisons (not cast spells, so no nukePoison). NEC carries
     manaRegen for Lich — a mana-regen click adds little on top of it.
     Keys line up with the gate DSL below. */
  const CAPS = {
    WAR: { melee: 1, dualWield: 1, ranged: 1, shield: 1 },
    CLR: { caster: 1, buffs: 1, heals: 1, cures: 1, rez: 1, undeadNukes: 1, summonedNukes: 1,
           nukeMagic: 1, root: 1, stun: 1, ivu: 1, gate: 1, pacify: 1, memBlur: 1, shield: 1 },
    PAL: { caster: 1, buffs: 1, melee: 1, ranged: 1, heals: 1, cures: 1, rez: 1, undeadNukes: 1,
           nukeMagic: 1, root: 1, stun: 1, hasteBuff: 1, ivu: 1, pacify: 1, shield: 1 },
    RNG: { caster: 1, buffs: 1, melee: 1, dualWield: 1, ranged: 1, dot: 1, heals: 1, cures: 1,
           summonedNukes: 1, nukeFire: 1, nukeMagic: 1, root: 1, snare: 1, invis: 1,
           damageShield: 1, atkBuff: 1, track: 1, moveBuff: 1, levitate: 1, shield: 1 },
    SHD: { caster: 1, buffs: 1, melee: 1, ranged: 1, dot: 1, undeadPet: 1, ownPet: 1, cures: 1,
           undeadNukes: 1, nukeMagic: 1, nukeDisease: 1, snare: 1, fear: 1, fd: 1, invis: 1,
           ivu: 1, lifetap: 1, rune: 1, atkBuff: 1, pacify: 1, shield: 1 },
    DRU: { caster: 1, buffs: 1, dot: 1, charm: 1, heals: 1, cures: 1, summonedNukes: 1,
           nukeFire: 1, nukeCold: 1, nukeMagic: 1, root: 1, snare: 1, stun: 1,
           invis: 1, gate: 1, ports: 1, damageShield: 1, atkBuff: 1, track: 1,
           moveBuff: 1, levitate: 1 },
    MNK: { melee: 1, dualWield: 1, fd: 1, pacify: 1, shield: 1 },
    BRD: { caster: 1, buffs: 1, melee: 1, dualWield: 1, songs: 1, charm: 1, fear: 1, mez: 1,
           cures: 1, nukeMagic: 1, snare: 1, hasteBuff: 1, slow: 1, invis: 1, rune: 1,
           manaRegen: 1, damageShield: 1, atkBuff: 1, track: 1, pacify: 1,
           moveBuff: 1, levitate: 1 },
    ROG: { melee: 1, dualWield: 1, backstab: 1, ranged: 1, slow: 1, invis: 1, ivu: 1 },
    SHM: { caster: 1, buffs: 1, dot: 1, ownPet: 1, charm: 1, heals: 1, cures: 1, nukeFire: 1,
           nukeCold: 1, nukePoison: 1, root: 1, hasteBuff: 1, slow: 1, invis: 1, gate: 1,
           atkBuff: 1, moveBuff: 1, levitate: 1 },
    NEC: { caster: 1, buffs: 1, dot: 1, undeadPet: 1, ownPet: 1, charm: 1, fear: 1, mez: 1,
           cures: 1, undeadNukes: 1, nukeFire: 1, nukeMagic: 1, nukePoison: 1, root: 1, snare: 1,
           stun: 1, fd: 1, invis: 1, ivu: 1, gate: 1, lifetap: 1, manaRegen: 1, rune: 1,
           damageShield: 1, atkBuff: 1, pacify: 1, memBlur: 1, levitate: 1 },
    WIZ: { caster: 1, buffs: 1, nukeFire: 1, nukeCold: 1, nukeMagic: 1, root: 1, snare: 1,
           stun: 1, invis: 1, ivu: 1, gate: 1, ports: 1, rune: 1, damageShield: 1, levitate: 1 },
    MAG: { caster: 1, buffs: 1, dot: 1, ownPet: 1, elemPet: 1, summonedNukes: 1, nukeFire: 1,
           nukeMagic: 1, invis: 1, gate: 1, damageShield: 1, moveBuff: 1 },
    ENC: { caster: 1, buffs: 1, dot: 1, ownPet: 1, charm: 1, fear: 1, mez: 1, nukeMagic: 1,
           root: 1, stun: 1, hasteBuff: 1, slow: 1, invis: 1, ivu: 1, gate: 1, manaRegen: 1,
           rune: 1, damageShield: 1, atkBuff: 1, pacify: 1, memBlur: 1, levitate: 1 },
    BST: { caster: 1, buffs: 1, melee: 1, dualWield: 1, dot: 1, ownPet: 1, heals: 1, cures: 1,
           nukeCold: 1, slow: 1, stun: 1, invis: 1, atkBuff: 1, manaRegen: 1,
           moveBuff: 1, levitate: 1, shield: 1 },
    BER: { melee: 1, ranged: 1, snare: 1, stun: 1, atkBuff: 1, shield: 1 },
  };
  /* Derived keys: `nukes` = any nuke school, `petClass` = any own pet or
     charm line. Kept out of the table so a cell is never double-stated. */
  const NUKE_KEYS = ["nukeFire", "nukeCold", "nukeMagic", "nukePoison", "nukeDisease"];
  const capHas = (cls, key) => {
    const c = CAPS[cls] || {};
    if (key === "nukes") return NUKE_KEYS.some((k) => c[k]);
    if (key === "petClass") return !!(c.ownPet || c.undeadPet || c.charm);
    if (key === "always") return true;
    return !!c[key];
  };

  /* ── gate table ───────────────────────────────────────────────────────
     One record per effect family. `need`: capability (or ANY-of array) that
     makes the effect worth showing; `tier`: 1 core / 2 useful / 3 minor at
     50; `dup`: a trio class casting this natively demotes it one tier;
     `situ`: situational tag (target-restricted etc.); `lvlNote`: a Limit
     Max Level line that guts it at 50. Families absent from the table fall
     back to { need: "always", tier: 2 }. */
  const GATES = {
    "Affliction Efficiency": { need: "dot", tier: 1, why: "cuts DoT mana cost up to 23%", lvlNote: "Limit Max Level: 44 — level-50 DoTs keep ~70% of bonus" },
    "Affliction Haste": { need: "dot", tier: 1, why: "cuts DoT cast time by 33%", lvlNote: "Limit Max Level: 44 — level-50 DoTs keep ~70% of bonus" },
    "Alacrity": { need: "melee", tier: 1, dup: "hasteBuff", why: "40% attack-speed haste click" },
    "Alliance": { need: "always", tier: 3, why: "raises target faction by 100" },
    "Allure": { need: "always", tier: 1, dup: "charm", situ: "charm risk", why: "charm click, up to level 51" },
    "Allure of Death": { need: "caster", tier: 3, dup: "manaRegen", why: "converts 6 HP per tick into 4 mana" },
    "Alter Plane: Sky": { need: "always", tier: 2, dup: "ports", situ: "reagent", why: "group teleport to the Plane of Sky" },
    "Banish Summoned": { need: "melee", tier: 2, situ: "summoned", why: "540-damage proc against summoned targets" },
    "Banish Undead": { need: "melee", tier: 2, situ: "undead", why: "468-damage proc against undead" },
    "Beguile Undead": { need: "always", tier: 2, dup: "charm", situ: "undead", why: "charms undead up to level 46" },
    "Berserker Strength": { need: "melee", tier: 2, dup: "atkBuff", why: "proc buff: +25 STR, 45-point damage absorb at 50" },
    "Bind Affinity": { need: "always", tier: 2, why: "sets bind location by click" },
    "Blaze": { need: "always", tier: 2, dup: "nukeFire", why: "418 fire-damage click" },
    "Blessing of the Lord Commander": { need: "melee", tier: 3, why: "melee strikes heal 6 each" },
    "Blessing of the Theurgist": { need: "melee", tier: 2, situ: "mana users", why: "restores 75 mana per proc" },
    "Blood Claw": { need: "melee", tier: 3, why: "50-damage poison DoT proc over 12s" },
    "Boil Blood": { need: "melee", tier: 2, why: "fire DoT proc, up to 67 per tick for 42s" },
    "Bonds of Force": { need: "always", tier: 2, dup: "snare", why: "targeted AE movement snare" },
    "Bramblecoat": { need: "always", tier: 2, dup: "damageShield", why: "self AC and damage-shield click" },
    "Brass Resonance 10": { need: "songs", tier: 3, why: "raises brass-song power — a stronger resonance exists in era" },
    "Brass Resonance 12": { need: "songs", tier: 3, why: "raises brass-song power — a stronger resonance exists in era" },
    "Brass Resonance 14": { need: "songs", tier: 3, why: "raises brass-song power — a stronger resonance exists in era" },
    "Brass Resonance 15": { need: "songs", tier: 1, why: "the strongest in-era brass resonance — raises brass-song power" },
    "Breath of the Dead": { need: "always", tier: 2, situ: "reagent", why: "water-breathing click" },
    "Burn": { need: "melee", tier: 3, why: "14-damage fire proc" },
    "Burning Affliction": { need: "dot", tier: 1, why: "raises DoT damage up to 20%" },
    "Burnout": { need: "petClass", tier: 2, why: "pet attack-speed, AC, and strength buff" },
    "Burst of Flame": { need: "always", tier: 3, dup: "nukeFire", why: "5-damage fire click" },
    "Cajoling Whispers": { need: "always", tier: 1, dup: "charm", situ: "charm risk", why: "16-minute charm click, targets up to level 46" },
    "Calm": { need: "always", tier: 2, dup: "pacify", why: "pacify click, works to level 50" },
    "Careless Lightning": { need: "always", tier: 3, dup: "nukes", why: "105-damage magic nuke click" },
    "Cascading Darkness": { need: "always", tier: 2, dup: "snare", why: "60% snare click with 72-per-tick DoT" },
    "Cazic Portal": { need: "always", tier: 2, dup: "ports", why: "group teleport click to Cazic-Thule" },
    "Chant of Battle": { need: "melee", tier: 3, why: "proc: brief low-magnitude group STR/DEX/AC song" },
    "Chaos Flux": { need: "melee", tier: 2, why: "175-damage proc with brief stun" },
    "Chaotic Feedback": { need: "melee", tier: 3, why: "32-damage proc with brief stun" },
    "Chill Sight": { need: "always", tier: 3, why: "night-vision self click" },
    "Choke": { need: "melee", tier: 3, why: "minor DoT plus STR/AGI debuff proc" },
    "Clarity": { need: "caster", tier: 2, dup: "manaRegen", why: "27-minute mana-regen click, 9 per tick" },
    "Cleanse": { need: "melee", tier: 3, why: "self proc: one-counter cures, 5-point heal" },
    "Clinging Darkness": { need: "always", tier: 3, dup: "snare", why: "30% snare click, 5-per-tick DoT" },
    "Color Shift": { need: "melee", tier: 2, why: "PBAE 6-second stun proc, works to 55" },
    "Combust": { need: "melee", tier: 2, why: "182-damage fire proc" },
    "Companion Spirit": { need: "always", tier: 3, dup: "petClass", why: "summons a level-26 wolf pet" },
    "Conflagration": { need: "always", tier: 1, dup: "nukeFire", why: "900-damage fire nuke click" },
    "Courage": { need: "always", tier: 3, why: "minor AC/HP worn buff" },
    "Cure Disease": { need: "always", tier: 3, dup: "cures", why: "minor disease-cure click" },
    "Cure Poison": { need: "always", tier: 3, dup: "cures", why: "minor poison-cure click" },
    "Deadeye": { need: "always", tier: 3, why: "see-invisible plus night-vision click" },
    "Diamondskin": { need: "always", tier: 1, dup: "rune", why: "394-damage-absorb rune click" },
    "Disease": { need: "melee", tier: 3, why: "trivial disease DoT proc" },
    "Disease Cloud": { need: "melee", tier: 3, why: "trivial disease DoT proc" },
    "Dismiss Summoned": { need: "melee", tier: 2, situ: "summoned", why: "244-damage proc against summoned targets" },
    "Dismiss Undead": { need: "melee", tier: 2, situ: "undead", why: "211-damage proc against undead" },
    "Divine Aura": { need: "always", tier: 1, situ: "self-only", why: "18-second invulnerability click" },
    "Drain Soul": { need: "always", tier: 2, dup: "lifetap", why: "~400-point lifetap click" },
    "Drones of Doom": { need: "always", tier: 2, why: "156/tick 48s single-target DoT" },
    "Earthquake": { need: "always", tier: 2, why: "214-246 PB AE nuke, 8 targets" },
    "Enduring Breath": { need: "always", tier: 2, why: "removes need to breathe 27 min" },
    "Engulfing Darkness": { need: "melee", tier: 2, dup: "snare", why: "40% snare proc with minor DoT" },
    "Enhancement Haste": { need: "buffs", tier: 2, why: "cuts long-buff cast time 30%", lvlNote: "Limit Max Level: 44 (lose 5%/level after) — mild decay on 45+ beneficial spells" },
    "Ensnaring Roots": { need: "melee", tier: 2, dup: "root", why: "root proc, 96s hold" },
    "Extended Enhancement": { need: "buffs", tier: 2, why: "extends buff duration 15%" },
    "Extended Range": { need: "caster", tier: 3, why: "extends spell range 15%" },
    "Eye of Zomm": { need: "always", tier: 3, why: "remote scouting eye" },
    "Fangol's Breath": { need: "melee", tier: 2, why: "120 poison-damage proc" },
    "Fear": { need: "always", tier: 2, dup: "fear", why: "18s single-target fear click" },
    "Feet like Cat": { need: "melee", tier: 3, why: "36-min agility buff proc" },
    "Feign Death": { need: "always", tier: 1, dup: "fd", why: "feign death click" },
    "Firestrike (proc)": { need: "always", tier: 2, why: "422 fire-damage click" },
    "Flame Bolt": { need: "always", tier: 3, why: "55 fire-damage bolt click" },
    "Flame Shock": { need: "melee", tier: 2, why: "175 fire-damage proc" },
    "Frost Strike": { need: "melee", tier: 2, why: "~150 cold-damage proc" },
    "Fury": { need: "always", tier: 2, why: "self +35 STR/DEX/AGI, +12 AC buff" },
    "Fury of the Chosen": { need: "melee", tier: 3, why: "6-18s self stat-buff proc" },
    "Gate": { need: "always", tier: 2, dup: "gate", why: "returns caster to bind point" },
    "Gather Shadows": { need: "always", tier: 1, dup: "invis", why: "20-min self invisibility click" },
    "Gaze": { need: "always", tier: 3, why: "extends sight distance" },
    "Glimpse": { need: "always", tier: 3, why: "12s far-sight vision" },
    "Grasping Roots": { need: "always", tier: 2, dup: "root", why: "48s root click" },
    "Gravity Flux": { need: "always", tier: 2, why: "214-damage targeted AE, 4 targets" },
    "Guardian Spirit": { need: "always", tier: 3, dup: "petClass", why: "summons fixed level-32 wolf pet" },
    "Hammer of Wrath": { need: "always", tier: 3, situ: "undead", why: "summons anti-undead hammer weapon" },
    "Harmshield": { need: "always", tier: 1, situ: "self-only", why: "18s invulnerability click, 10-min recast" },
    "Haste": { need: "melee", tier: 1, dup: "hasteBuff", why: "35% attack-speed self-haste at max level" },
    "Heritage of Mistmoore": { need: "always", tier: 2, why: "HP and mana regen — costs magic and fire resist" },
    "Healing": { need: "always", tier: 2, dup: "heals", why: "175-hit-point heal click" },
    "Heat Blood": { need: "melee", tier: 2, why: "fire DoT proc, 43 per tick for 36s" },
    "Herikol's Soothing": { need: "melee", tier: 2, situ: "pet-only", why: "proc heals pet 298 and cures counters" },
    "Holy Might": { need: "always", tier: 2, dup: "stun", why: "stun click plus 60 damage, works to 55" },
    "Ice Shock": { need: "always", tier: 2, dup: "nukes", why: "490-539 cold damage click" },
    "Identify": { need: "always", tier: 3, why: "identifies held items" },
    "Ignite": { need: "melee", tier: 3, why: "46 fire damage proc" },
    "Illusion: Dark Elf": { need: "always", tier: 3, why: "dark elf appearance illusion" },
    "Illusion: Skeleton": { need: "always", tier: 3, why: "skeleton appearance illusion" },
    "Illusion: Tree": { need: "always", tier: 3, situ: "outdoors-only", why: "tree illusion, roots caster, outdoor cast only" },
    "Improved Damage": { need: "nukes", tier: 1, why: "20% damage on instant single-target nukes" },
    "Improved Healing": { need: "heals", tier: 1, why: "20% stronger heal spells" },
    "Invisibility versus Animal": { need: "always", tier: 3, situ: "animals", why: "invisibility against animals only" },
    "Invisibility versus Undead": { need: "always", tier: 2, dup: "ivu", situ: "undead", why: "27-minute targetable invisibility versus undead" },
    "Invoke Fear": { need: "always", tier: 2, dup: "fear", why: "42-second single-target fear click" },
    "Invoke Shadow": { need: "always", tier: 3, dup: "petClass", why: "summons level-29 skeletal pet" },
    "JourneymanBoots": { need: "always", tier: 1, dup: "moveBuff", why: "35% self movement-speed click" },
    "Knee Shot": { need: "ranged", tier: 3, why: "bow proc — no wiki description" },
    "Laceration": { need: "melee", tier: 3, situ: "healer mobs", why: "reduces healing the target receives" },
    "Leech": { need: "melee", tier: 3, why: "8-per-tick lifetap DoT proc" },
    "Levitate": { need: "always", tier: 2, dup: "levitate", why: "targetable 16-minute levitate click" },
    "Lifespike": { need: "always", tier: 3, dup: "lifetap", why: "7-12 damage lifetap click" },
    "Lifetap": { need: "melee", tier: 3, why: "6-damage lifetap proc" },
    "Light Healing": { need: "always", tier: 3, dup: "heals", why: "65-hit-point heal click" },
    "Locate Corpse": { need: "always", tier: 3, why: "points toward nearest corpse" },
    "LowerElement": { need: "always", tier: 3, why: "no wiki description" },
    "Lull": { need: "always", tier: 3, dup: "pacify", why: "aggro-radius reducer, level-30 cap", lvlNote: "affects creatures up to level 30 only" },
    "Malaise": { need: "caster", tier: 2, why: "lowers target's cold/fire/magic/poison resists 11 min" },
    "Malaisement": { need: "caster", tier: 2, why: "second-rank debuff to four resist schools" },
    "Mana Convert": { need: "caster", tier: 1, why: "converts 60 HP to 20 mana per click" },
    "Mana Preservation": { need: "caster", tier: 1, why: "cuts spell mana cost up to 10%", lvlNote: "Limit Max Level: 44 (-5%/level) — level-50 spells keep ~70% of the bonus" },
    "Mana Sieve": { need: "always", tier: 3, situ: "caster mobs only", why: "drains 214-370 target mana, unresistable" },
    "Mana Sink": { need: "melee", tier: 3, situ: "caster mobs only", why: "proc drains up to 130 target mana" },
    "Minion of Air": { need: "elemPet", tier: 1, situ: "air pet line", why: "pet power focus for air summon line" },
    "Minion of Earth": { need: "elemPet", tier: 1, situ: "earth pet line", why: "pet power focus for earth summon line" },
    "Minion of Fire": { need: "elemPet", tier: 1, situ: "fire pet line", why: "pet power focus for fire summon line" },
    "Minion of Hate": { need: "undeadPet", tier: 1, why: "pet power +10 for level-48+ undead pet spells" },
    "Minion of Water": { need: "elemPet", tier: 1, situ: "water pet line", why: "pet power focus for water summon line" },
    "Minor Healing": { need: "always", tier: 3, dup: "heals", why: "20-point heal click" },
    "Minor Improved Damage": { need: "nukes", tier: 3, why: "boosts instant spell damage up to 10%", lvlNote: "Limit Max Level: 20 (-5%/level) — zero bonus on level-50 nukes" },
    "Mistwalker": { need: "melee", tier: 3, dup: "petClass", why: "proc summons a pet that persists normally" },
    "Oathbreaker's Curse": { need: "melee", tier: 2, why: "siphons 80 HP per tick for 54s, two targets" },
    "Obsidian Shatter": { need: "melee", tier: 3, why: "30-damage proc with 6-point AC debuff" },
    "Percussion Resonance 11": { need: "songs", tier: 3, why: "raises percussion-song power — a stronger resonance exists in era" },
    "Percussion Resonance 12": { need: "songs", tier: 3, why: "raises percussion-song power — a stronger resonance exists in era" },
    "Percussion Resonance 14": { need: "songs", tier: 1, why: "the strongest in-era percussion resonance — raises percussion-song power" },
    "Percussion Resonance 8": { need: "songs", tier: 3, why: "raises percussion-song power — a stronger resonance exists in era" },
    "Pillar of Fire": { need: "always", tier: 3, dup: "nukeFire", why: "68-76 fire damage AE click, four targets" },
    "Produce Wrench": { need: "always", tier: 3, why: "summons a Tinker Wrench" },
    "Project Lightning": { need: "melee", tier: 3, why: "57-62 damage PBAE lightning proc" },
    "Promised Renewal": { need: "always", tier: 1, dup: "heals", why: "5000-point heal landing after 18s delay" },
    "Purge": { need: "always", tier: 3, dup: "cures", why: "removes one poison and one disease counter" },
    "Raging Strength": { need: "melee", tier: 2, dup: "atkBuff", why: "+23-26 STR single-target buff, 45 minutes" },
    "Rain of Swords": { need: "melee", tier: 1, why: "proc rains three 324-damage AE waves" },
    "Rampage": { need: "melee", tier: 2, dup: "rune", why: "+35 STR and 90-point absorb proc buff" },
    "Reagent Conservation": { need: "caster", tier: 3, why: "15% chance to not consume spell reagents" },
    "Reanimation Efficiency": { need: "undeadPet", tier: 2, why: "focus limited to summon-undead pet spells" },
    "Reanimation Haste": { need: "undeadPet", tier: 2, why: "30% cast-time cut on summon-undead pet spells", lvlNote: "Limit Max Level: 44 (5%/level decay) — mild on level 45-49 pet summons" },
    "Reclaim Energy": { need: ["ownPet", "undeadPet"], tier: 3, why: "dismisses pet, refunds 75% of summon mana" },
    "Restore Sight": { need: "always", tier: 3, situ: "blindness", why: "removes blindness from target" },
    "Resurrection": { need: "always", tier: 3, dup: "rez", why: "90% XP rez; no death penalty in EQL" },
    "Ring of Commons": { need: "always", tier: 2, dup: "ports", why: "self-teleport to West Commonlands" },
    "Root": { need: "melee", tier: 2, dup: "root", why: "48s single-target root proc" },
    "Rune": { need: "always", tier: 1, dup: "rune", why: "damage-absorb rune click, ~305-394" },
    "Scalp of the Ghoul Lord": { need: "always", tier: 3, why: "no wiki description" },
    "Scourge": { need: "melee", tier: 2, why: "disease DoT proc, 58 + 98/tick for 72s" },
    "Screaming Mace": { need: "melee", tier: 3, why: "+10 STR, +6 AC 18s self-buff proc" },
    "See Invisible": { need: "always", tier: 3, why: "see invisible while worn" },
    "Sentinel": { need: "always", tier: 3, why: "placeable ward pings nearby movement" },
    "Serpent Sight": { need: "always", tier: 3, why: "grants infravision" },
    "Servant of Air": { need: "elemPet", tier: 2, why: "mage elemental-pet focus; effect text undocumented" },
    "Servant of Earth": { need: "elemPet", tier: 2, why: "mage elemental-pet focus; effect text undocumented" },
    "Servant of Fire": { need: "elemPet", tier: 2, why: "mage elemental-pet focus; effect text undocumented" },
    "Servant of Water": { need: "elemPet", tier: 2, why: "mage elemental-pet focus; effect text undocumented" },
    "Sha's Lethargy": { need: "melee", tier: 1, dup: "slow", why: "40% attack-speed slow proc" },
    "Shallow Breath": { need: "melee", tier: 3, why: "5 damage, -5 STR/AGI proc" },
    "Shield of Brambles": { need: "melee", tier: 3, dup: "damageShield", why: "procs ~12/hit damage shield, 15 min" },
    "Shield of Lava": { need: "always", tier: 2, dup: "damageShield", why: "25/hit damage shield click, +25 fire resist" },
    "Shock of Fire": { need: "melee", tier: 3, why: "20-damage fire proc" },
    "Shock of Frost": { need: "always", tier: 3, dup: "nukes", why: "4-6 damage cold nuke" },
    "Shock of Swords": { need: "always", tier: 1, dup: "nukes", why: "584-damage magic nuke click" },
    "Shrink": { need: "always", tier: 3, why: "shrinks player size 34%" },
    "Sicken": { need: "melee", tier: 3, why: "minor disease DoT proc, 11/tick" },
    "Siphon": { need: "melee", tier: 3, why: "80-point lifetap proc" },
    "Soothe": { need: "always", tier: 3, dup: "pacify", situ: "targets ≤L40", why: "pacify click, capped at level 40" },
    "Soul Leech": { need: "melee", tier: 3, why: "75-point lifetap proc" },
    "Spell Haste": { need: "caster", tier: 1, why: "cuts spell cast time 15%", lvlNote: "Limit Max Level: 44 — 5%/level decay on 45+ spells (mild)" },
    "Spirit Strike": { need: "melee", tier: 3, why: "78-damage cold proc" },
    "Spirit Tap": { need: "always", tier: 2, dup: "lifetap", why: "210-point lifetap click" },
    "Spirit of Cheetah": { need: "always", tier: 2, dup: "moveBuff", situ: "48s sprint", why: "movement-speed sprint, 10-minute reuse" },
    "Spirit of Wolf": { need: "always", tier: 1, dup: "moveBuff", why: "36-minute movement-speed buff" },
    "Spirit of the Traveler": { need: "always", tier: 3, why: "no wiki description" },
    "Stalking Probe (Spell)": { need: "always", tier: 3, why: "Eye of Zomm scouting probe" },
    "Steal Strength": { need: "melee", tier: 3, why: "drains 15-27 STR on proc" },
    "Steelskin": { need: "always", tier: 2, dup: "rune", why: "230-damage self rune, consumes a jasper" },
    "Strengthen": { need: "always", tier: 3, dup: "atkBuff", why: "+5-10 STR buff click" },
    "String Resonance 10": { need: "songs", tier: 3, why: "raises string-song power — a stronger resonance exists in era" },
    "String Resonance 11": { need: "songs", tier: 3, why: "raises string-song power — a stronger resonance exists in era" },
    "String Resonance 14": { need: "songs", tier: 1, why: "the strongest in-era string resonance — raises string-song power" },
    "Strip Enchantment": { need: "always", tier: 2, situ: "buffed targets", why: "strips four buffs from target" },
    "Strong Poison": { need: "melee", tier: 3, why: "poison DoT proc, ~310 total over 2 minutes" },
    "Stun": { need: "melee", tier: 2, why: "4-second stun proc, works to level 55" },
    "Summon Drink": { need: "always", tier: 3, why: "summons drinking water" },
    "Summon Food": { need: "always", tier: 3, why: "summons bread" },
    "Summon Holy Ale of Brell": { need: "always", tier: 3, why: "summons a stout drink item" },
    "Summoning Efficiency": { need: "ownPet", tier: 2, why: "cuts pet-summon mana cost 25%", lvlNote: "Limit Max Level: 44 — 5%/level decay hits 45+ pet summons" },
    "Summoning Haste": { need: "ownPet", tier: 2, why: "cuts pet-summon cast time 30%" },
    "Superior Healing": { need: "always", tier: 1, dup: "heals", why: "600-point heal click" },
    "Swift Like the Wind": { need: "melee", tier: 1, dup: "hasteBuff", why: "60% attack-speed haste click" },
    "Tagar's Insects": { need: "melee", tier: 1, dup: "slow", why: "34-50% attack-speed slow proc" },
    "Tashani": { need: "melee", tier: 2, situ: "caster trios", why: "magic-resist debuff proc" },
    "Tashania": { need: "melee", tier: 2, why: "magic-resist debuff proc, -33 MR" },
    "Thunder Strike": { need: "always", tier: 2, dup: "nukes", why: "263-damage stun click" },
    "Tishan's Clash": { need: "melee", tier: 2, why: "5-second stun proc, works to level 55" },
    "Trakanon Tail": { need: "always", tier: 3, why: "restores 1 stamina per click" },
    "Ultravision": { need: "always", tier: 3, why: "night vision, worn" },
    "Unrighteous Bash": { need: "always", tier: 3, why: "no wiki description" },
    "Vampiric Curse": { need: "always", tier: 3, dup: "dot", why: "189-total lifetap DoT click" },
    "Vigor of Zehkes": { need: "petClass", tier: 2, dup: "heals", why: "671 pet heal plus cures, click" },
    "Walking Sleep": { need: "always", tier: 1, dup: "slow", why: "attack-speed slow click, up to 35%" },
    "Ward Undead": { need: "melee", tier: 3, situ: "undead", why: "7-12 damage undead-only proc" },
    "Weak Poison": { need: "melee", tier: 3, why: "trivial poison DoT proc, 6 per tick" },
    "Weaken": { need: "melee", tier: 3, why: "-15 STR debuff proc" },
    "Whirlwind": { need: "melee", tier: 2, why: "unresistable spin-stun proc, 100 damage" },
    "Wind Resonance 10": { need: "songs", tier: 3, why: "raises wind-song power — a stronger resonance exists in era" },
    "Wind Resonance 11": { need: "songs", tier: 3, why: "raises wind-song power — a stronger resonance exists in era" },
    "Wind Resonance 12": { need: "songs", tier: 3, why: "raises wind-song power — a stronger resonance exists in era" },
    "Wind Resonance 14": { need: "songs", tier: 1, why: "the strongest in-era wind resonance — raises wind-song power" },
    "Wind Resonance 8": { need: "songs", tier: 3, why: "raises wind-song power — a stronger resonance exists in era" },
    "Winter's Roar": { need: "melee", tier: 2, why: "~246 cold damage proc" },
    "Word of Health": { need: "always", tier: 1, dup: "heals", why: "group heal click, up to 485 each" },
    "Word of Pain": { need: "melee", tier: 3, why: "15-29 damage PBAE proc" },
    "Word of Shadow": { need: "melee", tier: 3, why: "33-58 damage PBAE proc" },
    "Yaulp": { need: "melee", tier: 2, why: "self-buff proc, +30 STR +12 AC" },
    "Ykesha": { need: "melee", tier: 2, why: "75-damage proc, 475 hate, interrupts casting" },
  };

  /* ── families ─────────────────────────────────────────────────────────
     "Affliction Efficiency II" → family "Affliction Efficiency", rank 2.
     Only a trailing ROMAN numeral is a rank — "Brass Resonance 14" is one
     family (the 14 is the instrument multiplier, not a rank). */
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  function familyOf(effect) {
    // the wiki writes some resonances "Brass Resonance: 13" — same family
    // shape as "Brass Resonance 13" (live 2026-09-01)
    const s = String(effect).replace(/(\sResonance):\s*(\d+)$/, "$1 $2");
    const m = /^(.*\S)\s+(I{1,3}|IV|VI{0,3}|IX|X)$/.exec(s);
    if (m && ROMAN[m[2]]) return { family: m[1], rank: ROMAN[m[2]] };
    return { family: s, rank: null };
  }

  /* The gate for a family. The wiki gains effects hourly and the table was
     judged against one build — an unmapped family is NEW, not universal:
     resonances gate on songs whatever their number; anything else shows as
     useful with an "unrated" marker until the table catches up. */
  function gateFor(family) {
    const g = GATES[family];
    if (g) return g;
    const m = /^(Brass|String|Wind|Percussion) Resonance \d+$/.exec(family);
    if (m) return { need: "songs", tier: 3, why: "raises " + m[1].toLowerCase() + "-song power" };
    return { need: "always", tier: 2, why: "", unrated: true };
  }

  /* Which classes in this trio carry a capability — for the "why" cell. */
  function whoHas(trio, need) {
    const keys = need === undefined ? ["always"] : Array.isArray(need) ? need : [need];
    const out = [];
    for (const cls of trio || [])
      if (keys.some((k) => capHas(cls, k)) && !out.includes(cls)) out.push(cls);
    return out;
  }

  /* The verdict for one family under one trio.
       bucket — "wanted" (tier 1-2), "minor" (tier 3, incl. dup-demoted),
                "no" (the gating capability is missing from the trio)
     `who` is the classes that satisfy the gate; `dupBy` the classes that
     cast the duplicated thing natively (set only when that demoted it). */
  function judge(family, trio) {
    const g = gateFor(family);
    const who = whoHas(trio, g.need);
    if (g.need !== "always" && !who.length)
      return { bucket: "no", tier: null, gate: g, who: [],
               dupBy: [], missingCap: Array.isArray(g.need) ? g.need.join(" or ") : g.need };
    let tier = g.tier;
    let dupBy = [];
    if (g.dup) {
      dupBy = whoHas(trio, g.dup);
      if (dupBy.length) tier = Math.min(3, tier + 1);
    }
    return { bucket: tier >= 3 ? "minor" : "wanted", tier, gate: g,
             who: g.need === "always" ? [] : who, dupBy: g.dup && dupBy.length ? dupBy : [], missingCap: null };
  }

  /* ── the missing computation ──────────────────────────────────────────
     cat  — EQLExaltCore.build(DATA)
     dump — EQLExaltCore.readDump(...) or null (no dump: nothing is
            "equipped", every family is a gap)
     trio — ["PAL","DRU","ENC"]
     opts — { hideOE (default true), allRanks (default false: max in-era
              rank only — at 50 the lower ranks are strictly worse) }

     Returns { equipped, rows }:
       equipped — one entry per FILLED worn socket: { w, type, stone|null,
                  effect|null, family|null, rank, base }
       rows     — one entry per family the trio is not covered on:
                  { family, kinds, maxRank, ranks, stones (the max-rank
                    candidate stones usable by the trio), verdict (judge),
                    status "missing"|"upgrade", equippedRank, fx } */
  function missing(cat, dump, trio, opts) {
    const o = opts || {};
    const hideOE = o.hideOE !== false;

    // what is on you now, socket by socket
    const equipped = [];
    const covered = new Map();          // family -> best equipped rank (0 = unranked)
    for (const w of (dump && dump.worn) || []) {
      for (const t of C.TYPES) {
        const sk = w.sockets[t.key];
        if (!sk.filled) continue;
        const st = sk.stone.stone;
        const effect = st ? st.effect : null;
        const fam = effect ? familyOf(effect) : null;
        equipped.push({ w, type: t.key, stone: st, effect,
                        family: fam ? fam.family : null, rank: fam ? fam.rank : null,
                        base: sk.stone.row.base });
        if (fam) {
          const r = fam.rank || 0;
          if (!covered.has(fam.family) || covered.get(fam.family) < r) covered.set(fam.family, r);
        }
      }
    }

    // the catalog, family by family
    const fams = new Map();
    for (const s of cat.stones) {
      if (s.type === null) continue;
      if (hideOE && s.oe) continue;
      const { family, rank } = familyOf(s.effect);
      let f = fams.get(family);
      if (!f) { f = { family, stones: [], ranks: new Set(), kinds: new Set() }; fams.set(family, f); }
      f.stones.push(s);
      f.ranks.add(rank || 0);
      f.kinds.add(s.type);
    }

    const rows = [];
    for (const f of fams.values()) {
      const maxRank = Math.max(...f.ranks);
      // at 50 only the top rank of a family is worth a socket
      let stones = o.allRanks ? f.stones
        : f.stones.filter((s) => (familyOf(s.effect).rank || 0) === maxRank);
      if (trio && trio.length) stones = stones.filter((s) => C.usableBy(s.cls, trio));
      if (!stones.length) continue;     // no source item this trio could use
      const have = covered.get(f.family);
      if (have !== undefined && have >= maxRank) continue;   // on you already
      const verdict = judge(f.family, trio);
      rows.push({
        family: f.family, kinds: [...f.kinds], maxRank: maxRank || null,
        ranks: [...f.ranks].sort((a, b) => a - b).filter(Boolean),
        stones, verdict,
        status: have !== undefined ? "upgrade" : "missing",
        equippedRank: have !== undefined ? have : null,
        fx: stones[0].fx || null,
      });
    }
    rows.sort((a, b) => {
      const ba = a.verdict.bucket === "no" ? 2 : a.verdict.bucket === "minor" ? 1 : 0;
      const bb = b.verdict.bucket === "no" ? 2 : b.verdict.bucket === "minor" ? 1 : 0;
      if (ba !== bb) return ba - bb;
      if ((a.verdict.tier || 9) !== (b.verdict.tier || 9)) return (a.verdict.tier || 9) - (b.verdict.tier || 9);
      const ka = C.TYPES.findIndex((t) => a.kinds.includes(t.key));
      const kb = C.TYPES.findIndex((t) => b.kinds.includes(t.key));
      return ka - kb || a.family.localeCompare(b.family);
    });
    return { equipped, rows };
  }

  window.EQLExaltWants = { CAPS, GATES, capHas, familyOf, gateFor, whoHas, judge, missing };
})();
