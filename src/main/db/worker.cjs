const Database = require('better-sqlite3')
const mysql = require('mysql2/promise')
const fs = require('node:fs')

const databases = new Map()
const quoteSqlite = name => `"${String(name).replaceAll('"', '""')}"`
const quoteMysql = name => `\`${String(name).replaceAll('`', '``')}\``
const send = message => process.parentPort ? process.parentPort.postMessage(message) : process.send(message)
const onMessage = fn => process.parentPort ? process.parentPort.on('message', event => fn(event.data)) : process.on('message', fn)
const jsonSafe = value => {
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return `[BLOB ${value.length} bytes]`
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
  return value
}
const dbFor = id => { const db = databases.get(id); if (!db) throw new Error('连接已断开'); return db }
const splitStatements = sql => { let q = null, count = 0, text = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (q) { if (c === q && sql[i + 1] === q) { i++; continue }; if (c === q) q = null; continue }; if (c === "'" || c === '"' || c === '`') { q = c; text = true; continue }; if (c === ';') { if (text) count++; text = false; continue }; if (!/\s/.test(c)) text = true }; if (text) count++; return count }

function sqliteTableExists(db, table) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE (type='table' OR type='view') AND name=?").get(table) }
function sqliteExecute(db, sql) {
  const trimmed = sql.trim(); if (!trimmed) throw new Error('请输入 SQL'); if (splitStatements(trimmed) > 1) throw new Error('首版每次只执行一条 SQL，请拆分语句后重试')
  const start = performance.now(); const statement = db.prepare(trimmed)
  if (statement.reader) { const rows = statement.all().slice(0, 1000).map(jsonSafe); const columns = rows.length ? Object.keys(rows[0]) : statement.columns().map(c => c.name); return { columns, rows, truncated: rows.length === 1000, elapsedMs: Math.round(performance.now() - start) } }
  const result = statement.run(); return { columns: [], rows: [], changes: result.changes, lastInsertRowid: jsonSafe(result.lastInsertRowid), elapsedMs: Math.round(performance.now() - start) }
}
function sqliteHandle(db, type, payload) {
  if (type === 'schema') return db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(jsonSafe)
  if (type === 'structure') { if (!sqliteTableExists(db, payload.table)) throw new Error('对象不存在'); const columns = db.prepare(`PRAGMA table_info(${quoteSqlite(payload.table)})`).all().map(jsonSafe); const indexes = db.prepare(`PRAGMA index_list(${quoteSqlite(payload.table)})`).all().map(jsonSafe); const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqlite(payload.table)})`).all().map(jsonSafe); const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(payload.table)?.sql || null; const identity = columns.find(c => c.pk)?.name || (columns.length ? '__sqlconnect_rowid' : null); const objectType = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(payload.table)?.type; return { columns, indexes, foreignKeys, sql, editable: objectType === 'table' && !!identity, identity } }
  if (type === 'query') { if (!sqliteTableExists(db, payload.table)) throw new Error('对象不存在'); const structure = db.prepare(`PRAGMA table_info(${quoteSqlite(payload.table)})`).all(); const isView = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(payload.table)?.type === 'view'; const order = payload.orderBy && structure.some(c => c.name === payload.orderBy) ? ` ORDER BY ${quoteSqlite(payload.orderBy)} ${payload.direction === 'desc' ? 'DESC' : 'ASC'}` : ''; const where = payload.filter ? ` WHERE ${structure.map(c => `CAST(${quoteSqlite(c.name)} AS TEXT) LIKE @filter`).join(' OR ')}` : ''; const from = quoteSqlite(payload.table); const select = isView ? '*' : `rowid AS __sqlconnect_rowid, *`; const stmt = db.prepare(`SELECT ${select} FROM ${from}${where}${order} LIMIT @limit OFFSET @offset`); const params = { limit: Math.min(Math.max(payload.limit || 100, 1), 1000), offset: Math.max(payload.offset || 0, 0) }; if (payload.filter) params.filter = `%${payload.filter}%`; const rows = stmt.all(params).map(jsonSafe); const total = db.prepare(`SELECT COUNT(*) AS count FROM ${from}${where}`).get(payload.filter ? { filter: `%${payload.filter}%` } : {})?.count; return { columns: rows.length ? Object.keys(rows[0]) : structure.map(c => c.name), rows, total: Number(total || 0), elapsedMs: 0 } }
  if (type === 'execute') return sqliteExecute(db, payload.sql)
  if (type === 'apply') {
    if (!payload.changes.length) return { columns: [], rows: [], changes: 0, elapsedMs: 0 }
    const transaction = db.transaction(() => {
      let count = 0
      for (const change of payload.changes) {
        if (change.type === 'insert') {
          const keys = Object.keys(change.values).filter(k => !k.startsWith('__'))
          const stmt = db.prepare(`INSERT INTO ${quoteSqlite(change.table)} (${keys.map(quoteSqlite).join(',')}) VALUES (${keys.map(k => '@' + k).join(',')})`)
          count += stmt.run(Object.fromEntries(keys.map(k => [k, change.values[k]]))).changes
          continue
        }
        if (change.rowid === undefined) throw new Error('该表没有可用的行标识，无法编辑')
        if (change.original) {
          const current = db.prepare(`SELECT * FROM ${quoteSqlite(change.table)} WHERE rowid=@rowid`).get({ rowid: change.rowid })
          if (!current) throw new Error('记录已被删除，请刷新后重试')
          for (const [key, value] of Object.entries(change.original)) if (String(jsonSafe(current[key])) !== String(value)) throw new Error('记录已被外部修改，请刷新后重试')
        }
        if (change.type === 'delete') count += db.prepare(`DELETE FROM ${quoteSqlite(change.table)} WHERE rowid=@rowid`).run({ rowid: change.rowid }).changes
        else {
          const keys = Object.keys(change.values).filter(k => k !== '__sqlconnect_rowid' && !k.startsWith('__'))
          const values = Object.fromEntries(keys.map(k => [k, change.values[k]])); values.rowid = change.rowid
          count += db.prepare(`UPDATE ${quoteSqlite(change.table)} SET ${keys.map(k => `${quoteSqlite(k)}=@${k}`).join(',')} WHERE rowid=@rowid`).run(values).changes
        }
      }
      return count
    })()
    return { columns: [], rows: [], changes: transaction, elapsedMs: 0 }
  }
  throw new Error('未知操作')
}

function mysqlOptions(payload) {
  const options = { host: payload.host, port: Number(payload.port || 3306), user: payload.user, password: payload.password || '', database: payload.database || undefined, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false, connectTimeout: 15000 }
  if (payload.tls !== false) { options.ssl = { rejectUnauthorized: true }; if (payload.caPath) options.ssl.ca = fs.readFileSync(payload.caPath) }
  return options
}
async function mysqlHandle(connection, type, payload) {
  if (type === 'databases') { const [rows] = await connection.base.query('SHOW DATABASES'); return rows.map(row => row.Database).filter(Boolean) }
  if (type === 'closeSession') { const session = connection.sessions.get(payload.sessionId); if (session) await session.end(); connection.sessions.delete(payload.sessionId); connection.sessionDatabases.delete(payload.sessionId); return true }
  const database = payload.database || connection.database
  const qualified = table => `${quoteMysql(database)}.${quoteMysql(table)}`
  if (type === 'schema') { if (!database) return []; const [rows] = await connection.base.query("SELECT TABLE_NAME AS name, TABLE_TYPE AS tableType FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME", [database]); return rows.map(row => ({ name: row.name, type: row.tableType === 'VIEW' ? 'view' : 'table' })) }
  if (!database) throw new Error('请先选择一个数据库')
  if (type === 'structure') { const [columns] = await connection.base.query("SELECT ORDINAL_POSITION AS cid, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [database, payload.table]); const [indexes] = await connection.base.query("SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName, SEQ_IN_INDEX AS seq FROM information_schema.statistics WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX", [database, payload.table]); const [foreignKeys] = await connection.base.query("SELECT CONSTRAINT_NAME AS name, COLUMN_NAME AS columnName, REFERENCED_TABLE_NAME AS referencedTable, REFERENCED_COLUMN_NAME AS referencedColumn FROM information_schema.key_column_usage WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND REFERENCED_TABLE_NAME IS NOT NULL", [database, payload.table]); const [created] = await connection.base.query(`SHOW CREATE TABLE ${qualified(payload.table)}`); const sql = created[0] ? (created[0]['Create Table'] || created[0]['Create View'] || null) : null; return { columns: columns.map(c => ({ cid: Number(c.cid), name: c.name, type: c.type, notnull: c.IS_NULLABLE === 'NO' ? 1 : 0, dflt_value: c.COLUMN_DEFAULT, pk: c.COLUMN_KEY === 'PRI' ? 1 : 0 })), indexes: indexes.map(jsonSafe), foreignKeys: foreignKeys.map(jsonSafe), sql, editable: false, identity: null } }
  if (type === 'query') { const [columns] = await connection.base.query("SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [database, payload.table]); if (!columns.length) throw new Error('对象不存在'); const allowed = new Set(columns.map(c => c.name)); const order = payload.orderBy && allowed.has(payload.orderBy) ? ` ORDER BY ${quoteMysql(payload.orderBy)} ${payload.direction === 'desc' ? 'DESC' : 'ASC'}` : ''; const where = payload.filter ? ` WHERE ${columns.map(c => `CAST(${quoteMysql(c.name)} AS CHAR) LIKE ?`).join(' OR ')}` : ''; const filterArgs = payload.filter ? columns.map(() => `%${payload.filter}%`) : []; const limit = Math.min(Math.max(Number(payload.limit || 100), 1), 1000); const offset = Math.max(Number(payload.offset || 0), 0); const [rows] = await connection.base.query(`SELECT * FROM ${qualified(payload.table)}${where}${order} LIMIT ${limit} OFFSET ${offset}`, filterArgs); const [countRows] = await connection.base.query(`SELECT COUNT(*) AS count FROM ${qualified(payload.table)}${where}`, filterArgs); return { columns: rows.length ? Object.keys(rows[0]) : columns.map(c => c.name), rows: rows.map(jsonSafe), total: Number(countRows[0]?.count || 0), elapsedMs: 0 } }
  if (type === 'execute') { const trimmed = payload.sql.trim(); if (!trimmed) throw new Error('请输入 SQL'); if (splitStatements(trimmed) > 1) throw new Error('首版每次只执行一条 SQL，请拆分语句后重试'); const sessionKey = payload.sessionId || 'default'; let session = connection.sessions.get(sessionKey); if (!session) { session = await mysql.createConnection(mysqlOptions({ ...connection.payload, database: payload.database || connection.database })); connection.sessions.set(sessionKey, session); if (payload.database || connection.database) connection.sessionDatabases.set(sessionKey, payload.database || connection.database) } const targetDatabase = payload.database || connection.database; const currentDatabase = connection.sessionDatabases.get(sessionKey); if (targetDatabase && currentDatabase !== targetDatabase) { await session.query(`USE ${quoteMysql(targetDatabase)}`); connection.sessionDatabases.set(sessionKey, targetDatabase) }; const start = performance.now(); const [rows, fields] = await session.query(trimmed); if (/^\s*USE\s+/i.test(trimmed)) { const match = trimmed.match(/^\s*USE\s+`?([^`;\s]+)`?/i); if (match) connection.sessionDatabases.set(sessionKey, match[1]) }; if (Array.isArray(rows)) return { columns: fields?.map(f => f.name) || (rows.length ? Object.keys(rows[0]) : []), rows: rows.slice(0, 1000).map(jsonSafe), truncated: rows.length > 1000, elapsedMs: Math.round(performance.now() - start) }; return { columns: [], rows: [], changes: Number(rows.affectedRows || 0), lastInsertRowid: rows.insertId == null ? undefined : String(rows.insertId), elapsedMs: Math.round(performance.now() - start) } }
  throw new Error('未知操作')
}

async function handle({ type, payload }) {
  if (type === 'connect') { if (payload.type === 'mysql') { const base = await mysql.createConnection(mysqlOptions(payload)); await base.query('SELECT 1'); databases.set(payload.id, { kind: 'mysql', base, payload, database: payload.database, sessions: new Map(), sessionDatabases: new Map() }); return { ok: true } }; if (!fs.existsSync(payload.path) && !payload.create) throw new Error('数据库文件不存在，请先创建或选择已有文件'); const db = new Database(payload.path, { readonly: !!payload.readonly, fileMustExist: !payload.create, timeout: 5000 }); db.pragma('foreign_keys = ON'); databases.set(payload.id, { kind: 'sqlite', db }); return { ok: true } }
  if (type === 'disconnect') { const connection = dbFor(payload.id); if (connection.kind === 'mysql') { for (const session of connection.sessions.values()) await session.end(); await connection.base.end() } else connection.db.close(); databases.delete(payload.id); return true }
  const connection = dbFor(payload.connectionId); if (connection.kind === 'mysql') return mysqlHandle(connection, type, payload); if (type === 'databases') return []; return sqliteHandle(connection.db, type, payload)
}
onMessage(async message => { try { send({ id: message.id, ok: true, result: await handle(message) }) } catch (error) { send({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }) } })
