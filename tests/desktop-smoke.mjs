import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(project, 'test-results')
await mkdir(output, { recursive: true })
const userData = await mkdtemp(join(output, 'desktop-profile-'))
const screenshots = join(project, 'docs', 'screenshots')
await mkdir(screenshots, { recursive: true })
const passed = []
const errors = []
let application
let page
const upstreamRequests = []
let rateLimited = false
const upstream = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString()
  upstreamRequests.push({ url: request.url, headers: request.headers, body })
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('X-Request-Id', 'keyhide-desktop-smoke')
  if (request.url?.startsWith('/v1/models')) {
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'test-chat-model', object: 'model' }, { id: 'test-embedding-model', object: 'model' }] }))
  } else if (rateLimited) {
    response.writeHead(429, { 'Retry-After': '2' }).end(JSON.stringify({ error: { type: 'rate_limit_error' } }))
  } else if (request.headers.authorization !== 'Bearer upstream-smoke-only') {
    response.writeHead(401).end(JSON.stringify({ error: { message: 'Invalid test credential' } }))
  } else {
    response.end(JSON.stringify({ id: 'desktop-smoke', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'Local mock response' } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }))
  }
})
await new Promise((accept) => upstream.listen(0, '127.0.0.1', accept))
const upstreamPort = upstream.address().port
const freePortServer = createServer()
await new Promise((accept) => freePortServer.listen(0, '127.0.0.1', accept))
const proxyPort = freePortServer.address().port
await new Promise((accept) => freePortServer.close(accept))
const packaged = process.argv[2]
const packageLabel = packaged && /portable/i.test(packaged) ? 'portable' : 'packaged'
const environment = { ...process.env, KEYHIDE_USER_DATA_DIR: userData }
delete environment.ELECTRON_RUN_AS_NODE

async function check(name, operation) {
  await operation()
  passed.push(name)
  console.log(`PASS ${name}`)
}
async function savedData() { return page.evaluate(() => window.api.getData()) }

try {
  application = await _electron.launch({ executablePath: packaged ? resolve(packaged) : require('electron'), args: packaged ? [] : [project], cwd: project, env: environment, timeout: 60000 })
  application.process().on('exit', (code) => console.log(`Electron exited (${code})`))
  page = await application.firstWindow({ timeout: 60000 })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
  await check('Electron opens real workspace with isolated empty profile', async () => {
    assert.equal((await savedData()).platforms.length, 0)
    assert.equal(await page.getByText('让项目只看见本地凭证。', { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await page.evaluate(() => typeof window.api.previewRoute), 'function')
  })
  await check('Platform form validates fields and saves pending key without extra add step', async () => {
    await page.getByRole('link', { name: '上游平台', exact: true }).click()
    await page.getByRole('button', { name: '添加平台', exact: true }).first().click()
    await page.getByRole('button', { name: '保存平台', exact: true }).click()
    await page.getByText('请输入平台名称', { exact: true }).waitFor()
    await page.getByLabel('平台名称', { exact: true }).fill('本地回归测试平台')
    await page.getByLabel('上游基础地址', { exact: true }).fill(`http://127.0.0.1:${upstreamPort}/v1`)
    await page.getByLabel('添加 Key（每行一个，支持批量粘贴）', { exact: true }).fill('upstream-smoke-only')
    await page.getByLabel('Key 标签（可选）', { exact: true }).fill('回归验证 Key')
    await page.getByLabel('支持的模型（每行一个，也可用逗号分隔）', { exact: true }).fill('test-chat-model')
    await page.getByRole('button', { name: '保存平台', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const data = await savedData()
    assert.equal(data.platforms.length, 1)
    assert.equal(data.platforms[0].keys.length, 1)
    assert.equal(data.platforms[0].keys[0].key, 'upstream-smoke-only')
  })
  await check('Imported query URLs and fractional weights remain editable', async () => {
    const data = await savedData()
    const platform = data.platforms[0]
    const imported = { ...platform, baseUrl: `${platform.baseUrl}?api-version=local/`, keys: platform.keys.map((key) => ({ ...key, weight: 0.5, priority: -1, quotaLimit: 100.5 })) }
    const result = await page.evaluate((platform) => window.api.importConfig(JSON.stringify({ platforms: [platform] })), imported)
    assert.equal(result.success, true)
    await page.reload()
    await page.getByRole('link', { name: '上游平台', exact: true }).click()
    const header = page.getByRole('button', { name: /^本地回归测试平台/ })
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
    await page.getByRole('button', { name: '编辑平台', exact: true }).click()
    await page.getByLabel('平台名称', { exact: true }).fill('本地回归测试平台（已编辑）')
    await page.getByRole('button', { name: '保存平台', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const saved = (await savedData()).platforms[0]
    assert.equal(saved.baseUrl, imported.baseUrl)
    assert.equal(saved.keys[0].weight, 0.5)
    assert.equal(saved.keys[0].priority, -1)
    assert.equal(saved.keys[0].quotaLimit, 100.5)
    await page.evaluate((platform) => window.api.savePlatform(platform), platform)
    await page.reload()
  })
  await check('Fetch models runs against local mock and avoids duplicate v1', async () => {
    await page.getByRole('button', { name: '获取模型', exact: true }).click()
    await page.getByText('已获取 2 个模型', { exact: true }).waitFor()
    assert.deepEqual((await savedData()).platforms[0].models, ['test-chat-model', 'test-embedding-model'])
    assert(upstreamRequests.some((request) => request.url === '/v1/models'))
    assert(!upstreamRequests.some((request) => request.url.includes('/v1/v1')))
  })
  await check('Model directory search and copy work with keyboard-accessible actions', async () => {
    await page.getByRole('link', { name: '模型目录', exact: true }).click()
    await page.getByLabel('搜索模型或平台', { exact: true }).fill('embedding')
    assert.equal(await page.locator('tbody tr').count(), 1)
    await page.getByRole('button', { name: '复制名称', exact: true }).click()
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), 'test-embedding-model')
    await page.reload()
    await page.getByLabel('搜索模型或平台', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('搜索模型或平台', { exact: true }).inputValue(), 'embedding')
  })
  await check('Unsaved proxy form guards internal navigation and does not autosave', async () => {
    await page.getByRole('link', { name: '代理服务', exact: true }).click()
    await page.getByLabel('监听端口', { exact: true }).fill(String(proxyPort))
    await page.getByLabel('上游超时（秒）', { exact: true }).fill('120.0')
    assert.notEqual((await savedData()).proxy.port, proxyPort)
    await page.getByRole('link', { name: '工作台', exact: true }).click()
    await page.getByRole('dialog', { name: '离开前放弃修改？' }).waitFor()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.getByLabel('监听端口', { exact: true }).inputValue(), String(proxyPort))
    await page.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('代理配置已保存', { exact: true }).waitFor()
    assert.equal((await savedData()).proxy.port, proxyPort)
  })
  await check('Proxy starts through UI and enforces local authentication', async () => {
    await page.getByRole('button', { name: '启动服务', exact: true }).click()
    await page.getByRole('button', { name: '停止服务', exact: true }).waitFor()
    const unauthorized = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test-chat-model', messages: [] }) })
    assert.equal(unauthorized.status, 401)
    const data = await savedData()
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions?desktop=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.proxy.maskedApiKey}` }, body: JSON.stringify({ model: 'test-chat-model', messages: [{ role: 'user', content: 'local test only' }] }) })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'keyhide-desktop-smoke')
    assert.equal((await response.json()).usage.total_tokens, 16)
    assert(upstreamRequests.some((request) => request.url === '/v1/chat/completions?desktop=1'))
    assert.equal(await page.getByLabel('监听端口', { exact: true }).isDisabled(), true)
  })
  await check('Cooldown expiry automatically restores model actions without a successful request', async () => {
    const data = await savedData()
    rateLimited = true
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.proxy.maskedApiKey}` }, body: JSON.stringify({ model: 'test-chat-model', messages: [] }) })
    assert.equal(response.status, 429)
    await response.text()
    rateLimited = false
    await page.getByRole('link', { name: '上游平台', exact: true }).click()
    const header = page.getByRole('button', { name: /^本地回归测试平台/ })
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
    await page.getByText('冷却中', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '获取模型', exact: true }).isDisabled(), true)
    await page.getByText('可重试', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '获取模型', exact: true }).isDisabled(), false)
    await page.getByRole('button', { name: '获取模型', exact: true }).click()
    await page.getByText('可用', { exact: true }).waitFor()
    await page.getByRole('link', { name: '代理服务', exact: true }).click()
  })
  await check('Live request log reflects route, status and token count', async () => {
    await page.getByRole('link', { name: '请求日志', exact: true }).click()
    await page.getByRole('button', { name: /^查看 test-chat-model/ }).first().waitFor()
    await page.getByRole('button', { name: /^查看 test-chat-model/ }).first().click()
    await page.getByRole('dialog', { name: '请求详情' }).waitFor()
    assert((await page.getByRole('dialog').innerText()).includes('本地回归测试平台'))
    assert((await page.getByRole('dialog').innerText()).includes('16') || (await savedData()).logs.some((log) => log.promptTokens + log.completionTokens === 16))
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  })
  await check('Route preview is no-traffic, no-counter dry run', async () => {
    await page.getByRole('link', { name: '设置与路由', exact: true }).click()
    await page.getByLabel('关闭窗口后留在托盘', { exact: true }).click()
    await page.getByText('关闭窗口后留在托盘已开启', { exact: true }).waitFor()
    await page.getByLabel('模型名', { exact: true }).fill('test-chat-model')
    const count = upstreamRequests.length
    const before = (await savedData()).platforms[0].keys[0].requestCount
    await page.getByRole('button', { name: '预览路由', exact: true }).click()
    await page.getByText('目标平台：本地回归测试平台', { exact: true }).waitFor()
    assert.equal(upstreamRequests.length, count)
    assert.equal((await savedData()).platforms[0].keys[0].requestCount, before)
    const pinned = await page.evaluate(() => window.api.previewRoute({ model: 'test-chat-model', path: '/nonexistent/v1/chat/completions', format: 'openai' }))
    assert.equal(pinned.platformId, null)
    assert(pinned.error)
  })
  await check('Export and rotation require confirmation; Escape restores focused action', async () => {
    const exportButton = page.getByRole('button', { name: '导出配置', exact: true })
    await exportButton.click()
    await page.getByRole('dialog', { name: '导出包含明文密钥的配置？' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await exportButton.evaluate((element) => document.activeElement === element), true)
    await page.getByRole('link', { name: '代理服务', exact: true }).click()
    const keyBefore = (await savedData()).proxy.maskedApiKey
    await page.getByRole('button', { name: '重新生成', exact: true }).click()
    await page.getByRole('dialog', { name: '重新生成接入 Key？' }).waitFor()
    assert.equal((await savedData()).proxy.maskedApiKey, keyBefore)
    await page.getByRole('button', { name: '取消', exact: true }).click()
  })
  await check('Quick navigation and unknown local route recovery work', async () => {
    await page.keyboard.press('Control+k')
    await page.getByRole('dialog', { name: '快速导航' }).waitFor()
    await page.getByLabel('搜索页面或操作').fill('模型目录')
    await page.getByRole('option', { name: '模型目录 搜索模型与复制名称', exact: true }).waitFor()
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: '模型目录', exact: true }).waitFor()
    await page.evaluate(() => { window.location.hash = '/not-a-real-page' })
    await page.getByText('这个页面不存在', { exact: true }).waitFor()
    await page.getByRole('button', { name: '回到工作台', exact: true }).click()
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor()
  })
  await check('Button and badge variants retain production styles', async () => {
    const styles = await page.evaluate(() => {
      const properties = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, border: style.borderTopColor, padding: parseFloat(style.paddingLeft), size: parseFloat(style.fontSize) }
      }
      return { primary: properties('.button-primary'), secondary: properties('.button-secondary'), ghost: properties('.button-ghost'), small: properties('.button-sm'), badge: properties('.badge-success') }
    })
    assert.equal(styles.primary.background, 'rgb(121, 184, 255)')
    assert.equal(styles.secondary.background, 'rgb(28, 45, 70)')
    assert.equal(styles.ghost.border, 'rgba(0, 0, 0, 0)')
    assert(styles.small.padding >= 10)
    assert.equal(styles.small.size, 12)
    assert.equal(styles.badge.border, 'rgba(112, 209, 180, 0.25)')
  })
  await check('All six pages fit narrow desktop windows and dialogs remain reachable', async () => {
    for (const width of [960, 760]) {
      await application.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0].setBounds({ width, height: 600 }) }, width)
      for (const [label, heading] of [['工作台', '工作台'], ['上游平台', '上游平台'], ['模型目录', '模型目录'], ['代理服务', '代理服务'], ['请求日志', '请求日志'], ['设置与路由', '设置与路由']]) {
        await page.getByRole('link', { name: label, exact: true }).click()
        await page.getByRole('heading', { name: heading, exact: true }).waitFor()
        const dimensions = await page.locator('.workspace').evaluate((element) => ({ viewport: element.clientWidth, content: element.scrollWidth }))
        assert(dimensions.content <= dimensions.viewport + 1, `${label} overflows at ${width}px: ${JSON.stringify(dimensions)}`)
      }
    }
    await page.getByRole('link', { name: '上游平台', exact: true }).click()
    await page.getByRole('button', { name: /^本地回归测试平台/ }).click()
    await page.getByRole('button', { name: '编辑平台', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    const dimensions = await dialog.evaluate((element) => { const bounds = element.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight } })
    assert(dimensions.left >= 0 && dimensions.right <= dimensions.width && dimensions.top >= 0 && dimensions.bottom <= dimensions.height)
    await page.getByRole('button', { name: '保存平台', exact: true }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('link', { name: '工作台', exact: true }).click()
    await page.evaluate(() => { document.querySelectorAll('button[aria-label="关闭通知"]').forEach((button) => button.click()) })
    await page.screenshot({ path: join(screenshots, packaged ? `keyhide-${packageLabel}-compact.png` : 'keyhide-compact.png') })
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 860 }) })
  })
  await check('Desktop workspace screenshot is non-blank and correct version', async () => {
    assert((await page.locator('body').innerText()).includes('1.0.1'))
    await page.screenshot({ path: join(screenshots, packaged ? `keyhide-${packageLabel}-workspace.png` : 'keyhide-workspace.png') })
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    assert(!csp.includes('unsafe-eval'))
    assert(!csp.includes("script-src 'self' 'unsafe-inline'"))
  })
  await check('Closing to tray retains the same window; reopening works', async () => {
    const result = await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.close()
      const preserved = !win.isDestroyed() && !win.isVisible()
      win.show()
      return preserved
    })
    assert.equal(result, true)
  })
  await check('Proxy stops through UI and releases listening port', async () => {
    await page.getByRole('link', { name: '代理服务', exact: true }).click()
    await page.getByRole('button', { name: '停止服务', exact: true }).click()
    await page.getByRole('button', { name: '启动服务', exact: true }).waitFor()
    assert.equal((await savedData()).proxy.running, false)
    await assert.rejects(fetch(`http://127.0.0.1:${proxyPort}/health`))
  })
  assert.deepEqual(errors, [], `Renderer console/runtime errors: ${JSON.stringify(errors)}`)
  console.log(`All ${passed.length} desktop checks passed. No paid upstream requests were sent.`)
} catch (error) {
  console.error(error)
  if (page) await page.screenshot({ path: join(output, 'desktop-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  if (application) await application.close().catch(() => {})
  await new Promise((accept) => upstream.close(accept))
  await writeFile(join(output, packaged ? `${packageLabel}-desktop-results.json` : 'desktop-results.json'), JSON.stringify({ passed, errors, profile: userData, packaged: packaged || null, timestamp: new Date().toISOString(), success: !process.exitCode }, null, 2))
}
