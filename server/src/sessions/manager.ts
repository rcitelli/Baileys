import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Boom } from '@hapi/boom'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { ALL_WEBHOOK_EVENTS, type CreateSessionInput, type SessionMeta, type WebhookEvent } from '../types.js'
import { Session, type SessionPaths } from './session.js'

const META_FILE = 'meta.json'
const AUTH_DIR = 'auth'
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

const pathsFor = (id: string): SessionPaths => {
	const root = join(config.dataDir, id)
	return { root, authDir: join(root, AUTH_DIR), metaFile: join(root, META_FILE) }
}

/**
 * Owns the full set of Session objects, persists their metadata, and re-hydrates
 * everything from disk on boot so a server restart transparently resumes sessions.
 * Emits 'update' (bubbled from any session) so the SSE layer can broadcast changes.
 */
export class SessionManager extends EventEmitter {
	private readonly sessions = new Map<string, Session>()

	async init(): Promise<void> {
		await mkdir(config.dataDir, { recursive: true })

		let entries: string[] = []
		try {
			entries = (await readdir(config.dataDir, { withFileTypes: true }))
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name)
		} catch (error) {
			logger.error({ err: (error as Error).message }, 'failed to scan data dir')
		}

		for (const id of entries) {
			try {
				const meta = await this.readMeta(id)
				if (!meta) {
					continue
				}

				const session = this.instantiate(meta)
				if (config.session.autostart) {
					void session.start()
				}
			} catch (error) {
				logger.error({ session: id, err: (error as Error).message }, 'failed to restore session')
			}
		}

		logger.info({ count: this.sessions.size }, 'sessions restored from disk')
	}

	private async readMeta(id: string): Promise<SessionMeta | undefined> {
		try {
			const raw = await readFile(pathsFor(id).metaFile, 'utf-8')
			return JSON.parse(raw) as SessionMeta
		} catch {
			return undefined
		}
	}

	private async writeMeta(meta: SessionMeta): Promise<void> {
		const { root, metaFile } = pathsFor(meta.id)
		await mkdir(root, { recursive: true })
		await writeFile(metaFile, JSON.stringify(meta, null, 2))
	}

	private instantiate(meta: SessionMeta): Session {
		const session = new Session(meta, pathsFor(meta.id))
		session.on('update', () => {
			void this.persist(session).catch(() => undefined)
			this.emit('update', session.id)
		})
		this.sessions.set(meta.id, session)
		return session
	}

	private async persist(session: Session): Promise<void> {
		await this.writeMeta(session.getMeta())
	}

	list(): Session[] {
		return [...this.sessions.values()]
	}

	get(id: string): Session {
		const session = this.sessions.get(id)
		if (!session) {
			throw new Boom(`Session '${id}' not found`, { statusCode: 404 })
		}

		return session
	}

	has(id: string): boolean {
		return this.sessions.has(id)
	}

	private normalizeEvents(events?: WebhookEvent[]): WebhookEvent[] {
		if (!events || events.length === 0) {
			return ['connection.update', 'messages.upsert']
		}

		return events.filter(event => ALL_WEBHOOK_EVENTS.includes(event))
	}

	async create(input: CreateSessionInput): Promise<Session> {
		const id = input.id?.trim() || `session-${Date.now().toString(36)}`
		if (!ID_PATTERN.test(id)) {
			throw new Boom('Invalid session id — use letters, numbers, - and _ (max 64 chars)', {
				statusCode: 400
			})
		}

		if (this.sessions.has(id)) {
			throw new Boom(`Session '${id}' already exists`, { statusCode: 409 })
		}

		const now = new Date().toISOString()
		const meta: SessionMeta = {
			id,
			name: input.name?.trim() || id,
			webhookUrl: input.webhookUrl?.trim() || undefined,
			webhookEvents: this.normalizeEvents(input.webhookEvents),
			createdAt: now,
			updatedAt: now
		}

		await this.writeMeta(meta)
		const session = this.instantiate(meta)
		await session.start()
		return session
	}

	async update(
		id: string,
		patch: Partial<Pick<SessionMeta, 'name' | 'webhookUrl' | 'webhookEvents'>>
	): Promise<Session> {
		const session = this.get(id)
		const next = { ...patch }
		if (next.webhookEvents) {
			next.webhookEvents = this.normalizeEvents(next.webhookEvents)
		}

		session.updateMeta(next)
		await this.persist(session)
		return session
	}

	async restart(id: string): Promise<Session> {
		const session = this.get(id)
		await session.stop()
		await session.start()
		return session
	}

	async logout(id: string): Promise<void> {
		await this.get(id).logout()
	}

	/** Log out (best-effort), stop the socket, and delete all on-disk data for the session. */
	async delete(id: string): Promise<void> {
		const session = this.get(id)
		await session.logout().catch(() => undefined)
		await session.stop().catch(() => undefined)
		this.sessions.delete(id)

		try {
			await rm(pathsFor(id).root, { recursive: true, force: true })
		} catch (error) {
			logger.warn({ session: id, err: (error as Error).message }, 'failed to remove session files')
		}
	}

	async shutdown(): Promise<void> {
		await Promise.all(this.list().map(session => session.stop().catch(() => undefined)))
	}
}
