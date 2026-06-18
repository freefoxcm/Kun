/**
 * Minimal typings for the bundled WeChat plugin's media send helper.
 * The package ships compiled JS under dist/ without type definitions; this
 * mirrors the signature of src/messaging/send-media.ts (v2.4.3).
 */
declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/send-media.js' {
  export function sendWeixinMediaFile(params: {
    filePath: string
    to: string
    text: string
    opts: {
      baseUrl: string
      token?: string
      timeoutMs?: number
      contextToken?: string
    }
    cdnBaseUrl: string
  }): Promise<{ messageId: string }>
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js' {
  // Mirrors the re-exports from send.js (v2.4.3):
  // - StreamingMarkdownFilter is consumed by weixin-streamer.ts.
  // - sendImageMessageWeixin is consumed by weixin-bridge-runtime.ts when
  //   delivering extracted ![alt](url) images from streaming markdown.
  export class StreamingMarkdownFilter {
    feed(delta: string): string
    flush(): string
  }
  export function sendImageMessageWeixin(params: {
    to: string
    text: string
    uploaded: {
      filekey: string
      fileSize: number
      fileSizeCiphertext: number
      aeskey: string
      downloadEncryptedQueryParam: string
    }
    opts: { baseUrl: string; token?: string; contextToken?: string }
  }): Promise<{ messageId: string }>
}

declare module '@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js' {
  // Mirrors the upload helper from cdn/upload.js (v2.4.3). Used by
  // weixin-bridge-runtime.sendImageFromUrlWeixin to push a temp file to the
  // WeChat CDN before calling sendImageMessageWeixin.
  export function uploadFileToWeixin(params: {
    filePath: string
    toUserId: string
    opts: { baseUrl: string; token?: string }
  }): Promise<{
    filekey: string
    fileSize: number
    fileSizeCiphertext: number
    aeskey: string
    downloadEncryptedQueryParam: string
  }>
}
