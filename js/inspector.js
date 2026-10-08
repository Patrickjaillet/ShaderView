// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Inspecteur : panneau latéral (recherche, filtres, tri, navigation clavier) et vue
// détail du shader sélectionné (métadonnées, onglets de code source par passe avec
// coloration syntaxique GLSL locale, journal de compilation, entrées de canal,
// statistiques de performance). La génération des miniatures (Phase 8) reste hors de
// ce module : chaque élément de la liste reçoit l'image dédiée que lui fournit le rappel
// `miniature` (voir js/thumbnails.js) et signale la liste affichée par `surListeAffichee`.
//
// Comme les autres modules, la logique de recherche/filtrage/tri et la coloration
// syntaxique GLSL sont indépendantes du DOM et testables sans navigateur ; seule la
// classe `Inspecteur` construit et met à jour le DOM lui-même.
//
// Tout le contenu issu des fichiers (titres, auteurs, messages d'erreur, code source)
// est inséré avec `textContent` ou des nœuds construits explicitement : aucun texte
// provenant d'un shader n'est interprété comme du HTML.

import { langue, traduire } from './i18n.js';

// ---------------------------------------------------------------------------
// Recherche, filtres, tri (indépendants du DOM)
// ---------------------------------------------------------------------------

/**
 * Vrai si une entrée correspond à une recherche plein texte (titre, auteur, tags,
 * nom de fichier), insensible à la casse et aux accents (une recherche « demo » doit
 * trouver « Démo »). Une requête vide correspond à tout.
 * @param {import('./catalog.js').Entree} entree
 * @param {string} requete
 * @returns {boolean}
 */
export function correspondRecherche(entree, requete) {
  const q = normaliserTexte(requete);
  if (q === '') return true;
  const champs = [entree.titre, entree.auteur, entree.fichier, ...entree.tags];
  return champs.some((c) => c !== null && normaliserTexte(c).includes(q));
}

function normaliserTexte(texte) {
  return texte.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Filtres disponibles sur la liste du catalogue (voir filtrerEntrees). */
export const FILTRES = Object.freeze({
  MULTIPASSE: 'multipasse',
  SON: 'son',
  ERREURS: 'erreurs',
  MEDIAS_MANQUANTS: 'medias_manquants',
});

/**
 * Vrai si une entrée a au moins un canal dont le média externe n'est pas résolu
 * (aucun fichier de ce nom dans shaders/media/, voir media.js) — seule heuristique
 * disponible au niveau du catalogue, sans charger le contenu complet du shader :
 * `entree.medias` liste les chemins référencés, `mediasDisponibles` les noms de
 * fichiers reconnus (voir catalog.js, Catalogue.media).
 * @param {import('./catalog.js').Entree} entree
 * @param {Set<string>} mediasDisponibles
 * @returns {boolean}
 */
export function aDesMediasManquants(entree, mediasDisponibles) {
  if (entree.medias.length === 0) return false;
  return entree.medias.some((chemin) => {
    const segments = chemin.split(/[/\\]/).filter((s) => s !== '');
    const nom = segments.length > 0 ? segments[segments.length - 1] : '';
    return nom === '' || !mediasDisponibles.has(nom);
  });
}

/**
 * Applique l'ensemble des filtres actifs (ET logique entre eux) à une liste d'entrées.
 * @param {import('./catalog.js').Entree[]} entrees
 * @param {Set<string>} filtresActifs sous-ensemble de FILTRES
 * @param {Set<string>} mediasDisponibles voir aDesMediasManquants
 * @returns {import('./catalog.js').Entree[]}
 */
export function filtrerEntrees(entrees, filtresActifs, mediasDisponibles) {
  return entrees.filter((e) => {
    if (filtresActifs.has(FILTRES.MULTIPASSE) && !e.multipasse) return false;
    if (filtresActifs.has(FILTRES.SON) && !e.son) return false;
    if (filtresActifs.has(FILTRES.ERREURS) && e.erreur === null) return false;
    if (filtresActifs.has(FILTRES.MEDIAS_MANQUANTS) && !aDesMediasManquants(e, mediasDisponibles)) return false;
    return true;
  });
}

/** Clés de tri disponibles pour la liste du catalogue (voir trierEntrees). */
export const TRIS = Object.freeze({
  NOM: 'nom',
  TITRE: 'titre',
  AUTEUR: 'auteur',
  TAILLE: 'taille',
  DATE: 'date',
});

const COMPARATEURS = Object.freeze({
  [TRIS.NOM]: (a, b) => comparerChaines(a.fichier, b.fichier),
  [TRIS.TITRE]: (a, b) => comparerChaines(a.titre, b.titre),
  [TRIS.AUTEUR]: (a, b) => comparerChaines(a.auteur ?? '', b.auteur ?? ''),
  [TRIS.TAILLE]: (a, b) => a.taille - b.taille,
  [TRIS.DATE]: (a, b) => (a.date ?? 0) - (b.date ?? 0),
});

function comparerChaines(a, b) {
  return normaliserTexte(a).localeCompare(normaliserTexte(b));
}

/**
 * Trie une liste d'entrées selon une clé de tri (voir TRIS), stable (deux entrées
 * égales selon la clé conservent leur ordre relatif — `Array.prototype.sort` est
 * stable depuis ES2019) et sans muter le tableau d'entrée.
 * @param {import('./catalog.js').Entree[]} entrees
 * @param {string} cle une valeur de TRIS
 * @param {boolean} [decroissant]
 * @returns {import('./catalog.js').Entree[]}
 */
export function trierEntrees(entrees, cle, decroissant = false) {
  const comparateur = COMPARATEURS[cle] ?? COMPARATEURS[TRIS.NOM];
  const triees = [...entrees].sort(comparateur);
  return decroissant ? triees.reverse() : triees;
}

/**
 * Compose recherche, filtres et tri en une seule liste prête à afficher.
 * @param {import('./catalog.js').Entree[]} entrees
 * @param {{ requete?: string, filtresActifs?: Set<string>, mediasDisponibles?: Set<string>, tri?: string, decroissant?: boolean }} [options]
 * @returns {import('./catalog.js').Entree[]}
 */
export function composerListe(entrees, {
  requete = '',
  filtresActifs = new Set(),
  mediasDisponibles = new Set(),
  tri = TRIS.NOM,
  decroissant = false,
} = {}) {
  const cherchees = entrees.filter((e) => correspondRecherche(e, requete));
  const filtrees = filtrerEntrees(cherchees, filtresActifs, mediasDisponibles);
  return trierEntrees(filtrees, tri, decroissant);
}

// ---------------------------------------------------------------------------
// Liste virtualisée (grands catalogues)
// ---------------------------------------------------------------------------

/** Au-delà de ce nombre d'entrées affichées, seules les lignes visibles (plus une marge) existent dans le document. */
export const SEUIL_VIRTUALISATION = 1000;

/** Pas vertical d'une ligne de la liste virtualisée, en pixels (hauteur fixe de la ligne plus espacement) ; voir css/main.css. */
export const HAUTEUR_LIGNE = 90;

/** Lignes montées de part et d'autre de la zone visible, pour qu'un défilement rapide ne montre jamais de vide. */
export const SURPLUS_LIGNES = 6;

/**
 * Fenêtre de lignes à monter pour une position de défilement donnée.
 * @param {{ defilement: number, hauteurVue: number, total: number, hauteurLigne?: number, surplus?: number }} options
 * @returns {{ debut: number, fin: number, espaceHaut: number, espaceBas: number, hauteurTotale: number }} lignes [debut, fin) à monter
 *          et hauteurs (px) des espaceurs qui remplacent les lignes absentes avant et après
 */
export function calculerFenetre({ defilement, hauteurVue, total, hauteurLigne = HAUTEUR_LIGNE, surplus = SURPLUS_LIGNES }) {
  if (!(total > 0)) return { debut: 0, fin: 0, espaceHaut: 0, espaceBas: 0, hauteurTotale: 0 };
  const haut = Math.max(0, defilement);
  const premiere = Math.floor(haut / hauteurLigne);
  const derniere = Math.ceil((haut + Math.max(0, hauteurVue)) / hauteurLigne);
  const debut = Math.min(total, Math.max(0, premiere - surplus));
  const fin = Math.min(total, Math.max(debut, derniere + surplus));
  return { debut, fin, espaceHaut: debut * hauteurLigne, espaceBas: (total - fin) * hauteurLigne, hauteurTotale: total * hauteurLigne };
}

/**
 * Position de défilement qui rend la ligne `index` entièrement visible en bougeant le moins possible.
 * @param {number} index
 * @param {{ defilement: number, hauteurVue: number, hauteurLigne?: number }} options
 * @returns {number} nouvelle position (identique à `defilement` si la ligne est déjà visible)
 */
export function defilementPour(index, { defilement, hauteurVue, hauteurLigne = HAUTEUR_LIGNE }) {
  const haut = index * hauteurLigne;
  const bas = haut + hauteurLigne;
  if (haut < defilement) return haut;
  if (bas > defilement + hauteurVue) return Math.max(0, bas - hauteurVue);
  return defilement;
}

// ---------------------------------------------------------------------------
// Préférences (stockage local du navigateur)
// ---------------------------------------------------------------------------

const CLE_PREFERENCES = 'shaderview.preferences';

/** Préférences par défaut, utilisées si rien n'est enregistré ou si la lecture échoue. */
export const PREFERENCES_PAR_DEFAUT = Object.freeze({
  volume: 1,
  filtresActifs: [],
  tri: TRIS.NOM,
  decroissant: false,
  dernierShader: null,
});

/**
 * Valide et complète un objet de préférences quelconque (issu de `JSON.parse`, donc
 * potentiellement mal formé ou d'une version antérieure) : tout champ absent ou du
 * mauvais type reçoit sa valeur par défaut plutôt que de faire échouer la lecture.
 * @param {unknown} valeur
 * @returns {typeof PREFERENCES_PAR_DEFAUT}
 */
export function validerPreferences(valeur) {
  const v = typeof valeur === 'object' && valeur !== null ? valeur : {};
  return {
    volume: typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 ? v.volume : PREFERENCES_PAR_DEFAUT.volume,
    filtresActifs: Array.isArray(v.filtresActifs) ? v.filtresActifs.filter((f) => Object.values(FILTRES).includes(f)) : [],
    tri: Object.values(TRIS).includes(v.tri) ? v.tri : PREFERENCES_PAR_DEFAUT.tri,
    decroissant: v.decroissant === true,
    dernierShader: typeof v.dernierShader === 'string' ? v.dernierShader : null,
  };
}

/**
 * Lit les préférences depuis `localStorage` (voir CLE_PREFERENCES). Ne lève jamais
 * d'exception : un stockage indisponible (navigation privée stricte, quota dépassé)
 * ou un contenu corrompu renvoient les préférences par défaut.
 * @param {{ stockage?: Storage }} [options]
 * @returns {typeof PREFERENCES_PAR_DEFAUT}
 */
export function lirePreferences({ stockage = globalThis.localStorage } = {}) {
  try {
    const brut = stockage?.getItem(CLE_PREFERENCES);
    return brut === null || brut === undefined ? { ...PREFERENCES_PAR_DEFAUT } : validerPreferences(JSON.parse(brut));
  } catch {
    return { ...PREFERENCES_PAR_DEFAUT };
  }
}

/**
 * Enregistre les préférences dans `localStorage`. Ne lève jamais d'exception (un
 * échec d'écriture — quota, navigation privée — n'empêche pas l'application de fonctionner,
 * seule la mémorisation entre sessions est perdue).
 * @param {typeof PREFERENCES_PAR_DEFAUT} preferences
 * @param {{ stockage?: Storage }} [options]
 */
export function ecrirePreferences(preferences, { stockage = globalThis.localStorage } = {}) {
  try {
    stockage?.setItem(CLE_PREFERENCES, JSON.stringify(preferences));
  } catch {
    // Stockage indisponible ou plein : la session en cours continue sans mémorisation.
  }
}

// ---------------------------------------------------------------------------
// Coloration syntaxique GLSL (locale, sans dépendance tierce)
// ---------------------------------------------------------------------------

const MOTS_CLES_GLSL = new Set([
  'attribute', 'break', 'case', 'const', 'continue', 'default', 'discard', 'do', 'else', 'flat',
  'for', 'highp', 'if', 'in', 'inout', 'invariant', 'layout', 'lowp', 'mediump', 'noperspective',
  'out', 'precision', 'return', 'smooth', 'struct', 'switch', 'uniform', 'varying', 'void', 'while',
]);

const TYPES_GLSL = new Set([
  'bool', 'bvec2', 'bvec3', 'bvec4', 'double', 'float', 'int', 'ivec2', 'ivec3', 'ivec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'sampler3D', 'samplerCube', 'sampler2DArray', 'uint', 'uvec2', 'uvec3', 'uvec4',
  'vec2', 'vec3', 'vec4', 'void',
]);

// Un seul motif global capturant chaque catégorie de jeton dans un groupe nommé ;
// l'ordre des alternatives importe (commentaire de ligne avant opérateur `/`, etc.).
const MOTIF_JETON = new RegExp(
  [
    '(?<commentaireLigne>//[^\\n]*)',
    '(?<commentaireBloc>/\\*[\\s\\S]*?\\*/)',
    '(?<chaine>"(?:[^"\\\\]|\\\\.)*")',
    '(?<nombre>\\b\\d+\\.\\d*([eE][+-]?\\d+)?[fF]?|\\b\\d+[fFuU]?\\b|\\.\\d+[fF]?\\b)',
    '(?<identifiant>[A-Za-z_][A-Za-z0-9_]*)',
    '(?<espace>\\s+)',
  ].join('|'),
  'g',
);

/**
 * Découpe un code GLSL en jetons classés pour la coloration syntaxique : mot-clé,
 * type, nombre, chaîne, commentaire, identifiant (fonction/variable, non distingués
 * — une analyse syntaxique complète n'apporterait rien à la simple lecture), ou
 * « autre » (ponctuation, opérateurs). Aucune dépendance tierce : la coloration est
 * volontairement simple (lexicale, pas une analyse sémantique du langage).
 * @param {string} code
 * @returns {{ texte: string, categorie: string }[]}
 */
export function tokeniserGlsl(code) {
  const jetons = [];
  let dernierIndex = 0;
  for (const correspondance of code.matchAll(MOTIF_JETON)) {
    if (correspondance.index > dernierIndex) {
      jetons.push({ texte: code.slice(dernierIndex, correspondance.index), categorie: 'autre' });
    }
    const groupes = correspondance.groups;
    let categorie = 'autre';
    if (groupes.commentaireLigne || groupes.commentaireBloc) categorie = 'commentaire';
    else if (groupes.chaine) categorie = 'chaine';
    else if (groupes.nombre) categorie = 'nombre';
    else if (groupes.espace) categorie = 'espace';
    else if (groupes.identifiant) {
      const mot = groupes.identifiant;
      categorie = MOTS_CLES_GLSL.has(mot) ? 'motcle' : TYPES_GLSL.has(mot) ? 'type' : 'identifiant';
    }
    jetons.push({ texte: correspondance[0], categorie });
    dernierIndex = correspondance.index + correspondance[0].length;
  }
  if (dernierIndex < code.length) jetons.push({ texte: code.slice(dernierIndex), categorie: 'autre' });
  return jetons;
}

// ---------------------------------------------------------------------------
// Panneau (DOM)
// ---------------------------------------------------------------------------

function noeud(balise, classe, texte) {
  const n = document.createElement(balise);
  if (classe) n.className = classe;
  if (texte !== undefined) n.textContent = texte;
  return n;
}

function pluriel(n, singulier, plurielForme) {
  return `${n} ${n > 1 ? plurielForme : singulier}`;
}

function formaterTaille(octets) {
  if (langue() === 'en') {
    if (octets < 1024) return `${octets} B`;
    if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(1)} KB`;
    return `${(octets / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(1)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

function formaterDate(horodatageUnix) {
  if (horodatageUnix === null) return null;
  return new Date(horodatageUnix * 1000).toLocaleDateString(langue() === 'en' ? 'en' : 'fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
}

function badge(texte, attention = false) {
  return noeud('span', attention ? 'badge badge--attention' : 'badge', texte);
}

/** Libellés des onglets de code pour les types de passe qui ne sont pas des buffers (nommés par leur lettre A à D). */
const LIBELLES_PASSE = Object.freeze({ common: 'inspector.pass.common', image: 'inspector.pass.image', sound: 'inspector.pass.sound' });

/**
 * Construit la liste ordonnée des onglets (lettre/nom affiché, code, type) d'un
 * shader normalisé : common (s'il existe), buffers dans leur ordre de déclaration
 * (A à D, pas l'ordre de rendu résolu — plus lisible pour l'inspection), cubemaps
 * par nom, sound (si présente), image en dernier (toujours présente).
 * @param {import('./parser.js').ShaderNormalise} normalise
 * @returns {{ id: string, libelle: string, passe: import('./parser.js').Passe }[]}
 */
export function construireOnglets(normalise) {
  const onglets = [];
  if (normalise.commun !== null) onglets.push({ id: 'common', libelle: traduire(LIBELLES_PASSE.common), passe: normalise.commun });
  for (const lettre of Object.keys(normalise.buffers).sort()) {
    onglets.push({ id: `buffer-${lettre}`, libelle: `Buffer ${lettre}`, passe: normalise.buffers[lettre] });
  }
  for (const nom of Object.keys(normalise.cubemaps)) onglets.push({ id: `cubemap-${nom}`, libelle: nom, passe: normalise.cubemaps[nom] });
  if (normalise.son !== null) onglets.push({ id: 'sound', libelle: traduire(LIBELLES_PASSE.sound), passe: normalise.son });
  onglets.push({ id: 'image', libelle: traduire(LIBELLES_PASSE.image), passe: normalise.image });
  return onglets;
}

const LIBELLES_CANAL = Object.freeze({
  texture: 'texture', cubemap: 'cubemap', volume: 'volume', buffer: 'buffer', keyboard: 'inspector.channel.keyboard',
  mic: 'inspector.channel.mic', music: 'inspector.channel.music', musicstream: 'inspector.channel.musicstream', webcam: 'webcam', video: 'inspector.channel.video', misc: 'inspector.channel.misc',
});

/**
 * Panneau latéral (liste filtrable/triable des shaders) et vue détail (métadonnées,
 * onglets de code, canaux, journal de compilation, statistiques de performance) d'un
 * shader sélectionné. Toutes les interactions remontent par callbacks injectés au
 * constructeur plutôt que par un bus d'événements : l'appelant (js/app.js) reste seul
 * responsable de l'état du catalogue, du rendu et du son.
 */
export class Inspecteur {
  /**
   * @param {object} elements références DOM (voir Inspecteur.depuisDocument)
   * @param {object} rappels
   * @param {(entree: import('./catalog.js').Entree) => void} rappels.surSelection
   * @param {() => void} rappels.surBasculerSon
   * @param {(src: string, nomPiste: string) => void} rappels.surChoixMusique
   * @param {(entree: import('./catalog.js').Entree) => HTMLElement} [rappels.miniature] fournit l'image dédiée à une entrée (toujours la même pour une entrée donnée, elle survit aux reconstructions de la liste)
   * @param {(entrees: import('./catalog.js').Entree[]) => void} [rappels.surListeAffichee] appelé après chaque reconstruction de la liste, avec les entrées dans l'ordre d'affichage
   */
  constructor(elements, { surSelection, surBasculerSon, surChoixMusique, miniature, surListeAffichee }) {
    this.el = elements;
    this._surSelection = surSelection;
    this._surBasculerSon = surBasculerSon;
    this._surChoixMusique = surChoixMusique;
    this._fournirMiniature = miniature ?? null;
    this._surListeAffichee = surListeAffichee ?? null;
    this._entrees = [];
    this._catalogueDefini = false;
    this._mediasDisponibles = new Set();
    this._selectionCle = null;
    this._onglets = [];
    this._ongletActifId = null;
    this._entreeDetail = null;
    this._normaliseDetail = null;
    this._preferences = lirePreferences();

    this.el.recherche.value = '';
    for (const case_ of this._casesFiltres()) case_.checked = this._preferences.filtresActifs.includes(case_.value);
    this.el.tri.value = this._preferences.tri;
    this.el.triSens.setAttribute('aria-pressed', String(this._preferences.decroissant));
    this.el.triSens.textContent = this._preferences.decroissant ? '↑' : '↓';
    this.el.volume.value = String(this._preferences.volume);

    this.el.recherche.addEventListener('input', () => this._rafraichirListe());
    for (const case_ of this._casesFiltres()) case_.addEventListener('change', () => this._rafraichirListe());
    this.el.tri.addEventListener('change', () => this._rafraichirListe());
    this.el.triSens.addEventListener('click', () => {
      const decroissant = this.el.triSens.getAttribute('aria-pressed') !== 'true';
      this.el.triSens.setAttribute('aria-pressed', String(decroissant));
      this.el.triSens.textContent = decroissant ? '↑' : '↓';
      this._rafraichirListe();
    });
    this.el.btnSon.addEventListener('click', () => this._surBasculerSon());
    this.el.liste.addEventListener('keydown', (e) => this._surClavierListe(e));
    this._virtuelle = false;
    this._entreesAffichees = [];
    this._fenetre = null;
    let imagePlanifiee = false;
    // Liste virtualisée : la fenêtre suit le défilement, au plus une reconstruction par image d'affichage.
    this.el.liste.addEventListener('scroll', () => {
      if (!this._virtuelle || imagePlanifiee) return;
      imagePlanifiee = true;
      requestAnimationFrame(() => { imagePlanifiee = false; if (this._virtuelle) this._rendreFenetre(false); });
    }, { passive: true });
  }

  _casesFiltres() {
    return [this.el.filtreMultipasse, this.el.filtreSon, this.el.filtreErreurs, this.el.filtreMedias];
  }

  _filtresActifs() {
    return new Set(this._casesFiltres().filter((c) => c.checked).map((c) => c.value));
  }

  /** Volume mémorisé (préférence restaurée au démarrage ; js/app.js l'applique au LecteurAudio). */
  get volumePreference() { return this._preferences.volume; }

  /** Clé de l'entrée mémorisée comme dernière sélection (voir ROADMAP.md, Phase 7). */
  get dernierShaderPreference() { return this._preferences.dernierShader; }

  /** Clé de l'entrée actuellement sélectionnée dans cette session, ou null si aucune. */
  get selectionCle() { return this._selectionCle; }

  _sauvegarderPreferences() {
    this._preferences = {
      volume: Number(this.el.volume.value),
      filtresActifs: [...this._filtresActifs()],
      tri: this.el.tri.value,
      decroissant: this.el.triSens.getAttribute('aria-pressed') === 'true',
      dernierShader: this._selectionCle,
    };
    ecrirePreferences(this._preferences);
  }

  /**
   * Enregistre le volume courant (voir js/app.js, contrôle de volume prévu avec la
   * barre de transport complète — non construite ici, seule la mémorisation l'est).
   * @param {number} volume
   */
  definirVolume(volume) {
    this.el.volume.value = String(volume);
    this._sauvegarderPreferences();
  }

  // -------------------------------------------------------------------------
  // Liste
  // -------------------------------------------------------------------------

  /**
   * Remplace le catalogue affiché. `mediasDisponibles` (voir catalog.js, Catalogue.media)
   * conditionne le filtre « médias manquants ».
   * @param {import('./catalog.js').Catalogue} catalogue
   */
  definirCatalogue(catalogue) {
    this._catalogueDefini = true;
    this._entrees = catalogue.entrees;
    this._mediasDisponibles = catalogue.media;
    this._selectionCle = null;
    this.viderDetail();
    this._rafraichirListe();
  }

  definirLangue() {
    if (!this._catalogueDefini) return;
    this._rafraichirListe();
    if (this._entreeDetail !== null) this.afficherEnTete(this._entreeDetail);
    if (this._normaliseDetail !== null) this.afficherPasses(this._normaliseDetail);
    if (this._rapportCompat !== null && this._rapportCompat !== undefined) this.afficherCompatibilite(this._rapportCompat);
    this.definirEtatMarcheSon(this.el.btnSon.getAttribute('aria-pressed') === 'true');
  }

  _listeComposee() {
    return composerListe(this._entrees, {
      requete: this.el.recherche.value,
      filtresActifs: this._filtresActifs(),
      mediasDisponibles: this._mediasDisponibles,
      tri: this.el.tri.value,
      decroissant: this.el.triSens.getAttribute('aria-pressed') === 'true',
    });
  }

  _rafraichirListe() {
    this._sauvegarderPreferences();
    const entrees = this._listeComposee();
    this._entreesAffichees = entrees;
    this._virtuelle = entrees.length > SEUIL_VIRTUALISATION;
    this.el.liste.classList.toggle('catalogue__liste--virtuelle', this._virtuelle);
    if (this._virtuelle) {
      // Grand catalogue : seules les lignes visibles existent dans le document, la miniature n'est demandée que pour elles.
      this.el.liste.scrollTop = 0;
      this._fenetre = null;
      this._rendreFenetre(true);
    } else {
      this.el.liste.replaceChildren(...entrees.map((e) => this._construireElementListe(e)));
      if (this._surListeAffichee !== null) this._surListeAffichee(entrees);
    }
    const n = entrees.length;
    const total = this._entrees.length;
    let message = n === total
      ? traduire('catalog.count', { count: n })
      : traduire('catalog.countOf', { count: n, total });
    const enErreur = entrees.filter((e) => e.erreur !== null).length;
    if (enErreur > 0) message += traduire('catalog.inError', { count: enErreur });
    this.el.etat.textContent = `${message}.`;
    this._marquerSelection();
  }

  /**
   * Affiche un message d'état à la place de la liste (ex. catalogue en cours de
   * chargement, ou inaccessible) : appelé par js/app.js avant que definirCatalogue
   * ne soit jamais invoquée, ou en cas d'échec de chargement.
   * @param {string} message
   */
  definirMessageEtat(message) {
    this.el.etat.textContent = message;
  }

  /**
   * Monte les lignes de la fenêtre visible entre deux espaceurs de la hauteur des lignes absentes (liste virtualisée).
   * Le bouton qui avait le focus le retrouve s'il fait toujours partie de la fenêtre.
   * @param {boolean} forcer reconstruire même si la fenêtre n'a pas changé
   */
  _rendreFenetre(forcer) {
    const entrees = this._entreesAffichees;
    const fenetre = calculerFenetre({ defilement: this.el.liste.scrollTop, hauteurVue: this.el.liste.clientHeight || 600, total: entrees.length });
    if (!forcer && this._fenetre !== null && this._fenetre.debut === fenetre.debut && this._fenetre.fin === fenetre.fin) return;
    this._fenetre = fenetre;
    const cleFocus = this.el.liste.contains(document.activeElement) ? document.activeElement.dataset?.cle : undefined;
    const espaceur = (hauteur) => {
      const li = document.createElement('li');
      li.className = 'catalogue__espace';
      li.setAttribute('aria-hidden', 'true');
      li.style.height = `${hauteur}px`;
      return li;
    };
    const visibles = entrees.slice(fenetre.debut, fenetre.fin);
    this.el.liste.replaceChildren(
      espaceur(fenetre.espaceHaut),
      ...visibles.map((e, i) => this._construireElementListe(e, { position: fenetre.debut + i + 1, total: entrees.length })),
      espaceur(fenetre.espaceBas),
    );
    if (this._surListeAffichee !== null) this._surListeAffichee(visibles);
    this._marquerSelection();
    if (cleFocus !== undefined) {
      for (const b of this.el.liste.querySelectorAll('.element')) if (b.dataset.cle === cleFocus) b.focus({ preventScroll: true });
    }
  }

  /**
   * Fait défiler la liste virtualisée pour que la ligne `index` soit visible.
   * @param {number} index
   * @returns {boolean} vrai si la position de défilement a changé
   */
  _defilerVers(index) {
    const liste = this.el.liste;
    const cible = defilementPour(index, { defilement: liste.scrollTop, hauteurVue: liste.clientHeight || 600 });
    if (cible === liste.scrollTop) return false;
    liste.scrollTop = cible;
    return true;
  }

  _construireElementListe(entree, { position = null, total = null } = {}) {
    const li = document.createElement('li');
    const bouton = noeud('button', entree.erreur === null ? 'element' : 'element element--erreur');
    bouton.type = 'button';
    bouton.id = `element-${entree.cle}`;
    bouton.setAttribute('role', 'option');
    bouton.dataset.cle = entree.cle;
    // Liste virtualisée : la position et la taille de l'ensemble sont annoncées, les lignes absentes n'étant pas dans le document.
    if (position !== null) { bouton.setAttribute('aria-posinset', String(position)); bouton.setAttribute('aria-setsize', String(total)); }
    // Miniature : l'image dédiée à cette entrée est fournie (et remplie) par thumbnails.js ;
    // ce module ne la dessine pas lui-même.
    bouton.append(this._fournirMiniature !== null ? this._fournirMiniature(entree) : noeud('img', 'element__miniature'));
    const corps = noeud('div', 'element__corps');
    corps.append(noeud('span', 'element__titre', entree.titre), noeud('span', 'element__fichier', entree.fichier));
    if (entree.erreur !== null) {
      corps.append(noeud('span', 'element__message', entree.erreur));
    } else {
      const badges = noeud('div', 'badges');
      for (const type of new Set(entree.passes)) {
        const nombre = entree.passes.filter((p) => p === type).length;
        badges.append(badge(nombre > 1 ? `${type} ×${nombre}` : type));
      }
      if (entree.multipasse) badges.append(badge(traduire('inspector.badge.multiPass')));
      if (entree.son) badges.append(badge(traduire('inspector.badge.sound')));
      if (aDesMediasManquants(entree, this._mediasDisponibles)) badges.append(badge(traduire('inspector.badge.missingMedia'), true));
      if (entree.avertissements.length > 0) badges.append(badge(traduire('inspector.badge.warning', { count: entree.avertissements.length }), true));
      corps.append(badges);
    }
    bouton.append(corps);
    bouton.addEventListener('click', () => this._surSelection(entree));
    li.append(bouton);
    return li;
  }

  _marquerSelection() {
    for (const b of this.el.liste.querySelectorAll('.element')) {
      // role="option" (voir _construireElementListe) : aria-selected est l'attribut
      // ARIA attendu pour l'état sélectionné d'une option, pas aria-current.
      b.setAttribute('aria-selected', String(b.dataset.cle === this._selectionCle));
    }
  }

  /**
   * Signale la sélection courante (pour le surlignage de la liste) ; n'appelle pas
   * `surSelection` elle-même (appelée en retour par js/app.js après ses propres
   * vérifications, voir ROADMAP.md Phase 7, navigation clavier).
   * @param {string} cle
   */
  definirSelection(cle) {
    this._selectionCle = cle;
    if (this._virtuelle) {
      // Sélection restaurée ou choisie ailleurs que dans la liste : amener sa ligne dans la zone montée.
      const index = this._entreesAffichees.findIndex((e) => e.cle === cle);
      if (index >= 0 && this._defilerVers(index)) this._rendreFenetre(true);
    }
    this._marquerSelection();
    this._sauvegarderPreferences();
  }

  _surClavierListeVirtuelle(evenement) {
    const entrees = this._entreesAffichees;
    if (evenement.key === 'ArrowDown' || evenement.key === 'ArrowUp') {
      evenement.preventDefault();
      const pas = evenement.key === 'ArrowDown' ? 1 : -1;
      const actuel = entrees.findIndex((e) => e.cle === this._selectionCle);
      const suivant = actuel === -1 ? 0 : (actuel + pas + entrees.length) % entrees.length;
      this._defilerVers(suivant);
      this._rendreFenetre(true);
      for (const b of this.el.liste.querySelectorAll('.element')) if (b.dataset.cle === entrees[suivant].cle) b.focus({ preventScroll: true });
      this._surSelection(entrees[suivant]);
    } else if (evenement.key === 'Escape') {
      this.el.recherche.focus();
    }
  }

  _surClavierListe(evenement) {
    if (this._virtuelle) { this._surClavierListeVirtuelle(evenement); return; }
    const boutons = [...this.el.liste.querySelectorAll('.element')];
    if (boutons.length === 0) return;
    const indexActuel = boutons.findIndex((b) => b.dataset.cle === this._selectionCle);
    if (evenement.key === 'ArrowDown' || evenement.key === 'ArrowUp') {
      evenement.preventDefault();
      const pas = evenement.key === 'ArrowDown' ? 1 : -1;
      const indexSuivant = indexActuel === -1 ? 0 : (indexActuel + pas + boutons.length) % boutons.length;
      boutons[indexSuivant].focus();
      const cle = boutons[indexSuivant].dataset.cle;
      const entree = this._entrees.find((e) => e.cle === cle);
      if (entree !== undefined) this._surSelection(entree);
    } else if (evenement.key === 'Escape') {
      this.el.recherche.focus();
    }
  }

  // -------------------------------------------------------------------------
  // Détail
  // -------------------------------------------------------------------------

  /** Vide la vue détail (catalogue changé, ou aucune sélection). */
  viderDetail() {
    this.el.detail.hidden = true;
    this.el.detailAlerte.hidden = true;
    this.masquerLenteur();
    this.afficherCompatibilite(null);
    this.el.detailSon.hidden = true;
    this.el.detailMusique.hidden = true;
    this.el.detailMusique.replaceChildren();
    this.el.detailPerf.textContent = '';
    this.el.detailOnglets.replaceChildren();
    this.el.detailCanaux.replaceChildren();
    this.el.detailCodeContenu.replaceChildren();
    this.el.detailJournal.replaceChildren();
    this._onglets = [];
    this._ongletActifId = null;
    this._entreeDetail = null;
    this._normaliseDetail = null;
  }

  /**
   * Affiche l'en-tête de la vue détail (métadonnées du catalogue) et un éventuel
   * message d'alerte, avant même qu'un shader normalisé existe (ex. fichier en erreur).
   * @param {import('./catalog.js').Entree} entree
   */
  afficherEnTete(entree) {
    this._entreeDetail = entree;
    this.el.detail.hidden = false;
    const date = formaterDate(entree.date);
    this.el.detailTitre.textContent = entree.titre;
    this.el.detailMeta.textContent = [
      entree.fichier,
      formaterTaille(entree.taille),
      entree.auteur !== null ? traduire('inspector.author', { author: entree.auteur }) : null,
      date,
    ].filter((v) => v !== null).join(' · ');
  }

  /**
   * Affiche un message d'alerte (erreur de lecture/normalisation/compilation, ou
   * avertissement non bloquant) dans la vue détail.
   * @param {string} message
   */
  afficherAlerte(message) {
    this.el.detailAlerte.textContent = message;
    this.el.detailAlerte.hidden = false;
  }

  /**
   * Construit les onglets de code source du shader sélectionné et affiche le
   * premier (ou conserve l'onglet actif s'il existe encore, pour qu'un recalcul de
   * la vue — ex. après résolution des médias — ne fasse pas sauter l'onglet ouvert).
   * @param {import('./parser.js').ShaderNormalise} normalise
   */
  afficherPasses(normalise) {
    this._normaliseDetail = normalise;
    this._onglets = construireOnglets(normalise);
    const ongletsDom = this._onglets.map(({ id, libelle }) => {
      const bouton = noeud('button', 'onglet', libelle);
      bouton.type = 'button';
      bouton.id = `onglet-${id}`;
      bouton.setAttribute('role', 'tab');
      bouton.dataset.id = id;
      bouton.addEventListener('click', () => this.afficherOnglet(id));
      return bouton;
    });
    this.el.detailOnglets.replaceChildren(...ongletsDom);
    const ongletCourantExiste = this._onglets.some((o) => o.id === this._ongletActifId);
    this.afficherOnglet(ongletCourantExiste ? this._ongletActifId : (this._onglets[this._onglets.length - 1]?.id ?? null));
  }

  /**
   * Affiche l'onglet donné : code source coloré (voir tokeniserGlsl) et entrées de
   * canal de cette passe (type, échantillonnage, source résolue/substituée — Phase 5).
   * @param {string|null} id
   */
  afficherOnglet(id) {
    this._ongletActifId = id;
    for (const bouton of this.el.detailOnglets.children) {
      const actif = bouton.dataset.id === id;
      bouton.classList.toggle('onglet--actif', actif);
      bouton.setAttribute('aria-selected', String(actif));
    }
    const entree = this._onglets.find((o) => o.id === id);
    if (entree === undefined) { this.el.detailCodeContenu.replaceChildren(); this.el.detailCanaux.replaceChildren(); return; }

    const fragments = tokeniserGlsl(entree.passe.code).map(({ texte, categorie }) => {
      if (categorie === 'espace' || categorie === 'autre') return document.createTextNode(texte);
      return noeud('span', `glsl-${categorie}`, texte);
    });
    this.el.detailCodeContenu.replaceChildren(...fragments);

    const canaux = entree.passe.entrees.map((e) => {
      const repetition = langue() === 'en'
        ? (e.echantillonnage.repetition === 'repeat' ? 'repeat' : 'clamp')
        : (e.echantillonnage.repetition === 'repeat' ? 'répétition' : 'bord');
      const type = LIBELLES_CANAL[e.type] ? traduire(LIBELLES_CANAL[e.type]) : e.type;
      return noeud('li', '', `iChannel${e.canal} — ${type} (${e.echantillonnage.filtre}, ${repetition})`);
    });
    this.el.detailCanaux.replaceChildren(...(canaux.length > 0 ? canaux.map((c) => c) : [noeud('p', 'detail__canaux-vide', traduire('inspector.noChannels'))]));
  }

  /**
   * Affiche le journal de compilation d'une passe : une ligne par erreur, cliquable
   * quand son numéro de ligne dans le code utilisateur a pu être déterminé (voir
   * renderer.js, mapperErreurs) pour amener l'onglet correspondant à cette ligne.
   * @param {string} idOnglet voir construireOnglets
   * @param {import('./renderer.js').ErreurLigne[]} erreursLigne
   */
  afficherJournalCompilation(idOnglet, erreursLigne) {
    const lignes = erreursLigne.map((erreur) => {
      const texte = erreur.ligne !== null ? traduire('inspector.line', { line: erreur.ligne, message: erreur.message }) : erreur.message;
      const li = document.createElement('li');
      if (erreur.ligne !== null) {
        const bouton = noeud('button', 'journal__ligne', texte);
        bouton.type = 'button';
        bouton.addEventListener('click', () => this._allerALaLigne(idOnglet, erreur.ligne));
        li.append(bouton);
      } else {
        li.append(noeud('span', 'journal__ligne', texte));
      }
      return li;
    });
    this.el.detailJournal.replaceChildren(...lignes);
  }

  _allerALaLigne(idOnglet, numeroLigne) {
    this.afficherOnglet(idOnglet);
    const lignesCode = this.el.detailCodeContenu.textContent.split('\n');
    if (numeroLigne < 1 || numeroLigne > lignesCode.length) return;
    // Pas de numérotation de ligne dans le <pre> (texte brut) : on amène la vue au
    // bon endroit en estimant sa position proportionnelle, lecture visuelle suffisante
    // pour une erreur de compilation sans ajouter de colonne de numéros de ligne.
    const ratio = (numeroLigne - 1) / lignesCode.length;
    this.el.detailCode.scrollTop = ratio * this.el.detailCode.scrollHeight;
    this.el.detailCode.focus();
  }

  /**
   * Affiche les statistiques de performance (FPS courant, résolution des buffers du
   * shader en cours). Appelé en continu par js/app.js depuis la boucle de rendu.
   * @param {{ fps: number, resolutionsBuffers: { nom: string, largeur: number, hauteur: number }[] }} stats
   */
  afficherStatsPerf({ fps, resolutionsBuffers }) {
    const buffers = resolutionsBuffers.map((b) => `${b.nom} ${b.largeur}×${b.hauteur}`).join(', ');
    const vitesse = `${Math.round(fps)} ${traduire('inspector.framesPerSecond')}`;
    this.el.detailPerf.textContent = buffers.length > 0 ? `${vitesse} · ${buffers}` : vitesse;
  }

  /**
   * Affiche le rapport de compatibilité du shader sélectionné : adaptations GLSL ES 1.00 → 3.00
   * appliquées au code, fonctions Shadertoy ignorées (`mainVR`) et précision flottante insuffisante.
   * Masque le panneau s'il n'y a rien à signaler (ou si `rapport` est null).
   * @param {(import('./renderer.js').RapportCompatibilite & { precisionBasse?: boolean })|null} rapport
   */
  afficherCompatibilite(rapport) {
    this._rapportCompat = rapport;
    const lignes = [];
    if (rapport !== null) {
      for (const c of rapport.conversions) lignes.push(traduire('compat.conversion', { pass: c.passe, from: c.de, to: c.vers, count: c.occurrences }));
      for (const i of rapport.inferences ?? []) lignes.push(traduire('compat.inference', { pass: i.passe, channel: i.canal, type: i.type }));
      for (const a of rapport.avertissements) lignes.push(traduire(`compat.${a.code}`, { pass: a.passe }));
      if (rapport.precisionBasse === true) lignes.push(traduire('compat.precision'));
    }
    this.el.detailCompatListe.replaceChildren(...lignes.map((texte) => noeud('li', '', texte)));
    this.el.detailCompat.hidden = lignes.length === 0;
  }

  /**
   * Signale un shader lent (images par seconde sous le seuil) avec un bouton pour le suspendre.
   * @param {number} fps cadence mesurée
   * @param {() => void} surSuspendre appelée au clic sur « Suspendre »
   */
  afficherLenteur(fps, surSuspendre) {
    this.el.detailLenteurTexte.textContent = traduire('slow.message', { fps: Math.round(fps) });
    this.el.btnLenteur.onclick = () => { surSuspendre(); this.masquerLenteur(); };
    this.el.detailLenteur.hidden = false;
  }

  /** Masque l'avertissement de lenteur. */
  masquerLenteur() {
    this.el.detailLenteur.hidden = true;
  }

  // -------------------------------------------------------------------------
  // Son (affichage seul ; la lecture elle-même relève de js/app.js)
  // -------------------------------------------------------------------------

  /** Affiche le contrôle audio du shader sélectionné (passe `sound` ou canal musical). */
  afficherControleSon() {
    this.el.detailSon.hidden = false;
  }

  /**
   * Met à jour le texte/l'état du bouton de lecture du son.
   * @param {boolean} enMarche
   * @param {string} etat texte de l'état audio courant
   */
  definirEtatSon(enMarche, etat) {
    this.el.btnSon.setAttribute('aria-pressed', String(enMarche));
    this.el.btnSon.textContent = traduire(enMarche ? 'sound.pause' : 'sound.play');
    this.el.detailSonEtat.textContent = etat;
  }

  /**
   * Bascule l'état lecture/pause du bouton sans changer le texte d'état affiché à
   * côté (utilisé par js/app.js, basculerLectureSon, qui ne modifie que l'état
   * marche/arrêt sans nouveau message).
   * @param {boolean} enMarche
   */
  definirEtatMarcheSon(enMarche) {
    this.el.btnSon.setAttribute('aria-pressed', String(enMarche));
    this.el.btnSon.textContent = traduire(enMarche ? 'sound.pause' : 'sound.play');
  }

  // -------------------------------------------------------------------------
  // Musique de remplacement (music/musicstream non résolus, choix manuel)
  // -------------------------------------------------------------------------

  /**
   * Affiche une liste déroulante de pistes par canal music/musicstream non résolu
   * (fichier d'origine absent de shaders/media/), pour que l'utilisateur choisisse
   * manuellement une musique de remplacement dans la bibliothèque audio
   * (audio/manifest.json, voir catalog.js). Masque le bloc si aucun canal n'a besoin
   * d'un choix, ou si la bibliothèque est vide.
   * @param {{ src: string, canal: number, type: string }[]} canaux
   * @param {string[]} [pistes] noms de fichiers disponibles (voir catalog.js, BibliothequeAudio.pistes)
   */
  afficherChoixMusique(canaux, pistes = []) {
    if (canaux.length === 0 || pistes.length === 0) {
      this.el.detailMusique.hidden = true;
      this.el.detailMusique.replaceChildren();
      return;
    }
    this.el.detailMusique.hidden = false;
    const lignes = canaux.map(({ src, canal }) => {
      const ligne = noeud('div', 'musique__ligne');
      const idSelect = `choix-musique-${canal}`;
      const etiquette = noeud('label', 'musique__libelle', traduire('inspector.missingMusic', { channel: canal }));
      etiquette.htmlFor = idSelect;
      const select = document.createElement('select');
      select.id = idSelect;
      select.className = 'champ';
      const optionVide = noeud('option', '', traduire('inspector.chooseTrack'));
      optionVide.value = '';
      select.append(optionVide);
      for (const piste of pistes) select.append(noeud('option', '', piste));
      select.value = '';
      select.addEventListener('change', () => {
        if (select.value !== '') this._surChoixMusique(src, select.value);
      });
      const etat = noeud('span', 'musique__etat');
      etat.dataset.src = src;
      ligne.append(etiquette, select, etat);
      return ligne;
    });
    this.el.detailMusique.replaceChildren(...lignes);
  }

  /**
   * Affiche un message d'état à côté du sélecteur d'un canal music/musicstream
   * (ex. « Chargement… », « Lecture impossible »), identifié par son `src`.
   * @param {string} src voir afficherChoixMusique
   * @param {string} message
   */
  definirEtatChoixMusique(src, message) {
    const etat = this.el.detailMusique.querySelector(`.musique__etat[data-src="${CSS.escape(src)}"]`);
    if (etat !== null) etat.textContent = message;
  }
}

/**
 * Récupère toutes les références DOM attendues par Inspecteur depuis le document
 * courant (voir index.html). Centralise les identifiants, pour que leur éventuel
 * renommage ne touche qu'un seul endroit.
 * @returns {object}
 */
export function elementsDepuisDocument() {
  return {
    liste: document.getElementById('catalogue-liste'),
    etat: document.getElementById('catalogue-etat'),
    recherche: document.getElementById('catalogue-recherche'),
    filtreMultipasse: document.getElementById('filtre-multipasse'),
    filtreSon: document.getElementById('filtre-son'),
    filtreErreurs: document.getElementById('filtre-erreurs'),
    filtreMedias: document.getElementById('filtre-medias'),
    tri: document.getElementById('catalogue-tri'),
    triSens: document.getElementById('btn-tri-sens'),
    detail: document.getElementById('detail'),
    detailTitre: document.getElementById('detail-titre'),
    detailMeta: document.getElementById('detail-meta'),
    detailAlerte: document.getElementById('detail-alerte'),
    detailLenteur: document.getElementById('detail-lenteur'),
    detailLenteurTexte: document.getElementById('detail-lenteur-texte'),
    btnLenteur: document.getElementById('btn-lenteur'),
    detailCompat: document.getElementById('detail-compat'),
    detailCompatListe: document.getElementById('detail-compat-liste'),
    detailSon: document.getElementById('detail-son'),
    detailSonEtat: document.getElementById('detail-son-etat'),
    detailMusique: document.getElementById('detail-musique'),
    detailPerf: document.getElementById('detail-perf'),
    detailOnglets: document.getElementById('detail-onglets'),
    detailCanaux: document.getElementById('detail-canaux'),
    detailCode: document.getElementById('detail-code'),
    detailCodeContenu: document.getElementById('detail-code-contenu'),
    detailJournal: document.getElementById('detail-journal'),
    btnSon: document.getElementById('btn-son'),
    // Le contrôle de volume n'a pas encore d'élément dans index.html (barre de
    // transport complète prévue en Phase 10) : un élément détaché mémorise la
    // préférence (lirePreferences/ecrirePreferences) sans rien afficher pour l'instant.
    volume: (() => { const i = document.createElement('input'); i.type = 'hidden'; i.value = '1'; return i; })(),
  };
}
