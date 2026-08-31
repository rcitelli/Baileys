import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { appStore } from '../apps.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { recordApiKeyUse } from '../system.js'

export interface Principal {
	kind: 'service' | 'user' | 'anonymous'
	id: string
	email?: string
	/** true = operator (Cloudflare user, .env key, or dev) with access to every tenant */
	admin: boolean
	/** set for a managed app key — scopes the request to this tenant (empresa) */
	tenant?: { id: string; slug: string; name: string }
}

declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace Express {
		interface Request {
			principal?: Principal
		}
	}
}

const { teamDomain, aud } = config.auth.cloudflare
const cfEnabled = Boolean(teamDomain && aud)

const jwks = cfEnabled
	? createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`))
	: undefined

const readCookie = (req: Request, name: string): string | undefined => {
	const cookieHeader = req.header('cookie')
	if (!cookieHeader) {
		return undefined
	}

	for (const part of cookieHeader.split(';')) {
		const [key, ...rest] = part.trim().split('=')
		if (key === name) {
			return decodeURIComponent(rest.join('='))
		}
	}

	return undefined
}

const extractApiKey = (req: Request): string | undefined => {
	const header = req.header('authorization')
	if (header?.toLowerCase().startsWith('bearer ')) {
		return header.slice(7).trim()
	}

	return req.header('x-api-key')?.trim() || undefined
}

/**
 * Constant-time membership test — avoids leaking which/how-many keys match via timing.
 * Returns the index of the matching key, or -1.
 */
const matchApiKeyIndex = (provided: string): number => {
	const a = Buffer.from(provided)
	let match = -1
	config.auth.apiKeys.forEach((key, index) => {
		const b = Buffer.from(key)
		// timingSafeEqual requires equal lengths; only compare when they match, but keep
		// iterating every key so total work doesn't depend on where the match is.
		if (a.length === b.length && timingSafeEqual(a, b)) {
			match = index
		}
	})

	return match
}

const verifyApiKey = (req: Request): Principal | undefined => {
	const key = extractApiKey(req)
	if (!key) {
		return undefined
	}

	// Managed apps (created via the panel) — scoped to their tenant (empresa).
	const tenant = appStore.verify(key, clientIp(req))
	if (tenant) {
		return { kind: 'service', id: `app-${tenant.id}`, admin: false, tenant }
	}

	// Legacy static keys from API_KEYS in .env — operator-level (admin).
	const index = matchApiKeyIndex(key)
	if (index >= 0) {
		recordApiKeyUse(index, clientIp(req))
		return { kind: 'service', id: `api-key-${index + 1}`, admin: true }
	}

	return undefined
}

/** Real client IP for logging — prefer Cloudflare's header, fall back to the socket. */
const clientIp = (req: Request): string =>
	req.header('cf-connecting-ip') || req.ip || req.socket.remoteAddress || 'unknown'

/** True when the request arrived on the public panel hostname (through Cloudflare). */
const isPublicHostname = (req: Request): boolean => {
	if (!config.auth.panelHostname) {
		return false
	}

	const host = (req.header('host') || '').toLowerCase().replace(/:\d+$/, '')
	return host === config.auth.panelHostname
}

const verifyCloudflare = async (req: Request): Promise<Principal | undefined> => {
	if (!cfEnabled || !jwks) {
		return undefined
	}

	const token = req.header('cf-access-jwt-assertion') || readCookie(req, 'CF_Authorization')
	if (!token) {
		return undefined
	}

	try {
		const { payload } = await jwtVerify(token, jwks, {
			issuer: teamDomain,
			audience: aud
		})

		return {
			kind: 'user',
			id: String(payload.sub ?? 'cf-user'),
			email: typeof payload.email === 'string' ? payload.email : undefined,
			admin: true
		}
	} catch (error) {
		logger.warn({ err: (error as Error).message }, 'cloudflare access token verification failed')
		return undefined
	}
}

/** Express middleware: allow if a valid API key OR a valid Cloudflare Access JWT is present. */
export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	if (config.auth.disabled) {
		req.principal = { kind: 'anonymous', id: 'anonymous', admin: true }
		next()
		return
	}

	// On the public panel hostname, require a Cloudflare Access user — never accept a
	// bare API key from the internet, so a leaked key can't be used from outside.
	if (isPublicHostname(req)) {
		const cfUser = await verifyCloudflare(req)
		if (cfUser) {
			req.principal = cfUser
			next()
			return
		}

		logger.warn({ ip: clientIp(req), path: req.path, host: req.header('host') }, 'rejected API-key/anon on public hostname')
		res.status(401).json({ error: 'unauthorized', message: 'Cloudflare Access session required on this hostname' })
		return
	}

	const principal = verifyApiKey(req) ?? (await verifyCloudflare(req))
	if (principal) {
		req.principal = principal
		next()
		return
	}

	logger.warn({ ip: clientIp(req), path: req.path }, 'unauthorized API request')
	res.status(401).json({ error: 'unauthorized', message: 'Valid API key or Cloudflare Access session required' })
}

/** Middleware for the browser panel: require a Cloudflare Access user (not a service key). */
export const requireCloudflareUser = async (
	req: Request,
	res: Response,
	next: NextFunction
): Promise<void> => {
	if (config.auth.disabled) {
		next()
		return
	}

	// When Cloudflare is not configured we fall back to the shared authenticate()
	// so the panel is never left wide open by accident.
	if (!cfEnabled) {
		await authenticate(req, res, next)
		return
	}

	const principal = await verifyCloudflare(req)
	if (principal) {
		req.principal = principal
		next()
		return
	}

	res.status(401).json({ error: 'unauthorized', message: 'Cloudflare Access session required' })
}

export const cloudflareConfigured = cfEnabled
