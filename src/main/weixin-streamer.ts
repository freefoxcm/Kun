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
  // The idle timer fires only for the *initial* accumulation. After a flush
  // (via minChars or idle), the next block waits for either another minChars
  // trigger or turn_completed — content is actively streaming so an idle flush
  // would split a coherent reply.
  private hasFlushedOnce = false

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
    const text = this.pendingText
    if (!text) return
    this.pendingText = ''
    this.hasFlushedOnce = true
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
