> 状态: draft (草稿) · 归属: wave1 · 更新: 2026-11-25 · 里程碑: M5

# Kore

Kore is a thin kernel that only schedules: it defines the rules for plugin lifecycle, permission checks, message routing and resource isolation, while 18–22 independent plugin repositories provide the actual operations features. There is no account, online verification or telemetry by default, and configuration is plain text. The first released version is 0.1.1 (0.1.0 was never released).

Language: [简体中文](DETAIL.md) · [English](DETAIL.en.md) · [Español](DETAIL.es.md) · [Français](DETAIL.fr.md) · [Deutsch](DETAIL.de.md) · [Русский](DETAIL.ru.md) · [Português](DETAIL.pt.md)

## What it does

- **Thin scheduling**: no operations logic in the kernel; zero plugin imports in `internal/core`. Plugins run as separate processes, started on demand and exit when idle.
- **Five anchors**: shape (one resident process, zero default timers), architecture (rules only), resources (hard limit ≤16 MiB idle), openness (zero outbound clients, zero telemetry), experience (first screen ≤300 KiB gzip).
- **Multi-repo**: this repository holds the kernel, public SDK `pkg/pluginapi`, shell frontend and collaboration hub; plugins live in `kore-plugin-<id>` repositories depending only on the SDK.
- **Platform tiers**: Linux is Tier A with full features; Windows 10 1809+ / macOS 12+ are Tier B with reduced isolation; below the minimum exits with code 6.
- **Zero telemetry**: no account, no online verification, no hidden reporting, plain-text configuration.

## Quick start

```bash
make docs-check    # document gate: metadata, links, placeholders, line counts
make help          # all make targets and M0 status

# From M1: build bin/kored and start the shell
make build && ./bin/kored
```

For a first run, read `QUICKSTART.md` at the repository root (build → minimal config → start → first login). For local multi-repo work use `go work init kore kore-plugin-echo`; never commit `go.work`.

## Security and boundaries

Report vulnerabilities through [SECURITY.md](../SECURITY.md) (acknowledged within 72 hours / coordinated disclosure in 90 days); do not open public issues. The security design (threat model, authentication, CSRF, capability checks, isolation) is in [docs/SECURITY.md](SECURITY.md). Hidden outbound traffic, undeclared reporting or bypassed permission checks are treated as high severity — disclose by email.

## Documentation map

- [docs/VISION.md](VISION.md) — positioning, five anchors, non-goals and success criteria.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — component diagram, process model, plugin state machine, failure domains.
- [docs/CORE.md](CORE.md) — kernel module responsibilities, inputs/outputs, failure modes and endpoints.
- [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — UDS + 4-byte length prefix + JSON, method table, error codes, lifecycle.
- [docs/RESOURCE-MODEL.md](RESOURCE-MODEL.md) — budget table, cgroup v2 mapping, measurement rules.
- [docs/README.md](README.md) — documentation index organized by “what I want to do”.

## More documents

See [README.md](../README.md) for the full description.
See [SECURITY.md](../SECURITY.md) for disclosure and [docs/SECURITY.md](SECURITY.md) for the security design.
See [CHANGELOG.md](../CHANGELOG.md) for version history.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to contribute.

## FAQ

**Q: Do I need an account?**
No. There is no account, no online verification and no hidden telemetry; configuration is plain text that you can read and change.

**Q: Where do plugins live?**
Each plugin lives in its own `kore-plugin-<id>` repository. This repository holds only the kernel and the public SDK.

**Q: Which document should I read first?**
Start with `QUICKSTART.md` (build to first login), then use the “what I want to do” index in `docs/README.md` to find topic documents.
