/* Dev-only: write a growing EQL-shaped log so the app's tail engine, stream
   parsing, tracker credit, and overlay can be exercised on a machine with no
   game client. Two modes:

     node scripts/simulate-log.mjs               # scenario: real zone + real
                                                 # Crushbone mobs + quest loots,
                                                 # a few lines every second
     node scripts/simulate-log.mjs --fixture     # replay the synthetic parser
                                                 # fixture (fake zone names —
                                                 # exercises grammar, not credit)

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

if (process.argv.includes("--fixture")) {
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
      b.push(`${now()} ${mob[0].toUpperCase() + mob.slice(1)} has been slain by Soronil!`);
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
