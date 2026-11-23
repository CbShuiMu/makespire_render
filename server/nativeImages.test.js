import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { normalizeImages, encodePixels } from './nativeImages.js'
import { validateRenderRequest } from './validate.js'

test('native image normalization bounds decoded pixels and preserves input', async () => {
  const source = await sharp({ create: { width: 2200, height: 20, channels: 4, background: '#ff00ff80' } }).png().toBuffer()
  const data = { object: 'card', title: 'Asset', style: { thumbnail: { dataUrl: `data:image/png;base64,${source.toString('base64')}`, scale: .8 } } }
  const copy = structuredClone(data)
  const result = await normalizeImages(data)
  assert.deepEqual(data, copy)
  const decoded = await sharp(Buffer.from(result.style.thumbnail.dataUrl.split(',')[1], 'base64')).metadata()
  assert.equal(decoded.width, 2048)
  assert.equal(decoded.hasAlpha, true)
  const bomb = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"><rect width="20000" height="20000"/></svg>').toString('base64')
  await assert.rejects(normalizeImages({ style: { thumbnail: { dataUrl: `data:image/svg+xml;base64,${bomb}` } } }), error => error.status === 400)
})

test('SVG external links, DTDs, CSS and disguised XML are rejected', async () => {
  for (const body of ['<image href="http://localhost/private"/>', '<style>@import "file:///secret";</style>',
    '<rect fill="url(file:///private)"/>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]>', '<script>alert(1)</script>']) {
    const value = Buffer.from(' '.repeat(5000) + `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`).toString('base64')
    for (const format of ['png', 'svg+xml']) await assert.rejects(normalizeImages({ style: { thumbnail: { dataUrl: `data:image/${format};base64,${value}` } } }), error => error.status === 400)
  }
})

test('native raw pixel response validates dimensions and length, PNG is lossless', async () => {
  const headers = { 'x-image-width': '648', 'x-image-height': '856' }
  await assert.rejects(encodePixels(new Response(new Uint8Array(1), { headers }), 'card'), /Incomplete/)
  await assert.rejects(encodePixels(new Response(null, { headers }), 'relic'), /dimensions/)
  const raw = Buffer.alloc(648 * 856 * 4, 127)
  const png = await encodePixels(new Response(raw, { headers }), 'card')
  assert.deepEqual(await sharp(png).raw().toBuffer(), raw)
})

test('native additions retain strict validation of palettes, assets and text', () => {
  assert.equal(validateRenderRequest({ object: 'relic', name: 'Shop', rarity: 'Shop' }).rarity, 'Shop')
  assert.equal(validateRenderRequest({ object: 'card', title: 'Basic', rarity: 'Basic' }).rarity, 'Basic')
  for (const changes of [{ rarity: 'Shop' }, { title: 'x'.repeat(12001) }, { watermark: 'true' },
    { style: { rarityHsv: [] } }, { style: { energy: { type: '../../' } } },
    { style: { thumbnail: { dataUrl: 'data:image/png;base64,AAAA', contentCenter: { x: .5, y: -1 } } } },
    { style: { thumbnail: { dataUrl: 'data:image/png;base64,AAAA', contentCenter: { x: '0.5', y: .5 } } } },
    { style: { thumbnail: { dataUrl: 'data:image/png;base64,AAAA', contentCenter: [] } } },
    { style: { thumbnail: { dataUrl: 'data:image/png;base64,AAAA', offsetX: Infinity } } }])
    assert.throws(() => validateRenderRequest({ object: 'card', title: 'Invalid', ...changes }))
})

test('unwatermarked relic previews allow an empty name without relaxing exports', () => {
  const relic = { object: 'relic', name: '', description: 'Gain 2 Block.', flavor: 'A story.' }
  assert.equal(validateRenderRequest(relic, { preview: true }), relic)
  assert.throws(() => validateRenderRequest(relic), /title/)
  assert.throws(() => validateRenderRequest({ ...relic, watermark: true }, { preview: true }), /unwatermarked/)
  assert.throws(() => validateRenderRequest({ object: 'card', title: '', cardPool: 'ironclad' }, { preview: true }), /Ancient/)
})
