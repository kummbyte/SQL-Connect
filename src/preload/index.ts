import { contextBridge, ipcRenderer } from 'electron'
import type { SqlConnectApi } from '../shared/types'

const api: SqlConnectApi = {
  settings: { load: () => ipcRenderer.invoke('settings:load'), save: (connections) => ipcRenderer.invoke('settings:save', connections) },
  dialog: { openFile: () => ipcRenderer.invoke('dialog:openFile'), openCertificate: () => ipcRenderer.invoke('dialog:openCertificate'), saveFile: () => ipcRenderer.invoke('dialog:saveFile') },
  db: {
    connect: (connection) => ipcRenderer.invoke('db:connect', connection), disconnect: (id) => ipcRenderer.invoke('db:disconnect', id), databases: (id) => ipcRenderer.invoke('db:databases', id), schema: (id, database) => ipcRenderer.invoke('db:schema', id, database), structure: (id, table, database) => ipcRenderer.invoke('db:structure', id, table, database), query: (id, table, options) => ipcRenderer.invoke('db:query', id, table, options), execute: (id, sql, sessionId, database) => ipcRenderer.invoke('db:execute', id, sql, sessionId, database), closeSession: (id, sessionId) => ipcRenderer.invoke('db:closeSession', id, sessionId), apply: (id, changes) => ipcRenderer.invoke('db:apply', id, changes), cancel: (id) => ipcRenderer.invoke('db:cancel', id)
  }
}
contextBridge.exposeInMainWorld('sqlConnect', api)
