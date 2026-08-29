import { readdir, readFile, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { logger } from './logger.js'

const UPSTREAM_REPO = 'WhiskeySockets/Baileys'
const UPSTREAM_BRANCH = 'master'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1h — GitHub unauth limit is 60 req/h/IP

export interface UpdateInfo {
	/** Version of the Baileys library this server was built against */
	current: string
	/** Version declared on the upstream default branch's package.json */
	upstream?: string
	updateAvailable: boolean
	latestRelease?: { tag: string; name?: string; url: string; publishedAt?: string }
	lastCommit?: { sha: string; shortSha: string; date?: string; url: string; message?: string }
	repo: string
	branch: string
	checkedAt: string
	error?: string
}

let cachedVersion: string | undefined

/** Read the Baileys library version from the parent package.json (../../package.json). */
export const getCurrentVersion = async (): Promise<string> => {
	if (cachedVersion) {
		return cachedVersion
	}

	try {
		const here = dirname(fileURLToPath(import.meta.url)) // <root>/server/src
		const raw = await readFile(join(here, '..', '..', 'package.json'), 'utf-8')
		cachedVersion = (JSON.parse(raw).version as string) || 'unknown'
	} catch {
		cachedVersion = 'unknown'
	}

	return cachedVersion
}

const parseVersion = (value: string): { nums: number[]; pre: string } => {
	const [core, ...preParts] = value.replace(/^v/, '').split('-')
	const nums = (core ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
	return { nums, pre: preParts.join('-') }
}

/** Semver-ish compare: >0 if a is newer than b. A missing prerelease outranks a present one. */
const compareVersions = (a: string, b: string): number => {
	const pa = parseVersion(a)
	const pb = parseVersion(b)
	for (let i = 0; i < 3; i++) {
		const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0)
		if (diff !== 0) {
			return diff > 0 ? 1 : -1
		}
	}

	if (pa.pre === pb.pre) {
		return 0
	}

	if (!pa.pre) {
		return 1
	}

	if (!pb.pre) {
		return -1
	}

	return pa.pre > pb.pre ? 1 : -1
}

const ghFetch = async (url: string, accept = 'application/vnd.github+json'): Promise<Response> =>
	fetch(url, {
		headers: { 'User-Agent': 'baileys-server', Accept: accept },
		signal: AbortSignal.timeout(8000)
	})

let cache: { at: number; data: UpdateInfo } | undefined

/** Check the upstream Baileys repo on GitHub for a newer version. Cached for an hour. */
export const checkUpdates = async (force = false): Promise<UpdateInfo> => {
	if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
		return cache.data
	}

	const current = await getCurrentVersion()
	const info: UpdateInfo = {
		current,
		updateAvailable: false,
		repo: UPSTREAM_REPO,
		branch: UPSTREAM_BRANCH,
		checkedAt: new Date().toISOString()
	}

	try {
		const [pkgRes, releaseRes, commitRes] = await Promise.all([
			ghFetch(
				`https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/package.json`,
				'application/json'
			),
			ghFetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=1`),
			ghFetch(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/${UPSTREAM_BRANCH}`)
		])

		if (pkgRes.ok) {
			const pkg = (await pkgRes.json()) as { version?: string }
			info.upstream = pkg.version
			if (pkg.version && current !== 'unknown') {
				info.updateAvailable = compareVersions(pkg.version, current) > 0
			}
		}

		if (releaseRes.ok) {
			const releases = (await releaseRes.json()) as Array<{
				tag_name?: string
				name?: string
				html_url?: string
				published_at?: string
			}>
			const latest = releases[0]
			if (latest?.tag_name && latest.html_url) {
				info.latestRelease = {
					tag: latest.tag_name,
					name: latest.name || undefined,
					url: latest.html_url,
					publishedAt: latest.published_at || undefined
				}
			}
		}

		if (commitRes.ok) {
			const commit = (await commitRes.json()) as {
				sha?: string
				html_url?: string
				commit?: { message?: string; author?: { date?: string } }
			}
			if (commit.sha && commit.html_url) {
				info.lastCommit = {
					sha: commit.sha,
					shortSha: commit.sha.slice(0, 7),
					date: commit.commit?.author?.date,
					url: commit.html_url,
					message: commit.commit?.message?.split('\n')[0]
				}
			}
		}

		if (!pkgRes.ok && !releaseRes.ok && !commitRes.ok) {
			info.error = 'Não foi possível consultar o GitHub (rate limit ou rede).'
		}
	} catch (error) {
		info.error = (error as Error).message
		logger.warn({ err: info.error }, 'update check failed')
	}

	cache = { at: Date.now(), data: info }
	return info
}

export interface HealthInfo {
	uptimeSeconds: number
	startedAt: string
	node: string
	platform: string
	memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number }
	storage: { dataDir: string; usedBytes: number; diskTotalBytes?: number; diskFreeBytes?: number }
}

const dirSize = async (dir: string): Promise<number> => {
	let total = 0
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return 0
	}

	for (const entry of entries) {
		const full = join(dir, entry.name)
		try {
			if (entry.isDirectory()) {
				total += await dirSize(full)
			} else {
				total += (await stat(full)).size
			}
		} catch {
			// ignore unreadable entries
		}
	}

	return total
}

const startedAt = new Date()

/** Runtime health: process uptime/memory and data-dir + disk storage usage. */
export const getHealth = async (): Promise<HealthInfo> => {
	const mem = process.memoryUsage()
	const storage: HealthInfo['storage'] = {
		dataDir: config.dataDir,
		usedBytes: await dirSize(config.dataDir)
	}

	try {
		const fsStat = await statfs(config.dataDir)
		storage.diskTotalBytes = fsStat.blocks * fsStat.bsize
		storage.diskFreeBytes = fsStat.bavail * fsStat.bsize
	} catch {
		// statfs unavailable — leave disk figures undefined
	}

	return {
		uptimeSeconds: Math.round(process.uptime()),
		startedAt: startedAt.toISOString(),
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal },
		storage
	}
}

export interface ApiClientUsage {
	count: number
	lastUsedAt?: string
	lastIp?: string
}

const usage = new Map<number, ApiClientUsage>()

/** Record a successful API-key authentication for the given key index (usage stats). */
export const recordApiKeyUse = (index: number, ip?: string): void => {
	const current = usage.get(index) ?? { count: 0 }
	usage.set(index, { count: current.count + 1, lastUsedAt: new Date().toISOString(), lastIp: ip })
}

export interface ApiClient {
	id: number
	masked: string
	count: number
	lastUsedAt?: string
	lastIp?: string
}

/** API-key "apps" derived from config, with the raw key masked and live usage stats. */
export const listApiClients = (): ApiClient[] =>
	config.auth.apiKeys.map((key, index) => {
		const u = usage.get(index)
		return {
			id: index + 1,
			masked: key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••',
			count: u?.count ?? 0,
			lastUsedAt: u?.lastUsedAt,
			lastIp: u?.lastIp
		}
	})

