import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { m } from '~/paraglide/messages.js'
import { appLanguageName, createClient, inputBudgetBytes, utf8Bytes, type AiClient } from '~/lib/ai'
import { asText, type Segment, type SpeakerNames } from '~/lib/transcript'
import { notifyTranscriptsChanged, readTranscript, renameTranscript, updateTranscriptSubtitle } from '~/lib/transcripts-store'
import { usePreferenceProvider } from '~/providers/preference'
import type { Job, TranscribeQueue } from './use-transcribe-queue'

const MAX_TITLE = 80
const MAX_SUBTITLE = 200
const titleLabel = /^[^a-z]*title[^a-z:]*:\s*/i
const subtitleLabel = /^[^a-z]*subtitle[^a-z:]*:\s*/i

export interface AiTitle {
	title: string
	subtitle: string
}

/** A finished transcript that still carries its made-up name and has text to read. */
export function shouldAutoTitle(job: Pick<Job, 'status' | 'autoNamed' | 'segments' | 'summary'>) {
	return job.status === 'done' && Boolean(job.autoNamed) && (job.segments.length > 0 || Boolean(job.summary))
}

export function titlePrompt(transcript: string, language: string) {
	return [
		`Write a title and a subtitle for this transcript in ${language}.`,
		'Title: at most 6 words naming the topic. No date, no quotes, no trailing period.',
		'Subtitle: one sentence of at most 15 words saying what it covers.',
		'Reply with exactly two lines and nothing else:',
		'Title: <title>',
		'Subtitle: <subtitle>',
		`Transcript:\n"""\n${transcript}\n"""`,
	].join('\n')
}

function clean(value: string, max: number) {
	const text = value
		.replace(/[*_#`]/g, '')
		.replace(/^["'“”„«»\s]+|["'“”„«»\s]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Read the model's two lines; tolerates markdown, quotes and a missing "Title:" label. */
export function parseTitle(reply: string): AiTitle | null {
	const lines = reply
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
	const labelled = (label: RegExp) => lines.find((line) => label.test(line))?.replace(label, '')
	const unlabelled = lines.filter((line) => !titleLabel.test(line) && !subtitleLabel.test(line))
	const title = clean(labelled(titleLabel) ?? unlabelled.shift() ?? '', MAX_TITLE).replace(/\.$/, '')
	const subtitle = clean(labelled(subtitleLabel) ?? unlabelled[0] ?? '', MAX_SUBTITLE)
	return title ? { title, subtitle } : null
}

export interface Titles {
	/** An AI connection is set up for summaries, so titles can be written. */
	enabled: boolean
	/** Saved project paths whose title is being rewritten on request. */
	pending: Record<string, boolean>
	/** Write a fresh title and subtitle for a saved project, replacing whatever name it has. */
	regenerate: (path: string) => Promise<boolean>
}

/**
 * After a transcription made in this session finishes, and when an AI connection is set up for
 * summaries, ask the model for a short title and a one-line subtitle. The title replaces the name
 * Vibe made up (`File-…`, `Record-…`) only while the user has not touched it; opened projects and
 * names the user typed are never retitled automatically, only through `regenerate`.
 */
export function useAutoTitle(queue: TranscribeQueue): Titles {
	const preference = usePreferenceProvider()
	const queueRef = useRef(queue)
	queueRef.current = queue
	const attempted = useRef<Set<string>>(new Set())
	const [pending, setPending] = useState<Record<string, boolean>>({})

	const { connection, tasks } = preference.ai
	const enabled = tasks.summary.enabled
	const client = useMemo<AiClient>(() => createClient(connection), [connection])

	/** Ask for a title; the opening of a long transcript says what it is about, the summary says it better. */
	const generate = useCallback(
		async (text: string, summary?: string) => {
			const budget = inputBudgetBytes(connection.contextTokens) - 2_000
			const source = utf8Bytes(text) <= budget ? text : (summary ?? text.slice(0, budget))
			if (!source.trim()) return null
			return parseTitle(await client.ask(titlePrompt(source, appLanguageName())))
		},
		[client, connection.contextTokens],
	)

	useEffect(() => {
		for (const job of queue.jobs) {
			if (!shouldAutoTitle(job) || attempted.current.has(job.id)) continue
			attempted.current.add(job.id)
			// Switching AI on later must not sweep over work that finished while it was off.
			if (!enabled) continue
			void retitle(job)
		}

		async function retitle(job: Job) {
			try {
				const result = await generate(textOf(job.segments, job.speakerNames, job.summary), job.summary)
				if (!result) return
				const current = queueRef.current.jobs.find((candidate) => candidate.id === job.id)
				if (!current) return
				if (current.autoNamed && current.name === job.name) await queueRef.current.renameJob(job.id, result.title)
				if (result.subtitle) await queueRef.current.setJobSubtitle(job.id, result.subtitle)
			} catch (error) {
				console.warn('auto title failed:', error)
			}
		}
	}, [queue.jobs, enabled, generate])

	const regenerate = useCallback(
		async (path: string) => {
			if (!enabled || pending[path]) return false
			setPending((previous) => ({ ...previous, [path]: true }))
			try {
				// A project open in the session goes through its job, so the view and the file agree.
				const job = queueRef.current.jobs.find((candidate) => candidate.savedPath === path)
				const record = job ? null : await readTranscript(path)
				if (!job && !record) throw new Error('Failed to read the transcript')
				const source = job ?? record!
				const result = await generate(textOf(source.segments, source.speakerNames, source.summary), source.summary)
				if (!result) throw new Error('The model returned no title')
				if (job) {
					if (!(await queueRef.current.renameJob(job.id, result.title))) throw new Error('Failed to rename the transcript')
					if (result.subtitle) await queueRef.current.setJobSubtitle(job.id, result.subtitle)
				} else {
					const renamed = await renameTranscript(path, result.title)
					if (!renamed) throw new Error('Failed to rename the transcript')
					if (result.subtitle) await updateTranscriptSubtitle(renamed.path, result.subtitle)
					notifyTranscriptsChanged()
				}
				return true
			} catch (error) {
				console.error('regenerate title failed:', error)
				toast.error(m.regenerateTitleFailed(), { description: String(error instanceof Error ? error.message : error), position: 'bottom-center' })
				return false
			} finally {
				setPending((previous) => {
					const next = { ...previous }
					delete next[path]
					return next
				})
			}
		},
		[enabled, pending, generate],
	)

	return { enabled, pending, regenerate }
}

function textOf(segments: Segment[], speakerNames: SpeakerNames | undefined, summary: string | undefined) {
	return segments.length ? asText(segments, m.speakerPrefix(), speakerNames) : (summary ?? '')
}
