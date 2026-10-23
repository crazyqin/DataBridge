interface Parameter { name: string; type: string }

function example(type: string): string | number | boolean {
  switch (type) {
    case 'integer': case 'decimal': return 0
    case 'boolean': return false
    case 'date': return 'YYYY-MM-DD'
    case 'datetime': return 'YYYY-MM-DDTHH:mm:ss'
    default: return ''
  }
}

/** Append missing fields without serializing existing values: JSON numbers must stay exact. */
export function completeTestParams(parameters: readonly Parameter[], current = '{}'): string | null {
  const source = current.trim() ? current : '{}'
  let values: unknown
  try { values = JSON.parse(source) } catch { return null }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) return null
  const names = new Set(Object.keys(values))
  const additions: string[] = []
  for (const parameter of parameters) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(parameter.name) || names.has(parameter.name)) continue
    additions.push(`  ${JSON.stringify(parameter.name)}: ${JSON.stringify(example(parameter.type))}`)
    names.add(parameter.name)
  }
  if (!additions.length) return source
  const end = source.lastIndexOf('}')
  return source.slice(0, end).trimEnd() + (Object.keys(values).length ? ',' : '') + '\n'
    + additions.join(',\n') + '\n}' + source.slice(end + 1)
}
