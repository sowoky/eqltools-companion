/* Context bridge — the only door between renderers and main. Both windows
   share this preload; each uses the slice it needs. */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  /* main window */
  init: () => ipcRenderer.invoke("app:init"),
  ready: () => ipcRenderer.send("renderer:ready"),
  getUpdate: () => ipcRenderer.invoke("update:get"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.send("update:install"),
  openReleases: () => ipcRenderer.send("update:openPage"),
  onUpdate: (fn) => ipcRenderer.on("update:state", (_e, p) => fn(p)),
  refreshData: () => ipcRenderer.invoke("data:refresh"),
  getZoneFile: (key) => ipcRenderer.invoke("data:zoneFile", key),
  getLogTail: () => ipcRenderer.invoke("log:tail"),
  pickLogDir: () => ipcRenderer.invoke("log:pickDir"),
  pickAchFile: () => ipcRenderer.invoke("ach:pick"),
  getEqConfig: () => ipcRenderer.invoke("eqconfig:get"),
  enableGameLog: () => ipcRenderer.invoke("eqconfig:enableLog"),
  openWiki: (url) => ipcRenderer.send("wiki:open", url),
  toggleOverlay: (force) => ipcRenderer.send("overlay:toggle", force),
  setClickThrough: (on) => ipcRenderer.send("overlay:clickThrough", on),
  overlayHotspot: (on) => ipcRenderer.send("overlay:hotspot", on),
  setOverlayPrefs: (p) => ipcRenderer.send("overlay:prefs", p),
  overlayMenu: () => ipcRenderer.send("overlay:menu"),
  /* Move/resize gestures: main reads the cursor, so these carry no
     coordinates — see the drag block in main.js. */
  overlayDragStart: (kind, sx, sy) => ipcRenderer.send("overlay:dragStart", kind, sx, sy),
  overlayDragMove: (sx, sy) => ipcRenderer.send("overlay:dragMove", sx, sy),
  overlayDragEnd: () => ipcRenderer.send("overlay:dragEnd"),
  resetOverlayPlacement: () => ipcRenderer.send("overlay:resetPlacement"),
  setOverlayOpacity: (v) => ipcRenderer.send("overlay:opacity", v),
  sendFeedEvent: (ev) => ipcRenderer.send("feed:event", ev),
  sendZone: (z) => ipcRenderer.send("feed:zone", z),
  sendQuests: (q) => ipcRenderer.send("feed:quests", q),
  sendStats: (s) => ipcRenderer.send("feed:stats", s),
  sendSky: (s) => ipcRenderer.send("feed:sky", s),
  sendValet: (v) => ipcRenderer.send("feed:valet", v),
  sendSpare: (v) => ipcRenderer.send("feed:spare", v),
  sendExalt: (v) => ipcRenderer.send("feed:exalt", v),
  markHeld: (n) => ipcRenderer.send("quest:markHeld", n),
  onMarkHeld: (fn) => ipcRenderer.on("quest:markHeld", (_e, p) => fn(p)),
  /* The Parser meter's reset stamp. Same shape as markHeld: the overlay asks,
     main forwards, the main renderer (which holds the engine and the only log
     clock) decides what instant that is. Not an overlay pref — a timestamp
     from a previous run names a moment no window still holds. */
  statsReset: (on) => ipcRenderer.send("stats:reset", !!on),
  onStatsReset: (fn) => ipcRenderer.on("stats:reset", (_e, p) => fn(p)),
  /* How the widget's Sky board is grouped. Same shape again: the payload for a
     boss board is BUILT in the main renderer (the overlay holds no datasets),
     so asking for it has to reach the window that can make it. It writes
     through to the same widget option the Sky tab shows — one setting, two
     places to change it. */
  skyView: (v) => ipcRenderer.send("sky:view", v),
  onSkyView: (fn) => ipcRenderer.on("sky:view", (_e, p) => fn(p)),
  onBootstrap: (fn) => ipcRenderer.on("log:bootstrap", (_e, p) => fn(p)),
  onLines: (fn) => ipcRenderer.on("log:lines", (_e, p) => fn(p)),
  onLogStatus: (fn) => ipcRenderer.on("log:status", (_e, p) => fn(p)),
  onInvFile: (fn) => ipcRenderer.on("inv:file", (_e, p) => fn(p)),
  onInvStatus: (fn) => ipcRenderer.on("inv:status", (_e, p) => fn(p)),
  onAchFile: (fn) => ipcRenderer.on("ach:file", (_e, p) => fn(p)),
  onAchStatus: (fn) => ipcRenderer.on("ach:status", (_e, p) => fn(p)),
  onDataUpdated: (fn) => ipcRenderer.on("data:updated", (_e, p) => fn(p)),
  onOverlayState: (fn) => ipcRenderer.on("overlay:state", (_e, p) => fn(p)),

  /* overlay window */
  onOverlayInit: (fn) => ipcRenderer.on("overlay:init", (_e, p) => fn(p)),
  onOverlayMode: (fn) => ipcRenderer.on("overlay:mode", (_e, p) => fn(p)),
  onFeedEvent: (fn) => ipcRenderer.on("feed:event", (_e, p) => fn(p)),
  onFeedZone: (fn) => ipcRenderer.on("feed:zone", (_e, p) => fn(p)),
  onFeedQuests: (fn) => ipcRenderer.on("feed:quests", (_e, p) => fn(p)),
  onFeedStats: (fn) => ipcRenderer.on("feed:stats", (_e, p) => fn(p)),
  onFeedSky: (fn) => ipcRenderer.on("feed:sky", (_e, p) => fn(p)),
  onFeedValet: (fn) => ipcRenderer.on("feed:valet", (_e, p) => fn(p)),
  onFeedSpare: (fn) => ipcRenderer.on("feed:spare", (_e, p) => fn(p)),
  onFeedExalt: (fn) => ipcRenderer.on("feed:exalt", (_e, p) => fn(p)),
});
