> 状态: Entwurf (草稿) · 归属: wave1 · 更新: 2026-11-25 · 里程碑: M5

# Kore

Kore ist ein schlanker Kernel, der nur plant: Er definiert Regeln für Plugin-Lebenszyklus, Berechtigungsprüfung, Nachrichtenweiterleitung und Ressourcenisolierung; 18–22 eigenständige Plugin-Repositories liefern die eigentlichen Funktionen. Standardmäßig gibt es keine Konten, keine Online-Prüfung und keine Telemetrie; die Konfiguration ist Klartext. Die erste veröffentlichte Version ist 0.1.1 (0.1.0 wurde nie veröffentlicht).

Sprache: [简体中文](DETAIL.md) · [English](DETAIL.en.md) · [Español](DETAIL.es.md) · [Français](DETAIL.fr.md) · [Deutsch](DETAIL.de.md) · [Русский](DETAIL.ru.md) · [Português](DETAIL.pt.md)

## Was es tut

- **Schlankes Scheduling**: keine Betriebslogik im Kernel; null Plugin-Imports in `internal/core`. Plugins laufen als eigene Prozesse, werden bei Bedarf gestartet und beenden sich im Leerlauf.
- **Fünf Anker**: Form (ein residenter Prozess, keine Standard-Timer), Architektur (nur Regeln), Ressourcen (Harte Grenze ≤16 MiB leer), Offenheit (null ausgehende Clients, keine Telemetrie), Erfahrung (erster Bildschirm ≤300 KiB gzip).
- **Multi-Repo**: hier liegen Kernel, öffentliches SDK `pkg/pluginapi`, Shell-Frontend und Kollaborationszentrale; Plugins liegen in `kore-plugin-<id>` und hängen nur vom SDK ab.
- **Plattformstufen**: Linux ist Tier A mit vollem Funktionsumfang; Windows 10 1809+ / macOS 12+ sind Tier B mit reduzierter Isolierung; unterhalb der Mindestanlage Exit-Code 6.
- **Null Telemetrie**: keine Konten, keine Online-Prüfung, keine versteckte Berichterstattung; Konfiguration im Klartext.

## Schnellstart

```bash
make docs-check    # Doku-Gate: Metadaten, Links, Platzhalter, Zeilen
make help          # alle make-Ziele und M0-Status

# Ab M1: bin/kored bauen und Shell starten
make build && ./bin/kored
```

Zum Einstieg `QUICKSTART.md` im Wurzelverzeichnis lesen (Build → Minimalconfig → Start → erste Anmeldung). Für lokale Multi-Repo-Arbeit `go work init kore kore-plugin-echo` verwenden; `go.work` nie committen.

## Sicherheit und Grenzen

Schwachstellen bitte über [SECURITY.md](../SECURITY.md) melden (Bestätigung binnen 72 Stunden / koordinierte Offenlegung nach 90 Tagen); keine öffentlichen Issues öffnen. Das Sicherheitsdesign (Bedrohungsmodell, Authentifizierung, CSRF, Berechtigungsprüfung, Isolierung) steht in [docs/SECURITY.md](SECURITY.md). Versteckter ausgehender Datenverkehr, nicht deklarierte Berichte oder umgangene Berechtigungen gelten als hochriskant — per E-Mail melden.

## Dokumentationsübersicht

- [docs/VISION.md](VISION.md) — Ausrichtung, fünf Anker, Non-Goals und Erfolgskriterien.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — Komponentendiagramm, Prozessmodell, Plugin-Zustandsautomat, Fehlerdomänen.
- [docs/CORE.md](CORE.md) — Verantwortlichkeiten der Kernelmodule, Ein-/Ausgaben, Fehlerfälle und Endpunkte.
- [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — UDS + 4-Byte-Längenpräfix + JSON, Methoden, Fehlercodes, Lebenszyklus.
- [docs/RESOURCE-MODEL.md](RESOURCE-MODEL.md) — Budgettabelle, cgroup v2, Messregeln.
- [docs/README.md](README.md) — Dokumentationsindex nach „Was möchte ich tun?“.

## Weitere Dokumente

Die vollständige Beschreibung steht in [README.md](../README.md).
Der Offenlegungsprozess steht in [SECURITY.md](../SECURITY.md), das Sicherheitsdesign in [docs/SECURITY.md](SECURITY.md).
Die Versionshistorie steht in [CHANGELOG.md](../CHANGELOG.md).
Wie du beiträgst: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Häufige Fragen

**F: Brauche ich ein Konto?**
Nein. Es gibt keine Konten, keine Online-Prüfung und keine versteckte Telemetrie; die Konfiguration ist Klartext, den du lesen und ändern kannst.

**F: Wo liegen die Plugins?**
Jedes Plugin liegt in einem eigenen Repository `kore-plugin-<id>`. Dieses Repository enthält nur den Kernel und das öffentliche SDK.

**F: Welches Dokument sollte ich zuerst lesen?**
Beginne mit `QUICKSTART.md` (vom Build bis zur ersten Anmeldung) und nutze dann den „Was möchte ich tun?“-Index in `docs/README.md`.
