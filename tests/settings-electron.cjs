const { app, BrowserWindow } = require('electron')
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')

const directory = mkdtempSync(join(tmpdir(), 'sql-connect-settings-'))
const root = resolve(process.env.SQL_CONNECT_TEST_APP_ROOT || '.')
const sqlitePath = join(directory, 'memory.sqlite')
const sqliteLink = join(directory, 'memory-link.sqlite')
writeFileSync(sqlitePath, '')
symlinkSync(sqlitePath, sqliteLink)
writeFileSync(join(directory, 'connections.json'), JSON.stringify([
  { id: 'sqlite-first', type: 'sqlite', name: 'memory', path: sqlitePath, readonly: false },
  { id: 'sqlite-second', type: 'sqlite', name: 'memory copy', path: sqliteLink, readonly: true },
  { id: 'mysql-first', type: 'mysql', name: 'MySQL 连接', host: '127.0.0.1', port: 3306, user: 'root', tls: false },
  { id: 'mysql-second', type: 'mysql', name: 'MySQL copy', host: '127.0.0.1 ', port: 3306, user: 'root', tls: false }
], null, 2))
app.setPath('userData', directory)
app.getAppPath = () => root
require(join(root, 'out/main/index.js'))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, description) { for (let i = 0; i < 120; i++) { if (await fn()) return; await delay(100) }; throw new Error(`Timed out: ${description}`) }

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await until(() => BrowserWindow.getAllWindows().length > 0, 'window created')
    const window = BrowserWindow.getAllWindows()[0]
    const js = code => window.webContents.executeJavaScript(code)
    await until(() => js('!!document.querySelector(".connection-menu-button")'), 'renderer mounted')
    const loaded = await js('window.sqlConnect.settings.load()')
    assert.equal(loaded.length, 2)
    assert.deepEqual(loaded.map(item => item.id), ['sqlite-first', 'mysql-first'])
    assert.equal(loaded[0].readonly, true)
    assert.equal(JSON.parse(readFileSync(join(directory, 'connections.json'), 'utf8')).length, 2)
    assert.equal(readdirSync(directory).some(name => name.startsWith('connections.json.backup-')), true)

    const saved = await js(`window.sqlConnect.settings.save(${JSON.stringify([
      loaded[0],
      { ...loaded[0], id: 'duplicate-again', readonly: false },
      loaded[1],
      { ...loaded[1], id: 'mysql-other-user', user: 'other' }
    ])})`)
    assert.equal(saved.length, 3)
    assert.equal(saved.filter(item => item.type === 'sqlite').length, 1)
    assert.equal(saved.find(item => item.type === 'sqlite').readonly, true)
    assert.equal(saved.filter(item => item.type === 'mysql').length, 2)
    const deleteResult = await js(`window.sqlConnect.settings.remove(${JSON.stringify(loaded[0].id)})`)
    assert.equal(deleteResult.ok, true)
    const afterDelete = await js('window.sqlConnect.settings.load()')
    assert.equal(afterDelete.some(item => item.id === loaded[0].id), false)
    assert.equal(JSON.parse(readFileSync(join(directory, 'connections.json'), 'utf8')).some(item => item.id === loaded[0].id), false)
    assert.equal((await js('window.sqlConnect.settings.load()')).length, 2)
    const configPath = join(directory, 'connections.json')
    const heldConfigPath = join(directory, 'connections.json.held')
    const failureTarget = afterDelete[0].id
    renameSync(configPath, heldConfigPath)
    mkdirSync(configPath)
    const failedDelete = await js(`window.sqlConnect.settings.remove(${JSON.stringify(failureTarget)})`)
    assert.equal(failedDelete.ok, false)
    assert.ok(failedDelete.error)
    rmSync(configPath, { recursive: true, force: true })
    renameSync(heldConfigPath, configPath)
    assert.equal((await js('window.sqlConnect.settings.load()')).some(item => item.id === failureTarget), true)
    console.log('PASS: settings merge SQLite symlink duplicates, preserves readonly, and keeps distinct MySQL users')
    console.log('PASS: settings delete removes only the selected saved connection')
    console.log('PASS: settings delete failure preserves the original saved connection list')
  } catch (error) { console.error(error); exitCode = 1 } finally {
    app.emit('before-quit', { preventDefault() {} })
    rmSync(directory, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
