import { useState } from 'react'
import type { TranscriptEntry } from './transcripts-store'

const ORDER_STORAGE_KEY = 'vibe_sidebar_order'

/** Where a dragged row lands relative to another one, or at an end of its group. */
export type Placement = 'before' | 'after' | 'start' | 'end'

/**
 * A project's key survives renames and moves: the stamp in its folder name never changes. Two
 * projects saved in the same second share it, which only means they move as a pair.
 */
export function entryKey(entry: Pick<TranscriptEntry, 'createdAt' | 'path'>) {
	const time = entry.createdAt.getTime()
	return time > 0 ? `stamp:${time}` : `path:${entry.path}`
}

export function folderKey(folder: string) {
	return `folder:${folder}`
}

/**
 * Sort one group (the folders, or the projects of one folder) by the user's order. Anything never
 * placed by hand comes first, in the default order, so a new transcription still shows up on top.
 */
export function sortGroup<T>(items: T[], keyOf: (item: T) => string, order: string[]): T[] {
	const rank = new Map(order.map((key, index) => [key, index]))
	const unranked = items.filter((item) => !rank.has(keyOf(item)))
	const ranked = items.filter((item) => rank.has(keyOf(item))).sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!)
	return [...unranked, ...ranked]
}

/**
 * Put `moving` into a group shown as `groupKeys`, next to `anchor` or at an end, and return the new
 * stored order. Ranks only compare within a group, so the group is rewritten at the end of the list
 * and every other group keeps its relative order.
 */
export function place(order: string[], groupKeys: string[], moving: string, anchor: string | null, placement: Placement): string[] {
	const sequence = groupKeys.filter((key) => key !== moving)
	const at = anchor === null ? -1 : sequence.indexOf(anchor)
	const index =
		placement === 'start' || (at < 0 && placement === 'before') ? 0 : placement === 'end' || at < 0 ? sequence.length : placement === 'before' ? at : at + 1
	sequence.splice(index, 0, moving)
	const placed = new Set(sequence)
	return [...order.filter((key) => !placed.has(key)), ...sequence]
}

/** Replace a key, for a renamed folder. */
export function renameKey(order: string[], from: string, to: string) {
	return order.map((key) => (key === from ? to : key))
}

/** The hand-made order of the sidebar; survives a reload, like the open folders. */
export function useRecentsOrder() {
	const [order, setOrder] = useState<string[]>(() => {
		try {
			const stored: unknown = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) ?? '[]')
			return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
		} catch {
			return []
		}
	})

	function update(next: string[]) {
		setOrder(next)
		try {
			window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next))
		} catch {
			/* private mode — the order still holds for this session */
		}
	}

	return { order, update }
}
