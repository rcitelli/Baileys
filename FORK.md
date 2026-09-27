# Sobre este fork

Este repositório é um **fork** de
[**WhiskeySockets/Baileys**](https://github.com/WhiskeySockets/Baileys) — a biblioteca
original permanece **intacta** em `src/`, `WAProto/`, `Example/` etc.

## O que foi adicionado

| Adição | Local | Descrição |
|---|---|---|
| Servidor / Painel / API | [`server/`](server/README.md) | Servidor central multi-sessão de WhatsApp: painel web com QR code, API REST e webhooks por sessão, com login via Cloudflare Access. Roda em Docker. |

Todas as adições ficam **fora** do código da biblioteca, para que o fork continue fácil de
manter e sincronizar com o projeto original.

## Créditos e licença

O crédito da biblioteca é do projeto original (Rajeh Taher / WhiskeySockets e
contribuidores), sob licença MIT — veja [`LICENSE`](LICENSE). Este fork mantém a mesma
licença e a política de uso responsável descrita em
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Mantendo-se atualizado com o upstream

```bash
# configurar o remote do projeto original (uma única vez)
git remote add upstream https://github.com/WhiskeySockets/Baileys.git

# trazer as atualizações
git fetch upstream
git merge upstream/master        # ou a tag/branch desejada, ex.: v7.0.0

# recompilar a biblioteca (o servidor consome ../lib)
yarn install && yarn build
```

Como as adições deste fork vivem em `server/` (e em arquivos próprios como este), os merges
do upstream raramente geram conflitos — quando geram, ficam restritos aos arquivos da
biblioteca. Acompanhe os lançamentos originais em
<https://github.com/WhiskeySockets/Baileys/releases>.

## Correções do upstream aplicadas antes do lançamento oficial

Quando o projeto original tem uma correção importante que ainda não chegou ao `master`, ela é
trazida para cá **sem alterar o conteúdo** — só o caminho dos arquivos, quando necessário. Assim,
quando o upstream lançar a versão, o merge tende a ser trivial (a mesma mudança dos dois lados).

| Correção (upstream) | Origem | Arquivos | Por quê |
|---|---|---|---|
| `fix: honor signature results, scope device domains, keep sources text` (#2751) | branch `develop`, commit `fe0fcabfe9` | `src/Utils/crypto.ts`, `src/Utils/signal.ts`, testes, `.gitattributes` | **Segurança**: a verificação de assinatura aceitava assinaturas forjadas (handshake e pareamento). **Entrega**: dispositivos eram endereçados no servidor errado após um dispositivo "hosted". |
| `chore: update WhatsApp Web version` | branch `update-version/stable`, commit `b304931dcc` | `src/Defaults/*`, `src/Utils/generics.ts` | Versão embutida do WhatsApp Web estava ~2 meses defasada. |

Ao sincronizar com o upstream, confira se essas correções já estão no `master` oficial; se estiverem,
nada a fazer — o merge resolve sozinho.
