import { app, BrowserWindow, dialog, ipcMain, utilityProcess, safeStorage } from 'electron'
import { join, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { WorkerClient } from './db/worker-client'
import type { ConnectResult, Connection, MySQLConnection, PendingChange } from '../shared/types'

let win: BrowserWindow
const workers = new Map<string, WorkerClient>()
const sessionPasswords = new Map<string, string>()
const rawSettings = new Map<string, any>()
const pendingConnects = new Map<string, Promise<ConnectResult>>()
let savedConnections: Connection[] = []
let settingsLoaded = false

function settingsPath() { return join(app.getPath('userData'), 'connections.json') }
function normalizeSQLitePath(path: string) {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch { return absolute }
}
function normalizeConnection(value: any): Connection {
  if (value?.type === 'mysql') {
    const connection: MySQLConnection = { ...value, type: 'mysql', name: String(value.name || 'MySQL 连接').trim(), host: String(value.host || '').trim(), port: Number(value.port) || 3306, user: String(value.user || ''), tls: value.tls !== false, caPath: value.caPath ? resolve(String(value.caPath)) : undefined }
    return connection
  }
  return { ...value, type: 'sqlite', path: normalizeSQLitePath(String(value?.path || '')), readonly: !!value?.readonly }
}
function connectionIdentity(value: any) {
  const connection = normalizeConnection(value)
  if (connection.type === 'mysql') return `mysql:${JSON.stringify([connection.host.toLocaleLowerCase(), connection.port, connection.user, connection.tls !== false, connection.caPath || ''])}`
  return `sqlite:${connection.path}`
}
function safeConnection(value: any): Connection {
  const copy: any = normalizeConnection(value)
  delete copy.password
  delete copy.passwordEncrypted
  delete copy.create
  return copy
}
function readEncryptedPassword(value: any, targetId = value.id) {
  if (!value?.passwordEncrypted || !safeStorage.isEncryptionAvailable()) return
  try { sessionPasswords.set(targetId, safeStorage.decryptString(Buffer.from(value.passwordEncrypted, 'base64'))) } catch { /* prompt again */ }
}
function mergeConnectionList(values: any[]) {
  const entries: Array<{ connection: Connection; raw: any }> = []
  const byIdentity = new Map<string, number>()
  for (const value of values) {
    const connection = normalizeConnection(value)
    const raw = { ...(rawSettings.get(connection.id) || {}), ...value, ...connection }
    readEncryptedPassword(value, connection.id)
    const key = connectionIdentity(connection)
    const existingIndex = byIdentity.get(key)
    if (existingIndex === undefined) {
      entries.push({ connection, raw })
      byIdentity.set(key, entries.length - 1)
      continue
    }
    const existing = entries[existingIndex]
    if (existing.connection.type === 'sqlite' && connection.type === 'sqlite') existing.connection = { ...existing.connection, readonly: existing.connection.readonly || connection.readonly }
    if (!existing.raw.passwordEncrypted && raw.passwordEncrypted) existing.raw.passwordEncrypted = raw.passwordEncrypted
    if (sessionPasswords.has(connection.id) && !sessionPasswords.has(existing.connection.id)) sessionPasswords.set(existing.connection.id, sessionPasswords.get(connection.id)!)
  }
  const connections = entries.map(entry => safeConnection(entry.connection))
  const raws = entries.map(entry => ({ ...entry.raw, ...entry.connection, ...(entry.connection.type === 'sqlite' ? { readonly: entry.connection.readonly } : {}) }))
  return { connections, raws }
}
function writeSettingsFile(output: any[], backup = false) {
  const file = settingsPath()
  mkdirSync(app.getPath('userData'), { recursive: true })
  if (backup && existsSync(file)) copyFileSync(file, `${file}.backup-${Date.now()}`)
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  try { writeFileSync(temp, JSON.stringify(output, null, 2)); renameSync(temp, file) } catch (error) { try { unlinkSync(temp) } catch { /* preserve original config */ } throw error }
}
function ensureSettingsLoaded() { if (!settingsLoaded) loadSettings() }
function saveSettingsInternal(connections: Connection[], backup = false) {
  const merged = mergeConnectionList(connections)
  const output = merged.connections.map((connection: any) => {
    const previous = rawSettings.get(connection.id) || {}
    const next: any = { ...connection }
    const password = connection.type === 'mysql' ? (connection as MySQLConnection).password || sessionPasswords.get(connection.id) : undefined
    delete next.password; delete next.passwordEncrypted
    if (connection.type === 'mysql' && connection.rememberPassword && !safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法使用钥匙串加密，不能保存 MySQL 密码')
    if (connection.type === 'mysql' && connection.rememberPassword && password && safeStorage.isEncryptionAvailable()) {
      next.passwordEncrypted = safeStorage.encryptString(password).toString('base64')
      sessionPasswords.set(connection.id, password)
    } else if (previous.passwordEncrypted && connection.type === 'mysql' && connection.rememberPassword && !password) next.passwordEncrypted = previous.passwordEncrypted
    rawSettings.set(connection.id, next)
    return next
  })
  writeSettingsFile(output, backup)
  savedConnections = merged.connections
  return savedConnections
}
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
  ensureSettingsLoaded()
  const normalized = normalizeConnection(connection)
  const existing = savedConnections.find(item => connectionIdentity(item) === connectionIdentity(normalized))
  const canonical = existing ? (existing.type === 'sqlite' ? existing : { ...existing, password: normalized.type === 'mysql' ? normalized.password : undefined }) : normalized
  const key = connectionIdentity(canonical)
  if (workers.has(canonical.id)) return { ok: true, connection: safeConnection(canonical), reused: true }
  const running = pendingConnects.get(key)
  if (running) return { ...(await running), reused: true }
  const request = (async (): Promise<ConnectResult> => {
    const effective = canonical.type === 'mysql' ? { ...canonical, password: (normalized.type === 'mysql' && normalized.password) || sessionPasswords.get(canonical.id) } : canonical
    const client = spawnWorker(canonical)
    try {
      await client.request('connect', effective, 15000)
      if (effective.type === 'mysql' && effective.password) sessionPasswords.set(effective.id, effective.password)
      const persisted = saveSettingsInternal([...savedConnections.filter(item => item.id !== canonical.id), canonical])
      return { ok: true, connection: persisted.find(item => item.id === canonical.id) || safeConnection(canonical), reused: false }
    } catch (error) { client.close(); throw error }
  })()
  pendingConnects.set(key, request)
  try { return await request } finally { pendingConnects.delete(key) }
}
function loadSettings(): Connection[] {
  const file = settingsPath()
  if (!existsSync(file)) { settingsLoaded = true; savedConnections = []; return savedConnections }
  let values: any[]
  try { values = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { throw new Error(`无法读取连接配置：${error instanceof Error ? error.message : String(error)}`) }
  if (!Array.isArray(values)) throw new Error('无法读取连接配置：格式无效')
  rawSettings.clear()
  const merged = mergeConnectionList(values)
  for (const raw of merged.raws) rawSettings.set(raw.id, raw)
  savedConnections = merged.connections
  settingsLoaded = true
  if (merged.connections.length !== values.length) writeSettingsFile(merged.raws, true)
  return savedConnections
}
function registerIpc() {
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_event, connections: Connection[]) => { ensureSettingsLoaded(); return saveSettingsInternal(connections) })
  ipcMain.handle('dialog:openFile', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'All files', extensions: ['*'] }] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('dialog:openCertificate', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Certificate', extensions: ['pem', 'crt', 'cer'] }, { name: 'All files', extensions: ['*'] }] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('dialog:saveFile', async () => { const result = await dialog.showSaveDialog(win, { defaultPath: 'database.sqlite', filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }] }); return result.canceled ? null : result.filePath })
  ipcMain.handle('db:connect', (_event, connection: Connection) => connect(connection))
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
