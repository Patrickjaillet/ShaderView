# ShaderView

Visionneuse de shaders Shadertoy hébergeable sur GitHub Pages, fonctionnant 100 % hors-ligne.

ShaderView lit les fichiers `.json` exportés depuis [shadertoy.com](https://www.shadertoy.com), les liste dans un inspecteur
et les affiche dans un viewport de 800 × 450.

## Objectifs

- Inspecteur listant tous les fichiers `.json` du dossier `shaders/`
- Miniatures animées générées automatiquement à partir du shader lui-même
- Rendu WebGL2 multipasse (buffers A à D, cubemaps, passe `common`) et passe son
- Export vidéo image par image avec son, aux formats WebM et MP4
- Aucune requête réseau à l'exécution

## Structure du dépôt

```
index.html              page unique
css/                    styles
js/                     code de l'application
js/export/              encodeurs et muxers WebM / MP4
js/vendor/              dépendances tierces locales (voir THIRD_PARTY_NOTICES.md)
shaders/                fichiers .json Shadertoy
tools/                  outils de construction et de contrôle
branding/favicon.svg    icône du projet
```

## Outils

```sh
node tools/inline-favicon.mjs   # réinjecte branding/favicon.svg dans index.html
node tools/check-headers.mjs    # vérifie les en-têtes de licence des fichiers sources
```

## Licence

© 2026 SANDEFJORD / Patrick JAILLET

Distribué sous licence GPL-3.0-or-later. Le texte complet figure dans les fichiers `LICENSE` et `COPYING`.
Les composants tiers éventuels et leurs licences sont consignés dans `THIRD_PARTY_NOTICES.md`.

## Contact

- E-mail : sandefjord.development@proton.me
- Site officiel : https://patrickjaillet.github.io/shaderview
