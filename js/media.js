// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Gestion des médias hors-ligne : les fichiers JSON Shadertoy référencent des médias
// distants (`/media/a/<empreinte>.ext`, `/presets/...`) qui ne sont jamais téléchargés
// à l'exécution (100 % hors-ligne, voir ROADMAP.md). Ce module résout chaque entrée de
// canal concernée (`texture`, `cubemap`, `volume`, `video`, `music`, `musicstream` —
// voir shader-meta.js, CANAUX_AVEC_MEDIA) vers, dans l'ordre :
//   1. un fichier fourni par l'utilisateur dans `shaders/media/`, reconnu par le nom
//      de fichier d'origine (dernier segment du chemin JSON, sans sous-dossier) ;
//   2. à défaut, un générateur procédural local (bruit, dégradé ou damier, choisi
//      selon le type de canal) — le média est alors dit « substitué » ;
// et classe chaque entrée (résolue, substituée, manquante) pour l'inspecteur (Phase 7).
//
// `webcam` et `mic` ne sont jamais résolus par ce module (aucun fichier à lire) : ils
// demandent une autorisation du navigateur au moment de l'activation, et restent
// désactivés par défaut partout où l'interactivité n'a pas de sens (miniatures, export).
//
// La liste des fichiers disponibles dans `shaders/media/` et la lecture de leurs
// octets bruts relèvent de catalog.js (`Catalogue.media`, `Catalogue.contenuMedia`) :
// comme pour `shaders/` lui-même, une page statique ne peut pas lister un dossier du
// serveur, donc le manifeste liste aussi `shaders/media/` (voir tools/build-manifest.mjs).
//
// Comme les autres modules de logique, la résolution de nom de fichier et les
// générateurs procéduraux sont indépendants du DOM et testables sans navigateur ;
// seul `decoderImage` et la section « Entrées webcam / micro » touchent réellement
// au DOM (Blob, createImageBitmap, getUserMedia).

import { CANAUX_AVEC_MEDIA } from './shader-meta.js';

/** États de résolution d'une entrée de canal, pour l'indicateur de l'inspecteur (Phase 7). */
export const ETAT_MEDIA = Object.freeze({
  SANS_OBJET: 'sans_objet', // type de canal qui ne référence pas de média (buffer, cubemap interne, keyboard)
  RESOLU: 'resolu', // fichier trouvé dans shaders/media/
  SUBSTITUE: 'substitue', // aucun fichier : généré proceduralement
  DESACTIVE: 'desactive', // webcam/mic, non activé (miniatures, export, ou refus explicite)
  MANQUANT: 'manquant', // média requis mais non substituable (ex. vidéo sans repli procédural utile)
});

// ---------------------------------------------------------------------------
// Résolution du nom de fichier
// ---------------------------------------------------------------------------

/**
 * Extrait le nom de fichier d'origine d'un chemin `src`/`filepath` du JSON (dernier
 * segment, séparateurs `/` ou `\`), sans son dossier. C'est ce nom, et lui seul, qui
 * sert à chercher le fichier dans `shaders/media/` : les dossiers Shadertoy d'origine
 * (`/media/a/`, `/presets/`, `/media/previz/`) n'existent pas en local et sont ignorés.
 * @param {string} src
 * @returns {string} chaîne vide si `src` est vide ou se termine par un séparateur
 */
export function nomFichierMedia(src) {
  if (typeof src !== 'string' || src === '' || /[/\\]$/.test(src)) return '';
  const segments = src.split(/[/\\]/);
  return segments[segments.length - 1];
}

/**
 * Recherche le nom de fichier d'une entrée dans un ensemble de noms disponibles
 * (contenu de `shaders/media/`). La comparaison est exacte (sensible à la casse,
 * aucune normalisation d'extension) : un fichier renommé par l'utilisateur, même
 * d'une seule lettre, n'est pas reconnu — préférable à une correspondance approximative
 * qui associerait silencieusement le mauvais média.
 * @param {string} src
 * @param {Set<string>|string[]} nomsDisponibles noms de fichiers présents dans shaders/media/
 * @returns {string|null} le nom reconnu, ou null si absent
 */
export function resoudreNomMedia(src, nomsDisponibles) {
  const nom = nomFichierMedia(src);
  if (nom === '') return null;
  const disponibles = nomsDisponibles instanceof Set ? nomsDisponibles : new Set(nomsDisponibles);
  return disponibles.has(nom) ? nom : null;
}

// ---------------------------------------------------------------------------
// Générateurs procéduraux (dernier recours, déterministes)
// ---------------------------------------------------------------------------

// Générateur pseudo-aléatoire déterministe (xorshift32) : la même src produit toujours
// la même image substituée, pour que l'apparence d'un shader reste stable entre deux
// sessions tant que le média réel n'est pas fourni.
//
// Deux graines numériquement voisines (ex. deux hachages FNV-1a qui ne diffèrent que
// d'une unité, cas courant pour des chaînes proches) donneraient, sans ce mélange, un
// premier état xorshift quasi identique ; `melangerEtatInitial` (une passe de type
// murmur) dissocie l'état initial de la valeur numérique de la graine.
function melangerEtatInitial(valeur) {
  let v = valeur >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x85ebca6b) >>> 0;
  v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

function* xorshift32(graine) {
  let etat = melangerEtatInitial(graine) || 1;
  for (;;) {
    etat ^= etat << 13; etat >>>= 0;
    etat ^= etat >>> 17;
    etat ^= etat << 5; etat >>>= 0;
    yield etat / 0xffffffff;
  }
}

/**
 * Calcule une graine déterministe à partir d'une chaîne (nom de fichier ou `src`),
 * par un hachage simple (FNV-1a 32 bits) — suffisant ici, aucune propriété
 * cryptographique n'est requise, seule la reproductibilité importe.
 * @param {string} texte
 * @returns {number}
 */
export function hacherGraine(texte) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i += 1) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Génère un damier RGBA (texture de repli pour `texture`/`volume`), deux tons de gris
 * neutres pour signaler visuellement un média substitué sans trancher sur les couleurs
 * attendues du shader.
 * @param {number} largeur
 * @param {number} hauteur
 * @param {number} [taille] taille d'une case, en pixels
 * @returns {Uint8Array} RGBA, `largeur * hauteur * 4` octets
 */
export function genererDamier(largeur, hauteur, taille = 16) {
  const octets = new Uint8Array(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const paire = (Math.floor(x / taille) + Math.floor(y / taille)) % 2 === 0;
      const valeur = paire ? 200 : 90;
      const i = (y * largeur + x) * 4;
      octets[i] = valeur; octets[i + 1] = valeur; octets[i + 2] = valeur; octets[i + 3] = 255;
    }
  }
  return octets;
}

/**
 * Génère un dégradé RGBA diagonal (texture de repli pour `cubemap`), déterministe à
 * partir d'une graine pour que chaque face substituée d'un même cubemap reste distincte.
 * @param {number} largeur
 * @param {number} hauteur
 * @param {number} graine
 * @returns {Uint8Array}
 */
export function genererDegrade(largeur, hauteur, graine) {
  const alea = xorshift32(graine);
  const teinte = Math.floor(alea.next().value * 255);
  const octets = new Uint8Array(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y += 1) {
    for (let x = 0; x < largeur; x += 1) {
      const t = (x / Math.max(1, largeur - 1) + y / Math.max(1, hauteur - 1)) / 2;
      const i = (y * largeur + x) * 4;
      octets[i] = Math.round(teinte * t);
      octets[i + 1] = Math.round(teinte * (1 - t));
      octets[i + 2] = Math.round(128 * t + 64);
      octets[i + 3] = 255;
    }
  }
  return octets;
}

/**
 * Génère un bruit RGBA déterministe (texture de repli pour `volume`, substitut d'une
 * donnée tridimensionnelle sans équivalent 2D fidèle, et pour toute entrée sans
 * générateur plus spécifique).
 * @param {number} largeur
 * @param {number} hauteur
 * @param {number} graine
 * @returns {Uint8Array}
 */
export function genererBruit(largeur, hauteur, graine) {
  const alea = xorshift32(graine);
  const octets = new Uint8Array(largeur * hauteur * 4);
  for (let i = 0; i < largeur * hauteur; i += 1) {
    const v = Math.floor(alea.next().value * 255);
    octets[i * 4] = v; octets[i * 4 + 1] = v; octets[i * 4 + 2] = v; octets[i * 4 + 3] = 255;
  }
  return octets;
}

// Choix du générateur procédural par type de canal : un dégradé pour les cubemaps
// (six faces visuellement cohérentes entre elles via la graine), un damier pour les
// textures 2D (motif reconnaissable comme un repli, pas une image naturelle), du bruit
// pour les volumes et tout type sans généreur plus spécifique (vidéo, musique visuelle).
const GENERATEUR_PAR_TYPE = Object.freeze({
  texture: (l, h) => genererDamier(l, h),
  cubemap: (l, h, graine) => genererDegrade(l, h, graine),
  volume: (l, h, graine) => genererBruit(l, h, graine),
});

/**
 * Génère l'image de repli d'une entrée de canal non résolue, déterministe à partir
 * de son `src` (voir hacherGraine) : la même entrée produit toujours la même image
 * tant que le média réel n'est pas fourni.
 * @param {string} typeCanal voir shader-meta.js, TYPES_CANAUX
 * @param {string} src
 * @param {number} largeur
 * @param {number} hauteur
 * @returns {Uint8Array} RGBA
 */
export function genererMediaSubstitue(typeCanal, src, largeur, hauteur) {
  const generateur = GENERATEUR_PAR_TYPE[typeCanal] ?? genererBruit;
  return generateur(largeur, hauteur, hacherGraine(src));
}

// ---------------------------------------------------------------------------
// Classification d'une entrée de canal (pour l'inspecteur, Phase 7)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ResolutionMedia
 * @property {string} etat voir ETAT_MEDIA
 * @property {string|null} nomFichier nom reconnu dans shaders/media/, si résolu
 * @property {string|null} message explication à afficher dans l'inspecteur (null si résolu sans ambiguïté)
 */

/**
 * Classe une entrée de canal selon son type et sa résolution dans `shaders/media/`.
 * Les canaux sans média (buffer, cubemap interne déjà rendu, keyboard, misc) sont
 * `SANS_OBJET` : ce module ne les concerne pas (voir renderer.js, resoudreSourcesCanaux,
 * qui les traite par liaison interne plutôt que par fichier). `webcam`/`mic` sont
 * toujours `DESACTIVE` ici (l'activation effective se décide ailleurs, voir EtatCapture).
 * @param {{ type: string, src: string|null }} entree une entrée normalisée (voir parser.js, Entree)
 * @param {Set<string>} nomsDisponibles contenu de shaders/media/
 * @returns {ResolutionMedia}
 */
export function classifierMedia(entree, nomsDisponibles) {
  if (entree.type === 'webcam' || entree.type === 'mic') {
    return { etat: ETAT_MEDIA.DESACTIVE, nomFichier: null, message: 'Webcam/micro désactivés par défaut : à activer explicitement.' };
  }
  if (!CANAUX_AVEC_MEDIA.has(entree.type)) return { etat: ETAT_MEDIA.SANS_OBJET, nomFichier: null, message: null };
  const nom = resoudreNomMedia(entree.src, nomsDisponibles);
  if (nom !== null) return { etat: ETAT_MEDIA.RESOLU, nomFichier: nom, message: null };
  if (entree.type === 'video') {
    return {
      etat: ETAT_MEDIA.MANQUANT,
      nomFichier: null,
      message: `Vidéo absente de shaders/media/ (${nomFichierMedia(entree.src) || 'nom de fichier inconnu'}) : aucune image affichée sur ce canal.`,
    };
  }
  return {
    etat: ETAT_MEDIA.SUBSTITUE,
    nomFichier: null,
    message: `Média absent de shaders/media/ (${nomFichierMedia(entree.src) || 'nom de fichier inconnu'}) : remplacé par une image générée.`,
  };
}

// ---------------------------------------------------------------------------
// Décodage des fichiers locaux
// ---------------------------------------------------------------------------

// La lecture des octets bruts d'un fichier de shaders/media/ (manifeste ou sélection
// locale) relève de catalog.js (`Catalogue.contenuMedia`, voir sa construction par
// chargerManifeste ou catalogueDepuisFichiers) : ce module décode ensuite ces octets
// selon le type de canal, sans connaître leur origine.

const TYPES_MIME_VIDEO = Object.freeze({
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg', mov: 'video/quicktime',
});

/**
 * Type MIME d'un fichier vidéo d'après son extension (le navigateur en a besoin pour choisir le démuxeur d'un Blob).
 * @param {string} nom nom de fichier
 * @returns {string} chaîne vide si l'extension n'est pas reconnue (le navigateur tente alors de détecter le format)
 */
export function typeMimeVideo(nom) {
  const extension = String(nom).split('.').pop().toLowerCase();
  return TYPES_MIME_VIDEO[extension] ?? '';
}

/**
 * Décode des octets d'image (JPEG, PNG, WebP…) en `ImageBitmap`, orienté selon le
 * drapeau `vflip` de l'échantillonnage JSON (Shadertoy stocke ses images à l'envers
 * par convention historique ; `imageOrientation: 'flipY'` l'inverse sans repasser
 * par un canevas intermédiaire).
 * @param {Uint8Array} octets
 * @param {boolean} retournementVertical voir parser.js, Echantillonnage.retournementVertical
 * @returns {Promise<ImageBitmap>}
 */
export async function decoderImage(octets, retournementVertical) {
  const blob = new Blob([octets]);
  return createImageBitmap(blob, { imageOrientation: retournementVertical ? 'flipY' : 'none' });
}

// ---------------------------------------------------------------------------
// Entrées webcam / micro : désactivées par défaut
// ---------------------------------------------------------------------------

/**
 * État d'activation des entrées interactives (`webcam`, `mic`) : désactivées par
 * défaut dans toute l'application, et explicitement désactivées (jamais activables)
 * dans les miniatures et l'export, où aucune interaction utilisateur n'a de sens et
 * où une demande de permission serait intrusive pour un rendu non supervisé.
 */
export class EtatCapture {
  constructor() {
    this._active = false;
    this._flux = null;
  }

  /** Vrai si la capture (webcam ou micro) est actuellement active. */
  get active() { return this._active; }

  /**
   * Demande l'autorisation du navigateur et démarre la capture. N'est jamais appelée
   * automatiquement : seul un geste explicite de l'utilisateur (Phase 7, bouton dédié
   * dans l'inspecteur) déclenche cette méthode, jamais le chargement d'un shader.
   * @param {'webcam'|'mic'} type
   * @returns {Promise<MediaStream>}
   * @throws {Error} si l'autorisation est refusée ou qu'aucun périphérique n'est disponible
   */
  async activer(type) {
    const contraintes = type === 'webcam' ? { video: true, audio: false } : { video: false, audio: true };
    this._flux = await navigator.mediaDevices.getUserMedia(contraintes);
    this._active = true;
    return this._flux;
  }

  /** Arrête la capture et libère le flux ; sans effet si elle n'était pas active. */
  desactiver() {
    if (this._flux !== null) for (const piste of this._flux.getTracks()) piste.stop();
    this._flux = null;
    this._active = false;
  }
}
