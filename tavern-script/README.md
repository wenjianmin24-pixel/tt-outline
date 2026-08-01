# tt-outline 酒馆助手脚本版（JS-Slash-Runner）

与扩展版功能相同：**发送前用大纲模型生成本轮剧情大纲，注入主提示后交给酒馆主 API 生成回复**。
区别：脚本版只需一个 JS 文件，通过 URL 导入，更新就是改一行导入地址，不用装/更新 git 扩展。

## 依赖

- SillyTavern / TauriTavern
- [酒馆助手 JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner) 扩展（SillyTavern 扩展面板在线安装）

## 安装

1. 在酒馆助手界面新建一个「全局脚本」（或脚本条目）
2. 脚本内容填一行导入（本仓库已托管到 GitHub，直接用 jsDelivr 加速）：

```js
import 'https://cdn.jsdelivr.net/gh/wenjianmin24-pixel/tt-outline@main/tavern-script/tt-outline-script.js'
```

3. 保存并启用脚本

> 也可以把 `tavern-script/tt-outline-script.js` 放到你自己的托管（GitHub 仓库 / 网盘直链 / Vercel 等），把导入地址换成你自己的。
> 注意：改脚本配置要编辑文件里的 `config` 对象后重新托管，再刷新导入地址版本号/分支。

## 配置（编辑文件顶部 config 对象）

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关 |
| `source` | `'main'` 用酒馆主 API（免 CORS，大纲模型=当前主模型）；`'api'` 用独立大纲 API |
| `apiBaseUrl / apiKey / model` | 仅 `source='api'` 时需要（OpenAI 兼容） |
| `temperature / maxTokens / timeoutSec` | 独立 API 的采样与超时参数 |
| `contextMessages` | 取最近多少条消息做大纲依据 |
| `injectionDepth` | 大纲注入深度（0=最后一条消息处） |
| `outlineOnRetry` | 重试/换一条/续写时是否也生成大纲 |
| `prompt` | 大纲提示词（支持 `{{messages}}` `{{user}}` `{{char}}`） |
| `injectionTemplate` | 注入模板（`{{outline}}` 为大纲占位） |

## 测试

在酒馆 F12 控制台执行：

```js
window.__ttOutlineTest().then(o => console.log(o))
```

或直接发一条消息看效果。

## 常见问题

- **CORS（`Failed to fetch`）**：脚本在页面里 `fetch` 外部 API 同样受浏览器跨域限制。
  - 优先用 `source='main'`（走主 API，无跨域）；
  - 想用独立模型：填**中继地址**（本仓库 `relay-server.js`，`UPSTREAM_BASE=你的API地址 node relay-server.js`，手机填 `http://电脑IP:8799`），或换支持跨域的提供商。
- **`generateRaw` 报错**：确认酒馆助手版本支持"请求生成"功能，且主 API 连接正常。
- **大纲没生效**：确认脚本已启用、`enabled=true`、`source` 选对；重试/续写类操作如需大纲请打开 `outlineOnRetry`。

## 原理

```
发消息 → 酒馆助手 eventOn(GENERATION_AFTER_COMMANDS)（被 await）
  → 组装大纲提示词 + 最近聊天
  → 大纲模型生成大纲（source='main' 走主 API / source='api' 走独立 API）
  → injectPrompts({ position:'in_chat', depth, role:'system', content:大纲 }, { once:true })
  → 酒馆主 API 模型带着大纲生成回复（once 用完自动清理）
```
