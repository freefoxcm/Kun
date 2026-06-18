import { describe, expect, it } from 'vitest'
import { FenceState, findFlushBoundaries } from './weixin-stream-boundaries'

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
