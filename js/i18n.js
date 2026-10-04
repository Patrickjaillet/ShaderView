// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

export const LANGUES = Object.freeze(['fr', 'en']);
export const LANGUE_PAR_DEFAUT = 'fr';
const CLE_LANGUE = 'shaderview.langue';

const MESSAGES = Object.freeze({
  fr: Object.freeze({
    'viewer.label': 'Visionneuse',
    'viewer.canvas': 'Rendu du shader sélectionné',
    'transport.play': 'Lire',
    'transport.pause': 'Pause',
    'transport.reset': 'Remettre à zéro',
    'transport.loop': 'Boucle (0–60 s)',
    'transport.fullscreen': 'Plein écran',
    'transport.capture': 'Capture PNG',
    'transport.captureDone': 'Capture PNG téléchargée.',
    'transport.captureFailed': 'Capture PNG impossible : {message}',
    'transport.fullscreenFailed': 'Plein écran indisponible : {message}',
    'transport.captureNoData': 'L’encodage PNG n’a retourné aucune donnée.',
    'transport.position': 'Position de lecture, en secondes',
    'transport.time': '{current} s / {total} s',
    'language.label': 'Changer la langue',
    'export.open': 'Exporter la vidéo…',
    'export.title': 'Exporter le shader',
    'common.close': 'Fermer',
    'export.format': 'Format',
    'export.resolution': 'Résolution',
    'export.fps': 'Fréquence d’images',
    'export.fps24': '24 i/s',
    'export.fps30': '30 i/s',
    'export.fps60': '60 i/s',
    'export.range': 'Plage temporelle (secondes)',
    'export.start': 'Début',
    'export.end': 'Fin',
    'export.videoBitrate': 'Débit vidéo (kbit/s)',
    'export.audioBitrate': 'Débit audio (kbit/s)',
    'export.includeAudio': 'Inclure la passe son du shader',
    'export.cancel': 'Annuler l’export',
    'export.startButton': 'Lancer l’export',
    'sound.play': 'Lire le son',
    'sound.pause': 'Mettre en pause',
    'catalog.title': 'Shaders',
    'catalog.openFolder': 'Ouvrir un dossier…',
    'catalog.openFiles': 'Ouvrir des .json…',
    'catalog.search': 'Rechercher',
    'catalog.searchPlaceholder': 'Rechercher (titre, auteur, tag…)',
    'catalog.filters': 'Filtres',
    'catalog.multiPass': 'Multipasse',
    'catalog.sound': 'Avec son',
    'catalog.errors': 'Erreurs',
    'catalog.missingMedia': 'Médias manquants',
    'catalog.sort': 'Trier par',
    'catalog.sortFilename': 'Nom de fichier',
    'catalog.sortTitle': 'Titre',
    'catalog.sortAuthor': 'Auteur',
    'catalog.sortSize': 'Taille',
    'catalog.sortDate': 'Date',
    'catalog.reverseSort': 'Inverser le sens du tri',
    'catalog.loading': 'Chargement du catalogue…',
    'catalog.unavailable': 'Catalogue indisponible : {message} Ouvrez le dossier shaders/ ou déposez vos fichiers .json.',
    'catalog.readingFiles': 'Lecture des fichiers…',
    'catalog.readProgress': 'Lecture des fichiers… {done}/{total}',
    'catalog.nativePickerFallback': 'Sélecteur natif indisponible ({message}), repli sur le sélecteur classique.',
    'catalog.list': 'Liste des shaders',
    'catalog.help': 'Sans manifeste, ouvrez le dossier shaders/ ou déposez ici vos fichiers .json.',
    'catalog.drop': 'Déposez un dossier ou des fichiers .json',
    'drop.required': 'ShaderView nécessite JavaScript et WebGL2 pour afficher les shaders.',
    'passes.label': 'Passes du shader',
    'export.checking': 'Vérification des codecs disponibles…',
    'export.audioNone': 'Ce shader ne contient pas de passe son.',
    'export.audioUnavailable': 'Aucun codec audio {codec} compatible n’est disponible ; l’export sera vidéo seule.',
    'export.audioIncluded': 'L’audio sera encodé en {codec} et synchronisé avec la vidéo.',
    'export.audioCheckFailed': 'Vérification AAC/Opus impossible : {message}',
    'export.codecsNone': 'Aucun codec vidéo WebM détecté. Vérifiez la disponibilité de WebCodecs dans ce navigateur.',
    'export.codecsAvailable': 'Codecs disponibles — WebM : {webm}{mp4}',
    'export.mp4Unavailable': ' ; H.264/MP4 indisponible',
    'export.rangeInvalid': 'La plage doit durer entre 0,1 et 600 secondes et commencer à zéro ou après.',
    'export.prepare': 'Préparation de l’export…',
    'export.audioRender': 'Rendu audio {percent} %',
    'export.render': 'Rendu des images',
    'export.videoEncode': 'Encodage vidéo',
    'export.audioEncode': 'Encodage audio',
    'export.mux': 'Muxage',
    'export.muxDone': 'Muxage terminé',
    'export.write': 'Écriture du fichier ({percent} %)',
    'export.complete': 'Export terminé : {filename}',
    'export.cancelled': 'Export annulé.',
    'export.failed': 'Échec de l’export : {message}',
    'export.invalidBlob': 'Le navigateur n’a pas produit de fichier vidéo valide.',
    'export.remaining': ' — environ {seconds} s restantes',
    'export.progress': '{label} : {done}/{total} {unit}{remaining}',
    'export.unit.bytes': 'octets',
    'export.unit.chunks': 'paquets',
    'export.closingFailure': ' Échec de fermeture du fichier temporaire : {message}',
    'audio.prepare': 'Préparation du son…',
    'audio.ready': 'Prêt ({seconds} s).',
    'audio.synchronized': 'Lecture du son et de l’image synchronisée.',
    'audio.autoplayBlocked': 'Le navigateur bloque le démarrage automatique. Cliquez sur « Lire le son » pour démarrer le son et l’image ensemble.',
    'audio.paused': 'Lecture du son et de l’image en pause.',
    'audio.unavailable': 'Son non disponible : {message}',
    'audio.playbackFailed': 'Lecture impossible : {message}',
    'music.loading': 'Chargement de « {name} »…',
    'music.loaded': '« {name} » chargée.',
    'music.playing': '« {name} » chargée et en lecture synchronisée avec le shader.',
    'music.autoplayBlocked': '« {name} » chargée. Utilisez Lecture pour démarrer la piste avec le shader.',
    'music.autoplayBlockedGeneric': 'Lecture automatique bloquée. Utilisez Lecture pour démarrer le son et l’image ensemble.',
    'music.playbackFailed': 'Lecture impossible : {message}',
    'catalog.none': 'Aucun fichier .json trouvé ({source}).',
    'catalog.entries': '{count} entrée(s) ({source})',
    'catalog.count': '{count} entrée(s)',
    'catalog.countOf': '{count} entrée(s) sur {total}',
    'catalog.inError': ', dont {count} en erreur',
    'catalog.source.manifest': 'manifeste',
    'catalog.source.folder': 'dossier local',
    'catalog.source.files': 'fichiers locaux',
    'catalog.stale': 'Le fichier a changé depuis la génération du manifeste : relancer « node tools/build-manifest.mjs ».',
    'catalog.compileError': 'Erreur de compilation (voir le journal ci-dessous).',
    'catalog.unreadable': 'Lecture impossible : {message}',
    'drop.failed': 'Dépôt impossible : {message}',
    'sound.prepareProgress': 'Préparation du son… {percent} %',
    'sound.readFailed': 'Lecture impossible : {message}',
    'inspector.noChannels': 'Aucune entrée de canal.',
    'inspector.missingMusic': 'iChannel{channel} (musique manquante) :',
    'inspector.chooseTrack': '— choisir une piste —',
    'inspector.line': 'Ligne {line} : {message}',
    'inspector.author': 'par {author}',
    'inspector.framesPerSecond': 'i/s',
    'inspector.pass.common': 'Common',
    'inspector.pass.image': 'Image',
    'inspector.pass.sound': 'Sound',
    'inspector.channel.keyboard': 'clavier',
    'inspector.channel.mic': 'micro',
    'inspector.channel.music': 'musique',
    'inspector.channel.musicstream': 'flux musical',
    'inspector.channel.video': 'vidéo',
    'inspector.channel.misc': 'divers',
    'inspector.badge.missingMedia': 'média manquant',
    'inspector.badge.warning': '{count} avertissement(s)',
    'inspector.badge.multiPass': 'multipasse',
    'inspector.badge.sound': 'son',
    'footer.license': '© 2026 SANDEFJORD / Patrick JAILLET — Distribué sous licence GPL-3.0-or-later',
  }),
  en: Object.freeze({
    'viewer.label': 'Viewer',
    'viewer.canvas': 'Rendering of the selected shader',
    'transport.play': 'Play',
    'transport.pause': 'Pause',
    'transport.reset': 'Reset',
    'transport.loop': 'Loop (0–60 s)',
    'transport.fullscreen': 'Fullscreen',
    'transport.capture': 'PNG capture',
    'transport.captureDone': 'PNG capture downloaded.',
    'transport.captureFailed': 'PNG capture failed: {message}',
    'transport.fullscreenFailed': 'Fullscreen unavailable: {message}',
    'transport.captureNoData': 'PNG encoding returned no data.',
    'transport.position': 'Playback position, in seconds',
    'transport.time': '{current} s / {total} s',
    'language.label': 'Change language',
    'export.open': 'Export video…',
    'export.title': 'Export shader',
    'common.close': 'Close',
    'export.format': 'Format',
    'export.resolution': 'Resolution',
    'export.fps': 'Frame rate',
    'export.fps24': '24 fps',
    'export.fps30': '30 fps',
    'export.fps60': '60 fps',
    'export.range': 'Time range (seconds)',
    'export.start': 'Start',
    'export.end': 'End',
    'export.videoBitrate': 'Video bitrate (kbit/s)',
    'export.audioBitrate': 'Audio bitrate (kbit/s)',
    'export.includeAudio': 'Include the shader sound pass',
    'export.cancel': 'Cancel export',
    'export.startButton': 'Start export',
    'sound.play': 'Play sound',
    'sound.pause': 'Pause sound',
    'catalog.title': 'Shaders',
    'catalog.openFolder': 'Open a folder…',
    'catalog.openFiles': 'Open .json files…',
    'catalog.search': 'Search',
    'catalog.searchPlaceholder': 'Search (title, author, tag…)',
    'catalog.filters': 'Filters',
    'catalog.multiPass': 'Multipass',
    'catalog.sound': 'With sound',
    'catalog.errors': 'Errors',
    'catalog.missingMedia': 'Missing media',
    'catalog.sort': 'Sort by',
    'catalog.sortFilename': 'Filename',
    'catalog.sortTitle': 'Title',
    'catalog.sortAuthor': 'Author',
    'catalog.sortSize': 'Size',
    'catalog.sortDate': 'Date',
    'catalog.reverseSort': 'Reverse sort order',
    'catalog.loading': 'Loading catalog…',
    'catalog.unavailable': 'Catalog unavailable: {message} Open the shaders/ folder or drop your .json files here.',
    'catalog.readingFiles': 'Reading files…',
    'catalog.readProgress': 'Reading files… {done}/{total}',
    'catalog.nativePickerFallback': 'Native folder picker unavailable ({message}); falling back to the standard picker.',
    'catalog.list': 'Shader list',
    'catalog.help': 'Without a manifest, open the shaders/ folder or drop your .json files here.',
    'catalog.drop': 'Drop a folder or .json files',
    'drop.required': 'ShaderView requires JavaScript and WebGL2 to display shaders.',
    'passes.label': 'Shader passes',
    'export.checking': 'Checking available codecs…',
    'export.audioNone': 'This shader has no sound pass.',
    'export.audioUnavailable': 'No compatible {codec} audio codec is available; export will be video-only.',
    'export.audioIncluded': 'Audio will be encoded as {codec} and synchronized with the video.',
    'export.audioCheckFailed': 'Could not check AAC/Opus support: {message}',
    'export.codecsNone': 'No WebM video codec detected. Check WebCodecs availability in this browser.',
    'export.codecsAvailable': 'Available codecs — WebM: {webm}{mp4}',
    'export.mp4Unavailable': ' ; H.264/MP4 unavailable',
    'export.rangeInvalid': 'The range must be between 0.1 and 600 seconds and start at zero or later.',
    'export.prepare': 'Preparing export…',
    'export.audioRender': 'Rendering audio {percent}%',
    'export.render': 'Rendering frames',
    'export.videoEncode': 'Encoding video',
    'export.audioEncode': 'Encoding audio',
    'export.mux': 'Muxing',
    'export.muxDone': 'Muxing complete',
    'export.write': 'Writing file ({percent}%)',
    'export.complete': 'Export complete: {filename}',
    'export.cancelled': 'Export cancelled.',
    'export.failed': 'Export failed: {message}',
    'export.invalidBlob': 'The browser did not produce a valid video file.',
    'export.remaining': ' — about {seconds} s remaining',
    'export.progress': '{label}: {done}/{total} {unit}{remaining}',
    'export.unit.bytes': 'bytes',
    'export.unit.chunks': 'chunks',
    'export.closingFailure': ' Could not close the temporary file: {message}',
    'audio.prepare': 'Preparing sound…',
    'audio.ready': 'Ready ({seconds} s).',
    'audio.synchronized': 'Sound and image are playing in sync.',
    'audio.autoplayBlocked': 'The browser blocked automatic playback. Click “Play sound” to start sound and image together.',
    'audio.paused': 'Sound and image playback paused.',
    'audio.unavailable': 'Sound unavailable: {message}',
    'audio.playbackFailed': 'Playback failed: {message}',
    'music.loading': 'Loading “{name}”…',
    'music.loaded': '“{name}” loaded.',
    'music.playing': '“{name}” loaded and playing in sync with the shader.',
    'music.autoplayBlocked': '“{name}” loaded. Use Play to start the track with the shader.',
    'music.autoplayBlockedGeneric': 'Automatic playback was blocked. Use Play to start sound and image together.',
    'music.playbackFailed': 'Playback failed: {message}',
    'catalog.none': 'No .json files found ({source}).',
    'catalog.entries': '{count} shader file(s) ({source})',
    'catalog.count': '{count} shader(s)',
    'catalog.countOf': '{count} of {total} shader(s)',
    'catalog.inError': ', including {count} with errors',
    'catalog.source.manifest': 'manifest',
    'catalog.source.folder': 'local folder',
    'catalog.source.files': 'local files',
    'catalog.stale': 'The file changed since the manifest was generated: run “node tools/build-manifest.mjs” again.',
    'catalog.compileError': 'Compilation error (see the log below).',
    'catalog.unreadable': 'Could not read: {message}',
    'drop.failed': 'Drop failed: {message}',
    'sound.prepareProgress': 'Preparing sound… {percent}%',
    'sound.readFailed': 'Playback failed: {message}',
    'inspector.noChannels': 'No channel inputs.',
    'inspector.missingMusic': 'iChannel{channel} (missing music):',
    'inspector.chooseTrack': '— choose a track —',
    'inspector.line': 'Line {line}: {message}',
    'inspector.author': 'by {author}',
    'inspector.framesPerSecond': 'fps',
    'inspector.pass.common': 'Common',
    'inspector.pass.image': 'Image',
    'inspector.pass.sound': 'Sound',
    'inspector.channel.keyboard': 'keyboard',
    'inspector.channel.mic': 'microphone',
    'inspector.channel.music': 'music',
    'inspector.channel.musicstream': 'music stream',
    'inspector.channel.video': 'video',
    'inspector.channel.misc': 'misc',
    'inspector.badge.missingMedia': 'missing media',
    'inspector.badge.warning': '{count} warning(s)',
    'inspector.badge.multiPass': 'multipass',
    'inspector.badge.sound': 'sound',
    'footer.license': '© 2026 SANDEFJORD / Patrick JAILLET — Distributed under the GPL-3.0-or-later license',
  }),
});

let langueCourante = LANGUE_PAR_DEFAUT;

export function traduire(cle, variables = {}, langue = langueCourante) {
  const messages = MESSAGES[langue] ?? MESSAGES[LANGUE_PAR_DEFAUT];
  const modele = messages[cle] ?? MESSAGES[LANGUE_PAR_DEFAUT][cle] ?? cle;
  return modele.replace(/\{([a-zA-Z][\w]*)\}/g, (correspondance, nom) => String(variables[nom] ?? correspondance));
}

export function langue() {
  return langueCourante;
}

export function definirLangue(nouvelleLangue, { document = globalThis.document, stockage = globalThis.localStorage } = {}) {
  if (!LANGUES.includes(nouvelleLangue)) throw new RangeError(`Langue non prise en charge : ${nouvelleLangue}.`);
  langueCourante = nouvelleLangue;
  try {
    stockage?.setItem(CLE_LANGUE, langueCourante);
  } catch {
    // Le choix de langue reste actif pour cette page si le stockage est indisponible.
  }
  if (document?.documentElement) document.documentElement.lang = langueCourante;
  appliquerTraductions(document);
  const EvenementPersonnalise = document?.defaultView?.CustomEvent ?? globalThis.CustomEvent;
  if (EvenementPersonnalise) document?.dispatchEvent?.(new EvenementPersonnalise('shaderview:langue', { detail: { langue: langueCourante } }));
  return langueCourante;
}

export function initialiserLangue({ document = globalThis.document, stockage = globalThis.localStorage } = {}) {
  let preferee = LANGUE_PAR_DEFAUT;
  try {
    const enregistree = stockage?.getItem(CLE_LANGUE);
    if (LANGUES.includes(enregistree)) preferee = enregistree;
  } catch {
    preferee = LANGUE_PAR_DEFAUT;
  }
  langueCourante = preferee;
  if (document?.documentElement) document.documentElement.lang = preferee;
  appliquerTraductions(document);
  return preferee;
}

export function appliquerTraductions(racine = globalThis.document) {
  if (racine === null || racine === undefined) return;
  const elements = [];
  if (racine.nodeType === 1 && racine.matches?.('[data-i18n], [data-i18n-aria-label], [data-i18n-title], [data-i18n-placeholder]')) {
    elements.push(racine);
  }
  elements.push(...(racine.querySelectorAll?.('[data-i18n], [data-i18n-aria-label], [data-i18n-title], [data-i18n-placeholder]') ?? []));
  for (const element of elements) {
    if (element.dataset.i18n) element.textContent = traduire(element.dataset.i18n);
    for (const [attribut, cle] of [
      ['aria-label', element.dataset.i18nAriaLabel],
      ['title', element.dataset.i18nTitle],
      ['placeholder', element.dataset.i18nPlaceholder],
    ]) {
      if (cle) element.setAttribute(attribut, traduire(cle));
    }
  }
}
