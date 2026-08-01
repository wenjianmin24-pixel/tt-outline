# 大纲生成器 Outline（tt-outline）

适配 **TauriTavern**（SillyTavern 的 Tauri/Rust 分支，支持 Android / Windows / Linux / macOS）的第三方扩展。

核心思路：**双模型流水线**——每次发消息前，先用你额外填的「大纲 API + 大纲提示词」调用**另一个模型**，写本轮回复的剧情大纲；写完后把大纲注入主提示，与酒馆消息一起发给**酒馆主 API 的模型**，让它顺着大纲生成回复。

```
你点发送
   │
   ▼
┌─ GENERATION_AFTER_COMMANDS（等待大纲完成）─────────────────────┐
│  1. 取最近 N 条聊天记录                                          │
│  2. 组装大纲提示词（你填的那份）                                  │
│  3. 请求「大纲 API + 大纲模型」→ 得到大纲文本                     │
│  4. setExtensionPrompt 把大纲注入主提示（聊天末尾附近）           │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
酒馆主 API 的模型收到「聊天上下文 + 大纲」→ 生成回复
   │
   ▼
生成结束 / 停止 / 切聊天 → 自动清掉本轮大纲，避免污染下一轮
```

---

## 目录结构

```
tt-outline-extension/
├── manifest.json       扩展清单（TauriTavern 扩展管理依赖它）
├── index.js            主逻辑（ES Module，副作用加载）
├── style.css           设置面板样式
├── relay-server.js     大纲 API 的 CORS 中继（可选，解决跨域）
└── README.md           本说明
```

---

## 安装（TauriTavern）

### 方式 A：Git 地址安装（推荐，可更新）
1. 把这个文件夹推到一个 **Git 仓库**（GitHub / GitLab / Gitee 均可，`main` 分支即可）。
2. 打开 TauriTavern → **扩展（Extensions）面板** → 安装扩展 → 粘贴 Git 地址 → 安装。
3. 安装后找到 **大纲生成器 Outline**，点击启用。

> TauriTavern 的扩展安装只接受 `http(s)` Git remote（不支持 SSH / ZIP）。更新、换分支都可以在扩展面板里完成。

### 方式 B：手动复制文件夹（无 Git 也能用）
把整个 `tt-outline` 文件夹（本目录）放进数据目录的任一扩展位置：

- 单用户（local，优先）：`data/default-user/extensions/tt-outline/`
- 全局（global）：`data/extensions/third-party/tt-outline/`

> 注意：**文件夹名必须叫 `tt-outline`**（与 `index.js` 里的常量一致，改名会找不到设置模板路径时请同步修改）。
> 在 TauriTavern 里通过设置页打开数据目录，或用文件管理器把文件夹放进去，重启应用后在扩展面板启用。

### 方式 C：TT-Sync 同步
TauriTavern 的 TT-Sync 支持同步 `extensions.local` / `extensions.third_party`，多设备可直接同步本扩展。

---

## 配置说明（扩展设置面板）

| 设置 | 说明 |
| --- | --- |
| 启用大纲生成 | 总开关 |
| 大纲生成方式 | 「独立 API」= 用你额外填的大纲 API（需支持跨域或走中继）；「酒馆主 API」= 用当前主模型生成大纲（免 CORS、免额外配置，但大纲模型=主模型） |
| 大纲 API 地址 | OpenAI 兼容接口，如 `https://api.openai.com/v1`；可填中转/中继地址（见下方 CORS） |
| 大纲 API Key | 大纲模型的密钥；不需要鉴权的中继可留空 |
| 大纲模型名 | 例如 `deepseek-chat`、`gpt-4o-mini`、`qwen-plus` 等；可点旁边的「**获取模型**」按钮直接从接口拉取列表并下拉选择 |
| 温度 / 最大tokens | 大纲模型采样参数 |
| 超时(秒) | 大纲请求超时；超时后按「失败」处理继续发主请求（failOpen 时） |
| 取最近消息 | 拿最近多少条聊天记录给大纲模型当依据 |
| 注入深度 | 大纲插入主提示的位置（0=最后一条消息处，越大越靠前） |
| 跳过系统消息 | 组装聊天记录时跳过系统消息 |
| 重试/换一条/续写时也生成大纲 | 关掉则只对普通发送生效 |
| 大纲失败时仍继续发送主请求 | 默认开启：大纲挂了不影响主回复 |
| 尝试 Tauri 原生 HTTP 通道 | 可选实验项，绕过 CORS；需应用内置 http 插件且授权该地址 |
| 大纲提示词 | 你填的「另一份大纲提示词」，支持 `{{messages}}` `{{user}}` `{{char}}` 占位符 |
| 注入模板 | 大纲如何呈现给主模型，`{{outline}}` 是大纲占位 |
| 测试生成大纲 | 用当前聊天试跑一次，结果在下方文本框显示 |
| 生成成功/失败用弹窗提示 | 每次发送时是否 toast 提示大纲结果 |
| 最近一次生成的大纲 | 每次发送后自动更新（含复制按钮），可回看刚注入的大纲 |

---

## 手机端必读：CORS（跨域）问题 ✅ 已解决

扩展版（v1.0.6 起）和脚本版的「独立 API」模式**都不再浏览器直连**外部 API，而是把请求交给**酒馆自己的后端**（`/api/backends/chat-completions/*`，SillyTavern 的 Node 后端 / TauriTavern 的 Rust 后端均已实现），由酒馆服务器转发到任意 OpenAI 兼容接口：

```
扩展/脚本 → 酒馆后端（同源，无 CORS）→ 你填的任意 API（服务器间调用，无 CORS）
```

所以 `大纲 API 地址 / Key / 模型名` 现在可以随便填（例如 opencode.ai 的 `https://opencode.ai/zen/go/v1`），**不需要中继、不需要支持 CORS 的提供商**。

> 旧版（≤1.0.5）扩展版直连 fetch 才会被 CORS 拦；如果你用的是旧版请更新。
> `relay-server.js` 仍保留：如果你想把大纲 API 的调用架到自己的服务器上（例如避免在手机上存 Key），或者跑在很老版本的酒馆上，可以继续用。

---

## 工作原理与安全边界

- 扩展监听 `GENERATION_AFTER_COMMANDS` 事件（`src/script.js` 里该事件在**真正发请求前**被 `await`，事件载荷 `(type, options, dryRun)`）。在事件处理函数里等待大纲 API 返回后，调用 `setExtensionPrompt(key, text, extension_prompt_types.IN_CHAT, depth, ...)` 把大纲注入主提示。
- `type === 'quiet'`（摘要、世界书等后台请求）、`dryRun`、未启用时**不会**触发大纲。
- 生成结束 / 停止 / 切换聊天时清空大纲注入，避免旧大纲累积。
- **隐私提示**：大纲 API Key 保存在酒馆设置里，会随设置文件一起存储；使用第三方中转前请确认其可信。本扩展不收集任何数据，只在本机 WebView 里发起大纲请求。
- 大纲请求的聊天记录是**最近 N 条纯文本摘要**，不会把角色卡全文/世界书发给大纲模型。

## 与原版 SillyTavern 的兼容性

本扩展以 **TauriTavern** 为优先目标（其第三方扩展以纯副作用 ES Module 加载，不要求 `registerExtension`）。代码里保留了 `registerExtension` 兼容分支，并针对两个环境的主脚本路径做了动态导入兼容：

- TauriTavern 主脚本在 `/script.js`（第三方扩展目录是 `/scripts/extensions/third-party/<name>/`，需向上 4 级）；
- 原版 SillyTavern 主脚本在 `/scripts/script.js`（向上 3 级）。

因此本扩展可直接放入原版 SillyTavern 的 `public/scripts/extensions/third-party/tt-outline/` 使用，但未经专门测试，以 TauriTavern 表现为准。

> 给扩展作者：如果你在 TauriTavern 里写第三方扩展时遇到「导入成功但置灰无法启用」，优先检查静态 import 的路径深度——TauriTavern 把 `script.js` 放在根目录，和 SillyTavern 的 `/scripts/script.js` 不同。

## 怎么看大纲有没有生成、大纲内容在哪

- **发送时**：默认会弹 toast——成功提示「大纲已生成并注入」，失败提示「大纲生成失败」。可在设置里关掉（「生成成功/失败用弹窗提示」）。
- **看内容**：扩展设置面板最下方「**最近一次生成的大纲**」会在每次发送后自动更新（含「复制大纲」按钮），跨重启也会保留（存在设置里）。
- **测试**：点「测试生成大纲」会用当前聊天跑一次，结果在「测试结果」框，同时也会更新「最近一次生成的大纲」。
- **控制台**：`F12` 里输入 `getDebugState?.()` 或看 `extension_settings.tt_outline.lastOutline` 也能拿到最近大纲。

## 常见问题

**Q：大纲一直失败，主回复还能发吗？**
能。默认 `大纲失败时仍继续发送主请求` 开启，失败只弹一条提示。

**Q：为什么每条回复都慢了几秒？**
大纲模型先跑一轮，这是双模型流水线的固有延迟。可以把「取最近消息」调小、模型换成更快的、或关闭「重试/换一条/续写时也生成大纲」来提速。

**Q：感觉大纲没有被主模型遵守？**
试试把「注入深度」调成 0~2（离主模型输出更近），或修改「注入模板」把措辞写得更明确（例如：`请严格按以下大纲推进剧情，但不要提大纲本身`）。

**Q：手机上怎么填局域网中继地址？**
手机与电脑同一 Wi-Fi，电脑上 `ipconfig`（Windows）/ `ifconfig`（macOS）查看局域网 IP（如 `192.168.x.x`），扩展里填 `http://192.168.x.x:8799`。若失败，检查电脑防火墙是否放行 8799 端口。
