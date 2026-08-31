#!/usr/bin/env node
/**
 * Operator helper to create/list empresas (tenants) and mint their API keys,
 * without opening the panel. Talks to the running server over localhost using an
 * admin key it reads from the environment (ADMIN_KEY, or the first API_KEYS entry).
 *
 * Run it INSIDE the container so it shares the server's env and localhost:
 *   docker compose exec baileys-server node scripts/manage-empresas.mjs list
 *   docker compose exec baileys-server node scripts/manage-empresas.mjs create "Elo Financeiro" "Elo CRM"
 */

const BASE = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
const KEY = process.env.ADMIN_KEY || (process.env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)[0]

if (!KEY) {
	console.error(
		'Nenhuma chave admin encontrada. Defina ADMIN_KEY, ou mantenha ao menos uma chave em API_KEYS no .env.'
	)
	process.exit(1)
}

const api = async (path, opts = {}) => {
	const res = await fetch(BASE + path, {
		...opts,
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) }
	})
	const data = await res.json().catch(() => ({}))
	if (!res.ok) {
		throw new Error(`${res.status} ${data.message || res.statusText}`)
	}

	return data
}

const [cmd, ...names] = process.argv.slice(2)

const run = async () => {
	if (cmd === 'list' || !cmd) {
		const { apps } = await api('/api/system/apps')
		if (!apps.length) {
			console.log('Nenhuma empresa cadastrada.')
			return
		}

		console.log('\nEMPRESAS\n' + '-'.repeat(60))
		for (const a of apps) {
			console.log(
				`${a.enabled ? '●' : '○'} ${a.name.padEnd(28)} slug=${a.slug.padEnd(20)} chave=${a.keyPrefix} req=${a.requests}`
			)
		}
		console.log('\n(as chaves completas não são recuperáveis — só o prefixo)\n')
		return
	}

	if (cmd === 'create') {
		if (!names.length) {
			console.error('Uso: create "Nome da Empresa" ["Outra Empresa" ...]')
			process.exit(1)
		}

		console.log('\nGUARDE ESTAS CHAVES — elas só aparecem agora:\n' + '='.repeat(70))
		for (const name of names) {
			try {
				const { app, key } = await api('/api/system/apps', {
					method: 'POST',
					body: JSON.stringify({ name })
				})
				console.log(`\nEmpresa : ${app.name}\nSlug    : ${app.slug}\nAPI Key : ${key}`)
			} catch (err) {
				console.error(`\nFalha ao criar "${name}": ${err.message}`)
			}
		}
		console.log('\n' + '='.repeat(70))
		console.log('Cole cada API Key na config da app correspondente (header Authorization: Bearer <key>).\n')
		return
	}

	console.error('Comandos: list | create "Nome" [...]')
	process.exit(1)
}

run().catch(err => {
	console.error('Erro:', err.message)
	process.exit(1)
})
