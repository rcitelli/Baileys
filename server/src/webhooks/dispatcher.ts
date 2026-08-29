import { setTimeout as sleep } from 'node:timers/promises'
import { config } from '../config.js'
import { logger } from '../logger.js'
import type { WebhookEvent } from '../types.js'

export interface WebhookPayload {
	sessionId: string
	event: WebhookEvent
	timestamp: string
	data: unknown
}

/**
 * Delivers an event to a session's webhook URL with exponential-backoff retries.
 * WhatsApp payloads carry Buffers; JSON.stringify serialises them as { type: 'Buffer', data: [...] }
 * which is fine for downstream consumers that expect standard Node Buffer JSON.
 */
export const dispatchWebhook = async (url: string, payload: WebhookPayload): Promise<boolean> => {
	const body = JSON.stringify(payload, (_key, value) =>
		typeof value === 'bigint' ? value.toString() : value
	)

	for (let attempt = 0; attempt <= config.webhook.maxRetries; attempt++) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), config.webhook.timeoutMs)

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Webhook-Event': payload.event,
					'X-Webhook-Session': payload.sessionId,
					...(config.webhook.secret ? { 'X-Webhook-Secret': config.webhook.secret } : {})
				},
				body,
				signal: controller.signal
			})

			if (res.ok) {
				return true
			}

			logger.warn(
				{ url, status: res.status, event: payload.event, session: payload.sessionId, attempt },
				'webhook delivery returned non-2xx'
			)
		} catch (error) {
			logger.warn(
				{ url, event: payload.event, session: payload.sessionId, attempt, err: (error as Error).message },
				'webhook delivery failed'
			)
		} finally {
			clearTimeout(timer)
		}

		if (attempt < config.webhook.maxRetries) {
			await sleep(config.webhook.retryBaseDelayMs * 2 ** attempt)
		}
	}

	logger.error(
		{ url, event: payload.event, session: payload.sessionId },
		'webhook delivery exhausted all retries'
	)
	return false
}
