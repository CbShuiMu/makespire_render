import { Buffer } from 'node:buffer'
import { MAX_BATCH_ITEMS } from '../src/api/renderBatchContract.js'
import { validateRenderRequest } from './validate.js'

export const MAX_ACTIVE_BATCHES = 2

export function validateBatch(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH_ITEMS) {
    throw Object.assign(new Error(`Expected a JSON array of 1 to ${MAX_BATCH_ITEMS} items.`), { status: 400 })
  }
}

export function batchStream(items, render, release) {
  const encoder = new TextEncoder()
  let index = 0
  let cancelled = false
  let active
  return new ReadableStream({
    async pull(controller) {
      const current = index++
      active = renderEntry(items[current], current, render)
      const result = await active
      active = null
      if (cancelled) return
      controller.enqueue(encoder.encode(JSON.stringify(result) + '\n'))
      if (index === items.length) {
        controller.close()
        release()
      }
    },
    async cancel() {
      cancelled = true
      await active
      release()
    },
  }, { highWaterMark: 0 })
}

async function renderEntry(input, index, render) {
  let data
  try {
    data = validateRenderRequest(input)
  } catch (error) {
    return { index, status: 400, error: error.message }
  }
  try {
    const png = await render(data)
    return { index, png: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64') }
  } catch (error) {
    const status = error.status ?? 503
    return { index, status, error: error.status ? error.message : 'Image rendering is temporarily unavailable.' }
  }
}
