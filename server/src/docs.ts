import { ALL_WEBHOOK_EVENTS } from './types.js'

/** Bump when the API surface documented here changes. */
export const DOCS_VERSION = '1.3.0'

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

### Isolamento por empresa (multi-tenant)

Cada chave de empresa é **isolada**: com ela, a empresa só enxerga e controla as **próprias** sessões.

- Os IDs de sessão têm **namespace por empresa** — a Empresa A e a B podem ambas usar \`vendas\` sem conflito. Na API, cada empresa usa seu ID local (ex.: \`vendas\`); internamente vira \`<empresa>__vendas\`.
- \`GET /api/sessions\` retorna apenas as sessões da empresa autenticada.
- Tentar acessar uma sessão de outra empresa retorna \`404\` (como se não existisse).
- O **operador** (login Cloudflare Access, ou chave do \`.env\`) tem visão de administrador: vê e gerencia as sessões de todas as empresas.

### Formato de erro
\`\`\`json
{ "error": "nome", "message": "descrição legível" }
\`\`\`
Códigos: \`400\` inválido · \`401\` não autenticado · \`403\` proibido (ex.: API Key tentando gerenciar apps) · \`404\` não encontrado · \`409\` conflito/sessão não conectada · \`429\` rate limit.

---

## Sessões

| Método | Rota | Descrição |
|---|---|---|
| GET | \`/api/sessions\` | Lista as sessões da empresa autenticada (todas, se operador). |
| POST | \`/api/sessions\` | Cria uma sessão. Body: \`{ id?, name?, webhookUrl?, webhookEvents? }\`. \`id\` é o identificador **local** da empresa (único dentro dela). O operador pode passar \`ownerAppId\` para atribuir a sessão a uma empresa. |
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

Para uma empresa, \`id\` é o seu identificador local. Para o operador, \`id\` é o global (\`<empresa>__<local>\`) e a resposta inclui \`ownerName\` (empresa dona).

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
curl -X POST https://api.wpp.elosolar.com.br/api/sessions/vendas/send-text \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"to":"5511999999999","text":"Olá!"}'

# imagem por URL
curl -X POST https://api.wpp.elosolar.com.br/api/sessions/vendas/send \\
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
| POST | \`/api/sessions/:id/history/full\` | **Histórico completo sem re-parear**: pede ao celular todo o histórico (\`FULL_HISTORY_SYNC_ON_DEMAND\`). Body: \`{ days? }\`. Responde \`202\`; o histórico chega pelo webhook \`messaging-history.set\`. A resposta do celular (aceitou/recusou) aparece em \`/history/sync\`. |
| POST | \`/api/sessions/:id/history/backfill\` | **Backfill sem re-parear**: para cada conversa com alguma mensagem conhecida, busca as mais antigas de 50 em 50 até \`days\` (padrão \`BACKFILL_DAYS\`=90). Body: \`{ days?, anchors?, maxPagesPerChat?, intervalMs? }\` — \`anchors\` (\`[{ remoteJid, id, fromMe, timestamp }]\`) acrescenta conversas que o servidor não conhece. Roda em segundo plano; os lotes chegam com \`origin: "backfill"\`. |
| DELETE | \`/api/sessions/:id/history/backfill\` | Interrompe o backfill em andamento. |
| GET | \`/api/sessions/:id/history/sync\` | Estado: \`{ platform, full, backfill }\` — resposta do celular ao pedido completo e progresso do backfill (conversas, pedidos, mensagens, timeouts). |
| POST | \`/api/sessions/:id/chats/:jid/history\` | **Lê o histórico de uma conversa e devolve na resposta** (não só pelo webhook). Pagina para trás a partir da mensagem mais antiga conhecida; com \`full: true\`, segue até o início da conversa. Detalhes abaixo. |
| POST | \`/api/sessions/:id/history/fetch\` | Pede ao celular mensagens **mais antigas** de uma conversa (até 50 por pedido). Body: \`{ jid \\| to, count?, anchor? }\`. Responde \`202\`; as mensagens chegam **depois**, pelo webhook \`messaging-history.set\` (\`syncType\` 6). \`anchor\` = \`{ id, fromMe, timestamp }\` de uma mensagem que você já tem; sem ele, o servidor usa a mais antiga que conhece da conversa. |

Registro de histórico:
\`\`\`json
{ "t": 1788048000000, "dir": "in", "chat": "5511...@s.whatsapp.net", "type": "conversation", "id": "ABCD", "status": "2" }
\`\`\`
> O conteúdo das mensagens **não** é armazenado no servidor. Ele chega às suas aplicações por webhook, e cada uma decide se guarda.

### Ler o histórico de uma conversa (resposta direta)

\`POST /api/sessions/:id/chats/:jid/history\` pede ao celular as mensagens **anteriores** a uma mensagem de referência (âncora) e **devolve o conteúdo na própria resposta**. Serve para abrir uma conversa antiga, inclusive de antes de o dispositivo ser vinculado.

\`:jid\` aceita o número (\`5511999999999\`) ou o JID completo. Body (tudo opcional):

| Campo | Descrição |
|---|---|
| \`count\` | Mensagens por página, 1 a 50 (padrão 50). |
| \`anchor\` | \`{ id, fromMe, timestamp }\` (timestamp em **segundos**) da mensagem mais antiga que você já tem. Sem ele, o servidor usa a mais antiga que conhece da conversa. |
| \`full\` | \`true\` para continuar paginando até o início da conversa. |
| \`maxPages\` | Limite de páginas no modo \`full\` (padrão 20, máx. 200). |
| \`days\` | Para quando as mensagens ficarem mais antigas que isso (dias). |

**Resposta**
\`\`\`json
{
  "chat": "123456789@lid",
  "anchor": { "id": "3EB0...", "fromMe": false, "timestamp": 1700000500, "remoteJid": "123456789@lid" },
  "messages": [
    {
      "id": "3EB0A1...", "chat": "123456789@lid", "fromMe": false, "timestamp": 1700000071,
      "pushName": "Cliente", "type": "conversation", "text": "Olá, tudo bem?",
      "key": { "...": "..." }, "message": { "...mensagem completa..." }
    }
  ],
  "nextCursor": { "id": "3EB0A1...", "fromMe": false, "timestamp": 1700000071, "remoteJid": "123456789@lid" },
  "hasMore": true,
  "complete": false,
  "pages": 1,
  "stoppedReason": "single-page"
}
\`\`\`
- \`messages\` vem em ordem **cronológica**. Para ir mais para trás, envie \`nextCursor\` como \`anchor\` na próxima chamada.
- \`complete: true\` = chegou ao início da conversa.
- \`stoppedReason\`: \`single-page\`, \`start-of-chat\`, \`page-limit\`, \`days\`, \`time-budget\` (limite de tempo da chamada, \`HISTORY_READ_BUDGET_MS\`, padrão 75s — abaixo do limite de 100s do Cloudflare) ou \`timeout\` (o celular parou de responder no meio; o que já chegou é devolvido).
- As mesmas mensagens também são encaminhadas ao webhook \`messaging-history.set\` com \`origin: "card"\`.

**Exemplo — conversa inteira**
\`\`\`bash
curl -X POST https://api.wpp.elosolar.com.br/api/sessions/vendas/chats/5511999999999/history \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" -d '{"full":true}'
# se hasMore=true, repita com: -d '{"full":true,"anchor":<nextCursor>}'
\`\`\`

**Erros:** \`422\` sem mensagem de referência (envie \`anchor\`, ou aguarde uma mensagem da conversa) · \`409\` sessão desconectada · \`504\` o celular não respondeu (precisa estar online) · \`400\` parâmetro inválido.

**Limites:** o histórico vem do **celular** (precisa estar online). Só volta o que ainda existe nele. Mídias antigas podem ter expirado nos servidores do WhatsApp. Leituras são processadas uma por vez por sessão. O conteúdo é repassado e **não** fica armazenado no servidor.

---

## Sistema

| Método | Rota | Descrição |
|---|---|---|
| GET | \`/api/system/info\` | Usuário logado, versão, status. |
| GET | \`/api/system/health\` | Uptime, memória, armazenamento/disco, sessões. |
| GET | \`/api/system/updates\` | Verifica atualizações do Baileys no GitHub (\`?refresh=1\` força). Inclui \`waWeb: { version, source }\` — a versão do WhatsApp Web que as sessões anunciam e de onde veio (\`web.whatsapp.com\` ao vivo, \`baileys-master\`, \`bundled\` ou \`env\` via \`WA_VERSION\`). |
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

**Histórico (\`messaging-history.set\`).** Conversas antigas, **com conteúdo**, chegam neste evento: ao parear um número (sincronização completa) e em resposta a \`/history/fetch\`. Lotes grandes são divididos em vários \`POST\`s de até \`WEBHOOK_HISTORY_BATCH_SIZE\` mensagens (padrão 100), entregues em ordem. Cada lote traz \`data.messages\`, \`syncType\` (0 bootstrap, 2 completo, 3 recente, 6 sob demanda), \`progress\`, \`part\` e \`parts\`; \`chats\`/\`contacts\` vêm só no 1º lote. Inscreva o evento em \`webhookEvents\` para recebê-lo.

---

_Documento gerado automaticamente pelo Baileys Hub (v${DOCS_VERSION}). Baixe sempre a versão mais recente pelo painel → aba **API**._
`
}
