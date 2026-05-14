const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stupidRedact", {
  warmup: () => ipcRenderer.invoke("redact:warmup"),
  redact: (text) => ipcRenderer.invoke("redact:text", text),
  onProgress: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("redact:progress", listener);
    return () => ipcRenderer.removeListener("redact:progress", listener);
  },
});
