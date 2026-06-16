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

// Lazy-load StreamingMarkdownFilter from the openclaw-weixin plugin.
// Match the import path used by weixin-bridge-runtime.ts:849 to avoid
// plugin upgrade drift. send.js re-exports StreamingMarkdownFilter from
// markdown-filter.js, so we can pull it via the same dynamic import.
type StreamingMarkdownFilterCtor = new () => {
  feed: (delta: string) => string
  flush: () => string
}
let _StreamingMarkdownFilterCtor: StreamingMarkdownFilterCtor | null = null
let _loadStreamingMarkdownFilterPromise: Promise<void> | null = null
function loadStreamingMarkdownFilter(): Promise<void> {
  _loadStreamingMarkdownFilterPromise ??= import(
    '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js'
  )
    .then((mod) => {
      const Ctor = (mod as { StreamingMarkdownFilter?: StreamingMarkdownFilterCtor }).StreamingMarkdownFilter
      if (Ctor) _StreamingMarkdownFilterCtor = Ctor
    })
    .catch(() => {
      // Plugin not available; will fall back to no-op filtering.
      // Reset so a later retry can attempt re-load.
      _loadStreamingMarkdownFilterPromise = null
    })
  return _loadStreamingMarkdownFilterPromise
}

export class WeixinStreamer {
  private pendingText = ''
  private messageCount = 0
  private accumulatedText = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private aborted = false
  private closeResolver: (() => void) | null = null
  private consecutiveFailures = 0
  private readonly MAX_CONSECUTIVE_FAILURES = 3
  // The idle timer fires only for the *initial* accumulation. After a flush
  // (via minChars or idle), the next block waits for either another minChars
  // trigger or turn_completed — content is actively streaming so an idle flush
  // would split a coherent reply.
  private hasFlushedOnce = false
  private filter: { feed: (delta: string) => string; flush: () => string } | null = null

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    if (this.closeResolver) {
      this.closeResolver()
      this.closeResolver = null
    }
  }

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

    // Pre-load filter lazily (non-blocking; if load fails, fall back to no filter)
    void loadStreamingMarkdownFilter().then(() => {
      const Ctor = _StreamingMarkdownFilterCtor
      if (Ctor) this.filter = new Ctor()
    })

    // If subscribe() throws synchronously, propagate the rejection so callers
    // can react (and the wait below can be unblocked by markClosed()).
    const setup = Promise.resolve().then(() => {
      const { close } = input.subscribe(ac.signal)
      closeRef = close
    }).catch((err) => {
      this.opts.logger('weixin-stream', 'subscribe failed', { message: String(err) })
      this.markClosed()
      throw err
    })
    void setup

    // 等 turn 终态事件触发关闭；这里用 wall-clock 兜底超时（不受 fake timers 影响）。
    // 用 Date.now() 而不是 setTimeout 是因为 vitest 的 runOnlyPendingTimersAsync
    // 会触发任何"pending" 的 timer（不管是否到期），而长 responseTimeoutMs
    // 在测试里被误触会导致 closed 提前置位。
    const startTime = Date.now()
    const checkTimeout = () => {
      if (this.closed) return
      if (Date.now() - startTime >= this.opts.responseTimeoutMs) {
        this.opts.logger('weixin-stream', 'response timeout, aborting stream', {
          responseTimeoutMs: this.opts.responseTimeoutMs
        })
        this.markClosed()
        ac.abort()
      }
    }
    // Wait for either the streamer to close (via turn_* event, abort, or
    // 3-failure escalation) or for the setup promise to reject synchronously.
    // Periodically re-check the wall-clock timeout so tests can use
    // vi.advanceTimersByTime to simulate elapsed time.
    await new Promise<void>((resolve) => {
      this.closeResolver = resolve
      const tick = () => {
        checkTimeout()
        if (this.closed) {
          resolve()
          return
        }
        setTimeout(tick, 50)
      }
      void setup.then(() => { if (this.closed) resolve(); else tick() }, () => resolve())
    })
    closeRef()
    // Surface subscribe failure (if any) now that the wait has unwound.
    await setup
    return {
      ok: this.consecutiveFailures < this.MAX_CONSECUTIVE_FAILURES,
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
      const filtered = this.filter ? this.filter.feed(text) : text
      this.accumulatedText += filtered
      this.pendingText += filtered
      this.scheduleFlush()
    } else if (kind === 'assistant_reasoning_delta') {
      this.opts.logger('weixin-stream', 'reasoning delta dropped', {})
      return
    } else if (kind === 'turn_completed' || kind === 'turn_failed' || kind === 'turn_aborted') {
      void this.flushPending()
      this.markClosed()
    }
  }

  private scheduleFlush(): void {
    if (this.pendingText.length >= this.opts.minChars) {
      // Defer the flush one microtask so additional deltas arriving in the
      // same tick get coalesced into the same block.
      queueMicrotask(() => {
        void this.flushPending()
      })
      return
    }
    if (this.hasFlushedOnce) return  // post-flush blocks wait for minChars or turn_completed
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
    if (this.aborted || this.closed) return
    const text = this.pendingText
    if (!text) return
    this.pendingText = ''
    this.hasFlushedOnce = true
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
        this.markClosed()
      }
    }
  }

  getAccumulatedText(): string { return this.accumulatedText }
  get messageCount_(): number { return this.messageCount }  // 暴露给 caller

  abort(): void { this.aborted = true; this.markClosed() }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.markClosed()
  }
}
