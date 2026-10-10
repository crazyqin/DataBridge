import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestTrace } from '../web/src/request-trace.ts'

test('editor diagnostics preserve exact request numbers and redact signing configuration and echoed secrets', () => {
  const payload = '{"api":{"sql":"SELECT :counter","externalAuth":{"tokenName":"ticket","headers":{"X-Service-Key":"private-service-key"},"dynamicHeaders":{"X-Sign":{"type":"digest","parts":[{"type":"literal","value":"private-signing-password"}]}}}},"params":{"counter":9007199254740993,"amount":1.10}}'
  const headers = { 'Content-Type': 'application/json', 'X-DataBridge-Test-Credential': 'Bearer private-user-token' }
  const recorder = createRequestTrace('POST', 'https://app.example.com/admin/apis/test', headers, payload)
  assert.equal(recorder.trace.completed, false)
  assert.equal(recorder.trace.response, null)
  assert.match(recorder.trace.request.body!, /9007199254740993/)
  assert.match(recorder.trace.request.body!, /1\.10/)
  assert.match(recorder.trace.request.body!, /SELECT :counter/)
  recorder.received(new Response('', { status: 502, headers: { 'X-Request-ID': 'trace-id', 'Set-Cookie': 'private-session' } }),
    '{"message":"identity service rejected private-user-token","ticket":"rotated-private-ticket","counter":9007199254740993}')
  const trace = recorder.finish(new Error('identity service rejected private-user-token'))
  assert.equal(trace.completed, true)
  assert.equal(trace.response!.status, 502)
  assert.equal(trace.response!.headers['x-request-id'], 'trace-id')
  assert.match(trace.response!.body!, /9007199254740993/)
  assert.doesNotMatch(JSON.stringify(trace), /private-service-key|private-signing-password|private-user-token|rotated-private-ticket|private-session/)
  assert.equal(headers['X-DataBridge-Test-Credential'], 'Bearer private-user-token', 'redaction must not mutate wire headers')
  assert.match(payload, /private-signing-password/, 'redaction must not mutate the wire body')
})

test('editor diagnostics retain non-JSON gateway responses and request details on network failures', () => {
  const recorder = createRequestTrace('POST', 'https://app.example.com/admin/apis/test', {}, '{"params":{"id":"00123"}}')
  recorder.received(new Response('', { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } }), '<html>upstream connection refused</html>')
  let trace = recorder.finish(new Error('请求失败 (502)'))
  assert.equal(trace.response!.statusText, 'Bad Gateway')
  assert.equal(trace.response!.body, '<html>upstream connection refused</html>')
  assert.match(trace.request.body!, /00123/)
  const disconnected = createRequestTrace('POST', 'https://app.example.com/admin/apis/test', {}, '{}')
  trace = disconnected.finish(new TypeError('Failed to fetch'))
  assert.equal(trace.response, null)
  assert.equal(trace.error, 'Failed to fetch')
  assert.equal(trace.request.method, 'POST')
})
