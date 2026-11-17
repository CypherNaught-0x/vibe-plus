// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { parseTitle, shouldAutoTitle } from './use-auto-title'

describe('parseTitle', () => {
	it('reads labelled lines', () => {
		expect(parseTitle('Title: Q4 budget review\nSubtitle: Finance walks through the cuts.')).toEqual({
			title: 'Q4 budget review',
			subtitle: 'Finance walks through the cuts.',
		})
	})

	it('strips markdown, quotes and a trailing period from the title', () => {
		expect(parseTitle('**Title:** "Sprint planning."\n**Subtitle:** The team sizes the next stories')).toEqual({
			title: 'Sprint planning',
			subtitle: 'The team sizes the next stories',
		})
	})

	it('falls back to the first two lines without labels', () => {
		expect(parseTitle('Hiring sync\nWho joins in January')).toEqual({ title: 'Hiring sync', subtitle: 'Who joins in January' })
	})

	it('gives up without a title, rather than promoting the subtitle', () => {
		expect(parseTitle('Subtitle: Only this')).toBeNull()
		expect(parseTitle('Subtitle: Covers hiring\nTitle: Hiring sync')).toEqual({ title: 'Hiring sync', subtitle: 'Covers hiring' })
		expect(parseTitle('')).toBeNull()
	})
})

describe('shouldAutoTitle', () => {
	const job = { status: 'done' as const, autoNamed: true, segments: [{ start: 0, stop: 1, text: 'hi' }], summary: undefined }

	it('needs a finished, auto-named job with text', () => {
		expect(shouldAutoTitle(job)).toBe(true)
		expect(shouldAutoTitle({ ...job, autoNamed: false })).toBe(false)
		expect(shouldAutoTitle({ ...job, status: 'running' })).toBe(false)
		expect(shouldAutoTitle({ ...job, segments: [] })).toBe(false)
		expect(shouldAutoTitle({ ...job, segments: [], summary: 'Sum' })).toBe(true)
	})
})
