const referencePattern = /<([^<>\r\n]+)>/g

export function getExtraDescriptionNames(...texts) {
  const names = texts.flatMap(text => Array.from(String(text ?? '').matchAll(referencePattern),
    match => match[1].trim()).filter(Boolean))
  return [...new Set(names)]
}

export function normalizeExtraDescriptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, description]) => typeof description === 'string'))
}

export function collectExtraDescriptions(texts, descriptions = {}) {
  return Object.fromEntries(getExtraDescriptionNames(...texts).map(name => [
    name, Object.hasOwn(descriptions, name) ? descriptions[name] : '',
  ]))
}

export function formatExtraDescriptionReferences(text) {
  return String(text ?? '').replace(referencePattern, (token, name) =>
    name.trim() ? `[gold]${name.trim()}[/gold]` : token)
}

export function splitExtraDescriptionReferences(text) {
  const segments = []
  let start = 0
  for (const match of text.matchAll(referencePattern)) {
    if (!match[1].trim()) continue
    if (match.index > start) segments.push({ text: text.slice(start, match.index) })
    segments.push({ text: match[1].trim(), reference: true })
    start = match.index + match[0].length
  }
  if (start < text.length) segments.push({ text: text.slice(start) })
  return segments
}
