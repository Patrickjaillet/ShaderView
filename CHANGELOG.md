# Notes de version — ShaderView

© 2026 SANDEFJORD / Patrick JAILLET — Distribué sous licence GPL-3.0-or-later

## Non publié

- Compatibilité Shadertoy : volumes 3D (`sampler3D`, fichiers `.bin`), mipmaps des cubemaps et des buffers lus en filtre
  `mipmap`, filtrage correct des textures 8 bits sur les appareils sans `OES_texture_float_linear`, textures `srgb`,
  `iChannelTime` des canaux vidéo et musique, `iChannelResolution.z` des volumes.
- Correction : les uniforms `iChannel1` à `iChannel3` lisaient tous l'unité de texture 0 ; chaque canal lit désormais sa texture.
- Correction : la texture clavier est lue au plus proche voisin.
- Les 443 shaders du catalogue compilent : macro `HW_PERFORMANCE`, uniforms standard redéclarés retirés, type d'échantillonneur
  (cubemap, volume) déduit du code pour les canaux dont l'entrée manque dans le JSON.
- Inspecteur : rubrique « Compatibilité » (conversions GLSL, `mainVR` ignorée, types déduits, précision flottante) et alerte avec
  bouton « Suspendre » pour un shader lent.
- Banc de régression visuelle (`tools/regression-visuelle.mjs`), corpus et images de référence.
- Correction : l'export MP4 échouait au-delà d'environ 720p (H.264 Baseline niveau 3.0 seul) ; les niveaux 3.0 à 5.2 sont essayés
  selon la taille et la cadence demandées, comme les niveaux VP9 et AV1 pour le WebM.
- Correction : une perte de contexte WebGL pouvait interrompre définitivement la boucle d'animation (exception de `rendre()`).
- Bouton « Diagnostic » (texte à copier, rien n'est envoyé) et journal borné des erreurs d'exécution.
- Avertissement avant un export de plus de 500 Mo quand le navigateur ne peut pas écrire directement le fichier.
- Contrôles en navigateur réel de l'export (relecture, annulation, stockage temporaire, 1080p60, synchronisation audio/vidéo).

## v1.1.0

- Lecture des entrées `video` : un fichier de `shaders/media/` alimente le canal en texture vidéo, calée sur l'horloge du shader
  (image par image à l'export).
- Correction : les textures de médias (images, vidéos) ne sont plus libérées pendant la lecture d'une piste `music`/`musicstream`.

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

- La lecture d'une entrée `video` n'est pas implémentée (ajoutée après cette version).
- L'export WebM n'a pas été validé dans un lecteur externe, et la synchronisation audio/vidéo d'un MP4 AAC reste à confirmer à l'écoute.
- Le repli par téléchargement du navigateur garde l'export complet en mémoire ; l'écriture directe exige l'API File System Access.
- L'export exige WebCodecs et les codecs correspondants ; la compatibilité Firefox et Safari n'a pas été vérifiée.
