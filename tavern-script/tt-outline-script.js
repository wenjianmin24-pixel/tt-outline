/**
 * tt-outline —— 酒馆助手（JS-Slash-Runner）脚本版
 * ------------------------------------------------------------
 * 功能：双模型剧情大纲。每次发消息前，先用大纲模型生成本轮回复的剧情大纲，
 *       把大纲注入主提示（in_chat 深度位置），再交给酒馆主 API 模型生成回复。
 *
 * 依赖：SillyTavern / TauriTavern 上安装「酒馆助手 JS-Slash-Runner」扩展。
 *
 * 用法：在酒馆助手的「全局脚本」或脚本条目里，填写下面这一行（换成你的托管地址）：
 *   import 'https://cdn.jsdelivr.net/gh/wenjianmin24-pixel/tt-outline@main/tavern-script/tt-outline-script.js'
 *
 * 说明：
 *   - source='main'：用酒馆主 API 生成大纲（免 CORS，大纲模型=当前主模型）。推荐先跑通。
 *   - source='api' ：用独立大纲 API（OpenAI 兼容）。两种来源都走酒馆后端转发
 *                    （generateRaw + custom_api），因此没有 CORS 限制，可以随便填 API 地址。
 *   - 修改配置：编辑本文件顶部的 config 对象后重新托管即可。
 * ------------------------------------------------------------
 */
const config = {
    enabled: true,
    // 'main' = 酒馆主 API（免 CORS，用当前主模型）；'api' = 独立大纲 API
    source: 'main',
    // 仅 source='api' 时需要：
    apiBaseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: '',
    model: '',
    temperature: 0.8,
    maxTokens: 512,
    timeoutSec: 25,
    contextMessages: 12,
    injectionDepth: 2,       // 大纲注入深度（0=最后一条消息处）
    outlineOnRetry: true,    // 重试/换一条/续写时也生成大纲
    prompt: `你是一位角色扮演剧情大纲助手。请根据下面给出的最近对话，为"即将到来的下一轮回复"规划一份简短、可执行的剧情大纲。

要求：
1. 使用与对话相同的语言输出（对话是中文就写中文）。
2. 输出 4~8 条要点，覆盖：当前场景状态、角色目标与心理、情绪走向、下一步可能的剧情推进、需要避免的雷点。
3. 只输出大纲要点本身，不要客套话、不要解释、不要任何前缀。`,
    injectionTemplate: `【本轮剧情大纲】（由大纲模型生成，仅供规划参考。请顺着大纲方向推进剧情并补全细节，不要直接复述或提及大纲本身）
{{outline}}`,
};

const PROMPT_ID = 'tt-outline-gen';
let outlineBusy = false;

/* ---------------- 工具 ---------------- */

function substitute(template, map) {
    let out = String(template ?? '');
    for (const [key, value] of Object.entries(map)) {
        out = out.split(key).join(String(value ?? ''));
    }
    return out;
}

function getTavern() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        return SillyTavern.getContext();
    }
    throw new Error('未找到 SillyTavern.getContext()（确认酒馆助手已安装）');
}

function buildChatDump() {
    const context = getTavern();
    const chat = context.chat || [];
    const userName = context.name1 || 'User';
    const charName = context.name2 || (context.character && context.character.name) || 'Character';
    const lines = [];
    const count = Math.max(1, Number(config.contextMessages) || 12);
    const slice = chat.slice(-count);
    for (const m of slice) {
        if (!m || typeof m.mes !== 'string' || !m.mes.trim()) {
            continue;
        }
        if (m.is_system || m.is_name || m.role === 'system') {
            continue;
        }
        const name = m.is_user ? userName : (m.name || charName);
        lines.push(`${name}：${m.mes.trim()}`);
    }
    return lines.join('\n\n');
}

/* ---------------- 大纲生成 ---------------- */

/**
 * 生成大纲。两种来源都走酒馆自己的后端（generateRaw → /api/backends/chat-completions/*），
 * 由酒馆服务器去调外部 API，因此没有浏览器 CORS 限制：
 *   - source='main'：不带 custom_api，用当前主连接
 *   - source='api' ：带 custom_api（apiurl/key/model），用任意 OpenAI 兼容接口
 */
async function generateOutline(instructionPrompt, chatDump) {
    if (typeof generateRaw !== 'function') {
        throw new Error('酒馆助手未提供 generateRaw（请升级酒馆助手版本）');
    }

    const baseOptions = {
        user_input: chatDump,
        ordered_prompts: [
            { role: 'system', content: instructionPrompt },
            'user_input',
        ],
    };

    let result;
    if (config.source === 'main') {
        result = await generateRaw(baseOptions);
    } else {
        const base = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
        if (!base) {
            throw new Error('未填写大纲 API 地址');
        }
        if (!String(config.model || '').trim()) {
            throw new Error('未填写大纲模型名');
        }
        result = await generateRaw({
            ...baseOptions,
            custom_api: {
                apiurl: base,
                key: String(config.apiKey || '').trim(),
                model: String(config.model).trim(),
                source: 'openai',
            },
        });
    }

    const text = String(result ?? '').trim();
    if (!text) {
        throw new Error('大纲返回为空');
    }
    return text;
}

async function makeOutlineForCurrentChat() {
    const context = getTavern();
    const chatDump = buildChatDump();
    if (!chatDump) {
        throw new Error('聊天内容为空，无法生成大纲');
    }
    const instructionPrompt = substitute(config.prompt, {
        '{{messages}}': chatDump,
        '{{user}}': context.name1 || 'User',
        '{{char}}': context.name2 || (context.character && context.character.name) || 'Character',
    });
    return await generateOutline(instructionPrompt, chatDump);
}

function injectOutline(outlineText) {
    if (typeof injectPrompts !== 'function') {
        throw new Error('酒馆助手未提供 injectPrompts');
    }
    const content = substitute(config.injectionTemplate, { '{{outline}}': outlineText });
    injectPrompts(
        [{
            id: PROMPT_ID,
            position: 'in_chat',
            depth: Number(config.injectionDepth) >= 0 ? Number(config.injectionDepth) : 2,
            role: 'system',
            content,
        }],
        { once: true }, // 用完自动清理，不污染下一轮
    );
}

/* ---------------- 事件钩子 ---------------- */

async function onBeforeGeneration(...args) {
    if (!config.enabled) {
        return;
    }
    const type = args[0];
    const options = args[1];
    // 跳过后台 quiet 请求（摘要、世界书等）与扮演
    if (type === 'quiet' || (options && options.quiet_prompt)) {
        return;
    }
    if (type === 'impersonate') {
        return;
    }
    if ((type === 'swipe' || type === 'regenerate' || type === 'continue') && !config.outlineOnRetry) {
        return;
    }

    if (outlineBusy) {
        return;
    }
    outlineBusy = true;
    try {
        const outline = await makeOutlineForCurrentChat();
        if (outline) {
            injectOutline(outline);
            console.log('[tt-outline] 已生成本轮大纲并注入主提示');
        }
    } catch (err) {
        console.warn('[tt-outline] 大纲生成失败：', err);
        if (typeof toastr !== 'undefined') {
            toastr.warning('大纲生成失败（本轮无大纲继续发送）：' + String((err && err.message) || err), 'tt-outline');
        }
    } finally {
        outlineBusy = false;
    }
}

// 测试函数：控制台里执行 window.__ttOutlineTest()，或酒馆快速回复里调用
async function testOutline() {
    try {
        const outline = await makeOutlineForCurrentChat();
        if (typeof toastr !== 'undefined') {
            toastr.success('大纲生成成功', 'tt-outline');
        }
        console.log('[tt-outline] 测试大纲：\n' + outline);
        return outline;
    } catch (err) {
        if (typeof toastr !== 'undefined') {
            toastr.error('大纲生成失败：' + String((err && err.message) || err), 'tt-outline');
        }
        throw err;
    }
}

/* ---------------- 注册 ---------------- */

if (typeof eventOn === 'function' && typeof tavern_events !== 'undefined') {
    eventOn(tavern_events.GENERATION_AFTER_COMMANDS, onBeforeGeneration);
    console.log('[tt-outline] 酒馆助手脚本版已加载（来源：' + config.source + '）');
} else {
    console.warn('[tt-outline] 未找到 eventOn / tavern_events，请确认在酒馆助手脚本环境中运行');
}

if (typeof window !== 'undefined') {
    window.__ttOutlineTest = testOutline;
}
