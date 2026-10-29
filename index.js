/**
 * dsh-yuniang-overlay —— 桌面悬浮窗的会话桥
 *
 * 作用：Electron 悬浮窗把老大打的字追加到 outbox.jsonl；
 *      本插件轮询到这个新行 → 唤醒一个专用会话（sessionId: overlay:desktop）
 *      把文本作为用户消息投进去 → 等这轮跑完；
 *      我这轮调用 overlay_say(text_ja, text_zh) → 写进 inbox.jsonl → 悬浮窗显示。
 *
 * 设计取舍：走文件而不是 HTTP。文件是最稳的接口，出问题只看两个文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'yuniang-overlay';
export const inject = ['agentDefaultModel', 'agents', 'systemPrompt', 'tools'];

const BASE = 'E:\\Deepseek\\工具\\悬浮对话';
const INBOX = path.join(BASE, 'inbox.jsonl');
const OUTBOX = path.join(BASE, 'outbox.jsonl');
const STATE = path.join(BASE, 'bridge-state.json');
const SESSION = SessionId('overlay:desktop');
const TTS = 'http://127.0.0.1:9880/tts';
const VOICE_REF = 'E:/Deepseek/交流区/16_声纹/03_权重/ref_furin_src0030.wav';
const VOICE_PROMPT = '早く戻るよ。本当に、わけがわからないよね。この魔力。';
const VOICE_DIR = path.join(BASE, 'voice');

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
}

async function speak(textJa) {
  const body = {
    text: textJa, text_lang: 'ja', ref_audio_path: VOICE_REF, prompt_text: VOICE_PROMPT,
    prompt_lang: 'ja', text_split_method: 'cut5', batch_size: 1, media_type: 'wav',
    streaming_mode: false, top_k: 15, top_p: 1, temperature: 0.9, speed_factor: 1.0,
    fragment_interval: 0.2,
  };
  const res = await fetch(TTS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('TTS ' + res.status + ' ' + ((await res.text().catch(() => '')).slice(0, 200)));
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('TTS 空音频');
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const out = path.join(VOICE_DIR, 'line_' + Date.now() + '.wav');
  fs.writeFileSync(out, buf);
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { seen: 0 }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s), 'utf8'); } catch {}
}

export function apply(ctx) {
  const state = loadState();
  let handle = null;
  let busy = false;
  let pendingReply = null;

  const sayTool = () => defineTool({
    name: 'overlay_say',
    description: '把这句话送到老大的桌面悬浮窗：日语原句 + 中文字幕。这是本轮唯一的外显出口。',
    parameters: {
      text_ja: { type: 'string', description: '日语原句（自然的日语口语）' },
      text_zh: { type: 'string', description: '中文翻译，显示为字幕' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    execute: async (args) => {
      pendingReply = { ja: args.text_ja, zh: args.text_zh, at: new Date().toTimeString().slice(0, 8) };
      let audio = null;
      try { audio = await speak(args.text_ja); } catch (e) { ctx.logger?.warn?.('yuniang-overlay: TTS 失败 ' + String(e)); }
      if (audio) pendingReply.audio = audio;
      fs.appendFileSync(INBOX, JSON.stringify(pendingReply) + '\n', 'utf8');
      return audio ? '已送到悬浮窗，并且念出来了。' : '已送到悬浮窗（语音没合成成功）。';
    },
  });

  async function ensure() {
    if (handle !== null) return handle;
    const selection = ctx.agentDefaultModel.currentSelection();
    const created = await ctx.agents.create({
      sessionId: SESSION,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
        agentCtx.systemPrompt.context({
          name: 'yuniang-overlay:source',
          order: 100,
          text: '你现在在老大桌面上的一个悬浮小窗里说话（不是网页聊天）。回答要短、口语、像贴着他耳边说；必须调用 overlay_say 给日语原句和中文翻译，不要只写文字回复。',
        });
        agentCtx.tools.register(sayTool());
      },
    });
    handle = created;
    return handle;
  }

  async function pump() {
    if (busy || handle === null) return;
    const lines = readLines(OUTBOX);
    if (lines.length <= state.seen) return;
    const fresh = lines.slice(state.seen);
    state.seen = lines.length;
    saveState(state);
    busy = true;
    try {
      for (const line of fresh) {
        let text = '';
        try { text = JSON.parse(line).text ?? ''; } catch { text = line; }
        if (!text.trim()) continue;
        const h = await ensure();
        await h.agent.whenIdle();
        pendingReply = null;
        h.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'overlay', form: 'notice', summary: '桌面悬浮窗消息' },
        }));
        await h.agent.whenIdle();
      }
    } catch (error) {
      ctx.logger?.warn?.(`yuniang-overlay: ${String(error)}`);
    } finally {
      busy = false;
    }
  }

  ctx.effect(() => {
    const timer = setInterval(() => { pump().catch(() => {}); }, 800);
    // 启动时先把已有对话记成"已读"，避免把历史当新消息
    const lines = readLines(OUTBOX);
    if (state.seen > lines.length) { state.seen = lines.length; saveState(state); }
    ensure().catch((e) => ctx.logger?.warn?.(`yuniang-overlay: 会话创建失败 ${String(e)}`));
    return () => {
      clearInterval(timer);
      if (handle !== null) handle.dispose?.();
    };
  }, 'yuniang-overlay: 轮询 outbox');
}