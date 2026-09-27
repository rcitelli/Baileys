import { getContentType, normalizeMessageContent, type WAMessage } from '../wa.js'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

const isLong = (v: unknown): v is { toNumber: () => number } =>
	typeof v === 'object' &&
	v !== null &&
	'low' in v &&
	'high' in v &&
	typeof (v as { toNumber?: unknown }).toNumber === 'function'

/** Deep-convert protobuf values to plain JSON: Long -> number, bytes -> base64 string. */
export const toPlainJson = (value: unknown): Json => {
	if (value === null || value === undefined) {
		return null
	}

	if (isLong(value)) {
		return value.toNumber()
	}

	if (typeof value === 'bigint') {
		return Number(value)
	}

	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return Buffer.from(value).toString('base64')
	}

	if (Array.isArray(value)) {
		return value.map(toPlainJson)
	}

	if (typeof value === 'object') {
		const out: { [k: string]: Json } = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (v !== undefined && typeof v !== 'function') {
				out[k] = toPlainJson(v)
			}
		}

		return out
	}

	if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
		return value
	}

	return null
}

export const timestampSeconds = (msg: WAMessage): number => {
	const raw = msg.messageTimestamp as unknown
	if (typeof raw === 'number') {
		return raw
	}

	if (isLong(raw)) {
		return raw.toNumber()
	}

	return Number(raw) || 0
}

const extractText = (msg: WAMessage): string | undefined => {
	const content = normalizeMessageContent(msg.message)
	if (!content) {
		return undefined
	}

	return (
		content.conversation ||
		content.extendedTextMessage?.text ||
		content.imageMessage?.caption ||
		content.videoMessage?.caption ||
		content.documentMessage?.caption ||
		content.documentMessage?.fileName ||
		undefined
	)
}

/** API shape for a historical message: convenient summary fields + the full raw message. */
export const summarizeMessage = (msg: WAMessage) => {
	const content = normalizeMessageContent(msg.message)
	return {
		id: msg.key.id,
		chat: msg.key.remoteJid,
		fromMe: Boolean(msg.key.fromMe),
		participant: msg.key.participant || undefined,
		timestamp: timestampSeconds(msg),
		pushName: msg.pushName || undefined,
		type: (content && getContentType(content)) || (msg.messageStubType ? 'stub' : 'unknown'),
		text: extractText(msg),
		key: toPlainJson(msg.key),
		message: toPlainJson(msg.message)
	}
}
