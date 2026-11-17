import { describe, expect, it } from 'vitest'
import { entryKey, place, renameKey, sortGroup } from './recents-order'

const id = (key: string) => key

describe('sortGroup', () => {
	it('keeps the default order without a hand-made one', () => {
		expect(sortGroup(['c', 'b', 'a'], id, [])).toEqual(['c', 'b', 'a'])
	})

	it('puts items never placed by hand first, then the placed ones in their order', () => {
		expect(sortGroup(['new', 'b', 'a', 'c'], id, ['a', 'c', 'b'])).toEqual(['new', 'a', 'c', 'b'])
	})
})

describe('place', () => {
	it('moves an item before or after another in its group', () => {
		expect(place([], ['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
		expect(place([], ['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c'])
	})

	it('adds an item coming from another group', () => {
		expect(place([], ['a', 'b'], 'x', 'b', 'before')).toEqual(['a', 'x', 'b'])
		expect(place([], ['a', 'b'], 'x', null, 'start')).toEqual(['x', 'a', 'b'])
		expect(place([], ['a', 'b'], 'x', null, 'end')).toEqual(['a', 'b', 'x'])
	})

	it('leaves the relative order of other groups alone', () => {
		const order = ['f1', 'a', 'f2', 'b']
		const next = place(order, ['a', 'b'], 'b', 'a', 'before')
		expect(sortGroup(['f2', 'f1'], id, next)).toEqual(['f1', 'f2'])
		expect(sortGroup(['a', 'b'], id, next)).toEqual(['b', 'a'])
	})

	it('falls back to an end when the anchor is gone', () => {
		expect(place([], ['a', 'b'], 'x', 'missing', 'after')).toEqual(['a', 'b', 'x'])
	})
})

describe('keys', () => {
	it('keys projects by their stamp so a rename or move keeps their place', () => {
		const createdAt = new Date(2026, 10, 17, 10, 12, 19)
		expect(entryKey({ createdAt, path: '/a/x/transcript.vibe.json' })).toBe(entryKey({ createdAt, path: '/a/F/y/transcript.vibe.json' }))
		expect(entryKey({ createdAt: new Date(0), path: '/p' })).toBe('path:/p')
	})

	it('renames a folder key in place', () => {
		expect(renameKey(['a', 'folder:Old', 'b'], 'folder:Old', 'folder:New')).toEqual(['a', 'folder:New', 'b'])
	})
})
