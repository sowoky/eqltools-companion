/* Context bridge — the only door between renderers and main. Both windows
   share this preload; each uses the slice it needs. */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  /* main window */
  init: () => ipcRenderer.invoke("app:init"),
  ready: () => ipcRenderer.send("renderer:ready"),
  getUpdate: () => ipcRenderer.invoke("update:get"),
  installUpdate: () => ipcRenderer.send("update:install"),
  openReleases: () => ipcRenderer.send("update:openPage"),
  onUpdate: (fn) => ipcRenderer.on("update:state", (_e, p) => fn(p)),
  refreshData: () => ipcRenderer.invoke("data:refresh"),
  getZoneFile: (key) => ipcRenderer.invoke("data:zoneFile", key),
  pickLogDir: () => ipcRenderer.invoke("log:pickDir"),
  openWiki: (url) => ipcRenderer.send("wiki:open", url),
  toggleOverlay: (force) => ipcRenderer.send("overlay:toggle", force),
  setClickThrough: (on) => ipcRenderer.send("overlay:clickThrough", on),
  setOverlayOpacity: (v) => ipcRenderer.send("overlay:opacity", v),
  sendFeedEvent: (ev) => ipcRenderer.send("feed:event", ev),
  sendZone: (z) => ipcRenderer.send("feed:zone", z),
  onBootstrap: (fn) => ipcRenderer.on("log:bootstrap", (_e, p) => fn(p)),
  onLines: (fn) => ipcRenderer.on("log:lines", (_e, p) => fn(p)),
  onLogStatus: (fn) => ipcRenderer.on("log:status", (_e, p) => fn(p)),
  onDataUpdated: (fn) => ipcRenderer.on("data:updated", (_e, p) => fn(p)),
  onOverlayState: (fn) => ipcRenderer.on("overlay:state", (_e, p) => fn(p)),

  /* overlay window */
  onOverlayInit: (fn) => ipcRenderer.on("overlay:init", (_e, p) => fn(p)),
  onOverlayMode: (fn) => ipcRenderer.on("overlay:mode", (_e, p) => fn(p)),
  onFeedEvent: (fn) => ipcRenderer.on("feed:event", (_e, p) => fn(p)),
  onFeedZone: (fn) => ipcRenderer.on("feed:zone", (_e, p) => fn(p)),
});
