import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { validateRenderRequest } from './validate.js'
import { NativePool } from './nativePool.js'
import { nativeConfig } from './nativeConfig.js'
import { ExportArchive } from './exportArchive.js'
import { batchStream, MAX_ACTIVE_BATCHES, validateBatch } from './renderBatch.js'
import { MAX_BATCH_BYTES, RENDER_BATCH_PATH, RENDER_BATCH_TYPE } from '../src/api/renderBatchContract.js'

const engine = 'godot'
const originToken = process.env.RENDER_ORIGIN_TOKEN
if (originToken !== undefined && !/^[a-f0-9]{64}$/.test(originToken)) {
  throw new Error('RENDER_ORIGIN_TOKEN must be 32 random bytes encoded as lowercase hex.')
}
const expectedAuthorization = originToken && Buffer.from(`Bearer ${originToken}`)
const concurrency = Number(process.env.RENDER_CONCURRENCY ?? 2)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid RENDER_CONCURRENCY.')
const pool = new NativePool(await nativeConfig(), { concurrency })
const cache = new Map()
const pending = new Map()
let cacheBytes = 0
const cacheLimit = 32 * 1024 * 1024
const archive = await new ExportArchive().init()
let activeBatches = 0

async function readJson(request, limit) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > limit) throw Object.assign(new Error(`Image request exceeds ${limit / (1024 * 1024)} MiB.`), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  catch (error) { throw Object.assign(error, { status: 400 }) }
}

async function renderImage(data, preview = false) {
  const key = createHash('sha256').update(JSON.stringify(data)).digest('hex')
  let png = cache.get(key)
  const cacheStatus = png ? 'HIT' : pending.has(key) ? 'COALESCED' : 'MISS'
  if (png) { cache.delete(key); cache.set(key, png) }
  else {
    let operation = pending.get(key)
    if (!operation) {
      operation = pool.render(data)
      pending.set(key, operation)
      // Remove both successful and failed in-flight work without creating an
      // unhandled rejected promise. Equal concurrent exports share one job.
      operation.then(() => pending.delete(key), () => pending.delete(key))
    }
    png = await operation
    // Concurrent equal requests may finish together. Account for replacement once.
    cacheBytes -= cache.get(key)?.length ?? 0
    cache.set(key, png)
    cacheBytes += png.length
    while (cacheBytes > cacheLimit) {
      const oldest = cache.keys().next().value
      cacheBytes -= cache.get(oldest).length
      cache.delete(oldest)
    }
  }
  let archiveId
  if (!preview) {
    archiveId = randomUUID()
    try {
      await archive.save(archiveId, data.object, png)
    } catch (error) {
      console.error('Image archive failed:', error.message)
      throw Object.assign(new Error('Image archive is temporarily unavailable.'), { status: 503 })
    }
  }
  return { png, cacheStatus, archiveId }
}

const server = createServer(async (request, response) => {
  try {
    if (expectedAuthorization) {
      const actual = Buffer.from(request.headers.authorization ?? '')
      if (actual.length !== expectedAuthorization.length || !timingSafeEqual(actual, expectedAuthorization)) {
        response.writeHead(401, { 'Cache-Control': 'no-store' }).end()
        return
      }
    }
    if (request.url === '/healthz' && request.method === 'GET') {
      const ready = pool.workers.every(worker => worker.child && worker.initialized)
      response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: ready ? 'ok' : 'recovering', engine, workers: concurrency }))
      return
    }
    const batch = request.url === RENDER_BATCH_PATH
    if (!batch && request.url !== '/api/v1/render-image') { response.writeHead(404).end(); return }
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      response.writeHead(415).end(); return
    }
    const preview = request.headers['x-render-preview'] === '1'
    if (batch) {
      if (preview) throw Object.assign(new Error('Batch rendering only supports exports.'), { status: 400 })
      if (activeBatches >= MAX_ACTIVE_BATCHES) throw Object.assign(new Error('The image service is busy.'), { status: 503 })
      activeBatches++
      let items
      try {
        items = await readJson(request, MAX_BATCH_BYTES)
        validateBatch(items)
      } catch (error) {
        activeBatches--
        throw error
      }
      if (response.destroyed) {
        activeBatches--
        return
      }
      const stream = Readable.fromWeb(batchStream(items, async item => (await renderImage(item)).png, () => activeBatches--))
      response.writeHead(200, { 'Content-Type': RENDER_BATCH_TYPE, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      response.once('close', () => stream.destroy())
      stream.on('error', error => response.destroy(error))
      stream.pipe(response)
      return
    }
    const data = await readJson(request, 24 * 1024 * 1024)
    try { validateRenderRequest(data, { preview }) }
    catch (error) { throw Object.assign(error, { status: 400 }) }
    const { png, cacheStatus, archiveId } = await renderImage(data, preview)
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store',
      'X-Render-Engine': engine, 'X-Render-Cache': cacheStatus,
      ...(archiveId ? { 'X-Render-Archive-Id': archiveId } : {}),
      ...(cacheStatus !== 'HIT' && png.timing ? { 'Server-Timing': png.timing } : {}),
      ...(png.metadata && process.env.NATIVE_RENDER_DIAGNOSTICS === '1' ? { 'X-Native-Metadata': png.metadata } : {}),
    })
    response.end(png)
  } catch (error) {
    console.error('Image render failed:', error.message)
    if (!response.destroyed) response.writeHead(error.status ?? 500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error.status ? error.message : 'Image rendering failed.' }))
  }
})
// Warm workers before accepting export requests.
server.requestTimeout = 30000
try { await Promise.all(pool.workers.map(worker => pool.prepare(worker))) }
catch (error) { await pool.close(); await archive.close(); throw error }
server.listen(Number(process.env.RENDER_PORT ?? 3001), process.env.RENDER_HOST ?? '127.0.0.1', () => {
  console.log(`Image renderer listening on port ${server.address().port} (${engine}, ${concurrency} workers)`)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close()
    server.closeAllConnections()
    await pool.close()
    await archive.close()
  })
}
