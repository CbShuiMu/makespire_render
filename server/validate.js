export function validateRenderRequest(data, { preview = false } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object.')
  if (!['card', 'relic'].includes(data.object)) throw new Error('object must be card or relic.')
  const title = data.object === 'card' ? data.title : data.name
  if (preview && (data.watermark || (data.object !== 'relic' &&
    data.cardPool !== 'ancient' && data.rarity !== 'Ancient'))) {
    throw new Error('Preview requires an unwatermarked relic or Ancient card.')
  }
  if (typeof title !== 'string' || (!preview && !title.trim())) throw new Error('A title is required.')
  for (const key of ['title', 'name', 'typeText', 'description', 'upgradedDescription', 'flavor', 'cost', 'upgradedCost', 'starEnergyCost']) {
    if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 12000)) {
      throw new Error(`Invalid ${key}. Expected text up to 12000 characters.`)
    }
  }
  for (const key of ['watermark', 'upgraded', 'starEnergyEnabled']) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new Error(`Invalid ${key}.`)
  }
  const enums = {
    language: ['zh', 'en'], type: ['Attack', 'Skill', 'Power'],
    rarity: data.object === 'card' ? ['Basic', 'Common', 'Uncommon', 'Rare', 'Ancient', 'Curse', 'Event', 'Quest', 'Status']
      : ['Starter', 'Common', 'Uncommon', 'Rare', 'Shop', 'Ancient', 'Curse', 'Event', 'Quest', 'Status'],
    cardPool: ['ironclad', 'silent', 'regent', 'necrobinder', 'defect', 'fool', 'colorless', 'ancient', 'status', 'curse', 'quest', 'custom'],
  }
  for (const [key, allowed] of Object.entries(enums)) {
    if (data[key] !== undefined && !allowed.includes(data[key])) throw new Error(`Invalid ${key}.`)
  }
  const style = data.style ?? {}
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new Error('Invalid style.')
  for (const key of ['rarityHsv', 'borderHsv']) {
    const hsv = style[key]
    if (hsv != null && (typeof hsv !== 'object' || Array.isArray(hsv) || !['h', 's', 'v'].every(channel => Number.isFinite(hsv[channel]) && Math.abs(hsv[channel]) <= 100))) {
      throw new Error(`Invalid ${key}.`)
    }
  }
  if (style.energy != null && (typeof style.energy !== 'object' ||
    ![...enums.cardPool, 'none'].includes(style.energy.type))) throw new Error('Invalid energy type.')
  for (const asset of [style.thumbnail, style.cardPoolCustomAsset, style.energy?.customAsset]) {
    if (asset == null) continue
    if (typeof asset !== 'object' || Array.isArray(asset) || typeof asset.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif|avif|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/.test(asset.dataUrl)) {
      throw new Error('Images must be base64 image data URLs.')
    }
    for (const key of ['scale', 'offsetX', 'offsetY']) {
      if (asset[key] !== undefined && (!Number.isFinite(asset[key]) || Math.abs(asset[key]) > 10000)) {
        throw new Error(`Invalid image ${key}.`)
      }
    }
    if (asset.contentCenter != null && (typeof asset.contentCenter !== 'object' || Array.isArray(asset.contentCenter) ||
      !['x', 'y'].every(key => Number.isFinite(asset.contentCenter[key]) &&
        asset.contentCenter[key] >= 0 && asset.contentCenter[key] <= 1))) {
      throw new Error('Invalid image contentCenter.')
    }
  }
  return data
}
