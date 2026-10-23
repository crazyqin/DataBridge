import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeTestParams } from '../web/src/test-params.ts'

test('test parameter templates cover declared types and ignore incomplete or duplicate names', () => {
  const result = completeTestParams([
    { name: 'q', type: 'string' }, { name: 'id', type: 'integer' }, { name: 'amount', type: 'decimal' },
    { name: 'enabled', type: 'boolean' }, { name: 'date', type: 'date' }, { name: 'at', type: 'datetime' },
    { name: '', type: 'string' }, { name: 'bad name', type: 'string' }, { name: 'q', type: 'integer' },
  ])!
  assert.deepEqual(JSON.parse(result), { q: '', id: 0, amount: 0, enabled: false, date: 'YYYY-MM-DD', at: 'YYYY-MM-DDTHH:mm:ss' })
  assert.equal(completeTestParams([]), '{}')
})

test('completing a template preserves exact numeric tokens, nested values, falsy values and extra keys', () => {
  const current = ' {"id":9007199254740993,"amount":1.1000,"scale":1e40,"zero":-0,"enabled":false,"q":"","optional":null,"extra":{"items":["} , \\\"",0]}} \n'
  const fields = ['id', 'amount', 'scale', 'zero', 'enabled', 'q', 'optional'].map(name => ({ name, type: 'string' }))
  const result = completeTestParams([...fields, { name: 'next', type: 'string' }], current)!
  for (const literal of ['9007199254740993', '1.1000', '1e40', '-0']) assert.ok(result.includes(literal))
  assert.deepEqual(JSON.parse(result), { ...JSON.parse(current), next: '' })
  assert.equal(completeTestParams(fields, current), current)
  assert.equal(completeTestParams([...fields, { name: 'next', type: 'string' }], result), result)
})

test('unfinished JSON and non-object input are left for the user to correct', () => {
  for (const current of ['{"q":', '{"q":"unfinished', '[]', 'null', '1', 'true', '"text"']) {
    assert.equal(completeTestParams([{ name: 'q', type: 'string' }], current), null)
  }
  assert.deepEqual(JSON.parse(completeTestParams([{ name: 'q', type: 'string' }], ' \n')!), { q: '' })
})

test('prototype-like parameter names stay ordinary JSON fields', () => {
  const result = completeTestParams([{ name: '__proto__', type: 'string' }, { name: 'constructor', type: 'string' }])!
  const parsed = JSON.parse(result)
  assert.ok(Object.hasOwn(parsed, '__proto__'))
  assert.equal(parsed.__proto__, '')
  assert.equal(parsed.constructor, '')
})
