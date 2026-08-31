/** Connection lifecycle state exposed to the panel and API */
export type SessionStatus =
	| 'idle' // created but socket not started yet
	| 'connecting' // socket opening / reconnecting
	| 'qr' // waiting for the QR code to be scanned
	| 'pairing' // waiting for a pairing code to be entered
	| 'open' // connected and ready to send/receive
	| 'close' // disconnected, will attempt to reconnect
	| 'logged_out' // logged out from the phone; needs a fresh QR

/** Events that can be forwarded to a session's webhook */
export type WebhookEvent =
	| 'connection.update'
	| 'creds.update'
	| 'messages.upsert'
	| 'messages.update'
	| 'messages.delete'
	| 'message-receipt.update'
	| 'messages.reaction'
	| 'presence.update'
	| 'chats.upsert'
	| 'chats.update'
	| 'contacts.upsert'
	| 'contacts.update'
	| 'groups.upsert'
	| 'groups.update'
	| 'call'

export const ALL_WEBHOOK_EVENTS: WebhookEvent[] = [
	'connection.update',
	'messages.upsert',
	'messages.update',
	'messages.delete',
	'message-receipt.update',
	'messages.reaction',
	'presence.update',
	'chats.upsert',
	'chats.update',
	'contacts.upsert',
	'contacts.update',
	'groups.upsert',
	'groups.update',
	'call'
]

/** Persisted, on-disk metadata for a session (meta.json) */
export interface SessionMeta {
	/** Global, namespaced id (e.g. "elo-financeiro__vendas"). Also the on-disk folder. */
	id: string
	/** Tenant-facing id (what the owning empresa uses in the API). */
	localId: string
	/** Owning empresa (app) id — undefined for operator-owned sessions. */
	ownerAppId?: string
	/** Owning empresa slug, mirrored for display/namespacing. */
	ownerSlug?: string
	name: string
	webhookUrl?: string
	webhookEvents: WebhookEvent[]
	createdAt: string
	updatedAt: string
}

/** Runtime view of a session returned by the API */
export interface SessionInfo extends SessionMeta {
	/** Display name of the owning empresa (admin views only). */
	ownerName?: string
	status: SessionStatus
	/** Connected WhatsApp account JID, once open */
	jid?: string
	/** Display name of the connected account */
	pushName?: string
	/** Phone number (E.164, digits only) of the connected account */
	phoneNumber?: string
	/** Whether a QR code is currently available to scan */
	hasQr: boolean
	lastConnectedAt?: string
	lastDisconnectReason?: string
}

export interface CreateSessionInput {
	id?: string
	name?: string
	webhookUrl?: string
	webhookEvents?: WebhookEvent[]
	/** Owning empresa — set by the operator when creating on a tenant's behalf. */
	ownerAppId?: string
	ownerSlug?: string
}
