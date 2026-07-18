# MCP-Browser-Bridge

一个浏览器扩展，把"你喜欢的搜索引擎 + 你正在浏览的网页"暴露成 MCP 工具，供
Claude Desktop、Cursor、Cline、Windsurf、Continue 等 **任何 MCP 客户端** 调用。

**亮点**：
- **AI 可直接操作网页**：通过 `eval_js` 在真实浏览器标签页里执行任意 JavaScript ——
  点击按钮、填写表单、读取 SPA 动态渲染内容、解析页面自身的 JS 状态（React/Vue/jQuery
  内部变量），相当于给 AI 一个真人浏览器。
- **适配所有 MCP 客户端**：同时实现 MCP `2025-06-18` Streamable HTTP（`/mcp` 端点 +
  `Mcp-Session-Id`）和 `2024-11-05` 旧版 SSE（`/sse` + `/messages`），客户端用哪种都行。
- **完全零外部依赖**：扩展是原生 ES Modules（无 npm 包、无构建步骤），native host 是
  纯 Python 标准库（无 pip 包），连图标都用标准库 `zlib`/`struct` 生成。
- **协议解析全部内置**：JSON-RPC 2.0 + MCP 协议在扩展内完整实现，native host 只做
  传输层 I/O 转发，端到端延迟极低。
- **用户可选端口与传输**：1024–65535 任意端口，三种传输模式（Streamable HTTP / 旧版 SSE /
  两者同开）。

## 工作原理

```
MCP 客户端 ──Streamable HTTP / SSE──▶ native host (host.py) ──native messaging──▶ 浏览器扩展
  (Claude Desktop, Cursor, ...)                                                │
                                                  ┌────────────────────────────┴────────────────────────────┐
                                                  │  内置 MCP 协议解析 (JSON-RPC 2.0 + MCP 2025-06-18)       │
                                                  │  搜索引擎配置 / 标签页管理 / JS 注入执行                  │
                                                  │  页面文本 & 链接识别 / SPA 状态解析                       │
                                                  └─────────────────────────────────────────────────────────┘
```

- **浏览器扩展（MV3 service worker）**：实现 MCP 协议解析、搜索引擎管理、标签页创建、
  页面内容提取（文本 + 链接）以及 **任意 JS 注入执行**。所有业务逻辑都在这里。
- **native messaging host（`native-host/host.py`，纯 Python 标准库）**：在用户选择的端口
  上起本地 HTTP/SSE 服务器，把 MCP 客户端的 JSON-RPC 帧原样转发给扩展，把扩展的响应
  原样推回客户端。**不解析、不改动任何协议内容**，只做传输层路由（session 管理、
  请求/响应关联），所以很快。

## 暴露的 MCP 工具

| 工具 | 说明 |
|------|------|
| `list_engines` | 列出已配置的搜索引擎（可选包含已禁用的） |
| `search` | 用指定引擎搜索，打开后台标签页，返回结构化结果（title / url / snippet） |
| `fetch_page` | 打开任意 URL，提取页面文本与所有链接 |
| `get_current_page` | 提取用户当前活动标签页的文本与链接 |
| `list_tabs` | 列出所有打开的标签页（id / url / title / active），用于挑选 `eval_js_tab` 目标 |
| `eval_js` | 打开指定 URL 的新后台标签页，等待加载后执行任意 JS，返回结果，关闭标签页 |
| `eval_js_current` | 在用户当前活动标签页执行任意 JS（不开新标签页） |
| `eval_js_tab` | 在指定 tabId（来自 `list_tabs`）的标签页执行任意 JS |
| `bridge_status` | 查询桥接状态（连接、端口、传输方式） |

`eval_js*` 系列工具支持 `world` 参数：
- `ISOLATED`（默认）：扩展隔离世界，不受页面 CSP 限制，完整 DOM 访问，但不能读页面 JS 全局变量。适合点击、填表、读渲染后 HTML。
- `MAIN`：页面主世界，能读/改页面 JS 变量和 SPA 框架状态（React/Vue/jQuery 内部），但受页面 CSP 约束。

JS 代码作为 **async 函数体** 执行：可用 `await`，最后一个表达式的 resolved 值会返回。
非 JSON 可序列化的值（DOM 节点、函数）会被安全地字符串化以跨 IPC 传输。

## 适配的 MCP 客户端

实现完整兼容 MCP `2025-06-18` 与 `2024-11-05` 两版传输协议：

| 客户端 | 推荐传输 | 端点 |
|--------|---------|------|
| Claude Desktop | Streamable HTTP | `http://127.0.0.1:8765/mcp` |
| Cursor | Streamable HTTP / SSE | `http://127.0.0.1:8765/mcp` 或 `http://127.0.0.1:8765/sse` |
| Cline | SSE | `http://127.0.0.1:8765/sse` |
| Windsurf | Streamable HTTP | `http://127.0.0.1:8765/mcp` |
| Continue | SSE | `http://127.0.0.1:8765/sse` |
| 任意 MCP SDK 客户端 | 任一 | 三种端点都开放 |

默认传输模式为 **Both**（同时开放所有端点），无需为不同客户端切换配置。

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库根目录
4. 复制该扩展的 ID（32 位字母数字），稍后安装 native host 时要用

### 2. 安装 native messaging host

在 `native-host/` 目录下运行（需要本机有 Python 3.8+，**无需任何 pip 包**）：

```bash
cd native-host
python3 install_host.py --extension-id <你的扩展ID>
```

脚本会自动：
- 生成启动器（`host_launcher.sh` / `host_launcher.bat`）调用 `host.py`
- 生成 native messaging manifest 并安装到对应位置：
  - **Linux**: `~/.config/google-chrome/NativeMessagingHosts/`
  - **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - **Windows**: `%LOCALAPPDATA%\MCPBrowserBridge\` + 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mcpbrowser.bridge`

卸载：

```bash
python3 install_host.py --uninstall
```

### 3. 启动桥接

1. 回到 `chrome://extensions`，点击扩展「详情 → 扩展程序选项」打开配置页
2. 确认端口（默认 `8765`）与传输方式（默认 `Both`）
3. 点击 **Save & Apply**，再点 **Reconnect**
4. 状态指示灯变绿即表示 native host 已在监听

## 配置 MCP 客户端

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "browser-bridge": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

### Cursor / Windsurf（Streamable HTTP）

```json
{
  "mcpServers": {
    "browser-bridge": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

### Cline / Continue（旧版 SSE）

```json
{
  "mcpServers": {
    "browser-bridge": {
      "url": "http://127.0.0.1:8765/sse",
      "type": "sse"
    }
  }
}
```

把端口换成你在配置页选的端口。保存后重启客户端即可看到 `search` / `eval_js` /
`fetch_page` 等工具。

## 端点说明

| 端点 | 方法 | 说明 |
|------|------|------|
| `/mcp` | POST | Streamable HTTP：发送 JSON-RPC；响应可为 JSON 或 SSE 流。`initialize` 返回 `Mcp-Session-Id` |
| `/mcp` | GET | 打开 SSE 流，接收 server→client 通知（需 `Mcp-Session-Id` header） |
| `/mcp` | DELETE | 终止 session（需 `Mcp-Session-Id` header） |
| `/sse` | GET | 旧版 SSE：建立事件流；首个 `endpoint` 事件告知后续 POST 地址 |
| `/messages` | POST | 旧版 SSE：发送 JSON-RPC，响应通过 SSE 流推送（`?sessionId=<id>`） |
| `/health` | GET | 健康检查，返回端口、传输方式、端点列表 |

Session 在 1 小时无活动后自动过期。

## 项目结构

```
MCP-Browser-Bridge/
├── manifest.json              # MV3 清单 (v0.2.0)
├── background/
│   └── background.js          # service worker：MCP 路由 + 标签页编排 + JS 注入
├── lib/
│   ├── mcp-protocol.js        # 内置 MCP / JSON-RPC 协议解析 (2025-06-18)
│   ├── bridge.js              # 扩展 <-> native host 桥接
│   ├── search-engines.js      # 搜索引擎配置模型 + 存储
│   ├── search-runner.js       # 创建标签页 -> 等待加载 -> 提取/执行JS -> 关闭
│   └── settings.js            # 端口/传输/生命周期等设置
├── content/
│   └── content.js             # 当前页文本/链接识别与解析
├── options/                   # 配置页（搜索引擎、端口、传输）
├── popup/                     # 弹窗（状态、快速测试）
├── icons/                     # 16/48/128 图标
├── native-host/
│   ├── host.py                # native messaging host + Streamable HTTP/SSE server
│   ├── install_host.py        # 跨平台安装脚本
│   └── com.mcpbrowser.bridge.json.template
└── tools/
    └── generate_icons.py      # 图标生成器（纯标准库，无需 Pillow）
```

## 零依赖声明

| 组件 | 依赖 |
|------|------|
| 浏览器扩展 | 无 npm 包，无构建步骤，原生 ES Modules |
| native host (`host.py`) | 仅 Python 3.8+ 标准库（`http.server` / `json` / `struct` / `threading` / `uuid` / `zlib`） |
| 安装脚本 | 仅 Python 标准库（`winreg` on Windows） |
| 图标生成 | 仅 Python 标准库（`zlib` / `struct`） |

**整个项目不需要 `npm install`、不需要 `pip install`，克隆即可用。**

## 开发

修改后：
1. 在 `chrome://extensions` 点扩展卡片上的「刷新」
2. 在配置页点 **Reconnect** 让 native host 应用新端口

重新生成图标：

```bash
python3 tools/generate_icons.py
```

校验语法（无需任何依赖）：

```bash
python3 -m py_compile native-host/host.py native-host/install_host.py
node --experimental-detect-module --check lib/mcp-protocol.js
```

端到端测试 host.py 的 Streamable HTTP 实现（不依赖浏览器，模拟扩展）：

```bash
python3 /path/to/test_host.py
```

## 安全说明

- native host 默认只绑定 `127.0.0.1`，不对外网暴露
- 扩展的 `allowed_origins` 限定为你的扩展 ID，其他扩展无法连接该 host
- `eval_js` 在真实浏览器中执行，沿用用户的 cookie 与登录态 —— **MCP 客户端将能以你的
  身份访问已登录站点并执行页面操作**，请只连接你信任的 MCP 客户端
- Session 1 小时无活动自动过期，DELETE `/mcp` 可主动终止

## License

MIT
