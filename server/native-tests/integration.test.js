import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { startService, request, render, artwork, card, relic } from './helpers.js'
import { relicRarityColorByRarity } from '../../src/utils/relicVisuals.js'

let service, origin, art
const output = new URL('../../native-verification.local/', import.meta.url)
before(async () => {
  service = await startService(); origin = service.origin
  art = await artwork()
  await mkdir(output, { recursive: true })
}, { timeout: 130000 })
after(async () => { await service?.close() })
const fresh = data => ({ ...data, testNonce: crypto.randomUUID() })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

test('editor JSON renders directly with gold references and embedded images', async () => {
  const thumbnail = { dataUrl: art, fileName: 'art.png', mimeType: 'image/png', offsetX: 0 }
  const entries = [
    {
      input: { object: 'card', title: '余烬之刃', type: 'Attack', typeText: '攻击', cost: '1', upgradedCost: '2',
        rarity: 'Common', cardPool: 'ironclad', description: '获得 <格挡>。', upgradedDescription: '获得 2 点 <格挡>。',
        starEnergyEnabled: false, starEnergyCost: '', extraDescriptions: { 格挡: '抵挡伤害。' },
        style: { thumbnail: { ...thumbnail, scale: .81, offsetY: 0 }, energy: { type: 'ironclad', customAsset: null }, cardPoolCustomAsset: null } },
      formatted: { description: '获得 [gold]格挡[/gold]。', upgradedDescription: '获得 2 点 [gold]格挡[/gold]。' },
    },
    {
      input: { object: 'relic', name: '余烬护符', typeText: '稀有遗物', rarity: 'Rare', description: '获得 <格挡>。',
        flavor: '守护 <旅人>。', extraDescriptions: { 格挡: '抵挡伤害。', 旅人: '' },
        style: { thumbnail: { ...thumbnail, scale: .8, offsetY: 35 } } },
      formatted: { description: '获得 [gold]格挡[/gold]。', flavor: '守护 [gold]旅人[/gold]。' },
    },
  ]
  for (const { input, formatted } of entries) {
    assert.deepEqual((await render(origin, input)).png, (await render(origin, { ...input, ...formatted })).png)
    if (input.object === 'card') {
      assert.deepEqual((await render(origin, { ...input, upgraded: true })).png,
        (await render(origin, { ...input, ...formatted, upgraded: true })).png)
    }
  }
})

test('editor relic presets reproduce game defaults and ancient banners remain untinted', async () => {
  for (const [rarity, rarityHsv] of Object.entries(relicRarityColorByRarity)) {
    const input = { ...relic, rarity }
    const native = await render(origin, input)
    const editor = await render(origin, { ...input, style: { rarityHsv } })
    assert.deepEqual(editor.pixels, native.pixels, `${rarity}: editor preset must match SetRarityVisuals`)
  }
  const input = { ...card, rarity: 'Ancient' }
  const first = await render(origin, { ...input, style: { rarityHsv: { h: 0, s: .2, v: .9 } } })
  const second = await render(origin, { ...input, style: { rarityHsv: { h: .5, s: 2, v: .5 } } })
  assert.deepEqual(first.pixels.subarray(0, 200 * 648 * 4), second.pixels.subarray(0, 200 * 648 * 4),
    'Special ancient banner and flame ignore the ordinary banner HSV')
  assert.notDeepEqual(first.pixels, second.pixels, 'HSV still affects the type plaque')
})

test('relic text previews and clean exports produce identical pixels', async () => {
  for (const input of [
    { ...relic, name: '余烬护符', typeText: '稀有遗物', flavor: '火光映在旧护符上。' },
    { ...relic, name: 'Bitter Memory', typeText: 'Event Relic', language: 'en',
      description: 'Gain [blue]2[/blue] Block.\n[b]Remember[/b] *star_energy*.', flavor: '[center]A quiet [red]ember[/red].[/center]' },
    { ...relic, name: '', typeText: '', description: '', flavor: '' },
  ]) {
    const preview = await fetch(`${origin}/api/v1/render-image`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Render-Preview': '1' }, body: JSON.stringify(input) })
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('x-render-engine'), 'godot')
    const png = Buffer.from(await preview.arrayBuffer())
    if (input.name) assert.deepEqual(png, (await render(origin, input)).png)
    else assert.equal((await request(origin, input)).status, 400)
  }
})

function greenArtworkBounds({ pixels, info }) {
  let left = info.width, right = -1, top = info.height, bottom = -1
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] >= 25 || pixels[i + 1] <= 220 || pixels[i + 2] >= 25 || pixels[i + 3] <= 240) continue
    const x = (i / 4) % info.width
    const y = Math.floor(i / 4 / info.width)
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  assert.ok(right > left && bottom > top, 'Artwork must remain visible')
  return { left, right, top, bottom }
}

test('portrait artwork matches the card editor zoom and pan', async () => {
  const svg = '<svg width="320" height="480"><rect x="96" y="220" width="64" height="40" fill="#00ff00"/></svg>'
  const dataUrl = `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`
  for (const placement of [{ scale: .81, offsetX: 0, offsetY: 0 }, { scale: .62, offsetX: 37, offsetY: -24 }]) {
    const result = await render(origin, fresh({ ...card, style: { thumbnail: { dataUrl, ...placement } } }))
    const { left, right, top, bottom } = greenArtworkBounds(result)
    // The portrait fits the editor's 260 × 364 box by height and the PNG is 2×.
    const fit = (364 / 480) * placement.scale * 2
    const expectedX = 324 + (-260 * .0037 + placement.offsetX) * 2 - 32 * fit
    const expectedY = 428 + (-364 * .17 + placement.offsetY) * 2
    assert.ok(Math.abs(right - left + 1 - 64 * fit) < 2, 'Artwork width matches the editor')
    assert.ok(Math.abs(bottom - top + 1 - 40 * fit) < 2, 'Artwork height matches the editor')
    assert.ok(Math.abs((left + right + 1) / 2 - expectedX) < 2, 'Artwork X center matches the editor')
    assert.ok(Math.abs((top + bottom + 1) / 2 - expectedY) < 2, 'Artwork Y center matches the editor')
  }
})

test('relic artwork stays centered through padding, zoom and editor pan', async () => {
  for (const [width, height, center] of [
    [200, 200, { x: .5, y: .5 }],
    [128, 256, { x: .25, y: .25 }],
    [256, 128, { x: .75, y: .25 }],
  ]) {
    const svg = `<svg width="${width}" height="${height}"><rect x="${width * center.x - 16}" y="${height * center.y - 16}" width="32" height="32" fill="#00ff00"/></svg>`
    const dataUrl = `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`
    for (const placement of [{}, { scale: .8, offsetX: 0, offsetY: 0 }, { scale: 1.2, offsetX: 24, offsetY: -30 }]) {
      const thumbnail = { dataUrl, contentCenter: center, ...placement }
      const result = await render(origin, fresh({ ...relic, style: { thumbnail } }))
      const frame = result.metadata.Frame
      const { left, right, top, bottom } = greenArtworkBounds(result)
      const expectedX = frame.x + frame.width / 2 + (placement.offsetX ?? 0) * 2 * .56
      const expectedY = frame.y + frame.height / 2 + (placement.offsetY ?? 0) * 2 * .56
      assert.ok(Math.abs((left + right + 1) / 2 - expectedX) < 2, 'Artwork X center matches the frame and pan')
      assert.ok(Math.abs((top + bottom + 1) / 2 - expectedY) < 2, 'Artwork Y center matches the frame and pan')
    }
  }
})

test('relic zoom and pan cannot draw outside the fixed editor window', async () => {
  const baseline = await render(origin, relic)
  const frame = baseline.metadata.Frame
  const centerX = frame.x + frame.width / 2
  const centerY = frame.y + frame.height / 2
  const halfWindow = 340 * .56 // 2x PNG, half of the window width.
  for (const [width, height, offsetX, offsetY] of [
    [200, 200, 120, -120], [200, 200, -120, 120],
    [320, 480, 0, 0], [480, 320, 80, 100],
  ]) {
    const dataUrl = `data:image/png;base64,${(await sharp({
      create: { width, height, channels: 4, background: '#00ff00' },
    }).png().toBuffer()).toString('base64')}`
    const result = await render(origin, { ...relic, style: { thumbnail: { dataUrl, scale: 2.5, offsetX, offsetY } } })
    const bounds = greenArtworkBounds(result)
    assert.ok(bounds.left >= centerX - halfWindow - 1 && bounds.right <= centerX + halfWindow + 1)
    assert.ok(bounds.top >= centerY - halfWindow - 1 && bounds.bottom <= centerY + halfWindow + 1)
    for (let y = 0; y < result.info.height; y++) for (let x = 0; x < result.info.width; x++) {
      if (Math.abs(x + .5 - centerX) <= halfWindow + 1 && Math.abs(y + .5 - centerY) <= halfWindow + 1) continue
      const i = (y * result.info.width + x) * 4
      assert.equal(result.pixels.readUInt32LE(i), baseline.pixels.readUInt32LE(i),
        `Artwork must not change pixels outside the fixed clip at ${x},${y}`)
    }
  }
})

test('native API health, routing, validation, body limit and decode recovery', async () => {
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: 'ok', engine: 'godot', workers: 2 })
  assert.equal((await fetch(`${origin}/missing`)).status, 404)
  assert.equal((await fetch(`${origin}/api/v1/render-image`)).status, 405)
  assert.equal((await fetch(`${origin}/api/v1/render-image`, { method: 'POST', body: '{}' })).status, 415)
  assert.equal((await fetch(`${origin}/api/v1/render-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400)
  for (const data of [null, [], {}, { object: 'card' }, { ...card, language: 'fr' }, { ...card, style: [] },
    { ...card, style: { thumbnail: { dataUrl: 'file:///private.png' } } }, { ...card, style: { rarityHsv: { h: 1, s: '2', v: 1 } } },
    { ...card, title: 'x'.repeat(12001) }, { ...card, style: { thumbnail: { dataUrl: 'data:image/png;base64,AAAA' } } }])
    assert.equal((await request(origin, data)).status, 400)
  assert.equal((await request(origin, { ...card, description: 'x'.repeat(25 * 1024 * 1024) })).status, 413)
  await render(origin, fresh(card))
})

test('native Chinese/English fonts, white flavor, explicit red and watermark', async () => {
  for (const language of ['zh', 'en']) {
    const data = { ...relic, language, name: language === 'zh' ? relic.name : 'Native Relic',
      flavor: language === 'zh' ? relic.flavor : 'A memory of the journey.', style: { thumbnail: { dataUrl: art } } }
    const normal = await render(origin, fresh(data))
    const red = await render(origin, fresh({ ...data, flavor: `[red]${data.flavor}[/red]` }))
    assert.equal(normal.metadata.FlavorText.color, 'fff6e3ff')
    assert.match(normal.metadata.FlavorText.font, language === 'zh' ? /noto_sans_mono/ : /bitter_medium_italic/)
    assert.match(normal.metadata.RelicName.font, language === 'zh' ? /noto_sans_mono/ : /kreon_bold/)
    assert.deepEqual(normal.pixels.subarray(0, 900 * 1040 * 4), red.pixels.subarray(0, 900 * 1040 * 4), 'Color tag only affects flavor')
    assert.notDeepEqual(normal.pixels, red.pixels)
    const marked = await render(origin, fresh({ ...data, watermark: true }))
    assert.deepEqual(normal.pixels.subarray(0, 1200 * 1040 * 4), marked.pixels.subarray(0, 1200 * 1040 * 4))
    assert.notDeepEqual(normal.pixels, marked.pixels)
    await writeFile(new URL(`relic-${language}.png`, output), normal.png)
    const c = await render(origin, fresh({ ...card, language, style: { thumbnail: { dataUrl: art } } }))
    assert.match(c.metadata.TitleLabel.family, language === 'zh' ? /Noto Sans Mono/i : /Kreon/i)
    assert.match(c.metadata.DescriptionLabel.font, language === 'zh' ? /noto_sans_mono/ : /kreon/)
    await writeFile(new URL(`card-${language}.png`, output), c.png)
  }
})

test('all 12 pools × 3 card types, all rarities and all relic palettes render', async () => {
  const pools = ['ironclad', 'silent', 'regent', 'necrobinder', 'defect', 'fool', 'colorless', 'ancient', 'status', 'curse', 'quest', 'custom']
  const hashes = new Set()
  for (const cardPool of pools) for (const type of ['Attack', 'Skill', 'Power']) {
    const result = await render(origin, fresh({ ...card, cardPool, type, rarity: cardPool === 'ancient' ? 'Ancient' : 'Rare',
      style: { thumbnail: { dataUrl: art } } }))
    hashes.add(hash(result.png))
    if (cardPool === 'ancient') {
      await writeFile(new URL(`ancient-${type}.png`, output), result.png)
      for (let y = 0; y < 856; y++)
        for (let x = 636; x < 648; x++) assert.equal(result.pixels[(y * 648 + x) * 4 + 3], 0, 'Ancient portrait must not spill into the right padding')
      if (type === 'Attack') for (const transform of [{ scale: 2, offsetX: 100, offsetY: -80 }, { scale: .3, offsetX: -100 }, { scale: -1 }, { scale: 0 }]) {
        const moved = await render(origin, fresh({ ...card, cardPool, type, rarity: 'Ancient', style: { thumbnail: { dataUrl: art, ...transform } } }))
        assert.notDeepEqual(moved.png, result.png)
        for (let y = 0; y < 856; y++) for (let x = 636; x < 648; x++)
          assert.equal(moved.pixels[(y * 648 + x) * 4 + 3], 0, 'Transformed ancient portrait stays clipped')
        if (transform.scale === 2) await writeFile(new URL('ancient-transformed.png', output), moved.png)
      }
    }
  }
  // Custom/colorless/status intentionally share native defaults, but the
  // distinct character colors and type silhouettes must not collapse.
  assert.ok(hashes.size >= 24, `${hashes.size} distinct styles`)
  for (const rarity of ['Basic', 'Common', 'Uncommon', 'Rare', 'Ancient', 'Curse', 'Event', 'Quest', 'Status'])
    await render(origin, fresh({ ...card, rarity }))
  for (const rarity of ['Starter', 'Common', 'Uncommon', 'Rare', 'Shop', 'Ancient', 'Curse', 'Event', 'Quest', 'Status'])
    await render(origin, fresh({ ...relic, rarity }))
})

test('upgrades, X/empty cost, stars, hidden energy, image transforms and HSV are applied', async () => {
  const base = { ...card, style: { thumbnail: { dataUrl: art } } }
  const normal = await render(origin, fresh(base))
  const upgraded = await render(origin, fresh({ ...base, upgraded: true, upgradedCost: '1', upgradedDescription: '获得 12 点格挡。' }))
  assert.notEqual(upgraded.metadata.TitleLabel.color, normal.metadata.TitleLabel.color)
  assert.notEqual(upgraded.metadata.EnergyLabel.color, normal.metadata.EnergyLabel.color)
  for (const change of [
    { cost: 'X' }, { cost: '' }, { starEnergyEnabled: true, starEnergyCost: 'X' },
    { typeText: '自定义卡种' }, { style: { ...base.style, energy: { type: 'none' } } },
    { style: { thumbnail: { dataUrl: art, scale: .55, offsetX: 15, offsetY: -10 } } },
    { style: { ...base.style, rarityHsv: { h: .3, s: 1.4, v: .7 }, borderHsv: { h: .6, s: .4, v: 1.2 } } },
    { cardPool: 'custom', style: { ...base.style, cardPoolCustomAsset: { dataUrl: art, scale: .9, offsetX: 4 } } },
    { style: { ...base.style, energy: { type: 'custom', customAsset: { dataUrl: art, scale: .7, offsetY: 4 } } } },
  ]) assert.notDeepEqual((await render(origin, fresh({ ...base, ...change }))).png, normal.png)
  const r = await render(origin, fresh({ ...relic, style: base.style }))
  assert.notDeepEqual((await render(origin, fresh({ ...relic, style: { thumbnail: { dataUrl: art, scale: .6, offsetX: 20, offsetY: 10 } } }))).png, r.png)
  await writeFile(new URL('card-upgraded.png', output), upgraded.png)
})

test('PNG/JPEG/WebP/GIF/AVIF/SVG uploads and custom inline icons', async () => {
  for (const format of ['png', 'jpeg', 'webp', 'gif', 'avif', 'svg+xml'])
    await render(origin, fresh({ ...card, style: { thumbnail: { dataUrl: await artwork('#0099bb', format) } } }))
  const icons = 'colorless defect fool ironclad necrobinder regent silent watcher'.split(' ').map(name => `*${name}_energy*`).join(' ')
  await render(origin, fresh({ ...card, description: `${icons}\n*star_energy*` }))
  const data = { ...card, description: '图标 *custom_energy*', style: { energy: { type: 'custom', customAsset: { dataUrl: art } } } }
  const a = await render(origin, fresh(data))
  const b = await render(origin, fresh({ ...data, style: { energy: { type: 'custom', customAsset: { dataUrl: await artwork('#ff8800') } } } }))
  const a2 = await render(origin, fresh(data))
  assert.notDeepEqual(a.png, b.png)
  assert.deepEqual(a.png, a2.png, 'Custom icon cache must not leak between jobs')
  await writeFile(new URL('card-custom-icons.png', output), a.png)
})

test('unsafe resource markup stays literal, malformed markup recovers, excessive text returns 422', async () => {
  for (const description of ['[img]file:///C:/private.png[/img]', '[font=res://secret.ttf]x[/font]',
    '[red]broken[/gold]', 'literal [bracket', '[/blue]orphan', '[gold]开头[blue]嵌套[/blue][/gold]'])
    await render(origin, fresh({ ...card, description }))
  const linked = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><image href="file:///private.png"/></svg>').toString('base64')
  for (const mime of ['svg+xml', 'png'])
    assert.equal((await request(origin, { ...card, style: { thumbnail: { dataUrl: `data:image/${mime};base64,${linked}` } } })).status, 400)
  for (const data of [{ ...card, description: '过长文字。'.repeat(1500) }, { ...relic, flavor: 'Long text. '.repeat(700) },
    { ...card, title: '过长名称'.repeat(400) }, { ...card, typeText: '过长类型'.repeat(400) },
    { ...card, cost: 'X'.repeat(200) }, { ...relic, name: 'Too long '.repeat(200) }])
    assert.equal((await request(origin, data)).status, 422)
  await render(origin, fresh(relic))
})

test('warm cache misses are deterministic across languages, objects and concurrent workers', async () => {
  const cases = [card, { ...card, language: 'en', title: 'Native Card' }, relic, { ...relic, language: 'en', name: 'Native Relic' },
    { ...card, cardPool: 'ancient', rarity: 'Ancient', style: { thumbnail: { dataUrl: art } } }]
  const baseline = []
  for (const data of cases) baseline.push((await render(origin, fresh(data))).png)
  for (let round = 0; round < 3; round++) {
    const parallel = await Promise.all(cases.map(data => render(origin, fresh(data))))
    parallel.forEach((result, i) => assert.deepEqual(result.png, baseline[i], `case ${i}, round ${round}`))
  }
})

test('LRU hits and coalescing avoid duplicate rendering without corrupting bytes', async () => {
  const data = fresh(card)
  const a = await render(origin, data)
  const b = await render(origin, data)
  assert.equal(a.headers.get('x-render-cache'), 'MISS')
  assert.equal(b.headers.get('x-render-cache'), 'HIT')
  assert.deepEqual(a.png, b.png)
  const other = fresh(relic)
  const simultaneous = await Promise.all(Array.from({ length: 6 }, () => render(origin, other)))
  assert.equal(simultaneous.filter(result => result.headers.get('x-render-cache') === 'MISS').length, 1)
  assert.ok(simultaneous.some(result => result.headers.get('x-render-cache') === 'COALESCED'))
  for (const result of simultaneous) assert.deepEqual(result.png, simultaneous[0].png)
})

test('measure 30 warm cache misses per object and retain artifacts', async () => {
  const report = { at: new Date().toISOString(), samples: 30, results: {} }
  for (const data of [card, relic]) {
    const fixture = { ...data, style: { thumbnail: { dataUrl: art } } }
    const times = []
    let first, last
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      last = fresh(fixture)
      first ??= last
      const response = await request(origin, last)
      assert.equal(response.status, 200)
      await response.arrayBuffer()
      times.push(performance.now() - start)
      assert.equal(response.headers.get('x-render-cache'), 'MISS')
    }
    const sorted = [...times].sort((a, b) => a - b)
    report.results[data.object] = { medianMs: sorted[15], p95Ms: sorted[28], samplesMs: times }
    if (data.object === 'relic') {
      assert.equal((await request(origin, last)).headers.get('x-render-cache'), 'HIT')
      // 30 textured relics exceed the 32 MiB LRU. The oldest must be evicted.
      const evicted = await request(origin, first)
      await evicted.arrayBuffer()
      assert.equal(evicted.headers.get('x-render-cache'), 'MISS')
    }
  }
  await writeFile(new URL('native-performance.json', output), JSON.stringify(report, null, 2))
  console.log('Warm native misses:', JSON.stringify(report.results, (key, value) => key === 'samplesMs' ? undefined : value))
})
