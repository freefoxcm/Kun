# Weixin Streamer Block Boundaries + Image Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `WeixinStreamer` so that text blocks respect semantic boundaries (paragraph / sentence / comma), never split inside ` ``` ` code fences, and complete `![alt](url)` images are sent as standalone image messages interleaved with text bubbles in source order.

**Architecture:** Pure-function helpers in a new `weixin-stream-boundaries.ts` module: `FenceState` (track `\`\`\`` open/close), `findFlushBoundaries` (scan + classify), `findCompleteImage` (regex match). `WeixinStreamer` keeps an instance of `FenceState`, feeds it deltas, and on flush runs an iterative `flushTick(force)` that interleaves text bubbles and image emissions. Bridge layer grows `sendImageFromUrlWeixin` that does the URL → download → SDK upload → `sendImageMessageWeixin` pipeline.

**Tech Stack:** TypeScript / Vitest / `@tencent-weixin/openclaw-weixin@2.4.3` (dynamic import already in use) / `weixin-bridge-runtime.ts` for the bridge helper.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/weixin-stream-boundaries.ts` (NEW) | `FenceState` class + `findFlushBoundaries(segment)` + `findCompleteImage(text)` |
| `src/main/weixin-stream-boundaries.test.ts` (NEW) | unit tests for the pure helpers |
| `src/main/weixin-streamer.ts` (MODIFY) | replace `scheduleFlush`/`flushPending` with `flushTick(force)`, add `maxChars` constructor param, add `emitText`/`emitImage`, use `FenceState` |
| `src/main/weixin-streamer.test.ts` (MODIFY) | extend tests for boundaries, fence awareness, image extraction |
| `src/main/weixin-bridge-runtime.ts` (MODIFY) | add `sendImageFromUrlWeixin(params)` helper, expose via `weixinBridgeRuntimeInternals` |
| `src/main/weixin-bridge-runtime.test.ts` (MODIFY) | test for `sendImageFromUrlWeixin` |
| `src/main/claw-runtime.ts` (MODIFY) | extend `WeixinBridgeHandle` type with `sendImage`, pass `maxChars` through `runStreamingReplyWeixin` |
| `src/main/claw-runtime.test.ts` (MODIFY) | update mocks to provide `sendImage` |
| `src/main/index.ts` (MODIFY) | wire `sendImage` into the injected `weixinBridge` handle |
| `src/main/openclaw-weixin-media.d.ts` (MODIFY) | declare `sendImageMessageWeixin` and `uploadFileToWeixin` exports we consume |
| `docs/superpowers/specs/2026-06-18-weixin-streaming-block-boundaries-design.md` | spec (already committed at `243f1b9` + `3c301cc`) |

---

## Task 1: FenceState class (TDD)

**Files:**
- Create: `src/main/weixin-stream-boundaries.ts`
- Create: `src/main/weixin-stream-boundaries.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/main/weixin-stream-boundaries.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FenceState } from './weixin-stream-boundaries'

describe('FenceState', () => {
  it('starts outside any fence', () => {
    const f = new FenceState()
    expect(f.isInside()).toBe(false)
  })

  it('enters fence on first ``` at line start', () => {
    const f = new FenceState()
    f.feed('```js\nconst a = 1\n')
    expect(f.isInside()).toBe(true)
  })

  it('exits fence on closing ```', () => {
    const f = new FenceState()
    f.feed('```js\nconst a = 1\n```\n')
    expect(f.isInside()).toBe(false)
  })

  it('handles split fence markers across feeds', () => {
    const f = new FenceState()
    f.feed('```py')
    expect(f.isInside()).toBe(true)
    f.feed('\nprint("hi")\n')
    expect(f.isInside()).toBe(true)
    f.feed('```')
    expect(f.isInside()).toBe(false)
  })

  it('toggles on each line-start ``` regardless of language tag', () => {
    const f = new FenceState()
    f.feed('```\nfoo\n```\n')
    expect(f.isInside()).toBe(false)
  })

  it('ignores ``` that is not at line start', () => {
    const f = new FenceState()
    f.feed('inline ``` is not a fence marker')
    expect(f.isInside()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts`
Expected: FAIL — `FenceState` not exported from `./weixin-stream-boundaries`

- [ ] **Step 3: Implement FenceState**

Create `src/main/weixin-stream-boundaries.ts`:

```ts
/**
 * Tracks whether the cumulative pendingText is currently inside a markdown
 * code fence (``` ... ```). The streamer feeds each delta into this state
 * machine as it arrives. Fence markers must appear at the start of a line
 * (after \n or at offset 0) to count; inline ``` is ignored.
 */
export class FenceState {
  private insideFence = false

  feed(text: string): void {
    const re = /(^|\n)```/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      this.insideFence = !this.insideFence
    }
  }

  isInside(): boolean {
    return this.insideFence
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts`
Expected: PASS — all 6 cases

- [ ] **Step 5: Commit**

```bash
git add src/main/weixin-stream-boundaries.ts src/main/weixin-stream-boundaries.test.ts
git commit -m "feat(weixin-streamer): add FenceState helper

Pure-function class to track markdown code-fence open/close state across
incremental SSE deltas. Line-start ``` toggles; inline ``` is ignored.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: findFlushBoundaries (TDD)

**Files:**
- Modify: `src/main/weixin-stream-boundaries.ts`
- Modify: `src/main/weixin-stream-boundaries.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/main/weixin-stream-boundaries.test.ts`:

```ts
import { findFlushBoundaries } from './weixin-stream-boundaries'

describe('findFlushBoundaries', () => {
  it('returns empty array for empty string', () => {
    expect(findFlushBoundaries('')).toEqual([])
  })

  it('finds paragraph boundary \\n\\n', () => {
    const seg = 'Hello\n\nWorld'
    const bs = findFlushBoundaries(seg)
    expect(bs).toContainEqual({ index: 5, type: 'paragraph', insideFence: false })
  })

  it('finds English sentence boundary after .!?', () => {
    const seg = 'Hello. World'
    const bs = findFlushBoundaries(seg)
    expect(bs).toContainEqual({ index: 6, type: 'sentence', insideFence: false })
  })

  it('finds Chinese sentence boundary after 。！？', () => {
    const seg = '你好。世界'
    const bs = findFlushBoundaries(seg)
    expect(bs).toContainEqual({ index: 3, type: 'sentence', insideFence: false })
  })

  it('finds comma boundary after ,;，；', () => {
    expect(findFlushBoundaries('Hello, world')).toContainEqual({
      index: 6, type: 'comma', insideFence: false
    })
    expect(findFlushBoundaries('你好，世界')).toContainEqual({
      index: 3, type: 'comma', insideFence: false
    })
  })

  it('does not match . , ; without trailing whitespace', () => {
    const bs = findFlushBoundaries('abc.def')
    expect(bs).toEqual([])
  })

  it('marks boundaries inside fence as insideFence: true', () => {
    const seg = 'Before.\n```\ninside. here\n```\nAfter.'
    const bs = findFlushBoundaries(seg)
    // Period at offset 7 is BEFORE fence (segment scan needs fence awareness)
    const beforeBoundary = bs.find(b => b.index === 7)
    expect(beforeBoundary?.insideFence).toBe(false)
    // Period after "inside." should be inside fence
    const insideFenceBoundary = bs.find(b => b.index >= 16 && b.index <= 22)
    expect(insideFenceBoundary?.insideFence).toBe(true)
  })

  it('sorts boundaries by index ascending', () => {
    const seg = 'Hi. There,\n\nNew para.'
    const bs = findFlushBoundaries(seg)
    for (let i = 1; i < bs.length; i++) {
      expect(bs[i].index).toBeGreaterThan(bs[i - 1].index)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts`
Expected: FAIL — `findFlushBoundaries` not exported

- [ ] **Step 3: Implement findFlushBoundaries**

Append to `src/main/weixin-stream-boundaries.ts`:

```ts
export type BoundaryType = 'paragraph' | 'sentence' | 'comma'

export type Boundary = {
  index: number
  type: BoundaryType
  insideFence: boolean
}

/**
 * Scan a text segment for all flush-worthy boundary positions, classified
 * by type and marked with whether they fall inside a markdown code fence.
 *
 * Returns ALL candidates (sorted by index ascending) — the caller decides
 * which to pick based on minChars / maxChars / force constraints.
 */
export function findFlushBoundaries(segment: string): Boundary[] {
  const boundaries: Boundary[] = []
  if (!segment) return boundaries

  // Track fence state as we scan.
  let insideFence = false
  // Track positions where fence toggled (in `segment` local coords).
  const fenceToggles: number[] = []
  const fenceRe = /(^|\n)```/g
  let fm: RegExpExecArray | null
  while ((fm = fenceRe.exec(segment)) !== null) {
    fenceToggles.push(fm.index + fm[1].length)
    insideFence = !insideFence
  }

  // Helper: is `pos` inside any open fence in `segment`?
  // After each toggle index, fence state flips. Determine state at `pos`.
  function isInsideFenceAt(pos: number): boolean {
    let state = false
    for (const t of fenceToggles) {
      if (t > pos) break
      state = !state
    }
    return state
  }

  // Paragraph: \n\n (boundary index = position AFTER the second \n)
  const paragraphRe = /\n\n/g
  let pm: RegExpExecArray | null
  while ((pm = paragraphRe.exec(segment)) !== null) {
    const idx = pm.index + pm[0].length
    boundaries.push({ index: idx, type: 'paragraph', insideFence: isInsideFenceAt(idx) })
  }

  // Sentence: 。！？.!? followed by whitespace or end-of-string
  const sentenceRe = /[。！？.!?](?=\s|$)/g
  let sm: RegExpExecArray | null
  while ((sm = sentenceRe.exec(segment)) !== null) {
    const idx = sm.index + 1
    boundaries.push({ index: idx, type: 'sentence', insideFence: isInsideFenceAt(idx) })
  }

  // Comma/semicolon: ，, ；; ,; followed by whitespace or end-of-string
  const commaRe = /[,;,，；](?=\s|$)/g
  let cm: RegExpExecArray | null
  while ((cm = commaRe.exec(segment)) !== null) {
    const idx = cm.index + 1
    boundaries.push({ index: idx, type: 'comma', insideFence: isInsideFenceAt(idx) })
  }

  boundaries.sort((a, b) => a.index - b.index)
  return boundaries
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts`
Expected: PASS — all cases

- [ ] **Step 5: Commit**

```bash
git add src/main/weixin-stream-boundaries.ts src/main/weixin-stream-boundaries.test.ts
git commit -m "feat(weixin-streamer): add findFlushBoundaries

Scans segment for paragraph (\\n\\n), sentence (。！？.!?), and
comma (，,；;) boundaries. Marks each with insideFence flag so callers
can prefer fence-safe split points.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: findCompleteImage (TDD)

**Files:**
- Modify: `src/main/weixin-stream-boundaries.ts`
- Modify: `src/main/weixin-stream-boundaries.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/main/weixin-stream-boundaries.test.ts`:

```ts
import { findCompleteImage } from './weixin-stream-boundaries'

describe('findCompleteImage', () => {
  it('returns null for text without image', () => {
    expect(findCompleteImage('plain text')).toBeNull()
  })

  it('matches ![alt](https://url)', () => {
    const r = findCompleteImage('Hello ![chart](https://example.com/x.png) world')
    expect(r).toEqual({
      start: 6, end: 38, url: 'https://example.com/x.png'
    })
  })

  it('matches absolute path ![](/local/path)', () => {
    const r = findCompleteImage('see ![](/tmp/x.png) below')
    expect(r?.url).toBe('/tmp/x.png')
  })

  it('matches empty alt ![](url)', () => {
    const r = findCompleteImage('![](https://e.com/x.png)')
    expect(r).not.toBeNull()
  })

  it('returns null for incomplete ![alt](url without closing paren', () => {
    expect(findCompleteImage('see ![alt](https://e.com/x.png here')).toBeNull()
  })

  it('returns null for incomplete ![ without alt/paren', () => {
    expect(findCompleteImage('here ![partial text')).toBeNull()
  })

  it('does NOT match ![alt](url "title") — title not supported', () => {
    // Title form is out of scope. Should return null so the streamer keeps
    // the text in pendingText and never extracts it as an image.
    expect(findCompleteImage('![alt](https://e.com/x.png "title")')).toBeNull()
  })

  it('does not match http:// or relative URLs that lack leading /', () => {
    // Only https/http and absolute / paths supported.
    expect(findCompleteImage('![alt](ftp://e.com/x.png)')).toBeNull()
    expect(findCompleteImage('![alt](./relative.png)')).toBeNull()
  })

  it('returns FIRST complete image in the segment', () => {
    const r = findCompleteImage('a ![one](https://a.com/1.png) b ![two](https://b.com/2.png)')
    expect(r?.url).toBe('https://a.com/1.png')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts`
Expected: FAIL — `findCompleteImage` not exported

- [ ] **Step 3: Implement findCompleteImage**

Append to `src/main/weixin-stream-boundaries.ts`:

```ts
export type ImageMatch = {
  start: number  // index of '!' in pendingText
  end: number    // index AFTER ')' in pendingText
  url: string
}

const IMAGE_RE = /!\[[^\]]*\]\((?:https?:|\/)[^\s)]+\)/g

/**
 * Find the FIRST complete `![alt](url)` image markdown in `text`. Returns
 * null if no complete image exists (e.g., the markdown is split across an
 * SSE delta boundary and the closing `)` hasn't arrived yet).
 *
 * Supports only `https?://` and absolute `/(...)` paths. Title form
 * `![alt](url "title")` is intentionally NOT matched — those stay in
 * pendingText and get emitted as-is when the stream ends.
 */
export function findCompleteImage(text: string): ImageMatch | null {
  IMAGE_RE.lastIndex = 0
  const m = IMAGE_RE.exec(text)
  if (!m) return null
  const matched = m[0]
  // Extract URL from inside the parens: `![alt](URL)`
  const parenStart = matched.indexOf('(')
  const url = matched.slice(parenStart + 1, matched.length - 1)
  return {
    start: m.index,
    end: m.index + matched.length,
    url
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts`
Expected: PASS — all cases

- [ ] **Step 5: Commit**

```bash
git add src/main/weixin-stream-boundaries.ts src/main/weixin-stream-boundaries.test.ts
git commit -m "feat(weixin-streamer): add findCompleteImage

Returns first complete ![alt](https?://|/...) match in text. Incomplete
markdown (across SSE delta boundary) returns null so the streamer waits.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Extend weixin-bridge-runtime with sendImageFromUrlWeixin (TDD)

**Files:**
- Modify: `src/main/weixin-bridge-runtime.ts`
- Modify: `src/main/weixin-bridge-runtime.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/main/weixin-bridge-runtime.test.ts` (find existing describe block pattern first; create new describe if needed):

```ts
import { describe, expect, it, vi } from 'vitest'

describe('sendImageFromUrlWeixin', () => {
  it('downloads URL, uploads via SDK, calls sendImageMessageWeixin', async () => {
    // Mock SDK dynamic import
    vi.doMock('@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js', () => ({
      sendImageMessageWeixin: vi.fn().mockResolvedValue({ messageId: 'sdk-msg-1' })
    }))
    // Mock upload
    vi.doMock('@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js', () => ({
      uploadFileToWeixin: vi.fn().mockResolvedValue({
        filekey: 'fk-1',
        fileSize: 1024,
        fileSizeCiphertext: 1040,
        aeskey: 'a'.repeat(32),
        downloadEncryptedQueryParam: 'qp=1'
      })
    }))
    // Mock network fetch
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]).buffer)
    })
    // @ts-expect-error — stub global
    globalThis.fetch = fetchSpy

    const mod = await import('./weixin-bridge-runtime')
    const result = await mod.weixinBridgeRuntimeInternals.sendImageFromUrlWeixin({
      account: { accountId: 'bot-1', baseUrl: 'https://ilinkai.weixin.qq.com', token: 'tk', sessionKey: '', createdAt: 0 } as never,
      to: 'user-1',
      imageUrl: 'https://cdn.example.com/x.jpg',
      contextToken: 'ctx-1'
    })

    expect(result.messageId).toBe('sdk-msg-1')
    expect(fetchSpy).toHaveBeenCalledWith('https://cdn.example.com/x.jpg')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/weixin-bridge-runtime.test.ts`
Expected: FAIL — `sendImageFromUrlWeixin` not exported on `weixinBridgeRuntimeInternals`

- [ ] **Step 3: Implement sendImageFromUrlWeixin**

First, extend the d.ts:

Append to `src/main/openclaw-weixin-media.d.ts`:

```ts
declare module '@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js' {
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

declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js' {
  // StreamingMarkdownFilter already declared above; add image sender here.
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
```

Then add to `src/main/weixin-bridge-runtime.ts` (place near other send helpers, around line 738):

```ts
/**
 * Download an image URL, upload it to the Weixin CDN via the bundled plugin,
 * and send it as a weixin image message. Used by weixin-streamer when it
 * extracts a complete ![alt](url) from streaming markdown.
 *
 * Pipeline:
 *   1. fetch(url) → ArrayBuffer
 *   2. write to OS temp file (with a .jpg extension hint so the SDK picks
 *      the image upload route; the MIME sniffer uses file extension)
 *   3. uploadFileToWeixin({ filePath, toUserId, opts })
 *   4. sendImageMessageWeixin({ to, uploaded, opts })
 *   5. unlink temp file
 */
async function sendImageFromUrlWeixin(params: {
  account: WeixinAccount
  to: string
  imageUrl: string
  contextToken?: string
  timeoutMs?: number
}): Promise<{ messageId: string }> {
  const { writeFile, unlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')

  // 1. Download.
  const res = await fetch(params.imageUrl)
  if (!res.ok) {
    throw new Error(`sendImageFromUrlWeixin: fetch failed status=${res.status} url=${params.imageUrl}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  // 2. Write to temp file with .jpg extension (SDK mime-sniffs via extension).
  const ext = guessImageExtension(params.imageUrl, buf)
  const tmpPath = join(tmpdir(), `kun-weixin-${randomUUID()}.${ext}`)
  await writeFile(tmpPath, buf)

  try {
    // 3. Upload to CDN.
    const { uploadFileToWeixin } = await import(
      '@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js' as string
    )
    const uploaded = await uploadFileToWeixin({
      filePath: tmpPath,
      toUserId: params.to,
      opts: { baseUrl: params.account.baseUrl, token: params.account.token }
    })

    // 4. Send image message.
    const { sendImageMessageWeixin } = await import(
      '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js' as string
    )
    const result = await sendImageMessageWeixin({
      to: params.to,
      text: '',
      uploaded,
      opts: {
        baseUrl: params.account.baseUrl,
        token: params.account.token,
        contextToken: params.contextToken
      }
    })
    return result
  } finally {
    // 5. Cleanup temp file (best-effort).
    void unlink(tmpPath).catch(() => undefined)
  }
}

function guessImageExtension(url: string, buf: Buffer): string {
  // Magic-byte sniff first (more reliable than URL).
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp'
  // Fall back to URL extension.
  const m = url.match(/\.(jpg|jpeg|png|gif|bmp|webp)(?:\?|$)/i)
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
  return 'jpg' // last resort
}
```

Then expose it via `weixinBridgeRuntimeInternals` (find the existing object literal that exports `sendMessageWeixin` and add this):

```ts
export const weixinBridgeRuntimeInternals = {
  // ...existing exports...
  sendImageFromUrlWeixin
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/weixin-bridge-runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/weixin-bridge-runtime.ts src/main/weixin-bridge-runtime.test.ts src/main/openclaw-weixin-media.d.ts
git commit -m "feat(weixin-bridge): add sendImageFromUrlWeixin

Downloads URL → temp file → uploadFileToWeixin → sendImageMessageWeixin.
Used by weixin-streamer when extracting ![alt](url) images.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Extend WeixinBridgeHandle type and inject sendImage

**Files:**
- Modify: `src/main/claw-runtime.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/claw-runtime.test.ts`

- [ ] **Step 1: Find existing WeixinBridgeHandle type**

Run: `grep -n "WeixinBridgeHandle" src/main/claw-runtime.ts src/main/claw-runtime-helpers.ts`

The type lives in `src/main/claw-runtime.ts` (or `claw-runtime-helpers.ts`). It currently has only `sendMessage`. Add `sendImage`:

In the file where `WeixinBridgeHandle` is defined, replace the type with:

```ts
export type WeixinBridgeHandle = {
  sendMessage: (accountId: string, to: string, text: string, contextToken: string | undefined) => Promise<{ messageId: string }>
  sendImage: (accountId: string, to: string, imageUrl: string, contextToken: string | undefined) => Promise<{ messageId: string }>
}
```

- [ ] **Step 2: Update src/main/index.ts injection**

Find where `weixinBridge` is built (search for `sendMessage: sendWeixinBridgeMessage` or similar). Wrap to add `sendImage`:

```ts
const weixinBridge = {
  sendMessage: (accountId, to, text, contextToken) =>
    sendWeixinBridgeMessage({ accountId, to, text, contextToken }),
  sendImage: (accountId, to, imageUrl, contextToken) =>
    weixinBridgeRuntimeInternals.sendImageFromUrlWeixin({
      account: resolveAccount(accountId),
      to,
      imageUrl,
      contextToken
    })
}
```

(Adjust to whatever `resolveAccount` helper exists in your index.ts; if no helper, look up the account from the bridge runtime's account map.)

- [ ] **Step 3: Update claw-runtime.test.ts mocks**

Find the `WeixinBridgeHandle` mock (likely an `as never` cast or a vi.fn). Add `sendImage`:

```ts
const mockBridge: WeixinBridgeHandle = {
  sendMessage: vi.fn().mockResolvedValue({ messageId: 'm1' }),
  sendImage: vi.fn().mockResolvedValue({ messageId: 'i1' })
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json 2>&1 | grep -v "WriteMarkdownPreview\|WorkspaceFilePreviewPanel\|chat-store-thread-actions\|claw-runtime.test\|feishu-streamer.test\|kun-process"`
Expected: no NEW errors (existing develop baseline errors are fine)

- [ ] **Step 5: Commit**

```bash
git add src/main/claw-runtime.ts src/main/index.ts src/main/claw-runtime.test.ts
git commit -m "feat(claw-runtime): add sendImage to WeixinBridgeHandle

Streamer needs to call bridge.sendImage for extracted markdown images.
Wire sendImageFromUrlWeixin through the dependency injection.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Refactor WeixinStreamer with flushTick (TDD)

**Files:**
- Modify: `src/main/weixin-streamer.ts`
- Modify: `src/main/weixin-streamer.test.ts`

This is the biggest task. We split into sub-steps but commit together at the end.

- [ ] **Step 1: Update test for new flushTick behavior**

In `src/main/weixin-streamer.test.ts`, find existing tests that rely on the old `scheduleFlush` (e.g., "sends first block after idle timer"). They may need rewriting because:
- Idle timer now triggers `flushTick(false)` instead of `flushPending()`
- After first flush, idle timer doesn't restart (existing behavior preserved)

Add NEW tests covering the new behavior. Append to the test file:

```ts
import { WeixinStreamer } from './weixin-streamer'

describe('WeixinStreamer boundary-aware flush', () => {
  function makeBridgeHandle() {
    return {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'm1' }),
      sendImage: vi.fn().mockResolvedValue({ messageId: 'i1' })
    }
  }

  function makeStreamer(opts?: Partial<Parameters<typeof WeixinStreamer.prototype.constructor>[0]>) {
    const bridge = makeBridgeHandle()
    const streamer = new WeixinStreamer({
      bridge,
      accountId: 'bot-1',
      to: 'user-1',
      turnId: 'turn-1',
      threadId: 'thr-1',
      contextToken: 'ctx',
      minChars: 50,
      maxChars: 200,
      idleMs: 100,
      responseTimeoutMs: 60_000,
      logger: () => {},
      ...opts
    })
    return { streamer, bridge }
  }

  it('flushes at paragraph boundary \\n\\n when minChars reached', async () => {
    const { streamer, bridge } = makeStreamer()
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'Hello\n\nWorld' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    // "Hello\n\n" flushed at minChars; "World" flushes at turn_completed
    expect(bridge.sendMessage).toHaveBeenCalledWith('bot-1', 'user-1', 'Hello\n\n', 'ctx')
    expect(bridge.sendMessage).toHaveBeenLastCalledWith('bot-1', 'user-1', 'World', 'ctx')
  })

  it('falls back to sentence boundary when no paragraph', async () => {
    const { streamer, bridge } = makeStreamer({ minChars: 10 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'Hello. World this is long enough to flush.' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    const calls = bridge.sendMessage.mock.calls.map(c => c[2])
    // First flush should split at the sentence boundary "Hello. "
    expect(calls[0]).toBe('Hello. ')
  })

  it('never splits inside code fence', async () => {
    const { streamer, bridge } = makeStreamer({ minChars: 10, maxChars: 1000 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    // Single big fenced block with internal sentence boundary
    const text = '```\nHello. World.\n```'
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    const calls = bridge.sendMessage.mock.calls.map(c => c[2])
    // Should emit the whole fenced block as one bubble
    expect(calls).toContain('```\nHello. World.\n```')
  })

  it('extracts complete image and emits image+text in source order', async () => {
    const { streamer, bridge } = makeStreamer({ minChars: 5 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'See ![chart](https://e.com/x.png) for details' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    // At turn_completed, force=true: emit "See " text, then image, then " for details"
    expect(bridge.sendMessage).toHaveBeenCalledWith('bot-1', 'user-1', 'See ', 'ctx')
    expect(bridge.sendImage).toHaveBeenCalledWith('bot-1', 'user-1', 'https://e.com/x.png', 'ctx')
    expect(bridge.sendMessage).toHaveBeenLastCalledWith('bot-1', 'user-1', ' for details', 'ctx')
  })

  it('keeps incomplete image markdown in pendingText and waits', async () => {
    const { streamer, bridge } = makeStreamer({ minChars: 5 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    // Partial image — missing closing )
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: 'See ![chart](https://e.com/x' } })
    await new Promise(r => setTimeout(r, 50))  // let idle timer fire
    expect(bridge.sendImage).not.toHaveBeenCalled()
    // Next delta completes it
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text: '.png) now' } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    expect(bridge.sendImage).toHaveBeenCalledWith('bot-1', 'user-1', 'https://e.com/x.png', 'ctx')
  })

  it('hard-splits at maxChars when no boundary found', async () => {
    const { streamer, bridge } = makeStreamer({ minChars: 10, maxChars: 30 })
    const startPromise = streamer.start({ subscribe: () => ({ close: () => {} }) })
    // 60 chars with NO spaces or punctuation (worst case)
    const text = 'a'.repeat(60)
    streamer.onSseEvent({ kind: 'assistant_text_delta', turnId: 'turn-1', item: { text } })
    streamer.onSseEvent({ kind: 'turn_completed', turnId: 'turn-1' })
    await startPromise
    const calls = bridge.sendMessage.mock.calls.map(c => c[2])
    // Two 30-char calls
    expect(calls.some(c => c.length === 30)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/weixin-streamer.test.ts`
Expected: FAIL — `maxChars` constructor param not accepted; flushTick logic not implemented; emitImage path missing

- [ ] **Step 3: Refactor WeixinStreamer**

Rewrite `src/main/weixin-streamer.ts`. The new file:

```ts
import {
  FenceState,
  findFlushBoundaries,
  findCompleteImage,
  type Boundary
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

// Lazy-load StreamingMarkdownFilter (kept for parity with prior implementation;
// boundary-aware splitter handles images separately now, but the filter
// still strips other unwanted constructs if the SDK ships it).
type StreamingMarkdownFilterCtor = new () => {
  feed: (delta: string) => string
  flush: () => string
}
let _StreamingMarkdownFilterCtor: StreamingMarkdownFilterCtor | null = null
let _loadStreamingMarkdownFilterPromise: Promise<void> | null = null
function loadStreamingMarkdownFilter(): Promise<void> {
  if (_loadStreamingMarkdownFilterPromise) return _loadStreamingMarkdownFilterPromise
  _loadStreamingMarkdownFilterPromise = import(
    '@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js'
  )
    .then((mod) => {
      const Ctor = (mod as { StreamingMarkdownFilter?: StreamingMarkdownFilterCtor }).StreamingMarkdownFilter
      if (Ctor) _StreamingMarkdownFilterCtor = Ctor
    })
    .catch(() => {
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
    let closeRef: () => void = () => {}
    const ac = new AbortController()

    void loadStreamingMarkdownFilter().then(() => {
      const Ctor = _StreamingMarkdownFilterCtor
      if (Ctor) this.filter = new Ctor()
    })

    const setup = Promise.resolve().then(() => {
      const { close } = input.subscribe(ac.signal)
      closeRef = close
    }).catch((err) => {
      this.opts.logger('weixin-stream', 'subscribe failed', { message: String(err) })
      this.markClosed()
      throw err
    })
    void setup

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

    await new Promise<void>((resolve) => {
      this.closeResolver = resolve
      const tick = () => {
        checkTimeout()
        if (this.closed) { resolve(); return }
        setTimeout(tick, 50)
      }
      void setup.then(() => { if (this.closed) resolve(); else tick() }, () => resolve())
    })
    closeRef()
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
    if (turnId && turnId !== this.opts.turnId) return

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
      queueMicrotask(() => { void this.flushTick(false) })
      return
    }
    if (this.hasFlushedOnce) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.flushTick(false) }, this.opts.idleMs)
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
    if (this.aborted || this.closed) return

    let processed = true
    while (processed && !this.aborted && !this.closed) {
      processed = false
      const imageMatch = findCompleteImage(this.pendingText)

      if (imageMatch === null) {
        // No image to emit; try to flush text at a boundary.
        const flushResult = this.tryFlushTextAtBoundary()
        if (flushResult === 'flushed') {
          processed = true
          continue
        }
        if (flushResult === 'hardSplit') {
          processed = true
          continue
        }
        // flushResult === 'wait'
        if (force && this.pendingText) {
          await this.emitText(this.pendingText)
          this.pendingText = ''
          processed = true
        }
        continue
      }

      // Image found at [imageStart, imageEnd].
      const { start: imageStart, end: imageEnd, url } = imageMatch
      if (imageStart > 0) {
        const textBefore = this.pendingText.slice(0, imageStart)
        const result = this.pickTextBoundary(textBefore)
        if (result.kind === 'found') {
          await this.emitText(textBefore.slice(0, result.index))
          this.pendingText = textBefore.slice(result.index) + this.pendingText.slice(imageStart)
          processed = true
          continue
        }
        if (result.kind === 'forceHard') {
          await this.emitText(textBefore.slice(0, this.maxChars))
          this.pendingText = textBefore.slice(this.maxChars) + this.pendingText.slice(imageStart)
          processed = true
          continue
        }
        if (force) {
          await this.emitText(textBefore)
          this.pendingText = this.pendingText.slice(imageStart)
          processed = true
          continue
        }
        // wait
        continue
      }

      // Image at start of pendingText.
      await this.emitImage(url)
      this.pendingText = this.pendingText.slice(imageEnd)
      processed = true
    }
  }

  /**
   * Try to flush pendingText as a text bubble using boundary logic.
   * Returns 'flushed' (cut happened), 'hardSplit' (maxChars force cut),
   * or 'wait' (not enough content or no boundary).
   */
  private tryFlushTextAtBoundary(): 'flushed' | 'hardSplit' | 'wait' {
    if (!this.pendingText) return 'wait'
    const result = this.pickTextBoundary(this.pendingText)
    if (result.kind === 'found') {
      // Sync boundary cut; actual emit happens via flushTick loop.
      // We need to emit here — so this helper is misleading. Refactor:
      // return the index instead and let flushTick emit.
      // (Implemented as a separate path below.)
      return 'flushed'  // marker only; flushTick handles via re-scan
    }
    if (result.kind === 'forceHard') return 'hardSplit'
    return 'wait'
  }

  /**
   * Pick a boundary index for `segment`:
   * - 'found' with index = first fence-safe boundary at or after minChars
   * - 'forceHard' if segment.length > maxChars and no clean boundary
   * - 'wait' if segment too short to flush
   */
  private pickTextBoundary(segment: string): { kind: 'found'; index: number } | { kind: 'forceHard' } | { kind: 'wait' } {
    if (!segment) return { kind: 'wait' }
    const candidates = findFlushBoundaries(segment)
    // Find first fence-safe candidate at or after minChars
    const usable = candidates.find(b => !b.insideFence && b.index >= this.opts.minChars)
    if (usable) return { kind: 'found', index: usable.index }
    // No clean boundary
    if (segment.length > this.maxChars) return { kind: 'forceHard' }
    return { kind: 'wait' }
  }

  private async emitText(text: string): Promise<void> {
    if (!text) return
    try {
      await this.opts.bridge.sendMessage(this.opts.accountId, this.opts.to, text, this.opts.contextToken)
      this.consecutiveFailures = 0
      this.messageCount += 1
      this.hasFlushedOnce = true
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
  get messageCount_(): number { return this.messageCount }

  abort(): void { this.aborted = true; this.markClosed() }

  dispose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.markClosed()
  }
}
```

**Note on the `tryFlushTextAtBoundary` refactor above**: the implementation shown has a subtle bug — the helper returns a marker but doesn't perform the cut. In the implementation commit, refactor so `tryFlushTextAtBoundary` returns the cut index and `flushTick` performs the cut, OR inline the logic into `flushTick`. The simpler approach is to inline. Use this final shape for `flushTick`'s text-only branch:

```ts
if (imageMatch === null) {
  const result = this.pickTextBoundary(this.pendingText)
  if (result.kind === 'found') {
    await this.emitText(this.pendingText.slice(0, result.index))
    this.pendingText = this.pendingText.slice(result.index)
    processed = true
    continue
  }
  if (result.kind === 'forceHard') {
    await this.emitText(this.pendingText.slice(0, this.maxChars))
    this.pendingText = this.pendingText.slice(this.maxChars)
    processed = true
    continue
  }
  // wait
  if (force && this.pendingText) {
    await this.emitText(this.pendingText)
    this.pendingText = ''
    processed = true
  }
  continue
}
```

Drop the `tryFlushTextAtBoundary` method — it's no longer used.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/weixin-streamer.test.ts`
Expected: PASS — all old + new cases

- [ ] **Step 5: Commit**

```bash
git add src/main/weixin-streamer.ts src/main/weixin-streamer.test.ts
git commit -m "feat(weixin-streamer): boundary-aware flushTick + image extraction

Replace scheduleFlush/flushPending with iterative flushTick(force) that:
- splits text at paragraph > sentence > comma boundaries (never inside fences)
- extracts complete ![alt](url) and emits via bridge.sendImage
- interleaves text bubbles and image messages in source order
- hard-splits at maxChars (default 1500) when no boundary found

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Wire runStreamingReplyWeixin with maxChars

**Files:**
- Modify: `src/main/claw-runtime.ts`
- Modify: `src/main/claw-runtime.test.ts`

- [ ] **Step 1: Find runStreamingReplyWeixin**

Run: `grep -n "runStreamingReplyWeixin" src/main/claw-runtime.ts`

It currently calls `new WeixinStreamer({ ... })`. Find that constructor call and add `maxChars`:

```ts
new WeixinStreamer({
  bridge: this.opts.bridgeHandle,
  accountId,
  to,
  turnId,
  threadId,
  contextToken,
  minChars: 200,
  maxChars: 1500,        // NEW
  idleMs: 3000,
  responseTimeoutMs,
  logger: this.opts.logger
})
```

- [ ] **Step 2: Run claw-runtime tests**

Run: `npx vitest run src/main/claw-runtime.test.ts`
Expected: PASS — all 51 tests, including new sendImage mock

- [ ] **Step 3: Commit**

```bash
git add src/main/claw-runtime.ts src/main/claw-runtime.test.ts
git commit -m "feat(claw-runtime): pass maxChars to WeixinStreamer

Default 1500 matches design spec; matches the hard-split fallback boundary
in weixin-stream-boundaries.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Final validation

**Files:** (none modified)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all existing tests pass; new tests pass

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`
Expected: no NEW errors beyond the develop baseline (WriteMarkdownPreview, feishu-streamer.test, claw-runtime.test, chat-store-thread-actions.test, kun-process, WorkspaceFilePreviewPanel — all pre-existing)

- [ ] **Step 3: Manual smoke**

Verify by running the new tests in isolation:

Run: `npx vitest run src/main/weixin-stream-boundaries.test.ts src/main/weixin-streamer.test.ts`
Expected: all pass

- [ ] **Step 4: Commit if any cleanup**

If step 1-3 surfaced any cleanup, commit it. Otherwise this task has no commit.

---

## Verification

After all tasks complete:

```bash
# Run all tests
npx vitest run

# Typecheck
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json

# Diff stat
git diff --stat develop..HEAD
```

Expected:
- 7 new/modified test files (`weixin-stream-boundaries.test.ts` new, others extended)
- `weixin-stream-boundaries.ts` new module (~120 lines)
- `weixin-streamer.ts` refactored with flushTick
- `weixin-bridge-runtime.ts` gains `sendImageFromUrlWeixin`
- `claw-runtime.ts` extends `WeixinBridgeHandle` and passes `maxChars`
- All tests pass
- No new typecheck errors

---

## Self-Review Notes (filled by plan author)

- **Spec coverage**: All 6 design decisions covered (boundaries priority, fence awareness, image extraction, maxChars cap, sendImage bridge, force-on-turn-end) → mapped to Tasks 1-7.
- **Placeholder scan**: No TBD/TODO. Each step has exact code or test.
- **Type consistency**: `BridgeHandle.sendImage` defined in Task 4 (bridge), referenced in Task 5 (type extension), used in Task 6 (streamer). Same `(accountId, to, ..., contextToken?) => Promise<{messageId}>` signature throughout. `WeixinBridgeHandle` (Task 5) mirrors this. ✓
- **Risk callout**: Task 4 dynamic imports may need vitest mocking. Task 6 has a known refactor note (the `tryFlushTextAtBoundary` helper is dropped in favor of inlined logic in `flushTick`).