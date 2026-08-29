# Baileys Server — Painel + API multi-sessão

Servidor central de WhatsApp para uso interno da equipe, construído **por cima** da
biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys). Ele gerencia várias
sessões (números) simultâneas, expõe um **painel web** para conectar via QR code e uma
**API REST** para suas outras aplicações enviarem/receberem mensagens.

> Este diretório (`server/`) é um **acréscimo do fork**. Ele **não altera** o código-fonte
> da biblioteca em `src/`, para que o upstream (`WhiskeySockets/Baileys`) continue fácil de
> sincronizar. Veja [Sincronizando com o upstream](#sincronizando-com-o-upstream).

## Recursos

- **Multi-sessão**: uma pasta por sessão em disco (`data/<id>/`), reconexão automática ao reiniciar.
- **Painel web** (`/`): lista todas as sessões, status em tempo real e leitura do QR code (via SSE).
- **API REST** (`/api`): criar/listar/excluir sessões, enviar mensagens, checar números, etc.
- **Webhooks por sessão**: eventos recebidos (mensagens, recibos, presença…) são enviados via
  `POST` para a URL configurada — é assim que suas aplicações "recebem" do WhatsApp.
- **Autenticação dupla**: **API Key** para chamadas server-to-server e **Cloudflare Access**
  para o painel no navegador.
- **Docker + docker-compose** com volume persistente e healthcheck.

## Arquitetura

```
Suas aplicações ─(API Key)─┐
                           ├─▶  Baileys Server  ─▶  WhatsApp Web
Navegador (Cloudflare Access)┘        │
                                      └─(webhook POST)─▶  Suas aplicações
```

O servidor **não** reinstala o Baileys como dependência aninhada: ele consome a lib já
compilada do pacote pai (`../lib`), e as dependências de runtime do Baileys (libsignal,
whatsapp-rust-bridge, ws…) são resolvidas pelo `node_modules` da raiz. Isso evita recompilar
módulos nativos duas vezes. Por isso é preciso compilar o pai antes (`yarn build` na raiz) —
o `Dockerfile` faz isso automaticamente.

## Rodando com Docker (recomendado)

```bash
cd server
cp .env.example .env
# edite .env: defina API_KEYS e, em produção, CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD
docker compose up -d --build
```

O servidor sobe em `127.0.0.1:3000` (apenas localhost — coloque o Cloudflare Tunnel ou um
reverse proxy na frente). Os dados das sessões ficam em `server/data/` (volume). Faça backup
dessa pasta para não perder as conexões.

## Rodando local (desenvolvimento)

```bash
# na raiz do repositório, uma vez:
yarn install && yarn build

cd server
npm install
AUTH_DISABLED=true npm run dev   # painel em http://localhost:3000
```

`AUTH_DISABLED=true` desliga toda a autenticação — use **somente** local, atrás de firewall.

## Configuração (`.env`)

Veja `.env.example` para a lista completa. Principais:

| Variável | Descrição |
|---|---|
| `PORT` / `HOST` | Porta e interface de bind. |
| `DATA_DIR` | Onde as sessões são gravadas. |
| `API_KEYS` | Chaves de API (separadas por vírgula) para as suas aplicações. |
| `CF_ACCESS_TEAM_DOMAIN` | Domínio Zero Trust, ex.: `https://suaequipe.cloudflareaccess.com`. |
| `CF_ACCESS_AUD` | Application Audience (AUD) da aplicação no Cloudflare Access. |
| `AUTH_DISABLED` | `true` desliga a auth (apenas dev). |
| `WEBHOOK_*` | Retries, timeout e segredo dos webhooks. |

## Autenticação

Toda rota `/api/*` aceita **uma** das duas provas:

1. **API Key** (aplicações): header `Authorization: Bearer <chave>` ou `x-api-key: <chave>`,
   onde `<chave>` está em `API_KEYS`. Gere chaves fortes: `openssl rand -hex 32`.
2. **Cloudflare Access** (navegador): o painel é servido em `/` e o Cloudflare injeta o
   header `Cf-Access-Jwt-Assertion`, que o servidor **verifica** contra as chaves públicas da
   sua equipe (`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`). Assim, mesmo que alguém acesse a
   origem diretamente, sem um JWT válido o acesso é negado.

### Configurando o Cloudflare Access

1. No painel Zero Trust da Cloudflare, crie um **Tunnel** apontando para
   `http://127.0.0.1:3000` (ou use seu reverse proxy) e um hostname público, ex.:
   `whatsapp.suaempresa.com`.
2. Crie uma **Access Application** (self-hosted) para esse hostname, com as políticas de
   quem pode entrar (e-mails/grupos da equipe).
3. Copie o **Application Audience (AUD) Tag** e o **team domain** para o `.env`
   (`CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`).
4. Para chamadas de API server-to-server que passem pelo mesmo hostname, você pode usar
   **Service Tokens** do Cloudflare Access **ou** simplesmente as `API_KEYS` (recomendado).

## API REST

Base: `/api`. Todos os exemplos assumem `Authorization: Bearer <API_KEY>`.

### Sessões

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/sessions` | Lista todas as sessões com status. |
| `POST` | `/sessions` | Cria uma sessão. Body: `{ id?, name?, webhookUrl?, webhookEvents? }`. |
| `GET` | `/sessions/:id` | Detalhes/status de uma sessão. |
| `PATCH` | `/sessions/:id` | Atualiza `name`, `webhookUrl`, `webhookEvents`. |
| `DELETE` | `/sessions/:id` | Desloga e apaga as credenciais do disco. |
| `POST` | `/sessions/:id/restart` | Reinicia o socket (mantém credenciais). |
| `POST` | `/sessions/:id/logout` | Desloga do aparelho (exige novo QR). |
| `GET` | `/sessions/:id/qr` | `{ status, qr, qrImage }` — `qrImage` é um data URL PNG. |
| `GET` | `/sessions/:id/events` | **SSE**: stream de `{ info, qr }` a cada mudança (o painel usa isto). |
| `POST` | `/sessions/:id/pairing-code` | Body `{ phoneNumber }`; retorna código de pareamento. |

### Mensagens

| Método | Rota | Body | Descrição |
|---|---|---|---|
| `POST` | `/sessions/:id/send-text` | `{ to, text, options? }` | Envia texto. `to` = número ou jid. |
| `POST` | `/sessions/:id/send` | `{ to, message, options? }` | Envia qualquer `AnyMessageContent` do Baileys (imagem, documento, botões…). |
| `POST` | `/sessions/:id/check` | `{ numbers }` | Verifica se números têm WhatsApp. |
| `POST` | `/sessions/:id/presence` | `{ type, to? }` | Atualiza presença (`composing`, `available`…). |
| `POST` | `/sessions/:id/read` | `{ keys }` | Marca mensagens como lidas. |

`to` aceita número puro (`5511999999999`) — vira `...@s.whatsapp.net` — ou um jid completo
(inclusive grupos `...@g.us`).

### Exemplos

```bash
# criar sessão com webhook
curl -X POST https://whatsapp.suaempresa.com/api/sessions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"id":"vendas","name":"Vendas","webhookUrl":"https://app.interna/wh","webhookEvents":["messages.upsert","connection.update"]}'

# enviar texto
curl -X POST https://whatsapp.suaempresa.com/api/sessions/vendas/send-text \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"5511999999999","text":"Olá do servidor central!"}'

# enviar imagem por URL
curl -X POST https://whatsapp.suaempresa.com/api/sessions/vendas/send \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"5511999999999","message":{"image":{"url":"https://.../foto.jpg"},"caption":"Legenda"}}'
```

## Webhooks (recebendo do WhatsApp)

Cada sessão pode ter uma `webhookUrl`. Quando um evento inscrito ocorre, o servidor faz um
`POST` com o corpo:

```json
{
  "sessionId": "vendas",
  "event": "messages.upsert",
  "timestamp": "2026-08-29T19:54:39.232Z",
  "data": { "...payload nativo do Baileys..." }
}
```

Headers: `X-Webhook-Event`, `X-Webhook-Session` e, se `WEBHOOK_SECRET` estiver definido,
`X-Webhook-Secret` (valide-o no destino). Entregas com falha são reenviadas com backoff
exponencial (`WEBHOOK_MAX_RETRIES`). Eventos disponíveis: `connection.update`,
`messages.upsert`, `messages.update`, `messages.delete`, `message-receipt.update`,
`messages.reaction`, `presence.update`, `chats.*`, `contacts.*`, `groups.*`, `call`.

## Sincronizando com o upstream

Todo o servidor vive em `server/` e não toca em `src/`, `WAProto/`, etc. Para trazer
atualizações do projeto original:

```bash
git remote add upstream https://github.com/WhiskeySockets/Baileys.git   # uma vez
git fetch upstream
git merge upstream/master        # ou a branch/tag desejada
# conflitos, se houver, ficam restritos a arquivos da biblioteca — o server/ raramente conflita
```

Como o `server/` consome a lib pela saída compilada (`../lib`), após um merge basta
`yarn build` na raiz (o Docker já refaz isso no build da imagem).

## Segurança

- Nunca exponha a porta diretamente na internet — use Cloudflare Tunnel/Access ou reverse proxy.
- Trate `data/` como segredo: contém as credenciais das sessões do WhatsApp.
- Este projeto herda a política de uso responsável do Baileys (sem spam/abuso). Veja
  `CODE_OF_CONDUCT.md` e `SECURITY.md` na raiz.
