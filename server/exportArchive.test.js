import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { ExportArchive } from './exportArchive.js'

test('archives exact bytes, counts each download, deduplicates concurrent retries, and persists Beijing days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'makespire-archive-'))
  let archive = await new ExportArchive(directory).init()
  try {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#42ff00' } }).png().toBuffer()
    const id = randomUUID()
    const beforeMidnight = new Date('2026-11-18T15:59:59Z')
    const afterMidnight = new Date('2026-11-18T16:00:00Z')
    await Promise.all(Array.from({ length: 5 }, () => archive.save(id, 'card', png, beforeMidnight)))
    await archive.save(randomUUID(), 'card', png, beforeMidnight)
    await archive.save(randomUUID(), 'relic', png, afterMidnight)
    assert.deepEqual(await readFile(join(directory, 'cards', `2026-11-18_${id}.png`)), png)
    assert.equal((await readdir(join(directory, 'cards'))).length, 2)
    await assert.rejects(archive.save(id, 'relic', png), { status: 409 })
    await assert.rejects(archive.save('../../escape', 'card', png), { status: 400 })
    await assert.rejects(archive.save(randomUUID(), 'card', Buffer.from('not png')), { status: 400 })
    await archive.close()
    archive = await new ExportArchive(directory).init()
    await archive.save(id, 'card', png, afterMidnight)
    const csv = await readFile(join(directory, 'daily-exports.csv'), 'utf8')
    assert.ok(csv.includes(`2026-11-18,2,${png.length * 2},0,0,2,${png.length * 2}`))
    assert.ok(csv.includes(`2026-11-19,0,0,1,${png.length},1,${png.length}`))
    assert.equal(archive.db.prepare('SELECT count(*) AS n FROM exports').get().n, 3)
  } finally { await archive.close(); await rm(directory, { recursive: true, force: true }) }
})
