const { app, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

app.whenReady().then(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sql-connect-electron-'))
  const worker = utilityProcess.fork(resolve(process.env.SQL_CONNECT_TEST_WORKER || 'src/main/db/worker.cjs'))
  let sequence = 0
  const pending = new Map()
  worker.on('message', message => {
    const request = pending.get(message.id)
    if (!request) { console.error('UNMATCHED WORKER RESPONSE:', message); return }
    pending.delete(message.id)
    clearTimeout(request.timer)
    message.ok ? request.resolve(message.result) : request.reject(new Error(message.error))
  })
  const send = (type, payload) => new Promise((resolve, reject) => {
    const id = String(++sequence)
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Electron worker request timed out: ${type}`)) }, 5000)
    pending.set(id, { resolve, reject, timer })
    worker.postMessage({ id, type, payload })
  })
  try {
    const path = join(directory, '新建数据库.sqlite')
    await send('connect', { id: 'test', path, create: true, readonly: false })
    assert.ok(existsSync(path))
    assert.deepEqual(await send('schema', { connectionId: 'test' }), [])
    await send('execute', { connectionId: 'test', sql: 'CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)' })
    await send('execute', { connectionId: 'test', sql: "INSERT INTO items(name) VALUES ('测试')" })
    const result = await send('query', { connectionId: 'test', table: 'items', offset: 0, limit: 100 })
    assert.equal(result.rows[0].name, '测试')
    const script = "INSERT INTO items(name) VALUES ('must not run'); /* ; comment */ SELECT name FROM items; DELETE FROM items;"
    const cursor = script.indexOf('SELECT')
    const selected = await send('execute', { connectionId: 'test', sql: script, executionRange: { from: cursor, to: cursor } })
    assert.deepEqual(selected.rows, [{ name: '测试' }])
    assert.deepEqual((await send('execute', { connectionId: 'test', sql: script, executionRange: { from: cursor, to: script.indexOf('; DELETE') } })).rows, [{ name: '测试' }])
    await assert.rejects(send('execute', { connectionId: 'test', sql: script, executionRange: { from: 0, to: script.length } }), /每次只能执行一条/)
    assert.equal((await send('execute', { connectionId: 'test', sql: 'SELECT COUNT(*) AS n FROM items; -- ; comment' })).rows[0].n, 1)
    await assert.rejects(send('execute', { connectionId: 'test', sql: 'SELECT 1', executionRange: { from: -1, to: 0 } }), /范围无效/)
    await send('execute', { connectionId: 'test', sql: 'CREATE TABLE delete_test(id TEXT PRIMARY KEY, value, nullable TEXT)' })
    await send('execute', { connectionId: 'test', sql: "INSERT INTO delete_test VALUES ('中文主键', 7, NULL), ('keep', '原值', NULL), ('gone', '原值', NULL)" })
    const readDeleteRows = async () => (await send('query', { connectionId: 'test', table: 'delete_test', limit: 100 })).rows
    const remove = row => ({ type: 'delete', table: 'delete_test', rowid: row.__sqlconnect_rowid, values: {}, original: row })
    const apply = changes => send('apply', { connectionId: 'test', changes })
    const [first, keep, gone] = await readDeleteRows()
    assert.equal((await apply([remove(first)])).changes, 1)
    assert.deepEqual((await readDeleteRows()).map(row => row.id), ['keep', 'gone'])
    // A later conflict must roll back an earlier successful deletion in the batch.
    await send('execute', { connectionId: 'test', sql: "UPDATE delete_test SET value='外部修改' WHERE id='gone'" })
    await assert.rejects(apply([remove(keep), remove(gone)]), /记录已被外部修改/)
    assert.deepEqual((await readDeleteRows()).map(row => row.id), ['keep', 'gone'])
    assert.equal((await apply([remove((await readDeleteRows())[1])])).changes, 1)
    await assert.rejects(apply([remove(gone)]), /记录已被删除/)
    // Equal text representations do not mean equal SQLite values or types.
    const nullRow = (await readDeleteRows())[0]
    await send('execute', { connectionId: 'test', sql: "UPDATE delete_test SET nullable='null' WHERE id='keep'" })
    await assert.rejects(apply([remove(nullRow)]), /记录已被外部修改/)
    await send('execute', { connectionId: 'test', sql: "UPDATE delete_test SET value=7 WHERE id='keep'" })
    const numberRow = (await readDeleteRows())[0]
    await send('execute', { connectionId: 'test', sql: "UPDATE delete_test SET value='7' WHERE id='keep'" })
    await assert.rejects(apply([remove(numberRow)]), /记录已被外部修改/)
    const typedRow = (await readDeleteRows())[0]
    assert.equal(typeof typedRow.value, 'string')
    assert.equal((await apply([{ type: 'update', table: 'delete_test', rowid: typedRow.__sqlconnect_rowid, values: { value: 8, nullable: null }, original: { value: typedRow.value, nullable: typedRow.nullable } }])).changes, 1)
    const updatedRow = (await readDeleteRows())[0]
    assert.equal(updatedRow.value, 8)
    assert.equal(updatedRow.nullable, null)
    assert.equal((await apply([remove(updatedRow)])).changes, 1)
    console.log('PASS: SQLite deletion ignores UI row identity, detects real/type conflicts, refreshes, and rolls back batches')
    await send('execute', { connectionId: 'test', sql: 'DROP TABLE delete_test' })
    await send('disconnect', { id: 'test' })
    await send('connect', { id: 'test', path, readonly: true })
    assert.equal((await send('schema', { connectionId: 'test' }))[0].name, 'items')
    assert.equal((await send('query', { connectionId: 'test', table: 'items', offset: 0, limit: 100 })).editable, false)
    assert.equal((await send('structure', { connectionId: 'test', table: 'items' })).editable, false)
    await assert.rejects(send('execute', { connectionId: 'test', sql: 'DELETE FROM items' }), /readonly/)
    assert.deepEqual((await send('execute', { connectionId: 'test', sql: script, executionRange: { from: cursor, to: cursor } })).rows, [{ name: '测试' }])
    await assert.rejects(send('execute', { connectionId: 'test', sql: script, executionRange: { from: 0, to: 0 } }), /readonly/)
    console.log('PASS: SQLite selection/cursor, comment delimiters, no adjacent side effects and readonly protection')
    await assert.rejects(send('apply', { connectionId: 'test', changes: [{ type: 'insert', table: 'items', values: { name: 'blocked' } }] }), /readonly/)
    await assert.rejects(send('connect', { id: 'missing', path: join(directory, 'missing.sqlite') }), /不存在/)
    await assert.rejects(send('connect', { id: 'invalid', path: join(directory, 'absent', 'new.sqlite'), create: true }), /directory does not exist|unable to open/)
    await send('disconnect', { id: 'test' })
    console.log('PASS: real Electron utility process — create, schema, SQL, reconnect, readonly, missing/invalid path')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    worker.kill()
    rmSync(directory, { recursive: true, force: true })
    app.exit(process.exitCode || 0)
  }
})
