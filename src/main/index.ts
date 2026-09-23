import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Connection, PendingChange } from '../shared/types'

let win: BrowserWindow
const workers = new Map<string, Electron.UtilityProcess>()
const requests = new Map<string, (value: any) => void>()
const rejects = new Map<string, (error: Error) => void>()

function settingsPath() { return join(app.getPath('userData'), 'connections.json') }
function sendWorker(connectionId: string, type: string, payload: any) {
  const worker = workers.get(connectionId)
  if (!worker) return Promise.reject(new Error('连接已断开'))
  const id = randomUUID()
  return new Promise((resolve, reject) => { requests.set(id, resolve); rejects.set(id, reject); worker.postMessage({ id, type, payload }) })
}
function spawnWorker(connection: Connection) {
  const worker = utilityProcess.fork(join(app.getAppPath(), 'src/main/db/worker.cjs'))
  workers.set(connection.id, worker)
  ;(worker as any).on('message', (message: any) => { const resolve = requests.get(message.id); const reject = rejects.get(message.id); if (!resolve || !reject) return; requests.delete(message.id); rejects.delete(message.id); message.ok ? resolve(message.result) : reject(new Error(message.error)) })
  worker.on('exit', () => workers.delete(connection.id))
  return worker
}
async function connect(connection: Connection) { spawnWorker(connection); try { await sendWorker(connection.id, 'connect', connection) } catch (error) { workers.get(connection.id)?.kill(); workers.delete(connection.id); throw error } }
function registerIpc() {
  ipcMain.handle('settings:load', () => { try { const file = settingsPath(); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [] } catch { return [] } })
  ipcMain.handle('settings:save', (_event, connections: Connection[]) => { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(connections, null, 2)); return true })
  ipcMain.handle('dialog:openFile', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'All files', extensions: ['*'] }] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('dialog:saveFile', async () => { const result = await dialog.showSaveDialog(win, { defaultPath: 'database.sqlite', filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }] }); return result.canceled ? null : result.filePath })
  ipcMain.handle('db:connect', (_event, connection: Connection) => connect(connection).then(() => ({ ok: true })))
  ipcMain.handle('db:disconnect', (_event, id: string) => { const worker = workers.get(id); worker?.kill(); workers.delete(id); return true })
  ipcMain.handle('db:schema', (_event, id: string) => sendWorker(id, 'schema', { connectionId: id }))
  ipcMain.handle('db:structure', (_event, id: string, table: string) => sendWorker(id, 'structure', { connectionId: id, table }))
  ipcMain.handle('db:query', (_event, id: string, table: string, options: any) => sendWorker(id, 'query', { connectionId: id, table, ...options }))
  ipcMain.handle('db:execute', (_event, id: string, sql: string) => sendWorker(id, 'execute', { connectionId: id, sql }))
  ipcMain.handle('db:apply', (_event, id: string, changes: PendingChange[]) => sendWorker(id, 'apply', { connectionId: id, changes }))
  ipcMain.handle('db:cancel', (_event, id: string) => { workers.get(id)?.kill(); workers.delete(id); return true })
}
function createWindow() { win = new BrowserWindow({ width: 1440, height: 920, minWidth: 1050, minHeight: 700, title: 'SQL Connect', backgroundColor: '#101522', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL); else win.loadFile(join(__dirname, '../renderer/index.html')) }
app.whenReady().then(() => { registerIpc(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
