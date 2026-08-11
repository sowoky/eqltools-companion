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
  openWiki: (url) => ipcRenderer.send("wiki:open", url),
  toggleOverlay: (force) => ipcRenderer.send("overlay:toggle", force),
  setClickThrough: (on) => ipcRenderer.send("overlay:clickThrough", on),
  overlayHotspot: (on) => ipcRenderer.send("overlay:hotspot", on),
  setOverlayPrefs: (p) => ipcRenderer.send("overlay:prefs", p),
  resizeOverlay: (w, h) => ipcRenderer.send("overlay:resize", w, h),
  setOverlayOpacity: (v) => ipcRenderer.send("overlay:opacity", v),
  sendFeedEvent: (ev) => ipcRenderer.send("feed:event", ev),
  sendZone: (z) => ipcRenderer.send("feed:zone", z),
  sendQuests: (q) => ipcRenderer.send("feed:quests", q),
  sendStats: (s) => ipcRenderer.send("feed:stats", s),
  markHeld: (n) => ipcRenderer.send("quest:markHeld", n),
  onMarkHeld: (fn) => ipcRenderer.on("quest:markHeld", (_e, p) => fn(p)),
  onBootstrap: (fn) => ipcRenderer.on("log:bootstrap", (_e, p) => fn(p)),
  onLines: (fn) => ipcRenderer.on("log:lines", (_e, p) => fn(p)),
  onLogStatus: (fn) => ipcRenderer.on("log:status", (_e, p) => fn(p)),
  onInvFile: (fn) => ipcRenderer.on("inv:file", (_e, p) => fn(p)),
  onInvStatus: (fn) => ipcRenderer.on("inv:status", (_e, p) => fn(p)),
  onDataUpdated: (fn) => ipcRenderer.on("data:updated", (_e, p) => fn(p)),
  onOverlayState: (fn) => ipcRenderer.on("overlay:state", (_e, p) => fn(p)),

  /* overlay window */
  onOverlayInit: (fn) => ipcRenderer.on("overlay:init", (_e, p) => fn(p)),
  onOverlayMode: (fn) => ipcRenderer.on("overlay:mode", (_e, p) => fn(p)),
  onFeedEvent: (fn) => ipcRenderer.on("feed:event", (_e, p) => fn(p)),
  onFeedZone: (fn) => ipcRenderer.on("feed:zone", (_e, p) => fn(p)),
  onFeedQuests: (fn) => ipcRenderer.on("feed:quests", (_e, p) => fn(p)),
  onFeedStats: (fn) => ipcRenderer.on("feed:stats", (_e, p) => fn(p)),
});
