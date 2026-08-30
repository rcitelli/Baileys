import { EventEmitter } from 'node:events'
import { Boom } from '@hapi/boom'
import makeWASocket, {
	type AnyMessageContent,
	Browsers,
	type ConnectionState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	getContentType,
	jidNormalizedUser,
	makeCacheableSignalKeyStore,
	type MiscMessageGenerationOptions,
	useMultiFileAuthState,
	type WAMessageKey,
	type WASocket
} from '../wa.js'
import QRCode from 'qrcode'
import { config } from '../config.js'
import { appendHistory, queryHistory } from '../history.js'
import { logger } from '../logger.js'
import type { SessionInfo, SessionMeta, SessionStatus, WebhookEvent } from '../types.js'
import { dispatchWebhook } from '../webhooks/dispatcher.js'

interface ContactLite {
	id: string
	name?: string
	notify?: string
}
interface ChatLite {
	id: string
	name?: string
	unread?: number
	ts?: number
}

const RECONNECT_DELAY_MS = 3000

export interface SessionPaths {
	root: string
	authDir: string
	metaFile: string
}

/**
 * Wraps a single Baileys socket: owns its auth state, connection lifecycle,
 * QR capture, webhook fan-out, and message sending for one WhatsApp account.
 * Emits 'update' whenever its public status/QR changes (used by the SSE stream).
 */
export class Session extends EventEmitter {
	readonly id: string
	private meta: SessionMeta
	private readonly paths: SessionPaths
	private sock?: WASocket
	private saveCreds?: () => Promise<void>

	private status: SessionStatus = 'idle'
	private qrString?: string
	private qrDataUrl?: string
	private jid?: string
	private pushName?: string
	private lastConnectedAt?: string
	private lastDisconnectReason?: string

	private starting = false
	private stopped = false
	private reconnectTimer?: NodeJS.Timeout

	// Live, in-memory only (not persisted) — cleared on restart. Matches "live, on-demand".
	private readonly contacts = new Map<string, ContactLite>()
	private readonly chats = new Map<string, ChatLite>()

	constructor(meta: SessionMeta, paths: SessionPaths) {
		super()
		this.id = meta.id
		this.meta = meta
		this.paths = paths
	}

	getMeta(): SessionMeta {
		return { ...this.meta }
	}

	updateMeta(patch: Partial<Pick<SessionMeta, 'name' | 'webhookUrl' | 'webhookEvents'>>): SessionMeta {
		this.meta = { ...this.meta, ...patch, updatedAt: new Date().toISOString() }
		this.emit('update')
		return this.getMeta()
	}

	getInfo(): SessionInfo {
		return {
			...this.meta,
			status: this.status,
			jid: this.jid,
			pushName: this.pushName,
			phoneNumber: this.jid ? this.jid.split('@')[0]?.split(':')[0] : undefined,
			hasQr: Boolean(this.qrString) && this.status === 'qr',
			lastConnectedAt: this.lastConnectedAt,
			lastDisconnectReason: this.lastDisconnectReason
		}
	}

	getQr(): { status: SessionStatus; qr?: string; qrImage?: string } {
		return { status: this.status, qr: this.qrString, qrImage: this.qrDataUrl }
	}

	isOpen(): boolean {
		return this.status === 'open'
	}

	private setStatus(status: SessionStatus) {
		if (this.status !== status) {
			this.status = status
			logger.info({ session: this.id, status }, 'session status changed')
			this.emit('update')
		}
	}

	/** Boot (or reboot) the underlying socket. Safe to call repeatedly. */
	async start(): Promise<void> {
		if (this.starting || this.status === 'open') {
			return
		}

		this.starting = true
		this.stopped = false

		try {
			const { state, saveCreds } = await useMultiFileAuthState(this.paths.authDir)
			this.saveCreds = saveCreds

			const { version } = await fetchLatestBaileysVersion()

			this.setStatus('connecting')

			const sock = makeWASocket({
				version,
				logger: logger.child({ session: this.id }),
				browser: Browsers.ubuntu('Chrome'),
				markOnlineOnConnect: config.session.markOnlineOnConnect,
				auth: {
					creds: state.creds,
					keys: makeCacheableSignalKeyStore(state.keys, logger.child({ session: this.id }))
				},
				generateHighQualityLinkPreview: true
			})

			this.sock = sock
			this.bindEvents(sock)
		} catch (error) {
			logger.error({ session: this.id, err: (error as Error).message }, 'failed to start session')
			this.setStatus('close')
			this.scheduleReconnect()
		} finally {
			this.starting = false
		}
	}

	private bindEvents(sock: WASocket) {
		sock.ev.process(async events => {
			if (events['creds.update']) {
				await this.saveCreds?.()
				this.forward('creds.update', {})
			}

			const update = events['connection.update']
			if (update) {
				await this.onConnectionUpdate(update)
			}

			this.capture(events)

			for (const key of Object.keys(events) as (keyof typeof events)[]) {
				if (key === 'creds.update' || key === 'connection.update') {
					continue
				}

				this.forward(key as WebhookEvent, events[key])
			}
		})
	}

	/** Extract metadata-only history + maintain live contact/chat maps from events. */
	private capture(events: Record<string, unknown>) {
		try {
			const upserts = events['messages.upsert'] as { messages?: unknown[] } | undefined
			if (upserts?.messages) {
				for (const raw of upserts.messages) {
					const m = raw as {
						key?: { id?: string; remoteJid?: string; fromMe?: boolean }
						message?: Record<string, unknown>
						messageTimestamp?: number | { toNumber?: () => number }
						status?: number
					}
					if (!m.key?.remoteJid) {
						continue
					}

					const rawTs = m.messageTimestamp
					const ts =
						typeof rawTs === 'number' ? rawTs : (rawTs?.toNumber?.() ?? Math.floor(Date.now() / 1000))
					void appendHistory(this.id, {
						t: ts * 1000,
						dir: m.key.fromMe ? 'out' : 'in',
						chat: m.key.remoteJid,
						type: m.message ? (getContentType(m.message as never) ?? 'unknown') : 'unknown',
						id: m.key.id,
						status: typeof m.status === 'number' ? String(m.status) : undefined
					})

					const chat = this.chats.get(m.key.remoteJid) ?? { id: m.key.remoteJid }
					chat.ts = ts
					this.chats.set(m.key.remoteJid, chat)
				}
			}

			const contacts = [
				...((events['contacts.upsert'] as unknown[]) ?? []),
				...((events['contacts.update'] as unknown[]) ?? [])
			] as Array<{ id?: string; name?: string; notify?: string }>
			for (const c of contacts) {
				if (c.id) {
					const prev = this.contacts.get(c.id) ?? { id: c.id }
					this.contacts.set(c.id, { id: c.id, name: c.name ?? prev.name, notify: c.notify ?? prev.notify })
				}
			}

			const chats = [
				...((events['chats.upsert'] as unknown[]) ?? []),
				...((events['chats.update'] as unknown[]) ?? [])
			] as Array<{ id?: string; name?: string; unreadCount?: number; conversationTimestamp?: number }>
			for (const c of chats) {
				if (c.id) {
					const prev = this.chats.get(c.id) ?? { id: c.id }
					this.chats.set(c.id, {
						id: c.id,
						name: c.name ?? prev.name,
						unread: c.unreadCount ?? prev.unread,
						ts: c.conversationTimestamp ?? prev.ts
					})
				}
			}

			const histSet = events['messaging-history.set'] as
				| { contacts?: Array<{ id?: string; name?: string; notify?: string }>; chats?: Array<{ id?: string; name?: string; conversationTimestamp?: number }> }
				| undefined
			if (histSet) {
				for (const c of histSet.contacts ?? []) {
					if (c.id) {
						this.contacts.set(c.id, { id: c.id, name: c.name, notify: c.notify })
					}
				}
				for (const c of histSet.chats ?? []) {
					if (c.id) {
						const prev = this.chats.get(c.id) ?? { id: c.id }
						this.chats.set(c.id, { id: c.id, name: c.name ?? prev.name, ts: c.conversationTimestamp ?? prev.ts })
					}
				}
			}
		} catch (error) {
			logger.warn({ session: this.id, err: (error as Error).message }, 'event capture failed')
		}
	}

	getContacts(): ContactLite[] {
		return [...this.contacts.values()].sort((a, b) => (a.name ?? a.notify ?? a.id).localeCompare(b.name ?? b.notify ?? b.id))
	}

	getChats(): ChatLite[] {
		return [...this.chats.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
	}

	async getHistory(limit = 100) {
		return queryHistory(this.id, limit)
	}

	private async onConnectionUpdate(update: Partial<ConnectionState>) {
		const { connection, lastDisconnect, qr } = update

		if (qr) {
			this.qrString = qr
			try {
				this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, scale: 6 })
			} catch {
				this.qrDataUrl = undefined
			}

			this.setStatus('qr')
		}

		if (connection === 'connecting') {
			this.setStatus('connecting')
		}

		if (connection === 'open') {
			this.qrString = undefined
			this.qrDataUrl = undefined
			this.jid = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : undefined
			this.pushName = this.sock?.user?.name
			this.lastConnectedAt = new Date().toISOString()
			this.lastDisconnectReason = undefined
			this.setStatus('open')
		}

		if (connection === 'close') {
			const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
			this.lastDisconnectReason = lastDisconnect?.error?.message ?? String(statusCode ?? 'unknown')

			if (statusCode === DisconnectReason.loggedOut) {
				this.setStatus('logged_out')
				logger.warn({ session: this.id }, 'session logged out from phone')
			} else {
				this.setStatus('close')
				this.scheduleReconnect()
			}
		}

		this.forward('connection.update', {
			connection,
			statusCode: (lastDisconnect?.error as Boom | undefined)?.output?.statusCode,
			reason: this.lastDisconnectReason,
			status: this.status
		})
	}

	private scheduleReconnect() {
		if (this.stopped || this.reconnectTimer) {
			return
		}

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined
			void this.start()
		}, RECONNECT_DELAY_MS)
	}

	private forward(event: WebhookEvent, data: unknown) {
		const { webhookUrl, webhookEvents } = this.meta
		if (!webhookUrl || !webhookEvents.includes(event)) {
			return
		}

		void dispatchWebhook(webhookUrl, {
			sessionId: this.id,
			event,
			timestamp: new Date().toISOString(),
			data
		})
	}

	private requireSock(): WASocket {
		if (!this.sock || this.status !== 'open') {
			throw new Boom('Session is not connected', { statusCode: 409 })
		}

		return this.sock
	}

	async requestPairingCode(phoneNumber: string): Promise<string> {
		if (!this.sock) {
			throw new Boom('Session socket not started', { statusCode: 409 })
		}

		if (this.sock.authState.creds.registered) {
			throw new Boom('Session is already registered', { statusCode: 409 })
		}

		this.setStatus('pairing')
		return this.sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''))
	}

	async sendMessage(
		jid: string,
		content: AnyMessageContent,
		options?: MiscMessageGenerationOptions
	) {
		return this.requireSock().sendMessage(jid, content, options)
	}

	async onWhatsApp(...numbers: string[]) {
		return this.requireSock().onWhatsApp(...numbers)
	}

	async presenceSubscribe(jid: string) {
		return this.requireSock().presenceSubscribe(jid)
	}

	async sendPresenceUpdate(type: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused', jid?: string) {
		return this.requireSock().sendPresenceUpdate(type, jid)
	}

	async readMessages(keys: WAMessageKey[]) {
		return this.requireSock().readMessages(keys)
	}

	/** Gracefully stop the socket without deleting credentials (survives restart). */
	async stop(): Promise<void> {
		this.stopped = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}

		try {
			this.sock?.end(undefined)
		} catch {
			// ignore
		}

		this.sock = undefined
	}

	/** Log out from the phone and clear the WhatsApp registration. */
	async logout(): Promise<void> {
		this.stopped = true
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = undefined
		}

		try {
			await this.sock?.logout()
		} catch (error) {
			logger.warn({ session: this.id, err: (error as Error).message }, 'logout call failed')
		}

		this.sock = undefined
		this.setStatus('logged_out')
	}
}
