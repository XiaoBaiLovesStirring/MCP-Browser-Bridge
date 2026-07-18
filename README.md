# MCP-Browser-Bridge

一个浏览器扩展，让你把"自己喜欢的搜索引擎 + 当前网页内容"暴露成 MCP 工具，
供 Claude Desktop、Cursor 等 MCP 客户端调用。支持 **SSE** 与 **HTTP** 两种传输，
端口由用户自选，**协议解析全部内置在扩展中**，native host 只做轻量 I/O 转发，
因此端到端延迟极低。

## 工作原理

```
MCP 客户端 ──HTTP/SSE──▶ native host (host.py) ──native messaging──▶ 浏览器扩展
                                                                  │
                                                  ┌───────────────┴───────────────┐
                                                  │  内置 MCP 协议解析 (JSON-RPC)   │
                                                  │  搜索引擎配置 / 标签页管理       │
                                                  │  页面文本 & 链接识别解析         │
                                                  └─────────────────────────────────┘
```

- **浏览器扩展（MV3 service worker）**：实现 MCP 协议解析、搜索引擎管理、
  标签页创建与页面内容提取（文本识别 + 链接识别）。所有业务逻辑都在这里。
- **native messaging host（`native-host/host.py`，纯 Python 标准库）**：
  在用户选择的端口上起一个本地 HTTP/SSE 服务器，把 MCP 客户端的请求原样
  转发给扩展，把扩展的响应原样推回客户端。**它不解析、不改动任何协议内容**，
  只做转发，所以很快。

## 特性

- 配置自己喜欢的搜索引擎（内置 Google / Bing / DuckDuckGo / Baidu 模板，可增删改）
- MCP 传输格式：**SSE**（流式，推荐）、**HTTP**（单请求/响应）、或两者同时开启
- 用户自选监听端口（1024–65535）与绑定地址（默认 `127.0.0.1`）
- 通过**创建新标签页**执行搜索，后台加载完成后自动提取结果再关闭
- **文本识别 + 链接识别**：提取页面正文文本与全部链接，支持结构化结果（标题/摘要/URL）
- 协议解析完全内置，无外部依赖
- 自带配置页（options）与弹窗（popup），实时显示连接状态

## 暴露的 MCP 工具

| 工具 | 说明 |
|------|------|
| `list_engines` | 列出已配置的搜索引擎（可选包含已禁用的） |
| `search` | 用指定引擎搜索，打开后台标签页，返回结构化结果（title / url / snippet） |
| `fetch_page` | 打开任意 URL，提取页面文本与所有链接 |
| `get_current_page` | 提取用户当前活动标签页的文本与链接 |
| `bridge_status` | 查询桥接状态（连接、端口、传输方式） |

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库根目录
4. 复制该扩展的 ID（32 位字母数字），稍后安装 native host 时要用

### 2. 安装 native messaging host

在 `native-host/` 目录下运行（需要本机有 Python 3.8+）：

```bash
cd native-host
python3 install_host.py --extension-id <你的扩展ID>
```

脚本会自动：
- 生成一个启动器（`host_launcher.sh` / `host_launcher.bat`）调用 `host.py`
- 生成 native messaging manifest 并安装到对应位置：
  - **Linux**: `~/.config/google-chrome/NativeMessagingHosts/`
  - **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
  - **Windows**: `%LOCALAPPDATA%\MCPBrowserBridge\` + 注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mcpbrowser.bridge`

卸载：

```bash
python3 install_host.py --uninstall
```

### 3. 启动桥接

1. 回到 `chrome://extensions`，点击扩展的「详情 → 扩展程序选项」打开配置页
2. 确认端口（默认 `8765`）与传输方式（默认 `SSE`）
3. 点击 **Save & Apply**，再点 **Reconnect**
4. 状态指示灯变绿即表示 native host 已在监听

## 配置 MCP 客户端

### Claude Desktop (`claude_desktop_config.json`)

SSE 模式：

```json
{
  "mcpServers": {
    "browser-bridge": {
      "url": "http://127.0.0.1:8765/sse"
    }
  }
}
```

HTTP 模式：

```json
{
  "mcpServers": {
    "browser-bridge": {
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

把端口换成你在配置页选的端口。保存后重启 Claude Desktop 即可看到
`search` / `fetch_page` / `get_current_page` 等工具。

## 端点说明

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /sse` | GET | 建立 SSE 事件流；首个事件 `endpoint` 告知客户端后续 POST 地址 |
| `POST /messages?sessionId=<id>` | POST | SSE 模式下发送 JSON-RPC，响应通过 SSE 流推送 |
| `POST /mcp` | POST | HTTP 模式：单请求/响应，同步返回 JSON-RPC 结果 |
| `GET /health` | GET | 健康检查，返回端口与传输方式 |

## 项目结构

```
MCP-Browser-Bridge/
├── manifest.json              # MV3 清单
├── background/
│   └── background.js          # service worker：MCP 路由 + 标签页编排
├── lib/
│   ├── mcp-protocol.js        # 内置 MCP / JSON-RPC 协议解析
│   ├── bridge.js              # 扩展 <-> native host 桥接
│   ├── search-engines.js      # 搜索引擎配置模型 + 存储
│   ├── search-runner.js       # 创建标签页 -> 等待加载 -> 提取 -> 关闭
│   └── settings.js            # 端口/传输/生命周期等设置
├── content/
│   └── content.js             # 当前页文本/链接识别与解析
├── options/                   # 配置页（搜索引擎、端口、传输）
├── popup/                     # 弹窗（状态、快速测试）
├── icons/                     # 16/48/128 图标
├── native-host/
│   ├── host.py                # native messaging host + HTTP/SSE server
│   ├── install_host.py        # 跨平台安装脚本
│   └── com.mcpbrowser.bridge.json.template
└── tools/
    └── generate_icons.py      # 图标生成器（纯标准库，无需 Pillow）
```

## 开发

无需构建步骤，全部是原生 ES modules + 纯 Python。修改后：

1. 在 `chrome://extensions` 点扩展卡片上的「刷新」
2. 在配置页点 **Reconnect** 让 native host 应用新端口

重新生成图标：

```bash
python3 tools/generate_icons.py
```

校验语法：

```bash
python3 -m py_compile native-host/host.py native-host/install_host.py
node --experimental-detect-module --check lib/mcp-protocol.js
```

## 安全说明

- native host 默认只绑定 `127.0.0.1`，不对外网暴露
- 扩展的 `allowed_origins` 限定为你的扩展 ID，其他扩展无法连接该 host
- 搜索与抓取通过真实浏览器标签页进行，沿用用户的 cookie 与登录态
  （注意：MCP 客户端将能以你的身份访问已登录站点）

## License

MIT
