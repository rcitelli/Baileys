import { ALL_WEBHOOK_EVENTS } from './types.js'

/** Bump when the API surface documented here changes. */
export const DOCS_VERSION = '1.0.0'

/** Build the full API reference as Markdown, stamped with the docs + library versions. */
export const buildApiDocs = (libraryVersion: string): string => {
	const generated = new Date().toISOString()
	const events = ALL_WEBHOOK_EVENTS.map(e => `\`${e}\``).join(', ')

	return `# Baileys Hub — Referência da API

| | |
|---|---|
| **Versão da documentação** | ${DOCS_VERSION} |
| **Versão da biblioteca Baileys** | ${libraryVersion} |
| **Gerado em** | ${generated} |

Servidor central de WhatsApp (multi-sessão) sobre a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys).
Todas as rotas ficam sob o prefixo \`/api\`.

---

## Autenticação

Toda rota \`/api/*\` exige **uma** das provas:

- **API Key** (aplicações / server-to-server) — header \`Authorization: Bearer <chave>\` (ou \`x-api-key: <chave>\`). As chaves são criadas no painel (aba Aplicativos) ou definidas em \`API_KEYS\` no \`.env\`.
- **Cloudflare Access** (navegador) — o JWT injetado por Cloudflare é verificado na origem.

No hostname público do painel, uma API Key sozinha é recusada — chamadas de máquina usam a rede interna (\`127.0.0.1\` / rede Docker).

### Formato de erro
\`\`\`json
{ "error": "nome", "message": "descrição legível" }
\`\`\`
Códigos: \`400\` inválido · \`401\` não autenticado · \`403\` proibido (ex.: API Key tentando gerenciar apps) · \`404\` não encontrado · \`409\` conflito/sessão não conectada · \`429\` rate limit.

---

## Sessões

| Método | Rota | Descrição |
|---|---|---|
| GET | \`/api/sessions\` | Lista todas as sessões com status. |
| POST | \`/api/sessions\` | Cria uma sessão. Body: \`{ id?, name?, webhookUrl?, webhookEvents? }\`. |
| GET | \`/api/sessions/:id\` | Detalhes/status. |
| PATCH | \`/api/sessions/:id\` | Atualiza \`name\`, \`webhookUrl\`, \`webhookEvents\`. |
| DELETE | \`/api/sessions/:id\` | Desloga e apaga as credenciais do disco. |
| POST | \`/api/sessions/:id/restart\` | Reinicia o socket (mantém credenciais). |
| POST | \`/api/sessions/:id/logout\` | Desloga do aparelho (exige novo QR). |
| GET | \`/api/sessions/:id/qr\` | \`{ status, qr, qrImage }\` — \`qrImage\` é um data URL PNG. |
| GET | \`/api/sessions/:id/events\` | **SSE**: stream de \`{ info, qr }\` a cada mudança. |
| POST | \`/api/sessions/:id/pairing-code\` | Body \`{ phoneNumber }\` → código de pareamento. |

### Objeto \`SessionInfo\`
\`\`\`json
{
  "id": "vendas", "name": "Atendimento Vendas",
  "status": "open", "jid": "5511999999999@s.whatsapp.net",
  "phoneNumber": "5511999999999", "pushName": "Vendas",
  "webhookUrl": "https://app/webhook", "webhookEvents": ["messages.upsert"],
  "hasQr": false, "lastConnectedAt": "2026-08-30T00:00:00.000Z"
}
\`\`\`
\`status\`: \`idle\` · \`connecting\` · \`qr\` · \`pairing\` · \`open\` · \`close\` · \`logged_out\`.

---

## Mensagens

| Método | Rota | Body | Descrição |
|---|---|---|---|
| POST | \`/api/sessions/:id/send-text\` | \`{ to, text, options? }\` | Envia texto. |
| POST | \`/api/sessions/:id/send\` | \`{ to, message, options? }\` | Envia qualquer \`AnyMessageContent\` do Baileys (imagem, documento, etc.). |
| POST | \`/api/sessions/:id/check\` | \`{ numbers }\` | Verifica se números têm WhatsApp. |
| POST | \`/api/sessions/:id/presence\` | \`{ type, to? }\` | Atualiza presença (\`composing\`, \`available\`…). |
| POST | \`/api/sessions/:id/read\` | \`{ keys }\` | Marca mensagens como lidas. |

\`to\` aceita número puro (\`5511999999999\` → \`...@s.whatsapp.net\`) ou um JID completo (grupos: \`...@g.us\`).

**Exemplos**
\`\`\`bash
# texto
curl -X POST https://wpp.elosolar.com.br/api/sessions/vendas/send-text \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"to":"5511999999999","text":"Olá!"}'

# imagem por URL
curl -X POST https://wpp.elosolar.com.br/api/sessions/vendas/send \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"to":"5511999999999","message":{"image":{"url":"https://.../f.jpg"},"caption":"oi"}}'
\`\`\`

---

## Contatos e histórico (por sessão)

| Método | Rota | Descrição |
|---|---|---|
| GET | \`/api/sessions/:id/contacts\` | Contatos conhecidos (ao vivo, em memória — não persistido). |
| GET | \`/api/sessions/:id/chats\` | Conversas conhecidas (ao vivo, em memória). |
| GET | \`/api/sessions/:id/history?limit=100\` | Histórico de interações — **metadados apenas** (sem conteúdo). |

Registro de histórico:
\`\`\`json
{ "t": 1788048000000, "dir": "in", "chat": "5511...@s.whatsapp.net", "type": "conversation", "id": "ABCD", "status": "2" }
\`\`\`
> O conteúdo das mensagens **não** é armazenado no servidor. Ele chega às suas aplicações por webhook, e cada uma decide se guarda.

---

## Sistema

| Método | Rota | Descrição |
|---|---|---|
| GET | \`/api/system/info\` | Usuário logado, versão, status. |
| GET | \`/api/system/health\` | Uptime, memória, armazenamento/disco, sessões. |
| GET | \`/api/system/updates\` | Verifica atualizações do Baileys no GitHub (\`?refresh=1\` força). |
| GET | \`/api/system/apps\` | Lista apps gerenciados + chaves legadas (mascaradas). |
| POST | \`/api/system/apps\` | Cria app. Body \`{ name }\` → \`{ app, key }\` (chave exibida uma vez). *Requer usuário do painel.* |
| PATCH | \`/api/system/apps/:id\` | \`{ name?, enabled? }\`. *Requer usuário do painel.* |
| DELETE | \`/api/system/apps/:id\` | Revoga a chave. *Requer usuário do painel.* |
| GET | \`/api/system/api-docs\` | Esta documentação em Markdown. |

---

## Webhooks (entrega de eventos às suas apps)

Cada sessão pode ter uma \`webhookUrl\`. Em cada evento inscrito, o servidor faz \`POST\`:
\`\`\`json
{
  "sessionId": "vendas",
  "event": "messages.upsert",
  "timestamp": "2026-08-30T00:00:00.000Z",
  "data": { "...payload nativo do Baileys..." }
}
\`\`\`
Headers: \`X-Webhook-Event\`, \`X-Webhook-Session\` e, se configurado, \`X-Webhook-Secret\` (valide no destino). Entregas com falha são reenviadas com backoff exponencial.

**Eventos disponíveis:** ${events}.

---

_Documento gerado automaticamente pelo Baileys Hub (v${DOCS_VERSION}). Baixe sempre a versão mais recente pelo painel → aba **API**._
`
}
