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

  it('handles fence marker split across feeds as 2+1 backticks', () => {
    const f = new FenceState()
    f.feed('```py')
    expect(f.isInside()).toBe(true)
    f.feed('\nprint("hi")\n')
    expect(f.isInside()).toBe(true)
    // Closing fence split as `` + `:
    f.feed('``')
    expect(f.isInside()).toBe(true)  // still inside: 2+1 haven't formed ```
    f.feed('`\n')
    expect(f.isInside()).toBe(false)
  })

  it('handles fence marker split across feeds as 1+2 backticks', () => {
    const f = new FenceState()
    f.feed('`')
    expect(f.isInside()).toBe(false)  // alone: no fence
    f.feed('``py\ncode\n')
    expect(f.isInside()).toBe(true)
    f.feed('```\n')  // close: ``` at line start
    expect(f.isInside()).toBe(false)
  })

  it('flushes trailing backticks when isInside is called repeatedly without new feed', () => {
    const f = new FenceState()
    f.feed('```js\nfoo\n``')
    expect(f.isInside()).toBe(true)
    // No new feed; state should not silently flip
    expect(f.isInside()).toBe(true)
  })
})
