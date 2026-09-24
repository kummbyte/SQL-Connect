import { app, BrowserWindow, dialog, ipcMain, utilityProcess, safeStorage } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { WorkerClient } from './db/worker-client'
import type { Connection, PendingChange } from '../shared/types'

let win: BrowserWindow
const workers = new Map<string, WorkerClient>()
const sessionPasswords = new Map<string, string>()
const rawSettings = new Map<string, any>()

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
  const effective = connection.type === 'mysql' ? { ...connection, password: connection.password || sessionPasswords.get(connection.id) } : connection
  const client = spawnWorker(connection)
  try {
    await client.request('connect', effective, 15000)
    if (effective.type === 'mysql' && effective.password) sessionPasswords.set(effective.id, effective.password)
  }
  catch (error) { client.close(); throw error }
}
function safeConnection(value: any): Connection {
  if (!value?.type || value.type === 'sqlite') return { ...value, type: 'sqlite' }
  const copy = { ...value }; delete copy.password; delete copy.passwordEncrypted; return copy
}
function loadSettings(): Connection[] {
  try {
    const file = settingsPath(); if (!existsSync(file)) return []
    const values = JSON.parse(readFileSync(file, 'utf8'))
    return values.map((value: any) => {
      rawSettings.set(value.id, value)
      if (value.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
        try { sessionPasswords.set(value.id, safeStorage.decryptString(Buffer.from(value.passwordEncrypted, 'base64'))) } catch { /* prompt again */ }
      }
      return safeConnection(value)
    })
  } catch { return [] }
}
function saveSettings(connections: Connection[]) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  const output = connections.map((connection: any) => {
    const previous = rawSettings.get(connection.id) || {}
    const next: any = { ...connection }
    const password = connection.password || sessionPasswords.get(connection.id)
    delete next.password; delete next.passwordEncrypted
    if (connection.type === 'mysql' && connection.rememberPassword && !safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用钥匙串加密，不能保存 MySQL 密码')
    if (connection.type === 'mysql' && connection.rememberPassword && password && safeStorage.isEncryptionAvailable()) {
      next.passwordEncrypted = safeStorage.encryptString(password).toString('base64')
      sessionPasswords.set(connection.id, password)
    } else if (previous.passwordEncrypted && connection.type === 'mysql' && connection.rememberPassword && !password) next.passwordEncrypted = previous.passwordEncrypted
    rawSettings.set(connection.id, next)
    return next
  })
  writeFileSync(settingsPath(), JSON.stringify(output, null, 2))
  return true
}
function registerIpc() {
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_event, connections: Connection[]) => saveSettings(connections))
  ipcMain.handle('dialog:openFile', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'All files', extensions: ['*'] }] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('dialog:openCertificate', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Certificate', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('dialog:saveFile', async () => { const result = await dialog.showSaveDialog(win, { defaultPath: 'database.sqlite', filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }] }); return result.canceled ? null : result.filePath })
  ipcMain.handle('db:connect', (_event, connection: Connection) => connect(connection).then(() => ({ ok: true })))
  ipcMain.handle('db:disconnect', (_event, id: string) => { workers.get(id)?.close(); sessionPasswords.delete(id); return true })
  ipcMain.handle('db:databases', (_event, id: string) => sendWorker(id, 'databases', { connectionId: id }))
  ipcMain.handle('db:schema', (_event, id: string, database?: string) => sendWorker(id, 'schema', { connectionId: id, database }))
  ipcMain.handle('db:structure', (_event, id: string, table: string, database?: string) => sendWorker(id, 'structure', { connectionId: id, table, database }))
  ipcMain.handle('db:query', (_event, id: string, table: string, options: any) => sendWorker(id, 'query', { connectionId: id, table, ...options }))
  ipcMain.handle('db:execute', (_event, id: string, sql: string, sessionId?: string, database?: string) => sendWorker(id, 'execute', { connectionId: id, sql, sessionId, database }))
  ipcMain.handle('db:closeSession', (_event, id: string, sessionId: string) => sendWorker(id, 'closeSession', { connectionId: id, sessionId }))
  ipcMain.handle('db:apply', (_event, id: string, changes: PendingChange[]) => sendWorker(id, 'apply', { connectionId: id, changes }))
  ipcMain.handle('db:cancel', (_event, id: string) => { workers.get(id)?.close('操作已取消，连接已断开'); return true })
}
function createWindow() { win = new BrowserWindow({ width: 1440, height: 920, minWidth: 1050, minHeight: 700, title: 'SQL Connect', backgroundColor: '#101522', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } }); if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL); else win.loadFile(join(__dirname, '../renderer/index.html')) }
app.whenReady().then(() => { registerIpc(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() }) })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { for (const worker of workers.values()) worker.close('应用正在退出') })
