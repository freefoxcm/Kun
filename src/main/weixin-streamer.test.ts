import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WeixinStreamer } from './weixin-streamer'

type BridgeHandle = {
  sendMessage: (accountId: string, to: string, text: string, contextToken: string | undefined) => Promise<{ messageId: string }>
}

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
