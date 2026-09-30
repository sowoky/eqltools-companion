# EQL Tools Companion

Companion app for [eqltools.com](https://eqltools.com) — reads your
EverQuest Legends log file in real time and can overlay the game window.

**Windows download:** grab `EQL-Tools-Companion-Setup-<version>.exe` from the
[latest release](https://github.com/sowoky/eqltools-companion/releases/latest).
It installs per-user — no admin rights needed — and keeps itself updated.

The build is not code-signed yet, so Windows flags the download. Either way
past works:

- When SmartScreen says "Windows protected your PC": **More info** → **Run
  anyway**.
- Or before running: right-click the downloaded file → **Properties** → check
  **Unblock** at the bottom → **OK**.

- **Quest-item loot alerts** — loot an item and the app tells you if it's a
  quest item, which quest wants it, what the reward is, one click to the
  quest's wiki page.
- **Gotta Kill 'Em All** — the eqltools.com kill tracker, fed live from your
  log instead of file drops. Same rules, same math: the app runs the site's
  own `shared.js` verbatim.
- **Item tooltips** — mouse over any item name and get the in-game item
  window: flags, slot, AC, stats, effect, weight, classes, races.
- **Inventory browser** — type `/out inventory` in game and every bag, bank
  slot, depot, and Dragon's Hoard row lands in one sortable table, in three
  readings. **Quest** shows which quests want each item, right on the row: the
  quest as a wiki link, its rewards with their in-game tooltips. **Gear** ranks
  everything you own and names the classes each piece is first pick for — a
  paired slot has two positions, so second-best still counts. **Spare** keeps
  only what nothing needs any more: beaten in every slot it fits, for every
  class that could wear it, sorted by how many of your own things beat it, with
  where each of those is sitting. An item at a lower upgrade rank is scaled up
  to its rival's before the comparison, and anything whose whole point is a
  click, a proc or a bard's resonance says so, because the score can't read
  those. Pick your own columns for more — stats at your upgrade tier, resists,
  effect, trade flags, class, era, drop sources. Search across all of it, filter
  by area, tradeability, or class. Exaltation sockets say what they are —
  `Head · Focus`, not `Slot7` — and hovering a stone tells you what it grants.
- **Auto-updates** — installed builds update themselves from GitHub
  Releases; portable/zip builds tell you when a new version is out.
- **Zone browser** — the atlas mobs & drops data, following your character:
  zone in and the app shows that zone's mobs (with your kill ✓s) and items
  (with quest flags), all linked to the wiki.
- **Overlay** — a translucent always-on-top panel over the game (windowed or
  borderless display mode; exclusive fullscreen draws past every window).
  `Ctrl+Shift+O` shows/hides it, `Ctrl+Shift+L` toggles click-through.

Your log is parsed locally and never leaves your machine. The only network
traffic is downloading data updates from eqltools.com. Quest and mob data
come from the community wiki (CC BY-SA 4.0).

Logging must be on in game: `/log`.

## Build

Use Node.js 22.12 or newer (Node.js 24 LTS is a suitable choice). The locked
Electron runtime is 44.4.5; Electron 38 is past its support window.

```
npm ci
node scripts/main-check.mjs
npm run dist:win     # → dist/  (per-user installer, x64)
```

### Linux x64

The app runs natively beside the Legends Windows client under Wine/Proton.
Build a portable archive from the published checkout:

```bash
npm ci
node scripts/main-check.mjs
npm run dist:linux   # → dist/EQL-Tools-Companion-<version>-linux-x64.tar.gz
```

Extract the archive and run `./eqltools-companion --ozone-platform=x11` from
the extracted directory. XWayland was tested on Ubuntu 24.04; native Wayland
overlay behavior has not been validated. The archive does not install system
files or update itself in place. Settings can notify you of a newer release.

The default Linux log folder is the isolated
[norrath-legends](https://github.com/williamzujkowski/norrath-legends) Proton
prefix under `~/.local/share/norrath-legends/`. It is selected only if it
exists. For other install layouts, use **Settings → Log folder** to choose
the Legends `Logs` directory. Type `/log on` in game. Inventory and
achievements exports beside `Logs` are watched automatically.

Ubuntu can report “No usable sandbox” for a user-owned Electron archive
because AppArmor restricts unprivileged user namespaces. On the tested host,
Google Chrome already provides `/opt/google/chrome/chrome-sandbox`, owned by
root with mode `4755`. In that specific setup, use the existing helper:

```bash
# Run once in the extracted Companion directory.
mv chrome-sandbox chrome-sandbox.unconfigured
CHROME_DEVEL_SANDBOX=/opt/google/chrome/chrome-sandbox \
  ./eqltools-companion --ozone-platform=x11
```

For a source run, rename `node_modules/electron/dist/chrome-sandbox` instead
and use the same environment variable with
`node_modules/.bin/electron . --ozone-platform=x11`. This preserves Chromium's
sandbox and leaves AppArmor unchanged. Check that the system helper has the
stated ownership and mode before using it; this workaround requires an
existing Chrome installation. Do not use `--no-sandbox` for an app that
fetches network data. [Chromium's Ubuntu sandbox guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)
explains the restriction and supported setup choices.

Linux validation so far: the app reads a live Legends log, imports an
inventory export, and displays its overlay on the tested Ubuntu host. Live
kill/loot/experience parsing and Windows/macOS behavior with the upgraded
Electron runtime still need validation.

Works from this repo as published: `vendor/` (the site's canonical
parsing/credit modules, copied verbatim from eqltools `public/kills/`) and
`data-snapshot/` (the wiki-derived datasets) are baked in at export time.
Development happens in the private eqltools repo, where `npm run sync`
regenerates both from the canonical sources — this repo is an export, and
pull requests against `vendor/` or `data-snapshot/` can't be taken directly.
Dev loop: `npm run dev`, and `npm run simulate` in a second terminal writes
a fake growing log (point the app's log folder at `tmp-logs/`).
