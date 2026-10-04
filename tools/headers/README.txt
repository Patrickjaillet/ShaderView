Modèles d'en-tête de licence de ShaderView.

Chaque fichier source (HTML, CSS, JS, MJS, SVG) doit comporter, dans ses
premières lignes, la ligne « SPDX-License-Identifier: GPL-3.0-or-later »
suivie de la mention de copyright et de licence, selon le modèle du type
de fichier :

  header.js.txt    fichiers .js et .mjs (commentaires de ligne)
  header.css.txt   fichiers .css
  header.html.txt  fichiers .html et .svg (après <!DOCTYPE html> pour le HTML)

Vérification : node tools/check-headers.mjs
Les fichiers de js/vendor/ conservent l'en-tête de leur auteur ; leur licence
est consignée dans THIRD_PARTY_NOTICES.md.
