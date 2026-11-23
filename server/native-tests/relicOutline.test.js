import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { startService, render, request, relic } from './helpers.js'

let service
before(async () => { service = await startService() }, { timeout: 130000 })
after(async () => { await service?.close() })

const pixel = (image, x, y) => Array.from(image.pixels.subarray((Math.round(y) * image.info.width + Math.round(x)) * 4,
  (Math.round(y) * image.info.width + Math.round(x)) * 4 + 4))
const green = ([r, g, b]) => r < 30 && g > 200 && b < 30
const black = ([r, g, b]) => r < 8 && g < 8 && b < 8

test('uploaded relics get a black contour without resizing their original icon box', async () => {
  await mkdir('native-verification.local/relic-outline', { recursive: true })
  for (const [kind, width, height] of [['circle', 200, 200], ['solid', 200, 200], ['portrait', 320, 480]]) {
    const shape = kind === 'circle' ? '<circle cx="100" cy="100" r="36" fill="#00ff00"/>'
      : `<rect width="${width}" height="${height}" fill="#00ff00"/>`
    const dataUrl = 'data:image/png;base64,' + (await sharp(Buffer.from(
      `<svg width="${width}" height="${height}">${shape}</svg>`,
    )).png().toBuffer()).toString('base64')
    for (const [scale, offsetX, offsetY] of [[.8, 0, 0], [.62, 37, -24], [1, 0, 0]]) {
      const input = { ...relic, name: `Outline ${kind}`, style: { thumbnail: { dataUrl, scale, offsetX, offsetY } } }
      const image = await render(service.origin, input)
      const frame = image.metadata.Frame
      const factor = frame.width / 304 * scale / .8
      const cx = frame.x + frame.width / 2 + offsetX * 1.12
      const cy = frame.y + frame.height / 2 + offsetY * 1.12
      assert.ok(Math.abs(image.metadata.RelicImage.width - 192 * factor) < .01, 'Keep the 192px game icon box')
      assert.ok(green(pixel(image, cx, cy)), 'Keep the original artwork color and center')
      const expectedBodyWidth = kind === 'circle' ? 72 * 192 / 200 * factor : 192 * width / Math.max(width, height) * factor
      let left = Math.round(cx), right = Math.round(cx)
      while (green(pixel(image, left - 1, cy))) left--
      while (green(pixel(image, right + 1, cy))) right++
      assert.ok(Math.abs(right - left + 1 - expectedBodyWidth) < 3,
        `${kind} scale=${scale}: keep artwork width ${expectedBodyWidth}, got ${right - left + 1}`)
      for (const direction of [-1, 1]) {
        const edge = direction < 0 ? left : right
        let blackPixels = 0
        for (let step = 1; step <= Math.ceil(4 * factor) + 3; step++) {
          if (black(pixel(image, edge + step * direction, cy))) blackPixels++
        }
        assert.ok(blackPixels >= Math.floor(4 * factor) - 1, `${kind}: solid black contour follows zoom`)
      }
      const preview = await fetch(`${service.origin}/api/v1/render-image`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Render-Preview': '1' }, body: JSON.stringify(input) })
      assert.equal(preview.status, 200)
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image.png, 'Native preview and export agree')
      if (scale === .8) await writeFile(`native-verification.local/relic-outline/${kind}.png`, image.png)
    }
  }
  assert.equal((await request(service.origin, { ...relic, name: 'Without artwork' })).status, 200)
  const blank = { ...relic, name: 'Transparent artwork' }
  const dataUrl = 'data:image/png;base64,' + (await sharp({ create: {
    width: 32, height: 48, channels: 4, background: '#00000000',
  } }).png().toBuffer()).toString('base64')
  assert.deepEqual((await render(service.origin, { ...blank, style: { thumbnail: { dataUrl } } })).pixels,
    (await render(service.origin, blank)).pixels, 'Transparent uploads must not draw a black rectangle')
})
