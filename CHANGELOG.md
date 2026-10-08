# Notes de version — ShaderView

© 2026 SANDEFJORD / Patrick JAILLET — Distribué sous licence GPL-3.0-or-later

## v1.0.0

Première version publique.

### Fonctionnalités

- Inspecteur listant les fichiers `.json` Shadertoy de `shaders/` (manifeste généré, repli dossier local et glisser-déposer),
  recherche, filtres, tri, vue détail avec code source par passe et journal de compilation.
- Rendu WebGL2 dans un viewport fixe de 800 × 450 : multipasse (buffers A à D avec rétroaction, cubemaps, passe `common`),
  clavier, souris, compatibilité GLSL ES 1.00.
- Médias hors-ligne : fichiers de `shaders/media/` résolus par nom, substituts procéduraux signalés dans l'inspecteur.
- Son : passe `sound` rendue hors-ligne et lue via Web Audio, pistes `music`/`musicstream` locales avec analyse FFT.
- Miniatures PNG statiques générées automatiquement, mises en cache par empreinte du fichier.
- Export vidéo image par image, déterministe : WebM (VP9/AV1, Opus) et MP4 (H.264, AAC) via WebCodecs, muxers écrits
  localement, écriture directe dans un fichier avec paquets encodés stockés temporairement hors mémoire quand le navigateur le permet.
- Interface sombre en français ou en anglais, transport (lecture, boucle, plein écran, capture PNG).
- Aucune requête réseau à l'exécution (CSP `default-src 'self'`).

### Limites connues

- La lecture d'une entrée `video` n'est pas implémentée.
- L'export WebM n'a pas été validé dans un lecteur externe, et la synchronisation audio/vidéo d'un MP4 AAC reste à confirmer à l'écoute.
- Le repli par téléchargement du navigateur garde l'export complet en mémoire ; l'écriture directe exige l'API File System Access.
- L'export exige WebCodecs et les codecs correspondants ; la compatibilité Firefox et Safari n'a pas été vérifiée.
