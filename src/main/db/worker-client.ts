import { randomUUID } from 'node:crypto'
import type { UtilityProcess } from 'electron'

type PendingRequest = {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** Owns one worker's requests so exits and replacement connections cannot orphan promises. */
export class WorkerClient {
  private pending = new Map<string, PendingRequest>()
  private closed = false

  constructor(private worker: UtilityProcess, private onClose: () => void) {
    worker.on('message', (message: any) => {
      if (!message || typeof message.id !== 'string' || typeof message.ok !== 'boolean') {
        this.close('数据库进程返回了无效响应，请重新连接')
        return
      }
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.ok) request.resolve(message.result)
      else request.reject(new Error(message.error || '数据库操作失败'))
    })
    worker.on('exit', code => this.finish(new Error(`数据库进程已退出（${code}），请重新连接`)))
    worker.on('error', () => this.close('数据库进程发生异常，请重新连接'))
  }

  request(type: string, payload: unknown, timeoutMs = 0): Promise<any> {
    if (this.closed) return Promise.reject(new Error('连接已断开'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const request: PendingRequest = { resolve, reject }
      this.pending.set(id, request)
      if (timeoutMs > 0) {
        request.timer = setTimeout(() => this.close('数据库连接或读取超时，请检查文件路径和访问权限后重试'), timeoutMs)
      }
      try { this.worker.postMessage({ id, type, payload }) }
      catch { this.close('无法发送数据库请求，请重新连接') }
    })
  }

  close(message = '连接已断开') {
    if (this.closed) return
    this.finish(new Error(message))
    this.worker.kill()
  }

  private finish(error: Error) {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.onClose()
  }
}
