<div align="center">

<img src="image/README/1782339203856.png" alt="Keyhide"/>

<h1>Keyhide</h1>

<h3>Local AI Relay & API Key Protection Service</h3>

<h3>本地 AI 中转服务 · API 密钥保护 · 多平台聚合代理</h3>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.1.0-purple.svg)](https://github.com/relliex/Keyhide/releases)
[![Electron](https://img.shields.io/badge/Electron-45-47848F.svg)](https://www.electronjs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-blue.svg)](https://github.com/relliex/Keyhide/releases)

</div>

---

## 📖 目录 / Table of Contents

- [中文说明](#中文说明)
- [English Documentation](#english-documentation)

---

## 中文说明

### 这是什么？

Keyhide 是一个运行在本地的 AI 中转代理服务。它为你生成一组**伪装的 URL 和 API Key**，你的开发项目使用这组伪装凭证调用 Keyhide，Keyhide 再转发请求到你真实的上游 AI 平台（OpenAI、Anthropic 或任何兼容的中转站）。

**核心价值**：当你把项目上传到 GitHub 时，代码里只有伪装凭证，真实的 API Key 永远留在本地，不会泄露。

### 🆕 1.1.0 更新

- 四种生成接口双向适配：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini Native generateContent。上游选择实际支持的一种，下游可使用任意一种，转换自动完成。
- 模型别名：为真实模型配置多个公开名称，并可选择是否继续显示原名；下游请求别名时自动替换为真实模型。
- Key 故障处理提供三档策略：暂时冷却、完全忽略错误、出错即禁用；普通限流不会再一律标记为额度耗尽。
- 改进了 Claude `thinking`、助手历史图片、Responses reasoning 等常见字段的跨协议兼容性。

### 🎯 适用场景

| 场景                     | 说明                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **密钥保护**       | 开发 AI 应用或使用需要外接 URL 与 API Key 的 AI 工具时，通过 Keyhide 中转调用，真实 Key 永不暴露在项目代码中                                  |
| **聚合统一调用**   | 将所有平台的 URL 和 API Key 聚合到本地统一入口，Keyhide 根据模型名自动路由到对应平台，单平台多 Key 额度用完自动接力切换，全程无需改配置改代码 |
| **开发/生产隔离**  | 切换上游平台只需改 Keyhide 配置，无需修改应用代码，开发环境用便宜模型、生产环境用强模型一键切换                                               |
| **请求日志与监控** | 自动记录每次调用的耗时、Token 用量、成功/失败状态，方便排查问题和统计成本                                                                     |

### ✨ 功能特性

| 功能                    | 说明                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| **密钥保护**      | 生成伪装 URL 和 API Key，真实密钥永不暴露给项目代码                                                      |
| **多平台聚合**    | 同时接入多个 AI 平台（Anthropic / OpenAI Chat / OpenAI Responses / Gemini），统一入口 |
| **多 Key 轮询**   | 单个平台配置多个 Key，支持轮询 / 优先级 / 加权 / 随机策略                                                |
| **自动故障转移**  | Key 报错或超时自动切换到下一个可用 Key；故障处理支持冷却、忽略或禁用三档策略                              |
| **协议自动转换**  | 下游四种生成接口与上游接口不同时自动转换请求和响应，无法表达的可选字段会安全忽略                          |
| **模型别名**      | 为真实模型设置多个公开名称，并可选是否继续公开原名                                                        |
| **全格式兼容**    | 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Gemini generateContent               |
| **流式响应**      | 完整支持 SSE 流式转发与跨协议流式转换                                                                     |
| **加密存储**      | 配置数据加密保存在本机；请勿分享数据目录或包含真实凭证的导出文件                                          |
| **模型列表**      | 自动获取上游模型列表，支持搜索和一键复制                                                                 |
| **请求日志**      | 记录每次请求的状态、耗时、Token 用量，支持筛选和统计                                                     |
| **数据管理**      | 支持重置统计数据和清除所有数据，灵活管理本地存储                                                         |
| **批量 Key 操作** | 一键全部启用 / 禁用某个平台的所有 Key                                                                    |

### 🚀 快速上手

#### 方式一：下载安装包（推荐普通用户）

1. 前往 [Releases](../../releases) 页面下载最新版本
2. 运行 `Keyhide-Setup-1.1.0.exe` 安装，或使用 `Keyhide-Portable-1.1.0.exe` 免安装运行
3. 打开 Keyhide，进入「上游平台」页面
4. 点击「添加平台」，填写：
   - **平台名称**：例如 `OpenAI 官方`
   - **认证方式**：选择 `Bearer`、`x-api-key` 或自定义请求头
   - **上游接口格式**：选择上游实际支持的生成接口
   - **Base URL**：例如 `https://api.openai.com`（可带或不带 `/v1`）
   - **API Key**：填入你的真实 Key
5. 点击「获取模型」拉取可用模型列表；需要伪装模型名时，在「模型目录」配置别名
6. 进入「代理服务」页面，启动代理服务
7. 复制**伪装 URL** 和**伪装 API Key**，用它们替换你项目中的真实凭证

#### 方式二：从源码构建（推荐开发者）

```bash
# 1. 克隆仓库
git clone https://github.com/relliex/Keyhide.git
cd Keyhide

# 2. 安装依赖
npm install

# 3. 开发模式运行
npm run dev

# 4. 打包构建
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

### 🛠 在项目中使用

配置好 Keyhide 后，只需把项目中的 API 配置改为伪装凭证：

**Python (OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-keyhide-xxxxxxxxxxxx",  # Keyhide 生成的伪装 Key
    base_url="http://127.0.0.1:7860/v1"  # Keyhide 的本地地址
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**Python (Anthropic SDK)**

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="sk-keyhide-xxxxxxxxxxxx",
    base_url="http://127.0.0.1:7860"
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**Node.js**

```javascript
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: 'sk-keyhide-xxxxxxxxxxxx',
  baseURL: 'http://127.0.0.1:7860/v1'
})
```

### ⚙️ 高级配置

#### 路由模式

| 模式                        | 说明                                               |
| --------------------------- | -------------------------------------------------- |
| **自动 (auto)**       | 优先使用默认平台，若不支持该模型则自动查找其他平台 |
| **按模型 (by-model)** | 严格根据模型名查找支持该模型的平台                 |
| **按路径 (by-path)**  | 所有请求都使用默认平台                             |

你也可以在请求路径中指定平台：`http://127.0.0.1:7860/{platformId}/v1/chat/completions`

#### 容错配置

- **Key 故障处理方式**：可选择暂时冷却、完全忽略错误或出错即禁用 Key
- 暂时冷却会在冷却结束后自动重试；出错即禁用需要到「上游平台」页面手动恢复
- 请求参数类错误不会改变 Key 状态

#### 数据存储位置

配置数据加密保存在本机。请勿分享数据目录或包含真实凭证的导出文件。

### 🏗 技术栈

- **Electron 45** — 跨平台桌面应用框架
- **React 18 + TypeScript** — 前端 UI
- **Vite 8** — 构建工具
- **Fastify 5** — HTTP 代理服务器
- **Tailwind CSS 3** — 样式
- **Zustand** — 状态管理

### 📁 项目结构

```
Keyhide/
├── electron/
│   ├── main/
│   │   ├── database.ts       # 数据存储
│   │   ├── proxy-server.ts   # 代理服务器（Fastify）
│   │   ├── ipc.ts            # IPC 通信
│   │   ├── window.ts         # 窗口管理
│   │   ├── index.ts          # 主进程入口
│   │   ├── protocols/        # 四协议转换与 SSE
│   │   └── upstream/
│   │       └── manager.ts    # 负载均衡与故障转移
│   ├── preload/
│   │   └── index.ts          # 预加载脚本
│   └── shared/
│       ├── types.ts          # 共享类型定义
│       ├── models.ts         # 模型别名规则
│       └── protocols.ts      # 协议路径与标签
├── src/
│   ├── components/            # UI 组件
│   ├── pages/                 # 页面（工作台/平台/模型/代理/日志/设置）
│   ├── stores/                # Zustand 状态管理
│   └── main.tsx               # 渲染进程入口
├── resources/
│   └── icon.png               # 应用图标
└── package.json
```

### 🔒 安全说明

- 默认绑定 `127.0.0.1`，**仅本机访问**，不暴露到公网
- 配置数据加密保存在本机；请勿分享数据目录或导出文件
- 伪装 API Key 仅存在于本地配置中
- 上游真实 Key 不会通过代理响应泄露给调用方

> ⚠️ 如果将监听地址改为 `0.0.0.0` 以共享给局域网，请注意 API Key 会以 HTTP 明文传输，建议配合防火墙使用。

### 📄 许可证

[MIT License](LICENSE)

---

## English Documentation

### What is this?

Keyhide is a local AI relay proxy service. It generates a pair of **masked URL and API Key** for your development projects. Your projects use these masked credentials to call Keyhide, which then forwards requests to your real upstream AI platforms (OpenAI, Anthropic, or any compatible relay service).

**Core value**: When you upload your project to GitHub, the code only contains masked credentials — your real API keys never leave your local machine.

### 🆕 What's New in 1.1.0

- Bidirectional support for four generation APIs: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini Native generateContent. Choose one for the upstream and use any of them downstream.
- Model aliases: publish multiple names for a real upstream model and optionally keep the original name visible.
- Three key error policies: temporary cooldown, fully ignore errors, or disable the key.
- Improved cross-protocol compatibility for Claude `thinking`, assistant-history images and Responses reasoning items.

### 🎯 Use Cases

| Use Case                               | Description                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Key Protection**               | When developing AI apps or using AI tools that require external URL and API key, relay through Keyhide to keep your real keys out of project code                                                                                          |
| **Unified Aggregation**          | Aggregate all platform URLs and API keys into a single local entry point. Keyhide auto-routes requests to the correct platform by model name, and auto-relays across multiple keys when quota runs out — no config or code changes needed |
| **Dev/Prod Isolation**           | Switch upstream platforms by simply changing Keyhide config — no code changes needed. Use cheap models in dev, powerful models in prod with one click                                                                                     |
| **Request Logging & Monitoring** | Automatically records duration, token usage, and success/failure status for each call — easy debugging and cost tracking                                                                                                                  |

### ✨ Features

| Feature                          | Description                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Key Protection**         | Generates masked URL and API Key; real keys are never exposed to project code                                       |
| **Multi-Platform**         | Connect multiple AI platforms (Anthropic / OpenAI Chat / OpenAI Responses / Gemini) with a unified entry point       |
| **Multi-Key Rotation**     | Configure multiple keys per platform with round-robin / priority / weighted / random strategies                     |
| **Auto Failover**          | Switches to the next available key on errors or timeouts; supports cooldown, ignore and disable policies            |
| **Protocol Conversion**    | Converts requests and responses automatically between the four downstream and upstream generation APIs              |
| **Model Aliases**          | Publish multiple public names for one real model and optionally keep the original name visible                       |
| **Full API Compatibility** | Supports Anthropic Messages, OpenAI Chat Completions, OpenAI Responses and Gemini generateContent                   |
| **Streaming Support**      | Full SSE passthrough and cross-protocol streaming conversion                                                        |
| **Encrypted Storage**      | Configuration data is encrypted on the local machine; do not share the data directory or exported config files      |
| **Model List**             | Auto-fetches upstream model lists with search and one-click copy                                                    |
| **Request Logging**        | Records status, duration, and token usage for each request with filtering and statistics                            |
| **Data Management**        | Reset statistics or clear all data with confirmation dialogs                                                        |
| **Bulk Key Operations**    | Enable / disable all keys for a platform with one click                                                             |

### 🚀 Quick Start

#### Option 1: Download Installer (Recommended for users)

1. Go to the [Releases](../../releases) page and download the latest version
2. Run `Keyhide-Setup-1.1.0.exe` to install, or use `Keyhide-Portable-1.1.0.exe` for portable mode
3. Open Keyhide and navigate to the **Upstream Platforms** page
4. Click **Add Platform** and fill in:
   - **Platform Name**: e.g., `OpenAI Official`
   - **Authentication**: `Bearer`, `x-api-key`, or custom headers
   - **Upstream Protocol**: the generation API the upstream actually supports
   - **Base URL**: e.g., `https://api.openai.com` (with or without `/v1`)
   - **API Key**: Enter your real key
5. Click **Fetch Models**; configure aliases in **Models** if you want to mask real model names
6. Go to the **Proxy Service** page and start the proxy
7. Copy the **masked URL** and **masked API Key** — use them to replace real credentials in your project

#### Option 2: Build from Source (Recommended for developers)

```bash
# 1. Clone the repository
git clone https://github.com/relliex/Keyhide.git
cd Keyhide

# 2. Install dependencies
npm install

# 3. Run in development mode
npm run dev

# 4. Build and package
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

### 🛠 Usage in Your Projects

After configuring Keyhide, simply replace your project's API credentials with the masked ones:

**Python (OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-keyhide-xxxxxxxxxxxx",  # Masked key from Keyhide
    base_url="http://127.0.0.1:7860/v1"  # Keyhide local address
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**Python (Anthropic SDK)**

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="sk-keyhide-xxxxxxxxxxxx",
    base_url="http://127.0.0.1:7860"
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**Node.js**

```javascript
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: 'sk-keyhide-xxxxxxxxxxxx',
  baseURL: 'http://127.0.0.1:7860/v1'
})
```

### ⚙️ Advanced Configuration

#### Routing Modes

| Mode               | Description                                                                         |
| ------------------ | ----------------------------------------------------------------------------------- |
| **Auto**     | Uses default platform first; auto-finds other platforms if the model is unsupported |
| **By Model** | Strictly finds platforms that support the requested model                           |
| **By Path**  | All requests use the default platform                                               |

You can also specify a platform in the request path: `http://127.0.0.1:7860/{platformId}/v1/chat/completions`

#### Fault Tolerance

- **Key error policy**: temporary cooldown, fully ignore errors, or disable the key on error
- Cooldown retries automatically after expiry; disabled keys must be re-enabled in the **Upstream Platforms** page
- Validation errors never change key state

#### Data Storage Location

Configuration data is encrypted on the local machine. Do not share the data directory or exported config files.

### 🏗 Tech Stack

- **Electron 45** — Cross-platform desktop framework
- **React 18 + TypeScript** — Frontend UI
- **Vite 8** — Build tool
- **Fastify 5** — HTTP proxy server
- **Tailwind CSS 3** — Styling
- **Zustand** — State management

### 📁 Project Structure

```
Keyhide/
├── electron/
│   ├── main/
│   │   ├── database.ts       # Data storage
│   │   ├── proxy-server.ts   # Proxy server (Fastify)
│   │   ├── ipc.ts            # IPC communication
│   │   ├── window.ts         # Window management
│   │   ├── index.ts          # Main process entry
│   │   ├── protocols/        # Four-protocol conversion & SSE
│   │   └── upstream/
│   │       └── manager.ts    # Load balancing & failover
│   ├── preload/
│   │   └── index.ts          # Preload script
│   └── shared/
│       ├── types.ts          # Shared type definitions
│       ├── models.ts         # Model alias rules
│       └── protocols.ts      # Protocol paths & labels
├── src/
│   ├── components/            # UI components
│   ├── pages/                 # Pages (Dashboard/Platforms/Models/Proxy/Logs/Settings)
│   ├── stores/                # Zustand state management
│   └── main.tsx               # Renderer process entry
├── resources/
│   └── icon.png               # App icon
└── package.json
```

### 🔒 Security Notes

- Binds to `127.0.0.1` by default — **localhost only**, not exposed to the public internet
- Configuration data is encrypted on the local machine; do not share the data directory or exported files
- Masked API Key exists only in local configuration
- Upstream real keys are never leaked through proxy responses

> ⚠️ If you change the listen address to `0.0.0.0` to share with your LAN, note that API keys will be transmitted in HTTP plaintext. Use with firewall protection.

### 📄 License

[MIT License](LICENSE)

---

<div align="center">

**Made with care for developers who value security.**

</div>
