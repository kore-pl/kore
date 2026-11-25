# Divulgação de vulnerabilidades de segurança

Este arquivo descreve o processo de divulgação, não o projeto de segurança. O projeto do núcleo está em docs/SECURITY.md; o modelo de ameaças do Kore está no repositório kore.

## Escopo

Covered: the kore kernel and main shell (`cmd/`, `internal/`, `pkg/pluginapi`), officially maintained plugin repositories (`kore-plugin-<id>`), and the official plugin index and presets (`kore-plugins`).

## Versões suportadas

| Versão | Status | Notas |
| --- | --- | --- |
| `0.1.x` | Sim — aceita e corrige | Linha MVP atual; correções apenas no último patch. |
| `< 0.1` | Não — sem suporte | Snapshot de prévia/desenvolvimento; atualize. |

Na fase 0.x usamos suporte mínimo: apenas o último patch de cada linha minor é corrigido; patches antigos não são retroportados.

## Superfície de ataque neste repositório

Ações remotas e gravações no host são limitadas às capacidades declaradas; uma evasão é uma vulnerabilidade. Os sockets dos plugins são criados pelo shell com permissões restritas; evadir permissões ou ler dados de outro plugin é uma vulnerabilidade.

## Relatos

Preferencialmente: GitHub Security Advisory neste repositório ("Relatar uma vulnerabilidade", privado, sem issue pública). E-mail alternativo: pengtang1024@users.noreply.github.com com assunto `[kore security] <repo>`. Não abra issues públicas nem publique detalhes exploráveis em discussões ou PRs.

Inclua: versão ou commit afetado, passos de reprodução ou PoC, avaliação de impacto, se já é público e sua preferência de atribuição.

## Prazos e divulgação

Confirmação em 72 horas com uma primeira avaliação; casos complexos recebem um plano de investigação. Divulgação coordenada com janela padrão de 90 dias; entre em contato primeiro se for preciso divulgar antes (ex.: exploração ativa). Registre as correções no CHANGELOG.md sem detalhes de exploração e publique um aviso se necessário.

## Agradecimentos

Com seu consentimento agradecemos o relator nas notas de lançamento; anônimo se solicitado.
