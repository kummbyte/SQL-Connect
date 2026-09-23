const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { transformSync } = require('esbuild')
const compiled = transformSync(readFileSync('src/main/db/worker-client.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
const compiledModule = { exports: {} }
new Function('require', 'module', 'exports', compiled)(require, compiledModule, compiledModule.exports)
const { WorkerClient } = compiledModule.exports

class FakeWorker extends EventEmitter {
  messages = []
  killed = false
  postMessage(message) { this.messages.push(message) }
  kill() { this.killed = true }
}
test('correlates replies and preserves database errors', async () => {
  const worker = new FakeWorker()
  const client = new WorkerClient(worker, () => {})
  const first = client.request('connect', {}, 1000)
  const second = client.request('connect', {}, 1000)
  worker.emit('message', { id: worker.messages[1].id, ok: false, error: '文件不存在' })
  worker.emit('message', { id: worker.messages[0].id, ok: true, result: { ok: true } })
  assert.deepEqual(await first, { ok: true })
  await assert.rejects(second, /文件不存在/)
  client.close()
})
test('worker crash rejects every pending request and closes only once', async () => {
  const worker = new FakeWorker()
  let closes = 0
  const client = new WorkerClient(worker, () => closes++)
  const requests = Promise.allSettled([client.request('connect', {}), client.request('schema', {})])
  worker.emit('exit', 1)
  for (const result of await requests) { assert.equal(result.status, 'rejected'); assert.match(result.reason.message, /进程已退出/) }
  await assert.rejects(client.request('schema', {}), /连接已断开/)
  client.close()
  assert.equal(closes, 1)
})
test('connection timeout rejects and kills an unresponsive worker', async () => {
  const worker = new FakeWorker()
  const client = new WorkerClient(worker, () => {})
  await assert.rejects(client.request('connect', {}, 30), /超时/)
  assert.equal(worker.killed, true)
})
test('invalid response id fails promptly rather than leaving the UI waiting', async () => {
  const worker = new FakeWorker()
  const client = new WorkerClient(worker, () => {})
  const request = client.request('connect', {})
  worker.emit('message', { id: undefined, ok: false })
  await assert.rejects(request, /无效响应/)
  assert.equal(worker.killed, true)
})
test('send failures, process errors and cancellation settle pending requests', async () => {
  for (const reason of ['send', 'error', 'cancel']) {
    const worker = new FakeWorker()
    const client = new WorkerClient(worker, () => {})
    if (reason === 'send') worker.postMessage = () => { throw new Error('closed channel') }
    const request = client.request('connect', {})
    if (reason === 'error') worker.emit('error', new Error('startup failure'))
    if (reason === 'cancel') client.close('操作已取消')
    await assert.rejects(request, /无法发送|进程发生异常|操作已取消/)
    assert.equal(worker.killed, true)
  }
})
