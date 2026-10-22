const assert = require('node:assert/strict')
const { ipcMain } = require('electron')

// Both suites create these fixtures in their own disposable database.
const paginationFixtures = [
  'CREATE TABLE pagination_test (id INTEGER PRIMARY KEY, value_text VARCHAR(30))',
  `INSERT INTO pagination_test VALUES ${Array.from({ length: 300 }, (_, i) => `(${i + 1},'${i < 205 ? 'keep' : 'other'}-${i + 1}')`).join(',')}`,
  'CREATE VIEW pagination_view AS SELECT * FROM pagination_test',
  'CREATE TABLE pagination_empty (id INTEGER PRIMARY KEY, value_text VARCHAR(30))'
]

async function testPagination({ window, js, until, database }) {
  const originalQuery = ipcMain._invokeHandlers.get('db:query')
  assert.equal(typeof originalQuery, 'function')
  let calls = [], failNext = false, holdNext = false, releaseHeld, heldReady = false
  ipcMain.removeHandler('db:query')
  ipcMain.handle('db:query', async (event, id, table, options) => {
    if (!table.startsWith('pagination_')) return originalQuery(event, id, table, options)
    calls.push({ table, ...options })
    if (failNext) { failNext = false; throw new Error('pagination test query failure') }
    const hold = holdNext
    holdNext = false
    const result = await originalQuery(event, id, table, options)
    if (hold) { await new Promise(resolve => { releaseHeld = resolve; heldReady = true }) }
    return result
  })
  const input = (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  const open = async name => {
    await js(`Array.from(document.querySelectorAll('.object-row')).find(row=>row.querySelector('.table-object-name')?.textContent===${JSON.stringify(name)}).querySelector('.table-object-button').click()`)
    await until(() => js(`document.querySelector('.panel h1')?.textContent===${JSON.stringify(name)} && !!document.querySelector('.page-input') && !document.querySelector('.statusbar')?.textContent.includes('正在执行')`), `open ${name}`)
  }
  const firstId = () => js("document.querySelector('.table-wrap tbody tr td:nth-child(2) input')?.value")
  const atPage = page => until(() => js(`document.querySelector('.page-status')?.textContent.startsWith('第 ${page} 页') && document.querySelector('.page-input')?.value==='${page}'`), `reach page ${page}`)
  const submit = () => js("document.querySelector('.page-jump-submit').click()")
  const jump = async (page, enter = false) => {
    await input('.page-input', String(page))
    if (enter) {
      // Native form submission needs a focused renderer and the Enter char event.
      window.focus(); window.webContents.focus()
      await js("document.querySelector('.page-input').focus()")
      await window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' })
      await window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      await window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' })
    } else await submit()
    await atPage(page)
  }
  const search = async value => {
    await input('.search-box input', value)
    await js("document.querySelector('.search-submit').click()")
    await until(() => js("!document.querySelector('.statusbar')?.textContent.includes('正在执行')"), 'filter finishes')
  }
  await js('void (window.__paginationConfirm = window.confirm)')
  try {
    await open('pagination_test')
    assert.equal(await js("document.querySelector('.page-status').textContent"), '第 1 页／共 3 页')
    assert.equal(await js("document.querySelector('.page-prev').disabled"), true)
    assert.equal(await js("document.querySelector('.page-first').disabled"), true)
    assert.equal(await js("document.querySelector('.page-last').disabled"), false)
    await js("document.querySelector('.page-last').click()")
    await atPage(3)
    assert.equal(await firstId(), '201')
    assert.equal(await js("document.querySelector('.page-last').disabled"), true)
    assert.equal(await js("document.querySelector('.page-first').disabled"), false)
    await js("document.querySelector('.page-first').click()")
    await atPage(1)
    assert.equal(await firstId(), '1')
    await js("document.querySelector('th:nth-child(3) .column-resize-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))")
    const savedWidth = await js("document.querySelector('th:nth-child(3)').dataset.columnWidth")
    const beforeTyping = calls.length
    await input('.page-input', '3')
    assert.equal(calls.length, beforeTyping, 'typing must not query')
    await submit(); await atPage(3)
    assert.equal(await firstId(), '201')
    assert.equal(await js("document.querySelector('th:nth-child(3)').dataset.columnWidth"), savedWidth)
    assert.equal(await js("document.querySelector('.page-next').disabled"), true, 'exactly 300 rows end on page 3')
    await jump(1, true)
    const beforeInvalid = calls.length
    for (const value of ['', '0', '-1', '1.5', '1e2', '4', 'abc', '99999999999999999999']) {
      await input('.page-input', value); await submit()
      assert.equal(await js("document.querySelector('.page-input').getAttribute('aria-invalid')"), 'true')
      assert.match(await js("document.querySelector('.page-error').textContent"), /1–3/)
    }
    assert.equal(calls.length, beforeInvalid, 'invalid pages never query')
    await jump(1)
    assert.equal(calls.length, beforeInvalid, 'current page never queries')
    await js("Array.from(document.querySelectorAll('.grid-header-label')).find(button=>button.title==='id').click()")
    await until(() => js("document.querySelector('th[aria-sort=ascending]')?.textContent.includes('id')"), 'ascending sort applies')
    await js("Array.from(document.querySelectorAll('.grid-header-label')).find(button=>button.title==='id').click()")
    await until(async () => await firstId() === '300', 'descending sort applies')
    await search('keep')
    assert.equal(await firstId(), '205')
    await js("document.querySelector('.page-last').click()")
    await atPage(3)
    assert.equal(await firstId(), '5')
    assert.equal(await js("document.querySelectorAll('.table-wrap tbody tr').length"), 5)
    assert.equal(calls.at(-1).filter, 'keep')
    assert.equal(calls.at(-1).orderBy, 'id')
    assert.equal(calls.at(-1).direction, 'desc')
    assert.equal(calls.at(-1).database, database)

    await input('.table-wrap tbody tr td:nth-child(3) input', 'pending-page-edit')
    await until(() => js("!!document.querySelector('.toolbar-btn.primary')"), 'staged edit exists')
    await js("void (window.confirm=message=>{window.__paginationMessage=message;return false})")
    const beforeCancel = calls.length
    await js("document.querySelector('.page-first').click()")
    assert.equal(calls.length, beforeCancel)
    assert.match(await js('window.__paginationMessage'), /未提交修改/)
    assert.equal(await firstId(), '5')
    assert.equal(await js("document.querySelector('.table-wrap tbody tr td:nth-child(3) input').value"), 'pending-page-edit')
    await js('void (window.confirm=()=>true)')
    await js("document.querySelector('.page-first').click()")
    await atPage(1)
    assert.equal(await js("!!document.querySelector('.toolbar-btn.primary')"), false)
    await input('.table-wrap tbody tr td:nth-child(3) input', 'pending-last-page-edit')
    await js('void (window.confirm=()=>false)')
    const beforeLastCancel = calls.length
    await js("document.querySelector('.page-last').click()")
    assert.equal(calls.length, beforeLastCancel)
    assert.equal(await firstId(), '205')
    assert.equal(await js("document.querySelector('.table-wrap tbody tr td:nth-child(3) input').value"), 'pending-last-page-edit')
    await js('void (window.confirm=()=>true)')
    await js("document.querySelector('.page-last').click()")
    await atPage(3)
    assert.equal(await js("!!document.querySelector('.toolbar-btn.primary')"), false)
    await js("document.querySelector('.page-first').click()")
    await atPage(1)
    await input('.table-wrap tbody tr td:nth-child(3) input', 'keep-committed')
    const originalApply = ipcMain._invokeHandlers.get('db:apply')
    let releaseApply, applyHeld = false
    ipcMain.removeHandler('db:apply')
    ipcMain.handle('db:apply', async (...args) => {
      const result = await originalApply(...args)
      await new Promise(resolve => { releaseApply = resolve; applyHeld = true })
      return result
    })
    try {
      await js("document.querySelector('.toolbar-btn.primary').click()")
      await until(() => applyHeld, 'commit response held')
      assert.equal(await js("document.querySelector('.page-input').disabled && document.querySelector('.page-jump-submit').disabled && document.querySelector('.page-first').disabled && document.querySelector('.page-last').disabled"), true)
      const beforeBusySubmit = calls.length
      await js("document.querySelector('.page-jump').requestSubmit()")
      assert.equal(calls.length, beforeBusySubmit, 'busy form cannot query')
      releaseApply(); releaseApply = null
      await until(() => js("!document.querySelector('.toolbar-btn.primary') && !document.querySelector('.page-input').disabled && !document.querySelector('.statusbar')?.textContent.includes('正在执行')"), 'commit finishes')
    } finally {
      releaseApply?.()
      ipcMain.removeHandler('db:apply'); ipcMain.handle('db:apply', originalApply)
    }
    await jump(2)
    const tableTab = await js("document.querySelector('.tab.active').dataset.tabId")
    await input('.page-input', '99')
    await open('pagination_empty')
    assert.equal(await js("document.querySelector('.page-status').textContent"), '第 1 页／共 1 页')
    assert.equal(await js("Array.from(document.querySelectorAll('.table-pagination .page-btn')).every(button=>button.disabled)"), true)
    await js(`Array.from(document.querySelectorAll('.tab')).find(tab=>tab.dataset.tabId===${JSON.stringify(tableTab)}).click()`)
    await atPage(2)
    assert.equal(await firstId(), '105')
    assert.equal(await js("document.querySelector('th:nth-child(3)').dataset.columnWidth"), savedWidth)

    failNext = true
    await input('.page-input', '3'); await submit()
    await until(() => js("document.querySelector('.toast.error')?.textContent.includes('pagination test query failure')"), 'query failure is visible')
    assert.equal(await firstId(), '105')
    assert.equal(await js("document.querySelector('.page-status').textContent"), '第 2 页／共 3 页')
    await submit(); await atPage(3)
    assert.equal(await firstId(), '5')

    holdNext = true
    await input('.page-input', '1'); await submit()
    await until(() => heldReady, 'older page response held')
    await jump(2)
    releaseHeld(); releaseHeld = null
    // A main-process round trip lets the held response cross IPC before asserting.
    await js('window.sqlConnect.settings.load()')
    assert.equal(await firstId(), '105')
    assert.equal(await js("document.querySelector('.page-status').textContent"), '第 2 页／共 3 页')

    await open('pagination_view')
    await js("document.querySelector('.page-last').click()")
    await atPage(3)
    assert.equal(await js("document.querySelector('.page-next').disabled"), true)
    assert.equal(await js("document.querySelectorAll('.table-wrap tbody tr').length"), 100)
    await search('no-pagination-matches')
    assert.equal(await js("document.querySelector('.page-status').textContent"), '第 1 页／共 1 页')
    await search('')

    // Shrink the available workspace without violating BrowserWindow's minimum size.
    await js("document.querySelector('.sidebar').style.width='680px'; document.querySelector('.sidebar').style.flex='none'")
    for (let i = 0; i < 2; i++) {
      await js("document.querySelector('.top-actions button[title=切换主题]').click()")
      const layout = await js(`(() => { const p=document.querySelector('.table-pagination'),r=p.getBoundingClientRect(); return {wrapped:getComputedStyle(p).flexWrap,overflow:p.scrollWidth>p.clientWidth,inside:Array.from(p.querySelectorAll('button,input')).every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1}),inputColor:getComputedStyle(p.querySelector('input')).color,theme:document.documentElement.dataset.theme} })()`)
      assert.equal(layout.wrapped, 'wrap')
      assert.equal(layout.overflow, false)
      assert.equal(layout.inside, true, JSON.stringify(layout))
      assert.ok(layout.inputColor)
    }
    await js("document.querySelector('.sidebar').style.width=''; document.querySelector('.sidebar').style.flex=''")
    console.log(`PASS: ${database ? 'MySQL' : 'SQLite'} first/last page buttons and page jump validate bounds, preserve sort/filter and tab state, confirms edits, retries failures, ignores stale responses, and handles empty/exact-full pages in both themes`)
  } finally {
    releaseHeld?.()
    ipcMain.removeHandler('db:query'); ipcMain.handle('db:query', originalQuery)
    await js("window.confirm=window.__paginationConfirm; document.querySelector('.sidebar').style.width=''; document.querySelector('.sidebar').style.flex=''")
    const fixtureTabs = await js("Array.from(document.querySelectorAll('.tab')).filter(tab=>tab.textContent.includes('pagination_')).map(tab=>tab.dataset.tabId)")
    for (const id of fixtureTabs) {
      await js(`Array.from(document.querySelectorAll('.tab')).find(tab=>tab.dataset.tabId===${JSON.stringify(id)})?.querySelector(':scope > svg').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
      await until(() => js(`!Array.from(document.querySelectorAll('.tab')).some(tab=>tab.dataset.tabId===${JSON.stringify(id)})`), 'close pagination fixture tab')
    }
  }
}
module.exports = { paginationFixtures, testPagination }
