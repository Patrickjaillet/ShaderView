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
import { ErreurCompilation, ErreurContexte, MoteurRendu, SuiviLenteur, TAILLE_FACE_CUBEMAP, analyserCompatibilite, convertirGles1VersGles3, convertirShaderNormalise } from './renderer.js';
import { decoderImage, decoderVolume, genererMediaSubstitue, genererVolumeSubstitue, resoudreNomMedia, typeMimeVideo } from './media.js';
import { CANAUX_AVEC_MEDIA } from './shader-meta.js';
import { LecteurAudio, TAILLE_FFT, construireTextureVisualiseur, rendreSonHorsLigne, synchroniserHorlogeAvecAudio } from './audio.js';
import { Inspecteur, elementsDepuisDocument } from './inspector.js';
import { GenerateurMiniatures, PREFIXE_CACHE, RenduMiniaturesWorker } from './thumbnails.js';
import { CacheMiniatures } from './cache-miniatures.js';
import { ModeEconomie, batterieFaible } from './economie.js';
import { enregistrerServiceWorker, etatHorsLigne, preparerHorsLigne } from './hors-ligne.js';
import { ExportVideo, FORMAT_EXPORT, nomFichierExport as fabriquerNomFichierExport } from './export/video.js';
import { definirLangue, initialiserLangue, langue, traduire } from './i18n.js';
import { JournalErreurs, SEUIL_AVERTISSEMENT_TELECHARGEMENT, VERSION_APPLICATION, construireDiagnostic, estimerTailleExport, installerCaptureErreurs } from './diagnostic.js';

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
  renduNecessaire: true,
  selectionEnCours: false,
  contexteAudio: null,
  lecteurSon: null,
  preparationSon: null,
  annulationPreparationSon: null,
  renduSonEnCours: false,
  // Entrées music/musicstream actives, par src : { lecteur: LecteurAudio, trame: Float32Array }.
  // Leur texture visualiseur (FFT, 512 × 2) est recalculée à chaque image tant que la
  // lecture est en cours (voir demarrerBoucle, mettreAJourVisualiseurs).
  visualiseursMusique: new Map(),
  /** Vidéos locales du shader en cours : { video, url } (voir chargerVideoLocale), libérées à chaque changement de shader. */
  videosSelection: [],
  // Pour les statistiques de performance (FPS lissé sur quelques images, voir mettreAJourStatsPerf).
  dernieresDurees: [],
  suiviLenteur: new SuiviLenteur(),
  journalErreurs: new JournalErreurs(),
  cacheMiniatures: null,
  economie: new ModeEconomie(),
  /** Vrai si l'horloge a été mise en pause parce que l'onglet est devenu invisible (reprise au retour). */
  pauseOngletMasque: false,
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
    // iChannelTime d'un canal musical : position de lecture du lecteur audio associé (0 tant qu'il n'existe pas).
    etat.moteur.tempsMedia = (src) => etat.visualiseursMusique.get(src)?.lecteur.position ?? null;
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
    etat.renduNecessaire = true;
  });
  el.viewport.addEventListener('pointerdown', (e) => {
    if (etat.moteur === null) return;
    const { x, y } = position(e);
    etat.moteur.souris.deplacer(x, y, el.viewport.height);
    etat.moteur.souris.appuyer();
    etat.renduNecessaire = true;
  });
  window.addEventListener('pointerup', () => {
    if (etat.moteur !== null) {
      etat.moteur.souris.relacher();
      etat.renduNecessaire = true;
    }
  });
}

// Clavier Shadertoy (texture 256 × 3, voir renderer.js EtatClavier) : capté sur le
// viewport, rendu focusable (tabindex) pour recevoir les événements sans gêner la
// navigation au clavier du reste de l'interface (catalogue, boutons).
function brancherClavier() {
  el.viewport.tabIndex = 0;
  el.viewport.addEventListener('keydown', (e) => {
    if (etat.moteur !== null) {
      etat.moteur.clavier.appuyer(e.keyCode, e.repeat);
      etat.renduNecessaire = true;
    }
  });
  el.viewport.addEventListener('keyup', (e) => {
    if (etat.moteur !== null) {
      etat.moteur.clavier.relacher(e.keyCode);
      etat.renduNecessaire = true;
    }
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
  const fps = moyenne > 0 ? 1 / moyenne : 0;
  etat.inspecteur.afficherStatsPerf({ fps, resolutionsBuffers: resolutionsBuffers(etat.normaliseActive) });
  // Seule une fenêtre de mesure pleine et une horloge en marche comptent (un rendu ponctuel en pause n'est pas une lenteur).
  if (etat.dernieresDurees.length >= 30 && etat.moteur.horloge.enMarche && etat.suiviLenteur.observer(fps)) {
    etat.inspecteur.afficherLenteur(fps, () => { etat.moteur.horloge.pause(); mettreAJourTransport(); });
  }
}

function mettreAJourTransport() {
  if (etat.moteur === null || el.transportTemps === undefined) return;
  const duree = dureeTransport();
  const temps = etat.moteur.horloge.temps;
  el.transportPosition.max = String(duree);
  const etiquetteBoucle = el.transportBoucle.nextElementSibling;
  if (etiquetteBoucle !== null) etiquetteBoucle.textContent = traduire('transport.loopDuration', { duration: duree.toFixed(2) });
  el.transportTemps.value = traduire('transport.time', {
    current: temps.toFixed(2),
    total: duree.toFixed(2),
  });
  el.transportTemps.textContent = el.transportTemps.value;
  if (document.activeElement !== el.transportPosition) el.transportPosition.value = String(Math.min(temps, duree));
  const enMarche = etat.moteur.horloge.enMarche;
  el.transportLecture.textContent = traduire(enMarche ? 'transport.pause' : 'transport.play');
  el.transportLecture.setAttribute('aria-pressed', String(enMarche));
}

function definirDisponibiliteTransport(disponible) {
  for (const controle of [el.transportLecture, el.transportReset, el.transportPosition, el.transportBoucle, el.transportPleinEcran, el.transportCapture]) {
    controle.disabled = !disponible;
  }
  if (!disponible) {
    el.transportPosition.max = String(DUREE_TRANSPORT_SECONDES);
    el.transportPosition.value = '0';
    const etiquetteBoucle = el.transportBoucle.nextElementSibling;
    if (etiquetteBoucle !== null) etiquetteBoucle.textContent = traduire('transport.loopDuration', { duration: DUREE_TRANSPORT_SECONDES.toFixed(2) });
    el.transportTemps.value = traduire('transport.time', { current: '0.00', total: DUREE_TRANSPORT_SECONDES.toFixed(2) });
    el.transportTemps.textContent = el.transportTemps.value;
  } else {
    mettreAJourTransport();
  }
}

function brancherTransport() {
  let reprendreAudioApresRecherche = false;
  el.transportLecture.addEventListener('click', async () => {
    if (etat.moteur === null || etat.exportEnCours) return;
    const horloge = etat.moteur.horloge;
    if (horloge.enMarche) mettreEnPauseSynchronisee();
    else {
      const lecteurAudio = lecteurReferenceAudio();
      const limite = dureeTransport();
      if (horloge.temps >= limite) {
        horloge.remettreAZero();
        positionnerLecteursAudio(0);
        etat.moteur.reinitialiserTampons();
        etat.renduNecessaire = true;
      }
      if (lecteurAudio !== null) {
        try {
          await demarrerLectureSonSynchronisee();
        } catch (e) {
          etat.inspecteur.definirEtatSon(false, traduire('audio.playbackFailed', { message: e instanceof Error ? e.message : String(e) }));
        }
      } else horloge.lire();
    }
    mettreAJourTransport();
  });
  el.transportReset.addEventListener('click', () => {
    if (etat.moteur === null || etat.exportEnCours) return;
    mettreEnPauseLecteursAudio();
    positionnerLecteursAudio(0);
    etat.moteur.horloge.pause();
    etat.moteur.horloge.remettreAZero();
    etat.moteur.reinitialiserTampons();
    etat.renduNecessaire = true;
    if (lecteursAudioSelection().length > 0) {
      etat.inspecteur.definirEtatSon(false, traduire('audio.paused'));
    }
    el.transportEtat.textContent = '';
    mettreAJourTransport();
  });
  el.transportPosition.addEventListener('input', () => {
    if (etat.moteur === null || etat.exportEnCours) return;
    const secondes = Math.min(Number(el.transportPosition.value), dureeTransport());
    el.transportPosition.value = String(secondes);
    const horloge = etat.moteur.horloge;
    const lecteursAudio = lecteursAudioSelection();
    const audioEnMarche = lecteursAudio.some((lecteur) => lecteur.enMarche);
    if (audioEnMarche) {
      reprendreAudioApresRecherche = true;
      mettreEnPauseLecteursAudio();
      horloge.pause();
    }
    positionnerLecteursAudio(secondes);
    horloge.definirEtat(secondes, Math.round(secondes * 30), 0);
    etat.moteur.reinitialiserTampons();
    etat.renduNecessaire = true;
    if (lecteursAudio.length > 0) {
      etat.inspecteur.definirEtatSon(false, traduire('audio.paused'));
    }
    mettreAJourTransport();
  });
  el.transportPosition.addEventListener('change', async () => {
    if (!reprendreAudioApresRecherche || etat.moteur === null || etat.exportEnCours) return;
    reprendreAudioApresRecherche = false;
    try {
      await demarrerLectureSonSynchronisee();
    } catch (e) {
      etat.inspecteur.definirEtatSon(false, traduire('audio.playbackFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  });
  el.transportPleinEcran.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === el.viewport) await document.exitFullscreen();
      else await el.viewport.requestFullscreen();
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
    el.transportPleinEcran.setAttribute('aria-pressed', String(document.fullscreenElement === el.viewport));
  });
}

/**
 * Onglet masqué : sans son à suivre, l'horloge du shader est mise en pause (le navigateur suspend de toute façon
 * l'animation, et le temps sauterait au retour) puis reprise au retour. Avec un son en lecture, l'horloge reste calée sur lui.
 */
function brancherVisibilite() {
  document.addEventListener('visibilitychange', () => {
    const horloge = etat.moteur?.horloge;
    if (horloge === undefined) return;
    if (document.hidden) {
      if (horloge.enMarche && lecteursAudioSelection().length === 0 && !etat.exportEnCours) {
        horloge.pause();
        etat.pauseOngletMasque = true;
      }
    } else if (etat.pauseOngletMasque) {
      etat.pauseOngletMasque = false;
      horloge.lire();
      etat.renduNecessaire = true;
    }
  });
}

/** Case « Mode économie » et suggestion automatique quand la batterie est faible et ne se recharge pas. */
function brancherEconomie() {
  el.transportEconomie.checked = etat.economie.actif;
  el.transportEconomie.addEventListener('change', () => {
    etat.economie.definir(el.transportEconomie.checked);
    el.transportEtat.textContent = '';
  });
  if (typeof navigator.getBattery !== 'function' || etat.economie.choixExplicite !== null) return;
  navigator.getBattery().then((batterie) => {
    if (batterieFaible(batterie) && etat.economie.suggerer()) {
      el.transportEconomie.checked = true;
      el.transportEtat.textContent = traduire('transport.economyBattery');
    }
  }).catch(() => {});
}

function demarrerBoucle() {
  if (etat.boucleActive) return;
  etat.boucleActive = true;
  let dernierHorodatage = null;
  let dernierRendu = null;
  const image = (horodatage) => {
    if (!etat.boucleActive) return;
    // Mode économie : image d'affichage sautée, le temps écoulé reste compté (dernierHorodatage n'est pas avancé).
    if (etat.moteur !== null && etat.economie.doitSauter(horodatage, dernierRendu, etat.moteur.horloge.enMarche)) {
      requestAnimationFrame(image);
      return;
    }
    dernierRendu = horodatage;
    if (etat.moteur !== null && !etat.exportEnCours) {
      const deltaSecondes = dernierHorodatage === null ? 0 : (horodatage - dernierHorodatage) / 1000;
      dernierHorodatage = horodatage;
      const horloge = etat.moteur.horloge;
      if (horloge.enMarche) {
        const lecteur = lecteurReferenceAudio();
        if (lecteur !== null) {
          if (!lecteur.enMarche || lecteur.position >= lecteur.duree) {
            const limite = Math.min(dureeTransport(), lecteur.duree);
            if (el.transportBoucle?.checked) {
              mettreEnPauseLecteursAudio();
              positionnerLecteursAudio(0);
              horloge.remettreAZero();
              etat.moteur.reinitialiserTampons();
              void demarrerLectureSonSynchronisee();
            } else {
              mettreEnPauseLecteursAudio();
              horloge.definirEtat(limite, Math.round(limite * 30), 0);
              horloge.pause();
              etat.renduNecessaire = true;
              etat.inspecteur.definirEtatSon(false, traduire('audio.paused'));
            }
          } else {
            synchroniserHorlogeAvecAudio(horloge, lecteur);
          }
        } else {
          horloge.avancer(deltaSecondes);
        }
        if (horloge.enMarche && horloge.temps >= dureeTransport()) {
          if (el.transportBoucle?.checked) {
            mettreEnPauseLecteursAudio();
            positionnerLecteursAudio(0);
            horloge.remettreAZero();
            etat.moteur.reinitialiserTampons();
            if (lecteursAudioSelection().length > 0) void demarrerLectureSonSynchronisee();
          } else {
            mettreEnPauseLecteursAudio();
            const duree = dureeTransport();
            horloge.definirEtat(duree, Math.round(duree * 30), 0);
            horloge.pause();
            etat.renduNecessaire = true;
          }
        }
      }
      if (!horloge.enMarche) etat.miniatures?.reprendre();
      if (!etat.renduSonEnCours && (horloge.enMarche || etat.renduNecessaire)) {
        mettreAJourVisualiseurs(!horloge.enMarche);
        etat.moteur.rendre();
        etat.renduNecessaire = false;
        mettreAJourStatsPerf(deltaSecondes);
      }
      mettreAJourTransport();
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
  etat.renduNecessaire = true;
  etat.moteur.horloge.remettreAZero();
  etat.moteur.horloge.pause();
  let normalise;
  try {
    normalise = parserShader(shader);
  } catch (e) {
    if (e instanceof ErreurParseur) { etat.inspecteur.afficherAlerte(e.message); return; }
    throw e;
  }
  etat.inspecteur.afficherPasses(normalise);
  const rapportCompatibilite = { ...analyserCompatibilite(normalise), precisionBasse: !etat.moteur.extensions.precisionHauteFragment };
  etat.inspecteur.afficherCompatibilite(rapportCompatibilite);
  etat.inspecteur.masquerLenteur();
  etat.suiviLenteur.reinitialiser();
  etat.dernieresDurees = [];
  try {
    etat.moteur.compiler(convertirShaderNormalise(normalise));
    etat.moteur.reinitialiserTampons();
    // Canaux dont l'entrée manque dans le JSON et dont l'échantillonneur a été déduit du code pendant la compilation.
    if (etat.moteur.inferences.length > 0) etat.inspecteur.afficherCompatibilite({ ...rapportCompatibilite, inferences: etat.moteur.inferences });
  } catch (e) {
    if (e instanceof ErreurCompilation) {
      etat.journalErreurs.ajouter('shader', `${e.idPasse ?? 'image'} : ${e.erreursLigne.map((l) => l.brut).slice(0, 3).join(' | ') || e.message}`);
      etat.inspecteur.afficherJournalCompilation(e.idPasse ?? 'image', e.erreursLigne);
      etat.inspecteur.afficherAlerte(e.erreursLigne.length > 0 ? traduire('catalog.compileError') : e.message);
      etat.normaliseActive = null;
      return;
    }
    throw e;
  }
  etat.normaliseActive = normalise;
  if (normalise.son === null) etat.moteur.horloge.lire();
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

function deverrouillerAudioDepuisInteraction() {
  try {
    return contexteAudio().resume().then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

function arreterSonSelection() {
  if (etat.annulationPreparationSon !== null) {
    etat.annulationPreparationSon.abort();
    etat.annulationPreparationSon = null;
  }
  if (etat.lecteurSon !== null) { etat.lecteurSon.detruire(); etat.lecteurSon = null; }
  if (etat.moteur !== null) etat.moteur.horloge.pause();
  for (const { lecteur } of etat.visualiseursMusique.values()) lecteur.detruire();
  etat.visualiseursMusique.clear();
  libererVideosSelection();
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
 * @param {Promise<boolean>} activationAudio déverrouillage tenté pendant le geste de sélection
 */
async function preparerSonSelection(normalise, jeton, activationAudio) {
  if (normalise.son === null || etat.moteur === null) return;
  etat.inspecteur.afficherControleSon();
  etat.inspecteur.definirEtatSon(false, traduire('audio.prepare'));
  const code = convertirGles1VersGles3(normalise.son.code);
  const commun = normalise.commun !== null ? convertirGles1VersGles3(normalise.commun.code) : null;
  const annulation = new AbortController();
  etat.annulationPreparationSon = annulation;
  etat.renduSonEnCours = true;
  let tampon;
  try {
    tampon = await rendreSonHorsLigne(etat.moteur.gl, contexteAudio(), code, commun, {
      signal: annulation.signal,
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
    definirDisponibiliteTransport(true);
    el.exporter.disabled = false;
    etat.moteur.horloge.lire();
    return;
  } finally {
    etat.renduSonEnCours = false;
    if (etat.annulationPreparationSon === annulation) etat.annulationPreparationSon = null;
  }
  if (jeton !== etat.jetonSelection) return;
  etat.lecteurSon = new LecteurAudio(contexteAudio(), tampon);
  etat.lecteurSon.volume = etat.inspecteur.volumePreference;
  definirDisponibiliteTransport(true);
  el.exporter.disabled = false;
  if (await activationAudio) {
    if (jeton !== etat.jetonSelection) return;
    try {
      if (await demarrerLectureSonSynchronisee()) return;
    } catch (e) {
      if (jeton !== etat.jetonSelection) return;
      etat.inspecteur.definirEtatSon(false, traduire('audio.playbackFailed', { message: e instanceof Error ? e.message : String(e) }));
      mettreAJourTransport();
      return;
    }
  }
  if (jeton !== etat.jetonSelection) return;
  etat.inspecteur.definirEtatSon(false, traduire('audio.autoplayBlocked'));
  mettreAJourTransport();
}

function lecteursAudioSelection() {
  return [
    ...(etat.lecteurSon === null ? [] : [etat.lecteurSon]),
    ...[...etat.visualiseursMusique.values()].map(({ lecteur }) => lecteur),
  ];
}

function lecteurReferenceAudio() {
  return etat.visualiseursMusique.values().next().value?.lecteur ?? etat.lecteurSon;
}

function dureeTransport() {
  return etat.visualiseursMusique.values().next().value?.lecteur.duree ?? DUREE_TRANSPORT_SECONDES;
}

function mettreEnPauseLecteursAudio() {
  for (const lecteur of lecteursAudioSelection()) lecteur.pause();
}

function positionnerLecteursAudio(secondes) {
  for (const lecteur of lecteursAudioSelection()) lecteur.sauterA(secondes);
}

async function demarrerAudioApresPreparation(activationAudio, { repartirAZero = false } = {}) {
  if (lecteursAudioSelection().length === 0 || !(await activationAudio)) return false;
  if (repartirAZero) {
    mettreEnPauseLecteursAudio();
    positionnerLecteursAudio(0);
    if (etat.moteur !== null) {
      etat.moteur.horloge.definirEtat(0, 0, 0);
      etat.moteur.reinitialiserTampons();
      etat.renduNecessaire = true;
    }
  }
  mettreAJourTransport();
  return demarrerLectureSonSynchronisee();
}

function mettreEnPauseSynchronisee() {
  if (etat.moteur === null) return;
  const horloge = etat.moteur.horloge;
  const lecteur = lecteurReferenceAudio();
  if (lecteur?.enMarche) {
    mettreEnPauseLecteursAudio();
    const position = lecteur.position;
    horloge.definirEtat(position, Math.round(position * 30), 0);
    etat.inspecteur.definirEtatSon(false, traduire('audio.paused'));
  }
  horloge.pause();
  etat.renduNecessaire = true;
}

async function demarrerLectureSonSynchronisee() {
  const lecteurs = lecteursAudioSelection();
  const lecteur = lecteurReferenceAudio();
  if (lecteur === null || etat.moteur === null) return false;
  await Promise.all(lecteurs.map((lecteurAudio) => lecteurAudio.lire()));
  if (lecteur !== lecteurReferenceAudio()) {
    mettreEnPauseLecteursAudio();
    return false;
  }
  const horloge = etat.moteur.horloge;
  horloge.definirEtat(lecteur.position, Math.round(lecteur.position * 30), 0);
  horloge.lire();
  etat.inspecteur.definirEtatSon(true, traduire('audio.synchronized'));
  mettreAJourTransport();
  return true;
}

async function basculerLectureSon() {
  const lecteur = lecteurReferenceAudio();
  if (lecteur === null) return;
  if (lecteur.enMarche) {
    mettreEnPauseSynchronisee();
    return;
  }
  try {
    await demarrerLectureSonSynchronisee();
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
function mettreAJourVisualiseurs(inclurePause = false) {
  if (etat.visualiseursMusique.size === 0 || etat.moteur === null) return;
  const textures = new Map();
  for (const [src, { lecteur, trame }] of etat.visualiseursMusique) {
    if (!inclurePause && !lecteur.enMarche) continue;
    lecteur.copierTrameRecente(trame);
    textures.set(src, { octets: construireTextureVisualiseur(trame), largeur: TAILLE_FFT, hauteur: 2 });
  }
  if (textures.size > 0) etat.moteur.definirTexturesMedia(textures, { fusionner: true });
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
  const lecteur = new LecteurAudio(contexteAudio(), tampon);
  lecteur.volume = etat.inspecteur.volumePreference;
  etat.visualiseursMusique.set(src, { lecteur, trame: new Float32Array(TAILLE_FFT) });
}

/**
 * Résout une entrée `music`/`musicstream` vers un lecteur audio : décode le fichier
 * reconnu dans `shaders/media/` et enregistre son visualiseur (voir
 * mettreAJourVisualiseurs, appelée à chaque image tant que la lecture avance). La
 * sélection démarre le lecteur après le chargement si le navigateur l'autorise.
 * Si le fichier
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
async function resoudreTextureMedia(entree, catalogue, jeton) {
  if (entree.type === 'webcam' || entree.type === 'mic') return null;
  if (entree.type === 'video') {
    const nomVideo = resoudreNomMedia(entree.src, catalogue.media);
    if (nomVideo !== null) {
      const video = await chargerVideoLocale(nomVideo, catalogue, jeton);
      if (video !== null) return { video, retournementVertical: entree.echantillonnage.retournementVertical };
    }
  }
  const taille = entree.type === 'cubemap' ? TAILLE_SUBSTITUTION_CUBEMAP : TAILLE_SUBSTITUTION;
  const nom = resoudreNomMedia(entree.src, catalogue.media);
  if (nom !== null && (entree.type === 'texture' || entree.type === 'cubemap')) {
    try {
      const brut = await catalogue.contenuMedia(nom);
      const image = await decoderImage(brut, entree.echantillonnage.retournementVertical);
      const canevas = new OffscreenCanvas(image.width, image.height);
      canevas.getContext('2d').drawImage(image, 0, 0);
      const octets = canevas.getContext('2d').getImageData(0, 0, image.width, image.height).data;
      return { octets: new Uint8Array(octets), largeur: image.width, hauteur: image.height, cubemap: entree.type === 'cubemap', srgb: entree.echantillonnage.srgb };
    } catch {
      // Fichier présent mais illisible/non décodable (format non géré, par exemple) :
      // substitution procédurale, comme si le fichier était absent.
    }
  }
  if (entree.type === 'volume') {
    if (nom !== null) {
      try {
        return decoderVolume(await catalogue.contenuMedia(nom));
      } catch {
        // Fichier .bin illisible ou d'un format inconnu : volume procédural, comme si le fichier était absent.
      }
    }
    return genererVolumeSubstitue(entree.src ?? 'volume');
  }
  if (entree.type === 'music' || entree.type === 'musicstream') {
    if (await preparerVisualiseurMusique(entree, catalogue)) return null;
  }
  // Vidéo absente ou non décodable, ou music/musicstream non décodable : substitution procédurale 2D.
  const octets = genererMediaSubstitue(entree.type, entree.src ?? entree.type, taille, taille);
  return { octets, largeur: taille, hauteur: taille, cubemap: entree.type === 'cubemap' };
}

/**
 * Charge une vidéo de shaders/media/ dans un élément <video> muet et bouclé (Blob local : aucune requête réseau). Le son
 * de la vidéo n'est pas lu, seule l'image alimente le canal. Renvoie null si le navigateur ne sait pas la décoder (la
 * substitution prend alors le relais) ou si le shader a changé pendant le chargement.
 * @param {string} nom nom de fichier dans shaders/media/
 * @param {import('./catalog.js').Catalogue} catalogue
 * @param {number} jeton valeur de etat.jetonSelection au moment de l'appel
 * @returns {Promise<HTMLVideoElement|null>}
 */
async function chargerVideoLocale(nom, catalogue, jeton) {
  let url = null;
  try {
    const brut = await catalogue.contenuMedia(nom);
    url = URL.createObjectURL(new Blob([brut], { type: typeMimeVideo(nom) }));
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise((resolu, rejeter) => {
      const minuteur = setTimeout(() => rejeter(new Error('Délai de chargement de la vidéo dépassé.')), 15000);
      video.addEventListener('loadeddata', () => { clearTimeout(minuteur); resolu(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(minuteur); rejeter(new Error('Vidéo non décodable.')); }, { once: true });
    });
    if (jeton !== etat.jetonSelection) throw new Error('Sélection abandonnée.');
    video.addEventListener('seeked', () => { etat.renduNecessaire = true; });
    etat.videosSelection.push({ video, url });
    return video;
  } catch {
    if (url !== null) URL.revokeObjectURL(url);
    return null;
  }
}

/** Arrête et libère les vidéos locales du shader en cours (lecture, décodeur, URL du Blob). */
function libererVideosSelection() {
  for (const { video, url } of etat.videosSelection) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
  etat.videosSelection = [];
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
    [...entrees.entries()].map(async ([cle, entree]) => [cle, entree.src, await resoudreTextureMedia(entree, catalogue, jeton)]),
  );
  if (jeton !== etat.jetonSelection || etat.moteur === null) return;
  const textures = new Map();
  for (const [, src, texture] of resultats) if (texture !== null && src !== null) textures.set(src, texture);
  if (textures.size > 0) {
    etat.moteur.definirTexturesMedia(textures);
    etat.renduNecessaire = true;
  }
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
 * definirLecteurMusique), puis démarre le son synchronisé avec l'image si le navigateur
 * l'autorise. Le sélecteur reste disponible pour pouvoir remplacer la piste. Abandonné
 * sans effet si le shader a changé depuis (le `src` n'identifierait plus la bonne entrée).
 * @param {string} src clé de l'entrée (voir entreesMediaUniques)
 * @param {string} nomPiste nom de fichier, tel que listé dans etat.bibliothequeAudio.pistes
 */
async function choisirPisteManuelle(src, nomPiste) {
  if (etat.bibliothequeAudio === null || !etat.entreesMusiqueNonResolues.has(src)) return;
  const jeton = etat.jetonSelection;
  const activationAudio = deverrouillerAudioDepuisInteraction();
  etat.inspecteur.definirEtatChoixMusique(src, traduire('music.loading', { name: nomPiste }));
  try {
    const brut = await etat.bibliothequeAudio.lire(nomPiste);
    const tampon = await contexteAudio().decodeAudioData(brut.buffer.slice(brut.byteOffset, brut.byteOffset + brut.byteLength));
    if (jeton !== etat.jetonSelection) return;
    definirLecteurMusique(src, tampon);
    etat.inspecteur.afficherControleSon();
    mettreAJourTransport();
    if (await demarrerAudioApresPreparation(activationAudio, { repartirAZero: true })) {
      etat.inspecteur.definirEtatChoixMusique(src, traduire('music.playing', { name: nomPiste }));
    } else {
      etat.inspecteur.definirEtatChoixMusique(src, traduire('music.autoplayBlocked', { name: nomPiste }));
      etat.inspecteur.definirEtatSon(false, traduire('music.autoplayBlockedGeneric'));
    }
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
  const preparationPrecedente = etat.preparationSon;
  const jeton = ++etat.jetonSelection;
  etat.selectionEnCours = true;
  try {
    etat.entreeSelectionnee = entree;
    etat.normaliseActive = null;
    el.exporter.disabled = true;
    etat.inspecteur.definirSelection(entree.cle);
    arreterSonSelection();
    const activationAudio = entree.son || entree.canaux.some((type) => type === 'music' || type === 'musicstream')
      ? deverrouillerAudioDepuisInteraction()
      : Promise.resolve(false);

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
    if (preparationPrecedente !== null) await preparationPrecedente;
    if (jeton !== etat.jetonSelection) return;

    const normalise = rendreSelection(shader);
    if (normalise !== undefined) {
      el.exporter.disabled = normalise.son !== null;
      if (normalise.son === null) definirDisponibiliteTransport(true);
      await chargerMediasSelection(normalise, catalogue, jeton);
      if (jeton !== etat.jetonSelection) return;
      mettreAJourTransport();
      if (normalise.son === null && lecteursAudioSelection().length > 0) {
        etat.inspecteur.afficherControleSon();
        if (!(await demarrerAudioApresPreparation(activationAudio))) {
          el.transportEtat.textContent = traduire('music.autoplayBlockedGeneric');
          etat.inspecteur.definirEtatSon(false, traduire('music.autoplayBlockedGeneric'));
        }
      }
      const preparation = preparerSonSelection(normalise, jeton, activationAudio).catch((e) => {
        if (jeton !== etat.jetonSelection) return;
        etat.inspecteur.definirEtatSon(false, e instanceof Error ? e.message : String(e));
        definirDisponibiliteTransport(true);
        el.exporter.disabled = false;
      });
      etat.preparationSon = preparation;
      void preparation.then(() => { if (etat.preparationSon === preparation) etat.preparationSon = null; });
    }

    const alertes = [];
    if (entree.perime) alertes.push(traduire('catalog.stale'));
    alertes.push(...entree.avertissements);
    if (alertes.length > 0) etat.inspecteur.afficherAlerte(alertes.join(' '));
  } finally {
    if (jeton === etat.jetonSelection) {
      etat.selectionEnCours = false;
      etat.miniatures?.reprendre();
    }
  }
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

/**
 * Rassemble les informations techniques du diagnostic (navigateur, GPU, capacités, shader courant, journal d'erreurs).
 * Aucune n'est envoyée : le texte est seulement affiché pour que l'utilisateur le copie.
 * @returns {Promise<import('./diagnostic.js').InfosDiagnostic>}
 */
async function collecterDiagnostic() {
  const gl = etat.moteur?.gl ?? null;
  let webgl = null;
  if (gl !== null) {
    const infoGpu = gl.getExtension('WEBGL_debug_renderer_info');
    webgl = {
      rendu: gl.getParameter(infoGpu ? infoGpu.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      fabricant: gl.getParameter(infoGpu ? infoGpu.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      tailleTextureMax: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      taille3dMax: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
      precisionHaute: etat.moteur.extensions.precisionHauteFragment,
      extensions: {
        EXT_color_buffer_float: etat.moteur.extensions.flottantsRenderables,
        OES_texture_float_linear: etat.moteur.extensions.filtrageLineaireFlottant,
        EXT_disjoint_timer_query_webgl2: gl.getSupportedExtensions()?.includes('EXT_disjoint_timer_query_webgl2') ?? false,
      },
    };
  }
  const codecs = await new ExportVideo().support();
  const entree = etat.entreeSelectionnee;
  return {
    version: VERSION_APPLICATION,
    langue: langue(),
    date: new Date().toISOString(),
    navigateur: {
      userAgent: navigator.userAgent,
      plateforme: navigator.platform,
      langues: (navigator.languages ?? [navigator.language]).join(', '),
      coeurs: navigator.hardwareConcurrency,
      memoireGo: navigator.deviceMemory,
    },
    webgl,
    capacites: {
      videoEncoder: typeof globalThis.VideoEncoder === 'function',
      audioEncoder: typeof globalThis.AudioEncoder === 'function',
      opfs: typeof navigator.storage?.getDirectory === 'function',
      selecteurFichier: typeof globalThis.showSaveFilePicker === 'function',
      audioContext: typeof globalThis.AudioContext === 'function',
      webm: codecs.webm,
      mp4: codecs.mp4,
    },
    shader: entree === null || entree === undefined ? null : {
      fichier: entree.fichier,
      titre: entree.titre,
      alerte: document.getElementById('detail-alerte')?.hidden === false ? document.getElementById('detail-alerte').textContent : null,
      inferences: etat.moteur?.inferences ?? [],
    },
    erreurs: etat.journalErreurs.entrees,
    cacheMiniatures: etat.cacheMiniatures?.disponible ? await etat.cacheMiniatures.statistiques() : null,
    horsLigne: etatHorsLigne(),
    modeMiniatures: etat.miniatures?.mode ?? 'inconnu',
  };
}

/** Propose la nouvelle version du site : elle ne remplace l'actuelle qu'après un clic sur « Recharger ». */
function afficherBandeauMiseAJour(appliquer) {
  const bandeau = document.getElementById('bandeau-maj');
  bandeau.hidden = false;
  document.getElementById('btn-maj').onclick = appliquer;
  document.getElementById('btn-maj-plus-tard').onclick = () => { bandeau.hidden = true; };
}

/**
 * Fait garder au Service Worker tous les fichiers du catalogue du site (shaders, médias, bibliothèque audio) pour une utilisation
 * sans connexion. Les fichiers déjà lus l'ont été au passage ; ceci complète le reste, à la demande de l'utilisateur.
 */
async function garderToutHorsLigne() {
  if (!etatHorsLigne().actif) { el.diagnosticEtat.textContent = traduire('offline.notActive'); return; }
  const catalogue = etat.catalogue;
  if (catalogue === null || catalogue.source !== SOURCES.MANIFESTE) { el.diagnosticEtat.textContent = traduire('offline.notSite'); return; }
  const taches = [
    ...[...new Set(catalogue.entrees.filter((e) => e.erreur === null).map((e) => e.fichier))].map((fichier) => () => catalogue.prechargerFichier(fichier)),
    ...[...catalogue.media].map((nom) => () => catalogue.contenuMedia(nom)),
    ...(etat.bibliothequeAudio?.pistes ?? []).map((nom) => () => etat.bibliothequeAudio.lire(nom)),
  ];
  const bouton = document.getElementById('diagnostic-hors-ligne');
  bouton.disabled = true;
  const resultat = await preparerHorsLigne(taches, (tache) => tache(), {
    surProgres: (fait, total) => { el.diagnosticEtat.textContent = traduire('offline.progress', { done: fait, total }); },
  });
  bouton.disabled = false;
  el.diagnosticEtat.textContent = resultat.echecs === 0
    ? traduire('offline.done', { count: resultat.reussis })
    : traduire('offline.doneFailed', { count: resultat.reussis, failed: resultat.echecs });
}

async function viderCacheMiniatures() {
  const nombre = await etat.cacheMiniatures.vider();
  el.diagnosticEtat.textContent = traduire('diag.cacheCleared', { count: nombre });
  await actualiserDiagnostic();
}

async function actualiserDiagnostic() {
  el.diagnosticTexte.value = construireDiagnostic(await collecterDiagnostic());
}

async function ouvrirDiagnostic() {
  el.diagnosticEtat.textContent = '';
  el.dialogueDiagnostic.showModal();
  await actualiserDiagnostic();
  el.diagnosticTexte.focus();
  el.diagnosticTexte.select();
}

async function copierDiagnostic() {
  el.diagnosticTexte.select();
  try {
    await navigator.clipboard.writeText(el.diagnosticTexte.value);
    el.diagnosticEtat.textContent = traduire('diag.copied');
  } catch {
    // Presse-papiers refusé ou indisponible (contexte non sécurisé) : ancienne commande, sinon sélection manuelle.
    el.diagnosticEtat.textContent = traduire(document.execCommand?.('copy') ? 'diag.copied' : 'diag.copyFailed');
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
  // Sans écriture directe dans un fichier, le résultat est gardé entièrement en mémoire avant le téléchargement.
  if (typeof globalThis.showSaveFilePicker !== 'function') {
    const octets = estimerTailleExport({ bitrate, bitrateAudio, duree, audio: el.exportAudio.checked });
    if (octets > SEUIL_AVERTISSEMENT_TELECHARGEMENT && !window.confirm(traduire('export.largeDownload', { size: Math.round(octets / 1048576) }))) return;
  }
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
      await moteur.preparerVideos();
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
    etat.renduNecessaire = true;
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
  installerCaptureErreurs(etat.journalErreurs, window);
  initialiserLangue();
  el.dialogueDiagnostic = document.getElementById('dialogue-diagnostic');
  el.diagnosticTexte = document.getElementById('diagnostic-texte');
  el.diagnosticEtat = document.getElementById('diagnostic-etat');
  document.getElementById('btn-diagnostic').addEventListener('click', ouvrirDiagnostic);
  document.getElementById('diagnostic-fermer').addEventListener('click', () => el.dialogueDiagnostic.close());
  document.getElementById('diagnostic-copier').addEventListener('click', copierDiagnostic);
  document.getElementById('diagnostic-vider-cache').addEventListener('click', () => { void viderCacheMiniatures(); });
  document.getElementById('diagnostic-hors-ligne').addEventListener('click', () => { void garderToutHorsLigne(); });
  void enregistrerServiceWorker({ surMiseAJour: afficherBandeauMiseAJour });
  document.getElementById('diagnostic-vider').addEventListener('click', () => { etat.journalErreurs.vider(); void actualiserDiagnostic(); });
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
  el.transportEconomie = document.getElementById('transport-economie');
  el.transportPleinEcran = document.getElementById('transport-plein-ecran');
  el.transportCapture = document.getElementById('transport-capture');
  el.transportEtat = document.getElementById('transport-etat');

  etat.cacheMiniatures = new CacheMiniatures();
  // Purge différée (entrées d'une ancienne version du rendu, excédent) : hors du chemin critique du démarrage.
  setTimeout(() => { void etat.cacheMiniatures.purger(PREFIXE_CACHE); }, 5000);
  etat.miniatures = new GenerateurMiniatures({
    cache: etat.cacheMiniatures,
    // Rendu dans un Worker (OffscreenCanvas) quand le navigateur le permet, sinon sur le fil principal.
    rendreExterne: new RenduMiniaturesWorker(),
    lireShader: (entree) => etat.catalogue.contenu(entree),
    // Les compilations/rendus WebGL synchrones des miniatures sont du travail de fond :
    // ils ne démarrent que lorsque le shader principal est à l'arrêt.
    autoriser: () => !etat.exportEnCours
      && !etat.selectionEnCours
      && etat.moteur?.horloge.enMarche !== true,
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
  else { brancherSouris(); brancherClavier(); brancherEconomie(); brancherVisibilite(); demarrerBoucle(); }
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
