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
