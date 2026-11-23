import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const badRequest = message => Object.assign(new Error(message), { status: 400 })
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

// One writer serializes files, durable accounting, and the human-readable summary.
export class ExportArchive {
  constructor(directory = process.env.EXPORT_ARCHIVE_DIR ?? 'D:/makespire') {
    this.directory = resolve(directory)
    this.queue = Promise.resolve()
  }

  async init() {
    for (const folder of ['cards', 'relics']) await mkdir(join(this.directory, folder), { recursive: true })
    this.db = new DatabaseSync(join(this.directory, 'exports.sqlite'))
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY, exported_at TEXT NOT NULL, day TEXT NOT NULL,
        kind TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, file TEXT NOT NULL
      )`)
    await this.writeSummary()
    return this
  }

  async writeSummary() {
    const rows = this.db.prepare(`SELECT day,
      sum(kind = 'card') AS cards, sum(CASE WHEN kind = 'card' THEN bytes ELSE 0 END) AS card_bytes,
      sum(kind = 'relic') AS relics, sum(CASE WHEN kind = 'relic' THEN bytes ELSE 0 END) AS relic_bytes,
      count(*) AS total_images, sum(bytes) AS total_bytes FROM exports GROUP BY day ORDER BY day`).all()
    const csv = 'date_beijing,cards,card_bytes,relics,relic_bytes,total_images,total_bytes\r\n' +
      rows.map(row => Object.values(row).join(',')).join('\r\n') + (rows.length ? '\r\n' : '')
    const temporary = join(this.directory, 'daily-exports.csv.tmp')
    await writeFile(temporary, '\ufeff' + csv)
    await rename(temporary, join(this.directory, 'daily-exports.csv'))
  }

  save(id, kind, png, now = new Date()) {
    const operation = this.queue.then(() => this.persist(id, kind, png, now))
    this.queue = operation.catch(() => {})
    return operation
  }

  async persist(id, kind, png, now) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id ?? '') || !['card', 'relic'].includes(kind)) {
      throw badRequest('Invalid export ID or kind.')
    }
    if (!png.subarray(0, pngSignature.length).equals(pngSignature)) throw badRequest('A rendered PNG is required.')
    const hash = createHash('sha256').update(png).digest('hex')
    const previous = this.db.prepare('SELECT * FROM exports WHERE id = ?').get(id)
    if (previous) {
      if (previous.sha256 !== hash || previous.kind !== kind) throw Object.assign(new Error('Export ID already used.'), { status: 409 })
      await this.writeSummary()
      return { id, bytes: previous.bytes, day: previous.day }
    }
    const day = dateFormat.format(now)
    const folder = kind === 'card' ? 'cards' : 'relics'
    const file = `${folder}/${day}_${id}.png`
    const path = join(this.directory, file)
    // A retry following a crash may encounter the file before its DB record.
    try {
      const existing = await readFile(path)
      if (!existing.equals(png)) throw Object.assign(new Error('Export file conflict.'), { status: 409 })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const temporary = `${path}.${randomUUID()}.tmp`
      await writeFile(temporary, png, { flag: 'wx', flush: true })
      await rename(temporary, path)
    }
    this.db.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, now.toISOString(), day, kind, png.length, hash, file)
    await this.writeSummary()
    return { id, bytes: png.length, day }
  }

  async close() { await this.queue; this.db.close() }
}
