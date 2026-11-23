import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { normalizeImages, encodePixels } from './nativeImages.js'
import { formatExtraDescriptionReferences } from '../src/utils/extraDescriptions.js'

const failure = (message, status = 503) => Object.assign(new Error(message), { status })

export class NativePool {
  constructor(config, { concurrency = 2, maxQueue = 16, timeout = 30000, startupTimeout = 90000 } = {}) {
    this.config = config
    this.maxQueue = maxQueue
    this.timeout = timeout
    this.startupTimeout = startupTimeout
    this.workers = Array.from({ length: concurrency }, () => ({ busy: false, child: null, ready: null }))
    this.queue = []
    this.closed = false
  }

  prepare(worker) {
    if (this.closed) return Promise.reject(failure('Renderer is shutting down.'))
    if (worker.ready) return worker.ready
    const token = randomBytes(32).toString('hex')
    const child = spawn(this.config.godotExecutable, ['--path', this.config.project, '--position', '-20000,-20000',
      '--resolution', '16x16', '--rendering-method', 'mobile', '--rendering-driver', this.config.driver,
      '--audio-driver', 'Dummy', '--nomods'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: this.config.project,
      env: { ...process.env, STS2_GAME_DIR: this.config.gameDir, STS2_ASSEMBLY_DIR: this.config.assemblyDir,
        STS2_GAME_VERSION: this.config.gameVersion, NATIVE_RENDER_TOKEN: token, NATIVE_RENDER_PARENT_PID: String(process.pid) },
    })
    worker.child = child
    worker.initialized = false
    worker.token = token
    worker.log = ''
    worker.ready = new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        reject(failure('Native renderer startup timed out.'))
        child.kill()
      }, this.startupTimeout)
      const fail = error => { clearTimeout(timer); if (!settled) reject(error); settled = true }
      child.once('error', fail)
      child.once('exit', code => {
        const error = failure(`Native renderer exited (${code}).`)
        error.cause = new Error(worker.log.slice(-3000))
        fail(error)
        if (worker.child === child) { worker.child = null; worker.ready = null; worker.initialized = false }
      })
      let lines = ''
      child.stderr.on('data', chunk => {
        worker.log = (worker.log + chunk).slice(-12000)
        if (process.env.NATIVE_RENDER_LOG === '1') process.stderr.write(chunk)
      })
      child.stdout.on('data', chunk => {
        worker.log = (worker.log + chunk).slice(-12000)
        if (process.env.NATIVE_RENDER_LOG === '1') process.stderr.write(chunk)
        lines += chunk
        let end
        while ((end = lines.indexOf('\n')) !== -1) {
          const line = lines.slice(0, end).trim(); lines = lines.slice(end + 1)
          if (!line.startsWith('NATIVE_RENDER_READY ')) continue
          try {
            const info = JSON.parse(line.slice('NATIVE_RENDER_READY '.length))
            if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new Error('Invalid native port.')
            worker.origin = `http://127.0.0.1:${info.port}`
            worker.info = info
            worker.initialized = true
            settled = true
            clearTimeout(timer)
            resolve()
          } catch (error) { fail(error); child.kill() }
        }
        if (lines.length > 16000) lines = lines.slice(-16000)
      })
    })
    return worker.ready
  }

  render(data) {
    if (this.closed) return Promise.reject(failure('Renderer is shutting down.'))
    if (this.queue.length >= this.maxQueue && this.workers.every(worker => worker.busy))
      return Promise.reject(failure('Render queue is full.'))
    return new Promise((resolve, reject) => {
      const job = { data, resolve, reject }
      job.timer = setTimeout(() => {
        const index = this.queue.indexOf(job)
        if (index >= 0) { this.queue.splice(index, 1); reject(failure('Render queue timed out.')) }
      }, this.timeout)
      this.queue.push(job)
      this.drain()
    })
  }

  drain() {
    for (const worker of this.workers) {
      if (this.closed || worker.busy || !this.queue.length) continue
      const job = this.queue.shift()
      clearTimeout(job.timer)
      worker.busy = true
      worker.operation = this.run(worker, job).finally(() => { worker.busy = false; this.drain() })
    }
  }

  async run(worker, job) {
    const controller = new AbortController()
    worker.controller = controller
    let timer
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure('Rendering timed out.', 504)) }, this.timeout)
    })
    try {
      const operation = async () => {
        const data = await normalizeImages(job.data)
        for (const field of ['description', 'upgradedDescription', 'flavor']) {
          if (typeof data[field] === 'string') data[field] = formatExtraDescriptionReferences(data[field])
        }
        controller.signal.throwIfAborted()
        await this.prepare(worker)
        controller.signal.throwIfAborted()
        const start = performance.now()
        const body = JSON.stringify(data)
        const response = await fetch(`${worker.origin}/render`, { method: 'POST',
          headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          body, signal: controller.signal })
        if (response.status === 422) throw failure('Text does not fit the native layout. Shorten the text.', 422)
        if (!response.ok) throw new Error(`Native rendering failed (${response.status}).`)
        const png = await encodePixels(response, data.object)
        controller.signal.throwIfAborted()
        // Buffers retain metadata for the API without changing its PNG contract.
        png.timing = `${response.headers.get('server-timing')}, pipeline;dur=${(performance.now() - start).toFixed(2)}`
        png.metadata = response.headers.get('x-native-metadata')
        return png
      }
      job.resolve(await Promise.race([operation(), timedOut]))
    } catch (error) {
      const resultError = controller.signal.aborted && !this.closed ? failure('Rendering timed out.', 504) : error
      // A validation failure never touched Godot; keep its warmed scene cache.
      if (![400, 422].includes(resultError.status)) await this.stopWorker(worker)
      job.reject(resultError)
    } finally { clearTimeout(timer); worker.controller = null }
  }

  async stopWorker(worker) {
    const child = worker.child
    worker.child = null
    worker.ready = null
    worker.initialized = false
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }

  async close() {
    this.closed = true
    for (const job of this.queue.splice(0)) { clearTimeout(job.timer); job.reject(failure('Renderer is shutting down.')) }
    for (const worker of this.workers) worker.controller?.abort()
    await Promise.all(this.workers.map(worker => this.stopWorker(worker)))
    await Promise.all(this.workers.map(worker => worker.operation))
  }
}
