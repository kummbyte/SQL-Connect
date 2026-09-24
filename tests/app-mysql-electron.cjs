const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')

const root = resolve(process.env.SQL_CONNECT_TEST_APP_ROOT || '.')
const mysqld = process.env.MYSQLD_BIN || '/opt/homebrew/opt/mysql@8.4/bin/mysqld'
const mysql = process.env.MYSQL_BIN || '/opt/homebrew/opt/mysql@8.4/bin/mysql'
const directory = mkdtempSync(join(tmpdir(), 'sql-connect-ui-mysql-'))
const socket = join(directory, 'mysql.sock')
const port = 13307
let server
app.setPath('userData', directory)
app.getAppPath = () => root

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitForServer() { for (let i = 0; i < 120; i++) { try { execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '-e', 'SELECT 1'], { stdio: 'ignore' }); return } catch { await delay(100) } } throw new Error('temporary MySQL did not start') }
async function until(fn, description) { for (let i = 0; i < 180; i++) { if (await fn()) return; await delay(100) }; throw new Error(`Timed out: ${description}`) }
function setInput(window, index, value) { return window.webContents.executeJavaScript(`(() => { const input = document.querySelectorAll('.modal-card input:not([type="checkbox"])')[${index}]; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()` ) }

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    execFileSync(mysqld, ['--initialize-insecure', '--datadir=' + directory, '--basedir=/opt/homebrew/opt/mysql@8.4'], { stdio: 'ignore' })
    server = spawn(mysqld, ['--no-defaults', '--datadir=' + directory, '--socket=' + socket, '--port=' + port, '--bind-address=127.0.0.1', '--skip-name-resolve', '--log-error=' + join(directory, 'error.log')], { stdio: 'ignore' })
    await waitForServer()
    execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '-e', "CREATE DATABASE `flower_shop`; CREATE TABLE `flower_shop`.`items` (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO `flower_shop`.`items` VALUES (1,'flower'); CREATE DATABASE `other_shop`; CREATE TABLE `other_shop`.`items` (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO `other_shop`.`items` VALUES (2,'other'); CREATE USER 'sqlconnect'@'127.0.0.1' IDENTIFIED BY 'secret'; GRANT ALL ON `flower_shop`.* TO 'sqlconnect'@'127.0.0.1'; GRANT ALL ON `other_shop`.* TO 'sqlconnect'@'127.0.0.1'; FLUSH PRIVILEGES;"], { stdio: 'ignore' })
    require(join(root, 'out/main/index.js'))
    await until(() => BrowserWindow.getAllWindows().length > 0, 'window created')
    const window = BrowserWindow.getAllWindows()[0]
    const js = code => window.webContents.executeJavaScript(code)
    await until(() => js('!!document.querySelector(".connection-menu-button")'), 'renderer mounted')
    await js('document.querySelector(".connection-menu-button").click()')
    await js('document.querySelector("[data-connection-option=mysql]").click()')
    await until(() => js('!!document.querySelector(".modal-card")'), 'MySQL form opened')
    await setInput(window, 0, 'MySQL UI test')
    await setInput(window, 1, '127.0.0.1')
    await setInput(window, 2, String(port))
    await setInput(window, 3, 'sqlconnect')
    await setInput(window, 4, 'secret')
    await js('document.querySelectorAll(".modal-card input[type=checkbox]")[0].click()')
    await js('document.querySelector(".modal-card button[type=submit]").click()')
    await until(() => js('document.querySelector(".connection-row")?.textContent.includes("在线")'), 'MySQL connected')
    await until(() => js('Array.from(document.querySelectorAll(".tree-row")).some(row => row.textContent.trim() === "flower_shop")'), 'flower_shop listed')
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop").click()')
    await until(() => js('Array.from(document.querySelectorAll(".object-row")).some(row => row.textContent.includes("items"))'), 'items table listed')
    await js('Array.from(document.querySelectorAll(".object-row > button:first-child")).find(button => button.textContent.includes("items")).click()')
    await until(() => js('document.querySelectorAll(".table-wrap input")[1]?.value === "flower"'), 'first table query includes selected database')
    assert.equal(await js('document.querySelector(".toast.error")?.textContent.includes("请选择一个数据库") || false'), false)
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "other_shop").click()')
    await until(() => js('Array.from(document.querySelectorAll(".object-row")).some(row => row.textContent.includes("items"))'), 'other_shop items listed')
    await js('Array.from(document.querySelectorAll(".object-row > button:first-child")).find(button => button.textContent.includes("items")).click()')
    await until(() => js('document.querySelectorAll(".table-wrap input")[1]?.value === "other"'), 'same table name uses other_shop context')
    assert.equal(await js('document.querySelector(".toast.error")?.textContent.includes("请选择一个数据库") || false'), false)
    console.log('PASS: BrowserWindow MySQL connection → database selection → same table name keeps each tab database context')
  } catch (error) { console.error(error); exitCode = 1 } finally {
    app.emit('before-quit', { preventDefault() {} })
    if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null || server.signalCode) resolve(); else server.once('exit', resolve) }) }
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    app.exit(exitCode)
  }
})
