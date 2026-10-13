/**
 * Interactive messages (reply buttons, lists, call-to-action buttons) over the
 * WhatsApp Web protocol.
 *
 * WhatsApp only renders these for "business" sends: the stanza must carry an
 * unencrypted `<biz>` node next to the encrypted payload. Upstream Baileys
 * removed every button helper (PR #956) and refuses to bring them back, so the
 * shapes below are kept HERE, in the server, as named RECIPES. When WhatsApp
 * changes something and the community finds the new shape, a recipe changes (or a
 * new one is added) and callers pick it by name — no caller code moves.
 *
 * The default recipes follow the shapes live-tested on 7.0.0-rc14 in Oct 2026
 * (Baileys PR #2849, Evolution API 2.4.0-rc, Wuzapi):
 * - reply buttons: the LEGACY `buttonsMessage` inside `documentWithCaptionMessage`
 *   + full `biz` node (native `quick_reply` renders on iOS with the choices disabled);
 * - list: the classic `listMessage` SINGLE_SELECT + `biz > list product_list`
 *   (1:1 chats only — lists do not render in groups);
 * - call-to-action (url / copy / call): `interactiveMessage` native flow + the
 *   minimal `biz` node. Never mixed with reply buttons in one message (WhatsApp
 *   Web/Desktop then refuses to show it).
 * No `bot` node (it adds an "AI" badge and disabled buttons in tests) and no
 * view-once wrapper (WhatsApp Web stops loading the message).
 *
 * None of this is official: it can stop rendering with any WhatsApp update, and a
 * send that "succeeds" may never be delivered. Callers must always carry a text
 * fallback and watch the delivery receipt.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { Boom } from '@hapi/boom'
import { type BinaryNode, getDevice, normalizeMessageContent, proto } from './wa.js'

export const MAX_REPLY_BUTTONS = 3
export const MAX_CTA_BUTTONS = 2
export const MAX_LIST_ROWS = 10

export interface ReplyButton {
	id: string
	text: string
}

export interface ListRow {
	id: string
	title: string
	description?: string
}

export interface ListSection {
	title?: string
	rows: ListRow[]
}

export type CtaButton =
	| { type: 'url'; text: string; url: string }
	| { type: 'copy'; text: string; code: string }
	| { type: 'call'; text: string; phone: string }

export type InteractiveSpec =
	| { kind: 'buttons'; text: string; footer?: string; buttons: ReplyButton[] }
	| { kind: 'list'; text: string; footer?: string; title?: string; buttonText: string; sections: ListSection[] }
	| { kind: 'cta'; text: string; footer?: string; buttons: CtaButton[] }

export type InteractiveKind = InteractiveSpec['kind']

interface Recipe {
	kind: InteractiveKind
	description: string
	build: (spec: InteractiveSpec, ctx: BuildContext) => proto.IMessage
	nodes: (ctx: BuildContext) => BinaryNode[]
}

interface BuildContext {
	isGroup: boolean
	nowSeconds: number
}

// ---- biz nodes ---------------------------------------------------------------

const nativeFlowChild = (): BinaryNode => ({
	tag: 'interactive',
	attrs: { type: 'native_flow', v: '1' },
	content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
})

/** `biz > interactive > native_flow(mixed)` — what Evolution/Wuzapi/wa-js send. */
const minimalBizNode = (): BinaryNode[] => [{ tag: 'biz', attrs: {}, content: [nativeFlowChild()] }]

/** The node copied from official traffic (PR #2849, whatsmeow #1235, itsliaaa). */
const fullBizNode = (ctx: BuildContext): BinaryNode[] => [
	{
		tag: 'biz',
		attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: String(ctx.nowSeconds) },
		content: [
			nativeFlowChild(),
			{
				tag: 'quality_control',
				attrs: { decision_id: randomBytes(20).toString('hex'), source_type: 'third_party' },
				content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
			}
		]
	}
]

const listBizNode = (): BinaryNode[] => [
	{ tag: 'biz', attrs: {}, content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }] }
]

/** Opaque per-message metadata the official client sends; 1:1 only gets the device list. */
const contextInfo = (ctx: BuildContext): proto.IMessageContextInfo => ({
	messageSecret: randomBytes(32),
	...(ctx.isGroup
		? {}
		: {
				deviceListMetadata: { recipientKeyHash: randomBytes(10), recipientTimestamp: ctx.nowSeconds },
				deviceListMetadataVersion: 2
			})
})

// ---- builders -----------------------------------------------------------------

const asButtons = (spec: InteractiveSpec) => spec as Extract<InteractiveSpec, { kind: 'buttons' }>
const asList = (spec: InteractiveSpec) => spec as Extract<InteractiveSpec, { kind: 'list' }>
const asCta = (spec: InteractiveSpec) => spec as Extract<InteractiveSpec, { kind: 'cta' }>

const legacyButtons = (spec: InteractiveSpec): proto.IMessage['buttonsMessage'] => {
	const s = asButtons(spec)
	return {
		contentText: s.text,
		...(s.footer ? { footerText: s.footer } : {}),
		headerType: proto.Message.ButtonsMessage.HeaderType.EMPTY,
		buttons: s.buttons.map(b => ({
			buttonId: b.id,
			buttonText: { displayText: b.text },
			type: proto.Message.ButtonsMessage.Button.Type.RESPONSE
		}))
	}
}

const ctaButton = (b: CtaButton) => {
	if (b.type === 'url') {
		return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.url, merchant_url: b.url }) }
	}

	if (b.type === 'copy') {
		return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: b.text, copy_code: b.code }) }
	}

	return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: b.text, phone_number: b.phone }) }
}

const listMessage = (spec: InteractiveSpec): proto.Message.IListMessage => {
	const s = asList(spec)
	return {
		title: s.title ?? '',
		description: s.text,
		buttonText: s.buttonText,
		...(s.footer ? { footerText: s.footer } : {}),
		listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
		sections: s.sections.map(sec => ({
			title: sec.title ?? '',
			rows: sec.rows.map(r => ({ rowId: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) }))
		}))
	}
}

export const RECIPES: Record<string, Recipe> = {
	'buttons.legacy_doc': {
		kind: 'buttons',
		description: 'buttonsMessage in documentWithCaptionMessage + full biz node (iOS and Web clickable, Oct 2026)',
		build: (spec, ctx) => ({
			messageContextInfo: contextInfo(ctx),
			documentWithCaptionMessage: { message: { buttonsMessage: legacyButtons(spec) } }
		}),
		nodes: fullBizNode
	},
	'buttons.native_flow': {
		kind: 'buttons',
		description: 'interactiveMessage quick_reply + minimal biz node (renders; iOS showed choices disabled)',
		build: (spec, ctx) => {
			const s = asButtons(spec)
			return {
				messageContextInfo: contextInfo(ctx),
				interactiveMessage: {
					body: { text: s.text },
					...(s.footer ? { footer: { text: s.footer } } : {}),
					nativeFlowMessage: {
						buttons: s.buttons.map(b => ({
							name: 'quick_reply',
							buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id })
						})),
						messageParamsJson: JSON.stringify({ from: 'api', templateId: randomUUID() }),
						messageVersion: 1
					}
				}
			}
		},
		nodes: minimalBizNode
	},
	'list.legacy': {
		kind: 'list',
		description: 'classic listMessage SINGLE_SELECT + biz list node (iOS and Web, 1:1 only)',
		build: spec => ({ listMessage: listMessage(spec) }),
		nodes: listBizNode
	},
	'list.legacy_doc': {
		kind: 'list',
		description: 'listMessage inside documentWithCaptionMessage + biz list node (Wuzapi shape)',
		build: spec => ({ documentWithCaptionMessage: { message: { listMessage: listMessage(spec) } } }),
		nodes: listBizNode
	},
	'cta.native_flow': {
		kind: 'cta',
		description: 'interactiveMessage cta_url / cta_copy / cta_call + minimal biz node',
		build: spec => {
			const s = asCta(spec)
			return {
				interactiveMessage: {
					body: { text: s.text },
					...(s.footer ? { footer: { text: s.footer } } : {}),
					nativeFlowMessage: {
						buttons: s.buttons.map(ctaButton),
						messageParamsJson: JSON.stringify({ from: 'api', templateId: randomUUID() })
					}
				}
			}
		},
		nodes: minimalBizNode
	}
}

/** The recipe used for each kind when the caller names none. */
export const DEFAULT_RECIPES: Record<InteractiveKind, string> = {
	buttons: 'buttons.legacy_doc',
	list: 'list.legacy',
	cta: 'cta.native_flow'
}

export const listRecipes = () =>
	Object.entries(RECIPES).map(([name, r]) => ({
		name,
		kind: r.kind,
		description: r.description,
		default: DEFAULT_RECIPES[r.kind] === name
	}))

// ---- validation ---------------------------------------------------------------

const bad = (message: string): never => {
	throw new Boom(message, { statusCode: 400 })
}

const text = (value: unknown, field: string, max: number): string => {
	if (typeof value !== 'string' || !value.trim()) {
		return bad(`\`${field}\` is required`)
	}

	if (value.length > max) {
		bad(`\`${field}\` is longer than ${max} characters`)
	}

	return value
}

const optionalText = (value: unknown, field: string, max: number): string | undefined =>
	value === undefined || value === null || value === '' ? undefined : text(value, field, max)

const array = (value: unknown, field: string, min: number, max: number): unknown[] => {
	if (!Array.isArray(value) || value.length < min) {
		return bad(`\`${field}\` needs at least ${min} item(s)`)
	}

	if (value.length > max) {
		bad(`\`${field}\` allows at most ${max} item(s)`)
	}

	return value
}

const record = (value: unknown, field: string): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return bad(`\`${field}\` must be an object`)
	}

	return value as Record<string, unknown>
}

const uniqueIds = (ids: string[], field: string) => {
	if (new Set(ids).size !== ids.length) {
		bad(`\`${field}\` ids must be unique`)
	}
}

/**
 * Validates a request body into an `InteractiveSpec`. Limits are WhatsApp's own
 * (3 reply buttons, 10 list rows, 20-char button labels) — beyond them the
 * message is silently not rendered, so it is better to refuse here.
 */
export const parseSpec = (body: unknown): InteractiveSpec => {
	const b = record(body, 'interactive')
	const kind = b.kind
	const bodyText = text(b.text, 'text', 1024)
	const footer = optionalText(b.footer, 'footer', 60)
	if (kind === 'buttons') {
		const buttons = array(b.buttons, 'buttons', 1, MAX_REPLY_BUTTONS).map((raw, i) => {
			const btn = record(raw, `buttons[${i}]`)
			return { id: text(btn.id, `buttons[${i}].id`, 256), text: text(btn.text, `buttons[${i}].text`, 20) }
		})
		uniqueIds(buttons.map(x => x.id), 'buttons')
		return { kind, text: bodyText, footer, buttons }
	}

	if (kind === 'list') {
		const sections = array(b.sections, 'sections', 1, MAX_LIST_ROWS).map((raw, i) => {
			const sec = record(raw, `sections[${i}]`)
			return {
				title: optionalText(sec.title, `sections[${i}].title`, 24),
				rows: array(sec.rows, `sections[${i}].rows`, 1, MAX_LIST_ROWS).map((rr, j) => {
					const row = record(rr, `sections[${i}].rows[${j}]`)
					return {
						id: text(row.id, `rows[${j}].id`, 200),
						title: text(row.title, `rows[${j}].title`, 24),
						description: optionalText(row.description, `rows[${j}].description`, 72)
					}
				})
			}
		})
		const rows = sections.flatMap(s => s.rows)
		if (rows.length > MAX_LIST_ROWS) {
			bad(`a list allows at most ${MAX_LIST_ROWS} rows in total`)
		}

		uniqueIds(rows.map(r => r.id), 'rows')
		return {
			kind,
			text: bodyText,
			footer,
			title: optionalText(b.title, 'title', 60),
			buttonText: text(b.buttonText, 'buttonText', 20),
			sections
		}
	}

	if (kind === 'cta') {
		const buttons = array(b.buttons, 'buttons', 1, MAX_CTA_BUTTONS).map((raw, i): CtaButton => {
			const btn = record(raw, `buttons[${i}]`)
			const label = text(btn.text, `buttons[${i}].text`, 20)
			if (btn.type === 'url') {
				const url = text(btn.url, `buttons[${i}].url`, 2000)
				if (!/^https?:\/\//i.test(url)) {
					bad(`\`buttons[${i}].url\` must be an absolute http(s) URL`)
				}

				return { type: 'url', text: label, url }
			}

			if (btn.type === 'copy') {
				return { type: 'copy', text: label, code: text(btn.code, `buttons[${i}].code`, 512) }
			}

			if (btn.type === 'call') {
				return { type: 'call', text: label, phone: text(btn.phone, `buttons[${i}].phone`, 20) }
			}

			return bad(`\`buttons[${i}].type\` must be url, copy or call`)
		})
		return { kind, text: bodyText, footer, buttons }
	}

	return bad('`kind` must be buttons, list or cta')
}

/** Picks the recipe (named or the kind's default) and refuses one of another kind. */
export const resolveRecipe = (spec: InteractiveSpec, name?: unknown): { name: string; recipe: Recipe } => {
	const chosen = typeof name === 'string' && name ? name : DEFAULT_RECIPES[spec.kind]
	const recipe = RECIPES[chosen]
	if (!recipe) {
		return bad(`unknown recipe \`${chosen}\``)
	}

	if (recipe.kind !== spec.kind) {
		bad(`recipe \`${chosen}\` is for ${recipe.kind}, not ${spec.kind}`)
	}

	return { name: chosen, recipe }
}

export const buildInteractive = (spec: InteractiveSpec, recipe: Recipe, isGroup: boolean) => {
	if (spec.kind === 'list' && isGroup) {
		bad('lists do not render in groups; use reply buttons')
	}

	const ctx: BuildContext = { isGroup, nowSeconds: Math.floor(Date.now() / 1000) }
	return { message: recipe.build(spec, ctx), additionalNodes: recipe.nodes(ctx) }
}

// ---- replies ------------------------------------------------------------------

/** A click (or list pick) normalised from any of the four shapes WhatsApp sends back. */
export interface InteractiveReply {
	/** wire shape it came in */
	type: 'buttons' | 'list' | 'template' | 'native_flow'
	/** the id WE put in the button/row */
	id: string
	/** label the user saw */
	text?: string
	/** id of the message that carried the button */
	quotedId?: string
	/** device that sent the click, guessed from the reply message id */
	device: string
}

const parseParamsId = (paramsJson: unknown): string | undefined => {
	if (typeof paramsJson !== 'string') {
		return undefined
	}

	try {
		const parsed = JSON.parse(paramsJson) as { id?: unknown }
		return typeof parsed.id === 'string' ? parsed.id : undefined
	} catch {
		return undefined
	}
}

/**
 * The reply carried by an incoming message, or undefined when it is not a click.
 * Shapes seen in the wild (PR #2849 fixtures, Oct 2026):
 * `buttonsResponseMessage.selectedButtonId` (legacy buttons), `listResponseMessage
 * .singleSelectReply.selectedRowId` (list), `templateButtonReplyMessage.selectedId`
 * (native quick_reply tapped on Web) and `interactiveResponseMessage
 * .nativeFlowResponseMessage.paramsJson {"id"}` (native flow on mobile).
 */
export const extractInteractiveReply = (msg: {
	key?: { id?: string | null }
	message?: unknown
}): InteractiveReply | undefined => {
	const content = normalizeMessageContent(msg.message as proto.IMessage | undefined)
	if (!content) {
		return undefined
	}

	const device = msg.key?.id ? getDevice(msg.key.id) : 'unknown'
	const b = content.buttonsResponseMessage
	if (b?.selectedButtonId) {
		return {
			type: 'buttons',
			id: b.selectedButtonId,
			text: b.selectedDisplayText ?? undefined,
			quotedId: b.contextInfo?.stanzaId ?? undefined,
			device
		}
	}

	const l = content.listResponseMessage
	if (l?.singleSelectReply?.selectedRowId) {
		return {
			type: 'list',
			id: l.singleSelectReply.selectedRowId,
			text: l.title ?? undefined,
			quotedId: l.contextInfo?.stanzaId ?? undefined,
			device
		}
	}

	const t = content.templateButtonReplyMessage
	if (t?.selectedId) {
		return {
			type: 'template',
			id: t.selectedId,
			text: t.selectedDisplayText ?? undefined,
			quotedId: t.contextInfo?.stanzaId ?? undefined,
			device
		}
	}

	const n = content.interactiveResponseMessage
	const nativeId = parseParamsId(n?.nativeFlowResponseMessage?.paramsJson)
	if (nativeId) {
		return {
			type: 'native_flow',
			id: nativeId,
			text: n?.body?.text ?? undefined,
			quotedId: n?.contextInfo?.stanzaId ?? undefined,
			device
		}
	}

	return undefined
}
