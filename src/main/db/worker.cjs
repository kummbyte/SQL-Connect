const Database = require('better-sqlite3')
const fs = require('node:fs')

const databases = new Map()
const quote = (name) => `"${String(name).replaceAll('"', '""')}"`
const send = (message) => process.parentPort ? process.parentPort.postMessage(message) : process.send(message)
// Electron delivers MessageEvent objects; Node child_process delivers the payload directly.
const onMessage = (fn) => process.parentPort ? process.parentPort.on('message', event => fn(event.data)) : process.on('message', fn)

function dbFor(id) {
  const db = databases.get(id)
  if (!db) throw new Error('连接已断开')
  return db
}
function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `[BLOB ${value.length} bytes]`
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
  return value
}
function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE (type='table' OR type='view') AND name=?").get(table)
}
function splitStatements(sql) {
  let quoteChar = null; let count = 0; let hasText = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quoteChar) { if (c === quoteChar && sql[i + 1] === quoteChar) { i++; continue } if (c === quoteChar) quoteChar = null; continue }
    if (c === "'" || c === '"' || c === '`') { quoteChar = c; hasText = true; continue }
    if (c === ';') { if (hasText) count++; hasText = false; continue }
    if (!/\s/.test(c)) hasText = true
  }
  if (hasText) count++
  return count
}
function execute(db, sql) {
  const trimmed = sql.trim()
  if (!trimmed) throw new Error('请输入 SQL')
  if (splitStatements(trimmed) > 1) throw new Error('首版每次只执行一条 SQL，请拆分语句后重试')
  const start = performance.now()
  const statement = db.prepare(trimmed)
  const isReader = statement.reader
  if (isReader) {
    const rows = statement.all().slice(0, 1000).map(jsonSafe)
    const columns = rows.length ? Object.keys(rows[0]) : (statement.columns?.().map(c => c.name) || [])
    return { columns, rows, truncated: rows.length === 1000, elapsedMs: Math.round(performance.now() - start) }
  }
  const result = statement.run()
  return { columns: [], rows: [], changes: result.changes, lastInsertRowid: jsonSafe(result.lastInsertRowid), elapsedMs: Math.round(performance.now() - start) }
}
async function handle({ id, type, payload }) {
  if (type === 'connect') {
    if (!fs.existsSync(payload.path) && !payload.create) throw new Error('数据库文件不存在，请先创建或选择已有文件')
    const db = new Database(payload.path, { readonly: !!payload.readonly, fileMustExist: !payload.create, timeout: 5000 })
    db.pragma('foreign_keys = ON')
    databases.set(payload.id, db)
    return { ok: true }
  }
  if (type === 'disconnect') { const db = databases.get(payload.id); if (db) db.close(); databases.delete(payload.id); return true }
  const db = dbFor(payload.connectionId)
  if (type === 'schema') {
    return db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(jsonSafe)
  }
  if (type === 'structure') {
    if (!tableExists(db, payload.table)) throw new Error('对象不存在')
    const columns = db.prepare(`PRAGMA table_info(${quote(payload.table)})`).all().map(jsonSafe)
    const indexes = db.prepare(`PRAGMA index_list(${quote(payload.table)})`).all().map(jsonSafe)
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quote(payload.table)})`).all().map(jsonSafe)
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(payload.table)?.sql || null
    const identity = columns.find(c => c.pk)?.name || (columns.length ? '__sqlconnect_rowid' : null)
    return { columns, indexes, foreignKeys, sql, editable: payload.type !== 'view' && !!identity, identity }
  }
  if (type === 'query') {
    if (!tableExists(db, payload.table)) throw new Error('对象不存在')
    const structure = db.prepare(`PRAGMA table_info(${quote(payload.table)})`).all()
    const isView = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(payload.table)?.type === 'view'
    const order = payload.orderBy && structure.some(c => c.name === payload.orderBy) ? ` ORDER BY ${quote(payload.orderBy)} ${payload.direction === 'desc' ? 'DESC' : 'ASC'}` : ''
    const where = payload.filter ? ` WHERE ${structure.map(c => `CAST(${quote(c.name)} AS TEXT) LIKE @filter`).join(' OR ')}` : ''
    const from = isView ? quote(payload.table) : `${quote(payload.table)}`
    const select = isView ? '*' : `rowid AS __sqlconnect_rowid, *`
    const stmt = db.prepare(`SELECT ${select} FROM ${from}${where}${order} LIMIT @limit OFFSET @offset`)
    const params = { limit: Math.min(Math.max(payload.limit || 100, 1), 1000), offset: Math.max(payload.offset || 0, 0) }
    if (payload.filter) params.filter = `%${payload.filter}%`
    const rows = stmt.all(params).map(jsonSafe)
    const total = db.prepare(`SELECT COUNT(*) AS count FROM ${from}${where}`).get(payload.filter ? { filter: `%${payload.filter}%` } : {})?.count
    return { columns: rows.length ? Object.keys(rows[0]) : structure.map(c => c.name), rows, total: Number(total || 0), elapsedMs: 0 }
  }
  if (type === 'execute') return execute(db, payload.sql)
  if (type === 'apply') {
    if (!payload.changes.length) return { columns: [], rows: [], changes: 0, elapsedMs: 0 }
    const transaction = db.transaction(() => {
      let count = 0
      for (const change of payload.changes) {
        if (change.type === 'insert') {
          const keys = Object.keys(change.values).filter(k => !k.startsWith('__'))
          const stmt = db.prepare(`INSERT INTO ${quote(change.table)} (${keys.map(quote).join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`)
          count += stmt.run(Object.fromEntries(keys.map(k => [k, change.values[k]]))).changes
        } else {
          if (change.rowid === undefined) throw new Error('该表没有可用的行标识，无法编辑')
          if (change.original) {
            const current = db.prepare(`SELECT * FROM ${quote(change.table)} WHERE rowid=@rowid`).get({ rowid: change.rowid })
            if (!current) throw new Error('记录已被删除，请刷新后重试')
            for (const [key, value] of Object.entries(change.original)) if (String(jsonSafe(current[key])) !== String(value)) throw new Error('记录已被外部修改，请刷新后重试')
          }
          if (change.type === 'delete') count += db.prepare(`DELETE FROM ${quote(change.table)} WHERE rowid=@rowid`).run({ rowid: change.rowid }).changes
          else {
            const keys = Object.keys(change.values).filter(k => k !== '__sqlconnect_rowid' && !k.startsWith('__'))
            const values = Object.fromEntries(keys.map(k => [k, change.values[k]])); values.rowid = change.rowid
            count += db.prepare(`UPDATE ${quote(change.table)} SET ${keys.map(k => `${quote(k)}=@${k}`).join(',')} WHERE rowid=@rowid`).run(values).changes
          }
        }
      }
      return count
    })()
    return { columns: [], rows: [], changes: transaction, elapsedMs: 0 }
  }
  throw new Error('未知操作')
}
onMessage(async (message) => {
  try { send({ id: message.id, ok: true, result: await handle(message) }) }
  catch (error) { send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }) }
})
