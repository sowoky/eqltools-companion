"use strict";
/* EQ Legends Combat Log Parser — client-side, class-agnostic, heuristic.
   Reads an eqlog_<char>_<server>.txt in the browser. No upload, no LLM.
   Every damage line becomes an actor→target event; buildClaims decides whose
   side each actor is on, and WHEN (the only claim signal is the pet's own
   second-person tell — the reasoning lives at buildClaims). Fights are
   per-mob encounters closed by the mob's death line; the xp/coin/faction
   burst that prints just BEFORE a death line carries the kill's XP and coin.
   The same algorithm is transcribed twice — here and in
   pipeline/scripts/logparse_ref.py — and the two are diffed on a real log by
   pipeline/scripts/check_log_parser.py. Any attribution change goes in BOTH,
   with its reasoning inline at the rule (.claude/rules/log-parser.md).
   Player-facing honesty notes live in index.html's footer. */

const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
const CLASS_ABBR = { 1:"WAR",2:"CLR",3:"PAL",4:"RNG",5:"SHD",6:"DRU",7:"MNK",8:"BRD",9:"ROG",10:"SHM",11:"NEC",12:"WIZ",13:"MAG",14:"ENC",15:"BST",16:"BER" };
// Every melee verb seen in real EQL logs ("reave"/"smite" are EQL-era; "frenzi"
// covers "frenzies"). A missing verb surfaces in the unparsed banner, not silence.
const MELEE = "hit|slash|pierce|crush|bash|kick|slice|maul|punch|strike|smash|gore|claw|bite|slam|sting|rend|cleave|backstab|shoot|throw|hurl|reave|smite|frenzy|frenzi";
// The log names combat skills by their verb, and collapses families: Kick and
// Round Kick both print "kick", Tiger Claw prints "strike" (both seen in game,
// 2026-07-11). These verbs get their own damage rows; everything else a player
// swings is a weapon and stays "auto-attack". Cleave/smite/reave are EQL-
// original class abilities (the client's own tooltip list; CLIENT-FILES.md
// §5c), not weapon types. H2H punches are auto-attack — a punch-family skill
// (Dragon Punch) would print the same verb and can't be told apart.
const SKILL_VERBS = new Set(["kick", "bash", "slam", "backstab", "frenzy", "strike", "cleave", "smite", "reave"]);
// Bow shots print "shoot" (observed); throw/hurl are the thrown-weapon guesses
// and unobserved in a real EQL log so far.
const RANGED_VERBS = new Set(["shoot", "throw", "hurl"]);
const baseVerb = v => v === "frenzi" ? "frenzy" : v; // "frenzies" captures as "frenzi"+es
const TS = String.raw`^\[(\w{3}) (\w{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})\] `;
const DS_VERBS = new Set(["burned","pierced","struck","frozen","singed","smitten","shocked","slashed","torn","chilled"]);
const RX = {
  // THE claim signal (see buildClaims). Past-tense "told you" is how the
  // client prints an NPC-to-you tell; live players print present-tense
  // ("tells you"), so a player can't produce this line. Only YOUR OWN pet's
  // tells are ever shown to you. The name is free-form ((.+?)) so a charmed
  // mob's tells claim it too — the old `[A-Z][a-z]+` capture silently missed
  // every mob-named actor. In EQL only the ATTACK-family responses are tells
  // ("Attacking <mob> Master.", "I am unable to wake <mob>, Master."); the
  // other /pet commands answer as SAYS ("Following you, Master.", "Sorry,
  // Master... calming down.", "As you wish, oh great one."), /pet taunt
  // prints a bare speakerless line, and /pet guard prints nothing. Says
  // never claim: player chat is a say too, and the reference log holds a
  // real counterexample ("Kurns says, 'Hail, Master Xalg'" — a player
  // hailing an NPC). The content test is "addresses you as Master" —
  // standalone capital-M Master (or great/splendid one) ANYWHERE — so any
  // response EQL ever promotes to a tell claims without a regex change,
  // while merchant/quest told-you paths stay rejected ("…the Ring of the
  // Ringmaster.'", "…seek out my master.'": embedded or lowercase).
  pet_tell:  new RegExp(TS + String.raw`(.+?) told you, '.*(?:\bMaster\b|great one|splendid one).*\.'$`),
  // /pet leader — "says, 'My leader is <Name>.'" Never seen in an EQL log
  // (111k-line reference, 11 pets) but parsed defensively: it names the
  // owner, so it claims for you and disclaims for anyone else. Say is public.
  pet_leader:new RegExp(TS + String.raw`(.+?) says,? 'My leader is ([A-Z][a-z]+)\.'$`),
  // The target window types names: (Player) is a hard "never yours, never a
  // mob". Pets are typed (NPC), so NPC proves nothing about a name.
  targeted:  new RegExp(TS + String.raw`Targeted \((\w+)\): (.+)$`),
  // Speakers can be multi-word ("Canloe Nusback says, '…'") — a \w+ speaker
  // let NPC says quoting combat phrases fall through to the unparsed banner
  chat:      new RegExp(TS + String.raw`(?:[\w' -]+? (?:tells?|told|says?|said|shouts?|shouted|auctions?|auctioned|BROADCASTS)[ ,]|You (?:tell|told|say|said|shout|auction)\b|[\w' -]+? says? out of character)`),
  miss:      new RegExp(TS + String.raw`(.+?) tr(?:y|ies) to (\w+)(?: on)? (.+?), but (.+?)!(?: \((.+)\))?$`),
  // You use the base verb; everyone else the s/es form — one combined rule
  // would misparse "a giant bite beetle bites …" (verb word inside a mob name)
  // frenzy targets through "on" ("Payne frenzies on CWG Model MB for 105…",
  // 292 real lines) — without the optional "on " the parser invented phantom
  // targets named "on YOU"
  melee_you: new RegExp(TS + `You (${MELEE}) (?:on )?(.+?) for (\\d+) points? of damage\\.(?: \\((.+)\\))?$`),
  melee:     new RegExp(TS + `(.+?) (${MELEE})(?:es|s) (?:on )?(.+?) for (\\d+) points? of damage\\.(?: \\((.+)\\))?$`),
  ds:        new RegExp(TS + String.raw`(.+?) (?:is|are) (\w+) by ([A-Z]OUR|.+?)(?:'s)? ([\w ]+?) for (\d+) points? of non-melee damage[.!]$`),
  spell:     new RegExp(TS + String.raw`(.+?) hits? (.+?) for (\d+) points? of (\w+) damage by (.+?)\.(?: \((.+)\))?$`),
  dot_your:  new RegExp(TS + String.raw`(.+?) has taken (\d+) damage from your (.+?)\.(?: \((.+)\))?$`),
  dot_from:  new RegExp(TS + String.raw`(.+?) ha(?:s|ve) taken (\d+) damage from (.+?) by (.+?)\.(?: \((.+)\))?$`),
  dot_anon:  new RegExp(TS + String.raw`(.+?) ha(?:s|ve) taken (\d+) damage by (.+?)\.(?: \((.+)\))?$`),
  // heals carry the same parenthetical flags as damage ("(Critical)") — real
  // log lines went unparsed until the tail group was added (2026-07-11)
  heal:      new RegExp(TS + String.raw`(.+?) healed (.+?)( over time)? for (\d+)(?: \((\d+)\))? hit points?(?: by (.+?))?\.(?: \((.+)\))?$`),
  // passive live-EQ form ("X has been healed over time for N … by <Spell>") —
  // names no healer, so it never counts as YOUR healing. UNOBSERVED in EQL;
  // parsed so it can't hit the unparsed banner if it ever appears.
  heal_been: new RegExp(TS + String.raw`(.+?) ha(?:s|ve) been healed( over time)? for (\d+)(?: \((\d+)\))? hit points?(?: by (.+?))?\.(?: \((.+)\))?$`),
  ds_rev:    new RegExp(TS + String.raw`(.+?) was \w+(?: [\w ]+?)? for (\d+) points? of non-melee damage\.$`),
  cast_you:  new RegExp(TS + String.raw`You begin (?:casting|singing) (.+?)\.$`),
  cast_other:new RegExp(TS + String.raw`(.+?) begins (?:casting|singing) (.+?)\.$`),
  slain_you: new RegExp(TS + String.raw`You have slain (.+?)!$`),
  you_slain: new RegExp(TS + String.raw`You have been slain by (.+?)!$`),
  slain_by:  new RegExp(TS + String.raw`(.+?) has been slain by (.+?)!$`),
  youdied:   new RegExp(TS + String.raw`You died\.$`),
  died:      new RegExp(TS + String.raw`(.+?) died\.$`),
  xp:        new RegExp(TS + String.raw`You gain (?:party |group )?experience! \((\d+(?:\.\d+)?)%\)$`),
  // "as your split" is the grouped-corpse form — UNOBSERVED in an EQL log
  // (adopted from EQBuddy's EQL parser 2026-07-20), parsed defensively so
  // grouped coin can't be silently lost; it clusters exactly like corpse coin
  coin:      new RegExp(TS + String.raw`You receive (.+?) (?:from the corpse|as your split)\.$`),
  // manual vendor sale — OBSERVED (51 in the 2026-07-20 reference log). Counts
  // into coin gained; never into kill clusters (nothing died).
  vendorsale:new RegExp(TS + String.raw`You receive (.+?) from .+? for the (.+?)\(s\)\.$`),
  // quest turn-in coin ("You receive 2 silver from Canloe Nusback.") and
  // item-salvage coin ("You received 2 gold... from that item.") — both
  // OBSERVED (73 lines / 10,385c in the reference log went uncounted before
  // these). Ordered after coin and vendorsale, so only their leftovers land
  // here; the handler drops matches carrying no coin words (item rewards).
  // Never clusters: a quest turn-in prints XP too, and its coin must not
  // attach to whatever kill happened to land in the same two seconds.
  questcoin: new RegExp(TS + String.raw`You receive (.+?) from .+?\.$`),
  salvage:   new RegExp(TS + String.raw`You received (.+?) from that item\.$`),
  loot:      new RegExp(TS + String.raw`You looted (?:an? |(\d+) )?(.+?) from (.+?)'s corpse(?:\.| (and stored it in your tradeskill depot|and sold it for free\.|and sold it for (.+?)\.|to create an? .+))?$`),
  // MANUAL loot (corpse window) prints a different line than auto-loot — no
  // "You looted" chat message, a --wrapped one instead: "--You have looted a
  // Charcoal from an earth elemental's corpse.--" (observed 2026-07-31, 309
  // lines in a live-play log — a missed Charcoal loot surfaced it).
  // Article precedes even plural item names ("a Bone Chips"); stacks print a
  // bare count with no article ("2 Bone Chips"); item names can contain
  // apostrophes ("Rambunctious Pet's Skull from a rambunctious pet's corpse"
  // — the lazy item group stops at the first " from "). No sell/depot/create
  // tail exists on this form: manual loot is always kept, never coin.
  // Groups mirror "loot": m[8] qty, m[9] item, m[10] mob.
  lootManual: new RegExp(TS + String.raw`--You have looted (?:an? |(\d+) )?(.+?) from (.+?)'s corpse\.--$`),
  faction:   new RegExp(TS + String.raw`Your faction standing with (.+?) (?:has been adjusted by (-?\d+)|could not possibly get any (better|worse))\.$`),
  skillup:   new RegExp(TS + String.raw`You have become better at (.+?)! \((\d+)\)$`),
  // Consider: "<mob> <faction phrase> -- <verdict> (Lvl: N)". The faction
  // phrase starts with a known verb; the " - a rare creature -" suffix only
  // ever appears here, never in slain lines. A con can be of a PLAYER, so con
  // names never enter the mob set and never open or refresh fights — cons
  // feed the level timeline and the per-mob level readout only.
  con:       new RegExp(TS + String.raw`(.+?) ((?:regards|scowls|glares|considers|looks|glowers|glances|judges|kindly|smiles|beams).*?) -- (.*?)\s*\(Lvl: (\d+)\)$`),
  aa:        new RegExp(TS + String.raw`You have gained an ability point! +You now have (\d+) ability points?\.$`),
  zone:      new RegExp(TS + String.raw`You have entered (.+?)\.$`),
  level:     new RegExp(TS + String.raw`You have gained a level! Welcome to level (\d+)!$`),
  interrupt: new RegExp(TS + String.raw`Your (.+?) spell is interrupted\.$`),
  fizzle:    new RegExp(TS + String.raw`Your spell fizzles!`),
  nomana:    new RegExp(TS + String.raw`Insufficient Mana`),
  resist:    new RegExp(TS + String.raw`(.+?) resisted your (.+?)!$`),
  stance:    new RegExp(TS + String.raw`You assume an? ([\w ]+?) stance\.$`),
  invoke:    new RegExp(TS + String.raw`You begin reciting the ([\w ]+?) invocation\.$`),
  wornoff:   new RegExp(TS + String.raw`Your (.+?) spell has worn off(?: of (.+?))?\.$`),
  mezzed:    new RegExp(TS + String.raw`(.+?) has been mesmerized\.$`),
  nonmelee_you: new RegExp(TS + String.raw`You were hit by non-melee for (\d+) damage\.$`),
  // Mend prints no number — "and heal some damage" is the whole story — so it
  // can only ever be a use-counter, never a healing total. Success is observed
  // in a real EQL log; the crit/fail/worsen wordings are the client's other
  // three mend strings (eqstr 349-352 via EQEmu), defensive until seen.
  mend:      new RegExp(TS + String.raw`You ((?:magically )?mend your wounds and heal (?:some|considerable) damage\.|have failed to mend your wounds\.|have worsened your wounds!)$`),
  // A spell that couldn't land on you ("but you are protected.") — ends in a
  // period, so the miss rule (which needs "!") never saw it
  protected: new RegExp(TS + String.raw`(.+?) tries to cast a spell on you, but you are protected\.$`),
  ds_absorb: new RegExp(TS + String.raw`(.+?)'s magical skin absorbs the damage of ([A-Z]OUR|.+?)(?:'s)? ([\w ]+?)\.$`),
  // a guild tag sits between race and ZONE for guilded players ("<Castle>")
  who:       new RegExp(TS + String.raw`\[(\d+) ([A-Z]{2,3}(?:/[A-Z]{2,3})*)\] (\w+) \(([\w ]+)\)\s+(?:<[^>]*>\s+)?ZONE: (.+?) \(`),
};
// most frequent first; you_slain before slain_by, youdied before died
// heal_been MUST run before heal: heal's lazy healer group would otherwise
// swallow "has been" and misparse the over-time passive form (healer "X has
// been", target "over time"). heal_been's "been healed" core can't match an
// active heal line, so the early position is safe.
const ORDER = ["miss","melee_you","melee","ds","spell","dot_your","dot_from","dot_anon","heal_been","heal","cast_you","cast_other",
  "slain_you","you_slain","slain_by","youdied","died","con","xp","coin","vendorsale","questcoin","salvage","loot","lootManual","faction","skillup","aa","zone","level","interrupt",
  "resist","stance","invoke","wornoff","mezzed","nonmelee_you","mend","protected","ds_absorb","ds_rev","who","targeted","fizzle","nomana"];
const COMBATISH = /points? of (?:\w+ )?damage|has taken \d+ damage|healed .+ for \d+|has been slain|You have slain|, but .{0,60}(?:miss|dodge|parr|ripost|block|absorb)/;
const COIN_RE = /(\d+) (platinum|gold|silver|copper)/g;
const PC_NAME = /^[A-Z][a-z]+$/;

const toDate = m => new Date(+m[7], MONTHS[m[2]] - 1, +m[3], +m[4], +m[5], +m[6]);
const flagsOf = s => s ? s.split(/, | (?=[A-Z])/).filter(Boolean) : [];
const inCopper = c => c.platinum * 1000 + c.gold * 100 + c.silver * 10 + c.copper;

/* ─── parse (single pass over the file) ────────────────────────────────────*/
function parse(text, fileOwner) {
  let owner = fileOwner || "You";
  const ev = [], told = new Set(), players = new Set(), castSet = new Set();
  let unparsedCombat = 0, who = null;
  // Article mobs print sentence-capitalized at line start ("A training dummy
  // hits…", "The froglok shin lord hits…") and lowercase mid-sentence — fold
  // to one name or the same mob gets two rows everywhere.
  const resolve = (n, self) => {
    n = n.trim();
    if (n === "You" || n === "you" || n === "YOU") return owner;
    // A reflexive target names the actor the line already named ("a necro
    // neophyte healed himself for 6 hit points by Lifetap."). The caller hands
    // in that actor as `self`; there is no ambiguity to resolve, the client is
    // just writing English. Load-bearing for HP bounds — a lifetap mob's
    // self-heals are exactly the points that must come back OUT of the damage
    // total, and left unresolved they would attribute to a mob named "himself".
    if ((n === "himself" || n === "herself" || n === "itself" || n === "yourself") && self) return self;
    if (n.startsWith("A ")) return "a" + n.slice(1);
    if (n.startsWith("An ")) return "an" + n.slice(2);
    if (n.startsWith("The ")) return "the" + n.slice(3);
    return n;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.length < 28) continue;
    let m;
    // pet tells and leader-says look like chat and come first; all other chat
    // is dropped before combat matching so a quoted sentence never parses as
    // combat. An ambient say ("At your service Master.") is NOT matched here
    // on purpose — say has a radius, and at a two-mage camp the other mage's
    // pet says it too. Only the second-person tell claims.
    if ((m = RX.pet_leader.exec(raw))) {
      const name = resolve(m[8]);
      if (resolve(m[9]) === owner) { told.add(name); ev.push({ ts: toDate(m), k: "tell", name }); }
      else ev.push({ ts: toDate(m), k: "antitell", name });
      continue;
    }
    if ((m = RX.pet_tell.exec(raw))) { const name = resolve(m[8]); told.add(name); ev.push({ ts: toDate(m), k: "tell", name }); continue; }
    if (RX.chat.test(raw)) continue;
    let hit = null, kind = null;
    for (const k of ORDER) {
      if ((m = RX[k].exec(raw))) {
        if (k === "ds" && !DS_VERBS.has(m[9])) continue;
        hit = m; kind = k; break;
      }
    }
    if (!hit) { if (COMBATISH.test(raw)) unparsedCombat++; continue; }
    m = hit;
    const ts = toDate(m);
    switch (kind) {
      case "melee_you": { const vb = baseVerb(m[8]); ev.push({ ts, k: "dmg", cat: RANGED_VERBS.has(vb) ? "ranged" : "melee", verb: vb, src: owner, tgt: resolve(m[9]), amt: +m[10], flags: flagsOf(m[11]) }); break; }
      case "melee":  { const vb = baseVerb(m[9]); ev.push({ ts, k: "dmg", cat: RANGED_VERBS.has(vb) ? "ranged" : "melee", verb: vb, src: resolve(m[8]), tgt: resolve(m[10]), amt: +m[11], flags: flagsOf(m[12]) }); break; }
      case "spell":  ev.push({ ts, k: "dmg", cat: "spell", src: resolve(m[8]), tgt: resolve(m[9]), amt: +m[10], elem: m[11], spell: m[12], flags: flagsOf(m[13]) }); break;
      case "ds":     ev.push({ ts, k: "dmg", cat: "ds", src: m[10] === "YOUR" ? owner : resolve(m[10]), tgt: resolve(m[8]), amt: +m[12], spell: `damage shield (${m[11]})`, flags: [] }); break;
      case "dot_your": ev.push({ ts, k: "dmg", cat: "dot", src: owner, tgt: resolve(m[8]), amt: +m[9], spell: m[10], flags: flagsOf(m[11]) }); break;
      case "dot_from": ev.push({ ts, k: "dmg", cat: "dot", src: resolve(m[11]), tgt: resolve(m[8]), amt: +m[9], spell: m[10], flags: flagsOf(m[12]) }); break;
      case "dot_anon": ev.push({ ts, k: "dmg", cat: "dot", src: null, tgt: resolve(m[8]), amt: +m[9], spell: m[10], flags: flagsOf(m[11]) }); break;
      case "miss":   ev.push({ ts, k: "miss", src: resolve(m[8]), verb: baseVerb(m[9]), tgt: resolve(m[10]), how: m[11].replace(/^YOU /, "").trim() }); break;
      case "heal": { const s = resolve(m[8]); ev.push({ ts, k: "heal", by: s, who: resolve(m[9], s), hot: !!m[10], amt: +m[11], pot: m[12] ? +m[12] : +m[11], spell: m[13] || "unknown", crit: /Critical/.test(m[14] || "") }); break; }
      case "heal_been": ev.push({ ts, k: "heal", by: null, who: resolve(m[8]), hot: !!m[9], amt: +m[10], pot: m[11] ? +m[11] : +m[10], spell: m[12] || "unknown", crit: /Critical/.test(m[13] || "") }); break;
      case "ds_rev": ev.push({ ts, k: "dmg", cat: "ds", src: null, tgt: resolve(m[8]), amt: +m[9], spell: "damage shield", flags: [] }); break;
      case "cast_you": castSet.add(m[8]); ev.push({ ts, k: "cast", spell: m[8] }); break;
      case "cast_other": ev.push({ ts, k: "castby", src: resolve(m[8]), spell: m[9] }); break;
      case "slain_you": ev.push({ ts, k: "kill", tgt: resolve(m[8]), src: owner }); break;
      case "slain_by":  ev.push({ ts, k: "kill", tgt: resolve(m[8]), src: resolve(m[9]) }); break;
      case "died":      ev.push({ ts, k: "kill", tgt: resolve(m[8]), src: null }); break;
      case "you_slain": ev.push({ ts, k: "death", by: resolve(m[8]) }); break;
      case "youdied":   ev.push({ ts, k: "death", by: "unknown" }); break;
      case "xp":     ev.push({ ts, k: "xp", pct: +m[8] }); break;
      case "con": { // strip the rare suffix (con-line-only), normalize he/she/it verdicts
        let nm = m[8], rare = false;
        const rm = /^(.*?) - a rare creature(?: \(Boss\))? ?-?$/.exec(nm);
        if (rm) { nm = rm[1]; rare = true; }
        const verdict = m[10].trim().replace(/^(?:he|she|it) appears/, "appears").replace(/^looks like (?:he|she|it) would/, "looks like it would");
        ev.push({ ts, k: "con", mob: resolve(nm), verdict, mlvl: +m[11], rare }); break; }
      case "coin": { const c = { platinum: 0, gold: 0, silver: 0, copper: 0 }; for (const [, n, d] of m[8].matchAll(COIN_RE)) c[d] += +n; ev.push({ ts, k: "coin", ...c }); break; }
      case "vendorsale": { const c = { platinum: 0, gold: 0, silver: 0, copper: 0 }; let any = false;
        for (const [, n, d] of m[8].matchAll(COIN_RE)) { c[d] += +n; any = true; }
        if (any) ev.push({ ts, k: "vendorsale", ...c, item: m[9] }); break; }
      case "questcoin": case "salvage": { const c = { platinum: 0, gold: 0, silver: 0, copper: 0 }; let any = false;
        for (const [, n, d] of m[8].matchAll(COIN_RE)) { c[d] += +n; any = true; }
        // no coin words = an ITEM handed over ("You receive the Sword...") — not money
        if (any) ev.push({ ts, k: "coinmisc", ...c }); break; }
      case "skillup": ev.push({ ts, k: "skillup", skill: m[8], val: +m[9] }); break;
      case "loot": { const sold = { platinum: 0, gold: 0, silver: 0, copper: 0 }; let anySold = false;
        if (m[12]) { for (const [, n, d] of m[12].matchAll(COIN_RE)) { sold[d] += +n; anySold = true; } }
        ev.push({ ts, k: "loot", qty: +(m[8] || 1), item: m[9], mob: resolve(m[10]), sold: anySold ? sold : null, depot: /depot/.test(m[11] || "") }); break; }
      // manual loot has no tail at all — always kept, never coin
      case "lootManual": ev.push({ ts, k: "loot", qty: +(m[8] || 1), item: m[9], mob: resolve(m[10]), sold: null, depot: false }); break;
      case "faction": ev.push({ ts, k: "faction", fac: m[8], delta: m[9] != null ? +m[9] : null, capped: m[10] || null }); break;
      case "aa":     ev.push({ ts, k: "aa", n: +m[8] }); break;
      // the zone-entry suffix is the difficulty tier: "Clan Crushbone 2
      // (Adaptive)" is base "Clan Crushbone", tier 2 (word and number always
      // agree in real logs) — without the split each tier reads as its own zone
      case "zone":   if (!/^(an area|an Arena|the Drunken Monkey)/.test(m[8])) {
        const tm = /^(.*) ([1-4]) \((?:Awakened|Adaptive|Fused|Refined)\)$/.exec(m[8]);
        ev.push(tm ? { ts, k: "zone", name: tm[1], tier: +tm[2] } : { ts, k: "zone", name: m[8], tier: 0 });
      } break;
      case "level":  ev.push({ ts, k: "level", lvl: +m[8] }); break;
      case "interrupt": ev.push({ ts, k: "interrupt", spell: m[8] }); break;
      case "resist": ev.push({ ts, k: "resist", tgt: resolve(m[8]), spell: m[9] }); break;
      case "stance": ev.push({ ts, k: "stance", name: m[8].trim() }); break;
      case "invoke": ev.push({ ts, k: "invoke", name: m[8].trim() }); break;
      // your spell fading off a NAME both refreshes its fight (like mez) and
      // marks a moment the name can change hands (a charm break) — buildClaims
      // treats every "shed" as a claim boundary
      case "wornoff": if (m[9]) ev.push({ ts, k: "shed", tgt: resolve(m[9]) }); break;
      case "mezzed": ev.push({ ts, k: "mez", tgt: resolve(m[8]) }); break;
      case "nonmelee_you": ev.push({ ts, k: "dmg", cat: "dot", src: null, tgt: owner, amt: +m[8], spell: "non-melee", flags: [] }); break;
      case "mend": ev.push({ ts, k: "mend", ok: m[8].includes("heal") }); break;
      // a blocked hostile cast is a "miss" against you — it feeds the avoided
      // tally and mob presence exactly like a dodged swing
      case "protected": ev.push({ ts, k: "miss", src: resolve(m[8]), tgt: owner, how: "protected" }); break;
      // your own /who line prints your CURRENT level — a hard anchor the
      // level timeline uses to recover after a silent loadout swap
      case "who": if (m[10] === owner || m[10] === fileOwner) { who = { lvl: +m[8], classes: m[9], name: m[10], race: m[11], zone: m[12] }; ev.push({ ts, k: "who", lvl: +m[8] }); } break;
      case "targeted": if (m[8] === "Player") players.add(resolve(m[9])); break;
      case "fizzle": case "nomana": ev.push({ ts, k: "nomana" }); break;
      case "ds_absorb": break; // an absorbed damage-shield tick — nothing to count
    }
  }
  if (who && who.name) owner = who.name;
  // Sentence-capitalization fold for bare common-noun mobs: "orc legionnaire"
  // prints "Orc legionnaire hits…" at line start and "…slash orc legionnaire"
  // mid-sentence — two rows for one mob. The lowercase variant having been
  // seen is the proof the capital is sentence case (a real name like "Lord
  // Darish" never prints lowercase), so fold Xxx → xxx only on that evidence.
  const NAME_KEYS = ["src", "tgt", "by", "who", "name", "mob"];
  const seenNames = new Set();
  for (const e of ev) for (const key of NAME_KEYS) if (e[key]) seenNames.add(e[key]);
  const foldCap = n => {
    if (!n || n.length < 2) return n;
    const lower = n[0].toLowerCase() + n.slice(1);
    return lower !== n && seenNames.has(lower) ? lower : n;
  };
  for (const e of ev) for (const key of NAME_KEYS) if (e[key]) e[key] = foldCap(e[key]);
  const refold = set => { for (const n of [...set]) { const f = foldCap(n); if (f !== n) { set.delete(n); set.add(f); } } };
  refold(told); refold(players);
  for (const e of ev) {
    if (e.k === "dmg" && e.cat === "spell" && e.src === owner && !castSet.has(e.spell)) e.cat = "proc";
    // crit-family tags per the live client's inline-flag format; Deadly
    // Strike and Finishing Blow are crit-grade (EQLogParser's IsCritKeyword
    // agrees), and (Finishing Blow) is observed in a real EQL log
    if (e.k === "dmg" && (e.flags || []).some(f => /Critical|Crippling|Slay|Deadly Strike|Finishing Blow/.test(f))) e.crit = true;
  }
  // names that are demonstrably mobs: article/space/"pet" shapes seen in
  // combat, plus single-word names YOUR side killed (named NPCs like Hadden).
  // Exclusions: names the target window typed (Player), and names that told
  // you "Master" — your own pet dying to a mob would otherwise enter here.
  // A PC-shaped name killed by a mob is most likely a dead player, not a mob.
  const mobSet = new Set();
  const shapeMob = n => !!n && (/^an? /.test(n) || n.includes(" ") || n.endsWith(" pet"));
  for (const e of ev) {
    if (e.k === "tell" || e.k === "antitell") continue;
    for (const n of [e.src, e.tgt]) if (shapeMob(n) && !players.has(n)) mobSet.add(n);
    if (e.k === "kill" && e.tgt && e.tgt !== owner && !told.has(e.tgt) && !players.has(e.tgt) &&
        (!PC_NAME.test(e.tgt) || e.src === owner || told.has(e.src))) mobSet.add(e.tgt);
  }
  // XP printed in the same second as a ding is the post-level rollover
  // remainder, not the kill's value — flagged here, excluded from per-mob
  // averages in buildMobStats (still real XP, so totals keep it)
  const dingSecs = new Set(ev.filter(e => e.k === "level").map(e => e.ts.getTime()));
  for (const e of ev) if (e.k === "xp" && dingSecs.has(e.ts.getTime())) e.rollover = true;
  return { owner, who, told, players, events: ev, unparsedCombat, mobSet };
}

/* ─── claims: whose side is an actor on, and WHEN ──────────────────────────
   The one surefire signal that an actor is yours is its second-person tell:
   "<name> told you, '…, Master.'" The client shows you nobody's pet tells
   but your own, and players can't produce the past-tense form. Ambient
   /says ("At your service Master.") reach everyone standing nearby, so they
   never claim — at a two-mage camp they would hand you the other mage's
   pet. That exact failure shipped once: a mob-fights-mobs heuristic claimed
   another player's charmed evil eye on the reference log. Surefire or
   nothing; a pet that never answered an order stays unclaimed, and the
   footer tells the player one /pet attack fixes that.

   A claim is an INTERVAL, not a name: summoned-pet names come from a shared
   generator and charm hands mobs back, so "yours" has a start and an end.
   The claim covers the actor's whole presence episode around its tells —
   backdated to the last boundary, so the swings between summon (or charm)
   and your first order still count. Boundaries are the moments an actor can
   change hands:
     · its death line
     · you zoned or died (charm breaks on your death; a summoned pet that
       survives re-claims itself with its next tell)
     · your spell wearing off it (the charm-break line)
     · it damaging YOU — a charmed pet never hits its master; a broken one does
   Within one episode two same-named actors can't be told apart in a text
   log; that is the same limitation fights have, and the footer says so. */
function buildClaims(P) {
  const open = new Map();   // name -> { t0, tells, anti }
  const claims = new Map(); // name -> [{ t0, t1, tells }]
  let lastTs = null;
  const push = (name, st, t1) => {
    if (!st.tells || st.anti) return;
    if (!claims.has(name)) claims.set(name, []);
    claims.get(name).push({ t0: st.t0, t1, tells: st.tells });
  };
  // Timestamps are whole seconds, and a killing blow prints in the SAME
  // second as the death line — so a death/shed/zone boundary includes its
  // own second (the actor was still yours while that second's swings
  // landed). The it-hit-YOU boundary excludes its second: the triggering
  // hit belongs to the broken charm, not to you.
  const cut = (name, ts, incl) => {
    const st = open.get(name);
    if (st) { push(name, st, incl ? new Date(ts.getTime() + 1000) : ts); open.delete(name); }
  };
  const touch = (name, ts) => {
    if (!name || name === P.owner) return null;
    let st = open.get(name);
    if (!st) { st = { t0: ts, tells: 0, anti: false }; open.set(name, st); }
    return st;
  };
  for (const e of P.events) {
    lastTs = e.ts;
    switch (e.k) {
      case "zone": case "death": // you moved on or died — every episode ends
        for (const name of [...open.keys()]) cut(name, e.ts, true);
        break;
      case "tell": { const st = touch(e.name, e.ts); if (st) st.tells++; break; }
      case "antitell": { const st = touch(e.name, e.ts); if (st) st.anti = true; break; }
      case "shed": touch(e.tgt, e.ts); cut(e.tgt, e.ts, true); break;
      case "kill":
        if (e.tgt) { touch(e.tgt, e.ts); cut(e.tgt, e.ts, true); }
        if (e.src) touch(e.src, e.ts);
        break;
      case "dmg":
        if (e.src && e.tgt === P.owner) { touch(e.src, e.ts); cut(e.src, e.ts, false); break; }
        /* falls through — a normal damage event is just presence */
      case "miss": touch(e.src, e.ts); touch(e.tgt, e.ts); break;
      case "heal": touch(e.by, e.ts); touch(e.who, e.ts); break;
      case "castby": touch(e.src, e.ts); break;
      case "resist": case "mez": touch(e.tgt, e.ts); break;
    }
  }
  if (lastTs) { const end = new Date(lastTs.getTime() + 1000); for (const name of [...open.keys()]) cut(name, end); }
  const at = (name, ts) => {
    const list = claims.get(name);
    if (!list) return false;
    for (const iv of list) if (ts >= iv.t0 && ts < iv.t1) return true;
    return false;
  };
  // roster for the who-line and tooltips, newest claim last-seen first
  const names = [];
  for (const [name, list] of claims) {
    names.push({ name, kind: P.mobSet.has(name) ? "charm" : "pet",
                 tells: list.reduce((a, iv) => a + iv.tells, 0),
                 from: list[0].t0, to: list[list.length - 1].t1 });
  }
  names.sort((x, y) => y.to - x.to);
  return { at, names, map: claims };
}

function mkSide(P, claims) {
  const side = e => {
    if (e.src === P.owner) return "you";
    if (!e.src) return "other";
    if (claims.at(e.src, e.ts)) return P.mobSet.has(e.src) ? "charm" : "pet";
    if (P.mobSet.has(e.src) && e.tgt && P.mobSet.has(e.tgt)) return "othermob";
    return "other";
  };
  side.claims = claims;
  return side;
}

/* ─── fights: one per mob encounter, closed by its death line ──────────────*/
// A kill prints a same-second burst of xp/coin/faction lines, often BEFORE its
// death line; the burst carries the kill's XP and coin. A burst with no death
// line anywhere near it, right where a fight was active, is a silent kill.
const FIGHT_IDLE = 45; // s without any event touching the mob (mez refreshes it)
// Log timestamps are whole seconds, so an epoch-second integer is the exact
// clock the log itself ticks on — HP/DPS math never introduces a fraction.
const epochSec = ts => Math.round(ts.getTime() / 1000);
function buildFights(P, side) {
  const fights = [], open = new Map();
  let zone = null, tier = 0, zv = -1;
  const sec = ts => ts.getTime() / 1000;
  const deathTs = P.events.filter(e => e.k === "kill" && e.tgt !== P.owner).map(e => sec(e.ts));
  const clusters = [];
  for (const e of P.events) {
    if (e.k !== "xp" && e.k !== "coin" && e.k !== "faction") continue;
    const t = sec(e.ts), xp = e.k === "xp" ? e.pct : 0, coin = e.k === "coin" ? inCopper(e) : 0;
    const c = clusters[clusters.length - 1];
    if (c && t - c.t1 <= 2) { c.t1 = t; c.xp += xp; c.coin += coin; c.roll = c.roll || !!e.rollover; }
    else clusters.push({ t0: t, t1: t, xp, coin, claimed: false, roll: !!e.rollover });
  }
  let di = 0;
  for (const c of clusters) {
    while (di < deathTs.length && deathTs[di] < c.t0 - 2) di++;
    c.nearDeath = di < deathTs.length && deathTs[di] <= c.t1 + 2;
  }
  const clusterAt = (t, w) => clusters.find(c => c.t0 - w <= t && t <= c.t1 + w) || null;
  const close = (key, end, killer, killed) => {
    const f = open.get(key); if (!f) return null;
    open.delete(key);
    f.end = end;
    if (killed) { f.killer = killer; f.killed = true; }
    // The mob's offensive window runs from its first swing to the end of the
    // fight — the death second for a kill, its last event otherwise. It is NOT
    // the fight's own span: a mob that stood there for 20s before it noticed
    // us was not dealing damage for those 20s, and dividing by them would
    // under-report what it hits for.
    f.offSecs = f.offT0 == null ? 0 : epochSec(end) - f.offT0;
    // HP bounds. Everything the mob lost minus everything it got back is the
    // most it could have had (hp_max); the killing blow proves it had at most
    // that much, and at least enough to still be standing before it (hp_min).
    // Only a KILL bounds anything — a fight the mob walked away from says only
    // "more than this". A tainted fight still gets bounds computed here; the
    // per-mob aggregate is where taint decides what to trust.
    if (f.killed && f.lastBlow != null) {
      f.hpMax = f.dmgAll - f.healed;
      f.hpMin = Math.max(1, f.hpMax - f.lastBlow + 1);
    }
    f.dotKeys = null; // tick-stack bookkeeping is per-fight and dies with it
    fights.push(f);
    return f;
  };
  // level and combo are stamped at fight OPEN from the current event — the
  // events are pre-tagged by buildSegments, and index-precise stamping is the
  // only way a fight whose opening blow shares a second with a ding lands in
  // the right level bucket (a timestamp lookup ties to the wrong side)
  let lvlNow = null, comboNow = null;
  const touch = (name, ts) => {
    let f = open.get(name);
    // dmgAll/lastBlow/healed feed the HP bounds; offTotal/offT0/offSecs/maxHit
    // are the mob's own output; dotKeys/dotStack/tainted are the "is this one
    // mob or two wearing the same name" audit. All are per-encounter — the
    // per-mob roll-up in buildMobStats is what the UI reads.
    if (!f) { f = { mob: name, zone, tier, zv: zv < 0 ? null : zv, lvl: lvlNow, combo: comboNow, start: ts, end: ts, last: ts, dmg: { you: 0, pet: 0, charm: 0 }, taken: 0, xp: 0, coin: 0, killed: false, inferred: false,
      dmgAll: 0, lastBlow: null, healed: 0, offTotal: 0, offT0: null, offSecs: 0, maxHit: 0, dotKeys: null, dotStack: false, tainted: false, hpMin: null, hpMax: null }; open.set(name, f); }
    f.last = f.end = ts;
    return f;
  };
  for (const e of P.events) {
    const t = e.ts;
    lvlNow = e.lvl === undefined ? null : e.lvl;
    comboNow = e.combo || null;
    for (const [key, f] of open) if ((t - f.last) / 1000 > FIGHT_IDLE) close(key, f.last);
    if (e.k === "zone") { zone = e.name; tier = e.tier; zv++; continue; }
    if (e.k === "xp" || e.k === "coin" || e.k === "faction") {
      const c = clusterAt(sec(t), 0);
      if (c && !c.nearDeath && !c.claimed) {
        let cand = null;
        for (const [, f] of open) if ((t - f.last) / 1000 <= 3 && (!cand || f.last > cand.last)) cand = f;
        if (cand) {
          c.claimed = true;
          const f = close(cand.mob, t, P.owner, true);
          f.inferred = true; f.xp += c.xp; f.coin += c.coin; if (c.roll) f.xpRoll = true;
        }
      }
      continue;
    }
    if (e.k === "kill" && e.tgt && P.mobSet.has(e.tgt)) {
      // a kill we never engaged with and didn't make: someone else's fight
      if (!open.has(e.tgt) && !(e.src === P.owner || side.claims.at(e.src, e.ts))) continue;
      touch(e.tgt, t);
      const f = close(e.tgt, t, e.src, true);
      const c = clusterAt(sec(t), 2);
      if (c && !c.claimed) {
        c.claimed = true; f.xp += c.xp; f.coin += c.coin; if (c.roll) f.xpRoll = true;
        // xp/coin/faction print only for kills the server credited to YOU — a
        // bare "<mob> died." names no killer, but its claimed burst names you
        if (!f.killer) f.killer = P.owner;
      }
      continue;
    }
    // A heal ON a mob subtracts from what we made it lose, so the HP bound has
    // to see it. It only counts against a fight that is ALREADY open and it
    // does not touch() — a heal is not evidence of an encounter (a passing
    // healer topping up a mob we never engaged would otherwise invent a fight),
    // and refreshing the idle clock off a heal would move existing fight
    // boundaries. Failure mode: a heal landing in the gap between two fights of
    // the same mob is dropped rather than guessed onto one of them.
    if (e.k === "heal" && e.who && open.has(e.who)) open.get(e.who).healed += e.amt;
    if (e.k === "dmg" || e.k === "miss" || e.k === "mez" || e.k === "shed") {
      for (const name of [e.src, e.tgt]) if (name && name !== P.owner && P.mobSet.has(name)) touch(name, t);
      if (e.k === "dmg" && e.tgt && P.mobSet.has(e.tgt)) {
        const s = side(e);
        const ft = open.get(e.tgt);
        if (s === "you" || s === "pet" || s === "charm") ft.dmg[s] += e.amt;
        // HP is a property of the MOB, not of our contribution: every point it
        // lost counts, whoever landed it (another player, an unclaimed pet, a
        // damage shield, a DoT). lastBlow is the last of them to land before
        // the fight closes — on a kill that is the killing blow, which is the
        // only line in the log that says "this was enough".
        ft.dmgAll += e.amt;
        ft.lastBlow = e.amt;
        // Tick-stack taint. One caster's DoT ticks a given entity once per
        // tick, so the same (second, spell, caster) landing twice on one name
        // means two mobs are wearing that name and this fight's totals are a
        // blend of both. Caster identity is the event's own src: the "your"
        // form resolves to the owner, the "from <Spell> by <Caster>" form to
        // that caster, and the anonymous form has no caster to distinguish, so
        // every anonymous tick keys together (the pessimistic side — it can
        // over-flag, never silently trust a blended fight).
        if (e.cat === "dot") {
          const dk = `${epochSec(t)}|${e.spell}|${e.src || "anon"}`;
          if (!ft.dotKeys) ft.dotKeys = new Set();
          if (ft.dotKeys.has(dk)) ft.dotStack = true; else ft.dotKeys.add(dk);
        }
      }
      if (e.k === "dmg" && e.tgt === P.owner && e.src && open.has(e.src)) open.get(e.src).taken += e.amt;
      // What the MOB puts out, at anyone — you, a pet, a charm, another mob.
      // (`taken` above stays owner-only; this is the separate question of how
      // hard the mob hits.) A miss starts the clock but adds no damage: the
      // swing happened, so the mob was already in combat, and counting the
      // swing-time is the whole point of an offensive-seconds denominator.
      if ((e.k === "dmg" || e.k === "miss") && e.src && open.has(e.src)) {
        const fo = open.get(e.src);
        if (fo.offT0 == null) fo.offT0 = epochSec(t);
        if (e.k === "dmg") {
          fo.offTotal += e.amt;
          // max hit is a MELEE reading — the number a player wants is "how big
          // a swing can this thing land", and a nuke or a DoT tick is neither
          // a swing nor mitigable the same way.
          if (e.cat === "melee" && e.amt > fo.maxHit) fo.maxHit = e.amt;
        }
      }
    }
  }
  for (const [key, f] of open) close(key, f.last);
  fights.forEach(f => { f.total = f.dmg.you + f.dmg.pet + f.dmg.charm; });
  markTaint(fights, P);
  return fights;
}
// A text log identifies a mob by its NAME, and a camp with two "a decaying
// skeleton" in it hands both of them to one fight object. That is fine for a
// damage meter (the damage happened either way) and fatal for an HP bound,
// which is arithmetic on the assumption that one entity absorbed every point.
// Taint marks the fights where the assumption is visibly unsafe, so the
// aggregate can drop them instead of averaging a lie.
const TAINT_SEC = 10; // chosen bound, not a measured one: wide enough to catch
// a trailing DoT tick or an immediate re-pull, short enough that an unrelated
// pull a minute later doesn't condemn a clean fight.
function markTaint(fights, P) {
  // every second at which a name appears in a damage or miss event, ascending
  // (P.events is chronological, so appending in order keeps it sorted)
  const seen = new Map();
  for (const e of P.events) {
    if (e.k !== "dmg" && e.k !== "miss") continue;
    const s = epochSec(e.ts);
    for (const n of [e.src, e.tgt]) {
      if (!n) continue;
      let a = seen.get(n); if (!a) { a = []; seen.set(n, a); }
      if (a[a.length - 1] !== s) a.push(s);
    }
  }
  const lastKill = new Map(); // name -> death second of its previous killed fight
  for (const f of fights) {
    if (!f.killed) continue;
    const d = epochSec(f.end);
    // (a) after-death contamination: a corpse cannot swing or be swung at, so
    // the name still trading blows after its death line is a second mob that
    // was in this fight's numbers all along. Strictly after — the killing blow
    // prints in the same second as the death line.
    const arr = seen.get(f.mob) || [];
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= d) lo = mid + 1; else hi = mid; }
    const after = lo < arr.length && arr[lo] <= d + TAINT_SEC;
    // (b) split risk: we opened on this name again within seconds of killing
    // one, so the previous mob's trailing effects (DoT ticks, a damage-shield
    // proc) land inside this fight and inflate its damage total.
    const prev = lastKill.get(f.mob);
    const split = prev != null && epochSec(f.start) - prev <= TAINT_SEC;
    f.tainted = after || split || f.dotStack;
    lastKill.set(f.mob, d);
  }
}
// A fight's identity is (mob, start second) — stable across live-watch
// re-parses. Array position is NOT: fights still open at the data boundary
// force-close early and renumber every poll, and the 40 MB tail window
// sliding forward renumbers everything (measured: 28% of simulated polls on
// the reference log swapped which mob a positional id named).
const fkey = f => `${f.start.getTime()}~${f.mob}`;

/* ─── per-mob aggregate: kills, xp, coin, drops ────────────────────────────
   The drop-rate denominator is KILLS SEEN. The log has no line for opening
   an empty corpse, so "corpses looted" is unknowable — a corpse you never
   opened still counts as a kill, and observed rates can only run LOW. Coin
   and XP averages only count what the kill-burst clusters tied to a fight;
   coin looted minutes later attributes to nothing rather than to a guess. */
function buildMobStats(fights, lootEvents, conEvents) {
  const agg = new Map();
  for (const f of fights) {
    let g = agg.get(f.mob);
    if (!g) { g = { mob: f.mob, zone: f.zone, kills: 0, fights: 0, dmg: 0, taken: 0, xp: 0, xpKills: 0, rollKills: 0, coin: 0, coinKills: 0, secs: 0, tiers: new Set(), enc: [], drops: new Map(), lvls: null, rare: false,
      offSum: 0, offSecsSum: 0, maxHit: 0, hpFights: [], hp: null }; agg.set(f.mob, g); }
    g.fights++; if (f.killed) g.kills++;
    g.dmg += f.total; g.taken += f.taken; g.secs += (f.end - f.start) / 1000;
    // Offense sums over EVERY fight, killed or not, tainted or not: a fight we
    // fled and a fight shared with a twin still both show real swings landing
    // for real amounts, and the mob's damage output is not an inference about
    // one entity the way its HP total is. Sums are stored raw; the division
    // (off_sum / off_secs_sum) happens in display so a short fight can't be
    // averaged in as if it weighed the same as a long one.
    g.offSum += f.offTotal; g.offSecsSum += f.offSecs;
    if (f.maxHit > g.maxHit) g.maxHit = f.maxHit;
    // HP measurements only from clean kills — a tainted fight's damage total
    // belongs to two mobs, so its bound is arithmetic about nothing.
    if (f.killed && !f.tainted && f.hpMax != null) g.hpFights.push(f);
    // rollover fights (their XP line was a post-ding remainder) stay out of
    // the average — numerator AND denominator — so a level-crossing kill
    // can't drag the mob's per-kill XP down
    if (f.xp && !f.xpRoll) { g.xp += f.xp; g.xpKills++; }
    else if (f.xp) g.rollKills++;
    if (f.coin) { g.coin += f.coin; g.coinKills++; }
    if (f.zone) { g.zone = f.zone; g.tiers.add(f.tier || 0); }
    g.enc.push(f);
  }
  for (const e of lootEvents) {
    const g = agg.get(e.mob);
    if (!g) continue; // looted a corpse we never fought — no denominator
    const d = g.drops.get(e.item) || { item: e.item, times: 0, qty: 0 };
    d.times++; d.qty += e.qty;
    g.drops.set(e.item, d);
  }
  // mob level is a readout of the player's own /con lines — nothing else in
  // the log states a level. Same-name spawns span levels, so it's a range.
  for (const e of conEvents || []) {
    const g = agg.get(e.mob);
    if (!g) continue;
    if (!g.lvls) g.lvls = { lo: e.mlvl, hi: e.mlvl, n: 0 };
    g.lvls.lo = Math.min(g.lvls.lo, e.mlvl); g.lvls.hi = Math.max(g.lvls.hi, e.mlvl); g.lvls.n++;
    if (e.rare) g.rare = true;
  }
  for (const g of agg.values()) resolveHp(g);
  return [...agg.values()].sort((x, y) => y.kills - x.kills || y.dmg - x.dmg);
}
/* Every clean kill of a mob is an independent measurement of the SAME number,
   so the honest combination is the INTERSECTION of the per-kill bounds, not an
   average of them: the answer has to satisfy all of them at once, and each
   extra kill can only narrow it.

   An empty intersection is a finding, not noise — it means the name covers
   more than one thing (a level range, a variant, a rare version), so no single
   HP value could have produced all these kills. Averaging there would invent a
   number that describes none of the spawns. Instead the fights are clustered:
   walk them in chronological order and drop each into the first cluster whose
   running intersection survives it, else start a new one; report the cluster
   with the most fights and flag the result mixed so the reader knows the name
   is not one creature. Ties keep the earliest cluster — arbitrary, but stable,
   which is what a re-parse during live-watch needs. */
function resolveHp(g) {
  const hf = g.hpFights;
  if (!hf.length) return;
  let lo = -Infinity, hi = Infinity;
  for (const f of hf) { lo = Math.max(lo, f.hpMin); hi = Math.min(hi, f.hpMax); }
  if (lo <= hi) { g.hp = [lo, hi, hf.length, 0]; return; }
  const cl = [];
  for (const f of hf) {
    let placed = false;
    for (const c of cl) {
      const nlo = Math.max(c.lo, f.hpMin), nhi = Math.min(c.hi, f.hpMax);
      if (nlo <= nhi) { c.lo = nlo; c.hi = nhi; c.n++; placed = true; break; }
    }
    if (!placed) cl.push({ lo: f.hpMin, hi: f.hpMax, n: 1 });
  }
  let best = cl[0];
  for (const c of cl) if (c.n > best.n) best = c; // strict >: first (earliest) cluster wins a tie
  g.hp = [best.lo, best.hi, best.n, 1];
}

/* ─── con-verdict bands (generated data — build_con_bands.py) ──────────────
   The band model detects silent loadout swaps: a run of considers that can't
   coexist with the assumed level. Samples come from the XP project's
   ding-anchored spans (the only measured meaning of each verdict); the
   pooling, slack, and scoring constants match xp_zem_extract.py so the two
   agree about what contradicts. No bands file → no swap detection; cons
   still give mob levels. */
let BANDS = null, bandsPromise = null;
function loadConBands() {
  if (bandsPromise) return bandsPromise;
  bandsPromise = fetch("/log-parser/data/con-bands.json")
    .then(r => r.ok ? r.json() : null).then(d => { BANDS = d || null; })
    .catch(() => { BANDS = null; });
  return bandsPromise;
}
function setConBands(d) { BANDS = d; } // the node harness injects the file here
function conBand(phrase, pl) {
  const rows = BANDS && BANDS.phrases[phrase];
  if (!rows || !rows.length) return null; // phrase never measured: uninformative
  let deltas = rows.filter(r => Math.abs(r[0] - pl) <= 4).map(r => r[1]), slack = 1;
  if (!deltas.length) { deltas = rows.map(r => r[1]); slack = 2; }
  let lo = Math.min(...deltas), hi = Math.max(...deltas);
  // open-ended phrases bound the gap on one side only — a tombstone can be
  // +6 or +30, so it can never contradict upward, nor "could probably win" down
  if (phrase === BANDS.open_high) hi = 999;
  if (phrase === BANDS.open_low) lo = -999;
  return { lo, hi, slack };
}
function conScore(phrase, pl, delta) {
  const b = conBand(phrase, pl);
  if (!b) return 0;
  if (delta >= b.lo && delta <= b.hi) return 0;
  const dist = delta > b.hi ? delta - b.hi : b.lo - delta;
  return dist <= b.slack ? -0.7 : -2 * Math.min(dist, 8);
}
// only a narrow band can CONFIRM a level; open-ended verdicts merely fail to
// contradict it, so they never advance the last-known-good marker
function conDiscriminative(phrase, pl) { const b = conBand(phrase, pl); return !!b && b.hi - b.lo <= 8; }

/* ─── level timeline: anchors, cuts, backfills ─────────────────────────────
   Dings alone mislabel everything after a silent loadout swap (40→10 prints
   nothing). Anchors set the level forward: a ding, or your own /who line.
   A cut sets it to UNKNOWN: three consecutive cons each strongly incompatible
   (score ≤ −4) with the assumed level. The stretch between the last
   discriminative in-band con and the first contradicting one is the swap
   buffer — the swap happened somewhere in it, so it stays unknown forever.
   From the first contradicting con to the next anchor is also unknown but
   BACKFILLS from that anchor (ding to N ⇒ N−1, who at L ⇒ L) — the same
   assumption the pre-first-ding rule always made: no second swap inside.
   Cons are not re-scored inside backfilled spans; a second swap with no
   anchor between goes undetected (xp_zem_extract.py does better, with a
   corpus behind it — this tool only ever STOPS claiming a level, it never
   guesses one from cons). */
function buildLevelSpans(ev) {
  const bounds = [{ i: 0, lvl: null, src: null }];
  let cur = null, anchorI = -1, badRun = 0, firstBad = -1, lastGood = -1;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.k === "level" || e.k === "who") {
      bounds.push({ i, lvl: e.lvl, src: e.k === "level" ? "ding" : "who" });
      cur = e.lvl; anchorI = i; badRun = 0; firstBad = -1; lastGood = -1;
      continue;
    }
    if (e.k !== "con" || cur == null || !BANDS) continue;
    if (conScore(e.verdict, cur, e.mlvl - cur) <= -4) {
      if (!badRun) firstBad = i;
      if (++badRun >= 3) {
        // the anchor event itself was certainly at its level, so the buffer
        // starts no earlier than the event after it
        const bufStart = Math.max(lastGood + 1, anchorI + 1);
        if (firstBad > bufStart) bounds.push({ i: bufStart, lvl: null, src: "swap" });
        bounds.push({ i: firstBad, lvl: null, src: firstBad > bufStart ? "post" : "swap" });
        cur = null; badRun = 0; firstBad = -1;
      }
    } else {
      badRun = 0; firstBad = -1;
      if (conDiscriminative(e.verdict, cur)) lastGood = i;
    }
  }
  const spans = [];
  for (let b = 0; b < bounds.length; b++) {
    const i0 = bounds[b].i, i1 = b + 1 < bounds.length ? bounds[b + 1].i : ev.length;
    if (i1 > i0) spans.push({ i0, i1, lvl: bounds[b].lvl, src: bounds[b].src });
  }
  for (let s = 0; s < spans.length; s++) {
    const sp = spans[s], nxt = spans[s + 1];
    if (sp.lvl != null || sp.src === "swap" || !nxt || nxt.lvl == null) continue;
    if (nxt.src === "ding") { sp.lvl = nxt.lvl - 1; sp.src = "backfill"; }
    else if (nxt.src === "who") { sp.lvl = nxt.lvl; sp.src = "backfill"; }
  }
  return spans;
}

/* ─── segment: levels, zones/visits, stance/invocation combos ──────────────*/
function buildSegments(P, side) {
  const ev = P.events;
  // zone visits: every zone-entry line starts a new visit (returning after a
  // death or gate is a new visit of the same zone)
  let vi = -1, zn = null, zt = 0;
  const visits = [];
  for (const e of ev) {
    if (e.k === "zone") { vi++; zn = e.name; zt = e.tier; visits.push({ id: vi, name: zn, tier: zt, ts: e.ts }); }
    e.zone = zn; e.ztier = zn ? zt : null; e.zv = zn ? vi : null;
  }
  const spans = buildLevelSpans(ev);
  for (const sp of spans) for (let i = sp.i0; i < sp.i1; i++) ev[i].lvl = sp.lvl;
  const swaps = spans.filter(sp => sp.src === "swap" || sp.src === "post");
  const swapAt = swaps.length ? ev[swaps[0].i0].ts : null;
  const dings = ev.filter(e => e.k === "level").map(e => ({ lvl: e.lvl, ts: e.ts }));
  const stanceTl = ev.filter(e => e.k === "stance").map(e => [e.ts, e.name]);
  const invokeTl = ev.filter(e => e.k === "invoke").map(e => [e.ts, e.name]);
  const activeAt = (tl, ts) => { let n = null; for (const [t, x] of tl) { if (t <= ts) n = x; else break; } return n; };
  // events must carry lvl and combo BEFORE fights build — buildFights stamps
  // both onto each fight at its opening event
  for (const e of ev) {
    e.stance = activeAt(stanceTl, e.ts); e.invoke = activeAt(invokeTl, e.ts);
    e.combo = `${e.stance || "—"}  ·  ${e.invoke || "—"}`;
  }
  const fights = buildFights(P, side);
  const levels = [...new Set(ev.map(e => e.lvl).filter(v => v != null))].sort((a, b) => a - b);
  const hasUnknown = ev.some(e => e.lvl == null) && (levels.length > 0);
  return { dings, levels, hasUnknown, spans, swapAt, visits, stanceTl, invokeTl, fights };
}

/* ─── class attribution (spell name → which of owner's 3 classes) ─────────*/
let ICON = null, SPCLASS = null;
async function loadSpellData() {
  if (ICON) return;
  ICON = new Map(); SPCLASS = new Map();
  try {
    const spells = await (await fetch("/spellmaster/data/spells.json")).json();
    for (const s of spells) {
      if (!s.n) continue;
      const k = s.n.toLowerCase();
      if (s.icon != null) ICON.set(k, s.icon);
      if (s.cls) SPCLASS.set(k, Object.keys(s.cls).map(id => CLASS_ABBR[+id]).filter(Boolean));
    }
  } catch { /* icons/class are a nicety; degrade silently */ }
}
function classOf(spell, ownerClasses) {
  if (!spell || !SPCLASS) return null;
  const cl = SPCLASS.get(spell.toLowerCase());
  if (!cl) return null;
  // Only attribute to a class the owner ACTUALLY has. No intersection → null
  // (falls to the honest "other" bucket) rather than inventing a class.
  if (ownerClasses) { const hit = cl.filter(c => ownerClasses.includes(c)); return hit.length ? hit[0] : null; }
  return cl[0];
}

/* ─── analysis ────────────────────────────────────────────────────────────*/
// DPS denominator = time spanned by the team's damage events. Gaps >30s don't count.
function combatSecondsOf(events, side) {
  const team = new Set(["you", "pet", "charm"]);
  const c = events.filter(e => (e.k === "dmg" || e.k === "miss") && team.has(side(e))).map(e => e.ts).sort((a, b) => a - b);
  let sec = 0, s = null, last = null;
  for (const t of c) { if (last && (t - last) / 1000 > 30) { sec += (last - s) / 1000 + 1; s = t; } if (!s) s = t; last = t; }
  if (s) sec += (last - s) / 1000 + 1;
  return sec;
}
const MIN_RATE_SEC = 5; // below this, a window is too short to quote a DPS for
const rateDps = (dmg, sec) => sec >= MIN_RATE_SEC ? fmt(dmg / sec) : "—";
function analyze(P, events, side, ownerClasses) {
  const src = new Map();
  const tot = { you: 0, pet: 0, charm: 0 };
  const buckets = { melee: 0, skill: 0, ranged: 0, cast: 0, proc: 0, dot: 0, ds: 0, pet: 0, charm: 0 };
  const elem = new Map(), byClass = new Map();
  const big = { melee: null, ranged: null, spell: null, dot: null, heal: null };
  for (const e of events) {
    if (e.k !== "dmg") continue;
    const s = side(e);
    if (s !== "you" && s !== "pet" && s !== "charm") continue;
    if (!P.mobSet.has(e.tgt)) continue; // only damage to enemies goes on the meter
    // Pet melee groups into ONE row: summoned-pet names come from a shared
    // generator and change every summon, so per-name rows fragment the same
    // pet across a session. Charm keeps its name — a mob's name says what it
    // IS, and which mob charms best is the interesting question. YOUR skill
    // verbs (kick, strike, backstab…) each get a row named by the verb the
    // log prints; weapon swings split by verb too — the verb is the weapon's
    // damage type, so different weapon types in each hand show as two rows
    // (the log never says which hand). Bow shots are "ranged". Pets keep one
    // row regardless — splitting a pet's kicks from its punches fragments
    // without informing.
    const phys = e.cat === "melee" || e.cat === "ranged";
    const nm = s === "charm" ? e.src
      : phys ? (s === "pet" ? "pet auto-attack"
        : e.cat === "ranged" ? "ranged"
        : SKILL_VERBS.has(e.verb) ? e.verb : `auto-attack (${e.verb})`)
      : e.spell || "unknown";
    const key = `${s}|${nm}`;
    const row = src.get(key) || { name: nm, side: s, cat: e.cat, elem: e.elem || (phys ? "physical" : "—"), hits: 0, dmg: 0, crit: 0, max: 0, actors: null, sub: null };
    row.hits++; row.dmg += e.amt; if (e.crit) row.crit++; if (e.amt > row.max) row.max = e.amt; if (e.elem) row.elem = e.elem;
    if (s !== "you") {
      row.actors = row.actors || new Map(); row.actors.set(e.src, (row.actors.get(e.src) || 0) + e.amt);
      // grouped rows still collect the full per-verb/per-spell split — the
      // row expands to it, so grouping costs the reader nothing
      const subName = phys ? (e.cat === "ranged" ? "ranged" : SKILL_VERBS.has(e.verb) ? e.verb : `auto-attack (${e.verb})`) : e.spell || "unknown";
      row.sub = row.sub || new Map();
      const sr = row.sub.get(subName) || { name: subName, hits: 0, dmg: 0, crit: 0, max: 0 };
      sr.hits++; sr.dmg += e.amt; if (e.crit) sr.crit++; if (e.amt > sr.max) sr.max = e.amt;
      row.sub.set(subName, sr);
    }
    src.set(key, row);
    tot[s] += e.amt;
    if (s === "you") {
      buckets[e.cat === "melee" ? (SKILL_VERBS.has(e.verb) ? "skill" : "melee") : e.cat === "spell" ? "cast" : e.cat] += e.amt;
      const cls = classOf(e.spell, ownerClasses) || (phys ? "melee" : "other");
      byClass.set(cls, (byClass.get(cls) || 0) + e.amt);
      const slot = e.cat === "melee" ? "melee" : e.cat === "ranged" ? "ranged" : e.cat === "dot" ? "dot" : e.cat === "spell" ? "spell" : null;
      if (slot && (!big[slot] || e.amt > big[slot].amt)) big[slot] = { amt: e.amt, name: nm, crit: e.crit };
    } else { buckets[s] += e.amt; byClass.set(s, (byClass.get(s) || 0) + e.amt); }
    const el = e.elem || (phys ? "physical" : "magic");
    elem.set(el, (elem.get(el) || 0) + e.amt);
  }
  const total = tot.you + tot.pet + tot.charm;
  const mHit = events.filter(e => e.k === "dmg" && e.src === P.owner && e.cat === "melee");
  const mMiss = events.filter(e => e.k === "miss" && e.src === P.owner && !RANGED_VERBS.has(e.verb)).length;
  // per-verb landed/missed for your rows — a monk's kick hit rate is a
  // different question from their weapon's, and with two weapon types the
  // per-weapon-verb split is the closest the log gets to mainhand/offhand
  const skills = new Map(), weapons = new Map();
  const verbRow = (map, vb) => { let s = map.get(vb); if (!s) { s = { verb: vb, landed: 0, missed: 0, dmg: 0, max: 0 }; map.set(vb, s); } return s; };
  const ranged = { landed: 0, missed: 0, dmg: 0, max: 0 };
  const mend = { ok: 0, fail: 0 };
  for (const e of events) {
    if (e.k === "mend") { mend[e.ok ? "ok" : "fail"]++; continue; }
    if (e.src !== P.owner || !e.verb) continue;
    const map = SKILL_VERBS.has(e.verb) ? skills : RANGED_VERBS.has(e.verb) ? null : weapons;
    if (e.k === "dmg" && e.cat === "ranged") { ranged.landed++; ranged.dmg += e.amt; if (e.amt > ranged.max) ranged.max = e.amt; }
    else if (e.k === "miss" && !map) ranged.missed++;
    else if (e.k === "dmg" && e.cat === "melee") { const s = verbRow(map, e.verb); s.landed++; s.dmg += e.amt; if (e.amt > s.max) s.max = e.amt; }
    else if (e.k === "miss" && e.how !== "protected") verbRow(map, e.verb).missed++;
  }
  const casts = events.filter(e => e.k === "cast").length;
  const interrupts = events.filter(e => e.k === "interrupt").length;
  const resists = events.filter(e => e.k === "resist").length;
  const deaths = events.filter(e => e.k === "death");
  const takenEv = events.filter(e => (e.k === "dmg" || e.k === "miss") && e.tgt === P.owner);
  const takenDmg = takenEv.filter(e => e.k === "dmg").reduce((a, e) => a + e.amt, 0);
  const takenLanded = takenEv.filter(e => e.k === "dmg" && (e.cat === "melee" || e.cat === "ranged")).length;
  const avoid = new Map();
  for (const e of takenEv) if (e.k === "miss") {
    const how = e.how === "protected" ? "spells blocked" : /absorb/.test(e.how) ? "absorbed" : /riposte/i.test(e.how) ? "riposte" : /parr/i.test(e.how) ? "parry" : /dodge/i.test(e.how) ? "dodge" : /block/i.test(e.how) ? "block" : "miss";
    avoid.set(how, (avoid.get(how) || 0) + 1);
  }
  const petTaken = events.filter(e => e.k === "dmg" && e.tgt && side.claims.at(e.tgt, e.ts)).reduce((a, e) => a + e.amt, 0);
  // heals BY the player (lifetaps included — the log calls them heals)
  const heals = new Map(); let healTot = 0, overTot = 0;
  for (const e of events) if (e.k === "heal" && e.by === P.owner) { const h = heals.get(e.spell) || { spell: e.spell, hits: 0, real: 0, over: 0, crit: 0 }; h.hits++; h.real += e.amt; h.over += Math.max(0, e.pot - e.amt); if (e.crit) h.crit++; heals.set(e.spell, h); healTot += e.amt; overTot += Math.max(0, e.pot - e.amt); if (!big.heal || e.amt > big.heal.amt) big.heal = { amt: e.amt, name: e.spell, crit: e.crit }; }
  // heals ON the player — the same lines, read from the receiving end
  const healsIn = new Map(); let healInTot = 0;
  for (const e of events) if (e.k === "heal" && e.who === P.owner) {
    const nm = e.by === P.owner ? "yourself" : (e.by || "unnamed");
    const h = healsIn.get(nm) || { by: nm, hits: 0, amt: 0 };
    h.hits++; h.amt += e.amt; healsIn.set(nm, h); healInTot += e.amt;
  }
  const skillups = new Map();
  for (const e of events) if (e.k === "skillup") { const s = skillups.get(e.skill) || { skill: e.skill, ups: 0, val: 0 }; s.ups++; s.val = Math.max(s.val, e.val); skillups.set(e.skill, s); }
  const faction = new Map();
  for (const e of events) if (e.k === "faction" && e.fac) { const f = faction.get(e.fac) || { fac: e.fac, hits: 0, net: 0, capped: 0 }; f.hits++; if (e.delta != null) f.net += e.delta; else f.capped++; faction.set(e.fac, f); }
  const meleeDmg = mHit.reduce((a, e) => a + e.amt, 0);
  const riposte = mHit.filter(e => (e.flags || []).some(f => /Riposte/.test(f))).length;
  const secs = combatSecondsOf(events, side);
  const xp = events.filter(e => e.k === "xp").reduce((a, e) => a + e.pct, 0);
  const aa = events.filter(e => e.k === "aa").length;
  const aaNow = events.reduce((n, e) => e.k === "aa" ? e.n : n, null);
  // coin gained = corpse coin + auto-sold loot + vendor sales + quest/salvage
  let copper = 0, vendorSaleCu = 0, vendorSales = 0, miscCu = 0;
  for (const e of events) {
    if (e.k === "coin") copper += inCopper(e);
    if (e.k === "loot" && e.sold) copper += inCopper(e.sold);
    if (e.k === "vendorsale") { vendorSaleCu += inCopper(e); vendorSales++; }
    if (e.k === "coinmisc") miscCu += inCopper(e);
  }
  copper += vendorSaleCu + miscCu;
  // active time: the event timeline with gaps over 30 minutes cut out, so
  // AFK and offline stretches never dilute the per-hour rates
  let activeSecs = 0;
  for (let i = 1; i < events.length; i++) { const d = (events[i].ts - events[i - 1].ts) / 1000; if (d <= 1800) activeSecs += d; }
  if (events.length) activeSecs += 1;
  const loot = new Map();
  for (const e of events) if (e.k === "loot") {
    const l = loot.get(e.item) || { item: e.item, qty: 0, sold: 0, depot: 0, kept: 0 };
    l.qty += e.qty;
    if (e.sold) l.sold += inCopper(e.sold); else if (e.depot) l.depot += e.qty; else l.kept += e.qty;
    loot.set(e.item, l);
  }
  const wallSecs = events.length ? (events[events.length - 1].ts - events[0].ts) / 1000 : 0;
  return {
    total, tot, buckets, big,
    sources: [...src.values()].sort((a, b) => b.dmg - a.dmg),
    elem: [...elem.entries()].sort((a, b) => b[1] - a[1]),
    byClass: [...byClass.entries()].sort((a, b) => b[1] - a[1]),
    melee: { landed: mHit.length, missed: mMiss, dmg: meleeDmg, avg: mHit.length ? meleeDmg / mHit.length : 0, max: mHit.reduce((a, e) => Math.max(a, e.amt), 0), riposte },
    skills: [...skills.values()].sort((a, b) => b.dmg - a.dmg),
    weapons: [...weapons.values()].sort((a, b) => b.dmg - a.dmg), ranged, mend,
    casts, interrupts, resists, deaths, combatSec: secs, wallSecs, activeSecs,
    heals: [...heals.values()].sort((a, b) => b.real - a.real), healTot, overTot,
    healsIn: [...healsIn.values()].sort((a, b) => b.amt - a.amt), healInTot,
    skillups: [...skillups.values()].sort((a, b) => b.ups - a.ups || a.skill.localeCompare(b.skill)),
    faction: [...faction.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.hits - a.hits),
    taken: { dmg: takenDmg, landed: takenLanded, avoid: [...avoid.entries()].sort((a, b) => b[1] - a[1]) },
    petTaken, xp, aa, aaNow, copper, vendorSaleCu, vendorSales, miscCu,
    loot: [...loot.values()].sort((a, b) => (b.sold || b.qty * 500) - (a.sold || a.qty * 500)),
  };
}

/* ─── icons / colors ──────────────────────────────────────────────────────*/
const ELEM_HUE = { fire: "var(--ember)", physical: "var(--gold)", magic: "var(--arcane)", cold: "#5aa9d6", poison: "#7fae4b", disease: "#8a9a4b", unresistable: "#cfc8b6" };
function gemFor(s) {
  // physical rows never consult the spell-icon index — skill verbs collide
  // with real spell NAMES (EQL has spells literally called Strike, Frenzy,
  // Smite) and a kick row wearing a cleric nuke's gem reads as a data error
  if (s.cat === "melee") return `<span class="gem gem-melee" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5.5 20 19.5"/><path d="M26 5.5 12 19.5"/><path d="M20 19.5 25.5 25M12 19.5 6.5 25"/></svg></span>`;
  if (s.cat === "ranged") return `<span class="gem gem-melee" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4 A 21 21 0 0 1 7 28"/><path d="M7 4 7 28"/><path d="M7 16 27 16"/><path d="M27 16l-5.5-3.5M27 16l-5.5 3.5"/></svg></span>`;
  const ic = ICON && ICON.get((s.name || "").toLowerCase());
  if (ic != null) return `<img class="gem" src="/spellmaster/icons/${ic}.png" alt="" loading="lazy" onerror="this.replaceWith(mkDot(${JSON.stringify(s.elem)}))">`;
  return `<span class="gem gem-dot" style="--h:${ELEM_HUE[s.elem] || 'var(--ink-dim)'}" aria-hidden="true"></span>`;
}
window.mkDot = elem => { const s = document.createElement("span"); s.className = "gem gem-dot"; s.style.setProperty("--h", ELEM_HUE[elem] || "var(--ink-dim)"); return s; };

/* ─── render helpers ──────────────────────────────────────────────────────*/
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const fmt = n => Math.round(n).toLocaleString();
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "—";
const dt = d => d ? d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const dtShort = d => d ? `${d.toLocaleString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase()}` : "—";
const fmtCopper = cu => {
  if (!cu) return "—";
  cu = Math.round(cu);
  const p = Math.floor(cu / 1000), g = Math.floor(cu % 1000 / 100), s = Math.floor(cu % 100 / 10), c = cu % 10;
  if (p >= 100) return `${fmt(p)}p`;
  if (p) return `${fmt(p)}p ${g}g`;
  if (g) return `${g}g ${s}s`;
  return `${s}s ${c}c`;
};
let SHOW_ALL_MOBS = false, SHOW_ALL_LOOT = false;
const EXPANDED = new Set(); // mob rows the player has opened
const EXPANDED_SRC = new Set(); // grouped source rows (pet/charm) opened to their per-verb split
function bar(frac, color) { const w = Math.max(0, Math.min(100, frac * 100)); return `<span class="mtrack"><span class="mfill" style="width:${w}%;background:${color}"></span></span>`; }

let STATE = null;

// A band chip narrower than ~4 characters drops its label (color + hover only)
// — a 1-2 character fragment reads as a glitch, not truncation. Measured after
// every render and again on resize, since chip widths are percentages.
function fitLanes() {
  document.querySelectorAll(".lane-seg").forEach(el => {
    el.classList.toggle("lane-tight", !el.classList.contains("lane-sliver") && el.clientWidth < 34);
  });
}
let fitLanesT = null;
window.addEventListener("resize", () => { clearTimeout(fitLanesT); fitLanesT = setTimeout(fitLanes, 150); });

/* ─── DPS-over-time sparkline (6s buckets, SVG area) ───────────────────────*/
function dpsChart(P, events, side, stanceTl, invokeTl) {
  const team = new Set(["you", "pet", "charm"]);
  const dmg = events.filter(e => e.k === "dmg" && team.has(side(e)) && P.mobSet.has(e.tgt));
  if (dmg.length < 4) return `<p class="sub">Not enough of a fight in this slice to chart.</p>`;
  // Idle compression: plotted on wall-clock, a multi-day log is a flatline
  // with one spike at the end (2678m of axis for 45m of combat). Gaps over
  // 60s between team damage events collapse to 12s of axis; stance markers
  // ride the same piecewise mapping so they still land on their fights.
  const GAP_MAX = 60, GAP_SHOWN = 12;
  const sec = ts => ts.getTime() / 1000;
  const knotsR = [], knotsC = [];
  let comp = 0, prevT = null, gaps = 0;
  const pts = dmg.map(e => {
    const t = sec(e.ts);
    if (prevT != null) {
      const d = t - prevT;
      if (d > GAP_MAX) { gaps++; comp += GAP_SHOWN; } else comp += d;
    }
    prevT = t;
    knotsR.push(t); knotsC.push(comp);
    return { c: comp, amt: e.amt };
  });
  const span = Math.max(comp, 1);
  const compress = t => {
    if (t <= knotsR[0]) return 0;
    let lo = 0, hi = knotsR.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (knotsR[mid] <= t) lo = mid; else hi = mid - 1; }
    // between damage events time flows 1:1, capped at the next knot
    const c = knotsC[lo] + (t - knotsR[lo]);
    return Math.min(c, lo + 1 < knotsC.length ? knotsC[lo + 1] : span);
  };
  // widen buckets on long slices so a whole log stays readable (~300 bars max)
  const B = Math.max(6, Math.ceil(span / 300 / 6) * 6);
  const n = Math.max(1, Math.ceil(span / B)), buckets = new Array(n).fill(0);
  for (const p of pts) buckets[Math.min(n - 1, Math.floor(p.c / B))] += p.amt;
  const dps = buckets.map(v => v / B), peak = Math.max(...dps, 1);
  const W = 900, H = 120, pad = 4;
  const x = i => pad + (W - 2 * pad) * (i / Math.max(1, n - 1));
  const y = v => H - pad - (H - 2 * pad) * (v / peak);
  let path = `M ${x(0)} ${y(dps[0])}`; for (let i = 1; i < n; i++) path += ` L ${x(i)} ${y(dps[i])}`;
  const area = `${path} L ${x(n - 1)} ${H - pad} L ${x(0)} ${H - pad} Z`;
  // Stances and invocations render as BANDS above and below the chart —
  // every segment is a labeled span on the same idle-compressed axis, in
  // HTML so labels never collide, distort, or get dropped; a segment too
  // narrow to read still ellipsizes and answers on hover (EQLTip). Thin
  // ticks inside the chart mark the exact transition moments.
  const laneSegs = tl => {
    const segs = [];
    let cur = null, curC = 0, curR = dmg[0].ts;
    for (const [ts, name] of tl) {
      const t = sec(ts);
      if (t <= knotsR[0]) { cur = name; continue; }
      if (t > prevT) break;
      const c = compress(t);
      if (cur) segs.push({ name: cur, c0: curC, c1: c, r0: curR, r1: ts });
      cur = name; curC = c; curR = ts;
    }
    if (cur) segs.push({ name: cur, c0: curC, c1: span, r0: curR, r1: dmg[dmg.length - 1].ts });
    return segs;
  };
  if (TIPCTX) TIPCTX.lanes = { s: [], i: [] };
  const lane = (tl, cls, laneKey) => {
    const segs = laneSegs(tl || []);
    if (!segs.length) return "";
    if (TIPCTX) TIPCTX.lanes[laneKey] = segs;
    // a segment too narrow for text (a stance toggled for seconds) renders
    // as a 2px sliver — no padding, no label — but still answers on hover.
    // Labels live in .lane-txt so fitLanes() can suppress fragments: a chip
    // too narrow for ~4 characters shows color only, never "o." noise.
    return `<div class="lane ${cls}">` + segs.map((s, i) => {
      const w = 100 * (s.c1 - s.c0) / span;
      const sliver = w < 0.15;
      return `<span class="lane-seg${sliver ? " lane-sliver" : ""}" data-tip="lp:lane:${laneKey}${i}" style="left:${(100 * s.c0 / span).toFixed(3)}%;width:${w.toFixed(3)}%">${sliver ? "" : `<span class="lane-txt">${esc(s.name)}</span>`}</span>`;
    }).join("") + `</div>`;
  };
  const ticks = (tl, col) => {
    let out = "";
    for (const [ts] of tl || []) {
      const t = sec(ts);
      if (t < knotsR[0] || t > prevT) continue;
      const mx = x(compress(t) / B);
      out += `<line x1="${mx}" y1="${pad}" x2="${mx}" y2="${H - pad}" stroke="${col}" stroke-width="1" stroke-dasharray="2 3" opacity=".35"/>`;
    }
    return out;
  };
  const marks = ticks(stanceTl, "var(--gold)") + ticks(invokeTl, "var(--arcane)");
  return lane(stanceTl, "lane-stance", "s") +
    `<svg viewBox="0 0 ${W} ${H}" class="spark" preserveAspectRatio="none" role="img" aria-label="damage per second over time">
    <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ember)" stop-opacity=".5"/><stop offset="1" stop-color="var(--ember)" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#dg)"/><path d="${path}" fill="none" stroke="var(--ember-hot,#ff8a3d)" stroke-width="1.6"/>${marks}
  </svg>` + lane(invokeTl, "lane-invoke", "i") +
    `<p class="sub">Peak ${fmt(peak)} DPS over a ${B}-second window · ${Math.round(span / 60)}m of combat${gaps ? " — idle time between fights cut out" : ""}</p>`;
}

/* ─── tooltips: the raw numbers behind every rounded value ─────────────────
   /_shared/tip.js provides the engine; this provider serves "lp:*" specs.
   Content is rebuilt from TIPCTX on every render, so a tip always shows the
   numbers of the slice on screen. */
let TIPCTX = null;
// Skill rows are named by the verb the log prints, and the log collapses
// families — these tips say so where it matters. Kick/strike collapses were
// observed in game (2026-07-11); the log never names the skill.
const VERB_TIP = {
  kick: "Kick and Round Kick both print “kick” in the log, so they share this row. The log never names the skill.",
  strike: "Strike-family skills print “strike” — Tiger Claw among them. The log never names the skill.",
  ranged: "Bow shots print “shoot” in the log.",
  auto: "Weapon swings, split by the verb the log prints — the verb is the weapon's damage type (slash, crush, pierce…). With a different weapon type in each hand, these rows are your two hands. The log never says which hand.",
  punch: "Bare-handed swings print “punch” — a punch-family skill like Dragon Punch would print the same verb, so they can't be split.",
};
function tipProvider(arg) {
  if (!TIPCTX) return null;
  const i = arg.indexOf(":");
  const key = i < 0 ? arg : arg.slice(0, i);
  const rest = i < 0 ? null : arg.slice(i + 1);
  const idx = rest == null ? null : +rest;
  const a = TIPCTX.a;
  switch (key) {
    case "verb": return VERB_TIP[rest] ? `<h5>${rest === "ranged" ? "Ranged" : rest === "auto" ? "Auto-attack" : rest}</h5><p>${VERB_TIP[rest]}</p>` : null;
    case "lane": {
      const segs = TIPCTX.lanes && TIPCTX.lanes[rest[0]];
      const s = segs && segs[+rest.slice(1)];
      if (!s) return null;
      return `<h5>${esc(s.name)}</h5><p>${rest[0] === "s" ? "Stance" : "Invocation"} · ${dtShort(s.r0)} → ${dtShort(s.r1)}</p>`;
    }
    case "mend": return `<h5>Mend</h5><p>The log says you mended — “You mend your wounds and heal some damage.” — but never prints the amount, so mend is counted, not totaled.</p>`;
    case "damage": return `<h5>Damage</h5><p>Only hits that landed on mobs count. You <b>${fmt(a.tot.you)}</b> · pets <b>${fmt(a.tot.pet)}</b> · charm <b>${fmt(a.tot.charm)}</b>.</p>`;
    case "dps": return `<h5>Est. DPS</h5><p>${fmt(a.total)} damage ÷ ${fmt(a.combatSec)}s of combat = <b>${fmt(a.combatSec ? a.total / a.combatSec : 0)}</b>. Combat time strings your side's damage together and skips gaps over 30s. Log timestamps are whole seconds, so short windows round hard.</p>`;
    case "combat": return `<h5>Combat time</h5><p>${fmt(a.combatSec)}s fighting inside ${fmt(a.wallSecs)}s of log — ${pct(a.combatSec, a.wallSecs)} of the time.</p>`;
    case "kills": return `<h5>Kills</h5><p><b>${TIPCTX.kills}</b> credited to you, your pets, or your charm.${TIPCTX.killedSeen > TIPCTX.kills ? ` ${TIPCTX.killedSeen - TIPCTX.kills} more deaths happened in fights someone else finished.` : ""}</p>`;
    case "deaths": return `<h5>Deaths</h5>` + (a.deaths.length ? `<p>${a.deaths.map(x => `${dtShort(x.ts)} — ${x.by}`).join("<br>")}</p>` : `<p>None in this slice.</p>`);
    case "xp": return `<h5>XP gained</h5><p><b>${a.xp.toFixed(2)}%</b> over ${TIPCTX.xpLines} experience lines${TIPCTX.kills ? ` — ${(a.xp / TIPCTX.kills).toFixed(2)}% per credited kill` : ""}. The log prints percentages only; 100% is one level.</p>`;
    case "coin": return `<h5>Coin</h5><p>Corpse coin <b>${fmtCopper(TIPCTX.corpseCu)}</b> + auto-sold loot <b>${fmtCopper(TIPCTX.vendorCu)}</b>${a.vendorSaleCu ? ` + vendor sales <b>${fmtCopper(a.vendorSaleCu)}</b>` : ""}${a.miscCu ? ` + quest and salvage coin <b>${fmtCopper(a.miscCu)}</b>` : ""}. Per-mob averages only count coin the kill burst tied to a fight.</p>`;
    case "aa": return `<h5>AA points</h5><p>${a.aa} ability-point line${a.aa === 1 ? "" : "s"} in this slice${a.aaNow != null ? ` — the last one said you have <b>${a.aaNow}</b>` : ""}. The log doesn't say where you spent them.</p>`;
    case "pace": return `<h5>Per hour of play</h5><p>Everything ÷ <b>${TIPCTX.activeH.toFixed(2)}h</b> of active time — the event timeline with gaps over 30 minutes cut out, so camp breaks and logouts don't dilute the rate. The level estimate is 100% ÷ your XP rate — 100% is one level at your current level's cost.</p>`;
    case "swap": return `<h5>Loadout swap</h5><p>Swapping class loadouts changes your level and the log prints nothing. This log's considers stopped matching the known level here, so fights between the last agreeing con and the next level-up or /who line are filed under <b>Level unknown</b> instead of guessed. Typing <code>/who</code> after a swap re-anchors immediately.</p>`;
    case "pets": {
      const ns = TIPCTX.side.claims.names;
      if (!ns.length) return `<h5>Pets</h5><p>Nothing answered you with ", Master." in this log. A pet identifies itself the first time you order it — one <code>/pet attack</code> and it counts.</p>`;
      return `<h5>Your pets</h5><p>Claimed by their own tells — the client only ever shows you your own pet's answers.</p><p>${ns.map(c => `<b>${c.name}</b> (${c.kind}) — ${c.tells} tell${c.tells === 1 ? "" : "s"}, ${dtShort(c.from)} → ${dtShort(c.to)}`).join("<br>")}</p>`;
    }
    case "droprate": return `<h5>Observed drop rate</h5><p>Loot lines ÷ kills seen. The log has no line for opening an empty corpse, so a corpse you never looted still counts as a kill — the rate here can only run low, never high.</p>`;
    case "enchp": return `<h5>HP this fight</h5><p>Bracketed by overkill: the mob took some total damage, and the killing blow either landed in full or was capped by whatever HP was left — so its HP sits between total−lastblow+1 and total. Heals it received subtract. A trailing <b>?</b> means another same-name mob was in the fray; the log can't tell two of a name apart, so that bracket is unreliable and stays out of the mob's HP.</p>`;
    case "srcrow": {
      const s = a.sources[idx];
      if (!s || !s.actors) return null;
      return `<h5>${s.name}</h5><p>${[...s.actors.entries()].sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n} ${fmt(v)}`).join(" · ")}</p>`;
    }
    case "mobxp": case "mobcoin": case "mobkills": case "moblvl": case "mobhp": case "mobdps": {
      const g = TIPCTX.mobs && TIPCTX.mobs[idx];
      if (!g) return null;
      if (key === "mobhp") return `<h5>${g.mob} — HP</h5><p>Each kill brackets HP between the total damage the mob took (minus heals it received) and that total minus the last blow — the killing hit can overshoot. ${g.hp[2]} clean kill${g.hp[2] === 1 ? "" : "s"} narrow${g.hp[2] === 1 ? "s" : ""} it to <b>${fmt(g.hp[0])}–${fmt(g.hp[1])}</b>.${g.hp[3] ? " Marked <b>mixed</b>: the kills disagree — same-name mobs spawn in more than one variant, and this bracket fits the most kills." : ""} Kills with another same-name mob nearby are left out.</p>`;
      if (key === "mobdps") return `<h5>${g.mob} — their DPS</h5><p><b>${fmt(g.offSum)}</b> damage it dealt — melee, spells, DoTs, damage shield, at anyone — over <b>${fmt(g.offSecsSum)}s</b> on the attack. Biggest melee hit: <b>${fmt(g.maxHit)}</b>.</p>`;
      if (key === "mobxp") return `<h5>${g.mob} — XP</h5><p>${g.xp.toFixed(2)}% total over ${g.kills} kill${g.kills === 1 ? "" : "s"}; ${g.xpKills} printed an XP line. The average divides by all kills${g.rollKills ? `, minus ${g.rollKills} that crossed a level — those print only the leftover past the ding, so they'd drag the average down` : ""}.</p>`;
      if (key === "mobcoin") return `<h5>${g.mob} — coin</h5><p>${fmtCopper(g.coin)} total over ${g.kills} kill${g.kills === 1 ? "" : "s"}; ${g.coinKills} dropped coin.</p>`;
      if (key === "moblvl") return `<h5>${g.mob} — level</h5><p>From ${g.lvls.n} of your own /con line${g.lvls.n === 1 ? "" : "s"} — the only place the log states a level. Same-name spawns can span levels, so a range is real, not noise.</p>`;
      return `<h5>${g.mob}</h5><p>${g.kills} killed${g.fights > g.kills ? ` · ${g.fights - g.kills} fought with no death seen — it fled, reset, or someone else finished it` : ""}.</p>`;
    }
  }
  return null;
}

function render() {
  const { P, seg, side } = STATE;
  const selLevels = currentLevels(), selZone = currentZone(), selCombo = $("comboSel").value, selFight = $("fightSel").value;
  let events = P.events;
  const focus = selFight === "*" ? null : seg.fights.find(f => fkey(f) === selFight) || null;
  if (focus) {
    // a focused fight IS the slice — level/zone/combo filters don't stack on
    // top, or focusing a fight outside the current slice shows an empty page
    const t0 = focus.start - 2000, t1 = focus.end.getTime() + 2000;
    events = events.filter(e => e.ts >= t0 && e.ts <= t1 &&
      (e.src === focus.mob || e.tgt === focus.mob || (e.k !== "dmg" && e.k !== "miss")));
  } else {
    if (selLevels) events = events.filter(e => selLevels.has(e.lvl));
    if (selZone) events = events.filter(e => zoneHas(selZone, e.zone, e.ztier, e.zv));
    if (selCombo !== "*") events = events.filter(e => e.combo === selCombo);
  }
  const oc = P.who ? P.who.classes.split("/") : null;
  const a = analyze(P, events, side, oc);

  // kills come from fights (a kill is credited only if we actually fought the
  // mob, and only to you or an actor claimed at the time), sliced the same
  // way the mob table is
  let fightsInSlice = focus ? [focus] : seg.fights.filter(f => f.total > 0 || f.taken > 0);
  if (!focus && selLevels) fightsInSlice = fightsInSlice.filter(f => selLevels.has(f.lvl));
  if (!focus && selZone) fightsInSlice = fightsInSlice.filter(f => zoneHas(selZone, f.zone, f.tier, f.zv));
  // the kills number must share its population with the combo-filtered events
  // or the pace line divides one slice's kills by another slice's hours
  if (!focus && selCombo !== "*") fightsInSlice = fightsInSlice.filter(f => f.combo === selCombo);
  const killedSeen = fightsInSlice.filter(f => f.killed);
  const kills = killedSeen.filter(f => f.killer === P.owner || side.claims.at(f.killer, f.end)).length;

  let corpseCu = 0, vendorCu = 0;
  for (const e of events) { if (e.k === "coin") corpseCu += inCopper(e); if (e.k === "loot" && e.sold) vendorCu += inCopper(e.sold); }
  TIPCTX = { a, side, kills, killedSeen: killedSeen.length, corpseCu, vendorCu,
             xpLines: events.filter(e => e.k === "xp").length, mobs: null };

  // plaques
  const pl = $("plaques"); pl.innerHTML = "";
  const dps = a.combatSec ? a.total / a.combatSec : 0;
  const plq = [["Damage", fmt(a.total), "damage", "hero"], ["Est. DPS", a.combatSec >= MIN_RATE_SEC ? fmt(dps) : "—", "dps"],
    ["Combat time", `${Math.round(a.combatSec / 60)}m`, "combat"], ["Kills", kills, "kills"], ["Deaths", a.deaths.length, "deaths"]];
  if (a.xp > 0) plq.push(["XP gained", a.xp >= 100 ? `${(a.xp / 100).toFixed(1)} lvls` : `${a.xp.toFixed(1)}%`, "xp"]);
  if (a.copper > 0) plq.push(["Coin gained", fmtCopper(a.copper), "coin"]);
  if (a.aa > 0) plq.push(["AA points", a.aa, "aa"]);
  plq.forEach(([l, n, key, cls]) => {
    const d = el("div", "plaque" + (cls ? " " + cls : ""), `<span class="pn">${n}</span><span class="pl">${l}</span>`);
    d.dataset.tip = "lp:" + key;
    pl.append(d);
  });

  // pace: per-hour rates over active time (gaps over 30m cut out). One line,
  // only when the slice is long enough for a rate to mean anything.
  const paceEl = $("paceLine");
  const activeH = a.activeSecs / 3600;
  TIPCTX.activeH = activeH;
  if (!focus && activeH >= 1 / 6 && (a.xp > 0 || kills > 0 || a.copper > 0)) {
    const parts = [];
    if (kills) parts.push(`${(kills / activeH).toFixed(kills / activeH < 10 ? 1 : 0)} kills`);
    if (a.xp > 0) parts.push(`${(a.xp / activeH).toFixed(1)}% XP`);
    if (a.copper > 0) parts.push(fmtCopper(a.copper / activeH));
    if (a.aa > 0) parts.push(`${(a.aa / activeH).toFixed(1)} AA`);
    const lvlH = a.xp > 0 ? 100 / (a.xp / activeH) : null;
    paceEl.hidden = false;
    paceEl.innerHTML = `<span class="tipv" data-tip="lp:pace">Per hour of play</span>: ${parts.join(" · ")}` +
      (lvlH && lvlH < 200 ? ` — a level every ~${lvlH < 10 ? lvlH.toFixed(1) : Math.round(lvlH)}h at this rate` : "");
  } else paceEl.hidden = true;

  // biggest-hit tiles
  const bh = $("bigHits"); bh.innerHTML = "";
  const tiles = [["biggest nuke", a.big.spell], ["biggest swing", a.big.melee], ["biggest DoT tick", a.big.dot]];
  if (a.big.ranged) tiles.push(["biggest shot", a.big.ranged]);
  if (a.big.heal) tiles.push(["biggest heal", a.big.heal]);
  for (const [lab, b] of tiles) if (b) bh.append(el("div", "bigtile", `<span class="bt-n">${fmt(b.amt)}</span><span class="bt-src">${b.name}${b.crit ? " <em>crit</em>" : ""}</span><span class="bt-lab">${lab}</span>`));

  // dps over time
  $("dpsChart").innerHTML = dpsChart(P, events, side, seg.stanceTl, seg.invokeTl);
  fitLanes();

  // damage by source
  const t = $("sourceTable");
  t.innerHTML = `<thead><tr><th></th><th>Source</th><th></th><th>Element</th><th>Hits</th><th>Total</th><th>%</th><th>Avg</th><th>Max</th><th>Crit</th></tr></thead>`;
  const tb = el("tbody");
  const TAGS = { you: `<span class="tag-you">you</span>`, pet: `<span class="tag-pet">pet</span>`, charm: `<span class="tag-charm">charm</span>` };
  a.sources.forEach((s, i) => {
    const vtip = s.side !== "you" ? null
      : s.name === "auto-attack (punch)" ? "punch"
      : s.name.startsWith("auto-attack (") ? "auto"
      : VERB_TIP[s.name] ? s.name : null;
    const nameCell = s.actors ? `<span class="tipv" data-tip="lp:srcrow:${i}">${s.name}</span>`
      : vtip ? `<span class="tipv" data-tip="lp:verb:${vtip}">${s.name}</span>` : s.name;
    // grouped pet/charm rows expand to their per-verb (and per-spell) split —
    // grouping is presentation, never lost detail
    const expandable = s.sub && s.sub.size >= 2;
    const srcKey = `${s.side}|${s.name}`;
    const isOpen = expandable && EXPANDED_SRC.has(srcKey);
    const critCell = s.cat === "melee" || s.cat === "ranged" || s.cat === "spell" || s.cat === "proc" ? pct(s.crit, s.hits) : "—";
    const tr = el("tr", expandable ? "src-row" + (isOpen ? " open" : "") : null,
      `<td class="c-gem">${gemFor(s)}</td><td class="c-name">${expandable ? `<span class="m-caret" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>` : ""}${nameCell}</td><td>${TAGS[s.side] || ""}</td><td class="c-el">${s.elem}</td><td>${fmt(s.hits)}</td><td class="c-dmg">${fmt(s.dmg)}</td><td>${pct(s.dmg, a.total)}</td><td>${fmt(s.dmg / s.hits)}</td><td>${fmt(s.max)}</td><td>${critCell}</td>`);
    if (expandable) tr.addEventListener("click", ev => {
      if (ev.target.closest("[data-tip]")) return; // the tip owns that click
      if (EXPANDED_SRC.has(srcKey)) EXPANDED_SRC.delete(srcKey); else EXPANDED_SRC.add(srcKey);
      render();
    });
    tb.append(tr);
    if (isOpen) for (const sub of [...s.sub.values()].sort((x, y) => y.dmg - x.dmg)) {
      tb.append(el("tr", "src-sub", `<td class="c-gem"></td><td class="c-name">${esc(sub.name)}</td><td></td><td class="c-el"></td><td>${fmt(sub.hits)}</td><td class="c-dmg">${fmt(sub.dmg)}</td><td>${pct(sub.dmg, a.total)}</td><td>${fmt(sub.dmg / sub.hits)}</td><td>${fmt(sub.max)}</td><td>${pct(sub.crit, sub.hits)}</td>`));
    }
  });
  t.append(tb);
  if (!a.sources.length) t.append(el("tbody", null, `<tr><td colspan="10" class="empty">No damage from your side in this slice.</td></tr>`));

  // composition + by-class
  const comp = $("composition"); comp.innerHTML = "";
  for (const [k, lab, col] of [["melee", "auto-attack", "var(--c-melee)"], ["skill", "combat skills", "var(--c-skill)"], ["ranged", "ranged", "var(--c-ranged)"], ["cast", "cast spells", "var(--c-cast)"], ["proc", "procs / passives", "var(--c-proc)"], ["dot", "damage over time", "var(--c-dot)"], ["ds", "damage shield", "var(--c-ds)"], ["pet", "pets", "var(--c-pet)"], ["charm", "charmed mobs", "var(--c-charm)"]]) {
    const v = a.buckets[k] || 0; if (!v) continue;
    comp.append(el("div", "meter", `<span class="mlab">${lab}</span>${bar(v / (a.total || 1), col)}<span class="mval">${pct(v, a.total)} · ${fmt(v)}</span>`));
  }
  comp.append(el("p", "sub", "Elements: " + (a.elem.map(([e, v]) => `${e} ${pct(v, a.total)}`).join(" · ") || "—")));
  const bc = $("byClass"); bc.innerHTML = "";
  if (oc && a.byClass.length > 1) {
    bc.append(el("h3", "mini-h", "By class"));
    for (const [c, v] of a.byClass) bc.append(el("div", "meter small", `<span class="mlab">${c}</span>${bar(v / (a.total || 1), c === "pet" || c === "charm" ? "var(--arcane)" : "var(--gold)")}<span class="mval">${pct(v, a.total)}</span>`));
  }

  // casting & melee
  const r = $("rates"); r.innerHTML = "";
  const row = (k, v, warn) => r.append(el("div", "statrow", `<span class="k">${k}</span><span class="v${warn ? " warn" : ""}">${v}</span>`));
  const hr = a.melee.landed + a.melee.missed;
  row("melee swings", `${fmt(a.melee.landed)} landed / ${fmt(a.melee.missed)} missed`);
  row("hit rate", pct(a.melee.landed, hr), hr > 100 && a.melee.landed / hr < .7);
  row("avg / biggest hit", `${fmt(a.melee.avg)} / ${fmt(a.melee.max)}`);
  if (a.melee.riposte) row("riposte hits", fmt(a.melee.riposte));
  if (a.weapons.length >= 2) for (const w of a.weapons) {
    row(`<span class="tipv" data-tip="lp:verb:auto">auto-attack (${w.verb})</span>`, `${fmt(w.landed)} landed / ${fmt(w.missed)} missed · avg ${w.landed ? fmt(w.dmg / w.landed) : "—"}`);
  }
  for (const sk of a.skills) {
    const tip = VERB_TIP[sk.verb] ? ` class="tipv" data-tip="lp:verb:${sk.verb}"` : "";
    row(`<span${tip}>${sk.verb}</span>`, `${fmt(sk.landed)} landed / ${fmt(sk.missed)} missed · avg ${sk.landed ? fmt(sk.dmg / sk.landed) : "—"}`);
  }
  if (a.ranged.landed || a.ranged.missed) {
    row(`<span class="tipv" data-tip="lp:verb:ranged">ranged shots</span>`, `${fmt(a.ranged.landed)} landed / ${fmt(a.ranged.missed)} missed` + (a.ranged.landed ? ` · avg ${fmt(a.ranged.dmg / a.ranged.landed)}` : ""));
  }
  if (a.mend.ok || a.mend.fail) row(`<span class="tipv" data-tip="lp:mend">mend</span>`, `${a.mend.ok} mended` + (a.mend.fail ? ` / ${a.mend.fail} failed` : ""));
  row("casts", fmt(a.casts));
  row("interrupted", `${fmt(a.interrupts)} (${pct(a.interrupts, a.casts)})`, a.casts && a.interrupts / a.casts >= .05);
  row("resisted", `${fmt(a.resists)} (${pct(a.resists, a.casts)})`, a.casts && a.resists / a.casts >= .04);
  if (a.taken.landed || a.taken.avoid.length) { const av = a.taken.avoid.reduce((x, [, n]) => x + n, 0);
    row("damage taken", `${fmt(a.taken.dmg)} over ${fmt(a.taken.landed)} hits`);
    row("avoided", av ? `${fmt(av)} (${a.taken.avoid.map(([k, n]) => `${k} ${n}`).join(", ")})` : "—"); }
  if (a.petTaken) row("your pets took", fmt(a.petTaken));

  // healing — what you cast, and what landed on you (same lines, both ends)
  const hp = $("healPanel");
  if (a.healTot > 0 || a.healInTot > 0) {
    hp.hidden = false;
    const ht = $("healTable"), hb = $("healOutBlock");
    hb.hidden = !(a.healTot > 0);
    if (a.healTot > 0) {
      ht.innerHTML = `<thead><tr><th>Heal</th><th>Casts</th><th>Healed</th><th>Overheal</th><th>Crit</th></tr></thead>`;
      const htb = el("tbody");
      for (const h of a.heals) htb.append(el("tr", null, `<td class="c-name">${h.spell}</td><td>${fmt(h.hits)}</td><td class="c-dmg">${fmt(h.real)}</td><td>${pct(h.over, h.real + h.over)}</td><td>${pct(h.crit, h.hits)}</td>`));
      htb.append(el("tr", "tot", `<td class="c-name">total</td><td></td><td class="c-dmg">${fmt(a.healTot)}</td><td>${pct(a.overTot, a.healTot + a.overTot)} wasted</td><td></td>`));
      ht.append(htb);
    }
    const hrb = $("healInBlock");
    hrb.hidden = !(a.healInTot > 0);
    if (a.healInTot > 0) {
      const hrt = $("healRecvTable");
      hrt.innerHTML = `<thead><tr><th>Healer</th><th>Casts</th><th>Amount</th></tr></thead>`;
      const hrtb = el("tbody");
      for (const h of a.healsIn) hrtb.append(el("tr", null, `<td class="c-name">${esc(h.by)}</td><td>${fmt(h.hits)}</td><td class="c-dmg">${fmt(h.amt)}</td>`));
      hrtb.append(el("tr", "tot", `<td class="c-name">total</td><td></td><td class="c-dmg">${fmt(a.healInTot)}</td>`));
      hrt.append(hrtb);
    }
  } else hp.hidden = true;

  // stance/invocation A/B — per-combo stats over the level+zone slice (ignore combo filter)
  let comboEvents = P.events;
  if (selLevels) comboEvents = comboEvents.filter(e => selLevels.has(e.lvl));
  if (selZone) comboEvents = comboEvents.filter(e => zoneHas(selZone, e.zone, e.ztier, e.zv));
  const comboNames = [...new Set(comboEvents.filter(e => e.k === "dmg" && side(e) === "you").map(e => e.combo))];
  const ctab = $("comboTable");
  ctab.innerHTML = `<thead><tr><th>Stance · invocation</th><th>Time</th><th>Damage</th><th>Est. DPS</th><th>Melee avg</th><th>Hit%</th><th>Crit%</th></tr></thead>`;
  const ctb = el("tbody"); const totalComboSec = comboNames.reduce((s, c) => s + combatSecondsOf(comboEvents.filter(e => e.combo === c), side), 0) || 1;
  const comboRows = comboNames.map(c => { const ce = comboEvents.filter(e => e.combo === c); const ca = analyze(P, ce, side, oc); const sec = combatSecondsOf(ce, side); return { c, ca, sec }; }).sort((x, y) => y.ca.total - x.ca.total);
  for (const { c, ca, sec } of comboRows) {
    const hrr = ca.melee.landed + ca.melee.missed;
    ctb.append(el("tr", null, `<td class="c-name">${c}</td><td>${bar(sec / totalComboSec, "var(--line-hot,#5c4630)")}<span class="inlpct">${pct(sec, totalComboSec)}</span></td><td class="c-dmg">${fmt(ca.total)}</td><td>${rateDps(ca.total, sec)}</td><td>${ca.melee.landed ? fmt(ca.melee.avg) : "—"}</td><td>${pct(ca.melee.landed, hrr)}</td><td>${pct(ca.sources.reduce((x, s) => x + s.crit, 0), ca.sources.reduce((x, s) => x + s.hits, 0))}</td>`));
  }
  ctab.append(ctb);
  if (comboRows.length <= 1) ctab.append(el("tbody", null, `<tr><td colspan="7" class="empty">Only one stance/invocation combo in this slice — switch them in game and the comparison fills in.</td></tr>`));

  renderMobs(selLevels, selZone, selFight);
  renderProgress(a);
  renderLoot(a);

  // death recap
  const dp = $("deathPanel"), dd = $("deaths");
  if (a.deaths.length) {
    dp.hidden = false; dd.innerHTML = "";
    for (const d of a.deaths) {
      const w0 = new Date(d.ts - 15000);
      const window = P.events.filter(e => e.k === "dmg" && e.tgt === P.owner && e.ts >= w0 && e.ts <= d.ts);
      const bySrc = new Map(); let totIn = 0;
      for (const e of window) { const key = (e.src || "unknown") + (e.spell ? ` (${e.spell})` : ""); bySrc.set(key, (bySrc.get(key) || 0) + e.amt); totIn += e.amt; }
      const lines = [...bySrc.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ");
      dd.append(el("div", "death", `<span class="d-when">${dt(d.ts)}</span> slain by <b>${mobCell(d.by)}</b> — last 15s: took ${fmt(totIn)}${lines ? ` (${lines})` : " (nothing logged incoming — likely a big hit or environmental)"}`));
    }
  } else dp.hidden = true;

  // unparsed honesty
  const uEl = $("unparsed"), up = P.unparsedCombat;
  const parsedCombat = P.events.filter(e => e.k === "dmg" || e.k === "miss" || e.k === "heal" || e.k === "kill").length;
  const upPct = (parsedCombat + up) ? up / (parsedCombat + up) : 0;
  if (!up) { uEl.textContent = ""; uEl.classList.remove("warn-banner"); }
  else {
    uEl.textContent = `${fmt(up)} combat lines (~${(upPct * 100).toFixed(1)}%) weren't recognized` +
      (upPct >= 0.1 ? " — a large share, so totals are likely missing real damage (probably a new EQL line the parser hasn't learned)." : upPct >= 0.03 ? " — enough to pull totals down a little." : ", so totals may run a hair low.");
    uEl.classList.toggle("warn-banner", upPct >= 0.03);
  }

  if (window.EQLTip) EQLTip.decorate();
}

/* ─── wiki item links ──────────────────────────────────────────────────────
   Lazy: the ~10.7k-title index only fetches the first time a drops or loot
   table is actually about to render, and only once (the promise is memoized).
   If it lands after that first paint, its own .then re-runs the normal
   render() — same pipeline every control change already uses — so linked
   items just appear on the next redraw rather than needing new machinery. */
let wikiItemsPromise = null, WIKI_ITEMS = null;
function loadWikiItems() {
  if (wikiItemsPromise) return wikiItemsPromise;
  wikiItemsPromise = fetch("/log-parser/data/wiki-items.json")
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      WIKI_ITEMS = d && d.titles ? { base: d.base, set: new Set(d.titles) } : null;
      if (STATE) render();
    })
    .catch(() => { WIKI_ITEMS = null; });
  return wikiItemsPromise;
}
function itemCell(name) {
  if (WIKI_ITEMS && WIKI_ITEMS.set.has(name))
    return `<a class="loot-wiki" href="${WIKI_ITEMS.base + encodeURIComponent(name.replace(/ /g, "_"))}" target="_blank" rel="noopener">${esc(name)}</a>`;
  return esc(name);
}
// Mob pages match case-insensitively: the log lowercases leading articles
// ("a Pickclaw Arroweater") while the wiki capitalizes them, so the index maps
// lowercased title -> the page's own casing.
let wikiMobsPromise = null, WIKI_MOBS = null;
function loadWikiMobs() {
  if (wikiMobsPromise) return wikiMobsPromise;
  wikiMobsPromise = fetch("/log-parser/data/wiki-mobs.json")
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      WIKI_MOBS = d && d.titles ? { base: d.base, map: new Map(d.titles.map(t => [t.toLowerCase(), t])) } : null;
      if (STATE) render();
    })
    .catch(() => { WIKI_MOBS = null; });
  return wikiMobsPromise;
}
function mobCell(name) {
  const t = WIKI_MOBS && WIKI_MOBS.map.get(String(name).toLowerCase());
  if (t) return `<a class="loot-wiki" href="${WIKI_MOBS.base + encodeURIComponent(t.replace(/ /g, "_"))}" target="_blank" rel="noopener">${esc(name)}</a>`;
  return esc(name);
}

/* ─── mobs & fights: one table, per-mob rows that open into encounters ─────*/
function renderMobs(selLevels, selZone, selFight) {
  const { P, seg } = STATE;
  let fights = seg.fights.filter(f => f.total > 0 || f.taken > 0);
  if (selLevels) fights = fights.filter(f => selLevels.has(f.lvl));
  if (selZone) fights = fights.filter(f => zoneHas(selZone, f.zone, f.tier, f.zv));
  let lootEv = P.events.filter(e => e.k === "loot");
  if (selLevels) lootEv = lootEv.filter(e => selLevels.has(e.lvl));
  if (selZone) lootEv = lootEv.filter(e => zoneHas(selZone, e.zone, e.ztier, e.zv));
  let conEv = P.events.filter(e => e.k === "con");
  if (selLevels) conEv = conEv.filter(e => selLevels.has(e.lvl));
  if (selZone) conEv = conEv.filter(e => zoneHas(selZone, e.zone, e.ztier, e.zv));
  const rows = buildMobStats(fights, lootEv, conEv);
  if (rows.length) loadWikiMobs();
  const focusFight = selFight === "*" ? null : seg.fights.find(f => fkey(f) === selFight) || null;
  if (focusFight) EXPANDED.add(focusFight.mob);
  const shown = SHOW_ALL_MOBS ? rows : rows.slice(0, 20);
  TIPCTX.mobs = shown;
  // the level column exists only when the player actually conned something —
  // levels come from their own /con lines, nowhere else
  const hasLvls = rows.some(g => g.lvls);
  const nCols = 9 + (hasLvls ? 1 : 0);
  const tierTxt = g => { if (!g.tiers || !g.tiers.size || (g.tiers.size === 1 && g.tiers.has(0))) return "";
    const ts = [...g.tiers].sort((x, y) => x - y); return ` · D${ts[0]}${ts.length > 1 ? `–D${ts[ts.length - 1]}` : ""}`; };
  const mt = $("mobTable");
  mt.innerHTML = `<thead><tr><th>Mob</th>${hasLvls ? "<th>Level</th>" : ""}<th>Kills</th><th>Avg fight</th><th>Avg XP</th><th>Avg coin</th><th>Damage</th><th>HP</th><th>Their DPS</th><th>Drops</th></tr></thead>`;
  const tb = el("tbody");
  shown.forEach((g, i) => {
    const isOpen = EXPANDED.has(g.mob);
    const items = g.drops.size;
    const lvlCell = !hasLvls ? "" :
      `<td>${g.lvls ? `<span class="tipv" data-tip="lp:moblvl:${i}">${g.lvls.lo === g.lvls.hi ? g.lvls.lo : `${g.lvls.lo}–${g.lvls.hi}`}</span>` : "—"}</td>`;
    const tr = el("tr", "mob-row" + (isOpen ? " open" : ""),
      `<td class="c-name"><span class="m-caret" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>${mobCell(g.mob)}${g.rare ? ` <span class="m-rare">rare</span>` : ""}${g.zone ? ` <span class="m-zone">${g.zone}${tierTxt(g)}</span>` : ""}</td>` +
      lvlCell +
      `<td><span class="tipv" data-tip="lp:mobkills:${i}">${g.kills}${g.fights > g.kills ? ` <span class="f-open">+${g.fights - g.kills}</span>` : ""}</span></td>` +
      `<td>${g.fights ? Math.round(g.secs / g.fights) + "s" : "—"}</td>` +
      `<td>${g.xpKills && g.xp ? `<span class="tipv" data-tip="lp:mobxp:${i}">${(g.xp / Math.max(1, g.kills - g.rollKills)).toFixed(2)}%</span>` : "—"}</td>` +
      `<td>${g.kills && g.coin ? `<span class="tipv" data-tip="lp:mobcoin:${i}">${fmtCopper(g.coin / g.kills)}</span>` : "—"}</td>` +
      `<td class="c-dmg">${fmt(g.dmg)}</td>` +
      `<td>${g.hp ? `<span class="tipv" data-tip="lp:mobhp:${i}">${g.hp[0] === g.hp[1] ? fmt(g.hp[0]) : `${fmt(g.hp[0])}–${fmt(g.hp[1])}`}${g.hp[3] ? ` <span class="f-open">mixed</span>` : ""}</span>` : "—"}</td>` +
      `<td>${g.offSum ? `<span class="tipv" data-tip="lp:mobdps:${i}">${(g.offSum / Math.max(1, g.offSecsSum)).toFixed(1)}</span>` : "—"}</td>` +
      `<td>${items ? `${items} item${items === 1 ? "" : "s"}` : "—"}</td>`);
    tr.addEventListener("click", ev => {
      if (ev.target.closest("[data-tip], a")) return; // tips and wiki links own their clicks
      if (EXPANDED.has(g.mob)) EXPANDED.delete(g.mob); else EXPANDED.add(g.mob);
      render();
    });
    tb.append(tr);
    if (!isOpen) return;
    const drops = [...g.drops.values()].sort((x, y) => y.times - x.times);
    if (drops.length) loadWikiItems();
    const dropRows = drops.map(d =>
      `<tr><td class="c-name">${itemCell(d.item)}</td><td>${d.times} of ${g.kills || "?"}</td><td>${g.kills ? (100 * d.times / g.kills).toFixed(1) + "%" : "—"}</td><td>${d.qty > d.times ? (d.qty / d.times).toFixed(1) : "1"}</td></tr>`).join("");
    const encs = g.enc.slice().sort((x, y) => y.start - x.start);
    const encShown = encs.slice(0, 15);
    const encRows = encShown.map(f => {
      const dur = Math.max((f.end - f.start) / 1000, 1);
      return `<tr class="enc-row${selFight === fkey(f) ? " on" : ""}">` +
        `<td class="c-name">${dtShort(f.start)}${f.killed ? "" : ` <span class="f-open">unfinished</span>`}</td>` +
        `<td>${Math.round(dur)}s</td><td class="c-dmg">${fmt(f.total)}</td><td>${rateDps(f.total, dur)}</td>` +
        `<td>${f.taken ? fmt(f.taken) : "—"}</td>` +
        `<td>${f.killed && f.hpMin != null ? `<span class="tipv" data-tip="lp:enchp">${fmt(f.hpMin)}–${fmt(f.hpMax)}${f.tainted ? "?" : ""}</span>` : "—"}</td>` +
        `<td>${f.xp ? f.xp.toFixed(2) + "%" : "—"}</td><td>${f.coin ? fmtCopper(f.coin) : "—"}</td>` +
        `<td class="c-foc">${selFight === fkey(f) ? "focused" : "focus"}</td></tr>`;
    }).join("");
    const detail = el("tr", "mob-detail", `<td colspan="${nCols}"><div class="detail-grid">` +
      (drops.length ? `<div class="d-block"><h4>Drops</h4><table class="mini-tbl"><thead><tr><th>Item</th><th>Dropped</th><th><span class="tipv" data-tip="lp:droprate">Rate</span></th><th>Per drop</th></tr></thead><tbody>${dropRows}</tbody></table></div>` : "") +
      `<div class="d-block"><h4>Fights${encs.length > encShown.length ? ` <span class="f-open">newest ${encShown.length} of ${encs.length}</span>` : ""}</h4><div class="tblwrap"><table class="mini-tbl enc-tbl"><thead><tr><th>When</th><th>Length</th><th>Damage</th><th>Est. DPS</th><th>Took</th><th>HP</th><th>XP</th><th>Coin</th><th></th></tr></thead><tbody>${encRows}</tbody></table></div></div>` +
      `</div></td>`);
    detail.querySelectorAll(".enc-row").forEach((rr, ri) => rr.addEventListener("click", ev2 => {
      ev2.stopPropagation();
      const fid = fkey(encShown[ri]);
      $("fightSel").value = selFight === fid ? "*" : fid;
      render();
    }));
    tb.append(detail);
  });
  mt.append(tb);
  if (!rows.length) mt.append(el("tbody", null, `<tr><td colspan="${nCols}" class="empty">No fights in this slice.</td></tr>`));
  const more = $("mobMore");
  if (rows.length > 20) { more.hidden = false; more.textContent = SHOW_ALL_MOBS ? "Show top 20" : `Show all ${rows.length} mobs`; }
  else more.hidden = true;
  $("mobPanel").hidden = !rows.length;
}

function renderLoot(a) {
  const lp = $("lootPanel");
  if (!a.loot.length && !a.copper) { lp.hidden = true; return; }
  lp.hidden = false;
  if (a.loot.length) loadWikiItems();
  const lt = $("lootTable");
  lt.innerHTML = `<thead><tr><th>Item</th><th>Count</th><th>Where it went</th><th>Vendor coin</th></tr></thead>`;
  const tb = el("tbody");
  const rows = SHOW_ALL_LOOT ? a.loot : a.loot.slice(0, 12);
  for (const l of rows) {
    const dest = [l.kept ? `kept ${l.kept}` : "", l.depot ? `depot ${l.depot}` : "", l.sold ? "auto-sold" : ""].filter(Boolean).join(" · ") || "—";
    tb.append(el("tr", null, `<td class="c-name">${itemCell(l.item)}</td><td>${fmt(l.qty)}</td><td class="c-el">${dest}</td><td class="c-dmg">${l.sold ? fmtCopper(l.sold) : "—"}</td>`));
  }
  lt.append(tb);
  const more = $("lootMore");
  if (a.loot.length > 12) { more.hidden = false; more.textContent = SHOW_ALL_LOOT ? "Show top 12" : `Show all ${a.loot.length} items`; }
  else more.hidden = true;
}

/* ─── skill-ups & faction: the log's other progression lines ──────────────*/
function renderProgress(a) {
  const panel = $("progressPanel");
  const hasSkills = a.skillups.length > 0, hasFaction = a.faction.length > 0;
  if (!hasSkills && !hasFaction) { panel.hidden = true; return; }
  panel.hidden = false;
  const sb = $("skillBlock");
  sb.hidden = !hasSkills;
  if (hasSkills) {
    const st = $("skillTable");
    st.innerHTML = `<thead><tr><th>Skill</th><th>Ups</th><th>Now at</th></tr></thead>`;
    const stb = el("tbody");
    for (const s of a.skillups) stb.append(el("tr", null, `<td class="c-name">${esc(s.skill)}</td><td>${s.ups}</td><td>${s.val}</td>`));
    st.append(stb);
  }
  const fb = $("factionBlock");
  fb.hidden = !hasFaction;
  if (hasFaction) {
    const ft = $("factionTable");
    ft.innerHTML = `<thead><tr><th>Faction</th><th>Changes</th><th>Net</th></tr></thead>`;
    const ftb = el("tbody");
    for (const f of a.faction) {
      const net = f.net > 0 ? `+${f.net}` : f.net < 0 ? `${f.net}` : f.capped ? "" : "0";
      // "capped" = the could-not-possibly-get-any-better/worse line: standing
      // moved to (or sat at) its floor or ceiling, amount unknown
      ftb.append(el("tr", null, `<td class="c-name">${esc(f.fac)}</td><td>${f.hits}</td><td class="c-dmg">${net}${f.capped ? `${net ? " · " : ""}at the cap ×${f.capped}` : ""}</td>`));
    }
    ft.append(ftb);
  }
}

function currentLevels() {
  const v = $("levelSel").value;
  if (v === "*") return null;
  // "?" = the unknown-level bucket: events between a detected loadout swap
  // and the next ding or /who. A null level is NOT a wildcard — it only
  // shows under "Whole log" and here.
  if (v === "?") return { has: l => l == null };
  const set = v.startsWith("last2") ? new Set(STATE.seg.levels.slice(-2)) : new Set([+v]);
  return { has: l => l != null && set.has(l) };
}
// zone slice: base zone, then optionally one difficulty, then one visit.
// Visit options carry the visit's START TIMESTAMP, not its index — indices
// renumber when the 40 MB live-watch window slides and would silently snap
// the selection to a different visit. The stale-key case resolves to -1,
// which matches nothing.
function currentZone() {
  const z = $("zoneSel").value;
  if (z === "*") return null;
  const t = $("tierSel").value, v = $("visitSel").value;
  let visit = null;
  if (v !== "*") {
    const vv = STATE.seg.visits.find(x => x.name === z && String(x.ts.getTime()) === v);
    visit = vv ? vv.id : -1;
  }
  return { zone: z, tier: t === "*" ? null : +t, visit };
}
const zoneHas = (zf, zone, tier, zv) => !zf ||
  (zone === zf.zone && (zf.tier == null || (tier || 0) === zf.tier) && (zf.visit == null || zv === zf.visit));
const TIER_WORD = { 1: "Awakened", 2: "Adaptive", 3: "Fused", 4: "Refined" };
// difficulty and visit only appear once a zone is picked, and only when the
// log actually has more than one of them there — empty selects are noise
function syncZoneControls(keep) {
  const { seg } = STATE;
  const z = $("zoneSel").value;
  const ts = $("tierSel"), vs = $("visitSel");
  const prevT = keep ? ts.value : "*", prevV = keep ? vs.value : "*";
  const vlist = z === "*" ? [] : seg.visits.filter(v => v.name === z);
  const tiers = [...new Set(vlist.map(v => v.tier))].sort((a, b) => a - b);
  ts.innerHTML = ""; ts.append(new Option("All difficulties", "*"));
  if (z !== "*" && tiers.length > 1) {
    $("tierCtl").hidden = false;
    for (const t of tiers) ts.append(new Option(t === 0 ? "D0 · base" : `D${t} · ${TIER_WORD[t]}`, String(t)));
    if ([...ts.options].some(o => o.value === prevT)) ts.value = prevT;
  } else $("tierCtl").hidden = true;
  const tval = ts.value;
  const vshow = vlist.filter(v => tval === "*" || v.tier === +tval);
  vs.innerHTML = ""; vs.append(new Option("All visits", "*"));
  if (z !== "*" && vshow.length > 1) {
    $("visitCtl").hidden = false;
    for (const v of vshow) vs.append(new Option(`${dtShort(v.ts)}${tiers.length > 1 ? ` · D${v.tier}` : ""}`, String(v.ts.getTime())));
    if ([...vs.options].some(o => o.value === prevV)) vs.value = prevV;
  } else $("visitCtl").hidden = true;
}
function buildControls(keepSelections) {
  const { P, seg, side } = STATE;
  const w = P.who;
  const prevLevel = keepSelections ? $("levelSel").value : null;
  const prevCombo = keepSelections ? $("comboSel").value : null;
  const pets = [...new Set(side.claims.names.filter(c => c.kind === "pet").map(c => c.name))];
  const charms = [...new Set(side.claims.names.filter(c => c.kind === "charm").map(c => c.name))];
  $("whoLine").innerHTML = `<span class="who-name">${P.owner}</span>` +
    (w ? `<span class="who-meta">${w.race} · ${w.classes} · ${w.zone}</span>` : "") +
    (pets.length ? `<span class="who-pet tipv" data-tip="lp:pets">pets: ${pets.slice(0, 4).join(", ")}${pets.length > 4 ? "…" : ""}</span>` : `<span class="who-pet dim tipv" data-tip="lp:pets">no pet detected</span>`) +
    (charms.length ? `<span class="who-pet tipv" data-tip="lp:pets">charm: ${charms.slice(0, 3).join(", ")}${charms.length > 3 ? "…" : ""}</span>` : "") +
    (seg.levels.length ? `<span class="who-lvl">levels ${seg.levels[0]}–${seg.levels[seg.levels.length - 1]}</span>` : "") +
    (seg.swapAt ? `<span class="who-swap tipv" data-tip="lp:swap">loadout swap? ${dtShort(seg.swapAt)}</span>` : "");
  const ls = $("levelSel"); ls.innerHTML = "";
  if (seg.levels.length >= 2) ls.append(new Option(`Last 2 levels (${seg.levels.slice(-2).join(", ")})`, "last2"));
  ls.append(new Option("Whole log", "*"));
  for (const lv of [...seg.levels].reverse()) ls.append(new Option(`Level ${lv}`, String(lv)));
  if (seg.hasUnknown) ls.append(new Option("Level unknown", "?"));
  ls.value = prevLevel && [...ls.options].some(o => o.value === prevLevel) ? prevLevel : (seg.levels.length >= 2 ? "last2" : "*");
  const prevZone = keepSelections ? $("zoneSel").value : null;
  const zs = $("zoneSel"); zs.innerHTML = ""; zs.append(new Option("All zones", "*"));
  const zseen = new Set();
  for (const v of seg.visits) if (!zseen.has(v.name)) { zseen.add(v.name); zs.append(new Option(v.name, v.name)); }
  $("zoneCtl").hidden = zseen.size === 0;
  if (prevZone && [...zs.options].some(o => o.value === prevZone)) zs.value = prevZone;
  syncZoneControls(keepSelections);
  const combos = [...new Set(P.events.filter(e => e.k === "dmg").map(e => e.combo))];
  const cs = $("comboSel"); cs.innerHTML = ""; cs.append(new Option("All combos", "*")); for (const c of combos) cs.append(new Option(c, c));
  if (prevCombo && [...cs.options].some(o => o.value === prevCombo)) cs.value = prevCombo;
  // the select lists the SAME fights as the mob-table encounters (every
  // clickable row must have an option, or setting the value silently lands
  // on fight 0)
  const prevFight = keepSelections ? $("fightSel").value : null;
  const fs = $("fightSel"); fs.innerHTML = ""; fs.append(new Option("All fights", "*"));
  for (const f of seg.fights.filter(f => f.total > 0 || f.taken > 0).sort((x, y) => y.start - x.start)) fs.append(new Option(`${f.mob} · ${dtShort(f.start)} · ${fmt(f.total)} dmg`, fkey(f)));
  if (prevFight && [...fs.options].some(o => o.value === prevFight)) fs.value = prevFight;
}

/* ─── copy summary (for Discord / guild chat) ─────────────────────────────*/
function buildSummary() {
  const { P, seg, side } = STATE;
  const selLevels = currentLevels(), selFight = $("fightSel").value;
  const focus = selFight === "*" ? null : seg.fights.find(f => fkey(f) === selFight) || null;
  if (focus) {
    const dur = Math.max((focus.end - focus.start) / 1000, 1);
    return `${P.owner} vs ${focus.mob} — ${Math.round(dur)}s, ${fmt(focus.total)} damage` +
      (dur >= MIN_RATE_SEC ? ` (${rateDps(focus.total, dur)} DPS)` : "") +
      (focus.taken ? `, took ${fmt(focus.taken)}` : "") + (focus.xp ? `, ${focus.xp.toFixed(2)}% xp` : "") +
      `\nparsed in the browser at eqltools.com/log-parser`;
  }
  let events = P.events;
  if (selLevels) events = events.filter(e => selLevels.has(e.lvl));
  const selZone = currentZone();
  if (selZone) events = events.filter(e => zoneHas(selZone, e.zone, e.ztier, e.zv));
  const selCombo = $("comboSel").value;
  if (selCombo !== "*") events = events.filter(e => e.combo === selCombo);
  const oc = P.who ? P.who.classes.split("/") : null;
  const a = analyze(P, events, side, oc);
  const dps = a.combatSec >= MIN_RATE_SEC ? `${fmt(a.total / a.combatSec)} DPS over ${Math.round(a.combatSec / 60)}m` : "—";
  let fightsInSlice = seg.fights.filter(f => f.total > 0 || f.taken > 0);
  if (selLevels) fightsInSlice = fightsInSlice.filter(f => selLevels.has(f.lvl));
  if (selZone) fightsInSlice = fightsInSlice.filter(f => zoneHas(selZone, f.zone, f.tier, f.zv));
  if (selCombo !== "*") fightsInSlice = fightsInSlice.filter(f => f.combo === selCombo);
  const kills = fightsInSlice.filter(f => f.killed && (f.killer === P.owner || side.claims.at(f.killer, f.end))).length;
  const share = [["you", a.tot.you], ["pets", a.tot.pet], ["charm", a.tot.charm]].filter(([, v]) => v)
    .map(([k, v]) => `${k} ${pct(v, a.total)}`).join(" · ");
  const top = a.sources.slice(0, 3).map(s => `${s.name} ${fmt(s.dmg)}`).join(" · ");
  const slice = $("levelSel").selectedOptions[0].textContent +
    (selZone ? ` · ${selZone.zone}${selZone.tier != null ? ` D${selZone.tier}` : ""}${selZone.visit != null ? ` · one visit` : ""}` : "");
  const activeH = a.activeSecs / 3600;
  const paceTxt = activeH >= 1 / 6 && a.xp > 0 ? `\n${(a.xp / activeH).toFixed(1)}% xp/hr over ${activeH.toFixed(1)}h active` : "";
  return `${P.owner}${P.who ? ` (${P.who.classes})` : ""} — ${slice}\n` +
    `${fmt(a.total)} damage · ${dps} · ${kills} kills · ${a.deaths.length} deaths` +
    (a.xp ? ` · ${a.xp >= 100 ? (a.xp / 100).toFixed(1) + " levels" : a.xp.toFixed(1) + "% xp"}` : "") +
    (a.copper ? ` · ${fmtCopper(a.copper)}` : "") +
    `\n${share}\ntop: ${top}${paceTxt}\nparsed in the browser at eqltools.com/log-parser`;
}

/* ─── intake ──────────────────────────────────────────────────────────────*/
const CAP = 40 * 1024 * 1024;
async function handleFile(file, opts = {}) {
  $("err").hidden = true;
  try {
    await Promise.all([loadSpellData(), loadConBands()]);
    const truncated = file.size > CAP;
    const blob = truncated ? file.slice(file.size - CAP) : file;
    let text = await blob.text();
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
    const ownerFromName = (file.name.match(/eqlog_([^_]+)_/) || [])[1];
    const P = parse(text, ownerFromName);
    if (!P.events.some(e => e.k === "dmg")) { showErr("No combat found — is this an EQ Legends log with logging on (/log on)?"); return; }
    const claims = buildClaims(P);
    STATE = { P, claims, side: mkSide(P, claims) };
    STATE.seg = buildSegments(P, STATE.side);
    buildControls(opts.keepSelections);
    $("intake").hidden = true; $("report").hidden = false;
    const tn = $("truncNote");
    if (truncated) { tn.hidden = false; tn.textContent = `Large file — read the last 40 MB (from ${dt(P.events[0].ts)}). Earlier history isn't shown.`; } else tn.hidden = true;
    render();
    if (!opts.keepSelections) $("report").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { showErr("Couldn't read that file: " + e.message); console.error(e); }
}
function showErr(msg) { const e = $("err"); e.hidden = false; e.textContent = msg; }

/* ─── live watch (Chromium: File System Access API re-reads the handle) ───*/
let WATCH = null; // { handle, size, timer }
async function startWatch() {
  stopWatch();
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "EQ Legends log", accept: { "text/plain": [".txt"] } }],
    });
    const file = await handle.getFile();
    await handleFile(file);
    WATCH = { handle, size: file.size, timer: setInterval(pollWatch, 5000) };
    $("watchNote").hidden = false;
  } catch (e) { if (e.name !== "AbortError") showErr("Couldn't watch that file: " + e.message); }
}
async function pollWatch() {
  if (!WATCH) return;
  try {
    const file = await WATCH.handle.getFile();
    if (file.size === WATCH.size) return;
    WATCH.size = file.size;
    await handleFile(file, { keepSelections: true });
    $("watchNote").hidden = false;
  } catch { stopWatch(); }
}
function stopWatch() {
  if (WATCH) { clearInterval(WATCH.timer); WATCH = null; }
  $("watchNote").hidden = true;
}

const dz = $("dropZone"), fi = $("logFile");
dz.addEventListener("click", () => fi.click());
fi.addEventListener("change", e => { const f = e.target.files[0]; if (f) { stopWatch(); handleFile(f); } });
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("over"); }));
dz.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) { stopWatch(); handleFile(f); } });
["levelSel", "comboSel", "fightSel", "visitSel"].forEach(id => $(id).addEventListener("change", render));
$("zoneSel").addEventListener("change", () => { syncZoneControls(false); render(); });
$("tierSel").addEventListener("change", () => { syncZoneControls(true); render(); });
$("mobMore").addEventListener("click", () => { SHOW_ALL_MOBS = !SHOW_ALL_MOBS; render(); });
$("lootMore").addEventListener("click", () => { SHOW_ALL_LOOT = !SHOW_ALL_LOOT; render(); });
$("btnReset").addEventListener("click", () => { stopWatch(); STATE = null; $("report").hidden = true; $("intake").hidden = false; fi.value = ""; window.scrollTo({ top: 0, behavior: "smooth" }); });
$("btnCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(buildSummary()); const b = $("btnCopy"); b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy summary"; }, 1500); }
  catch { showErr("Couldn't reach the clipboard — your browser may be blocking it."); }
});
if (window.showOpenFilePicker) {
  $("btnWatch").hidden = false;
  $("btnWatch").addEventListener("click", startWatch);
}
if (window.EQLTip) { EQLTip.provider("lp", tipProvider); EQLTip.init(); }

/* ─── embedded intake (EQL Tools Companion iframe) ────────────────────────
   ?embed=1 drops the site chrome and the file intake; the embedder tails the
   log itself and posts {type:"eqlt-log", text, name, keep}. A File keeps
   handleFile's single intake path, and parsing stays local either way. Not
   an attribution/grammar change — logparse_ref.py intentionally untouched.
   typeof-guarded: the verification harness runs this file without a DOM. */
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("embed")) {
  document.body.classList.add("embed");
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (d && d.type === "eqlt-log" && typeof d.text === "string")
      handleFile(new File([d.text], String(d.name || "eqlog.txt")), { keepSelections: !!d.keep });
  });
}
