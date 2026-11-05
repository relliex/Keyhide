const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { gzipSync } = require('node:zlib')
const { loadBackend } = require('./load-backend.cjs')
const root = path.resolve(__dirname, '..')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  return server.address().port
}
async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}
function request(port, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', ...options }, (res) => {
      const chunks = []
      let firstByte = null
      let settled = false
      const finish = (error = null) => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), error, firstByte, duration: Date.now() - started })
      }
      res.on('data', (chunk) => { firstByte ??= Date.now() - started; chunks.push(chunk) })
      res.on('error', finish)
      res.on('end', () => finish())
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyhide-backend-test-'))
  const handlers = new Map()
  const sender = Object.assign(new EventEmitter(), { id: 1 })
  let failRename = false
  const overrides = {
    os: { ...os, homedir: () => home },
    fs: { ...fs, renameSync: (...args) => { if (failRename && args[1].endsWith('keyhide.enc')) throw new Error('simulated atomic rename failure'); return fs.renameSync(...args) } },
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: {}, clipboard: { writeText() {} } }
  }
  const load = loadBackend(overrides)
  const db = load(path.join(root, 'database.ts'))
  const proxy = load(path.join(root, 'proxy-server.ts'))
  const manager = load(path.join(root, 'upstream/manager.ts'))
  const transport = load(path.join(root, 'upstream/http.ts'))
  const usage = load(path.join(root, 'upstream/usage.ts'))
  const validation = load(path.join(root, 'config-validation.ts'))
  const servers = []
  const calls = []
  const port = await freePort()
  db.saveProxyConfig({ port, timeout: 1000, maxLogs: 100 })
  const key = db.getData().proxy.maskedApiKey
  const context = {
    home, db, proxy, manager, transport, usage, validation, port, key, calls, handlers, sender, load,
    auth: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    failRename: (value) => { failRename = value },
    reload: () => loadBackend(overrides)(path.join(root, 'database.ts')),
    ipc: () => load(path.join(root, 'ipc.ts')).registerIpc(),
    async upstream(handler) {
      const server = http.createServer(async (req, res) => {
        const chunks = []
        try {
          for await (const chunk of req) chunks.push(chunk)
          const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }
          calls.push(call)
          await handler(call, res, req)
        } catch (error) { if (!res.destroyed) { res.statusCode = 500; res.end(String(error)) } }
      })
      const serverPort = await listen(server)
      servers.push(server)
      return `http://127.0.0.1:${serverPort}`
    },
    platform(baseUrl, keys = ['key-1'], overrides = {}) {
      const platform = {
        ...db.createNewPlatform(), name: 'Mock platform', baseUrl, models: ['m'],
        keys: keys.map((value, index) => db.createNewKey(value, `Key ${index + 1}`)), ...overrides
      }
      return db.savePlatform({
        ...platform,
        upstreamProtocol: overrides.upstreamProtocol || (platform.type === 'anthropic' ? 'anthropic' : 'openai-chat')
      })
    },
    async start() { assert.equal((await proxy.startProxy()).success, true) },
    async json(body = { model: 'm' }, options = {}) { return request(port, { headers: context.auth, ...options }, Buffer.from(JSON.stringify(body))) }
  }
  t.after(async () => {
    await proxy.stopProxy()
    db.flushData()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
  return context
}

function jsonResponse(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(data))
}

test('transparent JSON bytes, query parameters, base prefixes, request and response headers', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream((call, res) => jsonResponse(res, { usage: { prompt_tokens: 3, completion_tokens: 2 } }, 201, { 'x-request-id': 'mock-id', 'set-cookie': ['one=1', 'two=2'] }))
  f.platform(`${url}/prefix/v1?base=1`)
  await f.start()
  const body = Buffer.from('{ "model" : "m", "messages": [], "stream": false }\n')
  const result = await request(f.port, { path: '/v1/chat/completions?x=%2F&x=2&raw=a+b', headers: { ...f.auth, authorization: `bEaReR ${f.key}`, 'x-extra': 'kept', 'openai-beta': 'assistants=v2', connection: 'close, x-hop', 'x-hop': 'removed' } }, body)
  assert.equal(result.status, 201)
  assert.equal(f.calls[0].url, '/prefix/v1/chat/completions?base=1&x=%2F&x=2&raw=a+b')
  assert.deepEqual(f.calls[0].body, body)
  assert.equal(f.calls[0].headers.authorization, 'Bearer key-1')
  assert.equal(f.calls[0].headers['x-extra'], 'kept')
  assert.equal(f.calls[0].headers['openai-beta'], 'assistants=v2')
  assert.equal(f.calls[0].headers['x-hop'], undefined)
  assert.equal(result.headers['x-request-id'], 'mock-id')
  assert.deepEqual(result.headers['set-cookie'], ['one=1', 'two=2'])
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 5)
})

test('multipart uploads stay byte-exact and model fields select the right platform', async (t) => {
  const f = await fixture(t)
  const wrong = await f.upstream((_call, res) => jsonResponse(res, { wrong: true }))
  f.platform(wrong, ['wrong'], { models: ['other'] })
  const url = await f.upstream((_call, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(Buffer.from([0, 255, 1, 128])) })
  const platform = f.platform(url)
  const boundary = 'test-boundary'
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from([0, 255, 13, 10, 128]), Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n--${boundary}--\r\n`)])
  await f.start()
  const result = await request(f.port, { path: '/v1/audio/transcriptions', headers: { authorization: `Bearer ${f.key}`, 'content-type': `multipart/form-data; boundary="${boundary}"` } }, body)
  assert.equal(result.status, 200)
  assert.deepEqual(f.calls[0].body, body)
  assert.equal(f.calls[0].headers.authorization, 'Bearer key-1')
  assert.deepEqual(result.body, Buffer.from([0, 255, 1, 128]))
  assert.equal(f.db.getData().logs[0].platformId, platform.id)
})

test('binary and compressed bodies retain their encoding and content length', async (t) => {
  const f = await fixture(t)
  const raw = Buffer.from([0, 255, 1, 0, 128])
  const compressed = gzipSync(raw)
  f.platform(await f.upstream((_call, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': compressed.length }); res.end(compressed) }))
  await f.start()
  const result = await request(f.port, { path: '/v1/files/file-1/content?download=true', method: 'GET', headers: f.auth })
  assert.deepEqual(result.body, compressed)
  assert.equal(result.headers['content-encoding'], 'gzip')
  assert.equal(Number(result.headers['content-length']), compressed.length)
})

test('unknown endpoints, PUT, HEAD and non-JSON vendor bodies are forwarded', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((call, res) => { res.writeHead(202, { 'content-type': 'text/plain', 'content-length': 2 }); res.end(call.method === 'HEAD' ? undefined : 'ok') }))
  await f.start()
  const body = Buffer.from('opaque\0body')
  const result = await request(f.port, { method: 'PUT', path: '/v1/vendor/resource?a=%25', headers: { ...f.auth, 'content-type': 'application/vnd.test' } }, body)
  assert.equal(result.status, 202)
  assert.deepEqual(f.calls[0].body, body)
  const head = await request(f.port, { method: 'HEAD', path: '/v1/vendor/resource', headers: f.auth })
  assert.equal(head.status, 202)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['content-length'], '2')
})

test('Anthropic metadata headers and auth forwarded without converting request/response', async (t) => {
  const f = await fixture(t)
  const platform = f.platform(await f.upstream((_call, res) => jsonResponse(res, { usage: { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 2 } })), ['anth-key'], { type: 'anthropic', customHeaders: { 'X-Custom': 'kept' } })
  await f.start()
  const result = await request(f.port, { path: `/${platform.id}/v1/messages/count_tokens`, headers: { 'x-api-key': f.key, 'content-type': 'application/json', 'anthropic-version': 'custom-version', 'anthropic-beta': 'beta-test' } }, Buffer.from('{"model":"m"}'))
  assert.equal(result.status, 200)
  assert.equal(f.calls[0].headers.authorization, undefined)
  assert.equal(f.calls[0].headers['x-api-key'], 'anth-key')
  assert.equal(f.calls[0].headers['anthropic-version'], 'custom-version')
  assert.equal(f.calls[0].headers['anthropic-beta'], 'beta-test')
  assert.equal(f.calls[0].headers['x-custom'], 'kept')
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 10)
})

test('custom upstream authentication can use configured x-api-key without leaking the local key', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => jsonResponse(res, {})), ['pool-key'], { type: 'custom', customHeaders: { 'X-Api-Key': 'custom-token' } })
  await f.start()
  assert.equal((await f.json()).status, 200)
  assert.equal(f.calls[0].headers['x-api-key'], 'custom-token')
  assert.equal(f.calls[0].headers.authorization, undefined)
})

test('model routing is strict, explicit platform paths are pinned, by-path requires a default', async (t) => {
  const f = await fixture(t)
  const p = f.platform(await f.upstream((_call, res) => jsonResponse(res, {})), ['key'], { models: ['known'] })
  await f.start()
  assert.equal((await f.json({ model: 'unknown' })).status, 503)
  assert.equal((await f.json({ model: 'known' }, { path: '/does-not-exist/v1/chat/completions' })).status, 503)
  f.db.saveSettings({ routeMode: 'by-model' })
  assert.equal((await f.json({ model: 'unknown' })).status, 503)
  f.db.saveSettings({ routeMode: 'by-path', defaultPlatformId: null })
  assert.equal((await f.json({ model: 'known' })).status, 503)
  f.db.saveSettings({ defaultPlatformId: p.id })
  assert.equal((await f.json({ model: 'any' })).status, 200)
  assert.equal(f.calls.length, 1)
})

test('exact model match precedes wildcard catalog, default still takes priority in auto', async (t) => {
  const f = await fixture(t)
  const wildcard = f.platform('http://localhost:1', ['wildcard'], { models: [] })
  const exact = f.platform('http://localhost:2', ['exact'])
  assert.equal(f.manager.selectUpstream('m', 'auto', null).platform.id, exact.id)
  assert.equal(f.manager.selectUpstream('m', 'auto', wildcard.id).platform.id, wildcard.id)
  assert.equal(f.manager.selectUpstream('m', 'by-model', wildcard.id).platform.id, exact.id)
})

test('preview-route IPC is read-only and agrees with actual routing', async (t) => {
  const f = await fixture(t)
  const p = f.platform('http://localhost:1', ['a', 'b'])
  f.ipc()
  const before = f.db.getData()
  for (let index = 0; index < 10; index++) {
    const preview = await f.handlers.get('preview-route')({}, { model: 'm', path: '/v1/chat/completions', format: 'openai' })
    assert.equal(preview.platformId, p.id)
    assert.equal(preview.platformName, p.name)
    assert.equal(typeof preview.reason, 'string')
  }
  assert.deepEqual(f.db.getData(), before)
  assert.equal(f.manager.selectUpstream('m', 'auto', null).key.key, 'a')
  assert.equal(f.manager.selectUpstream('m', 'auto', null).key.key, 'b')
  const preview = f.proxy.previewProxyRoute({ model: 'm', path: '/bad/path', format: 'openai' })
  assert.equal(preview.platformId, null)
  assert.equal(typeof preview.error, 'string')
  const converted = f.proxy.previewProxyRoute({ model: 'm', path: '/v1/responses', format: 'openai-responses' })
  assert.equal(converted.downstreamProtocol, 'openai-responses')
  assert.equal(converted.upstreamProtocol, 'openai-chat')
  assert.equal(converted.conversion, 'convert')
  assert.equal(converted.resolvedModel, 'm')
})

test('401 rejection fails over to another key and logs the final successful attempt', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((call, res) => jsonResponse(res, call.headers.authorization === 'Bearer bad' ? { error: 'bad key' } : { usage: { prompt_tokens: 1, completion_tokens: 2 } }, call.headers.authorization === 'Bearer bad' ? 401 : 200)), ['bad', 'good'])
  await f.start()
  assert.equal((await f.json()).status, 200)
  assert.equal(f.calls.length, 2)
  const data = f.db.getData()
  assert.equal(data.platforms[0].keys[0].status, 'error')
  assert(f.manager.keyRetryAt(data.platforms[0], data.platforms[0].keys[0]) > Date.now())
  assert.equal(data.platforms[0].keys[0].requestCount, 1)
  assert.equal(data.platforms[0].keys[1].requestCount, 1)
  assert.equal(data.logs[0].statusCode, 200)
  assert.equal(data.logs[0].keyLabel, 'Key 2')
  assert.equal(data.logs[0].error, null)
})

test('three key error policies: cooldown, ignore and disable', async (t) => {
  const f = await fixture(t)
  const platform = f.platform('http://localhost:1', ['a', 'b'])
  f.manager.markKeyError(platform.id, platform.keys[0].id, 'unauthorized', 401)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'error')
  assert(f.manager.keyRetryAt(f.db.loadData().platforms[0], f.db.loadData().platforms[0].keys[0]) > Date.now())
  f.db.saveSettings({ keyErrorPolicy: 'ignore' })
  f.manager.clearRoutingState()
  f.manager.markKeyError(platform.id, platform.keys[1].id, 'forbidden', 403)
  assert.equal(f.db.getData().platforms[0].keys[1].status, 'active')
  assert.equal(f.manager.keyRetryAt(f.db.loadData().platforms[0], f.db.loadData().platforms[0].keys[1]), undefined)
  f.manager.markKeyError(platform.id, platform.keys[1].id, 'quota', 429, undefined, true)
  assert.equal(f.db.getData().platforms[0].keys[1].status, 'active')
  assert.equal(f.manager.keyRetryAt(f.db.loadData().platforms[0], f.db.loadData().platforms[0].keys[1]), undefined)
  f.db.saveSettings({ keyErrorPolicy: 'disable' })
  f.manager.clearRoutingState()
  f.manager.markKeyError(platform.id, platform.keys[1].id, 'server error', 503)
  assert.equal(f.db.getData().platforms[0].keys[1].status, 'disabled')
})

test('legacy autoDisableKeyOnError migrates to the new three-state policy', async (t) => {
  const f = await fixture(t)
  assert.equal(f.db.getData().settings.keyErrorPolicy, 'cooldown')
  f.db.importConfig({ settings: { autoDisableKeyOnError: true } })
  assert.equal(f.db.getData().settings.keyErrorPolicy, 'disable')
  f.db.importConfig({ settings: { autoDisableKeyOnError: false } })
  assert.equal(f.db.getData().settings.keyErrorPolicy, 'cooldown')
})

test('429 cooldown respects Retry-After, recovers, and does not permanently exhaust valid keys', async (t) => {
  const f = await fixture(t)
  let rateLimited = true
  const p = f.platform(await f.upstream((call, res) => {
    if (call.headers.authorization === 'Bearer limited' && rateLimited) { rateLimited = false; jsonResponse(res, { error: { type: 'rate_limit_error' } }, 429, { 'retry-after': '0.1' }) }
    else jsonResponse(res, {})
  }), ['limited', 'good'])
  await f.start()
  assert.equal((await f.json()).status, 200)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'error')
  assert.equal(f.manager.selectKey(f.db.loadData().platforms[0]).key, 'good')
  await delay(120)
  assert.equal((await f.json()).status, 200)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'active')
  assert.equal(f.db.getData().platforms[0].id, p.id)
})

test('quota-specific 429 cools down in cooldown mode while validation errors never alter keys', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((call, res) => jsonResponse(res, { error: { code: call.url.includes('quota') ? 'insufficient_quota' : 'invalid_request_error' } }, call.url.includes('quota') ? 429 : 400)), ['a', 'b'])
  await f.start()
  const quota = await f.json({}, { path: '/v1/quota' })
  assert.equal(quota.status, 429)
  assert.ok(f.db.getData().platforms[0].keys.every((key) => key.status === 'error'))
  f.db.resetStats(); f.manager.clearRoutingState()
  f.db.saveSettings({ keyErrorPolicy: 'disable' })
  assert.equal((await f.json({})).status, 400)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'active')
  assert.equal(f.db.getData().platforms[0].keys[0].errorStreak, 0)
})

test('non-idempotent POST is not duplicated on 5xx, while idempotency-key permits failover', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((call, res) => jsonResponse(res, {}, call.headers.authorization === 'Bearer bad' ? 503 : 200)), ['bad', 'good'])
  await f.start()
  assert.equal((await f.json()).status, 503)
  assert.equal(f.calls.length, 1)
  f.db.resetStats(); f.manager.clearRoutingState()
  assert.equal((await f.json({ model: 'm' }, { headers: { ...f.auth, 'idempotency-key': 'test-request' } })).status, 200)
  assert.equal(f.calls.length, 3)
})

test('explicit platform failover never falls through to a different platform', async (t) => {
  const f = await fixture(t)
  const p = f.platform(await f.upstream((_call, res) => jsonResponse(res, {}, 401)), ['bad'])
  f.platform(await f.upstream((_call, res) => jsonResponse(res, {})), ['good'])
  await f.start()
  assert.equal((await f.json({ model: 'm' }, { path: `/${p.id}/v1/chat/completions` })).status, 401)
  assert.equal(f.calls.length, 1)
})

test('SSE is recognized from response headers, streamed early and counts final usage', async (t) => {
  const f = await fixture(t)
  const first = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
  const last = 'data: {"usage":{"prompt_tokens":4,"completion_tokens":7}}\n\ndata: [DONE]\n\n'
  f.platform(await f.upstream(async (_call, res) => { res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-stream': 'yes' }); res.write(first); await delay(120); res.end(last) }))
  await f.start()
  const result = await f.json({ model: 'm' })
  assert.equal(result.status, 200)
  assert.equal(result.body.toString(), first + last)
  assert.ok(result.firstByte < 100)
  assert.equal(result.headers['x-stream'], 'yes')
  assert.equal(f.db.getData().logs[0].stream, true)
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 11)
})

test('SSE usage handles split UTF-8, CRLF and cumulative provider usage without keeping transcripts', async (t) => {
  const f = await fixture(t)
  const tracker = new f.usage.UsageTracker('text/event-stream')
  const body = Buffer.from('event: message_start\r\ndata: {"message":{"usage":{"input_tokens":2,"cache_read_input_tokens":3},"text":"你好"}}\r\n\r\ndata: {"usage":{"output_tokens":4}}\r\n\r\ndata: {"usage":{"output_tokens":8}}\r\n\r\n')
  for (const byte of body) tracker.observe(Buffer.from([byte]))
  assert.deepEqual(tracker.finish(), { prompt: 5, completion: 8 })
  const binaryTracker = new f.usage.UsageTracker('application/octet-stream')
  binaryTracker.observe(Buffer.alloc(1024 * 1024))
  assert.deepEqual(binaryTracker.finish(), { prompt: 0, completion: 0 })
})

test('header timeout returns 504 and never retries a possibly executed POST', async (t) => {
  const f = await fixture(t)
  f.db.saveProxyConfig({ timeout: 100 })
  f.platform(await f.upstream(async (_call, res) => { await delay(250); if (!res.destroyed) jsonResponse(res, {}) }), ['a', 'b'])
  await f.start()
  const result = await f.json()
  assert.equal(result.status, 504)
  assert.equal(f.calls.length, 1)
  assert.equal(f.db.getData().logs[0].statusCode, 504)
})

test('stream idle timeout closes the incomplete response and records 504, not success', async (t) => {
  const f = await fixture(t)
  f.db.saveProxyConfig({ timeout: 100 })
  f.platform(await f.upstream((_call, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"hello":1}\n\n') }))
  await f.start()
  const result = await f.json()
  assert.equal(result.status, 200)
  assert.ok(result.error)
  await delay(20)
  assert.equal(f.db.getData().logs[0].statusCode, 504)
  assert.notEqual(f.db.getData().platforms[0].keys[0].status, 'active')
})

test('client abort cancels upstream promptly without penalizing its key', async (t) => {
  const f = await fixture(t)
  let closed = false
  f.platform(await f.upstream((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n')
    const timer = setInterval(() => res.write(': ping\n\n'), 20)
    res.once('close', () => { closed = true; clearInterval(timer) })
  }))
  await f.start()
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST', headers: f.auth }, (res) => {
      res.once('data', () => { req.destroy(); res.destroy(); resolve() })
    })
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
    req.end('{"model":"m","stream":true}')
  })
  await delay(60)
  assert.equal(closed, true)
  assert.equal(f.db.getData().platforms[0].keys[0].errorStreak, 0)
  assert.equal(f.db.getData().logs[0].statusCode, 499)
})

test('an upstream socket reset after headers is logged as incomplete 502, not successful 200', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('partial'); setTimeout(() => res.destroy(), 20) }))
  await f.start()
  assert.ok((await f.json()).error)
  await delay(20)
  assert.equal(f.db.getData().logs[0].statusCode, 502)
  assert.equal(f.db.getData().platforms[0].keys[0].errorStreak, 1)
})

test('model discovery checks statuses, retries keys, carries custom headers and handles pagination', async (t) => {
  const f = await fixture(t)
  const p = f.platform(await f.upstream((call, res) => {
    if (call.headers.authorization === 'Bearer bad') return jsonResponse(res, { error: {} }, 401)
    if (call.url.includes('after_id=')) return jsonResponse(res, { data: [{ id: 'second' }], has_more: false })
    return jsonResponse(res, { data: [{ id: 'first' }], has_more: true, last_id: 'first' })
  }), ['bad', 'good'], { customHeaders: { 'x-customer': 'test' } })
  assert.deepEqual(await f.proxy.fetchUpstreamModels(p.id), ['first', 'second'])
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every((call) => call.headers['x-customer'] === 'test'))
  assert.equal(f.calls[2].url, '/v1/models?after_id=first')
  assert.deepEqual(f.db.getData().platforms[0].models, ['first', 'second'])
})

test('model discovery HTTP/JSON failures preserve the existing catalog', async (t) => {
  const f = await fixture(t)
  const p = f.platform(await f.upstream((_call, res) => jsonResponse(res, { error: {} }, 500)))
  await assert.rejects(f.proxy.fetchUpstreamModels(p.id), /HTTP 500/)
  assert.deepEqual(f.db.getData().platforms[0].models, ['m'])
  assert.equal((await f.proxy.testConnection(p.id)).success, false)
})

test('runtime state reflects start/stop, bind failure recovers and active stop is prompt', async (t) => {
  const f = await fixture(t)
  const occupied = http.createServer()
  await new Promise((resolve) => occupied.listen(f.port, '127.0.0.1', resolve))
  assert.equal((await f.proxy.startProxy()).success, false)
  assert.equal(f.db.getData().proxy.running, false)
  await new Promise((resolve) => occupied.close(resolve))
  f.platform(await f.upstream((_call, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {}\n\n') }))
  await f.start()
  assert.equal(f.db.getData().proxy.running, true)
  assert.throws(() => f.db.saveProxyConfig({ port: f.port + 1 }), /停止/)
  assert.throws(() => f.db.saveProxyConfig({ cors: false }), /停止/)
  f.db.saveProxyConfig({ logRequests: false, running: false })
  assert.equal(f.db.getData().proxy.running, true)
  const pending = f.json()
  await delay(40)
  const start = Date.now()
  assert.equal((await f.proxy.stopProxy()).success, true)
  await pending.catch(() => {})
  assert.ok(Date.now() - start < 500)
  assert.equal(f.db.getData().proxy.running, false)
})

test('validation rejects malformed imported config atomically and allows legitimate localhost upstreams', async (t) => {
  const f = await fixture(t)
  f.platform('http://localhost:11434/v1')
  const before = f.db.getData()
  assert.throws(() => f.db.importConfig({ platforms: [{ id: 'bad', baseUrl: 'file:///secret' }] }), /配置无效/)
  assert.throws(() => f.db.importConfig({ proxy: { port: -1 } }), /配置无效/)
  assert.throws(() => f.db.importConfig({ settings: { defaultPlatformId: 'missing' } }), /默认平台/)
  assert.deepEqual(f.db.getData(), before)
  assert.throws(() => f.platform('http://localhost:1', ['x'], { customHeaders: { test: 'bad\r\nvalue' } }), /请求头/)
  assert.throws(() => f.platform('http://localhost:1', ['x'], { customHeaders: { Host: 'other-host' } }), /请求头/)
  const valid = f.validation.validatePlatform({ ...before.platforms[0], baseUrl: 'http://[::1]:11434/prefix/v1' })
  assert.equal(valid.baseUrl, 'http://[::1]:11434/prefix/v1')
  f.db.importConfig({ proxy: { running: true } })
  assert.equal(f.db.getData().proxy.running, false)
})

test('atomic persistence retains encrypted original and cache on write failure and removes temp files', async (t) => {
  const f = await fixture(t)
  f.platform('http://localhost:1', ['private-secret'])
  const dataPath = path.join(f.home, 'AppData', 'LocalLow', 'Keyhide', 'keyhide.enc')
  const original = fs.readFileSync(dataPath)
  assert.equal(original.includes(Buffer.from('private-secret')), false)
  const before = f.db.getData()
  f.failRename(true)
  assert.throws(() => f.db.saveSettings({ autoStartProxy: true }), /simulated atomic/)
  f.failRename(false)
  assert.deepEqual(fs.readFileSync(dataPath), original)
  assert.deepEqual(f.db.getData(), before)
  assert.equal(fs.readdirSync(path.dirname(dataPath)).some((name) => name.endsWith('.tmp')), false)
})

test('corrupted encrypted data recovers backup and preserves damaged ciphertext', async (t) => {
  const f = await fixture(t)
  const p = f.platform('http://localhost:1', ['secret'])
  f.db.saveSettings({ autoStartProxy: true })
  const dir = path.join(f.home, 'AppData', 'LocalLow', 'Keyhide')
  fs.writeFileSync(path.join(dir, 'keyhide.enc'), Buffer.from('damaged ciphertext'))
  const reloaded = f.reload().getData()
  assert.equal(reloaded.platforms[0].id, p.id)
  assert.equal(reloaded.settings.autoStartProxy, false)
  const preserved = fs.readdirSync(dir).find((name) => name.startsWith('keyhide.enc.corrupt-'))
  assert.ok(preserved)
  assert.equal(fs.readFileSync(path.join(dir, preserved)).toString(), 'damaged ciphertext')
})

test('statistics writes coalesce, persist on flush, and reset does not re-enable manually disabled keys', async (t) => {
  const f = await fixture(t)
  const p = f.platform('http://localhost:1', ['a', 'b'])
  f.manager.markKeySuccess(p.id, p.keys[0].id, 9)
  f.manager.markKeySuccess(p.id, p.keys[0].id, 4)
  f.db.updateKeyStatus(p.id, p.keys[1].id, { status: 'disabled' })
  f.db.flushData()
  assert.equal(f.reload().getData().platforms[0].keys[0].quotaUsed, 13)
  f.db.resetStats()
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 0)
  assert.equal(f.db.getData().platforms[0].keys[1].status, 'disabled')
})

test('stale renderer saves retain live counters/status, explicit toggles still apply', async (t) => {
  const f = await fixture(t)
  const p = f.platform('http://localhost:1', ['a'])
  f.ipc()
  const event = { sender: f.sender }
  const stale = (await f.handlers.get('get-data')(event)).platforms[0]
  f.manager.markKeySuccess(p.id, p.keys[0].id, 17)
  f.manager.markKeyError(p.id, p.keys[0].id, 'HTTP 401', 401)
  stale.name = 'Edited name'
  stale.keys[0].requestCount = 999
  const saved = await f.handlers.get('save-platform')(event, stale)
  assert.equal(saved.keys[0].requestCount, 2)
  assert.equal(saved.keys[0].quotaUsed, 17)
  assert.equal(saved.keys[0].status, 'error')
  const fresh = (await f.handlers.get('get-data')(event)).platforms[0]
  fresh.keys[0].status = 'active'
  assert.equal((await f.handlers.get('save-platform')(event, fresh)).keys[0].status, 'active')
})

test('in-flight success cannot undo manual disable; old credential failure cannot disable replacement', async (t) => {
  const f = await fixture(t)
  const p = f.platform('http://localhost:1', ['a'])
  f.db.updateKeyStatus(p.id, p.keys[0].id, { status: 'disabled' })
  f.manager.markKeySuccess(p.id, p.keys[0].id, 1, 'a')
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'disabled')
  const changed = f.db.getData().platforms[0]
  changed.keys[0].key = 'replacement'; changed.keys[0].status = 'active'
  f.db.savePlatform(changed)
  f.manager.markKeyError(p.id, p.keys[0].id, 'HTTP 401', 401, undefined, false, 'a')
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'active')
})

test('compressed JSON and SSE preserve bytes and retain reported usage', async (t) => {
  const f = await fixture(t)
  const payloads = [Buffer.from(JSON.stringify({ output: 'x'.repeat(700000), usage: { prompt_tokens: 7, completion_tokens: 3 } })), Buffer.from('data: {"usage":{"prompt_tokens":2,"completion_tokens":4}}\n\ndata: [DONE]\n\n')]
  let index = 0
  let wire
  f.platform(await f.upstream((_call, res) => {
    wire = gzipSync(payloads[index])
    res.writeHead(200, { 'content-type': index++ === 0 ? 'application/json' : 'text/event-stream', 'content-encoding': 'gzip', 'content-length': wire.length })
    res.end(wire)
  }))
  await f.start()
  const json = await f.json()
  assert.deepEqual(json.body, wire)
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 10)
  const stream = await f.json()
  assert.deepEqual(stream.body, wire)
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 16)
  assert.equal(f.db.getData().logs[0].stream, true)
})

test('normal completion of an error SSE is logged as a failed generation', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"usage":{"input_tokens":5}}\n\nevent: error\ndata: {"error":{"type":"overloaded_error"}}\n\n')
  }))
  await f.start()
  assert.equal((await f.json()).status, 200)
  assert.equal(f.db.getData().logs[0].statusCode, 502)
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 5)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'error')
})

test('client cancellation retains already-observed SSE usage without penalizing the key', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n')
  }))
  await f.start()
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port, path: '/v1/chat/completions', method: 'POST', headers: f.auth }, (res) => { res.once('data', () => { req.destroy(); res.destroy(); resolve() }) })
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error) })
    req.end('{"model":"m","stream":true}')
  })
  await delay(60)
  assert.equal(f.db.getData().logs[0].promptTokens, 8)
  assert.equal(f.db.getData().logs[0].completionTokens, 2)
  assert.equal(f.db.getData().platforms[0].keys[0].quotaUsed, 10)
  assert.equal(f.db.getData().platforms[0].keys[0].errorStreak, 0)
})

test('editor-origin snapshots preserve a key disabled after a background refresh', async (t) => {
  const f = await fixture(t)
  const p = f.platform(await f.upstream((_call, res) => jsonResponse(res, {})))
  f.ipc()
  const original = (await f.handlers.get('get-data')({ sender: f.sender })).platforms[0]
  f.manager.markKeyError(p.id, p.keys[0].id, 'unauthorized', 401)
  await f.handlers.get('get-data')({ sender: f.sender })
  await f.handlers.get('save-platform')({ sender: f.sender }, { ...original, name: 'Renamed only' }, original)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'error')
})

test('listener configuration and clearing are locked while startup is pending', async (t) => {
  const f = await fixture(t)
  const starting = f.proxy.startProxy()
  assert.throws(() => f.db.saveProxyConfig({ port: f.port + 1 }), /停止代理/)
  assert.throws(() => f.db.importConfig({ proxy: { host: '0.0.0.0' } }), /停止代理/)
  assert.throws(() => f.db.clearAllData(), /停止代理/)
  assert.equal((await starting).success, true)
  assert.equal(f.db.getData().proxy.port, f.port)
})

test('runtime data notifications continue with request logging disabled', async (t) => {
  const f = await fixture(t)
  f.db.saveProxyConfig({ logRequests: false })
  f.platform(await f.upstream((_call, res) => jsonResponse(res, {}, 401)))
  let changed = 0
  f.proxy.setEmitCallbacks(() => assert.fail('Logging is disabled'), () => {}, () => changed++)
  await f.start()
  assert.equal((await f.json()).status, 401)
  assert.equal(f.db.getData().logs.length, 0)
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'error')
  assert.equal(changed, 1)
})

test('model discovery does not overwrite an upstream replaced during the request', async (t) => {
  const f = await fixture(t)
  let release
  let received
  const pending = new Promise((resolve) => { received = resolve })
  const p = f.platform(await f.upstream(async (_call, res) => {
    received()
    await new Promise((resolve) => { release = resolve })
    jsonResponse(res, { data: [{ id: 'old-model' }] })
  }))
  const discovery = f.proxy.fetchUpstreamModels(p.id)
  await pending
  f.db.savePlatform({ ...p, baseUrl: 'http://127.0.0.1:12345', models: ['replacement-model'] })
  release()
  await assert.rejects(discovery, /平台配置已改变/)
  assert.deepEqual(f.db.getData().platforms[0].models, ['replacement-model'])
})

test('IPC exposes recoverable key cooldown and clears it after expiry or restart', async (t) => {
  const f = await fixture(t)
  const p = f.platform(await f.upstream((_call, res) => jsonResponse(res, {})))
  f.ipc()
  f.manager.markKeyError(p.id, p.keys[0].id, 'rate limited', 429, 100)
  const data = await f.handlers.get('get-data')({ sender: f.sender })
  assert(data.platforms[0].keys[0].retryAt > Date.now())
  assert.equal(f.manager.selectKey(f.db.loadData().platforms[0]), null)
  assert.equal(f.db.getData().platforms[0].keys[0].retryAt, undefined)
  await delay(120)
  assert.equal((await f.handlers.get('get-data')({ sender: f.sender })).platforms[0].keys[0].retryAt, undefined)
  assert(f.manager.selectKey(f.db.loadData().platforms[0]))
  f.manager.markKeyError(p.id, p.keys[0].id, 'network failure', 502, 10000)
  f.manager.clearRoutingState()
  assert.equal((await f.handlers.get('get-data')({ sender: f.sender })).platforms[0].keys[0].retryAt, undefined)
})

test('logs redact encoded query names, configured credentials and metadata before credentials are deleted', async (t) => {
  const f = await fixture(t)
  const secret = 'vendor_token_ABC'
  const headerSecret = 'custom/header+secret'
  const p = f.platform(await f.upstream((_call, res) => jsonResponse(res, {})), [secret], { name: `Platform ${secret}`, models: [], customHeaders: { 'x-custom-auth': headerSecret } })
  await f.start()
  const emitted = []
  f.proxy.setEmitCallbacks((log) => emitted.push(log), () => {})
  assert.equal((await f.json({ model: secret }, { path: `/v1/chat/completions?credential=${secret}&%61pi_key=unknown-private&opaque=${encodeURIComponent(headerSecret)}&other=${encodeURIComponent(f.key)}` })).status, 200)
  await delay(10)
  const logs = JSON.stringify(f.db.getData().logs)
  for (const value of [secret, headerSecret, encodeURIComponent(headerSecret), f.key, 'unknown-private']) {
    assert(!logs.includes(value), `Persisted logs contain ${value}`)
    assert(!JSON.stringify(emitted).includes(value), `Emitted logs contain ${value}`)
  }
  assert(logs.includes('[REDACTED]'))
  f.db.deletePlatform(p.id)
  assert(!JSON.stringify(f.db.getData().logs).includes(secret))
})

test('health is 1.1.0, invalid auth is local-only, and query secrets are redacted in logs', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => jsonResponse(res, {})))
  await f.start()
  const health = await request(f.port, { path: '/health', method: 'GET' })
  assert.equal(JSON.parse(health.body).version, '1.1.0')
  assert.equal((await request(f.port, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.json({ model: 'm' }, { path: '/v1/chat/completions?api_key=private&x=ok' })).status, 200)
  assert.equal(f.db.getData().logs[0].path, '/v1/chat/completions?api_key=[REDACTED]&x=ok')
})

/* ------------------------------------------------------------------ */
/* 1.0.2 四协议转换与模型别名                                          */
/* ------------------------------------------------------------------ */

const PROTOCOLS = ['anthropic', 'openai-chat', 'openai-responses', 'gemini']
const protocolPaths = {
  anthropic: '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses'
}

function post(f, path, body, headers = {}) {
  return request(f.port, { path, headers: { ...f.auth, ...headers } }, Buffer.from(JSON.stringify(body)))
}
function get(f, path, headers = {}) {
  return request(f.port, { path, method: 'GET', headers: { ...f.auth, ...headers } })
}
function downstreamRequest(protocol, model, stream = false) {
  if (protocol === 'anthropic') return { path: '/v1/messages', body: { model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream } }
  if (protocol === 'openai-chat') return { path: '/v1/chat/completions', body: { model, messages: [{ role: 'user', content: 'hi' }], stream } }
  if (protocol === 'openai-responses') return { path: '/v1/responses', body: { model, input: 'hi', stream } }
  return { path: `/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } }
}
function requestModel(call) {
  try { const body = JSON.parse(call.body.toString()); if (typeof body.model === 'string') return body.model } catch { /* Gemini 路径 */ }
  const match = /\/models\/([^/:]+)/.exec(call.url)
  return match ? decodeURIComponent(match[1]) : 'unknown'
}
function nonStreamUpstream(protocol, text = 'hello') {
  return (call, res) => {
    const model = requestModel(call)
    if (protocol === 'anthropic') return jsonResponse(res, { id: 'msg_up', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } })
    if (protocol === 'openai-chat') return jsonResponse(res, { id: 'chat_up', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
    if (protocol === 'openai-responses') return jsonResponse(res, { id: 'resp_up', object: 'response', created_at: 1, status: 'completed', model, output: [{ id: 'msg_out', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3, output_tokens: 2 } })
    return jsonResponse(res, { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, finishReason: 'STOP' }], modelVersion: model, usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } })
  }
}
function downstreamJsonText(protocol, body) {
  if (protocol === 'anthropic') return body.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  if (protocol === 'openai-chat') return body.choices[0].message.content || ''
  if (protocol === 'openai-responses') return body.output.flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text).join('')
  return body.candidates[0].content.parts.map((part) => part.text || '').join('')
}
function sseText(protocol, buffer) {
  const frames = buffer.toString().split('\n\n').filter(Boolean).map((frame) => frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')).filter(Boolean)
  if (protocol === 'anthropic') return frames.map((text) => { try { const body = JSON.parse(text); return body.delta?.type === 'text_delta' ? body.delta.text : '' } catch { return '' } }).join('')
  if (protocol === 'openai-chat') return frames.map((text) => { try { const body = JSON.parse(text); return body.choices?.[0]?.delta?.content || '' } catch { return '' } }).join('')
  if (protocol === 'openai-responses') return frames.map((text) => { try { const body = JSON.parse(text); return body.type === 'response.output_text.delta' ? body.delta : '' } catch { return '' } }).join('')
  return frames.map((text) => { try { const body = JSON.parse(text); return (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('') } catch { return '' } }).join('')
}

test('4x4 non-stream protocol matrix converts request, authentication, path and response', async (t) => {
  const f = await fixture(t)
  for (const protocol of PROTOCOLS) {
    const url = await f.upstream(nonStreamUpstream(protocol))
    f.platform(url, [`${protocol}-key`], {
      upstreamProtocol: protocol, models: [`m-${protocol}`], name: `upstream ${protocol}`,
      type: protocol === 'anthropic' ? 'anthropic' : protocol === 'gemini' ? 'custom' : 'openai'
    })
  }
  await f.start()
  for (const downstream of PROTOCOLS) {
    for (const upstream of PROTOCOLS) {
      const model = `m-${upstream}`
      const requestDef = downstreamRequest(downstream, model)
      const result = await post(f, requestDef.path, requestDef.body)
      assert.equal(result.status, 200, `${downstream} → ${upstream} status`)
      assert.match(String(result.headers['content-type']), /json/i)
      const call = f.calls[f.calls.length - 1]
      if (upstream === 'anthropic') {
        assert.equal(call.url, '/v1/messages')
        assert.equal(call.headers['x-api-key'], 'anthropic-key')
        assert.equal(call.headers.authorization, undefined)
        assert.equal(call.headers['anthropic-version'], '2023-06-01')
        assert.equal(JSON.parse(call.body.toString()).model, model)
      } else if (upstream === 'gemini') {
        const action = downstream === upstream ? 'generateContent' : 'streamGenerateContent?alt=sse'
        assert.equal(call.url, `/v1beta/models/${model}:${action}`)
        assert.equal(call.headers['x-goog-api-key'], 'gemini-key')
        assert.equal(call.headers.authorization, undefined)
      } else {
        assert.equal(call.url, protocolPaths[upstream])
        assert.equal(call.headers.authorization, `Bearer ${upstream}-key`)
        assert.equal(JSON.parse(call.body.toString()).model, model)
      }
      const output = JSON.parse(result.body.toString())
      assert.equal(downstreamJsonText(downstream, output), 'hello', `${downstream} → ${upstream} text`)
    }
  }
  assert.equal(f.db.getData().logs.length, 16)
  assert.equal(f.db.getData().platforms.every((platform) => platform.keys[0].requestCount === 4), true)
})

test('4x4 streaming protocol matrix emits real incremental SSE in the downstream protocol', async (t) => {
  const f = await fixture(t)
  for (const protocol of PROTOCOLS) {
    const url = await f.upstream(async (call, res) => {
      const model = requestModel(call)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (protocol === 'anthropic') {
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"' + model + '","usage":{"input_tokens":3}}}\n\n')
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n')
        await delay(30)
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n')
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
        res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n')
      } else if (protocol === 'openai-chat') {
        res.write('data: {"id":"chat_1","model":"' + model + '","choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n')
        await delay(30)
        res.write('data: {"id":"chat_1","model":"' + model + '","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n')
        res.end('data: {"id":"chat_1","model":"' + model + '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
      } else if (protocol === 'openai-responses') {
        res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"' + model + '","status":"in_progress"}}\n\n')
        res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n')
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"hel"}\n\n')
        await delay(30)
        res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"lo"}\n\n')
        res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}\n\n')
        res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"' + model + '","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":3,"output_tokens":2}}}\n\n')
      } else {
        res.write('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hel"}]},"index":0}],"modelVersion":"' + model + '"}\n\n')
        await delay(30)
        res.write('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"index":0}]}\n\n')
        res.end('data: {"candidates":[{"content":{"role":"model","parts":[]},"index":0,"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n')
      }
    })
    f.platform(url, [`${protocol}-key`], {
      upstreamProtocol: protocol, models: [`m-${protocol}`], name: `stream ${protocol}`,
      type: protocol === 'anthropic' ? 'anthropic' : protocol === 'gemini' ? 'custom' : 'openai'
    })
  }
  await f.start()
  for (const downstream of PROTOCOLS) {
    for (const upstream of PROTOCOLS) {
      const model = `m-${upstream}`
      const requestDef = downstreamRequest(downstream, model, true)
      const result = await post(f, requestDef.path, requestDef.body)
      assert.equal(result.status, 200, `${downstream} → ${upstream} status`)
      assert.match(String(result.headers['content-type']), /text\/event-stream/i)
      assert.equal(sseText(downstream, result.body), 'hello', `${downstream} ← ${upstream} stream text`)
      const text = result.body.toString()
      if (downstream === 'anthropic') assert(/message_stop/.test(text))
      if (downstream === 'openai-chat') assert(/\[DONE\]/.test(text))
      if (downstream === 'openai-responses') assert(/response\.completed/.test(text))
      if (downstream === 'gemini') assert(/finishReason/.test(text))
    }
  }
})

test('cross-protocol tool calls and tool results preserve ids and arguments', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream((call, res) => {
    const body = JSON.parse(call.body.toString())
    if (body.messages.some((message) => message.role === 'tool')) return nonStreamUpstream('openai-chat', 'sunny')(call, res)
    jsonResponse(res, {
      id: 'chat_tool', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 }
    })
  })
  f.platform(url, ['chat-key'], { upstreamProtocol: 'openai-chat' })
  await f.start()
  const tools = [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]
  const first = await post(f, '/v1/messages', { model: 'm', max_tokens: 64, tools, messages: [{ role: 'user', content: 'weather?' }] })
  assert.equal(first.status, 200)
  const firstBody = JSON.parse(first.body.toString())
  const toolUse = firstBody.content.find((block) => block.type === 'tool_use')
  assert.equal(toolUse.name, 'get_weather')
  assert.deepEqual(toolUse.input, { city: 'Shanghai' })
  assert.equal(firstBody.stop_reason, 'tool_use')
  const upstreamFirst = JSON.parse(f.calls[0].body.toString())
  assert.equal(upstreamFirst.tools[0].function.name, 'get_weather')
  const second = await post(f, '/v1/messages', { model: 'm', max_tokens: 64, tools, messages: [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_weather', name: 'get_weather', input: { city: 'Shanghai' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_weather', content: 'sunny' }] }
  ] })
  assert.equal(second.status, 200)
  assert.equal(JSON.parse(second.body.toString()).content[0].text, 'sunny')
  const upstreamSecond = JSON.parse(f.calls[1].body.toString())
  assert.equal(upstreamSecond.messages[1].tool_calls[0].id, 'call_weather')
  assert.equal(upstreamSecond.messages[2].role, 'tool')
  assert.equal(upstreamSecond.messages[2].tool_call_id, 'call_weather')
})

test('model aliases hide public names, route to the real model and preserve both identities in logs', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream(nonStreamUpstream('openai-chat'))
  const platform = f.platform(url, ['real-key'], { models: ['gpt6'], name: 'Alias platform' })
  f.db.saveSettings({ enableModelAliases: true })
  f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['deepseek-v4', 'company-chat'], showOriginal: false })
  await f.start()
  const catalog = JSON.parse((await get(f, '/v1/models')).body.toString())
  assert.deepEqual(catalog.data.map((item) => item.id), ['company-chat', 'deepseek-v4'])
  const anthropicCatalog = JSON.parse((await get(f, '/v1/models', { 'anthropic-version': '2023-06-01' })).body.toString())
  assert.equal(anthropicCatalog.data[0].type, 'model')
  assert.equal(anthropicCatalog.data[0].display_name, anthropicCatalog.data[0].id)
  assert.equal((await get(f, `/${platform.id}/v1/models`)).body.toString().includes('"gpt6"'), false)
  assert.equal((await post(f, '/v1/chat/completions', { model: 'deepseek-v4', messages: [{ role: 'user', content: 'hi' }] })).status, 200)
  assert.equal(JSON.parse(f.calls[0].body.toString()).model, 'gpt6')
  // 已知真实名称仍可直接请求，隐藏只是目录展示。
  assert.equal((await post(f, '/v1/chat/completions', { model: 'gpt6', messages: [{ role: 'user', content: 'hi' }] })).status, 200)
  assert.equal(JSON.parse(f.calls[1].body.toString()).model, 'gpt6')
  assert.equal(f.db.getData().logs[0].model, 'gpt6')
  assert.equal(f.db.getData().logs[1].model, 'deepseek-v4')
  assert.equal(f.db.getData().logs[1].resolvedModel, 'gpt6')
  assert.equal(f.db.getData().logs[1].upstreamProtocol, 'openai-chat')
  // 显示原名开启后，下游目录同时包含真实名称与所有别名。
  f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['deepseek-v4', 'company-chat'], showOriginal: true })
  const visibleCatalog = JSON.parse((await get(f, '/v1/models')).body.toString())
  assert.deepEqual(visibleCatalog.data.map((item) => item.id), ['company-chat', 'deepseek-v4', 'gpt6'])
  f.db.saveSettings({ enableModelAliases: false })
  assert.equal((await post(f, '/v1/chat/completions', { model: 'deepseek-v4', messages: [{ role: 'user', content: 'hi' }] })).status, 503)
  const disabledCatalog = JSON.parse((await get(f, '/v1/models')).body.toString())
  assert.deepEqual(disabledCatalog.data.map((item) => item.id), ['gpt6'])
  assert.equal(f.manager.getAllAvailableModels().includes('deepseek-v4'), false)
})

test('alias validation rejects duplicate and conflicting names without discarding saved config', async (t) => {
  const f = await fixture(t)
  const platform = f.platform('http://localhost:1', ['key'], { models: ['gpt6', 'other-model'] })
  f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['deepseek-v4'], showOriginal: true })
  assert.throws(() => f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['deepseek-v4', 'deepseek-v4'], showOriginal: true }), /别名重复/)
  assert.throws(() => f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['other-model'], showOriginal: true }), /冲突/)
  assert.throws(() => f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['gpt6'], showOriginal: true }), /同名/)
  assert.deepEqual(f.db.getData().platforms[0].modelAliases[0].aliases, ['deepseek-v4'])
  assert.throws(() => f.db.saveModelAliases({ platformId: platform.id, model: 'gpt6', aliases: ['new-name'], showOriginal: true, expectedAliases: [] }), /已被其他操作修改/)
})

test('Gemini native paths accept query keys locally without forwarding them and discover models with x-goog-api-key', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream((call, res) => {
    if (call.url.startsWith('/v1beta/models?pageToken=')) return jsonResponse(res, { models: [{ name: 'models/second' }] })
    if (call.url === '/v1beta/models') return jsonResponse(res, { models: [{ name: 'models/first' }], nextPageToken: 'next' })
    jsonResponse(res, { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } })
  })
  const platform = f.platform(url, ['google-key'], { upstreamProtocol: 'gemini', models: ['gemini-model'], type: 'custom' })
  await f.start()
  const withQueryKey = await request(f.port, { path: `/v1beta/models/gemini-model:generateContent?key=${encodeURIComponent(f.key)}&alt=json`, headers: { 'content-type': 'application/json' } }, Buffer.from(JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })))
  assert.equal(withQueryKey.status, 200)
  const call = f.calls[0]
  assert.equal(call.headers['x-goog-api-key'], 'google-key')
  assert.equal(call.headers.authorization, undefined)
  assert.equal(call.url.includes('key='), false)
  assert.equal(call.url, '/v1beta/models/gemini-model:generateContent?alt=json')
  assert.deepEqual(await f.proxy.fetchUpstreamModels(platform.id), ['first', 'second'])
  assert.equal(f.calls[1].url, '/v1beta/models')
  assert.equal(f.calls[2].url, '/v1beta/models?pageToken=next')
  assert(f.calls.every((item) => item.headers['x-goog-api-key'] === 'google-key'))
  const geminiCatalog = JSON.parse((await get(f, '/v1beta/models')).body.toString())
  assert.deepEqual(geminiCatalog.models.map((item) => item.name), ['models/first', 'models/second'])
})

test('streaming tool calls convert incrementally with matching ids and arguments', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream(async (_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"id":"chat_tool","model":"gpt6","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}\n\n')
    res.write('data: {"id":"chat_tool","model":"gpt6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}\n\n')
    await delay(20)
    res.write('data: {"id":"chat_tool","model":"gpt6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]}}]}\n\n')
    res.end('data: {"id":"chat_tool","model":"gpt6","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
  })
  f.platform(url, ['chat-key'], { upstreamProtocol: 'openai-chat', models: ['gpt6'] })
  await f.start()
  const result = await post(f, '/v1/messages', {
    model: 'gpt6', max_tokens: 64, stream: true,
    tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    messages: [{ role: 'user', content: 'weather in Paris?' }]
  })
  assert.equal(result.status, 200)
  const frames = result.body.toString().split('\n\n').filter(Boolean).map((frame) => frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim()).filter(Boolean).map((data) => JSON.parse(data))
  const start = frames.find((frame) => frame.type === 'content_block_start' && frame.content_block.type === 'tool_use')
  assert.equal(start.content_block.id, 'call_weather')
  assert.equal(start.content_block.name, 'get_weather')
  const argumentsText = frames.filter((frame) => frame.type === 'content_block_delta' && frame.delta.type === 'input_json_delta').map((frame) => frame.delta.partial_json).join('')
  assert.deepEqual(JSON.parse(argumentsText), { city: 'Paris' })
  const delta = frames.find((frame) => frame.type === 'message_delta')
  assert.equal(delta.delta.stop_reason, 'tool_use')
  const upstreamBody = JSON.parse(f.calls[0].body.toString())
  assert.equal(upstreamBody.stream, true)
  assert.equal(upstreamBody.tools[0].function.name, 'get_weather')
})

test('base64 images convert while external image URLs fail with a field-level 400', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream((call, res) => {
    const body = JSON.parse(call.body.toString())
    const inline = body.contents[0].parts.find((part) => part.inlineData)
    jsonResponse(res, { candidates: [{ content: { role: 'model', parts: [{ text: inline ? inline.inlineData.data : 'none' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } })
  })
  f.platform(url, ['google-key'], { upstreamProtocol: 'gemini', models: ['gemini-model'], type: 'custom' })
  await f.start()
  const converted = await post(f, '/v1/messages', { model: 'gemini-model', max_tokens: 32, messages: [{ role: 'user', content: [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
  ] }] })
  assert.equal(converted.status, 200)
  assert.equal(JSON.parse(converted.body.toString()).content[0].text, 'aGVsbG8=')
  const upstreamBody = JSON.parse(f.calls[0].body.toString())
  assert.deepEqual(upstreamBody.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } })
  const rejected = await post(f, '/v1/messages', { model: 'gemini-model', max_tokens: 32, messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } }
  ] }] })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.toString(), /image|图片/i)
  assert.equal(f.calls.length, 1)
})

test('unsupported cross-protocol parameters and upstream errors return protocol-shaped bodies', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream((call, res) => jsonResponse(res, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '0.1' }))
  f.platform(url, ['anth-key'], { upstreamProtocol: 'anthropic', type: 'anthropic' })
  await f.start()
  const rejected = await post(f, '/v1/chat/completions', { model: 'm', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.toString(), /response_format/)
  assert.equal(f.calls.length, 0)
  const upstreamError = await post(f, '/v1/responses', { model: 'm', input: 'hi' })
  assert.equal(upstreamError.status, 429)
  const body = JSON.parse(upstreamError.body.toString())
  assert.equal(body.error.message, 'slow down')
  assert.equal(f.calls.length, 1)
})

test('converted responses keep the upstream model identity and use downstream usage fields', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => jsonResponse(res, { id: 'chat_up', object: 'chat.completion', created: 1, model: 'real-gpt6', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })),
    ['chat-key'], { upstreamProtocol: 'openai-chat', models: ['public-model'] })
  await f.start()
  const anthropic = JSON.parse((await post(f, '/v1/messages', { model: 'public-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] })).body.toString())
  assert.equal(anthropic.model, 'real-gpt6')
  assert.deepEqual(anthropic.usage, { input_tokens: 5, output_tokens: 2 })
  const responses = JSON.parse((await post(f, '/v1/responses', { model: 'public-model', input: 'hi' })).body.toString())
  assert.equal(responses.model, 'real-gpt6')
  assert.equal(responses.usage.input_tokens, 5)
  assert.equal(responses.usage.output_tokens, 2)
  assert.equal(responses.usage.total_tokens, 7)
  assert.equal(f.db.getData().logs[0].resolvedModel, 'public-model')
})

test('non-stream downstream aggregates upstream SSE and forces upstream streaming', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream(async (_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hel"}}]}\n\n')
    await delay(15)
    res.end('data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n')
  })
  f.platform(url, ['chat-key'], { upstreamProtocol: 'openai-chat', models: ['gpt6'] })
  await f.start()
  const result = await post(f, '/v1/messages', { model: 'gpt6', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.status, 200)
  assert.match(String(result.headers['content-type']), /json/i)
  const body = JSON.parse(result.body.toString())
  assert.equal(body.model, 'gpt6')
  assert.equal(body.content[0].text, 'hello')
  assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 2 })
  assert.equal(JSON.parse(f.calls[0].body.toString()).stream, true)
  assert.equal(f.db.getData().logs[0].stream, false)
})

test('optional reasoning fields and assistant images are ignored instead of failing conversion', async (t) => {
  const f = await fixture(t)
  const inspected = []
  const url = await f.upstream((call, res) => {
    const body = JSON.parse(call.body.toString())
    inspected.push(body)
    jsonResponse(res, {
      id: 'resp_ok', object: 'response', status: 'completed', model: body.model,
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { id: 'msg_ok', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }
      ],
      usage: { input_tokens: 3, output_tokens: 2 }
    })
  })
  f.platform(url, ['resp-key'], { upstreamProtocol: 'openai-responses', models: ['gpt6'] })
  await f.start()
  const anthropic = await post(f, '/v1/messages', {
    model: 'gpt6', max_tokens: 64, thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'see image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'sig' }, { type: 'text', text: 'I saw it' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
      { role: 'user', content: 'continue' }
    ]
  })
  assert.equal(anthropic.status, 200)
  assert.equal(JSON.parse(anthropic.body.toString()).content[0].text, 'ok')
  const first = inspected[0]
  assert.equal(first.thinking, undefined)
  assert.equal(first.output_config, undefined)
  assert.equal(first.stream, true)
  assert.equal(JSON.stringify(first.input).split('input_image').length - 1, 1)
  const chat = await post(f, '/v1/chat/completions', {
    model: 'gpt6', reasoning_effort: 'high', logprobs: true,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'see image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'I saw it' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] },
      { role: 'user', content: 'continue' }
    ]
  })
  assert.equal(chat.status, 200)
  assert.equal(JSON.parse(chat.body.toString()).choices[0].message.content, 'ok')
  const second = inspected[1]
  assert.equal(second.reasoning_effort, undefined)
  assert.equal(second.logprobs, undefined)
  assert.equal(JSON.stringify(second.input).split('input_image').length - 1, 1)
})

test('streaming Responses reasoning items are skipped without leaking into downstream text', async (t) => {
  const f = await fixture(t)
  const url = await f.upstream(async (_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","model":"gpt6","status":"in_progress"}}\n\n')
    res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n')
    res.write('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"delta":"thought"}\n\n')
    res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n')
    res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":2,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n')
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":2,"delta":"hi"}\n\n')
    res.write('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":2,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}\n\n')
    res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt6","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":3,"output_tokens":2}}}\n\n')
  })
  f.platform(url, ['resp-key'], { upstreamProtocol: 'openai-responses', models: ['gpt6'] })
  await f.start()
  const result = await post(f, '/v1/chat/completions', { model: 'gpt6', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(result.status, 200)
  const text = result.body.toString()
  assert.equal(sseText('openai-chat', result.body), 'hi')
  assert.equal(text.includes('thought'), false)
})



