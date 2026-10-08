# ShaderView

Visionneuse de shaders Shadertoy hébergeable sur GitHub Pages, fonctionnant 100 % hors-ligne.

ShaderView lit les fichiers `.json` exportés depuis [shadertoy.com](https://www.shadertoy.com), les liste dans un inspecteur
et les affiche dans un viewport de 800 × 450.

## Objectifs

- Inspecteur listant tous les fichiers `.json` du dossier `shaders/`
- Miniatures images PNG statiques générées automatiquement à partir du shader lui-même (un seul rendu hors-écran par entrée, mis en cache selon l'empreinte du fichier, sans animation ni son)
- Rendu WebGL2 multipasse (buffers A à D, cubemaps, passe `common`), passe son et lecture synchronisée des pistes locales `music`/`musicstream` (dont MP3 décodables par le navigateur)
- Export vidéo déterministe WebM (VP9/AV1, Opus) et MP4 (H.264, AAC) via WebCodecs, selon les codecs proposés par le navigateur
- Commandes de lecture, boucle sur 60 secondes (ou sur la durée du MP3 associé), plein écran et capture PNG
- Interface en français par défaut, avec bascule anglais/français mémorisée localement
- Aucune requête réseau à l'exécution

## Structure du dépôt

```
index.html              page unique
css/                    styles
js/                     code de l'application (catalogue, analyse des fichiers, interface)
js/export/              encodeurs et muxers WebM / MP4
js/vendor/              dépendances tierces locales (voir THIRD_PARTY_NOTICES.md)
shaders/                fichiers .json Shadertoy
tools/                  outils de construction et de contrôle
tests/                  tests automatisés (node:test)
branding/favicon.svg    icône du projet
```

## Ajouter un shader

1. Déposer le fichier `.json` exporté depuis Shadertoy dans `shaders/`.
2. Régénérer le manifeste : `node tools/build-manifest.mjs`.
3. Publier `shaders/` avec le fichier `manifest.json` mis à jour.

Un fichier peut contenir un shader (objet) ou plusieurs (tableau) ; chacun apparaît comme une entrée du catalogue.
Un fichier invalide n'empêche pas la génération : son erreur est consignée dans le manifeste et affichée dans la liste.

Sans manifeste (ou pour parcourir un dossier non publié), la page propose « Ouvrir un dossier… », « Ouvrir des .json… »
et le glisser-déposer de dossiers ou de fichiers.

## Outils

```sh
node tools/build-manifest.mjs           # génère shaders/manifest.json (--check : vérifie, --strict : échoue sur erreur)
node tools/check-headers.mjs            # vérifie les en-têtes de licence des fichiers sources
node tools/inline-favicon.mjs           # réinjecte branding/favicon.svg dans index.html
node tools/audit-reseau.mjs             # vérifie l'absence de requête réseau et la CSP
node tools/build.mjs                    # contrôle complet avant publication
node --test "tests/*.test.mjs"          # lance les tests automatisés
```

Les mêmes commandes sont disponibles via `npm run manifeste`, `en-tetes`, `favicon` et `npm test` (Node.js 20 ou plus récent ;
aucune dépendance à installer).

## Publication sur GitHub Pages

Le site est entièrement statique : GitHub Pages sert directement la racine du dépôt (fichier `.nojekyll` présent, aucune étape de
construction côté serveur).

1. `node tools/build-manifest.mjs` après toute modification de `shaders/` ou `audio/`.
2. `node tools/build.mjs` : vérifie manifestes, en-têtes SPDX, absence de requête réseau (CSP comprise), dépendances
   consignées, fichiers de publication et tests. Ne publier que si la commande se termine sans erreur.
3. Pousser sur `main`, puis dans les paramètres du dépôt : *Pages* → source « Deploy from a branch », branche `main`, dossier `/ (root)`.
4. Vérifier le site publié : https://patrickjaillet.github.io/ShaderView (catalogue chargé, un shader rendu, console sans erreur).

Les notes de chaque version figurent dans `CHANGELOG.md`.

## Visualisation locale

La page doit être servie par HTTP (le chargement du manifeste est refusé depuis `file://`) :

```sh
python3 -m http.server 8080
```

puis ouvrir http://localhost:8080/.

## Licence

© 2026 SANDEFJORD / Patrick JAILLET

Distribué sous licence GPL-3.0-or-later. Le texte complet figure dans les fichiers `LICENSE` et `COPYING`.
Les composants tiers éventuels et leurs licences sont consignés dans `THIRD_PARTY_NOTICES.md`.

## Contact

- E-mail : sandefjord.development@proton.me
- Site officiel : https://patrickjaillet.github.io/ShaderView
