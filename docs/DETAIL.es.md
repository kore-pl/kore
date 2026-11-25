> 状态: borrador (草稿) · 归属: wave1 · 更新: 2026-11-25 · 里程碑: M5

# Kore

Kore es un núcleo delgado que solo programa: define las reglas de ciclo de vida, verificación de permisos, enrutamiento de mensajes y aislamiento de recursos; 18–22 repositorios de plugins independientes aportan las funciones reales. No hay cuentas, verificación en línea ni telemetría; la configuración es texto plano. La primera versión publicada es la 0.1.1 (la 0.1.0 nunca se publicó).

Idioma: [简体中文](DETAIL.md) · [English](DETAIL.en.md) · [Español](DETAIL.es.md) · [Français](DETAIL.fr.md) · [Deutsch](DETAIL.de.md) · [Русский](DETAIL.ru.md) · [Português](DETAIL.pt.md)

## Qué hace

- **Programación delgada**: sin lógica de operación en el núcleo; cero importaciones de plugins en `internal/core`. Los plugins son procesos independientes, se inician bajo demanda y salen cuando están inactivos.
- **Cinco anclas**: forma (un proceso residente, cero temporizadores por defecto), arquitectura (solo reglas), recursos (límite ≤16 MiB en vacío), apertura (cero clientes salientes, cero telemetría), experiencia (primera pantalla ≤300 KiB gzip).
- **Multirrepositorio**: aquí están el núcleo, el SDK público `pkg/pluginapi`, el frontend y el centro de colaboración; los plugins viven en `kore-plugin-<id>` y solo dependen del SDK.
- **Niveles de plataforma**: Linux es Tier A completo; Windows 10 1809+ / macOS 12+ son Tier B con aislamiento reducido; por debajo del mínimo se sale con código 6.
- **Cero telemetría**: sin cuentas, verificación en línea ni informes ocultos; configuración en texto plano.

## Inicio rápido

```bash
make docs-check    # puerta de documentos: metadatos, enlaces, marcadores, líneas
make help          # todos los objetivos make y estado M0

# Desde M1: genera bin/kored e inicia el shell
make build && ./bin/kored
```

Para empezar, lee `QUICKSTART.md` en la raíz (compilación → configuración mínima → inicio → primer acceso). Para trabajar con varios repositorios usa `go work init kore kore-plugin-echo`; no subas `go.work`.

## Seguridad y límites

Las vulnerabilidades se informan por [SECURITY.md](../SECURITY.md) (confirmación en 72 h / divulgación coordinada en 90 días); no abras issues públicos. El diseño de seguridad (modelo de amenazas, autenticación, CSRF, comprobación de capacidades, aislamiento) está en [docs/SECURITY.md](SECURITY.md). El tráfico saliente oculto, los informes no declarados o la evasión de permisos se tratan como graves: divulga por correo.

## Mapa de documentación

- [docs/VISION.md](VISION.md) — posicionamiento, cinco anclas, no objetivos y criterios de éxito.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — diagrama de componentes, modelo de procesos, máquina de estados y dominios de fallo.
- [docs/CORE.md](CORE.md) — responsabilidades de los módulos del núcleo, entradas/salidas, fallos y endpoints.
- [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — UDS + prefijo de longitud de 4 bytes + JSON, métodos, códigos de error, ciclo de vida.
- [docs/RESOURCE-MODEL.md](RESOURCE-MODEL.md) — tabla de presupuesto, cgroup v2, reglas de medición.
- [docs/README.md](README.md) — índice de documentación por «qué quiero hacer».

## Más documentos

La descripción completa está en [README.md](../README.md).
El procedimiento de divulgación está en [SECURITY.md](../SECURITY.md) y el diseño de seguridad en [docs/SECURITY.md](SECURITY.md).
El historial de versiones está en [CHANGELOG.md](../CHANGELOG.md).
Cómo contribuir: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Preguntas frecuentes

**P: ¿Necesito una cuenta?**
No. No hay cuentas, verificación en línea ni telemetría oculta; la configuración es texto plano que puedes leer y cambiar.

**P: ¿Dónde están los plugins?**
Cada plugin vive en su propio repositorio `kore-plugin-<id>`. Este repositorio solo contiene el núcleo y el SDK público.

**P: ¿Qué documento debo leer primero?**
Empieza por `QUICKSTART.md` (de la compilación al primer inicio de sesión) y usa el índice «qué quiero hacer» en `docs/README.md`.
