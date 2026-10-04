# Avis sur les composants tiers — ShaderView

© 2026 SANDEFJORD / Patrick JAILLET — Distribué sous licence GPL-3.0-or-later

Ce document recense tous les composants tiers embarqués dans le dépôt, avec leur
version, leur licence et la vérification de leur compatibilité avec la
GNU General Public License v3.0 (GPL-3.0-or-later) sous laquelle ShaderView est distribué.

## Composants tiers embarqués

Aucun composant tiers n'est embarqué à ce jour : `js/vendor/` est vide, et ShaderView
fonctionne sans dépendance externe, ni à l'exécution ni à la construction.

| Composant | Version | Auteur | Licence | Compatible GPL-3.0 | Emplacement |
|-----------|---------|--------|---------|--------------------|-------------|
| —         | —       | —      | —       | —                  | —           |

## Règles d'admission d'une dépendance

Toute dépendance ajoutée dans `js/vendor/` doit satisfaire l'ensemble des conditions suivantes
et être consignée dans le tableau ci-dessus **avant** son intégration :

1. Licence compatible avec la GPL-3.0-or-later : par exemple MIT, BSD 2/3 clauses, ISC,
   Apache-2.0, Zlib, MPL-2.0, LGPL-2.1-or-later, LGPL-3.0, GPL-3.0-or-later, Unlicense, CC0-1.0.
2. Licences refusées : GPL-2.0-only, licences propriétaires, licences « non commerciales »,
   licences avec clause de publicité incompatible, licences sans mention explicite.
3. Fonctionnement 100 % hors-ligne : aucun appel réseau à l'exécution (CDN, télémétrie, polices distantes).
4. Texte de licence et avis de copyright d'origine conservés dans le fichier ou à côté de lui.
5. Version exacte figée et source d'origine indiquée.

## Contenu du dossier `shaders/`

Les fichiers `.json` du dossier `shaders/` sont des données (exports au format Shadertoy) et non du code
du programme. Chacun reste soumis aux conditions choisies par son auteur ; la licence
GPL-3.0-or-later du projet s'applique au code de ShaderView (HTML, CSS, JavaScript, outils),
pas au contenu de ces fichiers.
