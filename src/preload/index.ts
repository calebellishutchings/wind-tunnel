import { contextBridge, ipcRenderer } from 'electron'
import type { Snapshot, TunnelApi, Result } from '../shared/model'
const api: TunnelApi = {
  pitotAct: (action) => ipcRenderer.invoke('tunnel:pitot-act', action),
  async snapshot() {
    const result = (await ipcRenderer.invoke('tunnel:get')) as Result<Snapshot>
    if (!result.ok) throw new Error(result.error)
    return result.value
  },
  subscribe(callback) {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Snapshot): void =>
      callback(snapshot)
    ipcRenderer.on('tunnel:snapshot', listener)
    return () => {
      ipcRenderer.removeListener('tunnel:snapshot', listener)
    }
  },
  act: (action) => ipcRenderer.invoke('tunnel:act', action),
  listPorts: () => ipcRenderer.invoke('tunnel:ports'),
  startRecording: () => ipcRenderer.invoke('tunnel:record-start'),
  stopRecording: () => ipcRenderer.invoke('tunnel:record-stop'),
  exportCsv: () => ipcRenderer.invoke('tunnel:export'),
}
contextBridge.exposeInMainWorld('tunnel', api)
