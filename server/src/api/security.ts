import { createHash } from 'node:crypto'
import type { Request, RequestHandler } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import helmet from 'helmet'
import { config } from '../config.js'

/**
 * Security headers. The panel is a self-contained page that uses inline <style>/<script>
 * and renders the QR as a data: URL, so the CSP allows inline + data: images but nothing
 * cross-origin. frameguard denies embedding (anti-clickjacking).
 */
export const securityHeaders: RequestHandler = helmet({
	contentSecurityPolicy: {
		useDefaults: true,
		directives: {
			defaultSrc: ["'self'"],
			scriptSrc: ["'self'", "'unsafe-inline'"],
			styleSrc: ["'self'", "'unsafe-inline'"],
			imgSrc: ["'self'", 'data:'],
			connectSrc: ["'self'"],
			objectSrc: ["'none'"],
			frameAncestors: ["'none'"],
			baseUri: ["'self'"]
		}
	},
	crossOriginEmbedderPolicy: false
})

/** Bucket by identity when possible (API key / CF user) so one client can't starve others. */
const keyByPrincipalOrIp = (req: Request): string => {
	const auth = req.header('authorization')
	const apiKey = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : req.header('x-api-key')?.trim()
	if (apiKey) {
		return 'k:' + createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
	}

	const cfUser = req.header('cf-access-authenticated-user-email')
	if (cfUser) {
		return 'u:' + cfUser
	}

	return 'ip:' + ipKeyGenerator(req.header('cf-connecting-ip') || req.ip || '0.0.0.0')
}

const message = { error: 'rate_limited', message: 'Too many requests, slow down.' }

/** General limiter applied to the whole /api surface. */
export const apiLimiter = rateLimit({
	windowMs: config.rateLimit.windowMs,
	limit: config.rateLimit.max,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	keyGenerator: keyByPrincipalOrIp,
	message
})

/** Stricter limiter for expensive/abusable actions (session create, message send). */
export const sensitiveLimiter = rateLimit({
	windowMs: config.rateLimit.windowMs,
	limit: config.rateLimit.sensitiveMax,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	keyGenerator: keyByPrincipalOrIp,
	message
})
