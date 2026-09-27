import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalDecimal, parse, stringify, stringifyForBrowser } from '../server/json.ts'
import { parseSql, positional } from '../server/sql.ts'
import { convert, identity, rowKey } from '../server/values.ts'
import { userAgentAllowed } from '../server/apis.ts'

test('JSON keeps numbers a double would change', () => {
  const text = '{"big":9007199254740993,"money":1.10,"plain":2.5,"exp":1e3}'
  const value = parse(text)
  assert.equal(stringify(value), text)
  assert.equal(stringifyForBrowser(value), '{"big":"9007199254740993","money":"1.10","plain":2.5,"exp":"1e3"}')
})

test('canonical decimals', () => {
  assert.equal(canonicalDecimal('001.500'), '1.5')
  assert.equal(canonicalDecimal('-0.00'), '0')
  assert.equal(canonicalDecimal('1.2e3'), '1200')
  assert.equal(canonicalDecimal('12e-4'), '0.0012')
  assert.equal(canonicalDecimal('abc'), undefined)
})

test('field conversion is strict and canonical', () => {
  assert.equal(convert('42', 'integer', 'n'), 42)
  assert.equal(stringify(convert('9223372036854775807', 'integer', 'n')), '9223372036854775807')
  assert.throws(() => convert('9223372036854775808', 'integer', 'n'))
  assert.throws(() => convert('1.5', 'integer', 'n'))
  assert.equal(convert('1.50', 'decimal', 'n'), 1.5)
  assert.equal(convert('false', 'boolean', 'b'), false)
  assert.throws(() => convert('yes', 'boolean', 'b'))
  assert.throws(() => convert('2026-02-30', 'date', 'd'))
  assert.equal(convert('2026-09-25 10:20:30.120000', 'datetime', 'd'), '2026-09-25T10:20:30.12')
  assert.equal(convert('2026-09-25T10:00:00+08:00', 'datetime', 'd'), '2026-09-25T02:00:00Z')
  assert.equal(convert('2026-09-25T02:00:00Z', 'datetime', 'd'), '2026-09-25T02:00:00Z')
})

test('identity compares numbers by value', () => {
  assert.equal(identity(parse('1.0')), identity(parse('1.00')))
  assert.notEqual(identity('1'), identity(1))
  assert.equal(rowKey({ a: parse('1.0'), b: 'x' }, ['a', 'b']), rowKey({ a: 1, b: 'x' }, ['a', 'b']))
  assert.throws(() => rowKey({ a: null }, ['a']))
})

test('SQL parameters are found outside strings, identifiers and comments', () => {
  const parsed = parseSql(`SELECT :id AS a, ':x' AS b, "c:d", $$e:f$$, E'it\\'s', x::text, '{"k":1}'::jsonb ? 'k' -- :y
    FROM t WHERE a = :id OR b = :other /* :z */;`)
  assert.deepEqual(parsed.names, ['id', 'other'])
  const sql = positional(parsed, () => 'int8')
  assert.match(sql, /SELECT \$1::int8 AS a/)
  assert.match(sql, /b = \$2::int8/)
  assert.match(sql, /\$\$e:f\$\$/)
})

test('SQL must be a single SELECT', () => {
  assert.throws(() => parseSql('DELETE FROM t'), /SELECT/)
  assert.throws(() => parseSql('SELECT 1; SELECT 2'), /一条/)
  assert.throws(() => parseSql("SELECT 'open"), /闭合/)
  assert.throws(() => parseSql('SELECT $1'), /:name/)
  assert.doesNotThrow(() => parseSql('WITH a AS (SELECT 1) SELECT * FROM a;'))
  assert.doesNotThrow(() => parseSql('(SELECT 1)'))
})

test('User-Agent rules', () => {
  assert.ok(userAgentAllowed([], undefined))
  assert.ok(userAgentAllowed(['MyClient/*'], 'MyClient/2.0'))
  assert.ok(!userAgentAllowed(['MyClient/1.0'], 'MyClient/1.01'))
  assert.ok(!userAgentAllowed(['MyClient/*'], undefined))
})
