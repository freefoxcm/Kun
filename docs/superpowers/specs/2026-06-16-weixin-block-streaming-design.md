# 微信 / WeChat 接入鲲后流式输出设计（block streaming 形态）

**日期**：2026-06-16
**状态**：已通过 brainstorming，待用户复审后进入 writing-plans
**适用范围**：`src/main/claw-runtime.ts` 中微信 / WeChat 入站消息的回复链路；其它渠道不在本期范围
**前身**：`docs/superpowers/specs/2026-06-15-feishu-streaming-with-live-fix-design.md`（飞流式 spec，本 spec 与之同构，差异点见第 3 节"关键差异点"）

## 背景

飞书流式（2026-06-15 spec）落地后，`docs/superpowers/specs/2026-06-15-feishu-streaming-with-live-fix-design.md` 的"后续可扩展"小节**明确列出**：

> WeChat 渠道流式（需要先确认微信侧是否有对应能力）

本期做以下确认与扩展：

1. **确认微信侧能力**：经查 `node_modules/@tencent-weixin/openclaw-weixin/` plugin SDK 源码：
   - iLink Bot API **无原生流式消息 API**（无 `streamMessage` / `editMessage` / 增量 append）
   - 但 plugin SDK 已声明 `capabilities.blockStreaming: true` 和 `streaming.blockStreamingCoalesceDefaults: { minChars: 200, idleMs: 3000 }`
   - 含义：channel 接受 SSE deltas，framework 按"≥200 字符 或 静默 3 秒"任一条件触发，发**新的、独立的**完整消息气泡
   - 已存在 `StreamingMarkdownFilter`（`src/messaging/markdown-filter.ts`），是 char 级 markdown 状态机，可直接复用

2. **架构差异**：微信入站路径是 HTTP webhook（`weixin-bridge-runtime.ts` → `/claw/im`），与飞书的 WS push 直连 `ClawRuntime` 不同。这意味着：
   - 飞书的 `bridge.stream()` 单卡编辑模型无法复用
   - 微信的"block streaming"在主进程侧由我们实现 `WeixinStreamer`，经由 `weixinBridgeRuntime.sendWeixinBridgeMessage()` 调用 plugin 的 `sendMessageWeixin()`
   - 关键契约变化：**流式开启时 webhook 返回 `{ reply: '' }`** —— bridge 据此不发送尾包

3. **renderer 侧无需新工作**：飞书 spec 已经修复了 `showLiveAssistant` 门控和 `subscribeThreadEventsLive`，这两处对所有渠道通用，微信流式直接受益。

## 目标与非目标

### 目标

- 微信 / WeChat bot 收到入站消息后，agent 回复按"≥200 字符 或 静默 3 秒"自动切成**多条独立消息气泡**发出，每条 ≥200 字符。
- 用户在微信客户端看到的是**陆续到达的若干条短消息**，而不是一次性大段文字。
- Connect phone 视图的 chat 区实时显示流式文本（飞书 spec 已修，**直接复用**）。
- 默认开启（`weixinStream: true`），新装机用户和老用户（settings migration）都启用。
- 失败时降级策略：能 partial 补一条就 partial 补一条；连 partial 都没有就"抱歉，生成失败"。
- 附件（image / video / file）行为不变，仍然在文本流式结束后作为独立消息发出。
- 与现有 thread / turn 编排、IM 命令（`/new` `/model` `/help`）、欢迎语共存不冲突。
- 与飞书 `feishuStream` 开关独立：用户可单独关闭微信流式而保留飞书流式（反之亦然）。

### 非目标

- 不暴露工具调用状态（不渲染"正在调用 file_read / bash"等中间行）。
- 不暴露 reasoning / chain-of-thought（过滤掉 `assistant_reasoning_delta`）。
- 不切到 iLink Bot card JSON 2.0 富卡片（plugin SDK 暂未提供）。
- 不发送 typing 指示器（`sendTyping` + `typing_ticket`）—— 微信客户端对 typing 的展示不确定友好；block 消息抵达本身就是提示。
- 不重做"重发 / 编辑历史消息"功能。
- 不解决微信侧限流问题（如遇限流，按 SDK 默认 retry 处理，本期不做额外限流策略）。
- 不改动飞书 channel 的代码（飞书 spec 已是稳定版）。

## 设计决策一览（已与用户确认）

| 维度 | 决策 | 备注 |
|---|---|---|
| 形态 | **Block streaming**（多条独立消息） | iLink Bot API 无 edit/append；与 plugin `blockStreaming: true` 对齐 |
| 切块触发 | `minChars=200` 或 `idleMs=3000` 任一 | 与 plugin `blockStreamingCoalesceDefaults` 对齐 |
| Markdown | 复用 plugin 的 `StreamingMarkdownFilter` | plugin 已实现 char 级状态机；通过 `weixin-bridge-runtime.ts:127` 的现有 import 路径加载（lazy import `openclaw-weixin/dist/src/messaging/send.js`，已 re-export `StreamingMarkdownFilter`） |
| 架构路径 | **Webhook + main 直接调 bridge** | 保留 webhook 路径；main 进程订阅 SSE、按块调 `sendWeixinBridgeMessage` |
| Bridge 契约 | 流式开启时 webhook 返回 `{ reply: '' }` | bridge 据此不发尾包 |
| Settings 粒度 | 全局 `settings.claw.im.weixinStream` | 与 `feishuStream` 一致；per-channel 留作 YAGNI 后续 |
| 默认值 | 开启（`weixinStream: true`） | 新装 + 老 migration |
| typing 指示器 | **不启用** | 仅靠 block 消息抵达提示 |
| 失败降级 | 已发 block 之后补一条"未完成"提示 | fallback 永远不丢消息 |
| 收尾信号 | `turn_completed` / `turn_failed` / `turn_aborted` | 终态事件后 flush 剩余累积文本 |
| 并发入站 | 并行处理 | 与 Feishu 一致 |
| Renderer 自动切 thread | 复用飞书已加的 `subscribeThreadEventsLive` | 不重写 |
| Renderer live bubble | 复用飞书已修的 `showLiveAssistant`（已去掉 `!isProcessing` 门控） | 不重写 |

## 架构

新增/修改模块图（**复用部分用虚线、新增部分用实线**）：

```
┌─────────────────────────────────────────────────────────────────┐
│ Renderer (React + Zustand)                                      │
│  ┌──────────────────────────────────────────────┐               │
│  │ chat-store (飞书 spec 已修)                   │  ←—— onClawChannelActivity 触发
│  │   • subscribeThreadEventsLive()   [复用]    │               │
│  │   • selectThread(threadId)        [保留]    │               │
│  │   • liveAssistant (SSE 实时填充)  [复用]    │               │
│  └──────────────────────────────────────────────┘               │
│  ┌──────────────────────────────────────────────┐               │
│  │ MessageTimeline (飞书 spec 已修)             │  ←—— showLiveAssistant
│  │   showLiveAssistant = !!liveContent.trim()   │       已去掉 !isProcessing 门控
│  └──────────────────────────────────────────────┘               │
└────────────────────┬────────────────────────────────────────────┘
                     │ window.kunGui
┌────────────────────▼────────────────────────────────────────────┐
│ Main (Electron)                                                 │
│  ┌──────────────────────────────────────────────┐               │
│  │ ClawRuntime                                  │               │
│  │   • handleWebhook             [改]          │               │
│  │     - provider=weixin & weixinStream=true    │               │
│  │       → runStreamingReplyWeixin              │               │
│  │     - provider=weixin & weixinStream=false   │               │
│  │       → processIncomingImPrompt (原路径)     │               │
│  │   • runStreamingReplyWeixin    [新增]        │  ← 流式编排   │
│  │   • subscribeSseForWeixin     [新增]        │  ← 适配层     │
│  │   • processIncomingImPrompt    [保留]        │  ← 兜底       │
│  └──────────────┬──────────────┬────────────────┘               │
│                 │              │                                 │
│  ┌──────────────▼───────┐  ┌───▼─────────────────────┐          │
│  │ WeixinStreamer       │  │ claw-runtime-helpers      │          │
│  │   [新增]             │  │   subscribeRuntimeThread  │          │
│  │   块合并器           │  │   Events + SseSubscriber  │          │
│  │   StreamingMarkdown  │  │   [复用飞书已有的]        │          │
│  │   Filter 调用         │  │                           │          │
│  │   sendBlockWeixin    │  │                           │          │
│  └────────┬─────────────┘  └─────┬──────────────────────┘          │
│           │                       │                                  │
└───────────┼───────────────────────┼──────────────────────────────────┘
            │                       │
            │ sendWeixinBridgeMessage  HTTP + SSE
            │ (RPC → bridge)        (kun serve /v1/threads/{id}/events)
┌───────────▼───────────────────────▼──────────────────────────────────┐
│ WeixinBridgeRuntime + plugin SDK (@tencent-weixin/openclaw-weixin)  │
│   • sendMessageWeixin → ilink/bot/sendmessage (每块一调)            │
│   • StreamingMarkdownFilter (char 级 markdown 状态机, 已实现)        │
│   • webhook 接收 → POST /claw/im  (现有路径保留)                    │
└────────────────────────────────────────────────────────────────────┘
```

**关键不变量**：
- 仍然只有一个 live agent runtime（`kun`），不引入任何"运行时切换器"或"流式 provider 切换"。
- 微信流式只是 `handleWebhook` 的一个 `provider==='weixin' && weixinStream===true` 分支。
- **bridge 契约**：流式成功时 webhook 返回 `{ reply: '' }`；bridge 据此不调用 `sendMessageWeixin` 发尾包。bridge 只对附件仍按现状发送。
- 失败永远不丢消息：能 partial 补一条就 partial；连 partial 都没有就"抱歉，生成失败"。
- 现有 `processIncomingImPrompt` 路径完全保留，仅作 `weixinStream=false` 时回退。
- 飞书流式代码、spec、测试**全部保留不动**；本 spec 仅新增模块，不修改飞书代码路径。

## 组件

### 2.1 `WeixinStreamer`（新增）— `src/main/weixin-streamer.ts`

封装"一次微信会话的一条流式回复"的全部状态。

```ts
class WeixinStreamer {
  constructor(opts: {
    bridge: WeixinBridgeHandle        // weixin-bridge-runtime 暴露的 RPC 客户端；
                                      // 封装 { sendMessage(accountId, to, text, contextToken) → Promise<{ messageId }> }
    accountId: string                 // 来自 webhook 载荷 message.accountId
    to: string                        // 来自 webhook 载荷 message.from（即 message.to_user_id）
    turnId: string
    threadId: string
    contextToken: string | undefined  // 来自 webhook 载荷 message.context_token
    minChars: number                  // 默认 200（与 plugin blockStreamingCoalesceDefaults 对齐）
    idleMs: number                    // 默认 3000（与 plugin blockStreamingCoalesceDefaults 对齐）
    responseTimeoutMs: number         // 总超时
    logger: WeixinStreamLogger
  })

  // 启动流式:订阅 SSE 喂数据，块合并器触发时调 sendMessageWeixin。
  // turn 终态后 flush 剩余累积文本。
  // 返回 { ok, messageCount, fellBack }。
  start(input: { subscribe: SseSubscriber }): Promise<WeixinStreamerResult>

  // 外部（SSE 消费者）每收到一个事件调一次
  onSseEvent(event: Record<string, unknown>): void

  getAccumulatedText(): string  // fallback 时用

  abort(): void      // 用户取消 / 超时
  dispose(): void    // 释放 timer + AbortController + 清空状态
}
```

**关键设计**：
- **块合并器**（内部）：每次 `onSseEvent` 收到 delta → 累积到 `pendingText`：
  - 若 `pendingText.length >= minChars`（200），立即 flush：`sendMessageWeixin` 发一条消息
  - 否则，**重置 idle timer**（3000ms）
  - turn 终态事件到达 → 强制 flush 剩余 `pendingText`
  - timer / 终态 任一触发均 flush；flush 后清空 `pendingText`，重置 timer
- **Markdown 过滤**：内部调用 plugin 的 `StreamingMarkdownFilter.feed(delta)` + `flush()`，得到可安全发给微信的文本，再喂给块合并器。Import 路径与 `weixin-bridge-runtime.ts:127` 一致（lazy import `openclaw-weixin/dist/src/messaging/send.js` 已经 re-export `StreamingMarkdownFilter`），保证 plugin 升级时 import 路径不漂移。
- **跨 turn delta**（`event.turnId !== this.opts.turnId`）直接丢弃，避免历史 turn 污染当前回复。
- **reasoning delta**（`assistant_reasoning_delta`）过滤掉，记 debug log。
- 状态机：`pending → streaming → closed`；reasoning delta 不入块合并器。

### 2.2 `subscribeSseForWeixin`（新增）— `ClawRuntime` 私有方法

适配层，把 async `subscribeRuntimeThreadEvents` 包成同步 `SseSubscriber` 契约。

```ts
private subscribeSseForWeixin(
  settings: AppSettingsV1,
  threadId: string,
  streamer: WeixinStreamer
): SseSubscriber
```

**关键设计**：与飞书 spec `subscribeSseForStreamer` 完全同构（直接复制）。同步立刻返回 `{ close: () => closeRef() }`，setup 异步跑；setup 异常在 `void setup.then(...).catch(...)` 记 log，不阻塞主流程——主流程的 fallback 在 `runStreamingReplyWeixin.catch` 里统一处理。

### 2.3 `runStreamingReplyWeixin`（新增）— `ClawRuntime` 私有方法

```ts
private async runStreamingReplyWeixin(input: {
  webhookPayload: WeixinWebhookPayload  // 含 accountId, from, contextToken 等
  threadId: string
  turnId: string
  responseTimeoutMs: number
  context: Record<string, unknown>
}): Promise<{
  ok: boolean
  messageCount: number
  finalText: string
  fellBack: boolean
  message: string
}>
```

**关键设计**：
- 构造 `WeixinStreamer`，串接 `subscribeSseForWeixin` 注入 SSE 喂数据
- 成功 → 返回 `{ ok: true, messageCount, finalText, fellBack: false }`；webhook handler 据此构造 `{ reply: '' }` 给 bridge
- 失败 catch → 把 `streamer.getAccumulatedText()` 拼到一次性 `sendWeixinBridgeMessage` 里 → fallback 永远不丢消息
- `finally` 调 `streamer.dispose()` + `clearTimeout`，资源必然释放
- **失败补条**：若已有 ≥1 个 block 发送成功，fallback 末尾追加一行 `（回复未完成）`，便于用户识别

### 2.4 `handleWebhook` 修改 — `src/main/claw-runtime.ts`

当前 webhook handler 在 `provider==='weixin'` 时统一走 `processIncomingImPrompt`。本期加一个分支：

```ts
// 伪代码：实际实现需考虑 IPC、settings 读取、turn 编排等现有细节
if (payload.provider === 'weixin') {
  const settings = await this.deps.store.load()
  if (settings.claw.im.weixinStream !== false) {
    // 新路径：流式
    const { threadId, turnId } = await this.createThreadAndTurn(...)
    const result = await this.runStreamingReplyWeixin({
      webhookPayload: payload,
      threadId,
      turnId,
      responseTimeoutMs: ...,
      context: { ... }
    })
    return { reply: '', messageCount: result.messageCount, ... }   // ← 关键：reply 为空
  }
  // 现有路径
  return this.processIncomingImPrompt(payload)
}
```

**关键设计**：
- **`reply: ''` 是契约信号**：bridge 看到 `reply` 为空字符串时**不**调用 `sendMessageWeixin`（已存在逻辑：line 950-955 `if (reply)` 守卫）。
- 当 `weixinStream === false` 时，原有路径完全不变。
- 当 `runStreamingReplyWeixin` 抛错时，**仍走 fallback**：webhook 返回 `{ reply: <final text> }`，bridge 用原路径发一次性消息。

### 2.5 `weixinStream` 设置（新增）— `src/shared/app-settings-types.ts` + `src/shared/app-settings-claw.ts` + `src/main/settings-store.ts`

```ts
// src/shared/app-settings-types.ts
interface ClawImSettingsV1 {
  // ...已有字段
  /** 微信渠道流式输出（block streaming 形态）。默认 true。 */
  weixinStream?: boolean
}

// src/shared/app-settings-claw.ts default normalizer
claw.im.weixinStream: true   // 新装用户默认

// src/main/settings-store.ts migration
claw.im.weixinStream ?? true  // 老用户补默认值
```

**关键设计**：
- 全局开关，对所有微信 channel 统一生效
- 单一 boolean 字段，不引入 per-channel 粒度（YAGNI）
- migration 兜底老 settings；新建用户走 default
- 与 `feishuStream` 字段并列，互不影响

### 2.6 Settings UI 入口（修改）— `src/renderer/src/components/settings-section-claw.tsx`

在飞书 `feishuStream` 现有的 `SettingRow` 旁边，加一行 `weixinStream` 切换（同样模式：开关 + inline 状态文字）。

**关键设计**：
- 复用现有 `SettingRow` 组件和 inline 状态文字样式（飞书 spec 已确立的 pattern）
- 不引入新的 UI 抽象

## 数据流（单条入站消息端到端时序）

```
[微信 iLink Bot]
    │
    ▼
[WeixinBridgeRuntime.monitorWeixinAccount]   src/main/weixin-bridge-runtime.ts
    │
    │  1. getUpdates (long-poll) 拿到 message
    │  2. postToDeepSeekGuiWebhook(message, accountId)
    │     │
    │     ▼
    │  [Kun GUI webhook /claw/im]
    │     │
    │     ▼
    │  [ClawRuntime.handleWebhook]   src/main/claw-runtime.ts
    │     │
    │     │  1. buildWeixinPrompt + parse { accountId, from, contextToken, text }
    │     │  2. POST /v1/threads  →  threadId
    │     │  3. POST /v1/threads/{id}/turns  →  turnId
    │     │  4. onTurnStarted: store.patch(threadId)
    │     │  5. onClawChannelActivity({ channelId, threadId })  [IPC → renderer]
    │     │
    │     ▼
    │  [Renderer: chat-store onClawChannelActivity]   (飞书 spec 已修，复用)
    │     │  • refreshThreads()  (异步)
    │     │  • subscribeThreadEventsLive(threadId)   ← 飞书已加，直接复用
    │     │
    │     ▼
    │  [subscribeThreadEventsLive]   src/renderer/src/store/chat-store-thread-actions.ts
    │     │  • reset liveAssistant, liveReasoning, busy:true
    │     │  • window.kunGui.subscribeThreadEvents(threadId, 0, sink, ac.signal)
    │     │  • armBusyWatchdog()
    │     │
    │     ▼
    │  [main: runStreamingReplyWeixin]   ClawRuntime
    │     │
    │     │  ┌─ streamer = new WeixinStreamer({
    │     │  │     bridge: weixinBridgeHandle,
    │     │  │     accountId, to, contextToken, turnId, threadId,
    │     │  │     minChars: 200, idleMs: 3000,
    │     │  │     responseTimeoutMs, logger
    │     │  │  })
    │     │  │
    │     │  ├─ streamer.start({ subscribe: this.subscribeSseForWeixin(...) })
    │     │  │     │
    │     │  │     ├─► subscribeRuntimeThreadEvents:
    │     │  │     │     SSE loop → onEvent → streamer.onSseEvent
    │     │  │     │       • assistant_text_delta + turnId 匹配 → pendingText += filtered
    │     │  │     │       • 若 pendingText.length ≥ 200 → flush: sendMessageWeixin
    │     │  │     │       • 否则重置 idle timer (3000ms)
    │     │  │     │       • assistant_reasoning_delta → 丢弃
    │     │  │     │       • turn_completed/failed/aborted → 强制 flush + close
    │     │  │     │
    │     │  │     └─► { ok: true, messageCount: N, fellBack: false }
    │     │  │
    │     │  └─► { ok, messageCount, finalText, fellBack }
    │     │
    │     ▼
    │  [handleWebhook returns: { reply: '', ... }]   ← 关键契约
    │     │
    │     ▼
    │  [WeixinBridgeRuntime 收到 webhook 响应]
    │     │  • reply 为空字符串 → 不调 sendMessageWeixin 发尾包（line 950 if (reply) 守卫）
    │     │  • 走 sendGeneratedFilesWeixin（若 webhook 响应含 files）
    │     │
    │     ▼
    │  [Renderer chat view]
    │     • liveAssistant 持续增长 → MessageTimeline 实时显示（飞书已修）
    │     • turn 终态后 drainLiveToBlocks → blocks 持久化
    │     • 微信客户端：每收到一个 block 气泡，UI 立即刷新
```

**关键时序不变量**：

| # | 不变量 | 为什么 |
|---|---|---|
| 1 | `subscribeThreadEventsLive` **先**于 main 侧 SSE 订阅生效 | renderer 必须在 SSE 准备好前 reset 状态，否则 deltas 进 `liveAssistant` 时旧 blocks 还在，被新 fetch 覆盖（飞书 bug #1） |
| 2 | 块合并器创建 **先**于 `subscribeRuntimeThreadEvents` 注册 | 避免 "SSE 已就绪但块合并器还没准备好"导致早到达 delta 丢失 |
| 3 | `subscribeRuntimeThreadEvents` 必须在 controller.signal 上挂 abort 监听 | turn 终态后立即关 fetch |
| 4 | 块合并器 flush 一定在 turn 终态后**最后**一次 | 不留尾巴 |
| 5 | `dispose()` 必须在 `finally` 里 | 资源必然释放；不依赖成功路径 |
| 6 | `showLiveAssistant` 渲染判断**不**看 `isProcessing` | 飞书已修，**直接复用** |
| 7 | webhook 返回 `{ reply: '' }` 时 bridge **不**发尾包 | 契约一致；webhook handler 是唯一可信源 |
| 8 | `contextToken` 每次 `sendMessageWeixin` 都要带 | 保证微信客户端识别为同一会话上下文 |

## 错误处理

10 个失败点 × 4 个处理层：

| # | 失败点 | 处理策略 | fallback 触发 |
|---|---|---|---|
| 1 | SSE 订阅失败（4xx / 网络） | `subscribeRuntimeThreadEvents` 自带重试（750ms→5s），4xx 立即终止 | `runStreamingReplyWeixin` catch → 一次性 `sendWeixinBridgeMessage` |
| 2 | SSE 中途断开（Kun 重启） | 已有 block 不撤回；catch 后用 accumulatedText fallback | 同上 |
| 3 | `sendMessageWeixin` 单次抛错（rate_limited / permission_denied） | **不触发 catch**：记 log；流继续（下一块再尝试）；错误计数 +1；连续 ≥3 次错误才升级到"放弃流式"并触发 catch | 仅连续失败超阈值时触发整体 fallback |
| 4 | `StreamingMarkdownFilter` 抛错 | 防御性 try/catch；退化为"原 delta 不经过滤直接喂块合并器" | 不触发 fallback |
| 5 | idle timer 触发后 `sendMessageWeixin` 失败 | 记 log；下一块继续尝试（不放弃整个流） | 不立即触发，整体 catch 时再统一 fallback |
| 6 | `turn_failed` / `turn_aborted` | 强制 flush 剩余 pendingText（best effort），resolve `{ ok: false }` | catch → fallback |
| 7 | 总超时（> `responseTimeoutMs`） | `streamer.abort()` + 取消整个 `runStreamingReplyWeixin` | catch → 一次性 `sendWeixinBridgeMessage`（含 partial） |
| 8 | 二次发文件失败 | 沿用现状：单文件 try/catch，失败名单独发"附件 X 上传失败" | 不走 streaming fallback |
| 9 | bridge RPC 不可用（bridge 未启动 / 端口异常） | `sendWeixinBridgeMessage` 自身抛错 → webhook 仍返回 `{ reply: finalText }`，bridge 用原路径发一次性消息 | catch → 一次性 send（bridge 路径自动降级） |
| 10 | `weixinStream` setting 异常（缺失字段） | migration 兜底 → 默认 true | 无影响 |

**`runStreamingReplyWeixin` 兜底骨架**：

```ts
async runStreamingReplyWeixin(input) {
  let streamer: WeixinStreamer | null = null
  const cancel = new AbortController()
  const timeout = setTimeout(() => cancel.abort(), input.responseTimeoutMs)
  try {
    streamer = new WeixinStreamer({
      bridge: input.bridge,
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
    const settings = await this.deps.store.load()
    const result = await streamer.start({
      subscribe: this.subscribeSseForWeixin(settings, input.threadId, streamer)
    })
    return { ok: result.ok, messageCount: result.messageCount, finalText: result.finalText, fellBack: false }
  } catch (error) {
    this.deps.logError('claw-weixin-stream', 'Weixin streaming reply failed; falling back to one-shot send.', {
      message: error instanceof Error ? error.message : String(error),
      ...input.context
    })
    const finalText = streamer?.getAccumulatedText() || ''
    const partialNote = (streamer?.messageCount ?? 0) >= 1 ? '\n\n（回复未完成）' : ''
    try {
      await input.bridge.sendWeixinBridgeMessage({
        accountId: input.webhookPayload.message.accountId,
        to: input.webhookPayload.message.from,
        text: finalText + partialNote || '抱歉，生成失败，请稍后再试。'
      })
      return { ok: true, messageCount: streamer?.messageCount ?? 0, finalText, fellBack: true }
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
    clearTimeout(timeout)
    streamer?.dispose()
  }
}
```

**不变量**：
- **永远不丢消息**：能 partial 补一条就 partial + "未完成"；连 partial 都没有就"抱歉，生成失败"
- **永远不让用户看到冲突**：bridge 看不到 webhook 内部块合并状态；契约是"reply 为空 = 全部由 webhook 处理"
- **不污染现有路径**：`processIncomingImPrompt` 轮询路径完全保留，微信 `weixinStream=false` 时仍走原路径

## Settings 改动

在 `settings.claw.im`（全局 IM 配置）上加一个开关字段：

```ts
// src/shared/app-settings-types.ts
interface ClawImSettingsV1 {
  // ...已有字段（含 feishuStream）
  /** 当 provider === 'weixin' 时,是否把 agent 回复改为 block streaming。默认 true。 */
  weixinStream?: boolean
}
```

`src/main/settings-store.ts` 的 migration 函数读到老 settings 时，补 `claw.im.weixinStream ?? true`。

本期是**全局开关**，对所有微信渠道统一生效。若未来需要"某个业务账号不流式"，再在 `ClawImChannelV1` 上加 per-channel 字段覆盖（本期不做，YAGNI）。

## 文件清单（按 commit 分组）

### Commit 1：settings 全局开关

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/shared/app-settings-types.ts` | `ClawImSettingsV1` 加 `weixinStream?: boolean` | +5 |
| `src/shared/app-settings-claw.ts` | default normalizer 补 `weixinStream: true` | +5 |
| `src/main/settings-store.ts` | migration 函数加 `claw.im.weixinStream ?? true` | +5 |
| `src/shared/app-settings.test.ts` | migration 测试 | +20 |

### Commit 2：main 侧流式核心

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/main/weixin-streamer.ts` | **新增**，`WeixinStreamer` 类（含块合并器、Markdown 过滤接入、dispose） | ~250 |
| `src/main/weixin-streamer.test.ts` | **新增**，12 个单测 | ~280 |
| `src/main/claw-runtime.ts` | **新增** `runStreamingReplyWeixin` + `subscribeSseForWeixin`；`handleWebhook` 加 `weixinStream` 分支 | +150 |
| `src/main/claw-runtime.test.ts` | 新增 5-6 个端到端 case | +200 |

### Commit 3：renderer 侧 UI 入口

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/renderer/src/components/settings-section-claw.tsx` | 新增 `weixinStream` `SettingRow`（紧邻 `feishuStream`） | +20 |
| `src/renderer/src/components/settings-section-claw.test.ts` | 新增单测 | +30 |
| `src/renderer/src/locales/{en,zh}/{common,settings}.json` | 新增 i18n keys | +20 |

### Commit 4：文档与 smoke

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `docs/superpowers/specs/2026-06-16-weixin-block-streaming-design.md` | **新增**（本文件） | — |
| `docs/superpowers/plans/2026-06-16-weixin-block-streaming.md` | **新增** | ~400 |
| `docs/CONTRIBUTING.md` | 追加"微信 block streaming smoke 测试"小节 | +60 |

**总估算**：~1450 行（含测试、文档）。实际代码 ~600 行。

### 不改的东西（明确范围）

- `kun/` runtime 包：不动（kun 的 `/v1/threads/{id}/events` SSE 端点已经存在）
- `src/main/feishu-streamer.ts` / `src/main/claw-runtime-helpers.ts`：不动（飞书 spec 已是稳定版，本 spec 全部复用）
- `src/renderer/src/components/chat/MessageTimeline.tsx`：不动（飞书 spec 已修）
- `src/renderer/src/store/chat-store-thread-actions.ts`：不动（飞书 spec 已加 `subscribeThreadEventsLive`）
- `src/main/weixin-bridge-runtime.ts`：不动（webhook 契约变更只在 ClawRuntime 侧）
- `node_modules/@tencent-weixin/openclaw-weixin/`：不动（plugin 已是稳定版）
- 现有 `processIncomingImPrompt` / `waitForAssistantResult` 路径：保留
- 飞书 channel 代码：不动
- 其它渠道（Slack / Telegram / 企业微信 等）：不在范围

## 测试策略

### 6.1 单元测试 — `src/main/weixin-streamer.test.ts`

fake `WeixinBridgeHandle`（`sendMessageWeixin` 用 `vi.fn`）+ 可控 SSE 事件流 + 假时钟。覆盖：

| # | 用例 | 验证 |
|---|---|---|
| 1 | 正常路径（5 个小 delta 累积触发 1 个 block + turn_completed flush 1 个 block） | `sendMessageWeixin` 被调 2 次；messageCount=2；resolve `{ ok: true }` |
| 2 | 大 delta 立即触发（一次性 250 字符） | `sendMessageWeixin` 在 idle timer 之前立即调一次 |
| 3 | idle timer 触发（连续小 delta 累加 100 字符，3 秒静默） | timer 到期后调一次 `sendMessageWeixin` |
| 4 | reasoning delta 过滤 | `assistant_reasoning_delta` 不入 pendingText，只记 log |
| 5 | 跨 turn 过滤 | `turnId !== this.turnId` 的 delta 丢弃 |
| 6 | Markdown 过滤（`<img src=x>`） | `StreamingMarkdownFilter` 调用后图片标签被剥离 |
| 7 | `sendMessageWeixin` 抛错（rate_limited，单次） | 记 log；流继续；不立刻终止；连续 ≥3 次错误才触发 catch |
| 8 | `subscribe()` 同步抛错 | `start()` reject |
| 9 | `turn_failed` | 强制 flush 剩余；resolve `{ ok: false }` |
| 10 | 取消（abort） | `nextDelta()` / idle timer 永久挂起；signal 触发 abort 后全部解锁 |
| 11 | 超时（200ms） | `responseTimeoutMs = 200` 触发 abort |
| 12 | `contextToken` 透传 | mock `sendMessageWeixin` 验证每次调用都带原 contextToken |
| 13 | `dispose()` 清 timer | 多次 dispose 幂等；不触发额外 sendMessage |

### 6.2 集成测试 — `src/main/claw-runtime.test.ts`

mock `WeixinBridgeHandle` + mock `WeixinBridgeRuntime` + 可控 HTTP / SSE 响应。覆盖：

| # | 用例 | 验证 |
|---|---|---|
| 1 | 流式成功 | createThread → startTurn → `runStreamingReplyWeixin` → 5 个 block 触发 → turn_completed → webhook 返回 `{ reply: '' }` |
| 2 | 流式降级 | 模拟 `sendMessageWeixin` 全程失败 → catch → fallback 一次性 send 含 partial + "未完成" |
| 3 | 完全失败（无 block 发送过） | fallback 一次性 send "抱歉，生成失败" |
| 4 | 附件仍发送 | `shouldSendGeneratedFilesForPrompt` 命中时，webhook 响应含 files → bridge 走 `sendGeneratedFilesWeixin` |
| 5 | `weixinStream = false` | 设置关闭时，`handleWebhook` 走原 `processIncomingImPrompt` 路径，不创建 `WeixinStreamer` |
| 6 | SSE 重连 | 模拟 SSE 5xx 一次，验证重连成功后续 block 仍正常发送 |
| 7 | `weixinStream` migration | 老 settings（无 `weixinStream` 字段）migration 后默认 `true` |
| 8 | bridge 契约 | 流式成功时 webhook 响应 `reply === ''`；`weixinStream=false` 时 `reply !== ''` |
| 9 | `contextToken` 透传 | webhook 载荷含 `message.context_token`，验证每次 `sendMessageWeixin` 调用都带它 |

### 6.3 Renderer 单元测试 — `settings-section-claw.test.ts`

| # | 用例 | 验证 |
|---|---|---|
| 1 | 渲染 `weixinStream` SettingRow | 默认 `true`，UI 渲染开启态 |
| 2 | 切换 `weixinStream` 到 false | 调用 IPC 更新 settings，刷新后渲染关闭态 |
| 3 | i18n keys 存在 | `en/common.json`、`zh/common.json`、`en/settings.json`、`zh/settings.json` 都有 `weixinStream` 相关 keys |

### 6.4 UI 渲染测试

`MessageTimeline` 和 `subscribeThreadEventsLive` 不动（飞书 spec 已覆盖）。无需新测试。

### 6.5 手工 / 真实微信 smoke checklist

写进 `docs/CONTRIBUTING.md`：

- [ ] 单条短回答（<200 字符）：单条气泡直接发；不切块
- [ ] 单条长回答（500-1000 字符）：分 3-5 条 block 气泡陆续到达
- [ ] 超长回答（5000+ 字符）：≥25 条 block 气泡
- [ ] 故意 SSE 断开：fallback 补一条 "未完成"
- [ ] 故意 `turn_failed`：fallback 补一条 "抱歉，生成失败"
- [ ] `weixinStream=false`：走原单条消息路径（不切块）
- [ ] **Connect phone 视图实时性**：bot 收到消息后 chat 视图立即出现 streaming 文本（不卡，飞书 spec 已修）
- [ ] **附件**：流式结束后图片 / 文件作为独立消息正常发出
- [ ] **会话连续性**：`contextToken` 正确带，微信客户端识别为同一对话
- [ ] **降级路径**：bridge 未启动时，webhook 返回 `{ reply: finalText }`，bridge 自动 fallback 到单条消息发送

### 6.6 验证命令

实现完成后必跑：

```bash
npm run typecheck        # 严格类型
npm run lint             # 风格
npm run test             # 全部单元测试
npm run build            # 整包构建（GUI + kun）
npm run build:kun        # runtime 包单独构建
# 手动（Electron + HMR 启动 + 真微信账号登录）—— 用户手工
npm run dev
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| iLink Bot `sendmessage` QPS 限流（高频 sendMessage） | 块合并器 `minChars=200` + `idleMs=3000` 默认值是 plugin SDK 团队定的保守值，本 spec 直接对齐，不自己再调；出问题先在 plugin 配置上调 `blockStreamingCoalesceDefaults` |
| iLink Bot 消息速率限制（同一 user 短时间内大量消息） | `sendMessageWeixin` 现有 retry（SDK 默认）兜底；本期不引入额外限流 |
| `contextToken` 失效（多端登录 / 重新登录） | webhook 载荷每次带最新 `context_token`；streamer 始终用最新；过期时 `sendMessageWeixin` 抛错，走 fallback |
| `StreamingMarkdownFilter` 边界 case（罕见 markdown 组合） | 防御性 try/catch；过滤失败时退化为"原 delta 直接喂块合并器"；plugin 团队已实现成熟，信任其健壮性 |
| 入站消息风暴（同一 channel 连续多条） | 现状不背 IM 队列；新方案并行处理，每条入站开独立 streamer——本设计接受这种行为 |
| webhook 返回 `reply: ''` 与现有非流式契约混淆 | 仅当 `provider==='weixin' && weixinStream===true` 时返回空；其他情况（飞书 / webhook / feishuStream=false / 错误路径）仍走原契约。**严格测试覆盖分支条件** |
| bridge 已发送的 block 与 fallback 一次性消息重复发送 | 契约保证：webhook handler 是唯一决定 "reply 内容" 的地方；bridge 只读 `reply` 字段；流式路径上 `reply=''` 时 bridge 完全不发送文本消息 |
| renderer `showLiveAssistant` 被重新加回 `!isProcessing` 门控（飞书 bug #2 复发） | 飞书 spec 单测 + snapshot 已覆盖；本 spec 不修改 renderer |
| plugin SDK 升级后 `blockStreaming` 行为变化 | 锁版本（package.json），升级前在 smoke 跑过；与 plugin 团队对齐升级窗口 |
| main 进程订阅 SSE 资源未释放（重复订阅 leak） | `streamer.dispose()` 显式调用，`finally` 块保证；单测覆盖多次 dispose 幂等 |

## 后续可扩展（不在本期）

- Card JSON 2.0 富卡片（plugin 暂未提供）
- 透出 reasoning delta（折叠区）
- IM 内"重发 / 编辑"上一条消息（需要把 messageId 持久化到 settings）
- Per-channel 粒度的 `weixinStream` 开关
- 打字指示器（`sendTyping` + `typing_ticket`）—— 本期决定不启用，若用户反馈"消息开始看不出在生成"再开
- 把 `subscribeThreadEventsLive` 推广到其它渠道（Slack / Telegram 等）
- 微信 channel 的工具调用状态展示（plugin SDK 未提供）
- 块合并策略自适应（按 SSE delta 速率动态调整 minChars / idleMs）