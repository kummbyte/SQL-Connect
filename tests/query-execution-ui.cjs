const assert = require('node:assert/strict')

// Test-only access to the installed CodeMirror view; no production test API.
const viewExpression = "document.querySelector('.cm-content').cmTile.root.view"
async function testQueryExecution({ window, js, until, press, mysql }) {
  const setEditor = async (sql, from = sql.length, to = from) => {
    await js(`(() => { const view = ${viewExpression}; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(sql)} }, selection: { anchor: ${from}, head: ${to} } }); view.focus() })()`)
  }
  const position = () => js(`(() => { const view = ${viewExpression}; return { text: view.state.doc.toString(), from: view.state.selection.main.from, to: view.state.selection.main.to, scroll: view.scrollDOM.scrollTop } })()`)
  const idle = () => until(() => js('!document.querySelector(".run-btn")?.disabled'), 'query finishes')
  const resultIs = value => until(() => js(`document.querySelector('.result-table td')?.textContent === ${JSON.stringify(String(value))}`), `query result is ${value}`)
  const sourceId = await js('document.querySelector(".tab.active").dataset.tabId')
  const tabCount = await js('document.querySelectorAll(".tab").length')
  const script = "SELECT '中文😀';\n/* ; ignored */ SELECT 22 AS chosen;\nSELECT 33;"
  const from = script.indexOf('SELECT 22'), to = script.indexOf(';\nSELECT 33')
  await setEditor(script, from, to)
  assert.equal(await js('document.querySelector(".run-btn").textContent.includes("执行选区")'), true)
  const before = await position()
  // A real mouse click moves focus to the button, without discarding selection.
  const point = await js('(() => { const r=document.querySelector(".run-btn").getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()')
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  await resultIs(22); await idle()
  assert.deepEqual(await position(), before)
  assert.equal(await js('document.querySelectorAll(".tab").length'), tabCount)
  assert.equal(await js('document.querySelector(".tab.active").dataset.tabId'), sourceId)

  await setEditor(script, script.indexOf('SELECT 33'))
  assert.equal(await js('document.querySelector(".run-btn").textContent.includes("执行当前语句")'), true)
  await press(window, 'ENTER', ['meta']); await resultIs(33); await idle()
  assert.equal((await position()).text, script)
  await setEditor(script, from, to)
  await press(window, 'ENTER', ['meta']); await resultIs(22); await idle()

  await setEditor(script, 0, script.length)
  await js('document.querySelector(".run-btn").click()')
  await until(() => js('document.querySelector(".toast.error")?.textContent.includes("每次只能执行一条 SQL，请调整选区")'), 'multi-statement selection rejected')
  await idle()
  assert.equal(await js('!!document.querySelector(".result-table")'), false)
  assert.equal((await position()).text, script)
  await setEditor('SELECT missing_column_for_range_test')
  await press(window, 'ENTER', ['meta'])
  await until(() => js('document.querySelector(".toast.error")?.textContent.includes("missing_column_for_range_test")'), 'SQL error visible')
  await idle()
  await setEditor('SELECT 44')
  await press(window, 'ENTER', ['meta']); await resultIs(44); await idle()

  await setEditor(script, from, to)
  await js(`(() => { const view = ${viewExpression}, Selection = view.state.selection.constructor; view.dispatch({ selection: Selection.create([Selection.range(0, 8), Selection.range(${from}, ${to})]) }) })()`)
  assert.equal(await js(`${viewExpression}.state.selection.ranges.length`), 2)
  await press(window, 'ENTER', ['meta'])
  await until(() => js('document.querySelector(".toast.info")?.textContent.includes("请使用单个选区")'), 'multiple selections rejected')
  // No SQL request is dispatched for unsupported multi-selection.
  assert.equal(await js('document.querySelector(".result-table td")?.textContent'), '44')

  const longScript = Array.from({ length: 60 }, (_, index) => `SELECT ${index};`).join('\n')
  const longFrom = longScript.lastIndexOf('SELECT')
  await setEditor(longScript, longFrom, longScript.length)
  await js(`${viewExpression}.dispatch({ scrollIntoView: true })`)
  await until(async () => (await position()).scroll > 100, 'long editor scrolls to selected statement')
  const scrolled = await position()
  await js('document.querySelector(".run-btn").click()')
  await resultIs(59); await idle()
  const afterScroll = await position()
  assert.equal(afterScroll.text, scrolled.text)
  assert.equal(afterScroll.from, scrolled.from)
  assert.equal(afterScroll.to, scrolled.to)
  assert.ok(Math.abs(afterScroll.scroll - scrolled.scroll) < 2, 'execution preserves editor scroll')

  // Saved selection survives tab unmount/remount, including reverse selection.
  await setEditor(script, to, from)
  await js('document.querySelector(".new-query").click()')
  const otherId = await js('document.querySelector(".tab.active").dataset.tabId')
  await setEditor('SELECT 55')
  await js(`document.querySelector('[data-tab-id="${sourceId}"]').click()`)
  await until(async () => (await position()).text === script, 'source editor restored')
  assert.equal((await position()).from, from)
  assert.equal((await position()).to, to)
  await js('document.querySelector(".cm-content").focus()')
  await press(window, 'ENTER', ['meta']); await resultIs(22); await idle()

  if (mysql) {
    // A real delayed query completes into its source tab while another is active.
    await setEditor('SELECT 66 AS chosen, SLEEP(0.5) AS wait_for_switch')
    await js(`document.querySelector('.run-btn').click(); document.querySelector('[data-tab-id="${otherId}"]').click()`)
    await until(() => js('!document.querySelector(".statusbar").textContent.includes("正在执行")'), 'background SQL completes')
    assert.equal(await js('document.querySelector(".tab.active").dataset.tabId'), otherId)
    assert.equal((await position()).text, 'SELECT 55')
    assert.equal(await js('!!document.querySelector(".result-table")'), false)
    await js(`document.querySelector('[data-tab-id="${sourceId}"]').click()`)
    await resultIs(66)

    await setEditor('SELECT 77 AS chosen, SLEEP(0.5) AS wait_for_close')
    await js(`document.querySelector('.run-btn').click(); document.querySelector('[data-tab-id="${sourceId}"] > svg:last-child').dispatchEvent(new MouseEvent('click', {bubbles:true}))`)
    await until(() => js('!document.querySelector(".statusbar").textContent.includes("正在执行")'), 'closed-tab query completes')
    assert.equal(await js(`!!document.querySelector('[data-tab-id="${sourceId}"]')`), false)
  } else {
    await js(`document.querySelector('[data-tab-id="${otherId}"]').click()`)
  }
  console.log(`PASS: ${mysql ? 'MySQL' : 'SQLite'} editor selection/cursor execution, same tab, preserved text/selection, error retry${mysql ? ', background and closed-tab responses' : ''}`)
}
module.exports = { testQueryExecution }
