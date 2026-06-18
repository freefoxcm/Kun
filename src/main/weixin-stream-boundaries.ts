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
 * - `paragraph`: index points AT the first `\n` of the `\n\n` pair (the blank
 *   line itself is excluded from the emitted prefix)
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

  // Paragraph: \n\n (boundary index = position OF the first \n in the pair,
  // so callers can flush text before the blank line)
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
