// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Miniatures de la liste du catalogue (Phase 8). Chaque entrée de la liste reçoit un
// canevas 2D dédié de 160 × 90 pixels (voir `canevasPour`), rempli automatiquement à
// partir du shader lui-même : lecture du contenu, normalisation, compilation, rendu d'une
// image à basse résolution, puis copie dans le canevas de l'entrée.
//
// Le rendu passe par un unique moteur (`MoteurRendu`, donc un unique contexte WebGL2)
// partagé par toutes les miniatures et traité une entrée à la fois : un contexte par
// miniature dépasserait vite la limite de contextes du navigateur. Ce moteur est distinct
// de celui du viewport principal (800 × 450), qui continue d'afficher le shader
// sélectionné sans être perturbé par la génération.
//
// Les canevas survivent aux reconstructions de la liste (filtre, tri, recherche) : l'inspecteur
// redemande le canevas d'une entrée à chaque reconstruction et reçoit toujours le même, déjà
// rempli. Une entrée est identifiée par sa clé de catalogue et l'empreinte de son fichier : un
// fichier modifié (rechargement automatique du catalogue) obtient donc une nouvelle miniature.
//
// Périmètre actuel : une image fixe par entrée, à un temps de capture constant. L'animation,
// le temps de capture choisi intelligemment, la file à budget, les médias externes et le
// repli visuel pour les shaders en erreur relèvent des points suivants de la Phase 8.
//
// Comme les autres modules, la logique (file, états, séquence de rendu) ne dépend ni du DOM ni
// de WebGL : le moteur, la fabrique de canevas et le planificateur sont injectés, ce qui permet
// de la tester sous Node. Les valeurs par défaut (voir `creerMoteurNavigateur`,
// `creerCanevasNavigateur`, `planifierImageSuivante`) sont celles du navigateur.

import { ErreurParseur, parserShader } from './parser.js';
import { ErreurCompilation, ErreurContexte, MoteurRendu, convertirShaderNormalise } from './renderer.js';

/** Largeur d'une miniature, en pixels. */
export const LARGEUR_MINIATURE = 160;

/** Hauteur d'une miniature, en pixels (rapport 16:9, comme le viewport principal). */
export const HAUTEUR_MINIATURE = 90;

/**
 * Temps (`iTime`, en secondes) auquel l'image d'une miniature est capturée. Valeur fixe
 * provisoire : à t = 0, de nombreux shaders affichent un écran noir ou un état initial peu
 * représentatif ; le choix intelligent du temps est un point distinct de la Phase 8.
 */
export const TEMPS_CAPTURE_SECONDES = 1;

/** Longueur maximale du message d'erreur conservé pour une miniature en échec. */
const LONGUEUR_MAX_MESSAGE = 200;

/** États d'une miniature (exposés dans `data-etat` du canevas, pour le style). */
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
 * Canevas 2D dédié à une miniature. Décoratif pour les technologies d'assistance : le titre de
 * l'entrée, juste à côté, porte déjà l'information.
 * @returns {HTMLCanvasElement}
 */
export function creerCanevasNavigateur() {
  const canevas = document.createElement('canvas');
  canevas.width = LARGEUR_MINIATURE;
  canevas.height = HAUTEUR_MINIATURE;
  canevas.className = 'element__miniature';
  canevas.setAttribute('aria-hidden', 'true');
  return canevas;
}

/**
 * Planifie une tâche à l'image d'affichage suivante : une miniature par image laisse au
 * navigateur le temps d'afficher et de traiter les événements entre deux compilations, et la
 * génération se met en pause d'elle-même quand l'onglet est masqué.
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
 * @property {HTMLCanvasElement} canevas canevas dédié, créé une fois et conservé
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
   * @param {() => HTMLCanvasElement} [options.creerCanevas] fabrique des canevas dédiés
   * @param {(tache: () => void) => void} [options.planifier] planifie la tâche suivante
   * @param {number} [options.temps] temps de capture, en secondes
   */
  constructor({
    lireShader,
    creerMoteur = creerMoteurNavigateur,
    creerCanevas = creerCanevasNavigateur,
    planifier = planifierImageSuivante,
    temps = TEMPS_CAPTURE_SECONDES,
  }) {
    this._lireShader = lireShader;
    this._creerMoteur = creerMoteur;
    this._creerCanevas = creerCanevas;
    this._planifier = planifier;
    this._temps = temps;
    /** @type {Map<string, Fiche>} */
    this._fiches = new Map();
    /** @type {string[]} clés des fiches à générer, dans l'ordre */
    this._file = [];
    this._moteur = null;
    this._contexteIndisponible = null;
    this._planifie = false;
    this._enCours = false;
    this._observer = null;
    this._visible = new Set();
    this._survol = new Set();
    this._selection = new Set();
    this._rafAnimation = null;
    this._derniereAnimation = new Map();
    this._cacheRepos = new Map();
    // Incrémenté à chaque changement de catalogue : un résultat obtenu pour l'ancien est écarté.
    this._jeton = 0;
    this._initialiserObservateur();
  }

  _initialiserObservateur() {
    if (typeof globalThis.IntersectionObserver !== 'function') return;
    this._observer = new IntersectionObserver((entrees) => {
      for (const entree of entrees) {
        const cle = entree.target.dataset.cle;
        if (!cle) continue;
        if (entree.isIntersecting) this._visible.add(cle);
        else this._visible.delete(cle);
      }
      this._planifierAnimation();
    }, { threshold: [0.05, 0.5, 1] });
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
    this._cacheRepos.clear();
    this._visible.clear();
    this._survol.clear();
    this._selection.clear();
    this._derniereAnimation.clear();
  }

  /**
   * Canevas dédié à une entrée, créé à la première demande puis toujours le même. Il porte son
   * état dans `dataset.etat`. Une entrée déjà en erreur au catalogue (fichier illisible, format
   * non reconnu) n'a aucun shader à rendre : elle est marquée en erreur sans passer par la file.
   * @param {import('./catalog.js').Entree} entree
   * @returns {HTMLCanvasElement}
   */
  canevasPour(entree) {
    const fiche = this._fiche(entree);
    this._attacherInteractions(fiche);
    return fiche.canevas;
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
    this._cacheRepos.clear();
    this._visible.clear();
    this._survol.clear();
    this._selection.clear();
    this._derniereAnimation.clear();
    if (this._observer !== null) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._fiches.clear();
    if (this._moteur !== null && typeof this._moteur.detruire === 'function') this._moteur.detruire();
    this._moteur = null;
    this._rafAnimation = null;
  }

  // -------------------------------------------------------------------------
  // Fiches
  // -------------------------------------------------------------------------

  _fiche(entree) {
    const cle = cleMiniature(entree);
    let fiche = this._fiches.get(cle);
    if (fiche === undefined) {
      fiche = { entree, canevas: this._creerCanevas(), etat: ETAT_MINIATURE.EN_ATTENTE, message: null, normalise: null };
      this._fiches.set(cle, fiche);
      if (entree.erreur !== null) this._definirEtat(fiche, ETAT_MINIATURE.ERREUR, entree.erreur);
      else if (this._contexteIndisponible !== null) this._definirEtat(fiche, ETAT_MINIATURE.ERREUR, this._contexteIndisponible);
      else this._definirEtat(fiche, ETAT_MINIATURE.EN_ATTENTE, null);
    }
    return fiche;
  }

  _attacherInteractions(fiche) {
    const canevas = fiche.canevas;
    if (typeof canevas.addEventListener !== 'function') return;
    if (canevas.dataset.lie === 'true') return;
    canevas.dataset.lie = 'true';
    canevas.dataset.cle = cleMiniature(fiche.entree);
    canevas.tabIndex = 0;
    canevas.addEventListener('mouseenter', () => {
      this._survol.add(cleMiniature(fiche.entree));
      this._planifierAnimation();
    });
    canevas.addEventListener('mouseleave', () => {
      this._survol.delete(cleMiniature(fiche.entree));
      this._planifierAnimation();
    });
    canevas.addEventListener('focus', () => {
      this._selection.add(cleMiniature(fiche.entree));
      this._planifierAnimation();
    });
    canevas.addEventListener('blur', () => {
      this._selection.delete(cleMiniature(fiche.entree));
      this._planifierAnimation();
    });
    if (this._observer !== null) this._observer.observe(canevas);
  }

  _definirEtat(fiche, etat, message) {
    fiche.etat = etat;
    fiche.message = message;
    fiche.canevas.dataset.etat = etat;
    fiche.canevas.title = etat === ETAT_MINIATURE.ERREUR && message !== null ? message : '';
    if (etat === ETAT_MINIATURE.ERREUR) this._dessinerErreur(fiche.canevas, message);
    if (etat === ETAT_MINIATURE.PRETE) this._planifierAnimation();
  }

  _dessinerErreur(canevas, message) {
    const contexte = canevas.getContext('2d');
    if (contexte === null || typeof contexte === 'undefined') return;
    if (typeof contexte.clearRect !== 'function' || typeof contexte.fillRect !== 'function' || typeof contexte.strokeRect !== 'function' || typeof contexte.fillText !== 'function') return;
    contexte.clearRect(0, 0, canevas.width, canevas.height);
    contexte.fillStyle = '#0f172a';
    contexte.fillRect(0, 0, canevas.width, canevas.height);
    contexte.strokeStyle = '#334155';
    contexte.strokeRect(1, 1, canevas.width - 2, canevas.height - 2);
    contexte.fillStyle = '#f8fafc';
    contexte.font = 'bold 11px sans-serif';
    contexte.textAlign = 'center';
    const lignes = [
      'Miniature',
      'indisponible',
    ];
    const detail = typeof message === 'string' && message.length > 0 ? message : 'Shader invalide';
    const resum = detail.length > 40 ? `${detail.slice(0, 37)}…` : detail;
    lignes.push(resum);
    lignes.forEach((ligne, index) => {
      const y = 30 + index * 18;
      contexte.fillText(ligne, canevas.width / 2, y);
    });
  }

  _planifierAnimation() {
    const actifs = this._visible.size > 0 || this._survol.size > 0 || this._selection.size > 0;
    if (!actifs || this._rafAnimation !== null) return;
    this._rafAnimation = this._planifier(() => {
      this._rafAnimation = null;
      this._rafraichirAnimation();
    });
  }

  _rafraichirAnimation() {
    const touches = [...new Set([...this._visible, ...this._survol, ...this._selection])];
    if (touches.length === 0) return;
    const maintenant = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    for (const cle of touches) {
      const fiche = this._fiches.get(cle);
      if (fiche === undefined || fiche.etat !== ETAT_MINIATURE.PRETE || fiche.normalise === null) continue;
      const derniere = this._derniereAnimation.get(cle) ?? -Infinity;
      if (maintenant - derniere < 80) continue;
      this._derniereAnimation.set(cle, maintenant);
      const temps = this._temps + (maintenant / 1000) * (this._survol.has(cle) || this._selection.has(cle) ? 1.8 : 0.8);
      try {
        this._rendreDans(fiche, fiche.normalise, temps);
      } catch {
        // Le rendu animé est best-effort : si le moteur est sous pression, on garde la dernière image statique.
      }
    }
    this._planifierAnimation();
  }

  _enregistrerCacheRepos(fiche) {
    try {
      if (typeof fiche.canevas.toDataURL === 'function') {
        this._cacheRepos.set(cleMiniature(fiche.entree), fiche.canevas.toDataURL('image/png'));
      }
    } catch {
      // Les environnements de test ne fournissent pas toujours un `toDataURL` réel.
    }
  }

  // -------------------------------------------------------------------------
  // File de génération
  // -------------------------------------------------------------------------

  _planifierSuite() {
    if (this._planifie || this._enCours || this._file.length === 0) return;
    this._planifie = true;
    this._planifier(() => {
      this._planifie = false;
      this._traiterSuivante();
    });
  }

  async _traiterSuivante() {
    if (this._enCours) return;
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
      const normalise = convertirShaderNormalise(parserShader(shader));
      fiche.normalise = normalise;
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
   * Compile le shader dans le moteur partagé, rend une image au temps de capture et la copie
   * dans le canevas de la fiche. Aucune attente (`await`) entre le rendu et la copie : le tampon
   * de dessin WebGL n'est garanti lisible que dans la tâche qui l'a rempli.
   * @param {Fiche} fiche
   * @param {import('./parser.js').ShaderNormalise} normalise shader déjà converti pour GLSL ES 3.00
   * @param {number} [temps] seconde de capture, utile pour l'animation des miniatures visibles
   */
  _rendreDans(fiche, normalise, temps = this._temps) {
    if (this._moteur === null) this._moteur = this._creerMoteur();
    const moteur = this._moteur;
    moteur.compiler(normalise);
    moteur.reinitialiserTampons();
    moteur.horloge.remettreAZero();
    moteur.horloge.sauterA(temps);
    moteur.rendre();
    const contexte = fiche.canevas.getContext('2d');
    if (contexte !== null && typeof contexte.drawImage === 'function') {
      contexte.drawImage(moteur.canevas, 0, 0, LARGEUR_MINIATURE, HAUTEUR_MINIATURE);
    }
    this._enregistrerCacheRepos(fiche);
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
