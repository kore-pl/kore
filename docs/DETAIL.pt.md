> 状态: rascunho (草稿) · 归属: wave1 · 更新: 2026-11-25 · 里程碑: M5

# Kore

Kore é um núcleo fino que apenas agenda: define as regras de ciclo de vida de plugins, verificação de permissões, roteamento de mensagens e isolamento de recursos, enquanto 18–22 repositórios de plugins independentes fornecem as funções reais. Não há contas, verificação online nem telemetria; a configuração é texto simples. A primeira versão lançada é a 0.1.1 (a 0.1.0 nunca foi lançada).

Idioma: [简体中文](DETAIL.md) · [English](DETAIL.en.md) · [Español](DETAIL.es.md) · [Français](DETAIL.fr.md) · [Deutsch](DETAIL.de.md) · [Русский](DETAIL.ru.md) · [Português](DETAIL.pt.md)

## O que faz

- **Agendamento fino**: nenhuma lógica de operação no núcleo; zero imports de plugins em `internal/core`. Os plugins rodam como processos separados, iniciados sob demanda e encerrados quando ociosos.
- **Cinco âncoras**: forma (um processo residente, zero temporizadores padrão), arquitetura (apenas regras), recursos (limite rígido ≤16 MiB em repouso), abertura (zero clientes de saída, zero telemetria), experiência (primeira tela ≤300 KiB gzip).
- **Multirrepositório**: aqui ficam o núcleo, o SDK público `pkg/pluginapi`, o frontend e o centro de colaboração; os plugins ficam em `kore-plugin-<id>` e dependem apenas do SDK.
- **Níveis de plataforma**: Linux é Tier A completo; Windows 10 1809+ / macOS 12+ são Tier B com isolamento reduzido; abaixo do mínimo, saída com código 6.
- **Zero telemetria**: sem contas, verificação online ou relatórios ocultos; configuração em texto simples.

## Início rápido

```bash
make docs-check    # porta de documentos: metadados, links, marcadores, linhas
make help          # todos os alvos make e estado M0

# A partir de M1: gerar bin/kored e iniciar o shell
make build && ./bin/kored
```

Para começar, leia `QUICKSTART.md` na raiz (compilação → configuração mínima → início → primeiro login). Para trabalho com vários repositórios, use `go work init kore kore-plugin-echo`; nunca commite `go.work`.

## Segurança e limites

Relate vulnerabilidades por [SECURITY.md](../SECURITY.md) (confirmação em 72 h / divulgação coordenada em 90 dias); não abra issues públicas. O projeto de segurança (modelo de ameaças, autenticação, CSRF, verificação de permissões, isolamento) está em [docs/SECURITY.md](SECURITY.md). Tráfego de saída oculto, relatórios não declarados ou burlar permissões são tratados como graves — divulgue por e-mail.

## Mapa da documentação

- [docs/VISION.md](VISION.md) — posicionamento, cinco âncoras, não objetivos e critérios de sucesso.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — diagrama de componentes, modelo de processos, máquina de estados dos plugins, domínios de falha.
- [docs/CORE.md](CORE.md) — responsabilidades dos módulos do núcleo, entradas/saídas, modos de falha e endpoints.
- [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — UDS + prefixo de 4 bytes + JSON, métodos, códigos de erro, ciclo de vida.
- [docs/RESOURCE-MODEL.md](RESOURCE-MODEL.md) — tabela de orçamento, cgroup v2, regras de medição.
- [docs/README.md](README.md) — índice da documentação por “o que quero fazer”.

## Mais documentos

A descrição completa está em [README.md](../README.md).
O processo de divulgação está em [SECURITY.md](../SECURITY.md) e o projeto de segurança em [docs/SECURITY.md](SECURITY.md).
O histórico de versões está em [CHANGELOG.md](../CHANGELOG.md).
Como contribuir: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Perguntas frequentes

**P: Preciso de uma conta?**
Não. Não há contas, verificação online nem telemetria oculta; a configuração é texto simples que você pode ler e alterar.

**P: Onde ficam os plugins?**
Cada plugin fica no seu próprio repositório `kore-plugin-<id>`. Aqui estão apenas o núcleo e o SDK público.

**P: Qual documento ler primeiro?**
Comece por `QUICKSTART.md` (da compilação ao primeiro login) e use o índice “o que quero fazer” em `docs/README.md`.
