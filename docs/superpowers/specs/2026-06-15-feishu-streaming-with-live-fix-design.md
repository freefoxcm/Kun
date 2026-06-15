# 飞书 / Lark 接入鲲后流式输出设计（带 live 视图卡顿修复）

**日期**:2026-06-15
**状态**:已通过 brainstorming,待用户复审后进入 writing-plans
**适用范围**:`src/main/claw-runtime.ts` 中飞书 / Lark 入站消息的回复链路;WeChat 渠道不在本期范围
**前身**:`D:\workspace\DeepSeek\DeepSeek-GUI` 的 `feature/feishu-streaming-bot-output` 分支上的同主题实现(2026-06-12);本次在 `develop` 上重建并修复 live 视图卡顿 bug

## 背景

`feature/feishu-streaming-bot-output` 分支上做过一版飞书流式,实现后用户报告 **bot 消息到达后,飞书 SDK 卡在实时刷新,但 Connect phone 视图的 chat 区一直不动,直到 turn 结束才看到文本**。

经排查,根因有两处叠加:

1. **`selectThread` 同步 HTTP 抢在 SSE 之前**。`onClawChannelActivity` 触发自动切换到 bot thread 时,调的是 `selectThread(threadId)`。`selectThread` 内部先 `await getThreadDetail()` 拉元数据 + 持久化 blocks,**然后**才打开 SSE。在 HTTP 往返期间,deltas 已经流入 chat-store,随后被 fetch 返回的旧 `blocks` 覆盖,deltas 消失。
2. **streaming 期间 live bubble 被 `isProcessing` 门控隐藏**。`MessageTimeline.tsx` 里 `showLiveAssistant = !isProcessing && !!liveContent.trim()`。turn 进行中(`busy: true`)时,bubble 被藏起来,只有 `WorkMetaRow` 处理指示器可见。`liveAssistant` 文本确实在累积,但用户看不到 —— 必须等 `turn_completed` 才一次性显示,视觉上像"卡住"。

上版在分支末尾提交了 `b12d4ba` 和 `eb9755c` 修这两个 bug,但因为是分支末尾的 fix,从未与本次主流程一起在干净的 `develop` 上验证过。本次目标是把整个流式故事 + 这两处修复从 day-1 一起做,走完整 spec/plan/test/smoke 闭环。

`develop` 分支当前状态(本分支起点):
- `src/main/feishu-streamer.ts` 不存在
- `src/shared/app-settings-types.ts` 没有 `feishuStream` 字段
- `chat-store-navigation-actions.ts:410` `onClawChannelActivity` 仍调 `selectThread` —— bug #1 仍在
- `MessageTimeline.tsx:448` 仍是 `!isProcessing &&` 门控 —— bug #2 仍在

## 目标与非目标

### 目标

- 飞书 / Lark bot 收到入站消息后,只回一条 SDK 流式卡(Message Bubble),内容随 agent run 实时刷新。
- Connect phone 视图的 chat 区**实时**显示流式文本(无视觉卡顿)。
- 飞书 SDK 卡和 Connect phone 视图两者同步 —— 用户两边看到的刷新节奏一致。
- 默认开启,新装机用户和老用户(settings migration)都启用。
- 失败时降级为一次性发送或 partial 补一条,用户始终能看到一些结果。
- 附件(file upload)行为不变,仍然在文本流式结束后作为独立消息发出。
- 与现有 thread / turn 编排、IM 命令(`/new` `/model` `/help`)、欢迎语、reaction 提示共存不冲突。

### 非目标

- 不暴露工具调用状态(不渲染"正在调用 file_read / bash"等中间行)。
- 不暴露 reasoning / chain-of-thought(过滤掉 `assistant_reasoning_delta`)。
- 不切到 card JSON 2.0 富卡片(本期只走 markdown 流式;card 模式留给后续工作)。
- WeChat 渠道保持单条消息回复不变(不订阅 SSE)。
- Webhook 入站路径(`handleWebhook`)保持单条回复不变(它返回的是 HTTP body,不是 IM 卡)。
- 不重做"重发 / 编辑历史消息"功能(本次只让流式阶段 + live 视图同步落地)。

## 设计决策一览(已与用户确认)

| 维度 | 决策 | 备注 |
|---|---|---|
| 载体 | Markdown 流式消息 | 用 SDK 的 `bridge.stream()` + `MarkdownStreamController` |
| 跨 SDK 调用方法 | `bridge.stream(...)`,**不是** `bridge.send(...)` | 上版踩过的坑(测试用 `send`,生产要用 `stream`),spec 注释里写明 |
| 流式内容范围 | 只 `assistant_text_delta` | `assistant_reasoning_delta` 过滤掉;记 debug log |
| SSE 字段读取 | `event.item.text`(不是 `event.item.delta`) | 上版踩过的字段错位坑;spec 注释里写明 |
| 附件 | 流式结束后作为独立消息 | 与现状行为一致 |
| 默认 | 开启(全局 `feishuStream: true`) | 新建渠道默认 true,老 settings migration 补默认值 |
| 失败降级 | 退到一次性 `bridge.send` | 能 partial 补一条就 partial 补一条;连 partial 都没有就"抱歉,生成失败" |
| 收尾信号 | `turn_completed` / `turn_failed` / `turn_aborted` | 终态事件后再 `setContent(accumulatedText)` 一次 |
| 并发入站 | 并行处理 | 新消息开新 turn + 新 streaming 卡;旧 turn 自然收尾 |
| Renderer 自动切 thread | 用 `subscribeThreadEventsLive` 而非 `selectThread` | 跳过 HTTP `getThreadDetail` 抢在 SSE 之前 |
| Renderer live bubble | 去掉 `!isProcessing` 门控 | `busy: true` 期间也显示流式文本 |
| WeChat | 不变 | 仍走 `processIncomingImPrompt` 轮询路径 |

## 架构

新增/修改模块图:

```
┌─────────────────────────────────────────────────────────────────┐
│ Renderer (React + Zustand)                                      │
│  ┌──────────────────────────────────────────────┐               │
│  │ chat-store                                   │  ←—— onClawChannelActivity 触发
│  │   • selectThread(threadId)        [保留]    │       (改走 subscribeThreadEventsLive)
│  │   • subscribeThreadEventsLive()   [新增]    │               │
│  │   • liveAssistant (SSE 实时填充)  [改]      │               │
│  └──────────────────────────────────────────────┘               │
│  ┌──────────────────────────────────────────────┐               │
│  │ MessageTimeline                              │  ←—— showLiveAssistant
│  │   showLiveAssistant = !!liveContent.trim()   │       去掉 !isProcessing 门控
│  │                                              │               │
│  └──────────────────────────────────────────────┘               │
└────────────────────┬────────────────────────────────────────────┘
                     │ window.kunGui
┌────────────────────▼────────────────────────────────────────────┐
│ Main (Electron)                                                 │
│  ┌──────────────────────────────────────────────┐               │
│  │ ClawRuntime                                  │               │
│  │   • handleFeishuMessage       [改]          │               │
│  │     - feishuStream=true  →  runStreamingReply │               │
│  │     - feishuStream=false →  processIncomingImPrompt          │
│  │   • runStreamingReply          [新增]        │  ← 流式编排   │
│  │   • subscribeSse               [新增]        │               │
│  │   • subscribeSseForStreamer    [新增]        │  ← 适配层     │
│  │   • processIncomingImPrompt    [保留]        │  ← 兜底 / WeChat│
│  │   • waitForAssistantResult     [保留]        │               │
│  └──────────────┬──────────────┬────────────────┘               │
│                 │              │                                 │
│  ┌──────────────▼───┐   ┌─────▼─────────────────────┐           │
│  │ FeishuStreamer   │   │ claw-runtime-helpers       │           │
│  │   [新增]         │   │   subscribeRuntimeThread   │           │
│  │   bridge.stream  │   │   Events + SseSubscriber   │           │
│  │   outbox+waiters │   │   [新增]                   │           │
│  │   append+setContent│   │                           │           │
│  └────────┬─────────┘   └─────┬──────────────────────┘           │
│           │                    │                                  │
└───────────┼────────────────────┼──────────────────────────────────┘
            │                    │ HTTP + SSE
┌───────────▼────────────────────▼──────────────────────────────────┐
│ kun serve  →  /v1/threads/{id}/turns  +  /v1/threads/{id}/events │
└───────────────────────────────────────────────────────────────────┘
```

**关键不变量**:
- 仍然只有一个 live agent runtime(`kun`),不引入任何"运行时切换器"或"流式 provider 切换"。
- 飞书流式只是 `handleFeishuMessage` 的一个分支;WeChat 走原路径不变。
- 失败永远不丢消息:能 partial 就 partial 补一条,连 partial 都没有就发"生成失败"。
- 现有 `processIncomingImPrompt` 轮询路径完全保留,仅作 fallback / WeChat 使用。
- renderer 侧两条进入路径(`selectThread` 与 `subscribeThreadEventsLive`)互不依赖,用户主动点击走前者,bot 自动切走后者。

## 组件

### 2.1 `FeishuStreamer`(新增)— `src/main/feishu-streamer.ts`

封装"一次飞书会话的一条流式回复"的全部状态。

```ts
class FeishuStreamer {
  constructor(opts: {
    bridge: LarkChannel
    chatId: string
    turnId: string
    threadId: string
    replyOptions: SendOptions
    logger: FeishuStreamLogger
  })

  // 启动流式:内部用 bridge.stream 创流式卡,订阅 SSE 喂 outbox,
  // turn 终态后 setContent 收尾。返回 { ok, messageId, finalText, fellBack }。
  // 注意:必须用 bridge.stream,不要用 bridge.send —— Lark SDK 的 send 不接受 producer 形态。
  start(input: { subscribe: SseSubscriber }): Promise<FeishuStreamerResult>

  // 外部(SSE 消费者)每收到一个事件调一次,喂 outbox 或关闭。
  // 读 event.item.text(delta 字符串),不读 event.item.delta。
  onSseEvent(event: Record<string, unknown>): void

  getAccumulatedText(): string  // fallback 时用

  abort(): void      // 用户取消 / 超时
  dispose(): void    // 释放 AbortController + 清空 waiters
}
```

**关键设计**:
- `bridge.stream(...)` 而非 `bridge.send(...)`(上版踩过的坑,spec 注释里写明)
- 状态机:`pending → streaming → closed`;reasoning delta 不入 outbox
- outbox 内部是 `string | null`(null = turn 终态哨兵)
- `append` 抛错时尝试 `setContent(partial)` 兜底;都失败交给上层 fallback
- 跨 turn delta(`event.turnId !== this.opts.turnId`)直接丢弃,避免历史 turn 的 deltas 污染当前卡

### 2.2 `subscribeRuntimeThreadEvents`(新增)— `src/main/claw-runtime-helpers.ts`

订阅 `/v1/threads/{id}/events`,把每条 RuntimeEvent 推给 `onEvent`。不复用 `src/main/runtime-sse-ipc.ts`,因为后者是给 renderer 用的 IPC 代理(走 renderer→main 的 fetch),main 直接持有 fetch 即可。

```ts
type SseSubscriber = (signal: AbortSignal) => { close: () => void }

type RuntimeSseEvent = {
  kind: string
  turnId?: string
  item?: { text?: unknown }
  seq?: number
  [k: string]: unknown
}

async function subscribeRuntimeThreadEvents(input: {
  baseUrl: string
  threadId: string
  headers: Record<string, string>
  onEvent: (event: RuntimeSseEvent) => void
  signal: AbortSignal
  logError?: (category, message, detail) => void
}): Promise<{ close: () => void }>
```

**关键设计**:
- 4xx(除 408 / 429)直接关闭不重连;5xx / 网络错 → 指数退避(750ms → 5s 上限)
- `since_seq` 持续跟踪,即使重连也不丢事件
- `signal` 触发时立即 abort fetch + 阻止重连
- 自带 SSE 解析循环(`\n\n` 分块,`data:` 开头行 `JSON.parse`)
- 解析失败的 data 行静默忽略(不影响后续事件)

### 2.3 `runStreamingReply` / `subscribeSse` / `subscribeSseForStreamer`(新增)— `ClawRuntime` 私有方法

```ts
private async subscribeSse(
  settings: AppSettingsV1,
  threadId: string,
  streamer: FeishuStreamer,
  signal: AbortSignal
): Promise<{ close: () => void }>

private subscribeSseForStreamer(
  settings: AppSettingsV1,
  threadId: string,
  streamer: FeishuStreamer
): SseSubscriber

private async runStreamingReply(input: {
  bridge: LarkChannel
  chatId: string
  threadId: string
  turnId: string
  replyOptions: { replyTo?: string; replyInThread?: boolean }
  responseTimeoutMs: number
  context: Record<string, unknown>
}): Promise<{
  ok: boolean
  messageId: string
  finalText: string
  fellBack: boolean
  message: string
}>
```

**关键设计**:
- `subscribeSseForStreamer` 是适配层:`subscribeRuntimeThreadEvents` 是 async,`SseSubscriber` 契约是同步(立刻返回 `{ close }`)。实现上是"`setup` 异步跑,先同步返回当前 `close` 占位,setup 完成后回填真正的 `close`"。如果 setup 自身抛错(例如没 baseUrl),在 `void setup.then(...).catch(...)` 里记 log,不阻塞主流程 —— 主流程的 fallback 在 `runStreamingReply.catch` 里统一处理。
- `runStreamingReply` 内部构造 `FeishuStreamer`,串接 `subscribeSse` 注入 SSE 喂数据
- 失败 catch → 把 `streamer.getAccumulatedText()` 拼到一次性 `bridge.send` 里 → fallback 永远不丢消息
- `finally` 调 `streamer.dispose()` + `clearTimeout`,资源必然释放

### 2.4 `subscribeThreadEventsLive`(新增)— `chat-store-thread-actions.ts`

解决"bot 消息到达时 chat-store 状态被旧 blocks 覆盖"的卡顿:

```ts
// 新增 action
subscribeThreadEventsLive: (threadId: string) => Promise<void>

// 与 selectThread 的区别:
//   selectThread(threadId)        → HTTP getThreadDetail(拉元数据 + 全部 blocks)+ SSE
//   subscribeThreadEventsLive(id)  → 仅 SSE,sinceSeq=0,跳过 HTTP fetch
//   适用:onClawChannelActivity 自动切换 bot thread(deltas 立即可见)
//   selectThread 保留:用户主动点击 thread(拉元数据 + 持久化 blocks)
```

**关键设计**:
- 同样 reset `liveAssistant / liveReasoning / currentTurnId / currentTurnUserId / turnStartedAtByUserId / turnDurationByUserId / turnReasoningFirstAtByUserId / turnReasoningLastAtByUserId / queuedMessages` 等"流式态"字段
- `sseAbortRef` 替换上一次的订阅,互斥
- 启用 busy watchdog(同 `selectThread`),断流超时给用户提示
- 用户首次显式点击 thread 仍走 `selectThread` 拉元数据 + 持久化 blocks(live 态会被覆盖为持久化态,幂等)

### 2.5 `feishuStream` 设置(新增)— `src/shared/app-settings-types.ts` + `src/shared/app-settings-claw.ts` + `src/main/settings-store.ts`

```ts
// src/shared/app-settings-types.ts
interface ClawImSettingsV1 {
  // ...已有字段
  /** 飞书渠道流式输出。默认 true。 */
  feishuStream?: boolean
}

// src/shared/app-settings-claw.ts default normalizer
claw.im.feishuStream: true   // 新装用户默认

// src/main/settings-store.ts migration
claw.im.feishuStream ?? true  // 老用户补默认值
```

**关键设计**:
- 全局开关,所有飞书 channel 统一生效
- 单一 boolean 字段,不引入 per-channel 粒度(YAGNI)
- migration 兜底老 settings;新建用户走 default

### 2.6 `showLiveAssistant` 修复(修改)— `src/renderer/src/components/chat/MessageTimeline.tsx`

```diff
- const showLiveAssistant = !isProcessing && !!liveContent.trim()
+ // Show the live assistant bubble whenever the SSE has streamed any text
+ // into `live`. We deliberately do NOT gate on `isProcessing`: the
+ // processing indicator (WorkMetaRow above) already covers "the agent is
+ // working", and hiding the streaming text here causes real-time updates
+ // (Feishu bot streaming) to appear only after turn_completed, which the
+ // user perceives as a long delay.
+ const showLiveAssistant = !!liveContent.trim()
```

去掉 `!isProcessing` 门控:streaming 期间(`busy: true`)也显示 live bubble。`WorkMetaRow` 仍由 `isProcessing` 控制,两者互不打架。

## 数据流(单条入站消息端到端时序)

```
[飞书 WS]
    │
    ▼
[ClawRuntime.handleFeishuMessage(channelId, message)]  src/main/claw-runtime.ts
    │
    │  1. buildFeishuPrompt + addReaction 'OnIt'
    │  2. POST /v1/threads  →  threadId
    │  3. POST /v1/threads/{id}/turns  →  turnId
    │  4. onTurnStarted: store.patch(threadId)
    │  5. onClawChannelActivity({ channelId, threadId })  [IPC → renderer]
    │
    ▼
[Renderer: chat-store onClawChannelActivity handler]  src/renderer/src/store/chat-store-navigation-actions.ts:391
    │
    │  • refreshThreads()  (异步,不 await)
    │  • 若是当前 channel:
    │      - activeThreadId !== threadId  →  subscribeThreadEventsLive(threadId)
    │      - activeThreadId === threadId  →  recoverActiveTurn()
    │
    ▼
[subscribeThreadEventsLive]  src/renderer/src/store/chat-store-thread-actions.ts
    │
    │  • sseAbortRef.current?.abort()  (清理旧订阅)
    │  • set({ activeThreadId, blocks:[], liveAssistant:'', liveReasoning:'', busy:true, ... })
    │  • window.kunGui.subscribeThreadEvents(threadId, 0, sink, ac.signal)
    │  • armBusyWatchdog()
    │
    │  ← SSE deltas 持续进入 chat-store.liveAssistant
    │     (chat 视图立即显示流式文本,不再被 isProcessing 隐藏)
    │
    ▼
[main: runStreamingReply]  ClawRuntime.runStreamingReply
    │
    │  ┌─ streamer = new FeishuStreamer({ bridge, chatId, turnId, threadId, replyOptions, logger })
    │  │
    │  ├─ streamer.start({ subscribe })
    │  │     │
    │  │     ├─► bridge.stream(chatId, { markdown: producer }, replyOptions)
    │  │     │     │
    │  │     │     │  [SDK] 创建流式卡 messageId = "om_xxx"
    │  │     │     │
    │  │     │     ├─► producer(controller):
    │  │     │     │     while (state === 'streaming') {
    │  │     │     │       chunk = await nextDelta()      // 阻塞等 outbox
    │  │     │     │       if (chunk === null) break      // turn 终态
    │  │     │     │       await controller.append(chunk) // 写到飞书卡
    │  │     │     │     }
    │  │     │     │     await controller.setContent(accumulatedText)  // SDK finalize
    │  │     │     │
    │  │     │     └─► return { messageId }
    │  │     │
    │  │     ├─► subscribeSseForStreamer 适配:
    │  │     │     (signal) => {
    │  │     │        const setup = subscribeSse(settings, threadId, streamer, signal)
    │  │     │        // 立刻返回 { close: () => closeRef() },setup 异步跑
    │  │     │     }
    │  │     │
    │  │     └─► subscribeRuntimeThreadEvents:
    │  │           SSE loop → onEvent → streamer.onSseEvent
    │  │              • assistant_text_delta  +  turnId 匹配  →  outbox.push(delta)
    │  │              • assistant_reasoning_delta              →  丢弃 + debug log
    │  │              • turn_completed/failed/aborted           →  outbox.push(null)
    │  │              • 其他                                    →  忽略
    │  │
    │  └─► { ok, messageId, finalText, fellBack: false }
    │
    │  6. sendFeishuGeneratedFiles(prompt)  (若命中文件模式,独立消息)
    │
    ▼
[Renderer chat view]
    • liveAssistant 持续增长 → MessageTimeline 实时显示
    • turn 终态后:drainLiveToBlocks → blocks 持久化
    • 同时,SDK 流式卡在飞书侧也实时刷新(两边节奏一致)
```

**关键时序不变量**:

| # | 不变量 | 为什么 |
|---|---|---|
| 1 | `subscribeThreadEventsLive` **先**于 main 侧 `bridge.stream` 完成 IPC 通知 | renderer 必须在 SSE 准备好前 reset 状态,否则 deltas 进 `liveAssistant` 时旧 blocks 还在,被新 fetch 覆盖 |
| 2 | `bridge.stream` **先**于 `subscribeRuntimeThreadEvents` 注册 | 避免"卡片还没建好 delta 就先到"导致 early-arrival 丢消息 |
| 3 | `subscribeRuntimeThreadEvents` 必须在 controller.signal 上挂 abort 监听 | turn 终态后立即关 fetch,不浪费带宽 |
| 4 | `producer` 一定在 `setContent(accumulatedText)` 后才 resolve | SDK finalize 必须跑,否则 `setContent` 没机会写 final text |
| 5 | `dispose()` 必须在 `finally` 里 | 资源必然释放;不依赖成功路径 |
| 6 | `showLiveAssistant` 渲染判断**不**看 `isProcessing` | streaming 期间(`busy: true`)也要显示 live bubble,否则视觉卡顿 |

## 错误处理

8 个失败点 × 4 个处理层:

| # | 失败点 | 处理策略 | fallback 触发 |
|---|---|---|---|
| 1 | SSE 订阅失败(4xx / 网络) | `subscribeRuntimeThreadEvents` 自带重试(750ms→5s),4xx 立即终止 | `runStreamingReply` catch → 一次性 `bridge.send` |
| 2 | SSE 中途断开(Kun 重启) | `setContent(accumulatedText)` 收尾 → 走 fallback | 同上 |
| 3 | `bridge.stream` 抛错(permission_denied / not_connected) | `producer` 异常 → `start()` reject | `runStreamingReply` catch → fallback |
| 4 | `controller.append` 抛错(rate_limited / 230099 切卡) | `accumulatedText` 非空 → `setContent(partial)` 收尾,正常 resolve;为空 → throw | 非空不触发 fallback;空才触发 |
| 5 | `controller.setContent` 收尾抛错 | 记 log,producer 正常 return(避免双发) | 不触发(已写过的内容即终态) |
| 6 | `turn_failed` / `turn_aborted` | `setContent(partial)`,resolve `{ ok: false }` | 可选发"生成未完成"尾注(默认关,留 setting 后续扩展) |
| 7 | `bridge.stream` 超时(> `responseTimeoutMs`) | `streamer.abort()` + 取消整个 runStreamingReply | catch → 一次性 `bridge.send`(含 partial) |
| 8 | 二次发文件失败 | 沿用现状:单文件 try / catch,失败名单独发"附件 X 上传失败" | 不走 streaming fallback |

**`runStreamingReply` 兜底骨架**:

```ts
async runStreamingReply(input) {
  let streamer: FeishuStreamer | null = null
  const cancel = new AbortController()
  const timeout = setTimeout(() => cancel.abort(), input.responseTimeoutMs)
  try {
    streamer = new FeishuStreamer({
      bridge: input.bridge,
      chatId: input.chatId,
      turnId: input.turnId,
      threadId: input.threadId,
      replyOptions: input.replyOptions,
      logger: (category, message, detail) => this.deps.logError(category, message, detail)
    })
    const settings = await this.deps.store.load()
    const result = await streamer.start({
      subscribe: this.subscribeSseForStreamer(settings, input.threadId, streamer)
    })
    return { ok: result.ok, messageId: result.messageId, finalText: result.finalText, fellBack: false }
  } catch (error) {
    this.deps.logError('claw-feishu-stream', 'Streaming reply failed; falling back to one-shot send.', {
      message: error instanceof Error ? error.message : String(error),
      ...input.context
    })
    const finalText = streamer?.getAccumulatedText() || ''
    try {
      const fb = await input.bridge.send(
        input.chatId,
        { markdown: finalText || 'Sorry, I could not finish streaming the response.' },
        input.replyOptions
      )
      return { ok: true, messageId: fb.messageId, finalText, fellBack: true }
    } catch (fbError) {
      return {
        ok: false,
        messageId: '',
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

**不变量**:
- **永远不丢消息**:能 partial 补一条就 partial;连 partial 都没有就"抱歉,生成失败"
- **永远不让用户看到两条**:fallback 用相同 `replyOptions`;SDK 端 controller 异常时优先 `setContent(partial)` 同卡收尾
- **不污染现有路径**:`processIncomingImPrompt` 轮询路径完全保留,WeChat 仍走单条消息

## Settings 改动

在 `settings.claw.im`(全局 IM 配置)上加一个开关字段:

```ts
// src/shared/app-settings-types.ts
interface ClawImSettingsV1 {
  // ...已有字段
  /** 当 provider === 'feishu' 时,是否把 agent 回复改为流式输出。默认 true。 */
  feishuStream?: boolean
}
```

`src/main/settings-store.ts` 的 migration 函数读到老 settings 时,补 `claw.im.feishuStream ?? true`。

本期是**全局开关**,对所有飞书渠道统一生效。若未来需要"某个业务账号不流式",再在 `ClawImChannelV1` 上加 per-channel 字段覆盖(本期不做,YAGNI)。

## 文件清单(按 commit 分组)

### Commit 1:renderer 侧卡顿修复(独立 commit,可先 review)

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/renderer/src/store/chat-store-thread-actions.ts` | 新增 `subscribeThreadEventsLive` action;与 `selectThread` 共享内部工具 | +60 |
| `src/renderer/src/store/chat-store-types.ts` | `ChatState` 加 `subscribeThreadEventsLive` 字段类型 | +10 |
| `src/renderer/src/store/chat-store-navigation-actions.ts` | `onClawChannelActivity` 自动切换改走 `subscribeThreadEventsLive` | -3/+8 |
| `src/renderer/src/components/chat/MessageTimeline.tsx` | `showLiveAssistant` 去掉 `!isProcessing` 门控 | ±3 |
| `src/renderer/src/store/chat-store-thread-actions.test.ts` | 新增 `subscribeThreadEventsLive` 单测 | +60 |

### Commit 2:settings 全局开关

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/shared/app-settings-types.ts` | `ClawImSettingsV1` 加 `feishuStream?: boolean` | +5 |
| `src/shared/app-settings-claw.ts` | default normalizer 补 `feishuStream: true` | +5 |
| `src/main/settings-store.ts` | migration 函数加 `claw.im.feishuStream ?? true` | +5 |
| `src/shared/app-settings.test.ts` | migration 测试 | +20 |

### Commit 3:main 侧流式核心

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `src/main/feishu-streamer.ts` | **新增**,`FeishuStreamer` 类 | ~200 |
| `src/main/feishu-streamer.test.ts` | **新增**,10 个单测 | ~250 |
| `src/main/claw-runtime-helpers.ts` | **新增** `subscribeRuntimeThreadEvents` + `SseSubscriber` + `RuntimeSseEvent` | +90 |
| `src/main/claw-runtime.ts` | **新增** `runStreamingReply` + `subscribeSse` + `subscribeSseForStreamer`;`handleFeishuMessage` 加 `feishuStream` 分支 | +130 |
| `src/main/claw-runtime.test.ts` | 新增 4-5 个端到端 case | +150 |

### Commit 4:文档

| 文件 | 改动 | 估算行数 |
|---|---|---|
| `docs/superpowers/specs/2026-06-15-feishu-streaming-with-live-fix-design.md` | **新增**(本文件) | — |
| `docs/superpowers/plans/2026-06-15-feishu-streaming-with-live-fix.md` | **新增**(重写,非全拷贝老 plan) | ~400 |
| `docs/CONTRIBUTING.md` | 末尾追加"飞书流式 smoke 测试"小节 | +60 |

**总估算**:~1700 行(含测试、文档)。实际代码 ~700 行。

### 不改的东西(明确范围)

- `kun/` runtime 包:不动(kun 的 `/v1/threads/{id}/events` SSE 端点已经存在)
- `src/renderer/src/agent/kun-runtime.ts`:不动(前端 SSE 消费走既有路径)
- `src/main/runtime-sse-ipc.ts`:不动(那是给 renderer SSE 用的,跟 main 直接 fetch 不同)
- 现有 `processIncomingImPrompt` / `waitForAssistantResult` 轮询路径:保留
- WeChat 渠道:不改

## 测试策略

### 6.1 单元测试 — `src/main/feishu-streamer.test.ts`

fake `LarkChannel`(`bridge.stream` 用 `vi.fn`)+ 可控 SSE 事件流。覆盖:

| 用例 | 验证 |
|---|---|
| 正常路径(5 个 delta + turn_completed) | `append` 5 次 + `setContent` 1 次 + resolve `{ ok: true, messageId, finalText, fellBack: false }` |
| reasoning delta 过滤 | `assistant_reasoning_delta` 不触发 `append`,只记 log |
| 跨 turn 过滤 | `turnId !== this.turnId` 的 delta 不入 outbox |
| `append` 抛错(rate_limited) | partial 走 `setContent` 收尾,start 仍 resolve `{ ok: true, finalText: 'partial' }` |
| `subscribe()` 同步抛错 | `start()` reject(验证 SSE 路径不通时不创卡) |
| `turn_failed` | `setContent('')`,resolve `{ ok: false, finalText: '' }` |
| 取消(abort) | `nextDelta()` 永久 await,signal 触发 abort 后全部 waiter 解锁为 null |
| 超时(200ms) | `responseTimeoutMs = 200` 触发 abort |
| `item.text` 字段读取 | 用 `item: { text: 'x' }` 而非 `item: { delta: 'x' }`(上版踩过的字段错位坑) |
| `bridge.stream` 而非 `send` | mock 验证调用的是 `stream()` 方法 |

### 6.2 集成测试 — `src/main/claw-runtime.test.ts`

mock `LarkChannel` + 可控 HTTP / SSE 响应。覆盖:

| 用例 | 验证 |
|---|---|
| 流式成功 | createThread → startTurn → `runStreamingReply` → 3 个 delta → turn_completed → 收到 `bridge.stream` 一次的 streamInput,拿到 messageId |
| 流式降级 | 模拟 `bridge.stream` 抛 `not_connected` → fallback 路径调一次 `bridge.send({ markdown })` |
| 附件仍发送 | `shouldSendGeneratedFilesForPrompt` 命中时,流式后 `sendFeishuGeneratedFiles` 仍被调用 |
| 渠道不受影响 | `provider === 'weixin'` 走原 `processIncomingImPrompt` 路径,不创建 `FeishuStreamer` |
| `feishuStream = false` | 设置关闭时,`handleFeishuMessage` 走原轮询路径 |
| SSE 重连 | 模拟 SSE 5xx 一次,验证重连成功后续 delta 仍正常 append |
| `feishuStream` migration | 老 settings(无 `feishuStream` 字段)migration 后默认 `true` |

### 6.3 Renderer 单元测试 — `src/renderer/src/store/chat-store-thread-actions.test.ts`

| 用例 | 验证 |
|---|---|
| `subscribeThreadEventsLive` 跳过 HTTP fetch | `provider.getThreadDetail` 不被调用 |
| `subscribeThreadEventsLive` 以 `sinceSeq=0` 开 SSE | `provider.subscribeThreadEvents` 收到 `{ threadId, sinceSeq: 0 }` |
| SSE deltas 实时进入 `liveAssistant` | sink.onDeltas 推送 → `state.liveAssistant` 累积 |
| `onClawChannelActivity` 自动调用 `subscribeThreadEventsLive` | mock `window.kunGui.onClawChannelActivity` 触发回调,验证 action 被调 |
| 用户主动点击 thread 仍走 `selectThread` | 验证两条路径互斥(activeThreadId 切换路径不同) |

### 6.4 UI 渲染测试 — `MessageTimeline` + snapshot

| 用例 | 验证 |
|---|---|
| `busy: true` + `liveContent: 'hello'` | 渲染 live bubble(不再被 isProcessing 隐藏) |
| `busy: true` + `liveContent: ''` | 不渲染 live bubble(空内容) |
| `busy: false` + `liveContent: 'hello'` | 渲染 live bubble(turn 终态后保留到 drain) |

### 6.5 手工 / 真实飞书 smoke checklist

写进 `docs/CONTRIBUTING.md`(沿用上版 smoke 表):

- [ ] 单条对话:发"你好" → streaming 卡出现 → 1-2s 内开始刷字
- [ ] 长回答:写代码 → 验证 30k 字符切卡跨第二张卡
- [ ] 故意限流:`outbound.retry.maxAttempts = 1` → 观察 fallback
- [ ] 故意 `turn_failed`:用抛错的 MCP 工具 → 观察 partial 补发
- [ ] 群聊 @bot:`replyInThread: true` 仍生效
- [ ] DM:`replyInThread: false` 默认
- [ ] **Connect phone 视图实时性**:bot 收到消息后 chat 视图立即出现 streaming 文本(不卡)
- [ ] **主动点击 thread**:从 streaming 状态切到该 thread → blocks 与 liveAssistant 内容一致

### 6.6 验证命令

实现完成后必跑:

```bash
npm run typecheck        # 严格类型
npm run lint             # 风格
npm run test             # 全部单元测试
npm run build            # 整包构建(GUI + kun)
npm run build:kun        # runtime 包单独构建
# 手动(Electron + HMR 启动 + 真飞书账号登录)—— 用户手工
npm run dev
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| SDK `MarkdownStreamController` 在新版升级后行为变化 | 锁版本(主进程 package.json),升级前在 smoke 跑过 |
| 飞书 QPS 限流(单 app 高频 `cardElement.content` 写) | 依赖 SDK 默认 `streamThrottleMs`(~200ms),不在本进程加额外限流;出问题先在 `outbound.retry` 上调 `baseDelayMs` |
| 30k 字符切卡被 SDK 行为差异影响 | 单测覆盖切卡边界,出问题第一时间在 `streamMaxElementChars` 上调小阈值(默认 30000) |
| SSE 订阅 leak(turn 终态后没 unsubscribe) | `streamer.dispose()` 显式调用,close path 总是跑(`finally` 块) |
| 入站消息风暴(同一渠道连续多条) | 现状不背 IM 队列(SDK 内部 `chatQueue` 默认关);新方案并行处理,可能短时开多张流式卡——本设计接受这种行为,符合"并行处理"决策 |
| renderer `liveAssistant` 被旧 `blocks` 覆盖(bug #1 复发) | 单元测试覆盖 `onClawChannelActivity` 必走 `subscribeThreadEventsLive`;selectThread 双路径保留为显式分支 |
| renderer `showLiveAssistant` 重新加回 `!isProcessing` 门控(bug #2 复发) | 单元测试 + snapshot 显式覆盖 `busy: true` 期间 live bubble 可见;Code Review checklist 列出 |
| 主进程 `bridge.send` vs `bridge.stream` 选错 | 单测显式 spy `bridge.stream` 调用次数;code review 清单列出 |
| SSE 字段 `item.delta` vs `item.text` 选错 | 单测显式验证 `item: { text: 'x' }` 形态;code review 清单列出 |

## 后续可扩展(不在本期)

- Card JSON 2.0 富卡片(工具状态、按钮、进度条)
- 透出 reasoning delta("💭 ..."折叠区)
- IM 内"重发 / 编辑"上一条消息(需要把 `messageId` 持久化到 settings)
- Per-channel 粒度的 `feishuStream` 开关
- WeChat 渠道流式(需要先确认微信侧是否有对应能力)
- 把 `subscribeThreadEventsLive` 推广到其他 bot 渠道(Slack / Telegram 等)
