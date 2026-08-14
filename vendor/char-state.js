/* DO NOT EDIT — generated copy of public/_shared/char-state.js (companion/scripts/sync-vendor.mjs).
   Edit the original; both the site and this app load the same logic. */
/* EQLChar — the one place the visitor's trio + level lives.
   Every tool that asks for classes reads and writes THIS store, so picking a
   trio on one page follows you to the next. First load seeds from the keys
   the pages used before it existed (combat's eqlstats.char, picker's trio).

   API: EQLChar.load() -> {classes:[3 short codes], level:int}
        EQLChar.save(state)          — persists + notifies this tab's listeners
        EQLChar.onChange(fn)         — fires on save() and on cross-tab writes
        EQLChar.CLASSES / NAMES      — the 16 codes and full names, same order
        EQLChar.name(code) / EQLChar.code(name)
*/
(function () {
  "use strict";
  const KEY = "eqlt-char-v1";
  const MAXLVL = 50;
  const CLASSES = ["WAR", "CLR", "PAL", "RNG", "SHD", "DRU", "MNK", "BRD",
                   "ROG", "SHM", "NEC", "WIZ", "MAG", "ENC", "BST", "BER"];
  const NAMES = ["Warrior", "Cleric", "Paladin", "Ranger", "Shadow Knight",
                 "Druid", "Monk", "Bard", "Rogue", "Shaman", "Necromancer",
                 "Wizard", "Magician", "Enchanter", "Beastlord", "Berserker"];
  const listeners = [];

  function valid3(a) {
    return Array.isArray(a) && a.length === 3 &&
      a.every((c) => CLASSES.includes(c)) && new Set(a).size === 3;
  }
  function clampLvl(v) { return Math.min(MAXLVL, Math.max(1, v | 0 || 50)); }

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
  }

  function load() {
    const s = read(KEY);
    if (s && valid3(s.classes)) {
      return { classes: s.classes.slice(), level: clampLvl(s.level),
               race: typeof s.race === "string" ? s.race : null };
    }
    const c = read("eqlstats.char");            // combat's pre-shared key
    // picker's trio seeds too; its race field is a slug key, not a race name,
    // so race never seeds from it
    const p = read("eqlt-picker-v5");
    if (c && valid3(c.c)) return { classes: c.c.slice(), level: clampLvl(c.lvl), race: null };
    if (p && valid3(p.trio)) return { classes: p.trio.slice(), level: 50, race: null };
    return { classes: ["WAR", "CLR", "WIZ"], level: 50, race: null };
  }

  function save(state) {
    // an invalid trio (duplicates, bad codes) keeps the last good one rather
    // than silently resetting the visitor to the default
    const s = { classes: valid3(state.classes) ? state.classes.slice() : load().classes,
                level: clampLvl(state.level),
                race: typeof state.race === "string" ? state.race : null };
    localStorage.setItem(KEY, JSON.stringify(s));
    listeners.forEach((fn) => fn(s));
  }

  window.addEventListener("storage", (e) => {
    if (e.key === KEY) listeners.forEach((fn) => fn(load()));
  });

  window.EQLChar = {
    load, save,
    onChange: (fn) => listeners.push(fn),
    CLASSES, NAMES, MAXLVL,
    name: (code) => NAMES[CLASSES.indexOf(code)] || code,
    code: (name) => CLASSES[NAMES.indexOf(name)] || name,
  };
})();
