const { contextBridge, ipcRenderer } = require("electron");

// The only thing the page can do is ask for a snapshot.
contextBridge.exposeInMainWorld("agentlink", {
  state: () => ipcRenderer.invoke("agentlink:state"),
});
