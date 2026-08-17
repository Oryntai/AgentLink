const { contextBridge, ipcRenderer } = require("electron");

// The only things the page can do: ask for a snapshot, or ask the main process
// to run one of a fixed set of named actions.
contextBridge.exposeInMainWorld("agentlink", {
  state: () => ipcRenderer.invoke("agentlink:state"),
  transcript: (options) => ipcRenderer.invoke("agentlink:transcript", options),
  act: (name, payload) => ipcRenderer.invoke("agentlink:action", name, payload),
});
