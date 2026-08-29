import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import cors from 'cors'
import express from 'express'
import { authenticate, cloudflareConfigured, requireCloudflareUser } from './api/auth.js'
import { createApiRouter } from './api/routes.js'
import { config } from './config.js'
import { logger } from './logger.js'
import { SessionManager } from './sessions/manager.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const main = async () => {
	const manager = new SessionManager()
	await manager.init()

	const app = express()
	app.disable('x-powered-by')
	app.use(cors())
	app.use(express.json({ limit: '10mb' }))

	// Liveness probe — intentionally unauthenticated so orchestrators can poll it.
	app.get('/health', (_req, res) => {
		res.json({ ok: true, sessions: manager.list().length, cloudflare: cloudflareConfigured })
	})

	// REST API — API key (server-to-server) or Cloudflare Access (panel) required.
	app.use('/api', authenticate, createApiRouter(manager))

	// Panel — a static single-page dashboard, gated behind Cloudflare Access.
	app.get('/', requireCloudflareUser, (_req, res) => {
		res.sendFile(join(__dirname, 'panel', 'index.html'))
	})
	app.use('/panel', requireCloudflareUser, express.static(join(__dirname, 'panel')))

	if (!config.auth.disabled && config.auth.apiKeys.length === 0 && !cloudflareConfigured) {
		logger.warn(
			'No API keys and no Cloudflare Access configured — every /api request will be rejected. ' +
				'Set API_KEYS and/or CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD, or AUTH_DISABLED=true for local dev.'
		)
	}

	const server = app.listen(config.port, config.host, () => {
		logger.info({ host: config.host, port: config.port }, 'baileys server listening')
	})

	const shutdown = async (signal: string) => {
		logger.info({ signal }, 'shutting down')
		server.close()
		await manager.shutdown()
		process.exit(0)
	}

	process.on('SIGINT', () => void shutdown('SIGINT'))
	process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(err => {
	logger.error({ err: (err as Error).message }, 'fatal error on startup')
	process.exit(1)
})
