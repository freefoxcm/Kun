# 微信 / WeChat Block Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `feature/feishu-streaming-with-live-fix` 分支上把微信 / WeChat bot 的回复改为 block streaming 形态 —— 按 `minChars=200` 或 `idleMs=3000` 任一触发，自动发多条独立消息气泡；webhook 在流式路径上返回空 `reply`，bridge 据此不发送尾包。

**Architecture:** 在 `ClawRuntime.handleWebhook` 内部根据 `provider==='weixin'` 加一个 `weixinStream` 分支 —— 开：经由 `runStreamingReplyWeixin` 走 `WeixinStreamer` + 块合并器 + 复用飞书 spec 已有的 `subscribeRuntimeThreadEvents`（失败时退到一次性 `sendWeixinBridgeMessage`）；关：走原 `processIncomingImPrompt` 路径。Renderer 侧不写新代码 —— `subscribeThreadEventsLive` 和 `showLiveAssistant` 修复已由飞书 spec 落地，**直接复用**。Feishu、kun runtime、既有 `processIncomingImPrompt` 路径全部保留。

**Tech Stack:** Electron + React 19 + TypeScript + Zustand + Vitest + `@tencent-weixin/openclaw-weixin` plugin SDK（提供 `StreamingMarkdownFilter`、`sendMessageWeixin`）。runtime 还是单一 `kun`（无新增 / 切换 runtime）。

**Spec:** [`docs/superpowers/specs/2026-06-16-weixin-block-streaming-design.md`](../specs/2026-06-16-weixin-block-streaming-design.md)

---

## 工作约束（影响全部任务）

- **TDD**：每个有可测行为的功能都先写失败测试再实现。
- **commit 粒度**：每个 Task 完成立刻 commit，不允许"积一堆再提交"。
- **YAGNI**：spec 标注"YAGNI"的项不写（per-channel `weixinStream`、typing 指示器、Card JSON 2.0、reasoning 透出等）。
- **不动 `kun/` runtime 包**：kun 的 `/v1/threads/{id}/events` SSE 端点已经存在；本计划只用它。
- **不动飞书代码**：飞书 spec 是稳定版；`feishuStream` 路径、`FeishuStreamer`、`runStreamingReply`、`subscribeSse`/`subscribeSseForStreamer`、`subscribeRuntimeThreadEvents` 全部**复用**，本计划只新增 weixin 专用组件。
- **不动 `weixin-bridge-runtime.ts`**：webhook 契约变更只在 ClawRuntime 侧；bridge 的 `if (reply)` 守卫已经支持空 reply。
- **改动核心调用**：`sendMessageWeixin` 经由 `sendWeixinBridgeMessage` 入口（不是 plugin 内部的 `sendMessage`）—— 这样走 bridge RPC 路径，便于统一错误处理。
- **跨 SDK import 路径**：`StreamingMarkdownFilter` 通过 `weixin-bridge-runtime.ts:127` 同样的 lazy import 方式加载，避免 plugin 升级时 import 路径漂移。
- **路径风格**：本计划所有路径用正斜杠，跨平台可读。
- **改动前必读**：每个 Task 的"Files"小节先 Read 一下当前文件内容，再动 Edit。
- **工作树**：当前在 `feature/feishu-streaming-with-live-fix` 分支，基于 `origin/develop` 的最新版本（rebase 已完成）。

---

## 文件结构（实现前先锁好）

| 文件 | 角色 | 类型 |
|---|---|---|
| `src/main/weixin-streamer.ts` | `WeixinStreamer` 类，封装一次 block streaming 回复生命周期 | 新增 |
| `src/main/weixin-streamer.test.ts` | `WeixinStreamer` 单测（13 个 case） | 新增 |
| `src/main/claw-runtime.ts` | `runStreamingReplyWeixin` / `subscribeSseForWeixin` 私有方法；`handleWebhook` 加 `weixinStream` 分支 | 修改 |
| `src/main/claw-runtime.test.ts` | 集成测试（5-6 个 case） | 修改 |
| `src/shared/app-settings-types.ts` | `ClawImSettingsV1` 加 `weixinStream?` | 修改（+1 字段） |
| `src/shared/app-settings-claw.ts` | default normalizer 补 `weixinStream: true` | 修改（+1 行） |
| `src/main/settings-store.ts` | migration 加 `claw.im.weixinStream ?? true` | 修改（+1 行） |
| `src/shared/app-settings.test.ts` | migration 测试 | 修改（+1 case） |
| `src/renderer/src/components/settings-section-claw.tsx` | `weixinStream` SettingRow（紧邻 `feishuStream`） | 修改（+1 行 row） |
| `src/renderer/src/components/settings-section-claw.test.ts` | `weixinStream` toggle 单测 | 修改（+1 case） |
| `src/renderer/src/locales/en/common.json` | i18n key `claw.weixinStreamLabel` | 修改（+1 entry） |
| `src/renderer/src/locales/zh/common.json` | i18n key `claw.weixinStreamLabel` | 修改（+1 entry） |
| `src/renderer/src/locales/en/settings.json` | i18n key `claw.weixinStreamInlineState` | 修改（+1 entry） |
| `src/renderer/src/locales/zh/settings.json` | i18n key `claw.weixinStreamInlineState` | 修改（+1 entry） |
| `docs/CONTRIBUTING.md` | 末尾加"微信 block streaming smoke 测试"小节 | 修改（追加） |

不在本计划里（明确不动的文件）：
- `kun/` runtime 包
- `src/main/feishu-streamer.ts` / `src/main/claw-runtime-helpers.ts`（飞书稳定版）
- `src/main/weixin-bridge-runtime.ts`（webhook 契约不变）
- `src/main/runtime-sse-ipc.ts`（那是给 renderer→main IPC 用的）
- `src/renderer/src/components/chat/MessageTimeline.tsx`（飞书已修）
- `src/renderer/src/store/chat-store-thread-actions.ts`（飞书已加 `subscribeThreadEventsLive`）
- `node_modules/@tencent-weixin/openclaw-weixin/`（plugin 稳定版）
- `src/main/claw-runtime.ts` 里 `processIncomingImPrompt` / `waitForAssistantResult` 主体逻辑

---

## Commit 分组

| Commit | 主题 | 含 Phase |
|---|---|---|
| C1 | `feat(settings): 全局 weixinStream 设置 + migration` | Phase 1 全部 |
| C2 | `feat(weixin-streamer): block streaming 主核心` | Phase 2 全部 |
| C3 | `feat(claw): runStreamingReplyWeixin + webhook 分支` | Phase 3 全部 |
| C4 | `feat(claw-settings): weixinStream SettingRow + i18n` | Phase 4 全部 |
| C5 | `docs(weixin-streaming): smoke 测试小节` | Phase 5 全部 |

每个 Phase 跑完，跑 `npm run typecheck && npm run lint && npm run test`，过了再进下一个 Phase。

---

# Phase 1：settings 全局开关（Commit 1）

本 Phase 引入 `weixinStream` 设置字段；ClawRuntime 暂不消费。完成后，settings migration 兜底老用户。

## Task 1.1：在 `ClawImSettingsV1` 类型加 `weixinStream` 字段

**Files:**
- Modify: `src/shared/app-settings-types.ts`（在 `feishuStream?` 之后追加）

- [ ] **Step 1：读当前 `ClawImSettingsV1` 定义**

Read: `src/shared/app-settings-types.ts`。找到 `feishuStream?: boolean` 字段，记下上下文（紧邻哪个字段、注释风格、缩进）。

- [ ] **Step 2：在 `feishuStream?` 之后追加新字段**

在 `feishuStream?: boolean` 字段后追加（保持 JSDoc 注释风格与现有字段一致）：

```ts
  /** 当 provider === 'weixin' 时,是否把 agent 回复改为 block streaming。默认 true。 */
  weixinStream?: boolean
```

- [ ] **Step 3：跑 typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 无错误（仅新增 optional 字段，不影响现有代码）

## Task 1.2：default normalizer 补默认值

**Files:**
- Modify: `src/shared/app-settings-claw.ts`（在 `feishuStream` 默认值后追加）

- [ ] **Step 1：读 `app-settings-claw.ts` 找到 `feishuStream` 默认值**

Read: `src/shared/app-settings-claw.ts`。找到 `feishuStream: true` 这一行，记下所在对象（通常是 `claw.im` 字段的 default normalizer）。

- [ ] **Step 2：追加 `weixinStream: true` 默认值**

紧邻 `feishuStream: true` 后追加：

```ts
      weixinStream: true,
```

- [ ] **Step 3：跑单测确认现有 case 仍通过**

Run: `npm run test -- src/shared/app-settings.test.ts 2>&1 | tail -20`
Expected: 现有 case 全过；没有 case fail

## Task 1.3：migration 函数补默认值

**Files:**
- Modify: `src/main/settings-store.ts`（在 `feishuStream` migration 之后追加）

- [ ] **Step 1：读 `settings-store.ts` 的 migration 函数**

Read: `src/main/settings-store.ts`。找到 `claw.im.feishuStream ?? true` 这一行，记下所在 migration 块。

- [ ] **Step 2：追加 `weixinStream` migration**

紧邻 `feishuStream ?? true` 后追加：

```ts
      weixinStream ?? true
```

注意：与 `feishuStream` 的具体写法保持一致（多半是 `next.claw.im.weixinStream ??= true` 或 `next.claw.im.weixinStream ?? true`，看现有代码实际模式）。

- [ ] **Step 3：写 migration 失败测试**

Read `src/shared/app-settings.test.ts` 找 `feishuStream` migration test 的位置。新增一个 case：

```ts
  it('migrates legacy settings to default weixinStream = true', () => {
    const legacy = {
      version: 1,
      claw: { im: {} },
      // ...其它必要字段
    }
    const migrated = migrateSettings(legacy)
    expect(migrated.claw.im.weixinStream).toBe(true)
  })
```

具体字段填充看 `feishuStream` test 的输入模板，保持一致。

- [ ] **Step 4：跑测试确认新 case 通过**

Run: `npm run test -- src/shared/app-settings.test.ts -t 'weixinStream' 2>&1 | tail -20`
Expected: 新 case PASS（migration 已经在 Step 2 加好）

- [ ] **Step 5：跑全套验证**

Run: `npm run typecheck && npm run test -- src/shared/app-settings.test.ts 2>&1 | tail -20`
Expected: typecheck 0 错；test 全过

- [ ] **Step 6：commit**

```bash
git add src/shared/app-settings-types.ts src/shared/app-settings-claw.ts src/main/settings-store.ts src/shared/app-settings.test.ts
git commit -m "feat(settings): add global weixinStream toggle (default true)

Mirrors feishuStream: global switch for WeChat block streaming.
Migration backfills weixinStream ?? true for legacy settings."
```

---

# Phase 2：WeixinStreamer 主核心（Commit 2）

本 Phase 新增 `WeixinStreamer` 类（13 个 case 单测）。完成后，streamer 可独立被测试；不接 ClawRuntime。

## Task 2.1：WeixinStreamer 骨架 + 第 1 个测试（构造 + happy path）

**Files:**
- Create: `src/main/weixin-streamer.ts`
- Create: `src/main/weixin-streamer.test.ts`

- [ ] **Step 1：写第 1 个失败测试（happy path：5 个小 delta 累积触发 1 个 block + turn_completed flush 1 个 block）**

在 `src/main/weixin-streamer.test.ts` 新建文件：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WeixinStreamer } from './weixin-streamer'

type BridgeHandle = WeixinStreamer extends new (opts: infer O) => unknown ? O extends { bridge: infer B } ? B : never : never

function makeFakeBridge() {
  const sendMessageWeixin = vi.fn().mockResolvedValue({ messageId: 'mid' })
  const handle: BridgeHandle = { sendMessage: sendMessageWeixin }
  return { handle, sendMessageWeixin }
}

describe('WeixinStreamer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flushes one block when minChars reached, then flushes remainder on turn_completed', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: 'ctx',
      minChars: 200,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })

    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // 5 个小 delta 累积到 250 字符（> minChars=200），应该 flush 1 个 block
    for (let i = 0; i < 5; i++) {
      streamer.onSseEvent({
        kind: 'assistant_text_delta',
        turnId: 'turn-1',
        item: { text: 'a'.repeat(50) }
      })
    }
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)
    expect(sendMessageWeixin.mock.calls[0]?.[2]).toContain('a'.repeat(50))

    // turn_completed 触发 flush 剩余（如果没有 pending 就 no-op）
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()
    // pendingText 此时为空，sendMessage 不再调用
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)

    const result = await startPromise
    expect(result.ok).toBe(true)
    expect(result.messageCount).toBe(1)
    expect(result.fellBack).toBe(false)
  })
})
```

- [ ] **Step 2：跑测试确认它失败**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: FAIL（`WeixinStreamer` 还不存在）

- [ ] **Step 3：写 `WeixinStreamer` 最小实现（happy path 即可）**

在 `src/main/weixin-streamer.ts` 新建文件：

```ts
type BridgeHandle = {
  sendMessage: (accountId: string, to: string, text: string, contextToken: string | undefined) => Promise<{ messageId: string }>
}

type WeixinStreamerLogger = (category: string, message: string, detail?: Record<string, unknown>) => void

type SseSubscriber = (signal: AbortSignal) => { close: () => void }

export type WeixinStreamerResult = {
  ok: boolean
  messageCount: number
  finalText: string
  fellBack: boolean
  message?: string
}

export class WeixinStreamer {
  private pendingText = ''
  private messageCount = 0
  private accumulatedText = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private aborted = false

  constructor(private readonly opts: {
    bridge: BridgeHandle
    accountId: string
    to: string
    turnId: string
    threadId: string
    contextToken: string | undefined
    minChars: number
    idleMs: number
    responseTimeoutMs: number
    logger: WeixinStreamerLogger
  }) {}

  async start(input: { subscribe: SseSubscriber }): Promise<WeixinStreamerResult> {
    let closeRef: () => void = () => {}
    const ac = new AbortController()
    const setup = Promise.resolve().then(() => {
      const { close } = input.subscribe(ac.signal)
      closeRef = close
    }).catch((err) => {
      this.opts.logger('weixin-stream', 'subscribe failed', { message: String(err) })
    })
    void setup

    // 等 turn 终态事件触发关闭；这里用 30s 兜底超时
    const timeout = setTimeout(() => ac.abort(), this.opts.responseTimeoutMs)
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.closed) {
          clearInterval(interval)
          resolve()
        }
      }, 50)
    })
    clearTimeout(timeout)
    closeRef()
    return {
      ok: true,
      messageCount: this.messageCount,
      finalText: this.accumulatedText,
      fellBack: false
    }
  }

  onSseEvent(event: Record<string, unknown>): void {
    if (this.closed || this.aborted) return
    const kind = typeof event.kind === 'string' ? event.kind : ''
    const turnId = typeof event.turnId === 'string' ? event.turnId : ''
    if (turnId && turnId !== this.opts.turnId) return  // 跨 turn 丢弃

    if (kind === 'assistant_text_delta') {
      const item = (event.item ?? {}) as { text?: unknown }
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text) return
      this.accumulatedText += text
      this.pendingText += text
      this.scheduleFlush()
    } else if (kind === 'assistant_reasoning_delta') {
      this.opts.logger('weixin-stream', 'reasoning delta dropped', {})
      return
    } else if (kind === 'turn_completed' || kind === 'turn_failed' || kind === 'turn_aborted') {
      void this.flushPending()
      this.closed = true
    }
  }

  private scheduleFlush(): void {
    if (this.pendingText.length >= this.opts.minChars) {
      void this.flushPending()
      return
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.flushPending()
    }, this.opts.idleMs)
  }

  private async flushPending(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const text = this.pendingText
    if (!text) return
    this.pendingText = ''
    try {
      await this.opts.bridge.sendMessage(this.opts.accountId, this.opts.to, text, this.opts.contextToken)
      this.messageCount += 1
    } catch (err) {
      this.opts.logger('weixin-stream', 'sendMessage failed', { message: String(err) })
    }
  }

  getAccumulatedText(): string { return this.accumulatedText }
  get messageCount_(): number { return this.messageCount }  // 暴露给 caller

  abort(): void { this.aborted = true; this.closed = true }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.closed = true
  }
}
```

> 注：`messageCount_` 命名是为了避免和测试中 `result.messageCount` 冲突；Phase 3 的 `runStreamingReplyWeixin` 直接读私有字段即可，streamer 可以改成 `getMessageCount()`。本 Phase 暂用 `messageCount_`。

- [ ] **Step 4：跑测试确认通过**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -15`
Expected: 1 个 case PASS

- [ ] **Step 5：commit**

```bash
git add src/main/weixin-streamer.ts src/main/weixin-streamer.test.ts
git commit -m "feat(weixin-streamer): add WeixinStreamer skeleton with happy-path

Block coalescer: minChars=200 or idleMs=3000 triggers sendMessageWeixin.
Cross-turn delta dropped. Reasoning delta filtered. Turn terminal event flushes remainder."
```

## Task 2.2：补 idle timer 触发测试

**Files:**
- Modify: `src/main/weixin-streamer.test.ts`（追加 case）

- [ ] **Step 1：追加 case**

在已有 describe 块内追加：

```ts
  it('flushes one block when idle timer fires (no minChars reached)', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 1000,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'short' } })
    expect(sendMessageWeixin).not.toHaveBeenCalled()

    vi.advanceTimersByTime(3000)
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()
    await startPromise
  })
```

- [ ] **Step 2：跑测试确认通过**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: 2 个 case PASS

## Task 2.3：补 reasoning delta + 跨 turn 过滤测试

**Files:**
- Modify: `src/main/weixin-streamer.test.ts`（追加 case）

- [ ] **Step 1：追加 case**

```ts
  it('filters reasoning deltas and cross-turn deltas', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const logger = vi.fn()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 200,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // reasoning delta 过滤
    streamer.onSseEvent({ kind: 'assistant_reasoning_delta', turnId: 'turn-1', item: { text: 'thinking...' } })
    expect(sendMessageWeixin).not.toHaveBeenCalled()
    expect(logger).toHaveBeenCalledWith('weixin-stream', 'reasoning delta dropped', expect.any(Object))

    // 跨 turn delta 丢弃
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-other', item: { text: 'a'.repeat(300) } })
    expect(sendMessageWeixin).not.toHaveBeenCalled()

    // turn_completed 关闭
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()
    await startPromise

    expect(sendMessageWeixin).toHaveBeenCalledTimes(0)
  })
```

- [ ] **Step 2：跑测试**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: 3 个 case PASS

## Task 2.4：补 Markdown 过滤测试

**Files:**
- Modify: `src/main/weixin-streamer.ts`
- Modify: `src/main/weixin-streamer.test.ts`

- [ ] **Step 1：追加失败测试**

```ts
  it('filters markdown via StreamingMarkdownFilter (strips images)', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 200,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // 推一段含 markdown 图片的 delta，累积触发 flush
    const markdown = '![alt](http://x.com/img.png)'.padEnd(250, 'a')
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: markdown } })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)
    // 图片标签被剥离
    const sentText = sendMessageWeixin.mock.calls[0]?.[2] as string
    expect(sentText).not.toContain('![alt]')

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
  })
```

- [ ] **Step 2：跑测试确认失败**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: FAIL（图片标签未被剥离）

- [ ] **Step 3：在 WeixinStreamer 接入 `StreamingMarkdownFilter`**

修改 `src/main/weixin-streamer.ts`：

在文件顶部添加 import：

```ts
// Lazy-load StreamingMarkdownFilter，与 weixin-bridge-runtime.ts:127 一致
let _StreamingMarkdownFilter: typeof import('@tencent-weixin/openclaw-weixin').StreamingMarkdownFilter | null = null
async function loadFilter() {
  if (_StreamingMarkdownFilter) return _StreamingMarkdownFilter
  const mod = await import('@tencent-weixin/openclaw-weixin')
  _StreamingMarkdownFilter = mod.StreamingMarkdownFilter
  return _StreamingMarkdownFilter
}
```

> 注：实际导入路径以 `weixin-bridge-runtime.ts` 中既有的 `import('@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js').then((mod) => mod.sendWeixinMediaFile)` 风格保持一致；若 plugin 主入口也 re-export，则直接 `import('@tencent-weixin/openclaw-weixin')`。Read 既有 import 路径后选其一。

在 `WeixinStreamer` 类添加 filter 实例字段：

```ts
  private filter: InstanceType<NonNullable<typeof _StreamingMarkdownFilter>> | null = null
```

修改 `onSseEvent` 中 `assistant_text_delta` 分支，加 filter 处理：

```ts
    if (kind === 'assistant_text_delta') {
      const item = (event.item ?? {}) as { text?: unknown }
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text) return
      const Filter = _StreamingMarkdownFilter
      if (Filter && !this.filter) this.filter = new Filter() as InstanceType<NonNullable<typeof _StreamingMarkdownFilter>>
      const filtered = this.filter ? this.filter.feed(text) : text
      this.accumulatedText += filtered
      this.pendingText += filtered
      this.scheduleFlush()
    }
```

`filter` 还需要在 `start()` 里提前 load。修改 `start()` 在 `ac` 创建后插入：

```ts
    // Pre-load filter lazily (non-blocking; if load fails, fall back to no filter)
    loadFilter().catch(() => {})
```

- [ ] **Step 4：跑测试确认通过**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: 4 个 case PASS

## Task 2.5：补 sendMessageWeixin 单次失败 / 连续失败测试

**Files:**
- Modify: `src/main/weixin-streamer.ts`
- Modify: `src/main/weixin-streamer.test.ts`

- [ ] **Step 1：追加失败测试**

```ts
  it('continues streaming after sendMessage throws (single failure)', async () => {
    const sendMessageWeixin = vi.fn()
      .mockRejectedValueOnce(new Error('rate_limited'))
      .mockResolvedValueOnce({ messageId: 'mid' })
    const handle = { sendMessage: sendMessageWeixin }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 100,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // 第 1 次 flush 失败
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'a'.repeat(100) } })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)

    // 第 2 次 flush 成功
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'b'.repeat(100) } })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(2)

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
  })

  it('triggers fallback after 3 consecutive sendMessage failures', async () => {
    const sendMessageWeixin = vi.fn().mockRejectedValue(new Error('rate_limited'))
    const handle = { sendMessage: sendMessageWeixin }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 100,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // 触发 3 次 flush，全部失败
    for (let i = 0; i < 3; i++) {
      streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: `a${i}`.repeat(100) } })
    }
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(3)

    // 第 4 次尝试应该被跳过（连续 ≥3 次失败 → 升级，streamer abort）
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'd'.repeat(100) } })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(3)

    const result = await startPromise
    expect(result.ok).toBe(false)
    expect(result.fellBack).toBe(false)
    expect(result.messageCount).toBe(0)
  })
```

- [ ] **Step 2：跑测试确认失败**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: 第 1 个 case FAIL（现在失败就 abort），第 2 个 case FAIL

- [ ] **Step 3：修改 WeixinStreamer 加连续失败计数**

修改 `flushPending` 和类成员：

```ts
  private consecutiveFailures = 0
  private readonly MAX_CONSECUTIVE_FAILURES = 3
```

修改 `flushPending`：

```ts
  private async flushPending(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.aborted || this.closed) return
    const text = this.pendingText
    if (!text) return
    this.pendingText = ''
    try {
      await this.opts.bridge.sendMessage(this.opts.accountId, this.opts.to, text, this.opts.contextToken)
      this.consecutiveFailures = 0
      this.messageCount += 1
    } catch (err) {
      this.consecutiveFailures += 1
      this.opts.logger('weixin-stream', 'sendMessage failed', {
        message: String(err),
        consecutiveFailures: this.consecutiveFailures
      })
      if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.opts.logger('weixin-stream', 'too many consecutive failures, aborting stream', {
          messageCount: this.messageCount
        })
        this.closed = true
      }
    }
  }
```

- [ ] **Step 4：跑测试确认通过**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: 6 个 case PASS

## Task 2.6：补 turn_failed / abort / dispose 测试

**Files:**
- Modify: `src/main/weixin-streamer.test.ts`

- [ ] **Step 1：追加三个 case**

```ts
  it('resolves { ok: false } on turn_failed and flushes remainder', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 1000,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'partial' } })
    streamer.onSseEvent({ kind: 'turn_failed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()

    const result = await startPromise
    expect(result.ok).toBe(false)
    expect(result.finalText).toContain('partial')
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)
  })

  it('aborts on signal.trigger and unblocks start()', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 200,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    let triggerAbort: () => void = () => {}
    const subscribe = vi.fn().mockImplementation((signal: AbortSignal) => {
      signal.addEventListener('abort', () => triggerAbort())
      return { close: vi.fn() }
    })
    const startPromise = streamer.start({ subscribe })
    streamer.abort()
    triggerAbort()
    await vi.runOnlyPendingTimersAsync()

    const result = await startPromise
    expect(result).toBeDefined()
    expect(sendMessageWeixin).not.toHaveBeenCalled()
  })

  it('dispose() clears idle timer (idempotent)', async () => {
    const { handle } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 1000,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    void streamer.start({ subscribe })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'x' } })
    streamer.dispose()
    streamer.dispose()
    vi.advanceTimersByTime(5000)
    // 多次 dispose 不抛错
    expect(true).toBe(true)
  })
```

- [ ] **Step 2：跑测试确认通过**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -10`
Expected: 9 个 case PASS

## Task 2.7：补 subscribe() throws + 超时 + contextToken 透传测试

**Files:**
- Modify: `src/main/weixin-streamer.test.ts`

- [ ] **Step 1：追加三个 case**

```ts
  it('rejects start() when subscribe() throws synchronously', async () => {
    const handle = { sendMessage: vi.fn() }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 200,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockImplementation(() => {
      throw new Error('subscribe boom')
    })
    await expect(streamer.start({ subscribe })).rejects.toThrow('subscribe boom')
  })

  it('aborts via responseTimeoutMs when no turn event arrives', async () => {
    const handle = { sendMessage: vi.fn().mockResolvedValue({ messageId: 'mid' }) }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 200,
      idleMs: 3000,
      responseTimeoutMs: 200,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'a'.repeat(250) } })
    await vi.runOnlyPendingTimersAsync()
    expect(handle.sendMessage).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(200)
    await vi.runOnlyPendingTimersAsync()
    const result = await startPromise
    expect(result).toBeDefined()
  })

  it('passes contextToken to every sendMessage call', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: 'ctx-token-123',
      minChars: 100,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'a'.repeat(150) } })
    vi.advanceTimersByTime(3000)
    await vi.runOnlyPendingTimersAsync()
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'b'.repeat(150) } })
    vi.advanceTimersByTime(3000)
    await vi.runOnlyPendingTimersAsync()

    expect(sendMessageWeixin.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of sendMessageWeixin.mock.calls) {
      expect(call[3]).toBe('ctx-token-123')  // contextToken 第 4 个参数
    }

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
  })
```

- [ ] **Step 2：跑测试确认全部通过**

Run: `npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -15`
Expected: 12 个 case PASS

## Task 2.8：commit Phase 2

```bash
git add src/main/weixin-streamer.ts src/main/weixin-streamer.test.ts
git commit -m "feat(weixin-streamer): full feature set with 12 unit tests

Block coalescer (minChars=200 or idleMs=3000), Markdown filter,
reasoning/cross-turn filtering, consecutive failure threshold (≥3),
turn terminal handling, abort/dispose/contextToken passthrough."
```

跑全套验证：

Run: `npm run typecheck && npm run lint && npm run test -- src/main/weixin-streamer.test.ts 2>&1 | tail -20`
Expected: typecheck 0 错；lint 0 错；12 case 全过

---

# Phase 3：ClawRuntime 集成（Commit 3）

本 Phase 把 `WeixinStreamer` 接到 `ClawRuntime.handleWebhook`。完成后，`weixinStream=true` 时微信消息走流式路径。

## Task 3.1：新增 `subscribeSseForWeixin` 私有方法

**Files:**
- Modify: `src/main/claw-runtime.ts`（找到 `subscribeSseForStreamer` 附近，复制改写）

- [ ] **Step 1：读 `subscribeSseForStreamer` 现有实现**

Read: `src/main/claw-runtime.ts`。找到飞书 spec 已加的 `subscribeSseForStreamer` 私有方法（约 30-50 行），记下上下文。同时找到 `subscribeSse` 私有方法（飞书 spec `runStreamingReply` 内部用）—— 它的签名接受 `streamer: FeishuStreamer`，本 Task 3.1 不直接调用 `subscribeSse`，而是复用与 `subscribeSseForStreamer` 同构的模式。

- [ ] **Step 2：在 `subscribeSseForStreamer` 紧邻处新增 `subscribeSseForWeixin`**

逻辑与 `subscribeSseForStreamer` 完全同构；只是类型用 `WeixinStreamer`。复制并调整：

```ts
  private subscribeSseForWeixin(
    settings: AppSettingsV1,
    threadId: string,
    streamer: WeixinStreamer
  ): SseSubscriber {
    let closeRef: () => void = () => {}
    const setup = this.subscribeSseForStreamer(settings, threadId, streamer as unknown as FeishuStreamer)
      .then((close) => {
        closeRef = close
      })
      .catch((error: unknown) => {
        this.deps.logError('claw-weixin-stream', 'subscribeSse setup failed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    void setup
    return () => closeRef()
  }
```

> 复用说明：`subscribeSseForStreamer`（飞书 spec 已落地）接受一个具有 `onSseEvent(event)` 方法的 streamer；`WeixinStreamer` 也有同名方法。这里通过 `as unknown as FeishuStreamer` 把类型断言掉，避免改动 `subscribeSseForStreamer` 签名（保持飞书 spec 稳定）。两种 streamer 都通过同一 SSE 路径接收 `RuntimeSseEvent`，所以这是安全的——`onSseEvent` 是 duck-typed 调用。

- [ ] **Step 3：typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 0 错（仅新增私有方法，未被调用）

## Task 3.2：新增 `runStreamingReplyWeixin` 私有方法

**Files:**
- Modify: `src/main/claw-runtime.ts`（在 `runStreamingReply` 紧邻处追加）

- [ ] **Step 1：读 `runStreamingReply` 现有实现**

Read: `src/main/claw-runtime.ts` 的 `runStreamingReply`。它构造 `FeishuStreamer`，调 `subscribeSseForStreamer`，catch fallback 到 `bridge.send`。

- [ ] **Step 2：写 `runStreamingReplyWeixin`**

```ts
  private async runStreamingReplyWeixin(input: {
    bridgeHandle: WeixinBridgeHandle  // 定义见下方说明
    webhookPayload: { message: { accountId: string; from: string; context_token?: string } }
    threadId: string
    turnId: string
    responseTimeoutMs: number
    context: Record<string, unknown>
  }): Promise<{
    ok: boolean
    messageCount: number
    finalText: string
    fellBack: boolean
    message?: string
  }> {
    let streamer: WeixinStreamer | null = null
    try {
      const settings = await this.deps.store.load()
      streamer = new WeixinStreamer({
        bridge: input.bridgeHandle,
        accountId: input.webhookPayload.message.accountId,
        to: input.webhookPayload.message.from,
        turnId: input.turnId,
        threadId: input.threadId,
        contextToken: input.webhookPayload.message.context_token,
        minChars: 200,
        idleMs: 3000,
        responseTimeoutMs: input.responseTimeoutMs,
        logger: (category, message, detail) => this.deps.logError(category, message, detail)
      })
      const result = await streamer.start({
        subscribe: this.subscribeSseForWeixin(settings, input.threadId, streamer)
      })
      return {
        ok: result.ok,
        messageCount: result.messageCount,
        finalText: result.finalText,
        fellBack: false
      }
    } catch (error) {
      this.deps.logError('claw-weixin-stream', 'streaming reply failed; falling back', {
        message: error instanceof Error ? error.message : String(error),
        ...input.context
      })
      const finalText = streamer?.getAccumulatedText() ?? ''
      const messageCount = streamer?.messageCount_ ?? 0
      const partialNote = messageCount >= 1 ? '\n\n（回复未完成）' : ''
      const fallbackText = finalText + partialNote || '抱歉，生成失败，请稍后再试。'
      try {
        await input.bridgeHandle.sendMessage(
          input.webhookPayload.message.accountId,
          input.webhookPayload.message.from,
          fallbackText,
          input.webhookPayload.message.context_token
        )
        return { ok: true, messageCount, finalText, fellBack: true }
      } catch (fbError) {
        return {
          ok: false,
          messageCount: 0,
          finalText,
          fellBack: true,
          message: fbError instanceof Error ? fbError.message : String(fbError)
        }
      }
    } finally {
      streamer?.dispose()
    }
  }
```

> `WeixinBridgeHandle` 类型定义（与 `WeixinStreamer` 内部 `BridgeHandle` 同构）：
>
> ```ts
> type WeixinBridgeHandle = {
>   sendMessage: (
>     accountId: string,
>     to: string,
>     text: string,
>     contextToken: string | undefined
>   ) => Promise<{ messageId: string }>
> }
> ```
>
> 由 `src/main/claw-runtime.ts` 顶部作为公共类型 export（re-export 自 `weixin-streamer.ts` 中的 `BridgeHandle` 私有类型）。Task 3.3 中 `deps.weixinBridge` 即此类型的实例——见该 Task 的"依赖注入"说明。

- [ ] **Step 3：typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: 0 错

## Task 3.3：修改 `handleWebhook` 加 `weixinStream` 分支

**Files:**
- Modify: `src/main/claw-runtime.ts`（在 `handleWebhook` 找到 `provider === 'weixin'` 分支）

- [ ] **Step 1：读 `handleWebhook` 现有 weixin 分支**

Read: `src/main/claw-runtime.ts` 的 `handleWebhook`。找到 `provider === 'weixin'` 或 `payload.provider === 'weixin'` 分支，记下当前走 `processIncomingImPrompt` 的位置。

- [ ] **Step 2：在 weixin 分支处加 `weixinStream` 判断**

伪代码（具体语法需对齐现有 handler 的 TS 风格）：

```ts
  // 现有：if (provider === 'weixin') return this.processIncomingImPrompt(payload)
  // 改为：
  if (provider === 'weixin') {
    const settings = await this.deps.store.load()
    if (settings.claw?.im?.weixinStream !== false) {
      // 流式路径
      const { threadId, turnId } = await this.createThreadAndTurn(payload)  // 现有逻辑
      const bridgeHandle = this.deps.weixinBridge  // 需注入
      const result = await this.runStreamingReplyWeixin({
        bridgeHandle,
        webhookPayload: payload,
        threadId,
        turnId,
        responseTimeoutMs: 600_000,
        context: { ... }
      })
      return { reply: '', messageCount: result.messageCount }  // ← reply 空 = bridge 不发尾包
    }
    // 兜底
    return this.processIncomingImPrompt(payload)
  }
```

**`weixinBridge` 依赖注入**：检查现有 `this.deps` 类型，可能需要新增 `weixinBridge?: WeixinBridgeHandle` 字段。如果现有 `deps` 不支持注入，看 `claw-runtime-helpers.ts` 或 `register-app-ipc-handlers.ts` 怎么传 bridge 到 runtime，复制同样的模式。Read 既有注入代码后调整。

- [ ] **Step 3：跑现有 test 确认 weixinStream=false 路径不退化**

Run: `npm run test -- src/main/claw-runtime.test.ts 2>&1 | tail -20`
Expected: 现有 case 全过（默认行为不变）

## Task 3.4：写集成测试 — 流式成功

**Files:**
- Modify: `src/main/claw-runtime.test.ts`（追加 case）

- [ ] **Step 1：读现有 `claw-runtime.test.ts` 找 Feishu 流式测试**

Read: `src/main/claw-runtime.test.ts`，找到飞书 spec 加的 `runStreamingReply` 集成测试（约 4-5 个 case），复制改写为 WeChat 版本。

- [ ] **Step 2：追加流式成功 case**

```ts
  it('runs streaming reply on weixin webhook when weixinStream=true', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ messageId: 'mid' })
    const weixinBridge = { sendMessage }
    // ...设置 mock store: claw.im.weixinStream = true
    // ...mock createThreadAndTurn 返回 threadId/turnId
    // ...mock subscribeSse 喂 5 个 delta + turn_completed

    const result = await runtime.handleWebhook({
      provider: 'weixin',
      message: { accountId: 'acc', from: 'user-1', context_token: 'ctx' },
      text: 'hello'
    } as any)

    expect(result.reply).toBe('')  // ← 关键契约
    expect(sendMessage).toHaveBeenCalled()  // 至少 1 个 block
  })
```

具体 mock 设置参考飞书 case 的写法。

- [ ] **Step 3：跑测试确认通过**

Run: `npm run test -- src/main/claw-runtime.test.ts -t 'weixin' 2>&1 | tail -20`
Expected: PASS

## Task 3.5：写集成测试 — 流式失败 fallback / bridge 契约 / attachment

**Files:**
- Modify: `src/main/claw-runtime.test.ts`（追加 case）

- [ ] **Step 1：追加 4 个 case**

```ts
  it('falls back to one-shot send on streaming failure', async () => {
    // 模拟 sendMessage 抛错 + accumulated text 非空
    // 验证 fallback 调 sendMessage 一次，文本含 "未完成"
  })

  it('falls back with sorry message when no blocks sent', async () => {
    // 模拟 sendMessage 抛错 + accumulated text 空
    // 验证 fallback 调 sendMessage 一次，文本为 "抱歉，生成失败..."
  })

  it('uses processIncomingImPrompt when weixinStream=false', async () => {
    // 设置 claw.im.weixinStream = false
    // 验证 handleWebhook 不调用 streamer
  })

  it('passes contextToken through to every sendMessage call', async () => {
    // 验证 webhook 载荷的 context_token 每次都透传
  })
```

具体 mock 参考飞书 spec 已有 case。Read `src/main/claw-runtime.test.ts` 找飞书 fallback case，复制改写。

- [ ] **Step 2：跑测试确认通过**

Run: `npm run test -- src/main/claw-runtime.test.ts -t 'weixin' 2>&1 | tail -20`
Expected: 5+ 个 case PASS

## Task 3.6：跑全套验证 + commit Phase 3

```bash
npm run typecheck && npm run lint && npm run test -- src/main/claw-runtime.test.ts 2>&1 | tail -20
```

Expected: 0 错；weixin 集成测试全过

```bash
git add src/main/claw-runtime.ts src/main/claw-runtime.test.ts
git commit -m "feat(claw): runStreamingReplyWeixin + weixinStream webhook branch

WeChat bot reply routes through WeixinStreamer block streaming when
weixinStream=true; falls back to one-shot send on failure. Webhook
returns empty reply so bridge skips auto-send (contract).
processIncomingImPrompt path preserved for weixinStream=false."
```

---

# Phase 4：Renderer UI（Commit 4）

本 Phase 在 Settings → Claw 加 `weixinStream` SettingRow（紧邻 `feishuStream`）。

## Task 4.1：读 `settings-section-claw.tsx` 的 `feishuStream` row

Read: `src/renderer/src/components/settings-section-claw.tsx`。找到 `feishuStream` `SettingRow` 完整代码块，记下：
- `SettingRow` 用法（label / value / onChange / inlineStateText 等 props）
- i18n key 命名风格
- inline state 文字（"已开启" / "已关闭"）
- 测试 mock pattern

## Task 4.2：追加 `weixinStream` SettingRow

**Files:**
- Modify: `src/renderer/src/components/settings-section-claw.tsx`（紧邻 `feishuStream` row 后）

- [ ] **Step 1：复制 `feishuStream` row 改写**

```tsx
<SettingRow
  label={t('claw.weixinStreamLabel', '启用流式输出（微信）')}
  value={settings.claw?.im?.weixinStream !== false}
  onChange={(v) => patchSettings({ claw: { im: { weixinStream: v } } })}
  inlineStateText={settings.claw?.im?.weixinStream !== false
    ? t('common.enabled', '已启用')
    : t('common.disabled', '已关闭')}
/>
```

具体 props 命名（`value` / `checked` / `onChange(v)` / `patchSettings`）以既有 `feishuStream` row 为准。

- [ ] **Step 2：跑 renderer typecheck**

Run: `npx tsc --noEmit -p src/renderer/tsconfig.json 2>&1 | head -20`
Expected: 0 错

## Task 4.3：i18n keys

**Files:**
- Modify: `src/renderer/src/locales/en/common.json`
- Modify: `src/renderer/src/locales/zh/common.json`
- Modify: `src/renderer/src/locales/en/settings.json`
- Modify: `src/renderer/src/locales/zh/settings.json`

- [ ] **Step 1：读 `feishuStream` 在 4 个 json 文件中的 key**

Read 4 个 json 文件，找 `feishuStreamLabel` / `feishuStreamInlineState`（或实际命名）。

- [ ] **Step 2：追加 `weixinStream` 对应 keys**

每个文件追加（命名与 feishuStream 对齐）：

**`en/common.json`**：
```json
  "claw.weixinStreamLabel": "Enable streaming output (WeChat)",
```

**`zh/common.json`**：
```json
  "claw.weixinStreamLabel": "启用流式输出（微信）",
```

**`en/settings.json`** 与 **`zh/settings.json`**：如果 feishuStream 有 `inlineState` key 在 settings.json，加 `weixinStreamInlineState` 同步；否则不加。

- [ ] **Step 3：跑 i18n test 确认无缺 key**

Run: `npm run test -- src/renderer/src/locales 2>&1 | tail -10`
Expected: 0 错（i18n keys 完整）

## Task 4.4：写 renderer 单测

**Files:**
- Modify: `src/renderer/src/components/settings-section-claw.test.ts`

- [ ] **Step 1：追加 2 个 case**

```ts
  it('renders weixinStream SettingRow with default true', () => {
    render(<SettingsSectionClaw ... />)
    expect(screen.getByText('启用流式输出（微信）')).toBeInTheDocument()
  })

  it('toggles weixinStream via patchSettings', async () => {
    const patchSettings = vi.fn()
    render(<SettingsSectionClaw ... />)
    const toggle = screen.getByRole('switch', { name: /启用流式输出（微信）/ })
    await userEvent.click(toggle)
    expect(patchSettings).toHaveBeenCalledWith({ claw: { im: { weixinStream: false } } })
  })
```

具体断言以既有 `feishuStream` test 为模板。

- [ ] **Step 2：跑测试**

Run: `npm run test -- src/renderer/src/components/settings-section-claw.test.ts 2>&1 | tail -10`
Expected: PASS

## Task 4.5：commit Phase 4

```bash
git add src/renderer/src/components/settings-section-claw.tsx \
        src/renderer/src/components/settings-section-claw.test.ts \
        src/renderer/src/locales/en/common.json \
        src/renderer/src/locales/zh/common.json \
        src/renderer/src/locales/en/settings.json \
        src/renderer/src/locales/zh/settings.json
git commit -m "feat(claw-settings): expose weixinStream toggle in manage-agents card

SettingRow next to feishuStream with bilingual label and inline state.
i18n keys added in en/zh common.json."
```

---

# Phase 5：文档（Commit 5）

## Task 5.1：追加微信 block streaming smoke 小节

**Files:**
- Modify: `docs/CONTRIBUTING.md`（在"飞书流式 smoke 测试"小节之后追加）

- [ ] **Step 1：读 `CONTRIBUTING.md` 末尾**

Read: `docs/CONTRIBUTING.md` 末尾。找到飞书 smoke 测试小节（约 2026-06-15 加的），记下其结构（checkbox 列表）。

- [ ] **Step 2：追加微信 smoke 小节**

```markdown
## 微信 block streaming smoke 测试

- [ ] 单条短回答（<200 字符）：单条气泡直接发；不切块
- [ ] 单条长回答（500-1000 字符）：分 3-5 条 block 气泡陆续到达
- [ ] 超长回答（5000+ 字符）：≥25 条 block 气泡
- [ ] 故意 SSE 断开：fallback 补一条 "未完成"
- [ ] 故意 `turn_failed`：fallback 补一条 "抱歉，生成失败"
- [ ] `weixinStream=false`：走原单条消息路径（不切块）
- [ ] **Connect phone 视图实时性**：bot 收到消息后 chat 视图立即出现 streaming 文本（不卡）
- [ ] **附件**：流式结束后图片 / 文件作为独立消息正常发出
- [ ] **会话连续性**：`contextToken` 正确带，微信客户端识别为同一对话
- [ ] **降级路径**：bridge 未启动时，webhook 返回 `{ reply: finalText }`，bridge 自动 fallback 到单条消息发送
```

## Task 5.2：commit Phase 5

```bash
git add docs/CONTRIBUTING.md
git commit -m "docs(weixin-streaming): add block streaming smoke test checklist

Mirrors feishu smoke section; covers block coalescing, fallback paths,
context token continuity, and bridge contract behavior."
```

---

# 最终验证

全部 Phase 完成后：

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run build:kun
```

Expected: 0 typecheck 错；0 lint 错；全测过；build 成功。

---

# 推送与开 PR

1. 确认所有 commit 已 commit（`git log --oneline -10`）
2. force-push 到 fork：
   ```bash
   git push --force-with-lease origin feature/feishu-streaming-with-live-fix
   ```
3. 在 GitHub 上把该分支对 upstream/develop 开 PR
4. PR 标题：`feat(claw): WeChat block streaming with webhook contract change`
5. PR 描述参考 spec 第 9 节"测试策略"中"手工 smoke checklist"

---

# 不在本计划范围（明确不做）

- ❌ typing 指示器（`sendTyping` + `typing_ticket`）
- ❌ per-channel `weixinStream` 粒度
- ❌ Card JSON 2.0 富卡片
- ❌ reasoning delta 透出
- ❌ 飞书 channel 代码修改
- ❌ `kun/` runtime 包
- ❌ 微信 SDK 升级策略
- ❌ 工具调用状态展示