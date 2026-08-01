/**
 * TauriTavern 大纲生成器（tt-outline）
 * ------------------------------------------------------------
 * 适配：TauriTavern（SillyTavern 的 Tauri/Rust 分支）第三方前端扩展
 *
 * 工作流程：
 *   1) 监听 GENERATION_AFTER_COMMANDS（该事件在真正发请求前触发，且会被 await，
 *      事件载荷为 (type, options, dryRun)）
 *   2) 用「额外 API + 大纲提示词」调用另一个模型，生成本轮回复的剧情大纲
 *   3) 通过 setExtensionPrompt 把大纲注入主提示（IN_CHAT + depth，靠近聊天结尾）
 *   4) 酒馆主 API 拿到带大纲的上下文，生成回复
 *   5) 生成结束 / 停止 / 切换聊天时清掉本轮大纲，避免污染下一轮
 *
 * 说明：TauriTavern 的第三方扩展以「ES Module 副作用」方式加载（不需要
 * registerExtension 也能运行）。本文件保留了对原版 SillyTavern 的兼容注册。
 */
import {
    getContext,
    extension_settings,
} from '../../../extensions.js';
import * as extApi from '../../../extensions.js';
import { extension_prompt_roles, extension_prompt_types } from '../../../extension-prompts.js';

// 注意：TauriTavern 的主脚本位于 /script.js（根目录），而第三方扩展在
// /scripts/extensions/third-party/<name>/ 下，需要 ../../../../script.js 才能到根目录；
// 原版 SillyTavern 的主脚本在 /scripts/script.js，只需 ../../../script.js。
// 这里用动态导入 + 回退，两种环境都能加载。
let scriptApi = null;

async function loadScriptApi() {
    if (scriptApi) {
        return;
    }
    try {
        // TauriTavern：/script.js
        scriptApi = await import('../../../../script.js');
    } catch (e1) {
        try {
            // 原版 SillyTavern：/scripts/script.js
            scriptApi = await import('../../../script.js');
        } catch (e2) {
            throw new Error('无法加载酒馆核心模块 script.js：' + String((e1 && e1.message) || e1) + ' / ' + String((e2 && e2.message) || e2));
        }
    }
    if (!scriptApi || typeof scriptApi.eventSource === 'undefined' || typeof scriptApi.setExtensionPrompt !== 'function') {
        throw new Error('script.js 加载成功但缺少所需导出（eventSource / setExtensionPrompt）');
    }
}

// 扩展目录名（manifest 与数据目录中的文件夹名保持一致）
const MODULE_NAME = 'tt-outline';
// 注入到主提示里的 prompt key（避免与其它扩展撞名）
const PROMPT_NAME = 'tt-outline-gen';

/* ---------------- 默认值 ---------------- */

const DEFAULT_PROMPT = `你是一位角色扮演剧情大纲助手。请根据下面给出的最近对话，为"即将到来的下一轮回复"规划一份简短、可执行的剧情大纲。

要求：
1. 使用与对话相同的语言输出（对话是中文就写中文）。
2. 输出 4~8 条要点，覆盖：当前场景状态、角色目标与心理、情绪走向、下一步可能的剧情推进、需要避免的雷点。
3. 只输出大纲要点本身，不要客套话、不要解释、不要任何前缀。`;

const DEFAULT_INJECTION = `【本轮剧情大纲】（由大纲模型生成，仅供规划参考。请顺着大纲方向推进剧情并补全细节，不要直接复述或提及大纲本身）
{{outline}}`;

const defaultSettings = {
    enabled: false,          // 总开关
    apiBaseUrl: '',          // 大纲 API 地址（OpenAI 兼容），例如 https://api.openai.com/v1
    apiKey: '',              // 大纲 API Key
    model: '',               // 大纲模型名
    temperature: 0.8,        // 大纲模型采样温度
    maxTokens: 512,          // 大纲最大输出 tokens
    timeoutSec: 25,          // 大纲请求超时（秒）
    contextMessages: 12,     // 读取最近多少条消息做大纲依据
    skipSystemMessages: true,// 跳过系统消息
    prompt: DEFAULT_PROMPT,  // 大纲提示词（可用占位符：{{messages}} {{user}} {{char}}）
    injectionTemplate: DEFAULT_INJECTION, // 注入模板（{{outline}} 为大纲占位）
    injectionDepth: 2,       // 注入深度（0=最后一条消息处，越大越靠前）
    outlineOnRetry: true,    // 重试/换一条/续写时也生成大纲
    skipImpersonate: true,   // 跳过"扮演"请求
    failOpen: true,          // 大纲失败时仍继续发送主请求
    useTauriHttp: false,     // 尝试 Tauri 原生 HTTP 通道（TauriTavern 默认未内置 http 插件，通常无效）
    outlineSource: 'api',    // 'api'=独立大纲 API；'main'=用酒馆主 API（免 CORS，用当前主模型）
    showToasts: true,        // 生成成功/失败用 toast 弹窗提示
};

let outlineBusy = false;
let initStarted = false;

// 调试辅助：暴露内部引用（不影响正常运行；控制台/测试排查用）
export function getScriptApi() {
    return scriptApi;
}

export function getDebugState() {
    const s = extension_settings[MODULE_NAME] || {};
    return {
        scriptApiLoaded: !!scriptApi,
        scriptMode: scriptApi && scriptApi.__MODE__ ? scriptApi.__MODE__ : (scriptApi ? 'loaded' : 'not-loaded'),
        outlineBusy,
        enabled: !!s.enabled,
        configured: !!(s.apiBaseUrl && s.model),
        lastOutlinePreview: s.lastOutline ? String(s.lastOutline).slice(0, 200) : '',
        lastOutlineAt: s.lastOutlineAt || null,
    };
}

/** 剪贴板兜底复制（旧 WebView） */
function fallbackCopyText(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch (e) {
        return false;
    }
}

/* ---------------- 工具函数 ---------------- */

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = value;
        }
    }
}

function saveSettings() {
    if (scriptApi && typeof scriptApi.saveSettingsDebounced === 'function') {
        scriptApi.saveSettingsDebounced();
    }
}

/** 模板替换（兼容不支持 replaceAll 的旧 WebView） */
function substitute(template, map) {
    let out = String(template ?? '');
    for (const [key, value] of Object.entries(map)) {
        out = out.split(key).join(String(value ?? ''));
    }
    return out;
}

/** 从 context.chat 里取最近 N 条消息，拼成纯文本对话 */
function buildChatDump(chat, maxMessages, skipSystem) {
    const context = getContext();
    const userName = context.name1 || 'User';
    const charName = context.name2 || (context.character && context.character.name) || 'Character';
    const lines = [];
    const count = Math.max(1, Number(maxMessages) || 12);
    const slice = chat.slice(-count);
    for (const m of slice) {
        if (!m || typeof m.mes !== 'string' || !m.mes.trim()) {
            continue;
        }
        if (skipSystem && (m.is_system || m.is_name || m.role === 'system')) {
            continue;
        }
        const name = m.is_user ? userName : (m.name || charName);
        lines.push(`${name}：${m.mes.trim()}`);
    }
    return lines.join('\n\n');
}

/** 从响应里提取大纲文本（OpenAI 兼容格式） */
function extractOutlineText(status, data) {
    if (status >= 200 && status < 300) {
        if (data && data.choices && data.choices[0] && data.choices[0].message) {
            const text = String(data.choices[0].message.content || '').trim();
            if (text) {
                return text;
            }
        }
        if (data && typeof data.output_text === 'string' && data.output_text.trim()) {
            return data.output_text.trim();
        }
        throw new Error('大纲 API 返回内容为空或格式不正确');
    }
    let detail = '';
    try {
        detail = JSON.stringify(data);
    } catch (e) {
        detail = String(data);
    }
    throw new Error(`大纲 API 返回 HTTP ${status}：${detail || '未知错误'}`);
}

/* ---------------- 获取模型列表（OpenAI 兼容 /models） ---------------- */

export async function fetchModelList() {
    const s = extension_settings[MODULE_NAME];
    const base = String(s.apiBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) {
        throw new Error('未填写大纲 API 地址');
    }
    const key = String(s.apiKey || '').trim();

    // 走酒馆后端 /status（custom source）拉模型列表，免 CORS
    const payload = {
        chat_completion_source: 'custom',
        custom_api_format: 'openai_compat',
        custom_url: base,
        custom_include_headers: key ? `Authorization: "Bearer ${key}"` : '',
    };

    const headers = { 'Content-Type': 'application/json' };
    if (scriptApi && typeof scriptApi.getRequestHeaders === 'function') {
        Object.assign(headers, scriptApi.getRequestHeaders());
    }

    const timeoutMs = (Number(s.timeoutSec) > 0 ? Number(s.timeoutSec) : 25) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = '/api/backends/chat-completions/status';

    try {
        const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
        const data = await resp.json().catch(() => null);

        if (data && data.error) {
            throw new Error(`获取模型失败：${(data.error && data.error.message) || data.message || '未知错误'}`);
        }
        const ids = (data && Array.isArray(data.data) ? data.data : [])
            .map(m => m && m.id)
            .filter(id => typeof id === 'string' && id.trim());
        if (!ids.length) {
            throw new Error('接口未返回模型列表');
        }
        return ids;
    } catch (err) {
        throw toFriendlyError(err, s, url);
    } finally {
        clearTimeout(timer);
    }
}

async function onFetchModelsClick() {
    const s = extension_settings[MODULE_NAME];
    if (s.outlineSource === 'main') {
        if (typeof toastr !== 'undefined') {
            toastr.info('当前是「酒馆主 API」模式，不需要获取模型（使用当前主模型）', 'tt-outline');
        }
        return;
    }
    const btn = this;
    const oldText = btn.innerText;
    btn.disabled = true;
    btn.innerText = '获取中…';
    try {
        const ids = await fetchModelList();
        const $pick = $('#tt-outline-model-pick');
        $pick.empty().append('<option value="">— 选择模型 —</option>');
        ids.forEach(id => $pick.append(`<option value="${String(id).replace(/"/g, '&quot;')}">${String(id)}</option>`));
        $pick.show();
        const current = extension_settings[MODULE_NAME].model;
        if (current && ids.includes(current)) {
            $pick.val(current);
        }
        if (typeof toastr !== 'undefined') {
            toastr.success(`获取到 ${ids.length} 个模型`, 'tt-outline');
        }
    } catch (err) {
        const msg = String((err && err.message) || err);
        $('#tt-outline-result').val('获取模型失败：' + msg);
        if (typeof toastr !== 'undefined') {
            toastr.error('获取模型失败：' + msg, 'tt-outline');
        }
    } finally {
        btn.disabled = false;
        btn.innerText = oldText;
    }
}

/* ---------------- 错误翻译（把 WebView 原始报错转成可读信息） ---------------- */

function toFriendlyError(err, s, url) {
    const isAbort = !!(err && (err.name === 'AbortError' || (err.message && /abort/i.test(String(err.message)))));
    const sec = (Number(s && s.timeoutSec) > 0 ? Number(s.timeoutSec) : 25);
    if (isAbort) {
        return new Error(`请求超时（超过 ${sec} 秒）：${url || '(未知地址)'}。请检查：① API 地址是否正确且手机能访问；② 该 API 是否支持浏览器跨域（CORS），不支持请改用 relay-server.js 中继或换支持跨域的提供商；③ 网络是否被拦截；④ 可调大“超时(秒)”`);
    }
    const msg = String((err && err.message) || err);
    return new Error(`请求失败（${url || '(未知地址)'}）：${msg}`);
}

/* ---------------- 大纲 API 调用（走酒馆后端转发，免 CORS） ---------------- */

/**
 * 独立大纲 API 模式：不再浏览器直连外部 API，而是把请求交给酒馆自己的后端
 * `/api/backends/chat-completions/generate`（SillyTavern 与 TauriTavern 都已实现），
 * 由酒馆服务器转发到任意 OpenAI 兼容接口（custom source）。
 * 因此没有 CORS 限制，apiBaseUrl/apiKey/model 随便填。
 */
async function callOutlineViaBackend(systemPrompt, userContent) {
    const s = extension_settings[MODULE_NAME];
    const base = String(s.apiBaseUrl || '').trim().replace(/\/+$/, '');
    if (!base) {
        throw new Error('未填写大纲 API 地址');
    }
    const model = String(s.model || '').trim();
    if (!model) {
        throw new Error('未填写大纲模型名');
    }
    const key = String(s.apiKey || '').trim();

    const payload = {
        type: 'quiet',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        model,
        temperature: Number(s.temperature) || 0.8,
        max_tokens: Number(s.maxTokens) > 0 ? Number(s.maxTokens) : 512,
        stream: false,
        chat_completion_source: 'custom',
        custom_api_format: 'openai_compat',
        custom_url: base,
        custom_include_headers: key ? `Authorization: "Bearer ${key}"` : '',
    };

    const headers = { 'Content-Type': 'application/json' };
    if (scriptApi && typeof scriptApi.getRequestHeaders === 'function') {
        Object.assign(headers, scriptApi.getRequestHeaders());
    }

    const timeoutMs = (Number(s.timeoutSec) > 0 ? Number(s.timeoutSec) : 25) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = '/api/backends/chat-completions/generate';

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const data = await response.json().catch(() => null);

        if (!response.ok || (data && data.error)) {
            const msg = (data && data.error && data.error.message)
                || (data && data.message)
                || `HTTP ${response.status}`;
            throw new Error(`大纲生成失败：${msg}`);
        }
        const text = String(data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content
            : '').trim();
        if (!text) {
            throw new Error('大纲返回内容为空');
        }
        return text;
    } catch (err) {
        throw toFriendlyError(err, s, url);
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------- 大纲生成 ---------------- */

/** 用当前聊天生成大纲文本 */
async function generateOutlineForCurrentChat() {
    const s = extension_settings[MODULE_NAME];
    const context = getContext();
    const chat = context.chat || [];

    const chatDump = buildChatDump(chat, s.contextMessages, s.skipSystemMessages);
    if (!chatDump) {
        throw new Error('聊天内容为空，无法生成大纲');
    }

    const prompt = substitute(s.prompt || DEFAULT_PROMPT, {
        '{{messages}}': chatDump,
        '{{user}}': context.name1 || 'User',
        '{{char}}': context.name2 || (context.character && context.character.name) || 'Character',
    });

    // 若提示词里显式写了 {{messages}}，就把它当系统消息整体发送；
    // 否则按「系统=大纲提示词，用户=最近对话」两段发送。
    const userContent = prompt.includes('{{messages}}')
        ? '请输出本轮回复的大纲。'
        : chatDump;

    // 酒馆主 API 模式：走酒馆后端（generateQuietPrompt），无 CORS；用当前主模型生成大纲
    if (s.outlineSource === 'main') {
        return await generateOutlineViaMain(prompt, chatDump);
    }

    // 独立大纲 API 模式：走酒馆后端转发（custom source），无 CORS，随便填地址
    return await callOutlineViaBackend(prompt, userContent);
}

/** 用酒馆主 API 的 quiet prompt 生成大纲（免 CORS，大纲模型=当前主模型） */
async function generateOutlineViaMain(instructionPrompt, chatDump) {
    if (!scriptApi || typeof scriptApi.generateQuietPrompt !== 'function') {
        throw new Error('当前环境不支持 generateQuietPrompt（script.js 未导出）');
    }
    const combined = `${instructionPrompt}\n\n最近对话（越靠后越新）：\n${chatDump}`;
    const outline = await scriptApi.generateQuietPrompt({ quietPrompt: combined, removeReasoning: true });
    const text = String(outline || '').trim();
    if (!text) {
        throw new Error('主 API 返回的大纲为空');
    }
    return text;
}

/* ---------------- 注入 / 清理 ---------------- */

function injectOutline(outlineText) {
    if (!scriptApi || typeof scriptApi.setExtensionPrompt !== 'function') {
        return;
    }
    const s = extension_settings[MODULE_NAME];
    const text = substitute(s.injectionTemplate || DEFAULT_INJECTION, { '{{outline}}': outlineText });
    scriptApi.setExtensionPrompt(
        PROMPT_NAME,
        text,
        extension_prompt_types.IN_CHAT,
        Number(s.injectionDepth) >= 0 ? Number(s.injectionDepth) : 2,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function clearOutline() {
    if (!scriptApi || typeof scriptApi.setExtensionPrompt !== 'function') {
        return;
    }
    const s = extension_settings[MODULE_NAME] || defaultSettings;
    scriptApi.setExtensionPrompt(
        PROMPT_NAME,
        '',
        extension_prompt_types.IN_CHAT,
        Number(s.injectionDepth) >= 0 ? Number(s.injectionDepth) : 2,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

/** 记录最近一次生成的大纲（面板展示 + 持久化，跨重启可回看） */
function setLastOutline(outline, source) {
    const s = extension_settings[MODULE_NAME];
    if (!s) {
        return;
    }
    s.lastOutline = String(outline || '');
    s.lastOutlineAt = Date.now();
    if (source) {
        s.lastOutlineSource = source;
    }
    if ($('#tt-outline-last').length) {
        $('#tt-outline-last').val(s.lastOutline);
    }
    saveSettings();
}

/* ---------------- 生成前拦截 ---------------- */

/**
 * @param {string} type  generation type（message / quiet / swipe / regenerate / continue / impersonate ...）
 * @param {object} options 生成选项
 * @param {boolean} dryRun 是否为试运行
 */
async function onBeforeGeneration(type, options, dryRun) {
    const s = extension_settings[MODULE_NAME];
    if (!s) {
        return;
    }

    if (dryRun) {
        return;
    }

    // 跳过“合成”事件：酒馆助手(JS-Slash-Runner)的 generateRaw 等会自行再 emit 一次
    // GENERATION_AFTER_COMMANDS('normal', {}, false)，其 options 为空对象。
    // 真实发送一定带 options（automatic_trigger 等），空 options = 嵌套/合成信号，
    // 必须跳过，否则会和脚本版同时启用时互相触发、重复生成大纲。
    if (!options || typeof options !== 'object' || Object.keys(options).length === 0) {
        return;
    }

    // 未启用时，顺手清掉可能残留的大纲
    if (!s.enabled) {
        clearOutline();
        return;
    }

    // 跳过 quiet 后台请求（摘要、世界书等）
    if (type === 'quiet' || (options && options.quiet_prompt)) {
        return;
    }

    // 跳过扮演
    if (type === 'impersonate' && s.skipImpersonate) {
        return;
    }

    // 重试 / 换一条 / 续写
    if ((type === 'swipe' || type === 'regenerate' || type === 'continue') && !s.outlineOnRetry) {
        return;
    }

    // 未配置则跳过
    if (!String(s.apiBaseUrl || '').trim() || !String(s.model || '').trim()) {
        console.warn('[tt-outline] 未配置大纲 API 地址或模型名，跳过大纲生成');
        return;
    }

    if (outlineBusy) {
        return;
    }
    outlineBusy = true;

    try {
        const outline = await generateOutlineForCurrentChat();
        if (outline) {
            injectOutline(outline);
            setLastOutline(outline, s.outlineSource === 'main' ? 'main' : 'api');
            console.log('[tt-outline] 已生成本轮大纲并注入主提示');
            if (s.showToasts && typeof toastr !== 'undefined') {
                toastr.success('大纲已生成并注入', 'tt-outline');
            }
        }
    } catch (err) {
        console.warn('[tt-outline] 大纲生成失败：', err);
        clearOutline();
        if (s.failOpen) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('大纲生成失败，本轮将无大纲继续发送', 'tt-outline');
            }
        } else {
            if (typeof toastr !== 'undefined') {
                toastr.error('大纲生成失败：' + String((err && err.message) || err), 'tt-outline');
            }
        }
    } finally {
        outlineBusy = false;
    }
}

/* ---------------- 设置面板 ---------------- */

function settingsHtml() {
    return `
    <div class="tt-outline-settings">
        <div class="tt-outline-title">
            <b>大纲生成器 Outline</b>
            <small>发送前调用「额外 API + 大纲模型」生成本轮剧情大纲，注入主提示后交给酒馆主 API 生成回复。</small>
        </div>
        <div class="tt-outline-body">
            <label for="tt-outline-source">大纲生成方式</label>
            <select id="tt-outline-source" class="text_pole wide100p">
                <option value="api">独立 API（走酒馆后端转发，免 CORS，随便填地址）</option>
                <option value="main">酒馆主 API（免 CORS，用当前主模型）</option>
            </select>
            <small class="tt-outline-tip">两种方式都走酒馆后端转发，没有跨域问题。「独立 API」可用任意 OpenAI 兼容接口当大纲模型；「酒馆主 API」则用当前主模型。</small>

            <label class="checkbox_label">
                <input type="checkbox" id="tt-outline-enabled"> 启用大纲生成
            </label>

            <label for="tt-outline-api-base">大纲 API 地址（OpenAI 兼容，可填中转/中继地址）</label>
            <input id="tt-outline-api-base" type="text" class="text_pole wide100p" placeholder="https://api.openai.com/v1">

            <label for="tt-outline-api-key">大纲 API Key（不需要鉴权的中继可留空）</label>
            <input id="tt-outline-api-key" type="password" class="text_pole wide100p" autocomplete="off" placeholder="sk-...">

            <label for="tt-outline-model">大纲模型名（可点「获取模型」从接口拉取列表）</label>
            <div class="flex-container wrap" style="gap:6px;align-items:center;">
                <input id="tt-outline-model" type="text" class="text_pole flex1" placeholder="例如 deepseek-chat / gpt-4o-mini">
                <button id="tt-outline-fetch-models" class="menu_button" type="button">获取模型</button>
            </div>
            <select id="tt-outline-model-pick" class="text_pole wide100p" style="margin-top:4px;display:none;">
                <option value="">— 选择模型 —</option>
            </select>

            <div class="flex-container flexFlowRow wrap">
                <label class="tt-outline-inline">温度 <input id="tt-outline-temperature" type="number" min="0" max="2" step="0.1" class="text_pole"></label>
                <label class="tt-outline-inline">最大tokens <input id="tt-outline-max-tokens" type="number" min="16" step="16" class="text_pole"></label>
                <label class="tt-outline-inline">超时(秒) <input id="tt-outline-timeout" type="number" min="3" step="1" class="text_pole"></label>
                <label class="tt-outline-inline">取最近消息 <input id="tt-outline-ctx-msgs" type="number" min="1" step="1" class="text_pole"></label>
                <label class="tt-outline-inline">注入深度 <input id="tt-outline-depth" type="number" min="0" step="1" class="text_pole"></label>
            </div>

            <label class="checkbox_label">
                <input type="checkbox" id="tt-outline-skip-system"> 跳过系统消息
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-outline-on-retry"> 重试/换一条/续写时也生成大纲
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-outline-fail-open"> 大纲失败时仍继续发送主请求
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-outline-show-toasts"> 生成成功/失败用弹窗提示
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="tt-outline-tauri-http">
                尝试 Tauri 原生 HTTP 通道（绕过 CORS；仅当应用内置 http 插件且授权该地址时可用）
            </label>

            <label for="tt-outline-prompt">大纲提示词（支持 {{messages}} / {{user}} / {{char}}，留空使用默认）</label>
            <textarea id="tt-outline-prompt" class="text_pole wide100p" rows="6"></textarea>

            <label for="tt-outline-injection">注入模板（{{outline}} 为大纲占位）</label>
            <textarea id="tt-outline-injection" class="text_pole wide100p" rows="3"></textarea>

            <div class="flex-container wrap" style="gap:8px;margin-top:6px;">
                <button id="tt-outline-test" class="menu_button">测试生成大纲</button>
                <button id="tt-outline-restore" class="menu_button">恢复默认提示词</button>
            </div>
            <textarea id="tt-outline-result" class="text_pole wide100p" rows="5" readonly placeholder="测试结果会显示在这里"></textarea>

            <label for="tt-outline-last">最近一次生成的大纲（每次发送后自动更新，已注入到主提示）</label>
            <textarea id="tt-outline-last" class="text_pole wide100p" rows="5" readonly placeholder="发消息后，这里会显示刚生成并注入主提示的大纲"></textarea>
            <div class="flex-container wrap" style="gap:8px;margin-top:4px;">
                <button id="tt-outline-copy-last" class="menu_button">复制大纲</button>
            </div>
        </div>
    </div>`;
}

function applySettingsToDom() {
    const s = extension_settings[MODULE_NAME];
    $('#tt-outline-source').val(s.outlineSource || 'api');
    $('#tt-outline-enabled').prop('checked', !!s.enabled);
    $('#tt-outline-api-base').val(s.apiBaseUrl || '');
    $('#tt-outline-api-key').val(s.apiKey || '');
    $('#tt-outline-model').val(s.model || '');
    $('#tt-outline-temperature').val(s.temperature);
    $('#tt-outline-max-tokens').val(s.maxTokens);
    $('#tt-outline-timeout').val(s.timeoutSec);
    $('#tt-outline-ctx-msgs').val(s.contextMessages);
    $('#tt-outline-depth').val(s.injectionDepth);
    $('#tt-outline-skip-system').prop('checked', !!s.skipSystemMessages);
    $('#tt-outline-on-retry').prop('checked', !!s.outlineOnRetry);
    $('#tt-outline-fail-open').prop('checked', !!s.failOpen);
    $('#tt-outline-show-toasts').prop('checked', !!s.showToasts);
    $('#tt-outline-last').val(s.lastOutline || '');
    $('#tt-outline-tauri-http').prop('checked', !!s.useTauriHttp);
    $('#tt-outline-prompt').val(s.prompt || '');
    $('#tt-outline-injection').val(s.injectionTemplate || '');
}

function bindSettings() {
    const s = () => extension_settings[MODULE_NAME];
    const onInput = (id, apply) => {
        $(id).on('input change', function () {
            apply(s(), this);
            saveSettings();
        });
    };

    onInput('#tt-outline-source', (s, el) => { s.outlineSource = $(el).val(); });
    onInput('#tt-outline-enabled', (s, el) => { s.enabled = !!$(el).prop('checked'); });
    onInput('#tt-outline-api-base', (s, el) => { s.apiBaseUrl = $(el).val(); });
    onInput('#tt-outline-api-key', (s, el) => { s.apiKey = $(el).val(); });
    onInput('#tt-outline-model', (s, el) => { s.model = $(el).val(); });
    onInput('#tt-outline-temperature', (s, el) => { s.temperature = Number($(el).val()); });

    // 获取模型按钮 + 模型下拉
    $('#tt-outline-fetch-models').on('click', onFetchModelsClick);
    $('#tt-outline-model-pick').on('change', function () {
        const value = String($(this).val() || '');
        if (value) {
            extension_settings[MODULE_NAME].model = value;
            $('#tt-outline-model').val(value);
            saveSettings();
        }
    });

    onInput('#tt-outline-max-tokens', (s, el) => { s.maxTokens = Number($(el).val()); });
    onInput('#tt-outline-timeout', (s, el) => { s.timeoutSec = Number($(el).val()); });
    onInput('#tt-outline-ctx-msgs', (s, el) => { s.contextMessages = Number($(el).val()); });
    onInput('#tt-outline-depth', (s, el) => { s.injectionDepth = Number($(el).val()); });
    onInput('#tt-outline-skip-system', (s, el) => { s.skipSystemMessages = !!$(el).prop('checked'); });
    onInput('#tt-outline-on-retry', (s, el) => { s.outlineOnRetry = !!$(el).prop('checked'); });
    onInput('#tt-outline-fail-open', (s, el) => { s.failOpen = !!$(el).prop('checked'); });
    onInput('#tt-outline-show-toasts', (s, el) => { s.showToasts = !!$(el).prop('checked'); });
    onInput('#tt-outline-tauri-http', (s, el) => { s.useTauriHttp = !!$(el).prop('checked'); });
    onInput('#tt-outline-prompt', (s, el) => { s.prompt = $(el).val(); });
    onInput('#tt-outline-injection', (s, el) => { s.injectionTemplate = $(el).val(); });

    // 说明：不实现自定义抽屉折叠，设置块始终可见（避免与 TauriTavern 全局 inline-drawer 处理器冲突）

    // 测试按钮
    $('#tt-outline-test').on('click', async function () {
        const btn = this;
        const oldText = btn.innerText;
        btn.disabled = true;
        btn.innerText = '生成中…';
        try {
            const outline = await generateOutlineForCurrentChat();
            setLastOutline(outline, 'test');
            $('#tt-outline-result').val(outline || '(空)');
            if (typeof toastr !== 'undefined') {
                toastr.success('大纲生成成功', 'tt-outline');
            }
        } catch (err) {
            $('#tt-outline-result').val('失败：' + String((err && err.message) || err));
            if (typeof toastr !== 'undefined') {
                toastr.error('大纲生成失败：' + String((err && err.message) || err), 'tt-outline');
            }
        } finally {
            btn.disabled = false;
            btn.innerText = oldText;
        }
    });

    // 恢复默认提示词
    $('#tt-outline-restore').on('click', function () {
        extension_settings[MODULE_NAME].prompt = DEFAULT_PROMPT;
        extension_settings[MODULE_NAME].injectionTemplate = DEFAULT_INJECTION;
        $('#tt-outline-prompt').val(DEFAULT_PROMPT);
        $('#tt-outline-injection').val(DEFAULT_INJECTION);
        saveSettings();
    });

    // 复制最近大纲
    $('#tt-outline-copy-last').on('click', function () {
        const text = String(extension_settings[MODULE_NAME].lastOutline || '');
        if (!text) {
            if (typeof toastr !== 'undefined') {
                toastr.info('还没有生成过大纲', 'tt-outline');
            }
            return;
        }
        const onOk = () => {
            if (typeof toastr !== 'undefined') {
                toastr.success('已复制', 'tt-outline');
            }
        };
        const onFail = () => {
            if (typeof toastr !== 'undefined') {
                toastr.warning('复制失败，请手动长按选择文本', 'tt-outline');
            }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onOk).catch(() => {
                fallbackCopyText(text) ? onOk() : onFail();
            });
        } else {
            fallbackCopyText(text) ? onOk() : onFail();
        }
    });
}

/* ---------------- 初始化 ---------------- */

async function initExtension() {
    if (initStarted) {
        return;
    }
    initStarted = true;

    try {
        await loadScriptApi();
    } catch (err) {
        console.error('[tt-outline] 初始化失败：', err);
        initStarted = false;
        return;
    }

    loadSettings();
    try {
        $('#extensions_settings').append(settingsHtml());
        applySettingsToDom();
        bindSettings();
    } catch (err) {
        console.error('[tt-outline] 设置面板渲染失败：', err);
        throw err;
    }

    const { eventSource, event_types } = scriptApi;
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    eventSource.on(event_types.GENERATION_ENDED, clearOutline);
    eventSource.on(event_types.GENERATION_STOPPED, clearOutline);
    eventSource.on(event_types.MESSAGE_RECEIVED, clearOutline);
    eventSource.on(event_types.CHAT_CHANGED, clearOutline);

    console.log('[tt-outline] 大纲生成器已加载');
}

// TauriTavern：模块以副作用方式注入。若 #extensions_settings 尚不存在则稍后重试。
function initWhenReady(attempt) {
    attempt = attempt || 0;
    if (typeof $ === 'undefined' || !$('#extensions_settings').length) {
        if (attempt < 50) {
            setTimeout(() => initWhenReady(attempt + 1), 200);
        }
        return;
    }
    initExtension();
}

// 兼容原版 SillyTavern：存在 registerExtension 时注册（TauriTavern 无此导出，自动跳过）
if (typeof extApi.registerExtension === 'function') {
    extApi.registerExtension(MODULE_NAME, { init: initExtension });
}

initWhenReady(0);
