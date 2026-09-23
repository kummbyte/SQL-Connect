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
    await send('disconnect', { id: 'test' })
    await send('connect', { id: 'test', path, readonly: true })
    assert.equal((await send('schema', { connectionId: 'test' }))[0].name, 'items')
    await assert.rejects(send('execute', { connectionId: 'test', sql: 'DELETE FROM items' }), /readonly/)
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
