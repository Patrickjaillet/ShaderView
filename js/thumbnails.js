// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Chaque entrée du catalogue reçoit une image PNG statique de 160 × 90 pixels,
// rendue une fois à partir du shader lui-même.
//
// Le rendu passe par un unique moteur (`MoteurRendu`, donc un unique contexte WebGL2)
// partagé par toutes les miniatures et traité une entrée à la fois : un contexte par
// miniature dépasserait vite la limite de contextes du navigateur. Ce moteur est distinct
// de celui du viewport principal (800 × 450). L'application suspend toutefois leur
// génération pendant la lecture du shader principal pour réserver les ressources au rendu actif.
//
// Les images survivent aux reconstructions de la liste (filtre, tri, recherche). Une entrée est
// identifiée par sa clé et l'empreinte du fichier : une modification invalide son image.
//
// Les miniatures ne sont jamais animées : compilation et rendu n'ont lieu qu'une fois par
// empreinte de fichier et ne dépendent pas de la visibilité des éléments.
//
// Comme les autres modules, la logique (file, états, séquence de rendu) ne dépend ni du DOM ni
// de WebGL : le moteur, la fabrique d'image et le planificateur sont injectés, ce qui permet
// de la tester sous Node. Les valeurs par défaut (voir `creerMoteurNavigateur`,
// `creerImageNavigateur`, `planifierImageSuivante`) sont celles du navigateur.

import { ErreurParseur, parserShader } from './parser.js';
import { ErreurCompilation, ErreurContexte, MoteurRendu, convertirShaderNormalise } from './renderer.js';

/** Largeur d'une miniature, en pixels. */
export const LARGEUR_MINIATURE = 160;

/** Hauteur d'une miniature, en pixels (rapport 16:9, comme le viewport principal). */
export const HAUTEUR_MINIATURE = 90;

/**
 * Temps (`iTime`, en secondes) de l'unique image statique générée par miniature.
 */
export const TEMPS_CAPTURE_SECONDES = 1;

/** Longueur maximale du message d'erreur conservé pour une miniature en échec. */
const LONGUEUR_MAX_MESSAGE = 200;

/** États d'une miniature (exposés dans `data-etat` de l'image). */
export const ETAT_MINIATURE = Object.freeze({
  EN_ATTENTE: 'en-attente',
  EN_COURS: 'en-cours',
  PRETE: 'prete',
  ERREUR: 'erreur',
});

// ---------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------

/**
 * Clé de cache d'une miniature : clé de l'entrée dans le catalogue et empreinte de son
 * fichier. L'empreinte invalide la miniature quand le fichier change.
 * @param {{ cle: string, empreinte: string }} entree
 * @returns {string}
 */
export function cleMiniature(entree) {
  return `${entree.cle}@${entree.empreinte}`;
}

/**
 * Réduit un message d'erreur (un journal de compilation GLSL peut faire plusieurs pages) à sa
 * première ligne non vide, tronquée, pour l'affichage en infobulle.
 * @param {unknown} erreur
 * @returns {string}
 */
export function resumerErreur(erreur) {
  const texte = erreur instanceof Error ? erreur.message : String(erreur);
  const premiere = texte.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'Erreur inconnue.';
  return premiere.length > LONGUEUR_MAX_MESSAGE ? `${premiere.slice(0, LONGUEUR_MAX_MESSAGE - 1)}…` : premiere;
}

/**
 * Message d'infobulle d'une miniature dont le shader ne compile pas : passe fautive, puis la
 * première erreur du pilote rattachée à une ligne du code utilisateur (à défaut, la première
 * erreur, à défaut le message général résumé).
 * @param {ErreurCompilation} erreur
 * @returns {string}
 */
export function resumerErreurCompilation(erreur) {
  const premiere = erreur.erreursLigne.find((l) => l.ligne !== null) ?? erreur.erreursLigne[0];
  let detail;
  if (premiere === undefined) detail = resumerErreur(erreur);
  else detail = premiere.ligne !== null ? `ligne ${premiere.ligne} : ${premiere.message}` : premiere.message;
  if (detail.length > LONGUEUR_MAX_MESSAGE) detail = `${detail.slice(0, LONGUEUR_MAX_MESSAGE - 1)}…`;
  return `Compilation (${erreur.idPasse ?? 'image'}), ${detail}`;
}

// ---------------------------------------------------------------------------
// Valeurs par défaut du navigateur
// ---------------------------------------------------------------------------

/**
 * Moteur de rendu partagé : un canevas hors-écran de la taille d'une miniature, donc un
 * contexte WebGL2 qui ne rend que des images 160 × 90.
 * @returns {MoteurRendu}
 * @throws {ErreurContexte} si WebGL2 n'est pas disponible
 */
export function creerMoteurNavigateur() {
  const canevas = document.createElement('canvas');
  canevas.width = LARGEUR_MINIATURE;
  canevas.height = HAUTEUR_MINIATURE;
  return new MoteurRendu(canevas);
}

/**
 * Élément image dédié à une miniature. Décoratif pour les technologies d'assistance : le titre de
 * l'entrée, juste à côté, porte déjà l'information.
 * @returns {HTMLImageElement}
 */
export function creerImageNavigateur() {
  const image = document.createElement('img');
  image.width = LARGEUR_MINIATURE;
  image.height = HAUTEUR_MINIATURE;
  image.className = 'element__miniature';
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  return image;
}

const IMAGE_ERREUR = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" fill="#0f172a"/><rect x="1" y="1" width="158" height="88" rx="4" fill="none" stroke="#334155"/><path d="M73 29h14v21H73zM76 55h8" fill="none" stroke="#f87171" stroke-width="3" stroke-linecap="round"/><text x="80" y="76" fill="#e6e9f2" font-family="sans-serif" font-size="10" text-anchor="middle">Image indisponible</text></svg>',
 )}`;

/**
 * Planifie la génération suivante sur une image d'affichage, afin de laisser le navigateur
 * traiter les événements entre deux compilations.
 * @param {() => void} tache
 */
export function planifierImageSuivante(tache) {
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => tache());
  else setTimeout(tache, 16);
}

// ---------------------------------------------------------------------------
// Générateur
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Fiche
 * @property {import('./catalog.js').Entree} entree
 * @property {HTMLImageElement} image image dédiée, créée une fois et conservée
 * @property {string} etat une valeur de ETAT_MINIATURE
 * @property {string|null} message raison de l'échec, si `etat` vaut ERREUR
 */

/**
 * Génère les miniatures des entrées du catalogue, une à la fois, dans l'ordre où la liste les
 * affiche. Ne lève jamais d'exception vers l'appelant : l'échec d'une miniature (fichier
 * illisible, shader qui ne compile pas, WebGL2 absent) est consigné dans son état et la file
 * continue avec les suivantes.
 */
export class GenerateurMiniatures {
  /**
   * @param {object} options
   * @param {(entree: import('./catalog.js').Entree) => Promise<object>} options.lireShader renvoie le shader brut (objet Shadertoy) d'une entrée, voir `Catalogue.contenu`
   * @param {() => { canevas: object, horloge: object, compiler: Function, reinitialiserTampons: Function, rendre: Function, detruire?: Function }} [options.creerMoteur] fabrique du moteur partagé, appelée au premier besoin
   * @param {() => HTMLImageElement} [options.creerImage] fabrique les éléments image dédiés
   * @param {(canevas: HTMLCanvasElement) => string} [options.encoderImage] sérialise l'image rendue en PNG
   * @param {(tache: () => void) => void} [options.planifier] planifie la prochaine génération
   * @param {() => boolean} [options.autoriser] indique si le rendu de fond peut démarrer
   * @param {number} [options.temps] temps de capture de l'image statique, en secondes
   */
  constructor({
    lireShader,
    creerMoteur = creerMoteurNavigateur,
    creerImage = creerImageNavigateur,
    encoderImage = (canevas) => canevas.toDataURL('image/png'),
    planifier = planifierImageSuivante,
    autoriser = () => true,
    temps = TEMPS_CAPTURE_SECONDES,
  }) {
    this._lireShader = lireShader;
    this._creerMoteur = creerMoteur;
    this._creerImage = creerImage;
    this._encoderImage = encoderImage;
    this._planifier = planifier;
    this._autoriser = autoriser;
    this._temps = temps;
    /** @type {Map<string, Fiche>} */
    this._fiches = new Map();
    /** @type {string[]} clés des fiches à générer, dans l'ordre */
    this._file = [];
    this._moteur = null;
    this._contexteIndisponible = null;
    this._planifie = false;
    this._enCours = false;
    // Incrémenté à chaque changement de catalogue : un résultat obtenu pour l'ancien est écarté.
    this._jeton = 0;
  }

  // -------------------------------------------------------------------------
  // Interface pour l'inspecteur
  // -------------------------------------------------------------------------

  /**
   * Annonce un nouveau catalogue. Les miniatures des entrées qui y figurent encore (même clé,
   * même empreinte) sont conservées ; les autres sont libérées. La file est vidée : la liste
   * affichée la redemandera par `demander`.
   * @param {{ entrees: import('./catalog.js').Entree[] }} catalogue
   */
  definirCatalogue(catalogue) {
    this._jeton += 1;
    this._file = [];
    const valides = new Set(catalogue.entrees.map(cleMiniature));
    for (const cle of [...this._fiches.keys()]) {
      if (!valides.has(cle)) this._fiches.delete(cle);
    }
  }

  /**
   * Image dédiée à une entrée, créée à la première demande puis toujours la même. Elle porte son
   * état dans `dataset.etat`. Une entrée déjà en erreur au catalogue (fichier illisible, format
   * non reconnu) n'a aucun shader à rendre : elle est marquée en erreur sans passer par la file.
   * @param {import('./catalog.js').Entree} entree
   * @returns {HTMLImageElement}
   */
  imagePour(entree) {
    const fiche = this._fiche(entree);
    return fiche.image;
  }

  /**
   * Fixe l'ordre de génération : les entrées données, dans l'ordre où la liste les affiche, qui
   * n'ont pas encore de miniature. Remplace toute demande précédente (un nouveau tri ou filtre
   * redonne la priorité à ce qui est visible), sans interrompre l'entrée en cours de rendu.
   * @param {import('./catalog.js').Entree[]} entrees
   */
  demander(entrees) {
    this._file = entrees
      .map((entree) => ({ entree, fiche: this._fiche(entree) }))
      .filter(({ fiche }) => fiche.etat === ETAT_MINIATURE.EN_ATTENTE)
      .map(({ entree }) => cleMiniature(entree));
    this._planifierSuite();
  }

  /** Reprend la file si le travail de fond est désormais autorisé. */
  reprendre() {
    this._planifierSuite();
  }

  /**
   * État d'une entrée, ou null si elle est inconnue du générateur.
   * @param {import('./catalog.js').Entree} entree
   * @returns {{ etat: string, message: string|null }|null}
   */
  etatDe(entree) {
    const fiche = this._fiches.get(cleMiniature(entree));
    return fiche === undefined ? null : { etat: fiche.etat, message: fiche.message };
  }

  /** Libère le moteur partagé et les miniatures. Le générateur n'est plus utilisable ensuite. */
  detruire() {
    this._jeton += 1;
    this._file = [];
    this._fiches.clear();
    if (this._moteur !== null && typeof this._moteur.detruire === 'function') this._moteur.detruire();
    this._moteur = null;
  }

  // -------------------------------------------------------------------------
  // Fiches
  // -------------------------------------------------------------------------

  _fiche(entree) {
    const cle = cleMiniature(entree);
    let fiche = this._fiches.get(cle);
    if (fiche === undefined) {
      fiche = { entree, image: this._creerImage(), etat: ETAT_MINIATURE.EN_ATTENTE, message: null };
      this._fiches.set(cle, fiche);
      if (entree.erreur !== null) this._definirEtat(fiche, ETAT_MINIATURE.ERREUR, entree.erreur);
      else if (this._contexteIndisponible !== null) this._definirEtat(fiche, ETAT_MINIATURE.ERREUR, this._contexteIndisponible);
      else this._definirEtat(fiche, ETAT_MINIATURE.EN_ATTENTE, null);
    }
    return fiche;
  }

  _definirEtat(fiche, etat, message) {
    fiche.etat = etat;
    fiche.message = message;
    fiche.image.dataset.etat = etat;
    fiche.image.title = etat === ETAT_MINIATURE.ERREUR && message !== null ? message : '';
    if (etat === ETAT_MINIATURE.ERREUR) fiche.image.src = IMAGE_ERREUR;
  }

  // -------------------------------------------------------------------------
  // File de génération
  // -------------------------------------------------------------------------

  _planifierSuite() {
    if (this._planifie || this._enCours || this._file.length === 0 || !this._autoriser()) return;
    this._planifie = true;
    this._planifier(() => {
      this._planifie = false;
      if (!this._autoriser()) return;
      this._traiterSuivante();
    });
  }

  async _traiterSuivante() {
    if (this._enCours || !this._autoriser()) return;
    const cle = this._file.shift();
    const fiche = cle === undefined ? undefined : this._fiches.get(cle);
    if (fiche === undefined || fiche.etat !== ETAT_MINIATURE.EN_ATTENTE) {
      this._planifierSuite();
      return;
    }
    this._enCours = true;
    try {
      await this._generer(fiche);
    } finally {
      // Même si la génération levait malgré tout, la file doit continuer avec les suivantes.
      this._enCours = false;
      this._planifierSuite();
    }
  }

  /**
   * Génère la miniature d'une fiche. Ne lève jamais : tout échec est consigné dans la fiche.
   * @param {Fiche} fiche
   */
  async _generer(fiche) {
    const jeton = this._jeton;
    this._definirEtat(fiche, ETAT_MINIATURE.EN_COURS, null);
    try {
      const shader = await this._lireShader(fiche.entree);
      if (jeton !== this._jeton) {
        // Catalogue remplacé pendant la lecture : la liste redemandera cette entrée si elle existe encore.
        this._definirEtat(fiche, ETAT_MINIATURE.EN_ATTENTE, null);
        return;
      }
      if (!this._autoriser()) {
        this._definirEtat(fiche, ETAT_MINIATURE.EN_ATTENTE, null);
        this._file.unshift(cleMiniature(fiche.entree));
        return;
      }
      const normalise = convertirShaderNormalise(parserShader(shader));
      this._rendreDans(fiche, normalise, this._temps);
      this._definirEtat(fiche, ETAT_MINIATURE.PRETE, null);
    } catch (e) {
      if (e instanceof ErreurContexte) {
        this._signalerContexteIndisponible(resumerErreur(e));
        return;
      }
      let message;
      if (e instanceof ErreurCompilation) message = resumerErreurCompilation(e);
      else if (e instanceof ErreurParseur) message = `Shader invalide : ${resumerErreur(e)}`;
      else message = resumerErreur(e);
      this._definirEtat(fiche, ETAT_MINIATURE.ERREUR, message);
    }
  }

  /**
   * Compile et rend une image au temps de capture, puis la sérialise en PNG dans l'élément image.
   * @param {Fiche} fiche
   * @param {import('./parser.js').ShaderNormalise} normalise shader déjà converti pour GLSL ES 3.00
   * @param {number} [temps] instant de capture de l'image statique
   */
  _rendreDans(fiche, normalise, temps = this._temps) {
    if (this._moteur === null) this._moteur = this._creerMoteur();
    const moteur = this._moteur;
    moteur.compiler(normalise);
    moteur.reinitialiserTampons();
    moteur.horloge.remettreAZero();
    moteur.horloge.sauterA(temps);
    moteur.rendre();
    fiche.image.src = this._encoderImage(moteur.canevas);
  }

  /**
   * WebGL2 est absent : aucune miniature ne pourra être générée. Toutes les fiches connues
   * passent en erreur avec la même raison, la file est vidée et le moteur n'est pas retenté.
   * @param {string} message
   */
  _signalerContexteIndisponible(message) {
    this._contexteIndisponible = message;
    this._file = [];
    for (const fiche of this._fiches.values()) {
      if (fiche.etat !== ETAT_MINIATURE.PRETE) this._definirEtat(fiche, ETAT_MINIATURE.ERREUR, message);
    }
  }
}
