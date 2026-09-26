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
async function press(window, keyCode, modifiers = []) {
  await window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  await window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}
function setInput(window, index, value) { return window.webContents.executeJavaScript(`(() => { const input = document.querySelectorAll('.modal-card input:not([type="checkbox"])')[${index}]; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()` ) }

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    execFileSync(mysqld, ['--initialize-insecure', '--datadir=' + directory, '--basedir=/opt/homebrew/opt/mysql@8.4'], { stdio: 'ignore' })
    server = spawn(mysqld, ['--no-defaults', '--datadir=' + directory, '--socket=' + socket, '--port=' + port, '--bind-address=127.0.0.1', '--skip-name-resolve', '--log-error=' + join(directory, 'error.log')], { stdio: 'ignore' })
    await waitForServer()
    execFileSync(mysql, ['--protocol=socket', '--socket', socket, '-uroot', '-e', "CREATE DATABASE `flower_shop`; CREATE TABLE `flower_shop`.`items` (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO `flower_shop`.`items` VALUES (1,'flower'); CREATE TABLE `flower_shop`.`this_is_a_very_long_table_name_for_sidebar_layout_checks` (id INT PRIMARY KEY); CREATE VIEW `flower_shop`.`layout_sidebar_view_with_long_name` AS SELECT id, name FROM `flower_shop`.`items`; CREATE DATABASE `other_shop`; CREATE TABLE `other_shop`.`items` (id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO `other_shop`.`items` VALUES (2,'other'); CREATE USER 'sqlconnect'@'127.0.0.1' IDENTIFIED BY 'secret'; GRANT ALL ON `flower_shop`.* TO 'sqlconnect'@'127.0.0.1'; GRANT ALL ON `other_shop`.* TO 'sqlconnect'@'127.0.0.1'; FLUSH PRIVILEGES;"], { stdio: 'ignore' })
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
    await js('(() => { const tls = document.querySelectorAll(".modal-card input[type=checkbox]")[0]; if (tls.checked) tls.click() })()')
    assert.equal(await js('document.querySelectorAll(".modal-card input[type=checkbox]")[0].checked'), false)
    await js('document.querySelector(".modal-card button[type=submit]").click()')
    await until(() => js('document.querySelector(".connection-row")?.textContent.includes("在线")'), 'MySQL connected')
    await until(() => js('Array.from(document.querySelectorAll(".tree-row")).some(row => row.textContent.trim() === "flower_shop")'), 'flower_shop listed')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop")?.getAttribute("aria-expanded")'), 'true')
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop").click()')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop")?.getAttribute("aria-expanded")'), 'false')
    assert.equal(await js('Array.from(document.querySelectorAll(".connection-database-tree > div")).find(section => section.querySelector(".tree-row")?.textContent.trim() === "flower_shop")?.querySelector(".object-row")'), null)
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop").click()')
    await until(() => js('Array.from(document.querySelectorAll(".object-row")).some(row => row.textContent.includes("items"))'), 'items table listed')
    const objectLayout = await js(`(() => {
      const sidebar = document.querySelector('.sidebar'); sidebar.style.width = '230px'; sidebar.style.flex = 'none';
      return ['this_is_a_very_long_table_name_for_sidebar_layout_checks', 'layout_sidebar_view_with_long_name'].map(name => {
        const row = Array.from(document.querySelectorAll('.object-row')).find(item => item.querySelector('.table-object-name')?.textContent === name);
        const icon = row.querySelector('.table-object-icon').getBoundingClientRect();
        const label = row.querySelector('.table-object-name'); const labelRect = label.getBoundingClientRect();
        const typeRect = row.querySelector('.table-object-type').getBoundingClientRect();
        const structureRect = row.querySelector('.structure-btn').getBoundingClientRect();
        return { name, iconWidth: icon.width, title: row.querySelector('.table-object-button').title, truncated: label.scrollWidth > label.clientWidth,
          labelRight: labelRect.right, typeLeft: typeRect.left, typeRight: typeRect.right, structureLeft: structureRect.left,
          kind: row.querySelector('.table-object-type').textContent.trim() };
      });
    })()`)
    assert.equal(objectLayout.length, 2)
    for (const layout of objectLayout) {
      assert.equal(layout.iconWidth, 16)
      assert.equal(layout.title, layout.name)
      assert.equal(layout.truncated, true)
      assert.ok(layout.labelRight <= layout.typeLeft)
      assert.ok(layout.typeRight <= layout.structureLeft)
    }
    assert.equal(objectLayout.find(item => item.kind === 'VIEW')?.name, 'layout_sidebar_view_with_long_name')
    const lightObjectLayout = await js(`(() => { document.querySelector('.top-actions button[title="切换主题"]').click(); return document.querySelector('.table-object-icon').getBoundingClientRect().width })()`)
    assert.equal(lightObjectLayout, 16)
    await js('document.querySelector(".top-actions button[title=切换主题]").click(); document.querySelector(".sidebar").style.width = ""; document.querySelector(".sidebar").style.flex = ""')
    console.log('PASS: MySQL table and view icons stay fixed; long names truncate without colliding with type or structure controls')
    await js('Array.from(document.querySelectorAll(".object-row > button:first-child")).find(button => button.textContent.includes("items")).click()')
    await until(() => js('document.querySelectorAll(".table-wrap input")[1]?.value === "flower"'), 'first table query includes selected database')
    assert.equal(await js('document.querySelector(".toast.error")?.textContent.includes("请选择一个数据库") || false'), false)
    assert.equal(await js('document.querySelector(".connection-info-toggle")?.getAttribute("aria-expanded")'), 'false')
    assert.equal(await js('!!document.querySelector(".connection-details")'), false)
    await js('document.querySelector(".connection-info-toggle").click()')
    const databaseHeaderLeft = await js('document.querySelector(".connection-database-tree > .tree-section-label").getBoundingClientRect().left')
    const detailsLabelLeft = await js('document.querySelector(".connection-details dt").getBoundingClientRect().left')
    assert.ok(Math.abs(databaseHeaderLeft - detailsLabelLeft) <= 2)
    assert.equal(await js('!!document.querySelector(".tree-row")'), true)
    await js('document.querySelector(".connection-info-toggle").click()')
    assert.equal(await js('!!document.querySelector(".connection-details")'), false)
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "other_shop").click()')
    await until(() => js('Array.from(document.querySelectorAll(".connection-database-tree > div")).find(section => section.querySelector(".tree-row")?.textContent.trim() === "other_shop")?.querySelector(".object-row")?.textContent.includes("items")'), 'other_shop items listed')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop")?.getAttribute("aria-expanded")'), 'true')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "other_shop")?.getAttribute("aria-expanded")'), 'true')
    await js('Array.from(document.querySelectorAll(".connection-database-tree > div")).find(section => section.querySelector(".tree-row")?.textContent.trim() === "other_shop").querySelector(".object-row > button:first-child").click()')
    await until(() => js('document.querySelectorAll(".table-wrap input")[1]?.value === "other"'), 'same table name uses other_shop context')
    assert.equal(await js('document.querySelector(".toast.error")?.textContent.includes("请选择一个数据库") || false'), false)
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop").click()')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop")?.getAttribute("aria-expanded")'), 'false')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "other_shop")?.getAttribute("aria-expanded")'), 'true')
    await js('document.querySelector(".new-query").click()')
    await until(() => js('!!document.querySelector(".database-picker select")'), 'new query database picker appears')
    assert.equal(await js('document.querySelector(".database-picker select").value'), 'other_shop')
    await js('Array.from(document.querySelectorAll(".tree-row")).find(row => row.textContent.trim() === "flower_shop").click()')
    assert.equal(await js('Array.from(document.querySelectorAll(".tree-row")).filter(row => row.getAttribute("aria-expanded") === "true").length'), 2)
    await js('document.querySelector(".connection-block .disconnect-control").click()')
    await until(() => js('document.querySelector(".connection-block")?.textContent.includes("MYSQL") && !document.querySelector(".connection-block")?.textContent.includes("在线")'), 'MySQL target disconnects')
    assert.equal(await js('!!document.querySelector(".sidebar-footer")'), false)
    await js('document.querySelector(".connection-block .connection-main").click()')
    assert.equal(await js('document.querySelector(".connection-block .connect-saved-btn")'), null)
    await js('document.querySelector(".connection-block .connection-main").click()')
    assert.equal(await js('document.querySelector(".connection-block .connection-details")?.textContent.includes("127.0.0.1")'), true)
    assert.equal(await js(`document.querySelector(".connection-block .connection-details")?.textContent.includes(${JSON.stringify(String(port))})`), true)
    assert.equal(await js('document.querySelector(".connection-block .connection-details")?.textContent.includes("用户名")'), true)
    assert.equal(await js('document.querySelector(".connection-block .connect-saved-btn")?.textContent.includes("连接")'), true)
    assert.equal(await js('document.querySelector(".connection-block")?.textContent.includes("在线")'), false)
    await js('document.querySelector(".connection-block .connect-saved-btn").click()')
    await until(() => js('!!document.querySelector(".modal-card")'), 'MySQL reconnect requests password')
    await setInput(window, 4, 'incorrect-password')
    await js('document.querySelector(".modal-card button[type=submit]").click()')
    await until(() => js('document.querySelector(".toast.error")?.textContent.includes("Access denied")'), 'invalid password reports connection error')
    assert.equal(await js('!!document.querySelector(".modal-card")'), true)
    await setInput(window, 4, 'secret')
    await js('document.querySelector(".modal-card button[type=submit]").click()')
    await until(() => js('document.querySelector(".connection-block")?.textContent.includes("在线")'), 'MySQL target reconnects')
    await until(() => js('Array.from(document.querySelectorAll(".tree-row")).some(row => row.textContent.trim() === "flower_shop")'), 'MySQL databases reload after reconnect')
    console.log('PASS: offline saved MySQL shows connection details; explicit connect retries after authentication failure')
    await js('document.querySelector(".new-query").click()')
    await until(() => js('!!document.querySelector(".cm-content")'), 'MySQL SQL editor opened')
    await js('document.querySelector(".cm-content").focus()')
    await window.webContents.insertText('sel')
    await until(() => js('document.querySelector(".cm-tooltip-autocomplete")?.textContent.includes("SELECT")'), 'MySQL SQL keyword completion appears')
    await delay(150)
    await press(window, 'Tab')
    await until(() => js('document.querySelector(".cm-content")?.innerText.trim() === "SELECT"'), 'MySQL Tab accepts SQL completion')
    await js('document.querySelector(".cm-content").focus(); document.execCommand("selectAll")')
    await window.webContents.insertText('SELECT 1')
    await press(window, 'ENTER', ['meta'])
    await until(() => js('Array.from(document.querySelectorAll(".result-table td")).some(cell => cell.textContent.trim() === "1")'), 'MySQL Command-Enter executes SQL')
    await js('document.querySelector(".connection-menu-button").click()')
    await js('document.querySelector("[data-connection-option=mysql]").click()')
    await until(() => js('!!document.querySelector(".modal-card")'), 'duplicate MySQL form opens')
    await setInput(window, 0, 'Different name')
    await setInput(window, 1, '127.0.0.1')
    await setInput(window, 2, String(port))
    await setInput(window, 3, 'sqlconnect')
    await setInput(window, 4, 'secret')
    await js('(() => { const tls = document.querySelectorAll(".modal-card input[type=checkbox]")[0]; if (tls.checked) tls.click() })()')
    assert.equal(await js('document.querySelectorAll(".modal-card input[type=checkbox]")[0].checked'), false)
    await js('document.querySelector(".modal-card button[type=submit]").click()')
    await until(() => js('document.querySelectorAll(".connection-row").length === 1 && document.querySelector(".toast.info")?.textContent.includes("已复用现有连接")'), 'duplicate MySQL reuses existing connection')
    const savedMySQL = await js('window.sqlConnect.settings.load().then(items => items.find(item => item.type === "mysql"))')
    assert.ok(savedMySQL)
    const missingPassword = await js(`(async () => { await window.sqlConnect.db.disconnect(${JSON.stringify(savedMySQL.id)}); try { await window.sqlConnect.db.connect(${JSON.stringify(savedMySQL)}); return null } catch (error) { return error instanceof Error ? error.message : String(error) } })()`)
    assert.equal(missingPassword.endsWith('请输入 MySQL 密码'), true)
    const rememberedReconnect = await js(`(async () => { try { const first = await window.sqlConnect.db.connect(${JSON.stringify({ ...savedMySQL, password: 'secret', rememberPassword: true })}); await window.sqlConnect.db.disconnect(first.connection.id); const second = await window.sqlConnect.db.connect(${JSON.stringify(savedMySQL)}); const persisted = (await window.sqlConnect.settings.load()).find(item => item.type === 'mysql'); await window.sqlConnect.db.disconnect(second.connection.id); return { rememberPassword: persisted?.rememberPassword, reconnected: true } } catch (error) { return { error: error instanceof Error ? error.message : String(error) } } })()`)
    assert.deepEqual(rememberedReconnect, { rememberPassword: true, reconnected: true })
    await js('(() => { window.__confirmResult = false; window.confirm = message => { window.__confirmMessage = message; return window.__confirmResult } })()')
    await js('document.querySelector(".connection-block .delete-connection-btn").click()')
    assert.equal(await js('window.__confirmMessage.includes("不会删除 SQLite 文件或 MySQL 数据")'), true)
    assert.equal(await js('document.querySelectorAll(".connection-row").length'), 1)
    await js('window.__confirmResult = true')
    await js('document.querySelector(".connection-block .delete-connection-btn").click()')
    await until(() => js('document.querySelectorAll(".connection-row").length === 0'), 'online MySQL saved connection deletes')
    assert.equal(await js('window.sqlConnect.settings.load().then(items => items.length)'), 0)
    console.log('PASS: BrowserWindow MySQL connection → database selection → same table name and duplicate connection reuse')
  } catch (error) { console.error(error); exitCode = 1 } finally {
    app.emit('before-quit', { preventDefault() {} })
    if (server) { server.kill(); await new Promise(resolve => { if (server.exitCode !== null || server.signalCode) resolve(); else server.once('exit', resolve) }) }
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    app.exit(exitCode)
  }
})
