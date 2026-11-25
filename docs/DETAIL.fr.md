> 状态: brouillon (草稿) · 归属: wave1 · 更新: 2026-11-25 · 里程碑: M5

# Kore

Kore est un noyau minimal qui ne fait qu’ordonnancer : il définit les règles de cycle de vie des plugins, de vérification des permissions, de routage des messages et d’isolement des ressources, tandis que 18 à 22 dépôts de plugins indépendants fournissent les fonctions réelles. Pas de compte, de vérification en ligne ni de télémétrie ; la configuration est en texte brut. La première version publiée est la 0.1.1 (la 0.1.0 n’a jamais été publiée).

Langue : [简体中文](DETAIL.md) · [English](DETAIL.en.md) · [Español](DETAIL.es.md) · [Français](DETAIL.fr.md) · [Deutsch](DETAIL.de.md) · [Русский](DETAIL.ru.md) · [Português](DETAIL.pt.md)

## Ce que fait le projet

- **Ordonnancement minimal** : aucune logique d’exploitation dans le noyau ; zéro import de plugin dans `internal/core`. Les plugins sont des processus séparés, lancés à la demande et terminés au repos.
- **Cinq ancres** : forme (un processus résident, aucun minuteur par défaut), architecture (règles seulement), ressources (limite ≤16 MiB à vide), ouverture (zéro client sortant, zéro télémétrie), expérience (premier écran ≤300 KiB gzip).
- **Multi-dépôts** : ce dépôt contient le noyau, le SDK public `pkg/pluginapi`, l’interface et le centre de collaboration ; les plugins vivent dans `kore-plugin-<id>` et ne dépendent que du SDK.
- **Niveaux de plateforme** : Linux est Tier A complet ; Windows 10 1809+ / macOS 12+ sont Tier B avec isolation réduite ; en dessous du minimum, sortie avec le code 6.
- **Zéro télémétrie** : pas de compte, de vérification en ligne ni de rapport caché ; configuration en texte brut.

## Démarrage rapide

```bash
make docs-check    # contrôle docs : métadonnées, liens, marqueurs, lignes
make help          # toutes les cibles make et l’état M0

# Depuis M1 : construire bin/kored et démarrer le shell
make build && ./bin/kored
```

Pour commencer, lisez `QUICKSTART.md` à la racine (build → configuration minimale → démarrage → premier login). Pour le travail multi-dépôts, utilisez `go work init kore kore-plugin-echo` ; ne committez pas `go.work`.

## Sécurité et limites

Signalez les vulnérabilités via [SECURITY.md](../SECURITY.md) (accusé de réception sous 72 h / divulgation coordonnée à 90 jours) ; n’ouvrez pas d’issue publique. La conception de la sécurité (modèle de menaces, authentification, CSRF, contrôle des capacités, isolement) est dans [docs/SECURITY.md](SECURITY.md). Le trafic sortant caché, les rapports non déclarés ou le contournement des permissions sont traités comme critiques : divulguez par e-mail.

## Plan de la documentation

- [docs/VISION.md](VISION.md) — positionnement, cinq ancres, non-objectifs et critères de réussite.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — diagramme des composants, modèle de processus, machine à états des plugins, domaines de défaillance.
- [docs/CORE.md](CORE.md) — responsabilités des modules du noyau, entrées/sorties, modes de défaillance et points d’accès.
- [docs/PLUGIN-PROTOCOL.md](PLUGIN-PROTOCOL.md) — UDS + préfixe de longueur 4 octets + JSON, méthodes, codes d’erreur, cycle de vie.
- [docs/RESOURCE-MODEL.md](RESOURCE-MODEL.md) — tableau des budgets, cgroup v2, règles de mesure.
- [docs/README.md](README.md) — index de la documentation organisé par « que veux-je faire ? ».

## Autres documents

La description complète est dans [README.md](../README.md).
La procédure de divulgation est dans [SECURITY.md](../SECURITY.md) et la conception de la sécurité dans [docs/SECURITY.md](SECURITY.md).
L’historique des versions est dans [CHANGELOG.md](../CHANGELOG.md).
Comment contribuer : [CONTRIBUTING.md](../CONTRIBUTING.md).

## Questions fréquentes

**Q : Faut-il un compte ?**
Non. Il n’y a ni compte, ni vérification en ligne, ni télémétrie cachée ; la configuration est en texte brut, lisible et modifiable.

**Q : Où se trouvent les plugins ?**
Chaque plugin vit dans son propre dépôt `kore-plugin-<id>`. Ce dépôt ne contient que le noyau et le SDK public.

**Q : Quel document lire en premier ?**
Commencez par `QUICKSTART.md` (de la compilation au premier login), puis utilisez l’index « que veux-je faire ? » dans `docs/README.md`.
