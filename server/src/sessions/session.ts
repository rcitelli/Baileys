import { EventEmitter } from 'node:events'
import { Boom } from '@hapi/boom'
import makeWASocket, {
	type AnyMessageContent,
	Browsers,
	type ConnectionState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	jidNormalizedUser,
	makeCacheableSignalKeyStore,
	type MiscMessageGenerationOptions,
	useMultiFileAuthState,
	type WAMessageKey,
	type WASocket
} from '../wa.js'
import QRCode from 'qrcode'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { SessionInfo, SessionMeta, SessionStatus, WebhookEvent } from '../types.js'
import { dispatchWebhook } from '../webhooks/dispatcher.js'

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

			for (const key of Object.keys(events) as (keyof typeof events)[]) {
				if (key === 'creds.update' || key === 'connection.update') {
					continue
				}

				this.forward(key as WebhookEvent, events[key])
			}
		})
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
