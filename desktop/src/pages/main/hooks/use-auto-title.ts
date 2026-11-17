import { useEffect, useMemo, useRef } from 'react'
import { m } from '~/paraglide/messages.js'
import { appLanguageName, createClient, inputBudgetBytes, utf8Bytes, type AiClient } from '~/lib/ai'
import { asText } from '~/lib/transcript'
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

/**
 * After a transcription made in this session finishes, and when an AI connection is set up for
 * summaries, ask the model for a short title and a one-line subtitle. The title replaces the name
 * Vibe made up (`File-…`, `Record-…`) only while the user has not touched it; opened projects and
 * names the user typed are never retitled.
 */
export function useAutoTitle(queue: TranscribeQueue) {
	const preference = usePreferenceProvider()
	const queueRef = useRef(queue)
	queueRef.current = queue
	const attempted = useRef<Set<string>>(new Set())

	const { connection, tasks } = preference.ai
	const enabled = tasks.summary.enabled
	const client = useMemo<AiClient>(() => createClient(connection), [connection])

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
				const budget = inputBudgetBytes(connection.contextTokens) - 2_000
				const text = job.segments.length ? asText(job.segments, m.speakerPrefix(), job.speakerNames) : (job.summary ?? '')
				// The opening of a long transcript says what it is about; the summary says it better when there is one.
				const source = utf8Bytes(text) <= budget ? text : (job.summary ?? text.slice(0, budget))
				const result = parseTitle(await client.ask(titlePrompt(source, appLanguageName())))
				if (!result) return
				const current = queueRef.current.jobs.find((candidate) => candidate.id === job.id)
				if (!current) return
				if (current.autoNamed && current.name === job.name) await queueRef.current.renameJob(job.id, result.title)
				if (result.subtitle) await queueRef.current.setJobSubtitle(job.id, result.subtitle)
			} catch (error) {
				console.warn('auto title failed:', error)
			}
		}
	}, [queue.jobs, enabled, client, connection.contextTokens])
}
