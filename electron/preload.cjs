const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stupidRedact", {
  redact: (text) => ipcRenderer.invoke("redact:text", text),
});
