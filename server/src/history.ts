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

/**
 * Append many metadata records at once (history sync). Grouped into ONE write per day
 * file — a full sync can carry tens of thousands of messages, and firing one
 * appendFile per message concurrently would exhaust file handles.
 */
export const appendHistoryBatch = async (sessionId: string, entries: HistoryEntry[]): Promise<void> => {
	if (!config.history.enabled || entries.length === 0) {
		return
	}

	const byDay = new Map<string, string[]>()
	for (const entry of entries) {
		const name = dayFileName(new Date(entry.t))
		const lines = byDay.get(name) ?? []
		lines.push(JSON.stringify(entry))
		byDay.set(name, lines)
	}

	try {
		const dir = historyDir(sessionId)
		await mkdir(dir, { recursive: true })
		for (const [name, lines] of byDay) {
			await appendFile(join(dir, name), lines.join('\n') + '\n')
		}
	} catch (error) {
		logger.warn({ session: sessionId, err: (error as Error).message }, 'history batch append failed')
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

/**
 * Oldest known message (with an id) in any of the given chat JIDs. WhatsApp's
 * on-demand history fetch must be anchored on a message the device already has, so
 * this is the default anchor when the caller does not supply one. Day files are
 * scanned oldest first; within the first matching day the earliest entry wins.
 */
export const oldestForChat = async (sessionId: string, jids: string[]): Promise<HistoryEntry | undefined> => {
	const wanted = new Set(jids.filter(Boolean))
	if (wanted.size === 0) {
		return undefined
	}

	const dir = historyDir(sessionId)
	let files: string[]
	try {
		files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort()
	} catch {
		return undefined
	}

	for (const file of files) {
		let best: HistoryEntry | undefined
		try {
			const lines = (await readFile(join(dir, file), 'utf-8')).split('\n').filter(Boolean)
			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as HistoryEntry
					if (entry.id && wanted.has(entry.chat) && (!best || entry.t < best.t)) {
						best = entry
					}
				} catch {
					// skip malformed line
				}
			}
		} catch {
			continue
		}

		if (best) {
			return best
		}
	}

	return undefined
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
