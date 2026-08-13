/* Dev-only: write a growing EQL-shaped log so the app's tail engine, stream
   parsing, tracker credit, and overlay can be exercised on a machine with no
   game client. Two modes:

     node scripts/simulate-log.mjs               # scenario: real zone + real
                                                 # Crushbone mobs + quest loots,
                                                 # a few lines every second
     node scripts/simulate-log.mjs --fixture     # replay the synthetic parser
                                                 # fixture (fake zone names —
                                                 # exercises grammar, not credit)
     node scripts/simulate-log.mjs --sky         # one-shot: a Plane of Sky log
                                                 # + matching inventory dump,
                                                 # for the Sky tab and widget

   Point the app's log folder at companion/tmp-logs. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const companion = resolve(here, "..");
const repo = resolve(companion, "..");
const outDir = join(companion, "tmp-logs");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "eqlog_Testchar_oggok.txt");

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const stamp = (d) => `[${DAYS[d.getDay()]} ${MONS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ` +
  [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":") + ` ${d.getFullYear()}]`;

/* ── --sky ────────────────────────────────────────────────────────────────
   The Sky tab needs a log with real turn-ins and a dump with the pieces sitting
   in real bag/bank slots, and no client on this machine writes one. Every name
   comes out of sky.json, so the scenario exercises the real matching rather
   than names invented to match. Written once, not streamed: this is a state to
   read, not a stream to watch. */
if (process.argv.includes("--sky")) {
  const sky = JSON.parse(readFileSync(join(repo, "public", "sky", "data", "sky.json"), "utf8"));
  const t0 = new Date(Date.now() - 3600e3);
  const at = (min) => stamp(new Date(t0.getTime() + min * 60000));
  const L = [`${at(0)} Welcome to EverQuest Legends!`, `${at(1)} You have entered The Plane of Sky.`];
  const bags = [];   // [location, item name]
  let m = 2;

  // pick(code, i) -> that class's i-th test
  const pick = (code, i) => sky.classes[code].tests[i];
  const loot = (n, mob, tail = ".") => L.push(`${at(m += 1)} You looted a ${n} from ${mob}'s corpse${tail}`);

  // 1. a test fully turned in — every piece offered, then the trade closes
  const done = pick("BER", 0);
  for (const it of done.items) loot(it.n, it.mob || "a spiroc guardian");
  loot(done.rune[0], "Protector of Sky", " and stored it in your currency");
  for (const it of done.items) L.push(`${at(m += 1)} You offered 1 ${it.n} to ${sky.classes.BER.giver}.`);
  L.push(`${at(m)} You offered 1 ${done.rune[0]} to ${sky.classes.BER.giver}.`);
  L.push(`${at(m += 1)} You complete the trade with ${sky.classes.BER.giver}.`);

  /* 2. tests READY — pieces and rune in hand, nothing handed over. One is
        chosen for having a component ANOTHER class's test also wants, which is
        the row the star has to appear on; a bag, a bag slot and a bank slot are
        used so all three badge shapes render. */
  const uses = new Map();
  for (const [code, c] of Object.entries(sky.classes))
    for (const t of c.tests)
      for (const it of t.items) uses.set(it.n, (uses.get(it.n) || []).concat(`${code}:${t.n}`));
  const shared = (t) => t.items.some((it) => (uses.get(it.n) || []).length > 1);
  const readyTests = [];
  for (const [code, locs] of [["PAL", ["General 1-Slot2", "General 2-Slot3"]], ["ROG", ["Bank5"]]]) {
    const t = sky.classes[code].tests.find(shared) || sky.classes[code].tests[0];
    readyTests.push(`${code} ${t.n}`);
    t.items.forEach((it, i) => { loot(it.n, it.mob || "a spiroc guardian"); bags.push([locs[i % locs.length], it.n]); });
    loot(t.rune[0], "Protector of Sky", " and stored it in your currency");
  }

  // 3. a test one piece short, and a piece the loot filter autosold on pickup
  const part = pick("WIZ", 0);
  loot(part.items[0].n, part.items[0].mob || "a spiroc guardian");
  bags.push(["General 3-Slot1", part.items[0].n]);
  const eaten = pick("SHM", 0);
  loot(eaten.items[0].n, "a bixie drone", " and sold it for 4gp.");

  // 4. the wrong class's pieces walked to a giver: he hands them back, and the
  //    trade still closes. Nothing may count.
  const wrong = pick("MNK", 0);
  loot(wrong.items[0].n, wrong.items[0].mob || "a spiroc guardian");
  L.push(`${at(m += 1)} You offered 1 ${wrong.items[0].n} to ${sky.classes.CLR.giver}.`);
  L.push(`${at(m)} ${sky.classes.CLR.giver} says, 'I have no need for this, Testchar. You can have it back.'`);
  L.push(`${at(m += 1)} You complete the trade with ${sky.classes.CLR.giver}.`);
  bags.push(["General 4", wrong.items[0].n]);

  writeFileSync(out, L.join("\n") + "\n");
  const inv = ["Location\tName\tID\tCount\tSlots",
    "Charm\tA Rabbit Foot\t1001\t1\t0",
    "General 1\tLarge Bag\t1100\t1\t10",
    "General 2\tLarge Bag\t1101\t1\t10",
    "General 3\tLarge Bag\t1102\t1\t10"];
  let id = 2000;
  for (const [loc, name] of bags) inv.push(`${loc}\t${name}\t${id++}\t1\t0`);
  const invOut = join(outDir, "Testchar_oggok-Inventory.txt");
  writeFileSync(invOut, inv.join("\n") + "\n");
  console.log(`sky scenario -> ${out} (${L.length} lines) and ${invOut} (${bags.length} pieces)`);
  console.log(`  turned in: BER ${done.n}`);
  console.log(`  ready:     ${readyTests.join(" / ")}`);
  console.log(`  autosold:  ${eaten.items[0].n} (wanted by SHM ${eaten.n})`);
} else if (process.argv.includes("--fixture")) {
  const src = join(repo, "pipeline", "tests", "fixtures", "eqlog_Testchar_oggok.txt");
  const lines = readFileSync(src, "utf8").split(/\r?\n/).filter(l => l.length);
  writeFileSync(out, "");
  console.log(`replaying ${lines.length} fixture lines -> ${out}`);
  let i = 0;
  const t = setInterval(() => {
    appendFileSync(out, lines.slice(i, i + 25).join("\n") + "\n");
    i += 25;
    if (i >= lines.length) { console.log("done"); clearInterval(t); }
  }, 1000);
} else {
  /* Real Crushbone mobs (wiki roster names) and real quest items so zone
     credit and the quest lookup both light up. */
  const MOBS = ["an orc pawn", "an orc centurion", "an orc legionnaire", "an orc oracle", "an orc trainee"];
  const LOOT = [
    "Crushbone Belt",        // classic turn-in — should hit the quest index
    "Glowing Mask",          // Acumen Mask Quest component
    "Bone Chips",            // several quests
    "Rusty Sword",           // mundane — should NOT flag
    "Patch of Shadow",       // Acumen Mask Quest component
  ];
  writeFileSync(out, `${stamp(new Date())} Welcome to EverQuest Legends!\n`);
  console.log(`scenario -> ${out} (Ctrl+C to stop)`);
  let step = 0;
  setInterval(() => {
    const now = () => stamp(new Date());
    const b = [];
    if (step === 0) b.push(`${now()} You have entered Clan Crushbone.`);
    const mob = MOBS[step % MOBS.length];
    if (step % 3 === 2) {
      // someone else's blow + xp inside the ±2s window → 'xp' credit
      b.push(`${now()} ${mob[0].toUpperCase() + mob.slice(1)} has been slain by Groupmate!`);
      b.push(`${now()} You gain party experience! (0.750%)`);
    } else {
      b.push(`${now()} You have slain ${mob}!`);
      b.push(`${now()} You gain experience! (1.250%)`);
    }
    if (step % 2 === 1) {
      const item = LOOT[(step >> 1) % LOOT.length];
      // alternate the two real loot formats: auto-loot and manual corpse-window
      b.push((step >> 1) % 2 === 0
        ? `${now()} You looted a ${item} from ${mob}'s corpse.`
        : `${now()} --You have looted a ${item} from ${mob}'s corpse.--`);
    }
    appendFileSync(out, b.join("\n") + "\n");
    step++;
  }, 2000);
}
