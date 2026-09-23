import { EventEmitter } from 'node:events'
import { Boom } from '@hapi/boom'
import makeWASocket, {
	type AnyMessageContent,
	Browsers,
	type ConnectionState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	getContentType,
	isLidUser,
	isPnUser,
	jidNormalizedUser,
	makeCacheableSignalKeyStore,
	type MiscMessageGenerationOptions,
	useMultiFileAuthState,
	type WAMessageKey,
	type WASocket
} from '../wa.js'
import QRCode from 'qrcode'
import { config } from '../config.js'
import { appendHistory, appendHistoryBatch, type HistoryEntry, oldestForChat, queryHistory } from '../history.js'
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

/** Minimal shape of a WAMessage as it arrives in upsert/history events. */
interface RawMessage {
	key?: { id?: string; remoteJid?: string; fromMe?: boolean }
	message?: Record<string, unknown>
	messageTimestamp?: number | string | { toNumber?: () => number; low?: number }
	status?: number
}

/** Shape of Baileys' `messaging-history.set` payload (the parts the server touches). */
interface HistorySetData {
	messages?: RawMessage[]
	chats?: Array<{ id?: string; name?: string; conversationTimestamp?: number }>
	contacts?: Array<{ id?: string; name?: string; notify?: string }>
	syncType?: number
	progress?: number | null
	isLatest?: boolean
	chunkOrder?: number | null
	peerDataRequestSessionId?: string | null
}

/** Anchor for an on-demand history fetch: a message the linked device already has. */
export interface HistoryAnchor {
	id: string
	fromMe: boolean
	/** message timestamp in SECONDS (as in WAMessage.messageTimestamp) */
	timestamp: number
	/** chat JID the anchor belongs to (pn or lid) */
	remoteJid?: string
}

/** WhatsApp caps each on-demand history request at 50 messages. */
const MAX_ON_DEMAND = 50

/** Seconds from a (possibly Long / string) protobuf timestamp. */
const tsSeconds = (raw: RawMessage['messageTimestamp']): number | undefined => {
	if (typeof raw === 'number') {
		return raw
	}

	if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) {
		return Number(raw)
	}

	if (raw && typeof raw === 'object') {
		const n = raw.toNumber?.() ?? raw.low
		return typeof n === 'number' ? n : undefined
	}

	return undefined
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

	// History deliveries are chained so batches reach the receiver in order and one
	// multi-thousand-message sync never floods it with parallel POSTs.
	private historyQueue: Promise<void> = Promise.resolve()

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
				generateHighQualityLinkPreview: true,
				// Old conversations (with content) arrive in `messaging-history.set`. The
				// library asks for the full history but, by default, DISCARDS the FULL
				// chunks (`syncType !== FULL`) — so only a few recent days ever surfaced.
				// Process every chunk; receivers decide what to keep.
				syncFullHistory: true,
				shouldSyncHistoryMessage: () => true
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

				if (key === 'messaging-history.set') {
					this.forwardHistory(events[key] as HistorySetData)
					continue
				}

				this.forward(key as WebhookEvent, events[key])
			}
		})
	}

	/** Extract metadata-only history + maintain live contact/chat maps from events. */
	private capture(events: Record<string, unknown>) {
		try {
			const upserts = events['messages.upsert'] as { messages?: RawMessage[] } | undefined
			if (upserts?.messages) {
				for (const m of upserts.messages) {
					const entry = this.toHistoryEntry(m)
					if (entry) {
						void appendHistory(this.id, entry)
					}
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

			const histSet = events['messaging-history.set'] as HistorySetData | undefined
			if (histSet) {
				// Record metadata for history messages too: it is the anchor store for
				// on-demand fetches (WhatsApp needs a message the device already has).
				const entries: HistoryEntry[] = []
				for (const m of histSet.messages ?? []) {
					const entry = this.toHistoryEntry(m)
					if (entry) {
						entries.push(entry)
					}
				}

				void appendHistoryBatch(this.id, entries)

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

	/** Metadata record for one message (no content); also bumps the live chat map. */
	private toHistoryEntry(m: RawMessage): HistoryEntry | undefined {
		const chat = m.key?.remoteJid
		if (!chat) {
			return undefined
		}

		const ts = tsSeconds(m.messageTimestamp) ?? Math.floor(Date.now() / 1000)
		const live = this.chats.get(chat) ?? { id: chat }
		if (!live.ts || ts > live.ts) {
			live.ts = ts
		}

		this.chats.set(chat, live)
		return {
			t: ts * 1000,
			dir: m.key?.fromMe ? 'out' : 'in',
			chat,
			type: m.message ? (getContentType(m.message as never) ?? 'unknown') : 'unknown',
			id: m.key?.id,
			status: typeof m.status === 'number' ? String(m.status) : undefined
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

	/**
	 * Forward `messaging-history.set` in batches of `webhook.historyBatchSize` messages.
	 * The first batch also carries `chats`/`contacts`; every batch carries the sync
	 * metadata plus `part`/`parts` so receivers can tell the pieces apart. Deliveries
	 * are chained (sequential) across syncs.
	 */
	private forwardHistory(data: HistorySetData) {
		const { webhookUrl, webhookEvents } = this.meta
		if (!webhookUrl || !webhookEvents.includes('messaging-history.set') || !data) {
			return
		}

		const messages = data.messages ?? []
		const size = config.webhook.historyBatchSize
		const parts = Math.max(1, Math.ceil(messages.length / size))
		const base = {
			syncType: data.syncType,
			progress: data.progress,
			isLatest: data.isLatest,
			chunkOrder: data.chunkOrder,
			peerDataRequestSessionId: data.peerDataRequestSessionId
		}
		logger.info(
			{ session: this.id, syncType: data.syncType, messages: messages.length, parts },
			'forwarding history sync'
		)

		for (let i = 0; i < parts; i++) {
			const batch = {
				...base,
				messages: messages.slice(i * size, (i + 1) * size),
				chats: i === 0 ? (data.chats ?? []) : [],
				contacts: i === 0 ? (data.contacts ?? []) : [],
				part: i + 1,
				parts
			}
			this.historyQueue = this.historyQueue.then(async () => {
				await dispatchWebhook(webhookUrl, {
					sessionId: this.id,
					event: 'messaging-history.set',
					timestamp: new Date().toISOString(),
					data: batch
				})
			})
		}
	}

	/**
	 * Ask the phone for OLDER messages of one chat (on-demand history sync). The reply
	 * is asynchronous: it arrives as a `messaging-history.set` event (syncType
	 * ON_DEMAND = 6) and is forwarded to the webhook like any other history.
	 *
	 * `target` is a JID or a phone number. The anchor must be a message the device
	 * already has — the caller's, or else the oldest one this server has seen for the
	 * chat (pn and lid forms are both tried).
	 */
	async fetchHistory(
		target: string,
		count = MAX_ON_DEMAND,
		anchor?: HistoryAnchor
	): Promise<{ requestId: string; jid: string; anchor: HistoryAnchor }> {
		const sock = this.requireSock()
		const n = Math.min(Math.max(Math.floor(count) || MAX_ON_DEMAND, 1), MAX_ON_DEMAND)

		let chosen: HistoryAnchor | undefined = anchor
		if (!chosen) {
			const candidates = await this.chatJidCandidates(target)
			const oldest = await oldestForChat(this.id, candidates)
			if (oldest?.id) {
				chosen = {
					id: oldest.id,
					fromMe: oldest.dir === 'out',
					timestamp: Math.floor(oldest.t / 1000),
					remoteJid: oldest.chat
				}
			}
		}

		if (!chosen?.id || !chosen.timestamp) {
			throw new Boom(
				'No known message in this chat to anchor the history request. Send or receive one message ' +
					'in the chat, or pass `anchor` ({ id, fromMe, timestamp }) from a message you have stored.',
				{ statusCode: 422 }
			)
		}

		const jid = chosen.remoteJid || (await this.chatJidCandidates(target))[0]!
		const requestId = await sock.fetchMessageHistory(
			n,
			{ remoteJid: jid, fromMe: chosen.fromMe, id: chosen.id },
			chosen.timestamp
		)
		logger.info({ session: this.id, jid, count: n, requestId }, 'on-demand history requested')
		return { requestId, jid, anchor: { ...chosen, remoteJid: jid } }
	}

	/**
	 * JIDs a chat may be keyed under. The target (jid or phone number) is normalized
	 * (device suffix dropped) and expanded with its counterpart identity — pn → mapped
	 * lid, lid → mapped pn — since stored history may use either form.
	 */
	private async chatJidCandidates(target: string): Promise<string[]> {
		const value = String(target).trim()
		let primary: string
		if (value.includes('@')) {
			primary = jidNormalizedUser(value)
			if (!primary) {
				throw new Boom('Invalid chat JID', { statusCode: 400 })
			}
		} else {
			const digits = value.replace(/[^0-9]/g, '')
			if (!digits) {
				throw new Boom('Invalid chat — pass a JID or a phone number', { statusCode: 400 })
			}

			primary = `${digits}@s.whatsapp.net`
		}

		const out = [primary]
		try {
			const mapping = this.sock?.signalRepository.lidMapping
			const other = isPnUser(primary)
				? await mapping?.getLIDForPN(primary)
				: isLidUser(primary)
					? await mapping?.getPNForLID(primary)
					: undefined
			if (other) {
				const normalized = jidNormalizedUser(other)
				if (normalized && !out.includes(normalized)) {
					out.push(normalized)
				}
			}
		} catch {
			// mapping is best-effort
		}

		return out
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
