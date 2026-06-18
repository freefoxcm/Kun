import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WeixinStreamer } from './weixin-streamer'

// Mock the openclaw-weixin plugin so the test does not depend on real dynamic
// import resolution under fake timers. StreamingMarkdownFilter is exposed
// directly via the re-export from send.js (see weixin-bridge-runtime.ts:849).
// The mock is a no-op pass-through: the boundary-aware flushTick is now
// responsible for image extraction (via findCompleteImage), so we do not
// want the filter to strip ![alt](url) before the streamer sees it.
vi.mock('@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js', () => ({
  StreamingMarkdownFilter: class {
    feed(delta: string): string {
      return delta
    }
    flush(): string {
      return ''
    }
  }
}))

type BridgeHandle = {
  sendMessage: (accountId: string, to: string, text: string, contextToken: string | undefined) => Promise<{ messageId: string }>
}

function makeFakeBridge() {
  const sendMessageWeixin = vi.fn().mockResolvedValue({ messageId: 'mid' })
  const sendImageWeixin = vi.fn().mockResolvedValue({ messageId: 'img-id' })
  const handle = { sendMessage: sendMessageWeixin, sendImage: sendImageWeixin }
  return { handle, sendMessageWeixin, sendImageWeixin }
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
      maxChars: 200,
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
    // 250 chars → maxChars=200 forceHard emits first 200, leaves 50 in pendingText.
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)
    expect(sendMessageWeixin.mock.calls[0]?.[2]).toContain('a'.repeat(50))

    // turn_completed drains the remaining 50 chars via force-flush.
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(2)

    const result = await startPromise
    expect(result.ok).toBe(true)
    expect(result.messageCount).toBe(2)
    expect(result.fellBack).toBe(false)
  })

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
      maxChars: 1000,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'A short message.' } })
    expect(sendMessageWeixin).not.toHaveBeenCalled()

    vi.advanceTimersByTime(3000)
    await vi.runOnlyPendingTimersAsync()
    // sentence boundary at '.' splits the 16-char text into one bubble.
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)
    expect(sendMessageWeixin.mock.calls[0]?.[2]).toBe('A short message.')

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()
    await startPromise
  })

  it('extracts complete image markdown via findCompleteImage (boundary-aware flush)', async () => {
    // Switch to real timers so the dynamic import promise resolves naturally.
    vi.useRealTimers()
    const sendMessageWeixin = vi.fn().mockResolvedValue({ messageId: 'mid' })
    const sendImageWeixin = vi.fn().mockResolvedValue({ messageId: 'img-id' })
    const handle = { sendMessage: sendMessageWeixin, sendImage: sendImageWeixin }
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

    // Wait for the lazy import to resolve so the streamer installs the filter
    // instance before the first delta arrives.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // 推一段含 markdown 图片的 delta，累积触发 flush
    const markdown = '![alt](http://x.com/img.png)' + 'a'.repeat(230)
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: markdown } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Image at offset 0 is emitted via sendImage, not stripped into text.
    expect(sendImageWeixin).toHaveBeenCalledWith('acc', 'user-1', 'http://x.com/img.png', undefined)
    // No text bubble should contain the raw markdown image syntax.
    for (const call of sendMessageWeixin.mock.calls) {
      expect(call[2] as string).not.toContain('![alt]')
    }

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
  })

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

  it('continues streaming after sendMessage throws (single failure)', async () => {
    const sendMessageWeixin = vi.fn()
      .mockRejectedValueOnce(new Error('rate_limited'))
      .mockResolvedValueOnce({ messageId: 'mid' })
    const handle = { sendMessage: sendMessageWeixin, sendImage: vi.fn() }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 100,
      maxChars: 100,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // 第 1 次 flush 失败
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'a'.repeat(150) } })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)

    // 第 2 次 flush 成功
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'b'.repeat(150) } })
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).toHaveBeenCalledTimes(2)

    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()
    await startPromise
  })

  it('triggers fallback after 3 consecutive sendMessage failures', async () => {
    const sendMessageWeixin = vi.fn().mockRejectedValue(new Error('rate_limited'))
    const handle = { sendMessage: sendMessageWeixin, sendImage: vi.fn() }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 100,
      maxChars: 100,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    // 触发 3 次 flush，全部失败（每个 delta 之间 await 让微任务 flush 完成）
    for (let i = 0; i < 3; i++) {
      streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: `a${i}`.repeat(100) } })
      await vi.runOnlyPendingTimersAsync()
    }
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

  it('flushes remainder on turn_failed and resolves start()', async () => {
    const { handle, sendMessageWeixin } = makeFakeBridge()
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 1000,
      maxChars: 1000,
      idleMs: 3000,
      responseTimeoutMs: 30_000,
      logger: () => {}
    })
    const subscribe = vi.fn().mockReturnValue({ close: vi.fn() })
    const startPromise = streamer.start({ subscribe })

    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'partial reply.' } })
    streamer.onSseEvent({ kind: 'turn_failed', turnId: 'turn-1' })
    await vi.runOnlyPendingTimersAsync()

    const result = await startPromise
    // turn_failed 在当前实现里走 flushPending 路径，flush 成功 → ok 仍为 true；
    // 这里只验证 partial 已被 flush 出去，且 start() 确实 resolve 了
    expect(result.messageCount).toBe(1)
    expect(result.finalText).toContain('partial')
    expect(sendMessageWeixin).toHaveBeenCalledTimes(1)
    const sentText = sendMessageWeixin.mock.calls[0]?.[2] as string
    expect(sentText).toContain('partial')
  })

  it('aborts on abort() and unblocks start()', async () => {
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
    // 模拟 subscribe：start() 不会监听 signal 的 abort，但这里挂一个 listener 验证 signal 至少被传入
    let receivedSignal: AbortSignal | null = null
    const subscribe = vi.fn().mockImplementation((signal: AbortSignal) => {
      receivedSignal = signal
      return { close: vi.fn() }
    })
    const startPromise = streamer.start({ subscribe })

    // 触发 abort，streamer.abort() 内部直接把 closed=true，下一次 poll resolve start()
    streamer.abort()
    await vi.runOnlyPendingTimersAsync()

    const result = await startPromise
    expect(result).toBeDefined()
    // 没有任何 delta 进来，所以 sendMessage 没被调
    expect(sendMessageWeixin).not.toHaveBeenCalled()
    // signal 确实被传给了 subscribe（说明 abort 通道在契约上是可用的）
    expect(receivedSignal).not.toBeNull()
  })

  it('dispose() clears idle timer (idempotent)', async () => {
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
    void streamer.start({ subscribe })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'x' } })
    // 多次 dispose 不抛错
    streamer.dispose()
    streamer.dispose()
    // 推进时间，idle timer 已被清空，不会触发 flush
    vi.advanceTimersByTime(5000)
    await vi.runOnlyPendingTimersAsync()
    expect(sendMessageWeixin).not.toHaveBeenCalled()
  })

  it('rejects start() when subscribe() throws synchronously', async () => {
    const handle = { sendMessage: vi.fn(), sendImage: vi.fn() }
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
    const handle = { sendMessage: vi.fn().mockResolvedValue({ messageId: 'mid' }), sendImage: vi.fn() }
    const streamer = new WeixinStreamer({
      bridge: handle,
      accountId: 'acc',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thread-1',
      contextToken: undefined,
      minChars: 200,
      maxChars: 200,
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
      maxChars: 100,
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

  // --- boundary-aware flushTick (Task 6) ---

  function makeBridgeHandle() {
    return {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'm1' }),
      sendImage: vi.fn().mockResolvedValue({ messageId: 'i1' })
    }
  }

  function makeBoundaryStreamer(opts?: Partial<{
    minChars: number
    maxChars: number
    idleMs: number
    bridge: ReturnType<typeof makeBridgeHandle>
  }>) {
    const bridge = opts?.bridge ?? makeBridgeHandle()
    const streamer = new WeixinStreamer({
      bridge,
      accountId: 'bot-1',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thr-1',
      contextToken: 'ctx',
      minChars: opts?.minChars ?? 50,
      maxChars: opts?.maxChars ?? 200,
      idleMs: opts?.idleMs ?? 100,
      responseTimeoutMs: 60_000,
      logger: () => {}
    })
    return { streamer, bridge }
  }

  it('flushes at paragraph boundary \\n\\n when minChars reached', async () => {
    const { streamer, bridge } = makeBoundaryStreamer()
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'Hello\n\nWorld' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    // Drive microtasks + the 50ms wait loop until start() resolves.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100)
    }
    await startPromise
    expect(bridge.sendMessage).toHaveBeenCalledWith('bot-1', 'user-1', 'Hello', 'ctx')
    expect(bridge.sendMessage).toHaveBeenLastCalledWith('bot-1', 'user-1', '\nWorld', 'ctx')
  })

  it('falls back to sentence boundary when no paragraph', async () => {
    const { streamer, bridge } = makeBoundaryStreamer({ minChars: 10 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'Hello. World this is long enough to flush.' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.advanceTimersByTimeAsync(100)
    await startPromise
    const calls = bridge.sendMessage.mock.calls.map(c => c[2])
    expect(calls[0]).toBe('Hello. ')
  })

  it('never splits inside code fence', async () => {
    const { streamer, bridge } = makeBoundaryStreamer({ minChars: 10, maxChars: 1000 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    const text = '```\nHello. World.\n```'
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.advanceTimersByTimeAsync(100)
    await startPromise
    const calls = bridge.sendMessage.mock.calls.map(c => c[2])
    expect(calls).toContain('```\nHello. World.\n```')
  })

  it('extracts complete image and emits image+text in source order', async () => {
    const { streamer, bridge } = makeBoundaryStreamer({ minChars: 5 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'See ![chart](https://e.com/x.png) for details' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.advanceTimersByTimeAsync(100)
    await startPromise
    expect(bridge.sendMessage).toHaveBeenCalledWith('bot-1', 'user-1', 'See ', 'ctx')
    expect(bridge.sendImage).toHaveBeenCalledWith('bot-1', 'user-1', 'https://e.com/x.png', 'ctx')
    expect(bridge.sendMessage).toHaveBeenLastCalledWith('bot-1', 'user-1', ' for details', 'ctx')
  })

  it('keeps incomplete image markdown in pendingText and waits', async () => {
    vi.useRealTimers()
    const { streamer, bridge } = makeBoundaryStreamer({ minChars: 5, idleMs: 5000 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'See ![chart](https://e.com/x' } })
    await new Promise(r => setTimeout(r, 50))
    expect(bridge.sendImage).not.toHaveBeenCalled()
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: '.png) now' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    expect(bridge.sendImage).toHaveBeenCalledWith('bot-1', 'user-1', 'https://e.com/x.png', 'ctx')
  })

  it('hard-splits at maxChars when no boundary found', async () => {
    const { streamer, bridge } = makeBoundaryStreamer({ minChars: 10, maxChars: 30 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    const text = 'a'.repeat(60)
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await vi.advanceTimersByTimeAsync(100)
    await startPromise
    const calls = bridge.sendMessage.mock.calls.map(c => c[2])
    expect(calls.some(c => c.length === 30)).toBe(true)
  })
})
