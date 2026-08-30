import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Boom } from '@hapi/boom'
import { config } from './config.js'
import { logger } from './logger.js'

interface AppRecord {
	id: string
	name: string
	keyPrefix: string
	keyHash: string
	createdAt: string
	lastUsedAt?: string
	lastIp?: string
	requests: number
	enabled: boolean
}

/** Public, safe-to-expose view of a managed app (never includes the raw key or its hash). */
export interface AppView {
	id: string
	name: string
	keyPrefix: string
	createdAt: string
	lastUsedAt?: string
	lastIp?: string
	requests: number
	enabled: boolean
}

const KEY_PREFIX = 'bk_'
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const toView = (record: AppRecord): AppView => ({
	id: record.id,
	name: record.name,
	keyPrefix: `${record.keyPrefix}…`,
	createdAt: record.createdAt,
	lastUsedAt: record.lastUsedAt,
	lastIp: record.lastIp,
	requests: record.requests,
	enabled: record.enabled
})

/**
 * Runtime store of API clients ("apps"), persisted to <dataDir>/apps.json.
 * Raw keys are never stored — only a SHA-256 hash plus a short prefix for display.
 * The plaintext key is returned exactly once, at creation time.
 */
class AppStore {
	private records: AppRecord[] = []
	private readonly file = join(config.dataDir, 'apps.json')
	private dirty = false
	private flushTimer?: NodeJS.Timeout

	async init(): Promise<void> {
		try {
			this.records = JSON.parse(await readFile(this.file, 'utf-8'))
		} catch {
			this.records = []
		}

		// Persist usage counters periodically instead of on every request.
		this.flushTimer = setInterval(() => void this.flush(), 30_000)
		this.flushTimer.unref?.()
		logger.info({ count: this.records.length }, 'api apps loaded')
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true })
		await writeFile(this.file, JSON.stringify(this.records, null, 2))
		this.dirty = false
	}

	private async flush(): Promise<void> {
		if (this.dirty) {
			await this.persist().catch(err => logger.warn({ err: err.message }, 'apps flush failed'))
		}
	}

	list(): AppView[] {
		return this.records.map(toView)
	}

	async create(name: string): Promise<{ app: AppView; key: string }> {
		const key = KEY_PREFIX + randomBytes(24).toString('hex')
		const record: AppRecord = {
			id: randomUUID(),
			name: name.trim() || 'App',
			keyPrefix: key.slice(0, 10),
			keyHash: sha256(key),
			createdAt: new Date().toISOString(),
			requests: 0,
			enabled: true
		}
		this.records.push(record)
		await this.persist()
		return { app: toView(record), key }
	}

	async update(id: string, patch: { name?: string; enabled?: boolean }): Promise<AppView> {
		const record = this.records.find(r => r.id === id)
		if (!record) {
			throw new Boom('App not found', { statusCode: 404 })
		}

		if (typeof patch.name === 'string' && patch.name.trim()) {
			record.name = patch.name.trim()
		}

		if (typeof patch.enabled === 'boolean') {
			record.enabled = patch.enabled
		}

		await this.persist()
		return toView(record)
	}

	async revoke(id: string): Promise<void> {
		const before = this.records.length
		this.records = this.records.filter(r => r.id !== id)
		if (this.records.length === before) {
			throw new Boom('App not found', { statusCode: 404 })
		}

		await this.persist()
	}

	/** Verify a raw key against the store; records usage on match. Returns the app id, or undefined. */
	verify(key: string, ip?: string): string | undefined {
		if (!key.startsWith(KEY_PREFIX)) {
			return undefined
		}

		const hash = Buffer.from(sha256(key))
		for (const record of this.records) {
			if (!record.enabled) {
				continue
			}

			const stored = Buffer.from(record.keyHash)
			if (stored.length === hash.length && timingSafeEqual(stored, hash)) {
				record.requests++
				record.lastUsedAt = new Date().toISOString()
				record.lastIp = ip
				this.dirty = true
				return record.id
			}
		}

		return undefined
	}
}

export const appStore = new AppStore()
