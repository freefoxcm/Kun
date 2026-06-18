import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { weixinBridgeRuntimeInternals } from './weixin-bridge-runtime'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/deepseek-gui-test-user-data',
    getVersion: () => '0.2.0-test'
  }
}))

const requireFromTest = createRequire(import.meta.url)

describe('weixin bridge runtime', () => {
  it('builds WeChat base_info from the bundled WeChat plugin package', () => {
    const pkg = requireFromTest('@tencent-weixin/openclaw-weixin/package.json') as {
      version: string
    }
    const baseInfo = weixinBridgeRuntimeInternals.buildBaseInfo()

    expect(baseInfo).toMatchObject({
      channel_version: pkg.version,
      bot_agent: 'Kun/0.2.0-test'
    })
  })

  it('keeps OpenClaw-compatible account id normalization for existing WeChat state files', () => {
    const { normalizeAccountId } = weixinBridgeRuntimeInternals

    expect(normalizeAccountId('b0f5860fdecb@im.bot')).toBe('b0f5860fdecb-im-bot')
    expect(normalizeAccountId('ABC@IM.WECHAT')).toBe('abc-im-wechat')
    expect(normalizeAccountId('')).toBe('default')
    expect(normalizeAccountId('__proto__')).toBe('default')
  })

  it('does not expose the removed OpenClaw adapter builders', () => {
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('buildGuiManagedOpenClawConfig')
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('buildWeixinBridgeAdapterSource')
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('parseNodeVersion')
  })

  it('extracts webhook generated files for WeChat media delivery, capped at three', () => {
    const { webhookGeneratedFiles } = weixinBridgeRuntimeInternals

    expect(webhookGeneratedFiles({
      ok: true,
      reply: 'done',
      files: [
        { path: '/ws/.deepseekgui-images/cat.png', fileName: 'cat.png' },
        { path: '/ws/out/report.pdf' },
        { unrelated: true },
        { path: '/ws/a.png' },
        { path: '/ws/b.png' }
      ]
    })).toEqual([
      { path: '/ws/.deepseekgui-images/cat.png', fileName: 'cat.png' },
      { path: '/ws/out/report.pdf', fileName: 'report.pdf' },
      { path: '/ws/a.png', fileName: 'a.png' }
    ])

    expect(webhookGeneratedFiles({ ok: true, reply: 'no files' })).toEqual([])
    expect(webhookGeneratedFiles({ files: 'not-an-array' })).toEqual([])
  })
})

describe('sendImageFromUrlWeixin', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js', () => ({
      sendImageMessageWeixin: vi.fn().mockResolvedValue({ messageId: 'sdk-msg-1' })
    }))
    vi.doMock('@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js', () => ({
      uploadFileToWeixin: vi.fn().mockResolvedValue({
        filekey: 'fk-1',
        fileSize: 1024,
        fileSizeCiphertext: 1040,
        aeskey: 'a'.repeat(32),
        downloadEncryptedQueryParam: 'qp=1'
      })
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js')
    vi.doUnmock('@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js')
    vi.resetModules()
  })

  it('downloads URL, uploads via SDK, calls sendImageMessageWeixin', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer)
    })
    vi.stubGlobal('fetch', fetchSpy)

    const mod = await import('./weixin-bridge-runtime')
    const result = await mod.weixinBridgeRuntimeInternals.sendImageFromUrlWeixin({
      account: {
        accountId: 'bot-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'tk',
        configured: true,
        createdAt: 0
      } as never,
      to: 'user-1',
      imageUrl: 'https://cdn.example.com/x.jpg',
      contextToken: 'ctx-1'
    })

    expect(result.messageId).toBe('sdk-msg-1')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://cdn.example.com/x.jpg',
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it('throws on fetch failure (non-2xx)', async () => {
    // @ts-expect-error — stub global
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 })

    const mod = await import('./weixin-bridge-runtime')
    await expect(mod.weixinBridgeRuntimeInternals.sendImageFromUrlWeixin({
      account: {
        accountId: 'bot-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'tk',
        sessionKey: '',
        createdAt: 0
      } as never,
      to: 'user-1',
      imageUrl: 'https://cdn.example.com/x.jpg',
      contextToken: 'ctx-1'
    })).rejects.toThrow(/fetch failed status=404/)
  })

  it.each([
    ['jpg', [0xff, 0xd8, 0xff]],
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['bmp', [0x42, 0x4d, 0x00, 0x00]],
    ['webp', [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
  ])('sniffs %s magic bytes and uploads', async (ext, magicBytes) => {
    // @ts-expect-error — stub global
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array(magicBytes).buffer)
    })

    const mod = await import('./weixin-bridge-runtime')
    const result = await mod.weixinBridgeRuntimeInternals.sendImageFromUrlWeixin({
      account: {
        accountId: 'bot-1',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        token: 'tk',
        sessionKey: '',
        createdAt: 0
      } as never,
      to: 'user-1',
      imageUrl: `https://cdn.example.com/x.${ext}`,
      contextToken: 'ctx-1'
    })

    expect(result.messageId).toBe('sdk-msg-1')
  })
})
