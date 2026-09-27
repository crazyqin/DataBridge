// Numbers a JS double cannot reproduce exactly (big integers, "1.10", "1e3") are kept as
// JSON.rawJSON values holding their source text, so they round-trip through parse/stringify
// without losing digits.

declare global {
  interface RawJSON { readonly rawJSON: string }
  interface JSON {
    rawJSON(text: string): RawJSON
    isRawJSON(value: unknown): value is RawJSON
  }
}

export type Json = null | boolean | number | string | RawJSON | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** A number when the text survives a round trip through a double, otherwise raw JSON. */
export function numberFromText(text: string): number | RawJSON {
  const value = Number(text)
  return String(value) === text ? value : JSON.rawJSON(text)
}

export function parse(text: string): Json {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === 'number' && context?.source !== undefined ? numberFromText(context.source) : value)
}

export function stringify(value: unknown): string {
  return JSON.stringify(value)
}

/** For the admin UI: numbers a browser would round are sent as strings. */
export function stringifyForBrowser(value: unknown): string {
  return JSON.stringify(value, (_key, item) => JSON.isRawJSON(item) ? item.rawJSON : item)
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !JSON.isRawJSON(value)
}

/** Canonical decimal text: "01.50" → "1.5", "1e2" → "100", "-0" → "0". */
export function canonicalDecimal(text: string): string | undefined {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,6}))?$/.exec(text.trim())
  if (!match || (match[2] + (match[3] ?? '')) === '') return undefined
  const fraction = match[3] ?? ''
  let digits = (match[2] + fraction).replace(/^0+/, '')
  let exponent = Number(match[4] ?? 0) - fraction.length
  if (!digits) return '0'
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent++ }
  const sign = match[1] === '-' ? '-' : ''
  if (exponent > 1000 || exponent < -1000) return `${sign}${digits}e${exponent}`
  if (exponent >= 0) return sign + digits + '0'.repeat(exponent)
  const point = digits.length + exponent
  return point > 0
    ? `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
    : `${sign}0.${'0'.repeat(-point)}${digits}`
}
