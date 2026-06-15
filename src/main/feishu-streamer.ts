import type { LarkChannel, SendOptions } from '@larksuiteoapi/node-sdk'
import type { SseSubscriber } from './claw-runtime-helpers'

export type FeishuStreamLogger = (category: string, message: string, detail?: unknown) => void

export type FeishuStreamerOptions = {
  bridge: LarkChannel
  chatId: string
  turnId: string
  threadId: string
  replyOptions: SendOptions
  logger: FeishuStreamLogger
}

export type FeishuStreamerResult = {
  ok: boolean
  messageId: string
  finalText: string
  fellBack: boolean
}

export class FeishuStreamer {
  private readonly opts: FeishuStreamerOptions
  private readonly outbox: Array<string | null> = []
  private readonly waiters: Array<(chunk: string | null) => void> = []
  private state: 'pending' | 'streaming' | 'closed' = 'pending'
  private accumulatedText = ''
  private subscription: { close: () => void } | null = null

  constructor(opts: FeishuStreamerOptions) {
    this.opts = opts
  }

  start(_input: { subscribe: SseSubscriber }): Promise<FeishuStreamerResult> {
    throw new Error('not implemented')
  }

  onSseEvent(_event: Record<string, unknown>): void {
    throw new Error('not implemented')
  }

  getAccumulatedText(): string {
    return this.accumulatedText
  }

  abort(): void {
    this.state = 'closed'
    this.subscription?.close()
    this.subscription = null
  }

  dispose(): void {
    this.abort()
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!
      w(null)
    }
  }
}
