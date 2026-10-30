<div align="center">

<img src="image/README/1782339203856.png" alt="Keyhide"/>

<h1>Keyhide 1.0.1</h1>
<h3>本地 AI 中转与 API 密钥保护工作台</h3>

[MIT License](LICENSE) · Windows x64 · 本地优化版本，未发布

</div>

## 中文说明

### 用途与安全边界

Keyhide 为应用提供本地 HTTP 地址和独立的接入 Key，再使用保存在本机的真实 Key 向 OpenAI、Anthropic 或兼容上游转发请求。更换真实凭证、模型目录和路由策略不需要修改应用中的接入配置。

接入 Key **仍是凭证，不应该提交到公开仓库**；能够访问代理并持有接入 Key 的调用方可以消耗上游额度。默认监听 `127.0.0.1`，仅本机可访问。若绑定 `0.0.0.0` 或 `::`，请自行限制防火墙和可信客户端；内置服务没有 TLS，局域网流量也可能是明文。

配置延续原有 AES-256-GCM 加密格式，密钥派生依赖机器名、用户名和本地 salt。这不是操作系统密钥库，**不能防御同用户权限的恶意进程**。导出的配置包含明文真实 Key、接入 Key 和自定义请求头，应仅保存在可信位置。透明转发不会检查或重写上游响应正文，请同时信任上游服务。

### 1.0.1 工作空间

- 深蓝本地工作空间，统一表单、按钮、状态反馈和键盘焦点；窄窗口自动收起导航文字。
- 六个独立页面：工作台、上游平台、模型目录、代理服务、请求日志、设置与路由。
- 本地 hash 路由；模型和日志筛选保留在 URL 中，刷新后仍可恢复。
- `Ctrl+K` 快速导航，`Alt+1` 至 `Alt+6` 切换页面；对话框支持焦点约束、Escape 和焦点恢复。
- 平台编辑支持批量粘贴 Key，保存时直接接纳尚未点击添加的 Key；编辑草稿不直接修改已保存数据。
- 代理和路由配置明确保存或放弃，离开未保存页面会提示；删除、重置、导出和接入 Key 轮换均要求确认。
- 模型目录跨平台去重、搜索、平台筛选和分页；路由预览只读取配置，不发送请求或改变轮询计数。
- 日志提供搜索、状态/协议/时间筛选、分页、详情、冻结显示和脱敏导出；统计只覆盖当前保留日志，并非历史总量或账单。
- 单实例、窗口尺寸恢复和真实托盘操作；退出时停止服务、取消活动请求并刷新统计。

### 本地运行与构建

安装构建产物使用 `release/Keyhide-Setup-1.0.1.exe`；免安装产物为 `release/Keyhide-Portable-1.0.1.exe`。免安装只表示不需要安装程序，配置仍写入正常的本机用户目录。

从源码运行需要 Node.js 22.12+ 或满足当前构建工具要求的较新版本。

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build:win
```

Windows 构建生成 NSIS 安装包、免安装包和 `release/win-unpacked/`。所有打包脚本指定 `--publish never`，不会上传 GitHub Release。macOS/Linux 脚本保留，但这次本地交付仅验证 Windows。

### 接入流程

1. 在「上游平台」添加名称、协议、基础地址和真实 Key。基础地址可以包含已有 `/v1` 或服务路径前缀。
2. 点击「获取模型」，或手动填写上游实际支持的模型 ID。
3. 在「代理服务」保存监听配置并启动。
4. 从页面复制协议对应的接入地址和接入 Key。OpenAI SDK 使用 `http://127.0.0.1:7860/v1`；Anthropic SDK 使用 `http://127.0.0.1:7860`。
5. 在调用应用中设置实际模型 ID。页面提供的示例不会自动执行。

Keyhide **不进行 OpenAI 与 Anthropic 协议转换**。应为调用方配置对应协议的上游。

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_KEYHIDE_KEY",
    base_url="http://127.0.0.1:7860/v1",
)
response = client.chat.completions.create(
    model="YOUR_UPSTREAM_MODEL_ID",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="YOUR_KEYHIDE_KEY",
    base_url="http://127.0.0.1:7860",
)
message = client.messages.create(
    model="YOUR_UPSTREAM_MODEL_ID",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### 路由与故障处理

| 模式 | 行为 |
| --- | --- |
| 自动 | 在符合模型条件的平台中选择；支持精确模型目录和未知目录兜底，符合条件的默认平台优先。 |
| 按模型 | 有模型名的请求只匹配明确声明该模型的平台，不用空目录或默认平台兜底。无模型的端点可以选取可用平台。 |
| 按路径 | 未指定平台时只使用默认平台，不切换到其他平台。 |

显式平台地址 `http://127.0.0.1:7860/{platformId}/v1/...` 始终固定到该平台；无效、禁用或不可用的平台返回错误，不会悄悄转发到另一家。

- 支持轮询、优先级、加权随机和随机 Key 策略。
- 401 禁用凭证；明确的额度错误标记耗尽。普通 429 使用 `Retry-After` 或临时冷却，不一律视为额度耗尽。
- 关闭自动禁用时，可恢复的网络/服务故障采用临时冷却；普通参数错误不禁用健康 Key。
- 最多进行 8 次有界故障转移。401/403/429 拒绝可切换；可能已执行的 POST 在超时/5xx 后不会无条件重放，除非带有幂等键。GET/HEAD/OPTIONS 可安全重试，连接建立前的明确失败也可以切换。
- 保留请求字节、查询参数、基础路径、响应状态/头、压缩与二进制正文；支持 multipart 和 SSE，处理背压和客户端取消。
- SSE 已开始后不会切换上游；超时、断流或上游错误事件会记录为失败，已观察到的用量不会因客户端取消而丢弃。支持 gzip/deflate/br 的有界用量解析，非流式 JSON 和压缩正文观察上限为 5 MiB，单个 SSE 事件为 512 KiB；超出范围、未知编码或上游缺失用量时可能无法统计。Token 上限是本地估算，不是严格的费用控制，缺失用量不代表零计费。

### 存储与测试

正常数据目录：`%USERPROFILE%/AppData/LocalLow/Keyhide`，保存 `keyhide.enc`、`keyhide.salt` 和备份。配置写入先验证再原子替换；损坏文件保留并尝试从备份恢复。高频日志/统计合并写入，手动禁用状态不会被统计重置重新启用。原生配置与日志文件导出限制为 10 MiB；过大的日志导出需先缩小筛选范围。

```bash
npm run test:backend
```

```bash
npm run build
```

```bash
npm run test:desktop
```

测试使用隔离配置目录和本地模拟 HTTP 上游，不读取实际用户配置，不使用真实 Key 或发送付费请求。桌面脚本启动实际 Electron，操作页面、验证代理转发、导航、样式、窄窗口和托盘；可传入 `release/win-unpacked/Keyhide.exe` 验证打包程序。测试报告在忽略的 `test-results/` 中，界面截图在 `docs/screenshots/`。

`npm run dev:ui` 是明确标记的模拟数据浏览器预览，不启动真实代理，也不是桌面 IPC 验证的替代品。`KEYHIDE_USER_DATA_DIR` 供自动测试隔离窗口与配置目录，普通运行无需设置。

### 技术栈与目录

Electron 45、React 18、TypeScript、electron-vite 6 / Vite 8、Fastify 5、Tailwind CSS 3、Zustand 4、React Router 7、Zod 4。

- `electron/main/`：生命周期、验证、加密存储、IPC、代理服务。
- `electron/main/upstream/`：路由/Key 选择、透明 HTTP 转发、用量观察。
- `electron/main/__tests__/`：本地代理与持久化回归。
- `electron/preload/`、`electron/shared/`：隔离 IPC 桥接和共享类型。
- `src/components/`、`src/pages/`、`src/stores/`：工作空间界面。
- `tests/desktop-smoke.mjs`：实际 Electron 与打包程序接入验证。
- `resources/`：本地图标；`out/`：编译输出；`release/`：本地打包输出。

## English

Keyhide 1.0.1 is a local-only optimization build of the provider-neutral desktop API proxy. Applications use a local URL and a separate access key; real upstream credentials remain in the local configuration. The access key is still sensitive and must not be published. Anyone with network access and that key can consume upstream quota.

The workspace now has six hash-routed pages, persistent filters, model discovery, keyboard navigation, explicit form saves, unsaved-change guards, confirmation dialogs, retained-log statistics, and working tray/window lifecycle behavior. Requests remain transparent: Keyhide does not translate OpenAI and Anthropic protocols. Use the appropriate upstream and SDK base URL (OpenAI ends in `/v1`; Anthropic uses the local origin).

Explicit platform paths never fall through to another provider. Strict model routing requires a declared model. Ordinary rate limits cool down rather than becoming quota exhaustion. Retries are bounded and do not blindly replay possibly executed paid POST requests after timeouts or server errors. Binary, multipart, compressed and SSE responses are forwarded with cancellation and backpressure.

Configuration retains the original AES-GCM format and machine/user/salt-derived key. This is not an OS key vault and does not protect against malicious processes with the same user privileges. Configuration exports contain plaintext secrets. The default bind address is localhost; LAN binding requires firewall restrictions and awareness that the built-in proxy does not provide TLS.

Use `npm run dev`, `npm run build:win`, `npm run test:backend`, and `npm run test:desktop`. Packaging explicitly uses `--publish never`. Windows output names are `Keyhide-Setup-1.0.1.exe` and `Keyhide-Portable-1.0.1.exe`; portable execution still stores configuration in the normal user data location. Tests launch actual Electron with isolated data and local mock upstreams only. macOS and Linux packaging have not been verified for this delivery.

## License

[MIT](LICENSE)
