// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Point d'entrée : charge le catalogue au démarrage (manifeste), propose les replis locaux
// (dossier, fichiers, glisser-déposer), délègue le panneau latéral et la vue détail à
// l'inspecteur (js/inspector.js), et rend l'ensemble des passes (buffers, cubemaps, image,
// son, médias) via le moteur de rendu et les modules des Phases 3 à 6. Ce fichier reste
// l'orchestration : catalogue, moteur de rendu, son, médias ; aucune construction de DOM
// de liste ou de détail ici (voir js/inspector.js).
//
// Tout le contenu issu des fichiers (titres, messages d'erreur) est inséré avec
// `textContent` : aucun texte provenant d'un shader n'est interprété comme du HTML.

import {
  SOURCES,
  catalogueDepuisFichiers,
  chargerBibliothequeAudio,
  chargerManifeste,
  choisirDossierNatif,
  collecterDepot,
  dossierNatifDisponible,
  fichiersDepuisSelection,
  manifesteAChange,
  reanalyserDossierNatif,
  selectionnerJson,
} from './catalog.js';
import { ErreurParseur, parserShader } from './parser.js';
import { ErreurCompilation, ErreurContexte, MoteurRendu, TAILLE_FACE_CUBEMAP, convertirGles1VersGles3, convertirShaderNormalise } from './renderer.js';
import { decoderImage, genererMediaSubstitue, resoudreNomMedia } from './media.js';
import { CANAUX_AVEC_MEDIA } from './shader-meta.js';
import { LecteurAudio, TAILLE_FFT, construireTextureVisualiseur, rendreSonHorsLigne } from './audio.js';
import { Inspecteur, elementsDepuisDocument } from './inspector.js';
import { GenerateurMiniatures } from './thumbnails.js';
import { ExportVideo, FORMAT_EXPORT, nomFichierExport as fabriquerNomFichierExport } from './export/video.js';
import { definirLangue, initialiserLangue, langue, traduire } from './i18n.js';

const CLES_SOURCE = {
  [SOURCES.MANIFESTE]: 'catalog.source.manifest',
  [SOURCES.DOSSIER]: 'catalog.source.folder',
  [SOURCES.FICHIERS]: 'catalog.source.files',
};

const etat = {
  catalogue: null,
  inspecteur: null,
  // Miniatures statiques de la liste : un moteur partagé, une image PNG dédiée par entrée.
  miniatures: null,
  jetonCatalogue: 0,
  jetonSelection: 0,
  moteur: null,
  boucleActive: false,
  contexteAudio: null,
  lecteurSon: null,
  // Entrées music/musicstream actives, par src : { lecteur: LecteurAudio, trame: Float32Array }.
  // Leur texture visualiseur (FFT, 512 × 2) est recalculée à chaque image tant que la
  // lecture est en cours (voir demarrerBoucle, mettreAJourVisualiseurs).
  visualiseursMusique: new Map(),
  // Pour les statistiques de performance (FPS lissé sur quelques images, voir mettreAJourStatsPerf).
  dernieresDurees: [],
  normaliseActive: null,
  entreeSelectionnee: null,
  exportEnCours: false,
  annulationExport: null,
  codecsAudioExport: null,
  jetonCodecsAudioExport: 0,
  // Rechargement automatique : handle du dossier natif ouvert (source DOSSIER, pour le
  // resonder sans redemander la permission) et minuteur de sondage périodique (voir
  // demarrerSondageCatalogue). Un sélecteur de fichiers isolés (SOURCES.FICHIERS) n'a
  // pas de dossier à resonder : seules les sources MANIFESTE et DOSSIER sont concernées.
  dossierNatifHandle: null,
  minuteurSondage: null,
  // Bibliothèque de musiques de remplacement (audio/manifest.json, voir catalog.js) ;
  // chargée une seule fois au démarrage, indépendamment du catalogue de shaders.
  bibliothequeAudio: null,
  // Entrées music/musicstream non résolues du shader en cours, par src : l'entrée
  // normalisée elle-même (pour relancer la résolution avec la piste choisie, voir
  // choisirPisteManuelle). Vidé à chaque nouvelle sélection (voir rendreSelection).
  entreesMusiqueNonResolues: new Map(),
};

const INTERVALLE_SONDAGE_MS = 5000;
const DUREE_TRANSPORT_SECONDES = 60;

const el = {};

// ---------------------------------------------------------------------------
// Rendu (multipasse : buffers, cubemaps, image ; son hors de ce moteur, Phase 6)
// ---------------------------------------------------------------------------

function demarrerMoteur() {
  try {
    etat.moteur = new MoteurRendu(el.viewport);
  } catch (e) {
    // WebGL2 indisponible : le viewport reste noir, la sélection affiche l'erreur
    // (voir afficherErreurRendu), mais le reste de l'interface (catalogue, détail) fonctionne.
    etat.moteur = null;
    if (e instanceof ErreurContexte) return e.message;
    throw e;
  }
  return null;
}

function brancherSouris() {
  const position = (evenement) => {
    const rect = el.viewport.getBoundingClientRect();
    // Conversion des coordonnées CSS (mise à l'échelle adaptative) vers les pixels
    // du viewport fixe 800 × 450 : iMouse doit rester indépendant de la taille affichée.
    const x = ((evenement.clientX - rect.left) / rect.width) * el.viewport.width;
    const y = ((evenement.clientY - rect.top) / rect.height) * el.viewport.height;
    return { x, y };
  };
  el.viewport.addEventListener('pointermove', (e) => {
    if (etat.moteur === null) return;
    const { x, y } = position(e);
    etat.moteur.souris.deplacer(x, y, el.viewport.height);
  });
  el.viewport.addEventListener('pointerdown', (e) => {
    if (etat.moteur === null) return;
    const { x, y } = position(e);
    etat.moteur.souris.deplacer(x, y, el.viewport.height);
    etat.moteur.souris.appuyer();
  });
  window.addEventListener('pointerup', () => {
    if (etat.moteur !== null) etat.moteur.souris.relacher();
  });
}

// Clavier Shadertoy (texture 256 × 3, voir renderer.js EtatClavier) : capté sur le
// viewport, rendu focusable (tabindex) pour recevoir les événements sans gêner la
// navigation au clavier du reste de l'interface (catalogue, boutons).
function brancherClavier() {
  el.viewport.tabIndex = 0;
  el.viewport.addEventListener('keydown', (e) => {
    if (etat.moteur !== null) etat.moteur.clavier.appuyer(e.keyCode, e.repeat);
  });
  el.viewport.addEventListener('keyup', (e) => {
    if (etat.moteur !== null) etat.moteur.clavier.relacher(e.keyCode);
  });
}

/**
 * Résolutions des buffers du shader en cours, pour les statistiques de performance
 * de l'inspecteur (voir Inspecteur.afficherStatsPerf). Le viewport est fixe 800 × 450 :
 * les buffers A à D y sont toujours rendus à cette même résolution (voir renderer.js,
 * Tampon) ; les cubemaps à TAILLE_FACE_CUBEMAP, fixe elle aussi.
 * @param {import('./parser.js').ShaderNormalise|null} normalise
 * @returns {{ nom: string, largeur: number, hauteur: number }[]}
 */
function resolutionsBuffers(normalise) {
  if (normalise === null) return [];
  const buffers = Object.keys(normalise.buffers).sort().map((lettre) => ({ nom: `Buffer ${lettre}`, largeur: el.viewport.width, hauteur: el.viewport.height }));
  const cubemaps = Object.keys(normalise.cubemaps).map((nom) => ({ nom, largeur: TAILLE_FACE_CUBEMAP, hauteur: TAILLE_FACE_CUBEMAP }));
  return [...buffers, ...cubemaps];
}

function mettreAJourStatsPerf(deltaSecondes) {
  if (deltaSecondes <= 0) return;
  etat.dernieresDurees.push(deltaSecondes);
  if (etat.dernieresDurees.length > 30) etat.dernieresDurees.shift();
  const moyenne = etat.dernieresDurees.reduce((s, d) => s + d, 0) / etat.dernieresDurees.length;
  etat.inspecteur.afficherStatsPerf({ fps: moyenne > 0 ? 1 / moyenne : 0, resolutionsBuffers: resolutionsBuffers(etat.normaliseActive) });
}

function mettreAJourTransport() {
  if (etat.moteur === null || el.transportTemps === undefined) return;
  const temps = etat.moteur.horloge.temps;
  el.transportTemps.value = traduire('transport.time', {
    current: temps.toFixed(2),
    total: DUREE_TRANSPORT_SECONDES.toFixed(2),
  });
  el.transportTemps.textContent = el.transportTemps.value;
  if (document.activeElement !== el.transportPosition) el.transportPosition.value = String(Math.min(temps, DUREE_TRANSPORT_SECONDES));
  const enMarche = etat.moteur.horloge.enMarche;
  el.transportLecture.textContent = traduire(enMarche ? 'transport.pause' : 'transport.play');
  el.transportLecture.setAttribute('aria-pressed', String(enMarche));
}

function definirDisponibiliteTransport(disponible) {
  for (const controle of [el.transportLecture, el.transportReset, el.transportPosition, el.transportBoucle, el.transportPleinEcran, el.transportCapture]) {
    controle.disabled = !disponible;
  }
  if (!disponible) {
    el.transportPosition.value = '0';
    el.transportTemps.value = traduire('transport.time', { current: '0.00', total: DUREE_TRANSPORT_SECONDES.toFixed(2) });
    el.transportTemps.textContent = el.transportTemps.value;
  } else {
    mettreAJourTransport();
  }
}

function brancherTransport() {
  el.transportLecture.addEventListener('click', () => {
    if (etat.moteur === null || etat.exportEnCours) return;
    const horloge = etat.moteur.horloge;
    if (horloge.enMarche) horloge.pause();
    else {
      if (horloge.temps >= DUREE_TRANSPORT_SECONDES) {
        horloge.remettreAZero();
        etat.moteur.reinitialiserTampons();
      }
      horloge.lire();
    }
    mettreAJourTransport();
  });
  el.transportReset.addEventListener('click', () => {
    if (etat.moteur === null || etat.exportEnCours) return;
    etat.moteur.horloge.pause();
    etat.moteur.horloge.remettreAZero();
    etat.moteur.reinitialiserTampons();
    el.transportEtat.textContent = '';
    mettreAJourTransport();
  });
  el.transportPosition.addEventListener('input', () => {
    if (etat.moteur === null || etat.exportEnCours) return;
    const secondes = Number(el.transportPosition.value);
    const horloge = etat.moteur.horloge;
    horloge.definirEtat(secondes, Math.round(secondes * 30), 0);
    etat.moteur.reinitialiserTampons();
    mettreAJourTransport();
  });
  el.transportPleinEcran.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === el.scene) await document.exitFullscreen();
      else await el.scene.requestFullscreen();
    } catch (erreur) {
      el.transportEtat.textContent = traduire('transport.fullscreenFailed', {
        message: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  });
  el.transportCapture.addEventListener('click', () => {
    try {
      el.viewport.toBlob((blob) => {
        if (blob === null) {
          el.transportEtat.textContent = traduire('transport.captureFailed', { message: traduire('transport.captureNoData') });
          return;
        }
        const lien = document.createElement('a');
        const titre = etat.entreeSelectionnee?.titre ?? 'ShaderView';
        const nom = titre.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim() || 'shader';
        const url = URL.createObjectURL(blob);
        lien.href = url;
        lien.download = `${nom}.png`;
        document.body.append(lien);
        lien.click();
        setTimeout(() => {
          lien.remove();
          URL.revokeObjectURL(url);
        }, 0);
        el.transportEtat.textContent = traduire('transport.captureDone');
      }, 'image/png');
    } catch (erreur) {
      el.transportEtat.textContent = traduire('transport.captureFailed', {
        message: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  });
  el.transportBoucle.addEventListener('change', () => {
    el.transportEtat.textContent = '';
  });
  document.addEventListener('fullscreenchange', () => {
    el.transportPleinEcran.setAttribute('aria-pressed', String(document.fullscreenElement === el.scene));
  });
}

function demarrerBoucle() {
  if (etat.boucleActive) return;
  etat.boucleActive = true;
  let dernierHorodatage = null;
  const image = (horodatage) => {
    if (!etat.boucleActive) return;
    if (etat.moteur !== null && !etat.exportEnCours) {
      const deltaSecondes = dernierHorodatage === null ? 0 : (horodatage - dernierHorodatage) / 1000;
      dernierHorodatage = horodatage;
      if (etat.moteur.horloge.enMarche) {
        etat.moteur.horloge.avancer(deltaSecondes);
        if (etat.moteur.horloge.temps >= DUREE_TRANSPORT_SECONDES) {
          if (el.transportBoucle?.checked) {
            etat.moteur.horloge.remettreAZero();
            etat.moteur.reinitialiserTampons();
          } else {
            etat.moteur.horloge.sauterA(DUREE_TRANSPORT_SECONDES);
            etat.moteur.horloge.pause();
          }
        }
      }
      mettreAJourVisualiseurs();
      etat.moteur.rendre();
      mettreAJourTransport();
      mettreAJourStatsPerf(deltaSecondes);
    }
    requestAnimationFrame(image);
  };
  requestAnimationFrame(image);
}

/**
 * Normalise, convertit et compile l'ensemble des passes du shader sélectionné
 * (buffers, cubemaps, image — la passe son reste hors de ce moteur, Phase 6). Les
 * erreurs de compilation (ErreurCompilation) affichent leur journal dans l'onglet de
 * la passe fautive, avec le numéro de ligne du code utilisateur quand il a pu être
 * déterminé ; une erreur de normalisation (ErreurParseur, ex. aucune passe « image »,
 * plus de quatre buffers) est également affichée sans bloquer le reste de l'interface.
 * L'horloge, la souris et les buffers de rétroaction repartent de zéro à chaque
 * sélection. Les médias externes (Phase 5) ne sont pas chargés ici : voir
 * chargerMediasSelection, appelée séparément par l'appelant avec le `ShaderNormalise` renvoyé.
 * @param {object} shader shader brut (objet Shadertoy), tel qu'obtenu de catalogue.contenu
 * @returns {import('./parser.js').ShaderNormalise|undefined} le shader normalisé en cas de succès, undefined sinon
 */
function rendreSelection(shader) {
  if (etat.moteur === null) return;
  etat.moteur.horloge.remettreAZero();
  etat.moteur.horloge.lire();
  let normalise;
  try {
    normalise = parserShader(shader);
  } catch (e) {
    if (e instanceof ErreurParseur) { etat.inspecteur.afficherAlerte(e.message); return; }
    throw e;
  }
  etat.inspecteur.afficherPasses(normalise);
  try {
    etat.moteur.compiler(convertirShaderNormalise(normalise));
    etat.moteur.reinitialiserTampons();
  } catch (e) {
    if (e instanceof ErreurCompilation) {
      etat.inspecteur.afficherJournalCompilation(e.idPasse ?? 'image', e.erreursLigne);
      etat.inspecteur.afficherAlerte(e.erreursLigne.length > 0 ? traduire('catalog.compileError') : e.message);
      etat.normaliseActive = null;
      return;
    }
    throw e;
  }
  etat.normaliseActive = normalise;
  return normalise;
}

// ---------------------------------------------------------------------------
// Son (Phase 6) : passe « sound » et entrées music/musicstream
// ---------------------------------------------------------------------------

/**
 * Contexte Web Audio unique de l'application, créé au premier besoin (la création
 * d'un AudioContext ne requiert pas de geste utilisateur, seul `resume()`/le
 * démarrage effectif d'une lecture en requiert un — voir LecteurAudio.lire).
 * @returns {AudioContext}
 */
function contexteAudio() {
  if (etat.contexteAudio === null) etat.contexteAudio = new AudioContext();
  return etat.contexteAudio;
}

function arreterSonSelection() {
  if (etat.lecteurSon !== null) { etat.lecteurSon.detruire(); etat.lecteurSon = null; }
  for (const { lecteur } of etat.visualiseursMusique.values()) lecteur.detruire();
  etat.visualiseursMusique.clear();
  etat.entreesMusiqueNonResolues.clear();
  etat.inspecteur.definirEtatSon(false, '');
  etat.inspecteur.afficherChoixMusique([]);
}

/**
 * Rend hors-ligne la passe « sound » du shader sélectionné, si elle existe, et
 * prépare le bouton de lecture. Le rendu (potentiellement long : jusqu'à 60 s audio
 * à calculer image par image côté GPU) s'exécute en arrière-plan, sans bloquer la
 * sélection ; abandonné sans effet si une autre sélection a eu lieu pendant le calcul.
 * @param {import('./parser.js').ShaderNormalise} normalise shader déjà converti (voir convertirShaderNormalise)
 * @param {number} jeton valeur de etat.jetonSelection au moment de l'appel
 */
async function preparerSonSelection(normalise, jeton) {
  if (normalise.son === null || etat.moteur === null) return;
  etat.inspecteur.afficherControleSon();
  etat.inspecteur.definirEtatSon(false, traduire('audio.prepare'));
  const code = convertirGles1VersGles3(normalise.son.code);
  const commun = normalise.commun !== null ? convertirGles1VersGles3(normalise.commun.code) : null;
  let tampon;
  try {
    tampon = await rendreSonHorsLigne(etat.moteur.gl, contexteAudio(), code, commun, {
      surProgres: async (fait, total) => {
        if (jeton === etat.jetonSelection) etat.inspecteur.definirEtatSon(false, traduire('sound.prepareProgress', { percent: Math.round((fait / total) * 100) }));
        // Rend la main au navigateur entre deux blocs : le calcul d'un shader son
        // (plusieurs synchronisations GPU via readPixels) ne doit pas geler l'affichage.
        await new Promise((resolu) => requestAnimationFrame(resolu));
      },
    });
  } catch (e) {
    if (jeton !== etat.jetonSelection) return;
    etat.inspecteur.definirEtatSon(false, e instanceof ErreurCompilation ? traduire('audio.unavailable', { message: e.message }) : (e instanceof Error ? e.message : String(e)));
    return;
  }
  if (jeton !== etat.jetonSelection) return;
  etat.lecteurSon = new LecteurAudio(contexteAudio(), tampon);
  etat.lecteurSon.volume = etat.inspecteur.volumePreference;
  etat.inspecteur.definirEtatSon(false, traduire('audio.ready', { seconds: tampon.duration.toFixed(1) }));
}

async function basculerLectureSon() {
  if (etat.lecteurSon === null) return;
  if (etat.lecteurSon.enMarche) {
    etat.lecteurSon.pause();
    etat.inspecteur.definirEtatMarcheSon(false);
    return;
  }
  try {
    await etat.lecteurSon.lire();
    etat.inspecteur.definirEtatMarcheSon(true);
  } catch (e) {
    etat.inspecteur.definirEtatSon(false, traduire('audio.playbackFailed', { message: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * Recalcule la texture visualiseur (FFT, 512 × 2) de chaque entrée music/musicstream
 * actuellement en lecture, à partir de sa position courante, et la fournit au moteur.
 * Appelée une fois par image (voir demarrerBoucle) : la trame change en continu tant
 * que la lecture avance, exactement comme Shadertoy recalcule ce canal en direct.
 */
function mettreAJourVisualiseurs() {
  if (etat.visualiseursMusique.size === 0 || etat.moteur === null) return;
  const textures = new Map();
  for (const [src, { lecteur, trame }] of etat.visualiseursMusique) {
    if (!lecteur.enMarche) continue;
    lecteur.copierTrameRecente(trame);
    textures.set(src, { octets: construireTextureVisualiseur(trame), largeur: TAILLE_FFT, hauteur: 2 });
  }
  if (textures.size > 0) etat.moteur.definirTexturesMedia(textures);
}

// ---------------------------------------------------------------------------
// Médias externes (Phase 5) : résolution, substitution procédurale, décodage
// ---------------------------------------------------------------------------

const TAILLE_SUBSTITUTION = 256;
const TAILLE_SUBSTITUTION_CUBEMAP = 64;

/**
 * Énumère toutes les entrées de canal du shader normalisé qui référencent un média
 * externe (voir shader-meta.js, CANAUX_AVEC_MEDIA), une par `src` distinct (plusieurs
 * passes ou canaux peuvent référencer le même fichier : il n'est résolu qu'une fois).
 * @param {import('./parser.js').ShaderNormalise} normalise
 * @returns {Map<string, import('./parser.js').Entree>} src (ou une clé synthétique si src est null) → première entrée rencontrée
 */
function entreesMediaUniques(normalise) {
  const parSrc = new Map();
  const passes = [normalise.commun, ...Object.values(normalise.buffers), ...Object.values(normalise.cubemaps), normalise.image].filter((p) => p !== null);
  for (const passe of passes) {
    for (const entree of passe.entrees) {
      if (!CANAUX_AVEC_MEDIA.has(entree.type)) continue;
      const cle = entree.src ?? `\0sans-src\0${entree.type}`;
      if (!parSrc.has(cle)) parSrc.set(cle, entree);
    }
  }
  return parSrc;
}

/**
 * Enregistre le lecteur audio et le visualiseur d'une entrée music/musicstream déjà
 * résolue (fichier d'origine trouvé dans shaders/media/, ou piste choisie manuellement
 * dans la bibliothèque — voir choisirPisteManuelle). Remplace silencieusement un
 * lecteur déjà actif pour le même `src` (ex. l'utilisateur change son choix).
 * @param {string} src clé de l'entrée (voir entreesMediaUniques)
 * @param {AudioBuffer} tampon
 */
function definirLecteurMusique(src, tampon) {
  const existant = etat.visualiseursMusique.get(src);
  if (existant !== undefined) existant.lecteur.detruire();
  etat.visualiseursMusique.set(src, { lecteur: new LecteurAudio(contexteAudio(), tampon), trame: new Float32Array(TAILLE_FFT) });
}

/**
 * Résout une entrée `music`/`musicstream` vers un lecteur audio : décode le fichier
 * reconnu dans `shaders/media/` et enregistre son visualiseur (voir
 * mettreAJourVisualiseurs, appelée à chaque image tant que la lecture avance). Ne
 * démarre jamais la lecture elle-même (politique d'autoplay : geste utilisateur requis ;
 * seule la passe « sound » a un contrôle de lecture aujourd'hui). Si le fichier
 * d'origine n'est pas fourni, l'entrée est signalée à l'inspecteur pour que
 * l'utilisateur puisse choisir une piste de remplacement dans la bibliothèque audio
 * (voir choisirPisteManuelle) plutôt que de rester silencieuse sans recours.
 * @param {import('./parser.js').Entree} entree
 * @param {import('./catalog.js').Catalogue} catalogue
 * @returns {Promise<boolean>} vrai si un lecteur a pu être créé (le canal n'a alors pas besoin de texture statique)
 */
async function preparerVisualiseurMusique(entree, catalogue) {
  const nom = resoudreNomMedia(entree.src, catalogue.media);
  if (nom === null) {
    etat.entreesMusiqueNonResolues.set(entree.src, entree);
    return false;
  }
  try {
    const brut = await catalogue.contenuMedia(nom);
    const tampon = await contexteAudio().decodeAudioData(brut.buffer.slice(brut.byteOffset, brut.byteOffset + brut.byteLength));
    definirLecteurMusique(entree.src, tampon);
    return true;
  } catch {
    // Fichier présent mais illisible/non décodable (format audio non géré) : proposé
    // au choix manuel comme s'il était absent, plutôt qu'une simple substitution muette.
    etat.entreesMusiqueNonResolues.set(entree.src, entree);
    return false;
  }
}

/**
 * Résout une entrée de canal vers une texture décodée (voir MoteurRendu.definirTexturesMedia) :
 * le fichier reconnu dans shaders/media/ s'il existe, sinon une substitution procédurale
 * déterministe. `webcam`/`mic` ne sont jamais chargés ici (toujours la texture de
 * repli — activation explicite non construite dans cette interface minimale) ;
 * `music`/`musicstream` déjà résolues en lecteur audio (voir preparerVisualiseurMusique)
 * ne repassent pas ici. Ne lève jamais d'exception : un média illisible retombe sur
 * la substitution procédurale.
 * @param {import('./parser.js').Entree} entree
 * @param {import('./catalog.js').Catalogue} catalogue
 * @returns {Promise<{ octets: Uint8Array, largeur: number, hauteur: number, cubemap?: boolean }|null>} null pour webcam/mic (pas de texture à fournir, la texture de repli reste active)
 */
async function resoudreTextureMedia(entree, catalogue) {
  if (entree.type === 'webcam' || entree.type === 'mic') return null;
  const taille = entree.type === 'cubemap' ? TAILLE_SUBSTITUTION_CUBEMAP : TAILLE_SUBSTITUTION;
  const nom = resoudreNomMedia(entree.src, catalogue.media);
  if (nom !== null && (entree.type === 'texture' || entree.type === 'cubemap')) {
    try {
      const brut = await catalogue.contenuMedia(nom);
      const image = await decoderImage(brut, entree.echantillonnage.retournementVertical);
      const canevas = new OffscreenCanvas(image.width, image.height);
      canevas.getContext('2d').drawImage(image, 0, 0);
      const octets = canevas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
      return { octets: new Uint8Array(octets), largeur: image.width, hauteur: image.height, cubemap: entree.type === 'cubemap' };
    } catch {
      // Fichier présent mais illisible/non décodable (format non géré, par exemple) :
      // substitution procédurale, comme si le fichier était absent.
    }
  }
  if (entree.type === 'music' || entree.type === 'musicstream') {
    if (await preparerVisualiseurMusique(entree, catalogue)) return null;
  }
  // `nom !== null` mais type « volume »/« video », ou music/musicstream non décodable :
  // pas encore de format local défini (volume) ou de lecture continue (vidéo).
  const octets = genererMediaSubstitue(entree.type, entree.src ?? entree.type, taille, taille);
  return { octets, largeur: taille, hauteur: taille, cubemap: entree.type === 'cubemap' };
}

/**
 * Résout et charge les textures de tous les médias externes du shader sélectionné,
 * puis les fournit au moteur. Fonctionne en arrière-plan, sans bloquer l'affichage :
 * le shader s'affiche d'abord avec la texture de repli sur ces canaux (voir
 * rendreSelection), puis chaque média apparaît dès qu'il est prêt. Abandonnée sans
 * effet si une autre sélection a eu lieu pendant le chargement (voir jeton).
 * @param {import('./parser.js').ShaderNormalise} normalise
 * @param {import('./catalog.js').Catalogue} catalogue
 * @param {number} jeton valeur de etat.jetonSelection au moment de l'appel
 */
async function chargerMediasSelection(normalise, catalogue, jeton) {
  etat.entreesMusiqueNonResolues.clear();
  const entrees = entreesMediaUniques(normalise);
  const resultats = await Promise.all(
    [...entrees.entries()].map(async ([cle, entree]) => [cle, entree.src, await resoudreTextureMedia(entree, catalogue)]),
  );
  if (jeton !== etat.jetonSelection || etat.moteur === null) return;
  const textures = new Map();
  for (const [, src, texture] of resultats) if (texture !== null && src !== null) textures.set(src, texture);
  if (textures.size > 0) etat.moteur.definirTexturesMedia(textures);
  afficherChoixMusique();
}

/**
 * Affiche dans l'inspecteur la liste des canaux music/musicstream non résolus du
 * shader en cours, avec la bibliothèque audio disponible pour chacun (voir
 * choisirPisteManuelle). Masque le panneau si aucun canal n'en a besoin, ou si la
 * bibliothèque est vide (rien à proposer).
 */
function afficherChoixMusique() {
  if (etat.entreesMusiqueNonResolues.size === 0 || etat.bibliothequeAudio === null || etat.bibliothequeAudio.pistes.length === 0) {
    etat.inspecteur.afficherChoixMusique([]);
    return;
  }
  const canaux = [...etat.entreesMusiqueNonResolues.values()].map((entree) => ({ src: entree.src, canal: entree.canal, type: entree.type }));
  etat.inspecteur.afficherChoixMusique(canaux, etat.bibliothequeAudio.pistes);
}

/**
 * Applique la piste choisie manuellement par l'utilisateur pour un canal
 * music/musicstream non résolu : décode la piste de la bibliothèque audio, remplace
 * la substitution procédurale par le lecteur/visualiseur réel (voir
 * definirLecteurMusique). Abandonné sans effet si le shader a changé depuis (le `src`
 * n'identifierait plus la bonne entrée).
 * @param {string} src clé de l'entrée (voir entreesMediaUniques)
 * @param {string} nomPiste nom de fichier, tel que listé dans etat.bibliothequeAudio.pistes
 */
async function choisirPisteManuelle(src, nomPiste) {
  if (etat.bibliothequeAudio === null || !etat.entreesMusiqueNonResolues.has(src)) return;
  const jeton = etat.jetonSelection;
  etat.inspecteur.definirEtatChoixMusique(src, traduire('music.loading', { name: nomPiste }));
  try {
    const brut = await etat.bibliothequeAudio.lire(nomPiste);
    const tampon = await contexteAudio().decodeAudioData(brut.buffer.slice(brut.byteOffset, brut.byteOffset + brut.byteLength));
    if (jeton !== etat.jetonSelection) return;
    definirLecteurMusique(src, tampon);
    etat.entreesMusiqueNonResolues.delete(src);
    etat.inspecteur.definirEtatChoixMusique(src, traduire('music.loaded', { name: nomPiste }));
  } catch (e) {
    if (jeton !== etat.jetonSelection) return;
    etat.inspecteur.definirEtatChoixMusique(src, traduire('music.playbackFailed', { message: e instanceof Error ? e.message : String(e) }));
  }
}

// ---------------------------------------------------------------------------
// Catalogue et sélection
// ---------------------------------------------------------------------------

/**
 * Remplace le catalogue affiché.
 * @param {import('./catalog.js').Catalogue} catalogue
 * @param {{ conserverSelection?: boolean }} [options] `conserverSelection` : vrai pour un
 *        rechargement automatique (voir demarrerSondageCatalogue) qui doit rouvrir la
 *        sélection en cours plutôt que la dernière mémorisée (faux au premier chargement).
 */
function appliquerCatalogue(catalogue, { conserverSelection = false } = {}) {
  const cleAConserver = conserverSelection ? etat.inspecteur.selectionCle : null;
  if (etat.catalogue !== null) etat.catalogue.vider();
  etat.catalogue = catalogue;
  etat.jetonSelection += 1;
  arreterSonSelection();
  etat.normaliseActive = null;
  // Avant l'inspecteur : sa reconstruction de la liste demande déjà les canevas du nouveau catalogue.
  etat.miniatures.definirCatalogue(catalogue);
  etat.inspecteur.definirCatalogue(catalogue);

  const n = catalogue.entrees.length;
  const source = traduire(CLES_SOURCE[catalogue.source]);
  const message = n === 0
    ? traduire('catalog.none', { source })
    : traduire('catalog.entries', { count: n, source });
  etat.inspecteur.definirMessageEtat(`${message}.`);

  // Reprend la sélection en cours (rechargement automatique) ou le dernier shader
  // sélectionné avant un rechargement manuel (préférence mémorisée, voir inspector.js),
  // si cette entrée existe toujours dans le nouveau catalogue.
  const cle = cleAConserver ?? etat.inspecteur.dernierShaderPreference;
  if (cle !== null) {
    const entree = catalogue.entrees.find((e) => e.cle === cle);
    if (entree !== undefined) selectionner(entree);
  }
}

async function selectionner(entree) {
  const catalogue = etat.catalogue;
  const jeton = ++etat.jetonSelection;
  etat.entreeSelectionnee = entree;
  etat.normaliseActive = null;
  el.exporter.disabled = true;
  etat.inspecteur.definirSelection(entree.cle);
  arreterSonSelection();

  etat.inspecteur.viderDetail();
  etat.inspecteur.afficherEnTete(entree);
  definirDisponibiliteTransport(false);
  el.transportEtat.textContent = '';

  if (entree.erreur !== null) {
    etat.inspecteur.afficherAlerte(entree.erreur);
    return;
  }

  let shader;
  try {
    shader = await catalogue.contenu(entree);
  } catch (e) {
    if (jeton !== etat.jetonSelection) return;
    etat.inspecteur.afficherAlerte(e instanceof Error ? e.message : String(e));
    return;
  }
  if (jeton !== etat.jetonSelection) return;

  const normalise = rendreSelection(shader);
  if (normalise !== undefined) {
    el.exporter.disabled = false;
    definirDisponibiliteTransport(true);
    chargerMediasSelection(normalise, catalogue, jeton);
    preparerSonSelection(normalise, jeton);
  }

  const alertes = [];
  if (entree.perime) alertes.push(traduire('catalog.stale'));
  alertes.push(...entree.avertissements);
  if (alertes.length > 0) etat.inspecteur.afficherAlerte(alertes.join(' '));
}

// ---------------------------------------------------------------------------
// Sources du catalogue
// ---------------------------------------------------------------------------

/**
 * Arrête le sondage périodique en cours (changement de source, ou source qui ne
 * s'y prête pas — fichiers isolés sans dossier à resonder).
 */
function arreterSondageCatalogue() {
  if (etat.minuteurSondage !== null) { clearInterval(etat.minuteurSondage); etat.minuteurSondage = null; }
}

/**
 * Démarre le rechargement automatique du catalogue : reparcourt périodiquement la
 * source active (`shaders/manifest.json` pour la source manifeste, le dossier natif
 * ouvert pour la source dossier) et réapplique un nouveau catalogue si son contenu a
 * changé (ajout, suppression ou modification d'un fichier). Une page statique ne
 * pouvant pas observer elle-même un dossier serveur ou local, ce sondage reste la
 * seule façon de détecter un ajout de shader sans recharger la page à la main.
 * Remplace tout sondage précédent (un seul actif à la fois, pour la source courante).
 */
function demarrerSondageCatalogue() {
  arreterSondageCatalogue();
  const catalogue = etat.catalogue;
  if (catalogue === null) return;

  if (catalogue.source === SOURCES.MANIFESTE) {
    etat.minuteurSondage = setInterval(async () => {
      if (await manifesteAChange(catalogue.empreinteManifeste)) {
        try {
          const nouveauCatalogue = await chargerManifeste();
          appliquerCatalogue(nouveauCatalogue, { conserverSelection: true });
          demarrerSondageCatalogue();
        } catch {
          // Échec passager (ex. serveur de développement redémarré) : le sondage réessaiera.
        }
      }
    }, INTERVALLE_SONDAGE_MS);
  } else if (catalogue.source === SOURCES.DOSSIER && etat.dossierNatifHandle !== null) {
    etat.minuteurSondage = setInterval(async () => {
      let fichiers;
      try {
        fichiers = await reanalyserDossierNatif(etat.dossierNatifHandle);
      } catch {
        arreterSondageCatalogue(); // permission révoquée ou dossier déplacé : resonder serait vain.
        return;
      }
      const nomsActuels = new Set(catalogue.fichiers.map((f) => f.fichier));
      const nomsRetrouves = new Set(selectionnerJson(fichiers).map((f) => f.nom));
      if (nomsActuels.size !== nomsRetrouves.size || [...nomsActuels].some((n) => !nomsRetrouves.has(n))) {
        const nouveauCatalogue = await catalogueDepuisFichiers(fichiers, { source: SOURCES.DOSSIER });
        appliquerCatalogue(nouveauCatalogue, { conserverSelection: true });
        demarrerSondageCatalogue();
      }
    }, INTERVALLE_SONDAGE_MS);
  }
}

async function demarrerAvecManifeste() {
  const jeton = ++etat.jetonCatalogue;
  arreterSondageCatalogue();
  etat.dossierNatifHandle = null;
  etat.inspecteur.definirMessageEtat(traduire('catalog.loading'));
  try {
    const catalogue = await chargerManifeste();
    if (jeton === etat.jetonCatalogue) { appliquerCatalogue(catalogue); demarrerSondageCatalogue(); }
  } catch (e) {
    if (jeton !== etat.jetonCatalogue) return;
    const detail = e instanceof Error ? e.message : String(e);
    etat.inspecteur.definirMessageEtat(traduire('catalog.unavailable', { message: detail }));
  }
}

async function chargerFichiersLocaux(fichiers, source, handleDossierNatif = null) {
  const jeton = ++etat.jetonCatalogue;
  arreterSondageCatalogue();
  etat.dossierNatifHandle = handleDossierNatif;
  etat.inspecteur.definirMessageEtat(traduire('catalog.readingFiles'));
  try {
    const catalogue = await catalogueDepuisFichiers(fichiers, {
      source,
      surProgres: (fait, total) => {
        if (jeton === etat.jetonCatalogue) etat.inspecteur.definirMessageEtat(traduire('catalog.readProgress', { done: fait, total }));
      },
    });
    if (jeton === etat.jetonCatalogue) { appliquerCatalogue(catalogue); demarrerSondageCatalogue(); }
  } catch (e) {
    if (jeton === etat.jetonCatalogue) {
      etat.inspecteur.definirMessageEtat(traduire('catalog.unreadable', { message: e instanceof Error ? e.message : String(e) }));
    }
  }
}

async function ouvrirDossier() {
  if (dossierNatifDisponible()) {
    try {
      const resultat = await choisirDossierNatif();
      if (resultat !== null) await chargerFichiersLocaux(resultat.fichiers, SOURCES.DOSSIER, resultat.handle);
      return;
    } catch (e) {
      // Contexte non sécurisé ou accès refusé : repli sur le sélecteur classique.
      etat.inspecteur.definirMessageEtat(traduire('catalog.nativePickerFallback', { message: e instanceof Error ? e.message : String(e) }));
    }
  }
  el.entreeDossier.click();
}

// ---------------------------------------------------------------------------
// Export vidéo (Phase 9)
// ---------------------------------------------------------------------------

function definirInfoAudioExport() {
  const formatWebm = el.exportFormat.value === FORMAT_EXPORT.WEBM;
  const sonDisponible = etat.normaliseActive?.son !== null && etat.normaliseActive?.son !== undefined;
  const codecsAudio = etat.codecsAudioExport?.[el.exportFormat.value] ?? [];
  const codecDisponible = codecsAudio.length > 0;
  el.exportAudio.disabled = !sonDisponible || !codecDisponible || etat.exportEnCours;
  if (!sonDisponible) {
    el.exportAudio.checked = false;
    el.exportAudioInfo.hidden = false;
    el.exportAudioInfo.textContent = traduire('export.audioNone');
  } else if (!codecDisponible) {
    el.exportAudio.checked = false;
    el.exportAudioInfo.hidden = false;
    el.exportAudioInfo.textContent = traduire('export.audioUnavailable', { codec: formatWebm ? 'Opus' : 'AAC' });
  } else {
    el.exportAudioInfo.hidden = !el.exportAudio.checked;
    el.exportAudioInfo.textContent = el.exportAudio.checked
      ? traduire('export.audioIncluded', { codec: formatWebm ? 'Opus' : 'AAC' })
      : '';
  }
}

async function actualiserCodecsAudioExport() {
  const jeton = ++etat.jetonCodecsAudioExport;
  const bitrateAudio = Number(el.exportBitrateAudio.value) * 1000;
  etat.codecsAudioExport = null;
  definirInfoAudioExport();
  try {
    const codecs = await new ExportVideo({ bitrateAudio }).supportAudio();
    if (jeton !== etat.jetonCodecsAudioExport) return;
    etat.codecsAudioExport = codecs;
    definirInfoAudioExport();
  } catch (erreur) {
    if (jeton !== etat.jetonCodecsAudioExport) return;
    etat.codecsAudioExport = { webm: [], mp4: [] };
    definirInfoAudioExport();
    el.exportEtat.textContent = traduire('export.audioCheckFailed', { message: erreur instanceof Error ? erreur.message : String(erreur) });
  }
}

async function ouvrirDialogueExport() {
  if (etat.normaliseActive === null || etat.moteur === null || etat.exportEnCours) return;
  el.exportEtat.textContent = traduire('export.checking');
  el.exportProgression.hidden = true;
  el.exportAudio.checked = false;
  etat.codecsAudioExport = null;
  definirInfoAudioExport();
  el.dialogueExport.showModal();
  const testeur = new ExportVideo();
  const [codecs] = await Promise.all([testeur.support(), actualiserCodecsAudioExport()]);
  if (el.dialogueExport.open) {
    const optionsMp4 = el.exportFormat.querySelector('option[value="mp4"]');
    optionsMp4.disabled = codecs.mp4.length === 0;
    el.exportEtat.textContent = codecs.webm.length === 0
      ? traduire('export.codecsNone')
      : traduire('export.codecsAvailable', {
        webm: codecs.webm.join(', '),
        mp4: codecs.mp4.length > 0 ? ` ; MP4 : ${codecs.mp4.join(', ')}` : traduire('export.mp4Unavailable'),
      });
    definirInfoAudioExport();
  }
}

function nomFichierExport() {
  return fabriquerNomFichierExport(
    etat.entreeSelectionnee?.titre ?? etat.entreeSelectionnee?.nom,
    el.exportFormat.value,
  );
}

async function lancerExport(evenement) {
  evenement.preventDefault();
  if (etat.exportEnCours || etat.normaliseActive === null || etat.moteur === null) return;
  if (!el.formulaireExport.reportValidity()) return;

  const debut = Number(el.exportDebut.value);
  const fin = Number(el.exportFin.value);
  const duree = fin - debut;
  if (!Number.isFinite(debut) || !Number.isFinite(fin) || debut < 0 || duree <= 0 || duree > 600) {
    el.exportEtat.textContent = traduire('export.rangeInvalid');
    return;
  }

  const [largeur, hauteur] = el.exportResolution.value.split('x').map(Number);
  const fps = Number(el.exportFps.value);
  const bitrate = Number(el.exportBitrateVideo.value) * 1000;
  const bitrateAudio = Number(el.exportBitrateAudio.value) * 1000;
  const format = el.exportFormat.value;
  const exporteur = new ExportVideo({
    format,
    largeur,
    hauteur,
    fps,
    debut,
    duree,
    bitrate,
    bitrateAudio,
  });
  const moteur = etat.moteur;
  const horloge = moteur.horloge;
  const ancienEtatHorloge = { temps: horloge.temps, image: horloge.image, delta: horloge.deltaTemps, marche: horloge.enMarche };
  const ancienneResolution = { largeur: moteur.canevas.width, hauteur: moteur.canevas.height };
  const annulation = new AbortController();
  let destinationExport = null;
  etat.annulationExport = annulation;
  etat.exportEnCours = true;
  definirDisponibiliteTransport(false);
  el.exportLancer.disabled = true;
  el.exportAnnuler.hidden = false;
  el.exportProgression.hidden = false;
  el.exportProgression.value = 0;
  el.exportEtat.textContent = traduire('export.prepare');
  definirInfoAudioExport();

  try {
    const nomSuggere = nomFichierExport();
    const promesseDestination = exporteur.ouvrirDestination({ suggestedName: nomSuggere });
    destinationExport = await promesseDestination;
    let renduAudio = null;
    const inclureAudio = el.exportAudio.checked;
    if (inclureAudio) {
      const passeSon = etat.normaliseActive.son;
      const code = convertirGles1VersGles3(passeSon.code);
      const commun = etat.normaliseActive.commun !== null
        ? convertirGles1VersGles3(etat.normaliseActive.commun.code)
        : null;
      renduAudio = async (_contexte, options) => rendreSonHorsLigne(
        moteur.gl,
        contexteAudio(),
        code,
        commun,
        {
          dureeSecondes: duree,
          frequenceEchantillonnage: 48000,
          surProgres: async (fait, total) => {
            if (options.signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
            el.exportEtat.textContent = traduire('export.audioRender', { percent: Math.round((fait / total) * 100) });
            await new Promise((resolu) => requestAnimationFrame(resolu));
          },
        },
      );
    }

    moteur.horloge.pause();
    moteur.redimensionner(largeur, hauteur);
    moteur.horloge.definirEtat(debut, Math.round(debut * fps), 1 / fps);
    moteur.reinitialiserTampons();
    const rendreFrame = async ({ frame, iTime, iTimeDelta }) => {
      if (annulation.signal.aborted) throw new DOMException('Export annulé.', 'AbortError');
      horloge.definirEtat(iTime, Math.round(debut * fps) + frame, iTimeDelta);
      moteur.rendre();
      return moteur.canevas;
    };
    const surProgres = (progres) => {
      const etape = progres.etape ?? 'rendu';
      const plages = {
        rendu: [0, 0.55],
        'encodage-video': [0.55, 0.78],
        'encodage-audio': [0.78, 0.9],
        muxage: [0.9, 0.95],
        ecriture: [0.95, 1],
      };
      const [debutEtape, finEtape] = plages[etape] ?? [0, 0.55];
      el.exportProgression.value = debutEtape + (finEtape - debutEtape) * (progres.progres ?? 0);
      const reste = progres.tempsRestant === null || progres.tempsRestant === undefined
        ? ''
        : traduire('export.remaining', { seconds: Math.ceil(progres.tempsRestant / 1000) });
      const etiquettes = {
        rendu: traduire('export.render'),
        'encodage-video': traduire('export.videoEncode'),
        'encodage-audio': traduire('export.audioEncode'),
        muxage: progres.progres === 1 ? traduire('export.muxDone') : traduire('export.mux'),
        ecriture: traduire('export.write', { percent: Math.round((progres.progres ?? 0) * 100) }),
      };
      const fait = progres.octetsEcrits ?? progres.fait ?? progres.frame ?? 0;
      const total = progres.octetsTotal ?? progres.total ?? 0;
      const unite = traduire(etape === 'ecriture' ? 'export.unit.bytes' : 'export.unit.chunks');
      el.exportEtat.textContent = traduire('export.progress', {
        label: etiquettes[etape] ?? 'Export',
        done: fait,
        total,
        unit: unite,
        remaining: reste,
      });
    };
    if (destinationExport !== null) {
      try {
        await exporteur.exporterVersDestination(rendreFrame, destinationExport, {
          renderAudio: inclureAudio ? renduAudio : null,
          signal: annulation.signal,
          onProgress: surProgres,
        });
      } finally {
        destinationExport = null;
      }
    } else {
      const resultat = inclureAudio
        ? await exporteur.exporterAvecAudio(rendreFrame, renduAudio, { signal: annulation.signal, onProgress: surProgres })
        : await exporteur.exporter(rendreFrame, { signal: annulation.signal, onProgress: surProgres });
      const blob = resultat?.video ?? resultat;
      if (!exporteur.estValide(blob)) throw new Error(traduire('export.invalidBlob'));
      await exporteur.enregistrerBlob(blob, { suggestedName: nomSuggere, signal: annulation.signal, onProgress: surProgres });
    }
    if (destinationExport !== null) {
      destinationExport = null;
    }
    el.exportProgression.value = 1;
    el.exportEtat.textContent = traduire('export.complete', { filename: nomFichierExport() });
  } catch (erreur) {
    if (erreur?.name === 'AbortError') el.exportEtat.textContent = traduire('export.cancelled');
    else el.exportEtat.textContent = traduire('export.failed', { message: erreur instanceof Error ? erreur.message : String(erreur) });
  } finally {
    if (destinationExport !== null) {
      try {
        await exporteur.abandonnerDestination(destinationExport);
      } catch (erreurNettoyage) {
        el.exportEtat.textContent += traduire('export.closingFailure', { message: erreurNettoyage instanceof Error ? erreurNettoyage.message : String(erreurNettoyage) });
      }
    }
    moteur.redimensionner(ancienneResolution.largeur, ancienneResolution.hauteur);
    moteur.horloge.definirEtat(ancienEtatHorloge.temps, ancienEtatHorloge.image, ancienEtatHorloge.delta);
    if (ancienEtatHorloge.marche) moteur.horloge.lire();
    else moteur.horloge.pause();
    moteur.reinitialiserTampons();
    etat.exportEnCours = false;
    etat.annulationExport = null;
    el.exportLancer.disabled = false;
    el.exportAnnuler.hidden = true;
    definirDisponibiliteTransport(etat.normaliseActive !== null && etat.moteur !== null);
    definirInfoAudioExport();
  }
}

// ---------------------------------------------------------------------------
// Glisser-déposer
// ---------------------------------------------------------------------------

function contientDesFichiers(evenement) {
  const types = evenement.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes('Files');
}

function brancherDepot() {
  let compteur = 0;
  window.addEventListener('dragenter', (e) => {
    if (!contientDesFichiers(e)) return;
    e.preventDefault();
    compteur += 1;
    el.depot.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!contientDesFichiers(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!contientDesFichiers(e)) return;
    compteur = Math.max(0, compteur - 1);
    if (compteur === 0) el.depot.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!contientDesFichiers(e)) return;
    e.preventDefault();
    compteur = 0;
    el.depot.hidden = true;
    // La collecte démarre ici, de façon synchrone : le DataTransfer n'est valide que pendant l'événement.
    collecterDepot(e.dataTransfer)
      .then((fichiers) => chargerFichiersLocaux(fichiers, SOURCES.FICHIERS))
      .catch((err) => {
        etat.inspecteur.definirMessageEtat(traduire('drop.failed', { message: err instanceof Error ? err.message : String(err) }));
      });
  });
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function demarrer() {
  initialiserLangue();
  el.scene = document.querySelector('.scene');
  el.viewport = document.getElementById('viewport');
  el.depot = document.getElementById('depot');
  el.entreeDossier = document.getElementById('entree-dossier');
  el.entreeFichiers = document.getElementById('entree-fichiers');
  el.exporter = document.getElementById('btn-exporter');
  el.dialogueExport = document.getElementById('dialogue-export');
  el.formulaireExport = document.getElementById('formulaire-export');
  el.exportFormat = document.getElementById('export-format');
  el.exportResolution = document.getElementById('export-resolution');
  el.exportFps = document.getElementById('export-fps');
  el.exportDebut = document.getElementById('export-debut');
  el.exportFin = document.getElementById('export-fin');
  el.exportBitrateVideo = document.getElementById('export-bitrate-video');
  el.exportBitrateAudio = document.getElementById('export-bitrate-audio');
  el.exportAudio = document.getElementById('export-audio');
  el.exportAudioInfo = document.getElementById('export-audio-info');
  el.exportProgression = document.getElementById('export-progression');
  el.exportEtat = document.getElementById('export-etat');
  el.exportLancer = document.getElementById('export-lancer');
  el.exportAnnuler = document.getElementById('export-annuler');
  el.transportLecture = document.getElementById('transport-lecture');
  el.transportReset = document.getElementById('transport-reset');
  el.transportPosition = document.getElementById('transport-position');
  el.transportTemps = document.getElementById('transport-temps');
  el.transportBoucle = document.getElementById('transport-boucle');
  el.transportPleinEcran = document.getElementById('transport-plein-ecran');
  el.transportCapture = document.getElementById('transport-capture');
  el.transportEtat = document.getElementById('transport-etat');

  etat.miniatures = new GenerateurMiniatures({
    lireShader: (entree) => etat.catalogue.contenu(entree),
  });

  etat.inspecteur = new Inspecteur(elementsDepuisDocument(), {
    miniature: (entree) => etat.miniatures.imagePour(entree),
    surListeAffichee: (entrees) => etat.miniatures.demander(entrees),
    surSelection: (entree) => selectionner(entree),
    surBasculerSon: () => basculerLectureSon(),
    surChoixMusique: (src, nomPiste) => choisirPisteManuelle(src, nomPiste),
  });

  const erreurMoteur = demarrerMoteur();
  if (erreurMoteur !== null) etat.inspecteur.definirMessageEtat(erreurMoteur);
  else { brancherSouris(); brancherClavier(); demarrerBoucle(); }
  definirDisponibiliteTransport(false);
  brancherTransport();

  const boutonLangue = document.getElementById('btn-langue');
  const actualiserBoutonLangue = () => {
    boutonLangue.textContent = langue() === 'fr' ? 'EN' : 'FR';
    boutonLangue.setAttribute('aria-pressed', String(langue() === 'en'));
  };
  boutonLangue.addEventListener('click', () => definirLangue(langue() === 'fr' ? 'en' : 'fr'));
  document.addEventListener('shaderview:langue', () => {
    actualiserBoutonLangue();
    etat.inspecteur?.definirLangue();
    mettreAJourTransport();
  });
  actualiserBoutonLangue();

  // Chargement indépendant du catalogue de shaders : la bibliothèque audio reste
  // disponible même si le manifeste des shaders est inaccessible, et réciproquement.
  chargerBibliothequeAudio().then((bibliotheque) => { etat.bibliothequeAudio = bibliotheque; });

  document.getElementById('btn-dossier').addEventListener('click', ouvrirDossier);
  document.getElementById('btn-fichiers').addEventListener('click', () => el.entreeFichiers.click());
  el.exporter.addEventListener('click', ouvrirDialogueExport);
  el.exportFormat.addEventListener('change', definirInfoAudioExport);
  el.exportAudio.addEventListener('change', definirInfoAudioExport);
  el.exportBitrateAudio.addEventListener('change', actualiserCodecsAudioExport);
  el.formulaireExport.addEventListener('submit', lancerExport);
  el.exportAnnuler.addEventListener('click', () => etat.annulationExport?.abort());
  for (const bouton of [document.getElementById('export-fermer'), document.getElementById('export-fermer-bas')]) {
    bouton.addEventListener('click', () => {
      if (etat.exportEnCours) etat.annulationExport?.abort();
      else el.dialogueExport.close();
    });
  }
  el.dialogueExport.addEventListener('cancel', (evenement) => {
    if (etat.exportEnCours) {
      evenement.preventDefault();
      etat.annulationExport?.abort();
    }
  });
  for (const [entree, source] of [[el.entreeDossier, SOURCES.DOSSIER], [el.entreeFichiers, SOURCES.FICHIERS]]) {
    entree.addEventListener('change', () => {
      const fichiers = fichiersDepuisSelection(entree.files);
      entree.value = '';
      if (fichiers.length > 0) chargerFichiersLocaux(fichiers, source);
    });
  }
  brancherDepot();
  demarrerAvecManifeste();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
else demarrer();
