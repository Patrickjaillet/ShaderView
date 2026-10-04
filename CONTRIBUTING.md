# Contribuer à ShaderView

© 2026 SANDEFJORD / Patrick JAILLET — Distribué sous licence GPL-3.0-or-later

## Licence des contributions

Toute contribution est publiée sous licence GPL-3.0-or-later, comme le reste du projet.

## En-têtes de licence

Chaque fichier source (HTML, CSS, JS, MJS, SVG) commence par l'en-tête SPDX correspondant à son type
(modèles dans `tools/headers/`). Contrôle avant chaque commit :

```sh
node tools/check-headers.mjs
```

## Messages de commit

- Rédigés en français, au nominal ou à l'infinitif, sur une ligne de 72 caractères au plus.
- Centrés sur le contenu fonctionnel du changement.
- Un changement logique par commit.

Exemples : « Ajout du parseur multipasse », « Implémentation du muxer WebM », « Correction du tri du catalogue ».

## Dépendances

Toute dépendance tierce doit être compatible GPL-3.0 et consignée dans `THIRD_PARTY_NOTICES.md`
avant son intégration. ShaderView ne doit émettre aucune requête réseau à l'exécution.

## Contact

sandefjord.development@proton.me
