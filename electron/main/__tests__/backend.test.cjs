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
      return db.savePlatform({ ...db.createNewPlatform(), name: 'Mock platform', baseUrl, models: ['m'], keys: keys.map((value, index) => db.createNewKey(value, `Key ${index + 1}`)), ...overrides })
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
})

test('401 rejection fails over to another key and logs the final successful attempt', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((call, res) => jsonResponse(res, call.headers.authorization === 'Bearer bad' ? { error: 'bad key' } : { usage: { prompt_tokens: 1, completion_tokens: 2 } }, call.headers.authorization === 'Bearer bad' ? 401 : 200)), ['bad', 'good'])
  await f.start()
  assert.equal((await f.json()).status, 200)
  assert.equal(f.calls.length, 2)
  const data = f.db.getData()
  assert.equal(data.platforms[0].keys[0].status, 'disabled')
  assert.equal(data.platforms[0].keys[0].requestCount, 1)
  assert.equal(data.platforms[0].keys[1].requestCount, 1)
  assert.equal(data.logs[0].statusCode, 200)
  assert.equal(data.logs[0].keyLabel, 'Key 2')
  assert.equal(data.logs[0].error, null)
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

test('quota-specific 429 exhausts keys but validation errors never auto-disable healthy keys', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((call, res) => jsonResponse(res, { error: { code: call.url.includes('quota') ? 'insufficient_quota' : 'invalid_request_error' } }, call.url.includes('quota') ? 429 : 400)), ['a', 'b'])
  await f.start()
  const quota = await f.json({}, { path: '/v1/quota' })
  assert.equal(quota.status, 429)
  assert.ok(f.db.getData().platforms[0].keys.every((key) => key.status === 'exhausted'))
  f.db.resetStats(); f.manager.clearRoutingState()
  f.db.saveSettings({ autoDisableKeyOnError: true })
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
  assert.equal(saved.keys[0].status, 'disabled')
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
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'disabled')
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
  assert.equal(f.db.getData().platforms[0].keys[0].status, 'disabled')
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

test('health is 1.0.1, invalid auth is local-only, and query secrets are redacted in logs', async (t) => {
  const f = await fixture(t)
  f.platform(await f.upstream((_call, res) => jsonResponse(res, {})))
  await f.start()
  const health = await request(f.port, { path: '/health', method: 'GET' })
  assert.equal(JSON.parse(health.body).version, '1.0.1')
  assert.equal((await request(f.port, { headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.json({ model: 'm' }, { path: '/v1/chat/completions?api_key=private&x=ok' })).status, 200)
  assert.equal(f.db.getData().logs[0].path, '/v1/chat/completions?api_key=[REDACTED]&x=ok')
})
