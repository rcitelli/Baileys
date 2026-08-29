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
