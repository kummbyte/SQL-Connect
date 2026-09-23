import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { WorkerClient } from './db/worker-client'
import type { Connection, PendingChange } from '../shared/types'

let win: BrowserWindow
const workers = new Map<string, WorkerClient>()

function settingsPath() { return join(app.getPath('userData'), 'connections.json') }
function sendWorker(connectionId: string, type: string, payload: any) {
  const worker = workers.get(connectionId)
  if (!worker) return Promise.reject(new Error('连接已断开'))
  // Long SQL queries keep their existing execution semantics; bound connection/schema loading only.
  return worker.request(type, payload, ['schema', 'structure'].includes(type) ? 30000 : 0)
}
function spawnWorker(connection: Connection) {
  workers.get(connection.id)?.close('连接已重新建立')
  const worker = utilityProcess.fork(join(app.getAppPath(), 'src/main/db/worker.cjs'))
  const client = new WorkerClient(worker, () => {
    if (workers.get(connection.id) === client) workers.delete(connection.id)
  })
  workers.set(connection.id, client)
  return client
}
async function connect(connection: Connection) {
  const client = spawnWorker(connection)
  try { await client.request('connect', connection, 15000) }
  catch (error) { client.close(); throw error }
}
function registerIpc() {
  ipcMain.handle('settings:load', () => { try { const file = settingsPath(); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [] } catch { return [] } })
  ipcMain.handle('settings:save', (_event, connections: Connection[]) => { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(connections, null, 2)); return true })
  ipcMain.handle('dialog:openFile', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'All files', extensions: ['*'] }] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('dialog:saveFile', async () => { const result = await dialog.showSaveDialog(win, { defaultPath: 'database.sqlite', filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }] }); return result.canceled ? null : result.filePath })
  ipcMain.handle('db:connect', (_event, connection: Connection) => connect(connection).then(() => ({ ok: true })))
  ipcMain.handle('db:disconnect', (_event, id: string) => { workers.get(id)?.close(); return true })
  ipcMain.handle('db:schema', (_event, id: string) => sendWorker(id, 'schema', { connectionId: id }))
  ipcMain.handle('db:structure', (_event, id: string, table: string) => sendWorker(id, 'structure', { connectionId: id, table }))
  ipcMain.handle('db:query', (_event, id: string, table: string, options: any) => sendWorker(id, 'query', { connectionId: id, table, ...options }))
  ipcMain.handle('db:execute', (_event, id: string, sql: string) => sendWorker(id, 'execute', { connectionId: id, sql }))
  ipcMain.handle('db:apply', (_event, id: string, changes: PendingChange[]) => sendWorker(id, 'apply', { connectionId: id, changes }))
  ipcMain.handle('db:cancel', (_event, id: string) => { workers.get(id)?.close('操作已取消，连接已断开'); return true })
}
function createWindow() { win = new BrowserWindow({ width: 1440, height: 920, minWidth: 1050, minHeight: 700, title: 'SQL Connect', backgroundColor: '#101522', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL); else win.loadFile(join(__dirname, '../renderer/index.html')) }
app.whenReady().then(() => { registerIpc(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { for (const worker of workers.values()) worker.close('应用正在退出') })
