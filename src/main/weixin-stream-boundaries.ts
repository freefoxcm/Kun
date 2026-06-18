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
