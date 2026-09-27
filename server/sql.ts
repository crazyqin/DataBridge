import { bad } from './errors.ts'

// A small PostgreSQL lexer: enough to find `:name` parameters outside strings, quoted
// identifiers, dollar quotes and comments, and to reject anything but one SELECT statement.
// Real enforcement of read-only access is the READ ONLY transaction the query runs in.

export interface ParsedSql {
  parts: (string | { param: string })[]
  names: string[]
}

const identStart = (ch: string) => /[A-Za-z_\u0080-￿]/.test(ch)
const identPart = (ch: string) => /[A-Za-z0-9_$\u0080-￿]/.test(ch)

export function parseSql(sql: string): ParsedSql {
  if (typeof sql !== 'string' || !sql.trim()) throw bad('SQL 不能为空')
  if (sql.length > 100_000) throw bad('SQL 过长')
  const parts: ParsedSql['parts'] = []
  const names: string[] = []
  let text = ''
  let bare = ''
  let ended = false
  let i = 0

  const skipQuoted = (quote: string, backslashEscapes: boolean) => {
    const start = i++
    for (; i < sql.length; i++) {
      if (backslashEscapes && sql[i] === '\\') { i++; continue }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) { i++; continue }
        i++
        return sql.slice(start, i)
      }
    }
    throw bad(quote === '"' ? 'SQL 中的引号标识符没有闭合' : 'SQL 中的字符串没有闭合')
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1] ?? ''
    if (ended && !/\s/.test(ch) && !(ch === '-' && next === '-') && !(ch === '/' && next === '*')) {
      throw bad('只允许一条 SELECT 语句')
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      text += ' '
    } else if (ch === '/' && next === '*') {
      let depth = 0
      for (; i < sql.length; i++) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i++ } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--; i++
          if (depth === 0) { i++; break }
        }
      }
      if (depth !== 0) throw bad('SQL 中的注释没有闭合')
      text += ' '
    } else if (ch === "'") {
      text += skipQuoted("'", false)
      bare += ' '
    } else if (ch === '"') {
      text += skipQuoted('"', false)
      bare += ' x '
    } else if (ch === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0]
      if (!tag) throw bad('请使用 :name 形式的参数，不要直接写 $1')
      const end = sql.indexOf(tag, i + tag.length)
      if (end < 0) throw bad('SQL 中的 $$ 字符串没有闭合')
      text += sql.slice(i, end + tag.length)
      bare += ' '
      i = end + tag.length
    } else if (identStart(ch)) {
      const start = i
      while (i < sql.length && identPart(sql[i])) i++
      const word = sql.slice(start, i)
      text += word
      bare += word
      if (/^e$/i.test(word) && sql[i] === "'") {
        text += skipQuoted("'", true)
        bare += ' '
      }
    } else if (ch === ':' && next === ':') {
      text += '::'
      bare += '::'
      i += 2
    } else if (ch === ':' && identStart(next)) {
      let end = i + 1
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end++
      const name = sql.slice(i + 1, end)
      parts.push(text, { param: name })
      if (!names.includes(name)) names.push(name)
      text = ''
      bare += ' ? '
      i = end
    } else if (ch === ';') {
      ended = true
      i++
    } else {
      text += ch
      bare += ch
      i++
    }
  }
  parts.push(text)
  if (!/^[\s(]*(select|with)\b/i.test(bare)) throw bad('只允许一条 SELECT 语句')
  return { parts, names }
}

/** Builds `$1`-style SQL; each named parameter maps to one position and gets an explicit cast. */
export function positional(parsed: ParsedSql, cast: (name: string) => string): string {
  return parsed.parts
    .map(part => typeof part === 'string' ? part : `$${parsed.names.indexOf(part.param) + 1}::${cast(part.param)}`)
    .join('')
}
