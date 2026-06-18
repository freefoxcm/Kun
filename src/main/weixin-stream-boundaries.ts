/**
 * Tracks whether the cumulative pendingText is currently inside a markdown
 * code fence (``` ... ```). The streamer feeds each delta into this state
 * machine as it arrives. Fence markers must appear at the start of a line
 * (after \n or at offset 0) to count; inline ``` is ignored.
 */
export class FenceState {
  private insideFence = false
  // Buffer of trailing 0..2 backticks from the previous feed that may form
  // part of a ``` fence marker with the next feed's leading backticks.
  private trailingTicks = ''

  feed(text: string): void {
    const combined = this.trailingTicks + text
    // Scan the full combined text for fence markers. Anything trailing after
    // the last match (up to 2 backticks) is held in the buffer in case it
    // forms a complete ``` marker with the next feed's leading backticks.
    const re = /(^|\n)```/g
    let lastMatchEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(combined)) !== null) {
      lastMatchEnd = re.lastIndex
      this.insideFence = !this.insideFence
    }
    const after = combined.slice(lastMatchEnd)
    const tail = after.match(/(?<ticks>`{0,2}$)/)?.groups?.ticks ?? ''
    this.trailingTicks = tail
  }

  isInside(): boolean {
    return this.insideFence
  }
}

export type BoundaryType = 'paragraph' | 'sentence' | 'comma'

/**
 * A potential flush position within a text segment.
 *
 * Index convention (PREFIX-END): in all cases, `text.slice(0, boundary.index)`
 * yields the content to emit, and `text.slice(boundary.index)` is what stays.
 * - `paragraph`: index points AT the first `\n` of the `\n\n` pair (the
 *   emitted prefix keeps NO trailing `\n`, and the caller slices the tail
 *   with `index + 1` so the tail keeps one leading `\n`).
 * - `sentence` / `comma`: index points AFTER the punctuation (the punctuation
 *   IS included in the emitted prefix)
 */
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
  // Fence toggles in `segment` local coords.
  const fenceToggles: number[] = []
  const fenceRe = /(^|\n)```/g
  let fm: RegExpExecArray | null
  while ((fm = fenceRe.exec(segment)) !== null) {
    fenceToggles.push(fm.index + fm[1].length)
  }

  // Helper: is `pos` inside any open fence in `segment`?
  // At each toggle position, fence has NOT yet flipped (strict >),
  // so the toggle char itself is treated as the start of the new fence state.
  function isInsideFenceAt(pos: number): boolean {
    let state = false
    for (const t of fenceToggles) {
      if (t > pos) break
      state = !state
    }
    return state
  }

  // Paragraph: \n\n. The boundary index is the position OF the first \n
  // in the pair (i.e. AT, not AFTER). This absorbs the first \n into the
  // boundary itself — the emitted prefix keeps no trailing \n, and the
  // streamer slices the tail with `index + 1` so it keeps one leading \n.
  // For input "Hello\n\nWorld" this produces "Hello" + "\nWorld" rather
  // than "Hello\n" + "\nWorld".
  const paragraphRe = /\n\n/g
  let pm: RegExpExecArray | null
  while ((pm = paragraphRe.exec(segment)) !== null) {
    const idx = pm.index
    boundaries.push({ index: idx, type: 'paragraph', insideFence: isInsideFenceAt(idx) })
  }

  // Sentence boundaries: Chinese 。！？ match at any position (Chinese text
  // typically has no space after the punctuation); English .!? require
  // trailing whitespace or end-of-string to avoid splitting decimals etc.
  const cjkSentenceRe = /[。！？]/g
  let csm: RegExpExecArray | null
  while ((csm = cjkSentenceRe.exec(segment)) !== null) {
    const idx = csm.index + 1
    boundaries.push({ index: idx, type: 'sentence', insideFence: isInsideFenceAt(idx) })
  }
  const enSentenceRe = /[.!?](?=\s|$)/g
  let esm: RegExpExecArray | null
  while ((esm = enSentenceRe.exec(segment)) !== null) {
    const idx = esm.index + 1
    boundaries.push({ index: idx, type: 'sentence', insideFence: isInsideFenceAt(idx) })
  }

  // Comma/semicolon: Chinese ，； match at any position; English ,; require
  // trailing whitespace or end-of-string.
  const cjkCommaRe = /[，；]/g
  let ccm: RegExpExecArray | null
  while ((ccm = cjkCommaRe.exec(segment)) !== null) {
    const idx = ccm.index + 1
    boundaries.push({ index: idx, type: 'comma', insideFence: isInsideFenceAt(idx) })
  }
  const enCommaRe = /[,;](?=\s|$)/g
  let ecm: RegExpExecArray | null
  while ((ecm = enCommaRe.exec(segment)) !== null) {
    const idx = ecm.index + 1
    boundaries.push({ index: idx, type: 'comma', insideFence: isInsideFenceAt(idx) })
  }

  boundaries.sort((a, b) => a.index - b.index)

  // Deduplicate boundaries that share the same index, keeping the strongest
  // type (paragraph > sentence > comma). This can happen when punctuation
  // sits right next to a paragraph break (e.g. "...end.\n\nNext").
  const priority: Record<BoundaryType, number> = {
    paragraph: 3,
    sentence: 2,
    comma: 1,
  }
  const deduped: Boundary[] = []
  for (const b of boundaries) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.index === b.index) {
      if (priority[b.type] > priority[prev.type]) {
        deduped[deduped.length - 1] = b
      }
    } else {
      deduped.push(b)
    }
  }
  return deduped
}

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
