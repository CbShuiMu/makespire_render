import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function startService() {
  const archiveDirectory = await mkdtemp(join(tmpdir(), 'makespire-native-test-'))
  const child = spawn(process.execPath, ['server/index.js'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, EXPORT_ARCHIVE_DIR: archiveDirectory, RENDER_PORT: '0', RENDER_CONCURRENCY: '2', NATIVE_RENDER_DIAGNOSTICS: '1' } })
  let log = ''
  let origin
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Native service startup timeout: ${log}`)), 120000)
      child.stderr.on('data', data => { log = (log + data).slice(-12000) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Native service exited ${code}: ${log}`)) })
      child.stdout.on('data', data => {
        log += data
        const match = log.match(/listening on port (\d+)/)
        if (match) { clearTimeout(timer); origin = `http://127.0.0.1:${match[1]}`; resolve() }
      })
    })
  } catch (error) { child.kill(); throw error }
  return { origin, async close() {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
    // Native workers observe their parent exiting, even on forced Windows exits.
    await delay(1800)
    await rm(archiveDirectory, { recursive: true, force: true })
  } }
}

export async function request(origin, data) {
  return fetch(`${origin}/api/v1/render-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(60000) })
}

export async function render(origin, data) {
  const response = await request(origin, data)
  assert.equal(response.status, 200, `${data.title || data.name}: ${response.ok ? '' : await response.text()}`)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('x-render-engine'), 'godot')
  const png = Buffer.from(await response.arrayBuffer())
  const { data: pixels, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.deepEqual([info.width, info.height], data.object === 'card' ? [648, 856] : [1040, 1296])
  assert.equal(pixels[3], 0, 'Transparent corner')
  assert.ok(pixels.some((value, index) => index % 4 === 3 && value === 255), 'Opaque artwork exists')
  const metadata = JSON.parse(Buffer.from(response.headers.get('x-native-metadata'), 'base64'))
  return { png, pixels, info, metadata, headers: response.headers }
}

export async function artwork(color = '#31c8dc', format = 'png') {
  // A non-square image catches accidental aspect-ratio distortion and clipping.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="480" height="320" fill="${color}"/><circle cx="240" cy="160" r="110" fill="#ffbb33"/><path d="M80 280L240 40L400 280Z" fill="#993355"/></svg>`
  if (format === 'svg+xml') return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return `data:image/${format};base64,${(await sharp(Buffer.from(svg)).toFormat(format).toBuffer()).toString('base64')}`
}

export const card = { object: 'card', title: '原生渲染', cost: '2', type: 'Attack', rarity: 'Common', cardPool: 'ironclad',
  description: '造成 [blue]8[/blue] 点伤害。\n[gold]消耗[/gold]。', language: 'zh' }
export const relic = { object: 'relic', name: '白字遗物', rarity: 'Rare', description: '获得 [blue]2[/blue] 点格挡。',
  flavor: '旅途留下的记忆。', language: 'zh' }
