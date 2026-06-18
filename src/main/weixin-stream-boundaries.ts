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
