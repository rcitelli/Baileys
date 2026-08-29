import type { NextFunction, Request, Response } from 'express'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'
import { logger } from '../logger.js'

export interface Principal {
	kind: 'service' | 'user' | 'anonymous'
	id: string
	email?: string
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

const verifyApiKey = (req: Request): Principal | undefined => {
	if (config.auth.apiKeys.length === 0) {
		return undefined
	}

	const key = extractApiKey(req)
	if (key && config.auth.apiKeys.includes(key)) {
		return { kind: 'service', id: 'api-key' }
	}

	return undefined
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
			email: typeof payload.email === 'string' ? payload.email : undefined
		}
	} catch (error) {
		logger.warn({ err: (error as Error).message }, 'cloudflare access token verification failed')
		return undefined
	}
}

/** Express middleware: allow if a valid API key OR a valid Cloudflare Access JWT is present. */
export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	if (config.auth.disabled) {
		req.principal = { kind: 'anonymous', id: 'anonymous' }
		next()
		return
	}

	const principal = verifyApiKey(req) ?? (await verifyCloudflare(req))
	if (principal) {
		req.principal = principal
		next()
		return
	}

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
