import {
  FenceState,
  findFlushBoundaries,
  findCompleteImage,
} from './weixin-stream-boundaries'

type BridgeHandle = {
  sendMessage: (accountId: string, to: string, text: string, contextToken: string | undefined) => Promise<{ messageId: string }>
  sendImage: (accountId: string, to: string, imageUrl: string, contextToken: string | undefined) => Promise<{ messageId: string }>
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

const DEFAULT_MAX_CHARS = 1500
const MAX_CONSECUTIVE_FAILURES = 3

// Lazy-load StreamingMarkdownFilter from the openclaw-weixin plugin.
// Match the import path used by weixin-bridge-runtime.ts:849 to avoid
// plugin upgrade drift. send.js re-exports StreamingMarkdownFilter from
// markdown-filter.js, so we can pull it via the same dynamic import.
// (Most markdown stripping now happens in the new flushTick via
// findCompleteImage extraction, but the filter is kept installed for
// parity — it normalizes other markdown fragments as they stream in.)
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
  // The idle timer fires only for the *initial* accumulation. After a flush
  // (via minChars or idle), the next block waits for either another minChars
  // trigger or turn_completed — content is actively streaming so an idle flush
  // would split a coherent reply.
  private hasFlushedOnce = false
  private filter: { feed: (delta: string) => string; flush: () => string } | null = null
  private readonly fenceState = new FenceState()

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
    maxChars?: number
    idleMs: number
    responseTimeoutMs: number
    logger: WeixinStreamerLogger
  }) {}

  get maxChars(): number {
    return this.opts.maxChars ?? DEFAULT_MAX_CHARS
  }

  async start(input: { subscribe: SseSubscriber }): Promise<WeixinStreamerResult> {
    console.log('[start] entry')
    let closeRef: () => void = () => {}
    const ac = new AbortController()
    console.log('[start] ac created')

    // Pre-load filter lazily (non-blocking; if load fails, fall back to no filter)
    void loadStreamingMarkdownFilter().then(() => {
      const Ctor = _StreamingMarkdownFilterCtor
      if (Ctor) this.filter = new Ctor()
    })
    console.log('[start] filter load initiated')

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
      console.log('[start] inner Promise setup, closeResolver set, closed=', this.closed)
      const tick = () => {
        console.log('[start] tick running, closed=', this.closed)
        checkTimeout()
        if (this.closed) {
          console.log('[start] tick sees closed=true, resolving')
          resolve()
          return
        }
        setTimeout(tick, 50)
      }
      void setup.then(() => {
        console.log('[start] setup.then fired, closed=', this.closed)
        if (this.closed) { console.log('[start] closed at setup, resolving'); resolve(); return }
        console.log('[start] calling tick')
        tick()
      }, (err) => { console.log('[start] setup rejected', err); resolve() })
    })
    console.log('[start] inner Promise resolved')
    closeRef()
    // Surface subscribe failure (if any) now that the wait has unwound.
    await setup
    return {
      ok: this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES,
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
      this.fenceState.feed(filtered)
      this.scheduleFlush()
    } else if (kind === 'assistant_reasoning_delta') {
      this.opts.logger('weixin-stream', 'reasoning delta dropped', {})
      return
    } else if (kind === 'turn_completed' || kind === 'turn_failed' || kind === 'turn_aborted') {
      void this.flushTick(true)
      this.markClosed()
    }
  }

  private scheduleFlush(): void {
    if (this.pendingText.length >= this.opts.minChars) {
      // Defer the flush one microtask so additional deltas arriving in the
      // same tick get coalesced into the same block.
      queueMicrotask(() => {
        void this.flushTick(false)
      })
      return
    }
    if (this.hasFlushedOnce) return  // post-flush blocks wait for minChars or turn_completed
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      // Idle timer fires when no more deltas arrive for `idleMs`. At this
      // point we should drain whatever we have rather than wait forever —
      // force=true so the boundary finder will split at the first safe
      // point (paragraph > sentence > comma) instead of the minChars gate.
      void this.flushTick(true)
    }, this.opts.idleMs)
  }

  /**
   * Iterative flush loop. Walks pendingText left-to-right, emitting
   * text bubbles (at the nearest fence-safe boundary meeting minChars) and
   * image messages (at complete ![alt](url) positions) in source order.
   *
   * @param force when true (turn_completed/failed/aborted), flushes all
   *              remaining content regardless of minChars or boundary.
   */
  private async flushTick(force: boolean): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.aborted || this.closed) {
      return
    }

    let processed = true
    // Capture aborted/closed at entry; do not re-check between iterations.
    // turn_completed/failed/aborted call markClosed() synchronously right
    // after kicking off flushTick(true), so re-checking `this.closed`
    // mid-loop would abort the drain before the trailing text is emitted.
    const startedAborted = this.aborted
    const startedClosed = this.closed
    while (processed && !startedAborted && !startedClosed) {
      processed = false
      const imageMatch = findCompleteImage(this.pendingText)

      if (imageMatch !== null) {
        // A complete image acts as an implicit boundary: flush any text that
        // sits before it (even if shorter than minChars) so the image message
        // lands in source order, then drop the image from pendingText.
        const textBefore = imageMatch.start > 0 ? this.pendingText.slice(0, imageMatch.start) : ''
        const imageUrl = imageMatch.url
        const textAfter = this.pendingText.slice(imageMatch.end)
        // Clear pendingText BEFORE awaiting so a concurrent flushTick
        // microtask (queued by a later SSE delta) sees an empty buffer
        // instead of duplicating content.
        this.pendingText = ''
        if (textBefore) await this.emitText(textBefore)
        await this.emitImage(imageUrl)
        this.pendingText = textAfter
        processed = true
        continue
      }

      const result = this.pickTextBoundary(this.pendingText, force)
      if (result.kind === 'found' || result.kind === 'forceFound') {
        // For sentence/comma boundaries, the index points AFTER punctuation
        // but BEFORE the trailing space (per findFlushBoundaries convention).
        // Consume the trailing whitespace too so the bubble reads as a
        // complete sentence ("Hello. ") rather than "Hello.". Paragraph
        // boundaries absorb the first `\n` of `\n\n` into the boundary
        // itself: prefix keeps no trailing `\n`, tail keeps one leading `\n`.
        let splitIdx = result.index
        if (result.boundaryType !== 'paragraph') {
          while (splitIdx < this.pendingText.length &&
                 (this.pendingText[splitIdx] === ' ' || this.pendingText[splitIdx] === '\t')) {
            splitIdx++
          }
        }
        const emit = this.pendingText.slice(0, splitIdx)
        const tail = result.boundaryType === 'paragraph'
          ? this.pendingText.slice(result.index + 1)
          : this.pendingText.slice(splitIdx)
        this.pendingText = ''
        await this.emitText(emit)
        this.pendingText = tail
        processed = true
        continue
      }
      if (result.kind === 'forceHard') {
        const emit = this.pendingText.slice(0, this.maxChars)
        const tail = this.pendingText.slice(this.maxChars)
        this.pendingText = ''
        await this.emitText(emit)
        this.pendingText = tail
        processed = true
        continue
      }
      // wait
      if (force && this.pendingText) {
        // Drain whatever's left, even if no fence-safe boundary exists.
        const emit = this.pendingText
        this.pendingText = ''
        await this.emitText(emit)
        processed = true
      }
    }
  }

  /**
   * Pick a boundary index for `segment`:
   * - 'found' with index = first fence-safe boundary at or after minChars
   * - 'forceFound' with index = first fence-safe boundary past index 0 (force mode)
   * - 'forceHard' if segment.length > maxChars and no clean boundary
   * - 'wait' if segment too short to flush
   */
  private pickTextBoundary(segment: string, force: boolean):
    | { kind: 'found'; index: number; boundaryType: 'paragraph' | 'sentence' | 'comma' }
    | { kind: 'forceFound'; index: number; boundaryType: 'paragraph' | 'sentence' | 'comma' }
    | { kind: 'forceHard' }
    | { kind: 'wait' } {
    if (!segment) return { kind: 'wait' }
    const candidates = findFlushBoundaries(segment)
    if (force) {
      // Under force, split at the EARLIEST fence-safe boundary past index 0
      // — a boundary at 0 would emit empty text and loop forever.
      const usable = candidates.find(b => !b.insideFence && b.index > 0)
      if (usable) return { kind: 'forceFound', index: usable.index, boundaryType: usable.type }
    } else {
      const usable = candidates.find(b => !b.insideFence && b.index >= this.opts.minChars)
      if (usable) return { kind: 'found', index: usable.index, boundaryType: usable.type }
    }
    if (segment.length > this.maxChars) return { kind: 'forceHard' }
    return { kind: 'wait' }
  }

  private async emitText(text: string): Promise<void> {
    if (!text) return
    console.log('[emitText] start len=', text.length, 'text=', JSON.stringify(text))
    try {
      await this.opts.bridge.sendMessage(this.opts.accountId, this.opts.to, text, this.opts.contextToken)
      this.consecutiveFailures = 0
      this.messageCount += 1
      this.hasFlushedOnce = true
      console.log('[emitText] success messageCount=', this.messageCount)
    } catch (err) {
      this.consecutiveFailures += 1
      this.opts.logger('weixin-stream', 'sendMessage failed', {
        message: String(err),
        consecutiveFailures: this.consecutiveFailures
      })
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.opts.logger('weixin-stream', 'too many consecutive failures, aborting stream', {
          messageCount: this.messageCount
        })
        this.markClosed()
      }
    }
  }

  private async emitImage(url: string): Promise<void> {
    try {
      await this.opts.bridge.sendImage(this.opts.accountId, this.opts.to, url, this.opts.contextToken)
      this.consecutiveFailures = 0
      this.messageCount += 1
    } catch (err) {
      this.consecutiveFailures += 1
      this.opts.logger('weixin-stream', 'sendImage failed', {
        url,
        message: String(err),
        consecutiveFailures: this.consecutiveFailures
      })
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
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