import { contextBridge, ipcRenderer } from 'electron'
import type { SqlConnectApi } from '../shared/types'

const api: SqlConnectApi = {
  settings: { load: () => ipcRenderer.invoke('settings:load'), save: (connections) => ipcRenderer.invoke('settings:save', connections) },
  dialog: { openFile: () => ipcRenderer.invoke('dialog:openFile'), saveFile: () => ipcRenderer.invoke('dialog:saveFile') },
  db: {
    connect: (connection) => ipcRenderer.invoke('db:connect', connection), disconnect: (id) => ipcRenderer.invoke('db:disconnect', id), schema: (id) => ipcRenderer.invoke('db:schema', id), structure: (id, table) => ipcRenderer.invoke('db:structure', id, table), query: (id, table, options) => ipcRenderer.invoke('db:query', id, table, options), execute: (id, sql) => ipcRenderer.invoke('db:execute', id, sql), apply: (id, changes) => ipcRenderer.invoke('db:apply', id, changes), cancel: (id) => ipcRenderer.invoke('db:cancel', id)
  }
}
contextBridge.exposeInMainWorld('sqlConnect', api)
