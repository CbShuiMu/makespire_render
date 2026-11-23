import { test, after } from 'node:test'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { NativePool } from '../nativePool.js'
import { nativeConfig } from '../nativeConfig.js'
import { card } from './helpers.js'

const pools = []
after(async () => { await Promise.all(pools.map(pool => pool.close())) })
async function create(options) {
  const pool = new NativePool(await nativeConfig(), { concurrency: 1, ...options })
  pools.push(pool)
  await pool.prepare(pool.workers[0])
  return pool
}

test('worker private endpoint refuses unauthenticated access and invalid methods', async () => {
  const pool = await create()
  const worker = pool.workers[0]
  assert.equal((await fetch(`${worker.origin}/render`, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(`${worker.origin}/render`, { headers: { Authorization: `Bearer ${worker.token}` } })).status, 404)
  await pool.close()
})

test('a killed native worker restarts and reproduces the original pixels', async () => {
  const pool = await create()
  const worker = pool.workers[0]
  const before = await pool.render(card)
  const pid = worker.child.pid
  const exited = once(worker.child, 'exit')
  worker.child.kill()
  await exited
  assert.equal(worker.initialized, false)
  const after = await pool.render(card)
  assert.equal(worker.initialized, true)
  assert.notEqual(worker.child.pid, pid)
  assert.deepEqual(Buffer.from(after), Buffer.from(before))
  await pool.close()
})

test('execution timeout stops the native process and next request recovers', async () => {
  const pool = await create()
  const pid = pool.workers[0].child.pid
  pool.timeout = 1
  await assert.rejects(pool.render(card), error => error.status === 504)
  assert.equal(pool.workers[0].child, null)
  pool.timeout = 30000
  const png = await pool.render(card)
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.notEqual(pool.workers[0].child.pid, pid)
  await pool.close()
})

test('queue overflow, queue timeout and shutdown settle pending work', async () => {
  const pool = await create({ maxQueue: 1 })
  const first = pool.render(card)
  const second = pool.render({ ...card, title: 'queued' })
  await assert.rejects(pool.render({ ...card, title: 'overflow' }), error => error.status === 503)
  await Promise.all([first, second])
  // Occupy the only slot to exercise the bounded waiting deadline separately.
  pool.workers[0].busy = true
  pool.timeout = 10
  await assert.rejects(pool.render(card), error => error.status === 503 && /queue timed out/.test(error.message))
  assert.equal(pool.queue.length, 0)
  pool.timeout = 30000
  const waiting = pool.render(card)
  const settled = assert.rejects(waiting, /shutting down/)
  await pool.close()
  await settled
  assert.equal(pool.workers[0].child, null)
  await assert.rejects(pool.render(card), /shutting down/)
})

test('startup failure rejects promptly without leaving a worker', async () => {
  const config = { ...await nativeConfig(), godotExecutable: 'Z:/nonexistent/native-renderer.exe' }
  const pool = new NativePool(config, { concurrency: 1, startupTimeout: 3000 })
  pools.push(pool)
  await assert.rejects(pool.prepare(pool.workers[0]))
  await pool.close()
})
