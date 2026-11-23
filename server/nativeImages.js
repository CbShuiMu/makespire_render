import sharp from 'sharp'

const imageError = message => Object.assign(new Error(message), { status: 400 })

export async function normalizeImages(data) {
  const normalized = structuredClone(data)
  const style = normalized.style
  if (!style) return normalized
  for (const asset of [style.thumbnail, style.cardPoolCustomAsset, style.energy?.customAsset]) {
    if (!asset) continue
    const bytes = Buffer.from(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1), 'base64')
    // SVG is rasterized by librsvg without scripts/network. Reject all linked
    // resources, DTDs and CSS URLs before handing it to an image decoder.
    if (asset.dataUrl.startsWith('data:image/svg+xml') || /<svg|<\?xml|<!DOCTYPE|<!ENTITY/i.test(bytes.toString('utf8'))) {
      const svg = bytes.toString('utf8')
      if (/<!DOCTYPE|<!ENTITY|<script|<foreignObject|\b(?:href|src)\s*=|url\s*\(|@import/i.test(svg))
        throw imageError('SVG must be self-contained and contain no linked resources.')
    }
    try {
      const image = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, animated: false, failOn: 'error' })
      const info = await image.metadata()
      if (!info.width || !info.height || info.width > 16384 || info.height > 16384)
        throw new Error('Invalid image dimensions.')
      // Export sizes are fixed. Bound GPU memory while preserving aspect ratio.
      const png = await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .toColourspace('srgb').png().toBuffer()
      asset.dataUrl = `data:image/png;base64,${png.toString('base64')}`
    } catch {
      throw imageError('Invalid image, or image exceeds 16 megapixels.')
    }
  }
  return normalized
}

export async function encodePixels(response, kind) {
  const width = Number(response.headers.get('x-image-width'))
  const height = Number(response.headers.get('x-image-height'))
  const expected = kind === 'card' ? [648, 856] : [1040, 1296]
  if (width !== expected[0] || height !== expected[1]) throw new Error('Invalid native image dimensions.')
  const pixels = Buffer.from(await response.arrayBuffer())
  if (pixels.length !== width * height * 4) throw new Error('Incomplete native image.')
  // PNG encoding in Godot was the largest benchmark cost. Preserve its exact
  // RGBA pixels and encode losslessly in libvips outside the game render thread.
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer()
}
