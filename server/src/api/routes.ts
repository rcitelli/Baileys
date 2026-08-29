import { Boom } from '@hapi/boom'
import { type AnyMessageContent, isJidGroup } from '../wa.js'
import { type Request, type Response, Router } from 'express'
import type { SessionManager } from '../sessions/manager.js'
import type { WebhookEvent } from '../types.js'
import { sensitiveLimiter } from './security.js'

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown

const asyncHandler =
	(fn: Handler) =>
	(req: Request, res: Response): void => {
		Promise.resolve(fn(req, res)).catch(err => {
			const status = err instanceof Boom ? err.output.statusCode : 500
			if (!res.headersSent) {
				res.status(status).json({ error: err?.name ?? 'error', message: err?.message ?? 'internal error' })
			}
		})
	}

/** Turn a phone number or partial jid into a full WhatsApp jid. */
const toJid = (input: string): string => {
	const value = String(input).trim()
	if (value.includes('@')) {
		return value
	}

	const digits = value.replace(/[^0-9]/g, '')
	if (!digits) {
		throw new Boom('Invalid recipient', { statusCode: 400 })
	}

	// A group id is numeric-with-dash; callers should pass the full @g.us jid for groups.
	return `${digits}@s.whatsapp.net`
}

export const createApiRouter = (manager: SessionManager): Router => {
	const router = Router()

	router.get(
		'/sessions',
		asyncHandler((_req, res) => {
			res.json({ sessions: manager.list().map(s => s.getInfo()) })
		})
	)

	router.post(
		'/sessions',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { id, name, webhookUrl, webhookEvents } = req.body ?? {}
			const session = await manager.create({
				id,
				name,
				webhookUrl,
				webhookEvents: webhookEvents as WebhookEvent[] | undefined
			})
			res.status(201).json(session.getInfo())
		})
	)

	router.get(
		'/sessions/:id',
		asyncHandler((req, res) => {
			res.json(manager.get(req.params.id!).getInfo())
		})
	)

	router.patch(
		'/sessions/:id',
		asyncHandler(async (req, res) => {
			const { name, webhookUrl, webhookEvents } = req.body ?? {}
			const session = await manager.update(req.params.id!, {
				...(name !== undefined ? { name } : {}),
				...(webhookUrl !== undefined ? { webhookUrl: webhookUrl || undefined } : {}),
				...(webhookEvents !== undefined ? { webhookEvents } : {})
			})
			res.json(session.getInfo())
		})
	)

	router.delete(
		'/sessions/:id',
		asyncHandler(async (req, res) => {
			await manager.delete(req.params.id!)
			res.status(204).end()
		})
	)

	router.post(
		'/sessions/:id/restart',
		asyncHandler(async (req, res) => {
			const session = await manager.restart(req.params.id!)
			res.json(session.getInfo())
		})
	)

	router.post(
		'/sessions/:id/logout',
		asyncHandler(async (req, res) => {
			await manager.logout(req.params.id!)
			res.json(manager.get(req.params.id!).getInfo())
		})
	)

	router.get(
		'/sessions/:id/qr',
		asyncHandler((req, res) => {
			res.json(manager.get(req.params.id!).getQr())
		})
	)

	router.post(
		'/sessions/:id/pairing-code',
		asyncHandler(async (req, res) => {
			const { phoneNumber } = req.body ?? {}
			if (!phoneNumber) {
				throw new Boom('phoneNumber is required', { statusCode: 400 })
			}

			const code = await manager.get(req.params.id!).requestPairingCode(String(phoneNumber))
			res.json({ pairingCode: code })
		})
	)

	// Server-Sent Events stream: pushes { info, qr } on every session change.
	router.get(
		'/sessions/:id/events',
		asyncHandler((req, res) => {
			const session = manager.get(req.params.id!)

			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no'
			})

			const send = () => {
				res.write(`data: ${JSON.stringify({ info: session.getInfo(), qr: session.getQr() })}\n\n`)
			}

			send()
			const onUpdate = () => send()
			session.on('update', onUpdate)

			const ping = setInterval(() => res.write(': ping\n\n'), 25000)

			req.on('close', () => {
				clearInterval(ping)
				session.off('update', onUpdate)
			})
		})
	)

	// ---- Messaging ----------------------------------------------------------

	router.post(
		'/sessions/:id/send-text',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { to, text, options } = req.body ?? {}
			if (!to || typeof text !== 'string') {
				throw new Boom('`to` and `text` are required', { statusCode: 400 })
			}

			const result = await manager.get(req.params.id!).sendMessage(toJid(to), { text }, options)
			res.json({ key: result?.key, status: result?.status })
		})
	)

	router.post(
		'/sessions/:id/send',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { to, message, options } = req.body ?? {}
			if (!to || !message || typeof message !== 'object') {
				throw new Boom('`to` and `message` (AnyMessageContent) are required', { statusCode: 400 })
			}

			const result = await manager
				.get(req.params.id!)
				.sendMessage(toJid(to), message as AnyMessageContent, options)
			res.json({ key: result?.key, status: result?.status })
		})
	)

	router.post(
		'/sessions/:id/check',
		asyncHandler(async (req, res) => {
			const { numbers } = req.body ?? {}
			const list: string[] = Array.isArray(numbers) ? numbers : numbers ? [numbers] : []
			if (list.length === 0) {
				throw new Boom('`numbers` is required', { statusCode: 400 })
			}

			const result = await manager.get(req.params.id!).onWhatsApp(...list.map(String))
			res.json({ results: result ?? [] })
		})
	)

	router.post(
		'/sessions/:id/presence',
		asyncHandler(async (req, res) => {
			const { type, to } = req.body ?? {}
			if (!type) {
				throw new Boom('`type` is required', { statusCode: 400 })
			}

			const jid = to ? toJid(to) : undefined
			if (jid && !isJidGroup(jid)) {
				await manager.get(req.params.id!).presenceSubscribe(jid)
			}

			await manager.get(req.params.id!).sendPresenceUpdate(type, jid)
			res.json({ ok: true })
		})
	)

	router.post(
		'/sessions/:id/read',
		asyncHandler(async (req, res) => {
			const { keys } = req.body ?? {}
			if (!Array.isArray(keys) || keys.length === 0) {
				throw new Boom('`keys` (array of WAMessageKey) is required', { statusCode: 400 })
			}

			await manager.get(req.params.id!).readMessages(keys)
			res.json({ ok: true })
		})
	)

	return router
}
