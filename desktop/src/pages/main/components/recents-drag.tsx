import { Folder } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '~/lib/style'
import type { TranscriptEntry } from '~/lib/transcripts-store'
import type { RecentsItem } from './recents-sidebar'

export type DragSource = { kind: 'entry'; entry: TranscriptEntry } | { kind: 'folder'; folder: string }

export type DropTarget =
	| { kind: 'entry'; entry: TranscriptEntry; placement: 'before' | 'after' }
	| { kind: 'folder'; folder: string; placement: 'before' | 'after' | 'into' }
	/** The empty space under the list: the top level, at its end. */
	| { kind: 'root' }

/** Pixels the pointer moves before a press becomes a drag, so clicks still open projects. */
const DRAG_THRESHOLD = 5
const EDGE = 36
const SCROLL_STEP = 10

/** What a drop on this row would mean for this source, or null where it cannot land. */
export function dropTargetFor(source: DragSource, item: RecentsItem | null, upperHalf: boolean): DropTarget | null {
	if (item === null) return source.kind === 'entry' ? { kind: 'root' } : null
	if (source.kind === 'entry') {
		if (item.kind === 'folder') return { kind: 'folder', folder: item.folder, placement: 'into' }
		if (item.kind === 'entry' && item.entry.path !== source.entry.path)
			return { kind: 'entry', entry: item.entry, placement: upperHalf ? 'before' : 'after' }
		return null
	}
	if (item.kind === 'folder' && item.folder !== source.folder) return { kind: 'folder', folder: item.folder, placement: upperHalf ? 'before' : 'after' }
	return null
}

interface Hover {
	index: number
	placement: 'before' | 'after' | 'into' | 'root'
}

/**
 * Drag rows of the recents list with the pointer: reorder projects and folders, file a project into
 * a folder. Pointer events rather than HTML drag and drop, which the window's own file-drop handling
 * switches off on some platforms. Rows are found under the pointer by `data-recents-index`; the list
 * itself is `-1`, the space under the last row.
 */
export function useRecentsDrag(items: RecentsItem[], scrollRef: RefObject<HTMLDivElement | null>, onDrop: (source: DragSource, target: DropTarget) => void) {
	const latest = useRef({ items, onDrop })
	latest.current = { items, onDrop }
	const [source, setSource] = useState<DragSource | null>(null)
	const [hover, setHover] = useState<Hover | null>(null)
	const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
	const cleanup = useRef<(() => void) | null>(null)

	useEffect(() => () => cleanup.current?.(), [])

	const start = useCallback(
		(event: React.PointerEvent, item: RecentsItem) => {
			if (event.button !== 0 || item.kind === 'new-folder') return
			// The "…" menu opens on press, and inputs need their own pointer.
			if ((event.target as HTMLElement).closest('[aria-haspopup], input, [role="menuitem"]')) return
			const dragged: DragSource = item.kind === 'entry' ? { kind: 'entry', entry: item.entry } : { kind: 'folder', folder: item.folder }
			const origin = { x: event.clientX, y: event.clientY }
			let active = false
			let last = origin
			let target: DropTarget | null = null
			let frame = 0

			function hitTest() {
				const element = document.elementFromPoint(last.x, last.y)?.closest<HTMLElement>('[data-recents-index]')
				if (!element || !scrollRef.current?.contains(element)) {
					target = null
					setHover(null)
					return
				}
				const index = Number(element.dataset.recentsIndex)
				const row = index >= 0 ? (latest.current.items[index] ?? null) : null
				const rect = element.getBoundingClientRect()
				target = dropTargetFor(dragged, row, last.y < rect.top + rect.height / 2)
				setHover(target ? { index, placement: target.kind === 'root' ? 'root' : target.placement } : null)
			}

			// Holding the pointer near an edge keeps scrolling, so long lists can be crossed.
			function scrollLoop() {
				const list = scrollRef.current
				if (list) {
					const bounds = list.getBoundingClientRect()
					const step = last.y < bounds.top + EDGE ? -SCROLL_STEP : last.y > bounds.bottom - EDGE ? SCROLL_STEP : 0
					if (step) {
						list.scrollTop += step
						hitTest()
					}
				}
				frame = requestAnimationFrame(scrollLoop)
			}

			function move(moveEvent: PointerEvent) {
				last = { x: moveEvent.clientX, y: moveEvent.clientY }
				if (!active) {
					if (Math.hypot(last.x - origin.x, last.y - origin.y) < DRAG_THRESHOLD) return
					active = true
					document.body.style.userSelect = 'none'
					setSource(dragged)
					frame = requestAnimationFrame(scrollLoop)
				}
				setPointer(last)
				hitTest()
			}

			function finish(drop: boolean) {
				window.removeEventListener('pointermove', move)
				window.removeEventListener('pointerup', up)
				window.removeEventListener('keydown', key)
				cancelAnimationFrame(frame)
				cleanup.current = null
				if (!active) return
				document.body.style.userSelect = ''
				// The release lands on a row's button; that click must not open the project.
				const swallow = (clickEvent: MouseEvent) => {
					clickEvent.stopPropagation()
					clickEvent.preventDefault()
				}
				window.addEventListener('click', swallow, { capture: true, once: true })
				setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
				setSource(null)
				setHover(null)
				setPointer(null)
				if (drop && target) latest.current.onDrop(dragged, target)
			}
			function up() {
				finish(true)
			}
			function key(keyEvent: KeyboardEvent) {
				if (keyEvent.key === 'Escape') finish(false)
			}

			cleanup.current?.()
			cleanup.current = () => finish(false)
			window.addEventListener('pointermove', move)
			window.addEventListener('pointerup', up)
			window.addEventListener('keydown', key)
		},
		[scrollRef],
	)

	return { source, hover, pointer, start }
}

export type RecentsDrag = ReturnType<typeof useRecentsDrag>

/** One row of the list as a drag handle and drop target, with the line or ring that shows where a drop lands. */
export function DragRow({ drag, item, index, children }: { drag: RecentsDrag; item: RecentsItem; index: number; children: ReactNode }) {
	const hover = drag.hover?.index === index ? drag.hover.placement : null
	const dragging =
		(drag.source?.kind === 'entry' && item.kind === 'entry' && drag.source.entry.path === item.entry.path) ||
		(drag.source?.kind === 'folder' && item.kind === 'folder' && drag.source.folder === item.folder)
	return (
		<div data-recents-index={index} onPointerDown={(event) => drag.start(event, item)} className={cn('relative', dragging && 'opacity-40')}>
			{children}
			{hover === 'into' && <span className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-primary/70" />}
			{(hover === 'before' || hover === 'after') && (
				<span className={cn('pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary', hover === 'before' ? '-top-px' : '-bottom-px')} />
			)}
		</div>
	)
}

/** The label that follows the pointer while a row is dragged. */
export function DragGhost({ drag }: { drag: RecentsDrag }) {
	if (!drag.source || !drag.pointer) return null
	const label = drag.source.kind === 'entry' ? drag.source.entry.name : drag.source.folder
	return (
		<div
			className="pointer-events-none fixed z-50 flex max-w-60 items-center gap-1.5 truncate rounded-lg border border-border bg-popover px-2.5 py-1 text-[12px] font-medium text-foreground shadow-lg"
			style={{ left: drag.pointer.x + 12, top: drag.pointer.y + 8 }}>
			{drag.source.kind === 'folder' && <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
			<span className="truncate">{label}</span>
		</div>
	)
}
