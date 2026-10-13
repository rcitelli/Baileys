import { Boom } from '@hapi/boom'
import { type AnyMessageContent, isJidGroup } from '../wa.js'
import { type Request, type Response, Router } from 'express'
import { appStore } from '../apps.js'
import { buildApiDocs, DOCS_VERSION } from '../docs.js'
import type { SessionManager } from '../sessions/manager.js'
import type { HistoryAnchor } from '../sessions/session.js'
import { listRecipes, parseSpec } from '../interactive.js'
import { checkUpdates, getCurrentVersion, getHealth, listApiClients } from '../system.js'
import type { WebhookEvent } from '../types.js'
import { cloudflareConfigured } from './auth.js'
import { sensitiveLimiter } from './security.js'

/** Managing empresas/keys is an operator (admin) action — tenant keys must not do it. */
const requireAdmin = (req: Request): void => {
	if (!req.principal?.admin) {
		throw new Boom('This action requires operator (admin) access — a tenant API key cannot manage empresas', {
			statusCode: 403
		})
	}
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown

const asyncHandler =
	(fn: Handler) =>
	(req: Request, res: Response): void => {
		// Wrap in a resolved promise so SYNCHRONOUS throws (e.g. getScoped 404) are caught too.
		Promise.resolve()
			.then(() => fn(req, res))
			.catch(err => {
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

	/** Resolve a caller-facing session id to the real (namespaced) id. */
	const resolveId = (req: Request, localId: string): string => {
		const p = req.principal
		if (p?.admin) {
			return localId // operator uses global ids
		}

		if (!p?.tenant) {
			throw new Boom('Forbidden', { statusCode: 403 })
		}

		return `${p.tenant.slug}__${localId}`
	}

	/** Fetch a session enforcing tenant ownership (404 hides other tenants' sessions). */
	const getScoped = (req: Request, localId: string) => {
		const session = manager.get(resolveId(req, localId))
		const p = req.principal
		if (!p?.admin && session.getMeta().ownerAppId !== p?.tenant?.id) {
			throw new Boom(`Session '${localId}' not found`, { statusCode: 404 })
		}

		return session
	}

	/** Shape a session for the caller: tenants see their local id; admins see owner info. */
	const viewFor = (req: Request, session: import('../sessions/session.js').Session) => {
		const info = session.getInfo()
		if (req.principal?.admin) {
			return { ...info, ownerName: info.ownerAppId ? appStore.getById(info.ownerAppId)?.name : undefined }
		}

		return { ...info, id: info.localId, ownerAppId: undefined, ownerSlug: undefined }
	}

	// ---- System / platform -------------------------------------------------

	router.get(
		'/system/info',
		asyncHandler(async (req, res) => {
			res.json({
				user: req.principal?.email ?? null,
				principal: req.principal?.kind ?? 'unknown',
				version: await getCurrentVersion(),
				cloudflare: cloudflareConfigured,
				sessions: manager.list().length
			})
		})
	)

	router.get(
		'/system/health',
		asyncHandler(async (_req, res) => {
			const sessions = manager.list().map(s => s.getInfo())
			const byStatus: Record<string, number> = {}
			for (const s of sessions) {
				byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
			}

			res.json({
				...(await getHealth()),
				cloudflare: cloudflareConfigured,
				sessions: { total: sessions.length, byStatus, connected: byStatus.open ?? 0 }
			})
		})
	)

	router.get(
		'/system/updates',
		asyncHandler(async (req, res) => {
			res.json(await checkUpdates(req.query.refresh === '1'))
		})
	)

	router.get(
		'/system/apps',
		asyncHandler((_req, res) => {
			res.json({ apps: appStore.list(), legacy: listApiClients() })
		})
	)

	router.post(
		'/system/apps',
		asyncHandler(async (req, res) => {
			requireAdmin(req)
			const name = (req.body?.name ?? '').toString().trim()
			if (!name) {
				throw new Boom('`name` is required', { statusCode: 400 })
			}

			// `key` is returned exactly once here and never again — only its hash is stored.
			const { app, key } = await appStore.create(name)
			res.status(201).json({ app, key })
		})
	)

	router.patch(
		'/system/apps/:id',
		asyncHandler(async (req, res) => {
			requireAdmin(req)
			const { name, enabled } = req.body ?? {}
			res.json(await appStore.update(req.params.id!, { name, enabled }))
		})
	)

	router.delete(
		'/system/apps/:id',
		asyncHandler(async (req, res) => {
			requireAdmin(req)
			await appStore.revoke(req.params.id!)
			res.status(204).end()
		})
	)

	router.get(
		'/system/api-docs',
		asyncHandler(async (req, res) => {
			const md = buildApiDocs(await getCurrentVersion())
			if (req.query.meta === '1') {
				res.json({ version: DOCS_VERSION, filename: `baileys-hub-api-v${DOCS_VERSION}.md`, markdown: md })
				return
			}

			res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
			if (req.query.download === '1') {
				res.setHeader('Content-Disposition', `attachment; filename="baileys-hub-api-v${DOCS_VERSION}.md"`)
			}

			res.send(md)
		})
	)

	router.get(
		'/sessions',
		asyncHandler((req, res) => {
			const p = req.principal
			const list = p?.admin ? manager.list() : (p?.tenant ? manager.listForTenant(p.tenant.id) : [])
			res.json({ sessions: list.map(s => viewFor(req, s)) })
		})
	)

	router.post(
		'/sessions',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { id, name, webhookUrl, webhookEvents } = req.body ?? {}
			const p = req.principal

			// Tenants always own their sessions; the operator may assign one to an empresa.
			let ownerAppId: string | undefined
			let ownerSlug: string | undefined
			if (!p?.admin) {
				ownerAppId = p?.tenant?.id
				ownerSlug = p?.tenant?.slug
			} else if (req.body?.ownerAppId) {
				const empresa = appStore.getById(String(req.body.ownerAppId))
				if (!empresa) {
					throw new Boom('ownerAppId (empresa) inválido', { statusCode: 400 })
				}

				ownerAppId = empresa.id
				ownerSlug = empresa.slug
			}

			const session = await manager.create({
				id,
				name,
				webhookUrl,
				webhookEvents: webhookEvents as WebhookEvent[] | undefined,
				ownerAppId,
				ownerSlug
			})
			res.status(201).json(viewFor(req, session))
		})
	)

	router.get(
		'/sessions/:id',
		asyncHandler((req, res) => {
			res.json(viewFor(req, getScoped(req, req.params.id!)))
		})
	)

	router.patch(
		'/sessions/:id',
		asyncHandler(async (req, res) => {
			const { name, webhookUrl, webhookEvents } = req.body ?? {}
			const session = await manager.update(getScoped(req, req.params.id!).id, {
				...(name !== undefined ? { name } : {}),
				...(webhookUrl !== undefined ? { webhookUrl: webhookUrl || undefined } : {}),
				...(webhookEvents !== undefined ? { webhookEvents } : {})
			})
			res.json(viewFor(req, session))
		})
	)

	router.delete(
		'/sessions/:id',
		asyncHandler(async (req, res) => {
			await manager.delete(getScoped(req, req.params.id!).id)
			res.status(204).end()
		})
	)

	router.post(
		'/sessions/:id/restart',
		asyncHandler(async (req, res) => {
			const session = await manager.restart(getScoped(req, req.params.id!).id)
			res.json(viewFor(req, session))
		})
	)

	router.post(
		'/sessions/:id/logout',
		asyncHandler(async (req, res) => {
			const session = getScoped(req, req.params.id!)
			await manager.logout(session.id)
			res.json(viewFor(req, session))
		})
	)

	router.get(
		'/sessions/:id/qr',
		asyncHandler((req, res) => {
			res.json(getScoped(req, req.params.id!).getQr())
		})
	)

	router.post(
		'/sessions/:id/pairing-code',
		asyncHandler(async (req, res) => {
			const { phoneNumber } = req.body ?? {}
			if (!phoneNumber) {
				throw new Boom('phoneNumber is required', { statusCode: 400 })
			}

			const code = await getScoped(req, req.params.id!).requestPairingCode(String(phoneNumber))
			res.json({ pairingCode: code })
		})
	)

	// Server-Sent Events stream: pushes { info, qr } on every session change.
	router.get(
		'/sessions/:id/events',
		asyncHandler((req, res) => {
			const session = getScoped(req, req.params.id!)

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

			const result = await getScoped(req, req.params.id!).sendMessage(toJid(to), { text }, options)
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

			const result = await getScoped(req, req.params.id!).sendMessage(
				toJid(to),
				message as AnyMessageContent,
				options
			)
			res.json({ key: result?.key, status: result?.status })
		})
	)

	/** Reply buttons / list / call-to-action buttons (unofficial: see interactive.ts). */
	router.post(
		'/sessions/:id/send-interactive',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { to, interactive, recipe } = req.body ?? {}
			if (!to || !interactive) {
				throw new Boom('`to` and `interactive` are required', { statusCode: 400 })
			}

			const spec = parseSpec(interactive)
			const result = await getScoped(req, req.params.id!).sendInteractive(toJid(to), spec, recipe)
			res.json({ key: result.key, recipe: result.recipe })
		})
	)

	router.get(
		'/interactive/recipes',
		asyncHandler(async (_req, res) => {
			res.json({ recipes: listRecipes() })
		})
	)

	router.get(
		'/sessions/:id/interactive/log',
		asyncHandler(async (req, res) => {
			res.json({ log: getScoped(req, req.params.id!).getInteractiveLog() })
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

			const result = await getScoped(req, req.params.id!).onWhatsApp(...list.map(String))
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
				await getScoped(req, req.params.id!).presenceSubscribe(jid)
			}

			await getScoped(req, req.params.id!).sendPresenceUpdate(type, jid)
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

			await getScoped(req, req.params.id!).readMessages(keys)
			res.json({ ok: true })
		})
	)

	// ---- Groups --------------------------------------------------------------

	/** Normalized group view: participants carry phone (when WhatsApp tells it) and LID. */
	const groupView = (g: {
		id: string
		subject?: string
		owner?: string
		creation?: number
		announce?: boolean
		participants?: { id: string; phoneNumber?: string; lid?: string; admin?: string | null }[]
	}) => ({
		id: g.id,
		subject: g.subject ?? '',
		owner: g.owner ?? null,
		creation: g.creation ?? null,
		announce: !!g.announce,
		size: g.participants?.length ?? 0,
		participants: (g.participants ?? []).map(p => ({
			id: p.id,
			phoneNumber: p.phoneNumber ?? (p.id.endsWith('@s.whatsapp.net') ? p.id : null),
			lid: p.lid ?? (p.id.endsWith('@lid') ? p.id : null),
			admin: p.admin ?? null
		}))
	})

	const requireGroupJid = (raw: string | undefined): string => {
		const jid = String(raw ?? '').trim()
		if (!isJidGroup(jid)) {
			throw new Boom('A group jid (…@g.us) is required', { statusCode: 400 })
		}

		return jid
	}

	router.get(
		'/sessions/:id/groups',
		asyncHandler(async (req, res) => {
			const groups = await getScoped(req, req.params.id!).listGroups()
			res.json({ groups: Object.values(groups ?? {}).map(groupView) })
		})
	)

	router.get(
		'/sessions/:id/groups/:jid',
		asyncHandler(async (req, res) => {
			const jid = requireGroupJid(req.params.jid)
			res.json(groupView(await getScoped(req, req.params.id!).groupMetadata(jid)))
		})
	)

	router.post(
		'/sessions/:id/groups/:jid/leave',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const jid = requireGroupJid(req.params.jid)
			await getScoped(req, req.params.id!).leaveGroup(jid)
			res.json({ ok: true })
		})
	)

	// ---- Contacts / chats / history (per session) --------------------------

	router.get(
		'/sessions/:id/contacts',
		asyncHandler((req, res) => {
			res.json({ contacts: getScoped(req, req.params.id!).getContacts() })
		})
	)

	router.get(
		'/sessions/:id/chats',
		asyncHandler((req, res) => {
			res.json({ chats: getScoped(req, req.params.id!).getChats() })
		})
	)

	router.get(
		'/sessions/:id/history',
		asyncHandler(async (req, res) => {
			const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000)
			res.json({ history: await getScoped(req, req.params.id!).getHistory(limit) })
		})
	)

	// On-demand history: ask the phone for OLDER messages of one chat. Asynchronous —
	// the messages arrive later as a `messaging-history.set` webhook (syncType 6).
	router.post(
		'/sessions/:id/history/fetch',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { jid, to, count, anchor } = req.body ?? {}
			const target = jid ?? to
			if (!target) {
				throw new Boom('`jid` (or `to`, a phone number) is required', { statusCode: 400 })
			}

			let parsed: HistoryAnchor | undefined
			if (anchor !== undefined) {
				const ts = Number(anchor?.timestamp)
				if (!anchor?.id || !Number.isFinite(ts) || ts <= 0) {
					throw new Boom('`anchor` needs { id, fromMe, timestamp (seconds) }', { statusCode: 400 })
				}

				parsed = {
					id: String(anchor.id),
					fromMe: Boolean(anchor.fromMe),
					timestamp: Math.floor(ts),
					remoteJid: anchor.remoteJid ? String(anchor.remoteJid) : undefined
				}
			}

			const result = await getScoped(req, req.params.id!).fetchHistory(
				String(target),
				count === undefined ? undefined : Number(count),
				parsed
			)
			res.status(202).json({ requested: true, ...result })
		})
	)

	// Synchronous read of ONE chat's history: the messages come back in this response
	// (and are also forwarded to the webhook with origin 'card').
	router.post(
		'/sessions/:id/chats/:jid/history',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { count, anchor, full, maxPages, days } = req.body ?? {}
			const bad = (field: string) => {
				throw new Boom(`Invalid \`${field}\``, { statusCode: 400 })
			}

			const num = (v: unknown, field: string, min: number, max: number) => {
				if (v === undefined) {
					return undefined
				}

				const n = Number(v)
				if (!Number.isFinite(n) || n < min || n > max) {
					bad(field)
				}

				return n
			}

			let parsed: HistoryAnchor | undefined
			if (anchor !== undefined) {
				let ts = Number(anchor?.timestamp)
				if (!anchor?.id || !Number.isFinite(ts) || ts <= 0) {
					throw new Boom('`anchor` needs { id, fromMe, timestamp (seconds) }', { statusCode: 400 })
				}

				if (ts > 1e12) {
					ts = ts / 1000 // tolerate milliseconds
				}

				parsed = {
					id: String(anchor.id),
					fromMe: Boolean(anchor.fromMe),
					timestamp: Math.floor(ts),
					remoteJid: anchor.remoteJid ? String(anchor.remoteJid) : undefined
				}
			}

			const result = await getScoped(req, req.params.id!).readChatHistory(req.params.jid!, {
				count: num(count, 'count', 1, 50),
				anchor: parsed,
				full: full === true || full === 'true',
				maxPages: num(maxPages, 'maxPages', 1, 200),
				days: num(days, 'days', 0, 36500)
			})
			res.json(result)
		})
	)

	// Full history WITHOUT re-pairing: one FULL_HISTORY_SYNC_ON_DEMAND request to the
	// phone. Asynchronous — history arrives via the `messaging-history.set` webhook;
	// the phone's answer (accepted/declined) shows up in GET /history/sync.
	router.post(
		'/sessions/:id/history/full',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const days = req.body?.days === undefined ? undefined : Number(req.body.days)
			if (days !== undefined && (!Number.isFinite(days) || days < 0)) {
				throw new Boom('`days` must be a non-negative number', { statusCode: 400 })
			}

			const full = await getScoped(req, req.params.id!).requestFullHistory(days)
			res.status(202).json({ requested: true, full })
		})
	)

	// Chat-by-chat backfill WITHOUT re-pairing: pages older messages (50 per request)
	// for every chat with a known message, up to `days`. Runs in the background.
	router.post(
		'/sessions/:id/history/backfill',
		sensitiveLimiter,
		asyncHandler(async (req, res) => {
			const { days, anchors, maxPagesPerChat, intervalMs } = req.body ?? {}
			const parsed: HistoryAnchor[] = []
			for (const a of Array.isArray(anchors) ? anchors : []) {
				const ts = Number(a?.timestamp)
				if (a?.id && a?.remoteJid && Number.isFinite(ts) && ts > 0) {
					parsed.push({
						id: String(a.id),
						fromMe: Boolean(a.fromMe),
						timestamp: Math.floor(ts),
						remoteJid: String(a.remoteJid)
					})
				}
			}

			const control = (value: unknown, name: string, min: number, max: number): number | undefined => {
				if (value === undefined || value === null) {
					return undefined
				}

				const n = Number(value)
				if (!Number.isFinite(n) || n < min || n > max) {
					throw new Boom(`\`${name}\` must be a number between ${min} and ${max}`, { statusCode: 400 })
				}

				return n
			}

			const backfill = await getScoped(req, req.params.id!).startBackfill({
				days: control(days, 'days', 0, 36500),
				anchors: parsed,
				maxPagesPerChat: control(maxPagesPerChat, 'maxPagesPerChat', 1, 1000),
				intervalMs: control(intervalMs, 'intervalMs', 250, 60_000)
			})
			res.status(202).json({ started: true, backfill })
		})
	)

	router.delete(
		'/sessions/:id/history/backfill',
		asyncHandler((req, res) => {
			res.json({ backfill: getScoped(req, req.params.id!).stopBackfill() })
		})
	)

	router.get(
		'/sessions/:id/history/sync',
		asyncHandler((req, res) => {
			res.json(getScoped(req, req.params.id!).getHistorySyncStatus())
		})
	)

	return router
}
