import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'

/**
 * A single interaction record. Deliberately METADATA-ONLY — no message text or media.
 * Full content reaches your apps via webhooks; each app decides whether to persist it.
 */
export interface HistoryEntry {
	/** epoch milliseconds */
	t: number
	/** 'in' received, 'out' sent */
	dir: 'in' | 'out'
	/** chat/remote JID */
	chat: string
	/** message content type (e.g. conversation, imageMessage) */
	type: string
	/** message id */
	id?: string
	/** last known delivery/read status, when available */
	status?: string
}

const historyDir = (sessionId: string): string => join(config.dataDir, sessionId, 'history')
const dayFileName = (d: Date): string => `${d.toISOString().slice(0, 10)}.jsonl`

/** Append one metadata record for a session (no-op if history is disabled). */
export const appendHistory = async (sessionId: string, entry: HistoryEntry): Promise<void> => {
	if (!config.history.enabled) {
		return
	}

	try {
		const dir = historyDir(sessionId)
		await mkdir(dir, { recursive: true })
		await appendFile(join(dir, dayFileName(new Date(entry.t))), JSON.stringify(entry) + '\n')
	} catch (error) {
		logger.warn({ session: sessionId, err: (error as Error).message }, 'history append failed')
	}
}

/** Return the most recent metadata records for a session, newest first. */
export const queryHistory = async (sessionId: string, limit = 100): Promise<HistoryEntry[]> => {
	const dir = historyDir(sessionId)
	let files: string[]
	try {
		files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().reverse()
	} catch {
		return []
	}

	const out: HistoryEntry[] = []
	for (const file of files) {
		if (out.length >= limit) {
			break
		}

		try {
			const lines = (await readFile(join(dir, file), 'utf-8')).split('\n').filter(Boolean)
			for (let i = lines.length - 1; i >= 0; i--) {
				try {
					out.push(JSON.parse(lines[i]!) as HistoryEntry)
				} catch {
					// skip malformed line
				}

				if (out.length >= limit) {
					break
				}
			}
		} catch {
			// skip unreadable file
		}
	}

	return out.sort((a, b) => b.t - a.t).slice(0, limit)
}

/** Delete metadata files older than the retention window, across all sessions. */
export const cleanupHistory = async (): Promise<void> => {
	if (!config.history.enabled) {
		return
	}

	const cutoff = new Date(Date.now() - config.history.retentionDays * 86400_000)
	const cutoffName = dayFileName(cutoff)

	let sessions: string[]
	try {
		sessions = (await readdir(config.dataDir, { withFileTypes: true }))
			.filter(e => e.isDirectory())
			.map(e => e.name)
	} catch {
		return
	}

	for (const sessionId of sessions) {
		const dir = historyDir(sessionId)
		let files: string[]
		try {
			files = await readdir(dir)
		} catch {
			continue
		}

		for (const file of files) {
			// Filenames are YYYY-MM-DD.jsonl, so lexical comparison equals chronological.
			if (file.endsWith('.jsonl') && file < cutoffName) {
				await unlink(join(dir, file)).catch(() => undefined)
			}
		}
	}
}

let cleanupTimer: NodeJS.Timeout | undefined

/** Start the daily retention cleanup (runs once now, then every 24h). */
export const startHistoryCleanup = (): void => {
	if (!config.history.enabled || cleanupTimer) {
		return
	}

	void cleanupHistory()
	cleanupTimer = setInterval(() => void cleanupHistory(), 24 * 60 * 60 * 1000)
	cleanupTimer.unref?.()
}
