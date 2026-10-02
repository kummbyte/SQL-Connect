const { app, utilityProcess } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')

const root = process.cwd()
const mysqld = process.env.MYSQLD_BIN || '/opt/homebrew/opt/mysql@8.4/bin/mysqld'
const mysql = process.env.MYSQL_BIN || '/opt/homebrew/opt/mysql@8.4/bin/mysql'
const directory = mkdtempSync(join(tmpdir(), 'sql-connect-mysql-'))
const socket = join(directory, 'mysql.sock')
const port = 13306
let server

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitForServer() { for (let i = 0; i < 100; i++) { try { execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '-e', 'SELECT 1'], { stdio: 'ignore' }); return } catch { await wait(100) } } throw new Error('temporary MySQL did not start') }
function send(worker, type, payload) { const id = crypto.randomUUID(); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`timeout: ${type}`)), 15000); const listener = message => { if (message.id !== id) return; clearTimeout(timer); worker.off('message', listener); message.ok ? resolve(message.result) : reject(new Error(message.error)) }; worker.on('message', listener); worker.postMessage({ id, type, payload }) }) }

app.whenReady().then(async () => {
  try {
    execFileSync(mysqld, ['--initialize-insecure', '--datadir=' + directory, '--basedir=/opt/homebrew/opt/mysql@8.4'], { stdio: 'ignore' })
    server = spawn(mysqld, ['--no-defaults', '--datadir=' + directory, '--socket=' + socket, '--port=' + port, '--bind-address=127.0.0.1', '--skip-name-resolve', '--log-error=' + join(directory, 'error.log')], { stdio: 'ignore' })
    await waitForServer()
    execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '-e', "CREATE DATABASE `sql_connect_a`; CREATE DATABASE `sql_connect_b`; CREATE USER 'sqlconnect'@'127.0.0.1' IDENTIFIED BY 'secret'; GRANT ALL ON `sql_connect_a`.* TO 'sqlconnect'@'127.0.0.1'; GRANT ALL ON `sql_connect_b`.* TO 'sqlconnect'@'127.0.0.1'; FLUSH PRIVILEGES; CREATE TABLE `sql_connect_a`.`items` (id BIGINT PRIMARY KEY, name VARCHAR(50), amount DECIMAL(20,5)); INSERT INTO `sql_connect_a`.`items` VALUES (1,'one',12.34000); CREATE TABLE `sql_connect_a`.`pair` (a VARCHAR(30), b INT, value_text VARCHAR(30) DEFAULT 'default'); ALTER TABLE `sql_connect_a`.`pair` ADD PRIMARY KEY (a,b); INSERT INTO `sql_connect_a`.`pair` VALUES ('first',1,'original'); CREATE TABLE `sql_connect_a`.`no_key` (name VARCHAR(30)); CREATE TABLE `sql_connect_b`.`items` (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO `sql_connect_b`.`items` VALUES (2,'two');"], { stdio: 'ignore' })
    execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '--delimiter=//', '-e', "CREATE FUNCTION sql_connect_a.mutate_item() RETURNS INT DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE sql_connect_a.items SET name='function-side-effect' WHERE id=1; RETURN 1; END//"], { stdio: 'ignore' })
    execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '-e', "SET GLOBAL sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'"], { stdio: 'ignore' })
    const worker = utilityProcess.fork(join(root, 'src/main/db/worker.cjs'))
    const id = 'mysql-test'
    await assert.rejects(send(worker, 'connect', { type: 'mysql', id: 'tls-failure', host: '127.0.0.1', port, user: 'sqlconnect', password: 'secret', tls: true }), /self-signed|certificate|SSL|HANDSHAKE|secure/i)
    await send(worker, 'connect', { type: 'mysql', id, host: '127.0.0.1', port, user: 'sqlconnect', password: 'secret', tls: false })
    const databases = await send(worker, 'databases', { connectionId: id }); assert.ok(databases.includes('sql_connect_a')); assert.ok(databases.includes('sql_connect_b'))
    const schema = await send(worker, 'schema', { connectionId: id, database: 'sql_connect_a' }); assert.equal(schema[0].name, 'items')
    const rowsA = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'items', offset: 0, limit: 100 }); assert.equal(rowsA.rows[0].name, 'one'); assert.equal(rowsA.rows[0].amount, '12.34000')
    const executeRange = (sql, executionRange, sessionId = 'range-test') => send(worker, 'execute', { connectionId: id, database: 'sql_connect_a', sessionId, sql, executionRange })
    const script = "UPDATE items SET name='must not run'; /* ; comment */ SELECT name FROM items; DELETE FROM items;"
    const cursor = script.indexOf('SELECT')
    assert.equal((await executeRange(script, { from: cursor, to: cursor })).rows[0].name, 'one')
    assert.equal((await executeRange(script, { from: cursor, to: script.indexOf('; DELETE') })).rows[0].name, 'one')
    await assert.rejects(executeRange(script, { from: 0, to: script.length }), /每次只能执行一条/)
    assert.equal(Number((await executeRange('SELECT COUNT(*) AS n FROM items; -- ; trailing comment')).rows[0].n), 1)
    await executeRange('SET @range_value = 42')
    assert.equal(Number((await executeRange('SELECT @range_value AS n')).rows[0].n), 42)
    assert.equal((await executeRange('SELECT @range_value AS n', undefined, 'range-other')).rows[0].n, null)
    await executeRange("SET SESSION sql_mode = ''")
    const escaped = String.raw`SELECT 'a\';b' AS sample; SELECT 2;`
    assert.equal((await executeRange(escaped, { from: 0, to: 0 })).rows[0].sample, "a';b")
    await executeRange("SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES,ANSI_QUOTES'")
    const unescaped = String.raw`SELECT 'a\' AS sample; SELECT 2;`
    assert.equal((await executeRange(unescaped, { from: 0, to: 0 })).rows[0].sample, "a\\")
    assert.equal((await executeRange('SELECT "name" FROM items; SELECT 2;', { from: 0, to: 0 })).rows[0].name, 'one')
    await executeRange('START TRANSACTION')
    await executeRange("UPDATE items SET name='transaction-only' WHERE id=1")
    await executeRange('ROLLBACK')
    assert.equal((await executeRange('SELECT name FROM items')).rows[0].name, 'one')
    await send(worker, 'closeSession', { connectionId: id, sessionId: 'range-test' })
    assert.equal((await executeRange('SELECT @range_value AS n')).rows[0].n, null)
    console.log('PASS: MySQL selection/cursor, no adjacent writes, stable session, rollback and changed SQL modes')
    const readonlyId = 'mysql-readonly-test'
    await send(worker, 'connect', { type: 'mysql', id: readonlyId, host: '127.0.0.1', port, user: 'sqlconnect', password: 'secret', tls: false, readonly: true })
    assert.equal((await send(worker, 'execute', { connectionId: readonlyId, database: 'sql_connect_a', sql: script, executionRange: { from: cursor, to: cursor } })).rows[0].name, 'one')
    await assert.rejects(send(worker, 'execute', { connectionId: readonlyId, database: 'sql_connect_a', sql: script, executionRange: { from: 0, to: 0 } }), /只读模式/)
    const readonlyRows = await send(worker, 'query', { connectionId: readonlyId, database: 'sql_connect_a', table: 'items', offset: 0, limit: 100 }); assert.equal(readonlyRows.editable, false); assert.equal(readonlyRows.editReason, '连接处于只读模式')
    const readonlyStructure = await send(worker, 'structure', { connectionId: readonlyId, database: 'sql_connect_a', table: 'items' }); assert.equal(readonlyStructure.editable, false); assert.equal(readonlyStructure.editReason, '连接处于只读模式')
    await assert.rejects(send(worker, 'apply', { connectionId: readonlyId, database: 'sql_connect_a', changes: [{ type: 'update', table: 'items', identity: rowsA.rows[0].__sqlconnect_identity, snapshot: rowsA.rows[0].__sqlconnect_snapshot, values: { name: 'must not write' } }] }), /只读模式/)
    const noBackslashSql = String.raw`SELECT 'a\' AS sample`
    for (const sql of ["SELECT 'semi;colon' AS sample;", '/* ordinary comment */ SELECT 1', 'WITH c AS (SELECT 1 AS n) SELECT n FROM c', 'SHOW TABLES', 'DESCRIBE items', 'EXPLAIN SELECT id FROM items', 'EXPLAIN FORMAT=JSON SELECT id FROM items', 'SELECT "name" FROM items', noBackslashSql]) {
      const result = await send(worker, 'execute', { connectionId: readonlyId, database: 'sql_connect_a', sessionId: `readonly-${crypto.randomUUID()}`, sql })
      assert.ok(Array.isArray(result.rows), `read-only query should run: ${sql}`)
      if (sql === noBackslashSql) assert.equal(result.rows[0].sample, 'a\\')
    }
    for (const sql of ["INSERT INTO items VALUES (2,'bad',1)", "UPDATE items SET name='bad'", 'DELETE FROM items', 'CREATE TEMPORARY TABLE local_only (id INT)', 'DROP TABLE items', 'SET @x=1', 'USE sql_connect_b', 'CALL no_such_procedure()', 'START TRANSACTION', 'COMMIT', 'EXPLAIN ANALYZE SELECT id FROM items', 'SELECT id INTO OUTFILE \'/tmp/sql-connect-readonly\' FROM items', 'SELECT id FROM items FOR UPDATE', 'WITH c AS (SELECT 1) UPDATE items SET name=\'bad\'', 'SELECT 1; SELECT 2', '/*! SELECT 1 */', 'SELECT /*+ MAX_EXECUTION_TIME(10) */ 1']) {
      await assert.rejects(send(worker, 'execute', { connectionId: readonlyId, database: 'sql_connect_a', sql }), /只读模式|锁定读取/, `read-only SQL should reject: ${sql}`)
    }
    await assert.rejects(send(worker, 'execute', { connectionId: readonlyId, database: 'sql_connect_a', sql: 'SELECT mutate_item()' }), /read.only|READ ONLY|readonly/i)
    assert.equal((await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'items', offset: 0, limit: 100 })).rows[0].name, 'one')
    await send(worker, 'disconnect', { id: readonlyId })
    const rowsB = await send(worker, 'query', { connectionId: id, database: 'sql_connect_b', table: 'items', offset: 0, limit: 100 }); assert.equal(rowsB.rows[0].name, 'two')
    const structure = await send(worker, 'structure', { connectionId: id, database: 'sql_connect_a', table: 'items' }); assert.equal(structure.editable, true); assert.match(structure.sql, /CREATE TABLE/)
    assert.equal(rowsA.editable, true); assert.deepEqual(rowsA.primaryKey, ['id']); assert.equal(rowsA.rows[0].__sqlconnect_identity.id, '1'); assert.match(rowsA.rows[0].__sqlconnect_snapshot, /^[a-f0-9]{64}$/)
    await send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'update', table: 'items', identity: rowsA.rows[0].__sqlconnect_identity, snapshot: rowsA.rows[0].__sqlconnect_snapshot, values: { name: 'updated', amount: '999999999999999.12345' } }] })
    const updated = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'items', offset: 0, limit: 100 }); assert.equal(updated.rows[0].name, 'updated'); assert.equal(updated.rows[0].amount, '999999999999999.12345')
    const stale = updated.rows[0]
    const session = `${id}:query:test`; await send(worker, 'execute', { connectionId: id, sessionId: session, database: 'sql_connect_a', sql: "UPDATE items SET name='external' WHERE id=1" })
    await assert.rejects(send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'delete', table: 'items', identity: stale.__sqlconnect_identity, snapshot: stale.__sqlconnect_snapshot, values: {} }] }), /externally|外部修改|修改/)
    const [pairRows, noKeyRows] = await Promise.all([send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'pair', offset: 0, limit: 100 }), send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'no_key', offset: 0, limit: 100 })])
    assert.equal(pairRows.editable, true); assert.deepEqual(pairRows.primaryKey, ['a', 'b']); assert.equal(noKeyRows.editable, false); assert.match(noKeyRows.editReason, /主键/)
    await send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'update', table: 'pair', identity: pairRows.rows[0].__sqlconnect_identity, snapshot: pairRows.rows[0].__sqlconnect_snapshot, values: { a: 'renamed', value_text: null } }] })
    const pairUpdated = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'pair', offset: 0, limit: 100 }); assert.equal(pairUpdated.rows[0].a, 'renamed'); assert.equal(pairUpdated.rows[0].value_text, null)
    await send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'insert', table: 'pair', values: { a: 'with-default', b: 2 } }] })
    const afterInsert = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'pair', offset: 0, limit: 100 }); assert.equal(afterInsert.rows.find(row => row.a === 'with-default').value_text, 'default')
    await assert.rejects(send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'update', table: 'pair', identity: pairUpdated.rows[0].__sqlconnect_identity, snapshot: pairUpdated.rows[0].__sqlconnect_snapshot, values: { value_text: 'should rollback' } }, { type: 'insert', table: 'pair', values: { a: 'renamed', b: 1 } }] }), /Duplicate|duplicate/i)
    const rolledBack = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'pair', offset: 0, limit: 100 }); assert.equal(rolledBack.rows.find(row => row.a === 'renamed').value_text, null)
    const result = await send(worker, 'execute', { connectionId: id, sessionId: session, database: 'sql_connect_a', sql: 'SELECT name FROM items WHERE id=1' }); assert.equal(result.rows[0].name, 'external')
    const beforeKeyChange = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'items', offset: 0, limit: 100 })
    await send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'update', table: 'items', identity: beforeKeyChange.rows[0].__sqlconnect_identity, snapshot: beforeKeyChange.rows[0].__sqlconnect_snapshot, values: { id: '10' } }] })
    const afterKeyChange = await send(worker, 'query', { connectionId: id, database: 'sql_connect_a', table: 'items', offset: 0, limit: 100 }); assert.equal(afterKeyChange.rows[0].id, '10'); assert.equal(afterKeyChange.rows[0].__sqlconnect_identity.id, '10')
    await assert.rejects(send(worker, 'apply', { connectionId: id, database: 'sql_connect_a', changes: [{ type: 'insert', table: 'no_key', values: { name: 'unsafe' } }] }), /主键|不可编辑/)
    await send(worker, 'closeSession', { connectionId: id, sessionId: session }); await send(worker, 'disconnect', { id }); worker.kill(); console.log('PASS: MySQL 8.4 utility process — database editing, composite keys, precision, defaults, NULL, conflicts and rollback')
  } catch (error) { console.error(error); process.exitCode = 1 } finally { if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null || server.signalCode) resolve(); else server.once('exit', resolve) }) }; rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); app.exit(process.exitCode || 0) }
})
