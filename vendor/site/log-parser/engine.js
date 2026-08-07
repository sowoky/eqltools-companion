"use strict";
/* EQ Legends Combat Log Parser — ENGINE (DOM-free). The grammar, event
   model, claims, fights, per-mob aggregates, level timeline, segments, and
   the analyze() roll-up. No DOM, no rendering: /log-parser/app.js is the
   page that consumes it (window.EQLLog), pipeline/scripts/logparse_harness.mjs
   is the node consumer, and the EQL Tools Companion loads it for its live
   Combat tab. Split from app.js 2026-08-06 as pure code motion — the
   algorithm and both-transcriptions contract (logparse_ref.py, diffed by
   check_log_parser.py) are unchanged; attribution reasoning stays inline at
   each rule (.claude/rules/log-parser.md). Every damage line becomes an
   actor→target event; buildClaims decides whose side each actor is on, and
   WHEN. Fights are per-mob encounters closed by the mob's death line; the
   xp/coin/faction burst just BEFORE a death line carries the kill's XP and
   coin. */

// local-calendar-date key ("2026-08-06") — string compare == same-day compare
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
  loot:      new RegExp(TS + String.raw`You looted (?:an? |(\d+) )?(.+?) from (.+?)'s corpse(?:\.| (and stored it in your (?:tradeskill depot|Dragon Hoard|currency)|and sold it for free\.|and sold it for (.+?)\.|to create an? .+))?$`),
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
  // the real line always names the spell ("Your Minor Healing spell
  // fizzles!", 602 in the 2026-08-06 Ravlin log) — a nameless form never
  // matched anything and left every fizzle uncounted
  fizzle:    new RegExp(TS + String.raw`Your (.+?) spell fizzles!$`),
  nomana:    new RegExp(TS + String.raw`Insufficient Mana`),
  resist:    new RegExp(TS + String.raw`(.+?) resisted your (.+?)!$`),
  // incoming — present tense observed ("You resist a large plague rat's
  // Plague Rat Disease!", 710×); "resisted" is defensive. Must run before
  // resist_other or the defensive past-tense form lands there with src "You".
  resist_in: new RegExp(TS + String.raw`You resist(?:ed)? (.+?)'s (.+?)!$`),
  // a NAMED caster's spell resisted — the caster can be your pet ("An elf
  // skeleton resisted Ravlin`s warder's Spirit of Lightning Strike!"). Runs
  // after `resist`, whose literal "resisted your" wins possessive spell names.
  resist_other: new RegExp(TS + String.raw`(.+?) resisted (.+?)'s (.+?)!$`),
  stance:    new RegExp(TS + String.raw`You assume an? ([\w ]+?) stance\.$`),
  invoke:    new RegExp(TS + String.raw`You begin reciting the ([\w ]+?) invocation\.$`),
  wornoff:   new RegExp(TS + String.raw`Your (.+?) spell has worn off(?: of (.+?))?\.$`),
  // one CC family, four verbs — all but "entranced" observed 2026-08-06
  mezzed:    new RegExp(TS + String.raw`(.+?) has been (?:mesmerized|enthralled|entranced|ensnared)\.$`),
  // the charm broadcast names no caster (every player in the zone sees it);
  // it proves the name is a MOB and nothing about whose pet it is — claims
  // still come only from the pet's own tells
  charmbc:   new RegExp(TS + String.raw`(.+?) has been charmed\.$`),
  // the client states which special is live behind a generic melee verb —
  // Kick, Round Kick and Flying Kick all print "kick" in damage lines
  special:   new RegExp(TS + String.raw`You will now use (.+?)(?: instead of (.+?))? while (?:auto )?attacking\.$`),
  login:     new RegExp(TS + String.raw`Welcome to EverQuest Legends!$`),
  // no trailing period on the merge line; the item name carries its "+N" tier
  merge:     new RegExp(TS + String.raw`You have successfully merged two items together to create a new item: (.+)$`),
  // one prefix, several stated reasons (weak mote / self-fuse / different
  // types observed 2026-08-06) — capture the reason so new ones surface
  mergefail: new RegExp(TS + String.raw`The item you are trying to add will not work, (.+?)\.$`),
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
  "resist","resist_in","resist_other","stance","invoke","wornoff","mezzed","charmbc","nonmelee_you","mend","protected","ds_absorb","ds_rev","who","targeted","fizzle","nomana",
  "special","login","merge","mergefail"];
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
      // agree in real logs) — without the split each tier reads as its own
      // zone. A " - Solo"/" - Group" marker means a RAID instance — the
      // voidling-spawned copy for a raid attempt (Kyle, 2026-08-06); ordinary
      // entries of the same zone print bare. Observed: "The Ruins of Old
      // Paineel - Solo.", "The Permafrost Caverns - Group 4 (Refined)." —
      // the tier WORD is authoritative there; the numeral after Group is not
      // cross-checked (its meaning is unconfirmed).
      case "zone":   if (!/^(an area|an Arena|the Drunken Monkey)/.test(m[8])) {
        const TIERW = { Awakened: 1, Adaptive: 2, Fused: 3, Refined: 4 };
        let name = m[8], raid = null, tier = 0;
        const rm = /^(.*) - (Solo|Group)((?: \d+)?(?: \((?:Awakened|Adaptive|Fused|Refined)\))?)$/.exec(name);
        if (rm) {
          raid = rm[2].toLowerCase(); name = rm[1];
          const w = /\((Awakened|Adaptive|Fused|Refined)\)/.exec(rm[3]);
          if (w) tier = TIERW[w[1]];
        }
        const tm = /^(.*) ([1-4]) \((?:Awakened|Adaptive|Fused|Refined)\)$/.exec(name);
        if (tm) { name = tm[1]; tier = +tm[2]; }
        ev.push({ ts, k: "zone", name, tier, raid });
      } break;
      case "level":  ev.push({ ts, k: "level", lvl: +m[8] }); break;
      case "interrupt": ev.push({ ts, k: "interrupt", spell: m[8] }); break;
      case "resist": ev.push({ ts, k: "resist", tgt: resolve(m[8]), spell: m[9] }); break;
      case "resist_in": ev.push({ ts, k: "resist_in", caster: resolve(m[8]), spell: m[9] }); break;
      // never touches fights or claims — display and summary only
      case "resist_other": ev.push({ ts, k: "resist_other", tgt: resolve(m[8]), caster: resolve(m[9]), spell: m[10] }); break;
      case "stance": ev.push({ ts, k: "stance", name: m[8].trim() }); break;
      case "invoke": ev.push({ ts, k: "invoke", name: m[8].trim() }); break;
      // your spell fading off a NAME both refreshes its fight (like mez) and
      // marks a moment the name can change hands (a charm break) — buildClaims
      // treats every "shed" as a claim boundary
      case "wornoff": if (m[9]) ev.push({ ts, k: "shed", tgt: resolve(m[9]) }); break;
      case "mezzed": ev.push({ ts, k: "mez", tgt: resolve(m[8]) }); break;
      // proves the name is a mob (broadcast, casterless) — never a claim
      case "charmbc": ev.push({ ts, k: "charm_bc", tgt: resolve(m[8]) }); break;
      case "special": ev.push({ ts, k: "special", name: m[8], prev: m[9] || null }); break;
      case "login": ev.push({ ts, k: "login" }); break;
      case "merge": ev.push({ ts, k: "merge", item: m[8] }); break;
      case "mergefail": ev.push({ ts, k: "mergefail", reason: m[8] }); break;
      case "nonmelee_you": ev.push({ ts, k: "dmg", cat: "dot", src: null, tgt: owner, amt: +m[8], spell: "non-melee", flags: [] }); break;
      case "mend": ev.push({ ts, k: "mend", ok: m[8].includes("heal") }); break;
      // a blocked hostile cast is a "miss" against you — it feeds the avoided
      // tally and mob presence exactly like a dodged swing
      case "protected": ev.push({ ts, k: "miss", src: resolve(m[8]), tgt: owner, how: "protected" }); break;
      // your own /who line prints your CURRENT level — a hard anchor the
      // level timeline uses to recover after a silent loadout swap
      case "who": if (m[10] === owner || m[10] === fileOwner) { who = { lvl: +m[8], classes: m[9], name: m[10], race: m[11], zone: m[12] }; ev.push({ ts, k: "who", lvl: +m[8] }); } break;
      case "targeted": if (m[8] === "Player") players.add(resolve(m[9])); break;
      case "fizzle": ev.push({ ts, k: "fizzle", spell: m[8] }); break;
      case "nomana": ev.push({ ts, k: "nomana" }); break;
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
  // e.day and visit.days are UI slice keys (the Day control), not part of the
  // two-transcription contract — logparse_ref.py intentionally untouched, the
  // diffed summary carries no day field. Log timestamps are the writing
  // machine's local clock, so a day boundary here is the player's own midnight.
  for (const e of ev) {
    if (e.k === "zone") { vi++; zn = e.name; zt = e.tier; visits.push({ id: vi, name: zn, tier: zt, raid: e.raid || null, ts: e.ts, days: new Set() }); }
    e.zone = zn; e.ztier = zn ? zt : null; e.zv = zn ? vi : null;
    e.day = dayKey(e.ts);
    if (vi >= 0) visits[vi].days.add(e.day);
  }
  const spans = buildLevelSpans(ev);
  for (const sp of spans) for (let i = sp.i0; i < sp.i1; i++) ev[i].lvl = sp.lvl;
  const swaps = spans.filter(sp => sp.src === "swap" || sp.src === "post");
  const swapAt = swaps.length ? ev[swaps[0].i0].ts : null;
  const dings = ev.filter(e => e.k === "level").map(e => ({ lvl: e.lvl, ts: e.ts }));
  const stanceTl = ev.filter(e => e.k === "stance").map(e => [e.ts, e.name]);
  const invokeTl = ev.filter(e => e.k === "invoke").map(e => [e.ts, e.name]);
  const activeAt = (tl, ts) => { let n = null; for (const [t, x] of tl) { if (t <= ts) n = x; else break; } return n; };
  // special-attack lanes: "You will now use X instead of Y while attacking."
  // states which real skill sits behind a generic verb (Kick / Round Kick /
  // Flying Kick all print "kick"). Known lane→verb pairs seed the map; an
  // upgrade line teaches the new name its predecessor's verb. Display-only —
  // the diffed you_verbs summary stays keyed by the raw verb.
  const VERB_OF_SPECIAL = new Map([["kick", "kick"], ["round kick", "kick"], ["flying kick", "kick"],
    ["tiger claw", "strike"], ["eagle strike", "strike"], ["dragon punch", "strike"]]);
  const laneTl = new Map(); // verb -> [[ts, lane name]]
  for (const e of ev) {
    if (e.k !== "special") continue;
    let vb = VERB_OF_SPECIAL.get(e.name.toLowerCase());
    if (!vb && e.prev) vb = VERB_OF_SPECIAL.get(e.prev.toLowerCase());
    if (!vb) continue;
    VERB_OF_SPECIAL.set(e.name.toLowerCase(), vb);
    let tl = laneTl.get(vb); if (!tl) { tl = []; laneTl.set(vb, tl); }
    tl.push([e.ts, e.name]);
  }
  // events must carry lvl and combo BEFORE fights build — buildFights stamps
  // both onto each fight at its opening event
  for (const e of ev) {
    e.stance = activeAt(stanceTl, e.ts); e.invoke = activeAt(invokeTl, e.ts);
    e.combo = `${e.stance || "—"}  ·  ${e.invoke || "—"}`;
    if (e.src === P.owner && e.verb && laneTl.has(e.verb)) {
      const lane = activeAt(laneTl.get(e.verb), e.ts);
      // the base skill's own name adds nothing ("kick · Kick")
      if (lane && lane.toLowerCase() !== e.verb) e.lane = lane;
    }
  }
  const fights = buildFights(P, side);
  const levels = [...new Set(ev.map(e => e.lvl).filter(v => v != null))].sort((a, b) => a - b);
  return { dings, levels, spans, swapAt, visits, stanceTl, invokeTl, fights };
}

/* ─── class attribution (spell name → which of owner's 3 classes) ─────────*/
let ICON = null, SPCLASS = null;
const spellIcon = name => ICON ? ICON.get(name) : null;
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
        : SKILL_VERBS.has(e.verb) ? (e.lane || e.verb) : `auto-attack (${e.verb})`)
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
    else if (e.k === "dmg" && e.cat === "melee") { const s = verbRow(map, e.lane || e.verb); s.landed++; s.dmg += e.amt; if (e.amt > s.max) s.max = e.amt; }
    else if (e.k === "miss" && e.how !== "protected") verbRow(map, e.lane || e.verb).missed++;
  }
  const casts = events.filter(e => e.k === "cast").length;
  const interrupts = events.filter(e => e.k === "interrupt").length;
  const resists = events.filter(e => e.k === "resist").length;
  const fizzles = events.filter(e => e.k === "fizzle").length;
  const resistIn = events.filter(e => e.k === "resist_in").length;
  // a resisted named caster claimed at that moment is YOUR pet's resist
  const petResists = events.filter(e => e.k === "resist_other" && side.claims.at(e.caster, e.ts)).length;
  const merges = new Map(); let mergeFails = 0;
  for (const e of events) {
    if (e.k === "merge") merges.set(e.item, (merges.get(e.item) || 0) + 1);
    else if (e.k === "mergefail") mergeFails++;
  }
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
  // AFK and offline stretches never dilute the per-hour rates. A login line
  // ("Welcome to EverQuest Legends!") proves any preceding gap over a minute
  // was offline, so it cuts too — the reconnect burst prints 0–2s before the
  // Welcome, so a quick relog stays active and the error is bounded at ~30s
  let activeSecs = 0;
  for (let i = 1; i < events.length; i++) {
    const d = (events[i].ts - events[i - 1].ts) / 1000;
    if (events[i].k === "login" ? d <= 60 : d <= 1800) activeSecs += d;
  }
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
    casts, interrupts, resists, fizzles, resistIn, petResists, deaths, combatSec: secs, wallSecs, activeSecs,
    merges: [...merges.entries()].sort((a, b) => b[1] - a[1]), mergeFails,
    heals: [...heals.values()].sort((a, b) => b.real - a.real), healTot, overTot,
    healsIn: [...healsIn.values()].sort((a, b) => b.amt - a.amt), healInTot,
    skillups: [...skillups.values()].sort((a, b) => b.ups - a.ups || a.skill.localeCompare(b.skill)),
    faction: [...faction.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.hits - a.hits),
    taken: { dmg: takenDmg, landed: takenLanded, avoid: [...avoid.entries()].sort((a, b) => b[1] - a[1]) },
    petTaken, xp, aa, aaNow, copper, vendorSaleCu, vendorSales, miscCu,
    loot: [...loot.values()].sort((a, b) => (b.sold || b.qty * 500) - (a.sold || a.qty * 500)),
  };
}

/* ─── namespace ───────────────────────────────────────────────────────────*/
const EQLLog = {
  parse, buildClaims, mkSide, buildFights, markTaint, buildMobStats, resolveHp,
  buildLevelSpans, buildSegments, analyze, combatSecondsOf, classOf,
  loadSpellData, spellIcon, loadConBands, setConBands, conBand, conScore,
  conDiscriminative, fkey, epochSec, dayKey, inCopper, toDate, flagsOf,
  CLASS_ABBR, SKILL_VERBS, RANGED_VERBS, FIGHT_IDLE,
};
if (typeof window !== "undefined") window.EQLLog = EQLLog;
else if (typeof globalThis !== "undefined") globalThis.EQLLog = EQLLog;
