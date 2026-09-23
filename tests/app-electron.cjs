const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')

const directory = mkdtempSync(join(tmpdir(), 'sql-connect-ui-'))
app.setPath('userData', directory)
const root = resolve(process.env.SQL_CONNECT_TEST_APP_ROOT || '.')
app.getAppPath = () => root
let savePath = join(directory, '中文新数据库.sqlite')
dialog.showSaveDialog = async () => ({ canceled: !savePath, filePath: savePath })
require(join(root, 'out/main/index.js'))

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, description) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(100) }
  throw new Error(`Timed out: ${description}`)
}
app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await until(() => BrowserWindow.getAllWindows().length > 0, 'window created')
    const window = BrowserWindow.getAllWindows()[0]
    const js = code => window.webContents.executeJavaScript(code)
    await until(() => js('!!document.querySelector(".welcome-actions")'), 'renderer mounted')
    const create = () => js('document.querySelectorAll(".welcome-actions button")[1].click()')
    await create()
    await until(() => js('document.querySelector(".connection-row")?.textContent.includes("在线") && !document.querySelector(".statusbar").textContent.includes("正在执行")'), 'create completes in UI')
    let connections = JSON.parse(readFileSync(join(directory, 'connections.json'), 'utf8'))
    assert.equal(connections.length, 1)
    assert.equal(connections[0].path, savePath)
    console.log('PASS: UI new database button → worker → saved connection → ready status')
    savePath = join(directory, 'missing-directory', 'fail.sqlite')
    await create()
    await until(() => js('!!document.querySelector(".toast.error") && !document.querySelector(".statusbar").textContent.includes("正在执行")'), 'invalid path clears loading')
    console.log('PASS: UI reports creation error and clears loading')
    savePath = join(directory, 'retry.sqlite')
    await create()
    await until(() => js('document.querySelectorAll(".connection-row").length === 2 && !document.querySelector(".statusbar").textContent.includes("正在执行")'), 'retry succeeds')
    savePath = undefined
    await create()
    assert.equal(await js('document.querySelectorAll(".connection-row").length'), 2)
    assert.equal(await js('document.querySelector(".statusbar").textContent.includes("正在执行")'), false)
    connections = JSON.parse(readFileSync(join(directory, 'connections.json'), 'utf8'))
    assert.equal(connections.length, 2)
    console.log('PASS: UI retry and file-dialog cancellation')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    app.emit('before-quit', { preventDefault() {} })
    rmSync(directory, { recursive: true, force: true })
    app.exit(exitCode)
  }
})
