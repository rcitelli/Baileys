import { resolve } from 'node:path'
import dotenv from 'dotenv'

dotenv.config()

const parseList = (value: string | undefined): string[] =>
	(value ?? '')
		.split(',')
		.map(item => item.trim())
		.filter(Boolean)

const bool = (value: string | undefined, fallback = false): boolean => {
	if (value === undefined) {
		return fallback
	}

	return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

const num = (value: string | undefined, fallback: number): number => {
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
	/** HTTP port the server listens on */
	port: num(process.env.PORT, 3000),
	/** Interface to bind — 0.0.0.0 inside a container, 127.0.0.1 behind a local reverse proxy */
	host: process.env.HOST ?? '0.0.0.0',
	/** Root directory that holds one folder per session (auth + metadata) */
	dataDir: resolve(process.env.DATA_DIR ?? './data'),
	/** Log level for pino */
	logLevel: process.env.LOG_LEVEL ?? 'info',
	/** Pretty-print logs (dev). In production leave off for JSON logs. */
	logPretty: bool(process.env.LOG_PRETTY, false),

	auth: {
		/** Disable all auth — ONLY for local development behind a firewall */
		disabled: bool(process.env.AUTH_DISABLED, false),
		/** Valid API keys for server-to-server calls (Bearer / x-api-key) */
		apiKeys: parseList(process.env.API_KEYS),
		cloudflare: {
			/** e.g. https://yourteam.cloudflareaccess.com — enables JWT verification of the panel */
			teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/+$/, '') || undefined,
			/** Application Audience (AUD) tag from the Cloudflare Access application */
			aud: process.env.CF_ACCESS_AUD || undefined
		}
	},

	webhook: {
		/** Max retry attempts when a webhook delivery fails */
		maxRetries: num(process.env.WEBHOOK_MAX_RETRIES, 3),
		/** Base delay (ms) for exponential backoff between webhook retries */
		retryBaseDelayMs: num(process.env.WEBHOOK_RETRY_BASE_DELAY_MS, 1000),
		/** Per-request timeout (ms) for webhook delivery */
		timeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10000),
		/** Optional shared secret; sent as X-Webhook-Secret so receivers can verify origin */
		secret: process.env.WEBHOOK_SECRET || undefined
	},

	session: {
		/** Automatically reconnect sessions on startup */
		autostart: bool(process.env.SESSION_AUTOSTART, true),
		/** Mark the outgoing socket as always-online */
		markOnlineOnConnect: bool(process.env.SESSION_MARK_ONLINE, false)
	}
} as const

export type AppConfig = typeof config
