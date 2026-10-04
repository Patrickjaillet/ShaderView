// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Catalogue des shaders : lecture de shaders/manifest.json (requête de même origine),
// chargement paresseux du contenu de chaque .json, et replis locaux sans manifeste
// (sélecteur de dossier, glisser-déposer de dossiers ou de fichiers). Expose aussi la
// bibliothèque audio (audio/manifest.json) de musiques de remplacement, choisies
// manuellement dans l'inspecteur pour un canal music/musicstream non résolu.
//
// Aucune requête ne quitte le site : la seule requête réseau est la lecture, sur la même
// origine, de fichiers publiés avec la page (manifestes et fichiers de shaders/ et audio/).

import { analyserFichier, decoderTexte, extraireShader, sha256Hex } from './shader-meta.js';

export const DOSSIER_SHADERS = 'shaders';
export const URL_MANIFESTE = `${DOSSIER_SHADERS}/manifest.json`;
export const VERSION_MANIFESTE = 1;

const NOM_MANIFESTE = 'manifest.json';
const DOSSIERS_IGNORES = new Set(['.git', 'node_modules']);
const PROFONDEUR_MAX = 4;

/** Sources possibles d'un catalogue. */
export const SOURCES = Object.freeze({ MANIFESTE: 'manifeste', DOSSIER: 'dossier', FICHIERS: 'fichiers' });

// Lecteur de média par défaut pour un catalogue chargé depuis le manifeste : requête
// de même origine sous shaders/media/ (même politique que la lecture d'un .json de
// shaders/, voir chargerManifeste). Les catalogues locaux (dossier, fichiers) passent
// leur propre lecteur, voir catalogueDepuisFichiers.
async function defaultLecteurMedia(nom) {
  const adresse = `${DOSSIER_SHADERS}/media/${encodeURIComponent(nom)}`;
  let r;
  try {
    r = await globalThis.fetch(adresse, { credentials: 'same-origin', cache: 'no-cache' });
  } catch (e) {
    throw new Error(`Lecture de ${adresse} impossible (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!r.ok) throw new Error(`Lecture de ${adresse} impossible (HTTP ${r.status}).`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Entree
 * @property {string} cle identifiant unique dans le catalogue (« fichier » ou « fichier#index »)
 * @property {string} fichier nom du fichier .json
 * @property {number|null} index position du shader dans le fichier (null si le fichier est illisible)
 * @property {string|null} id identifiant Shadertoy (`info.id`)
 * @property {string} titre
 * @property {string|null} auteur
 * @property {string|null} description
 * @property {string[]} tags
 * @property {number|null} date horodatage Unix (secondes), `info.date`
 * @property {string[]} passes
 * @property {boolean} multipasse
 * @property {boolean} son
 * @property {string[]} canaux types de canal utilisés par au moins une passe (voir shader-meta.js, TYPES_CANAUX)
 * @property {string[]} medias chemins `src`/`filepath` des médias externes référencés (voir shader-meta.js, CANAUX_AVEC_MEDIA)
 * @property {string|null} erreur anomalie bloquante (fichier ou shader), sinon null
 * @property {string[]} avertissements
 * @property {number} taille taille du fichier en octets
 * @property {string} empreinte SHA-256 du fichier
 * @property {boolean} perime vrai si le fichier a changé depuis la génération du manifeste
 */

/**
 * Aplatit la liste de fichiers analysés en une liste d'entrées à afficher :
 * un fichier illisible donne une entrée en erreur, un fichier multi-shaders en donne une par shader.
 * @param {object[]} fichiers
 * @returns {Entree[]}
 */
export function aplatir(fichiers) {
  const entrees = [];
  for (const f of fichiers) {
    if (f.erreur !== null || f.shaders.length === 0) {
      entrees.push({
        cle: f.fichier,
        fichier: f.fichier,
        index: null,
        id: null,
        titre: f.fichier.replace(/\.json$/i, ''),
        auteur: null,
        description: null,
        tags: [],
        date: null,
        passes: [],
        multipasse: false,
        son: false,
        canaux: [],
        medias: [],
        avertissements: [],
        erreur: f.erreur ?? 'Fichier sans shader.',
        taille: f.taille,
        empreinte: f.empreinte,
        perime: false,
      });
      continue;
    }
    for (const s of f.shaders) {
      entrees.push({
        ...s,
        cle: f.shaders.length === 1 ? f.fichier : `${f.fichier}#${s.index}`,
        fichier: f.fichier,
        taille: f.taille,
        empreinte: f.empreinte,
        perime: false,
      });
    }
  }
  return entrees;
}

export class Catalogue {
  /**
   * @param {string} source une valeur de SOURCES
   * @param {object[]} fichiers fichiers analysés (voir analyserFichier)
   * @param {(fichier: string) => Promise<Uint8Array>} lecteur lit le contenu brut d'un fichier du catalogue
   * @param {object} [options]
   * @param {Set<string>} [options.media] noms de fichiers disponibles dans shaders/media/ (voir media.js), vide par défaut
   * @param {(nom: string) => Promise<Uint8Array>} [options.lecteurMedia] lit le contenu brut d'un fichier de shaders/media/ ; par défaut, une requête de même origine sous DOSSIER_SHADERS/media/
   */
  constructor(source, fichiers, lecteur, { media = new Set(), lecteurMedia } = {}) {
    this.source = source;
    this.fichiers = fichiers;
    this.entrees = aplatir(fichiers);
    this.media = media;
    this._lecteur = lecteur;
    this._lecteurMedia = lecteurMedia ?? defaultLecteurMedia;
    this._documents = new Map();
  }

  /**
   * Charge le contenu brut d'un fichier de `shaders/media/` reconnu (voir media.js,
   * `resoudreNomMedia`). Chaque fichier est relu à chaque appel (pas de mise en cache :
   * contrairement aux .json de shaders/, un média peut être volumineux et n'est demandé
   * qu'une fois par canal résolu, voir renderer.js/MoteurRendu).
   * @param {string} nom
   * @returns {Promise<Uint8Array>}
   */
  async contenuMedia(nom) {
    return this._lecteurMedia(nom);
  }

  /** Nombre de fichiers en erreur (fichier illisible ou shader invalide). */
  get nbErreurs() {
    return this.entrees.filter((e) => e.erreur !== null).length;
  }

  /**
   * Charge à la demande le contenu d'une entrée et renvoie le shader (objet Shadertoy).
   * Chaque fichier n'est lu qu'une fois, même s'il contient plusieurs shaders.
   * Si l'empreinte du fichier diffère de celle du manifeste, `entree.perime` passe à vrai :
   * le contenu est tout de même utilisé, l'interface signale que le manifeste est périmé.
   * @param {Entree} entree
   * @returns {Promise<object>}
   */
  async contenu(entree) {
    if (entree.erreur !== null) throw new Error(`${entree.fichier} : ${entree.erreur}`);
    let promesse = this._documents.get(entree.fichier);
    if (promesse === undefined) {
      promesse = this._lecteur(entree.fichier).then((octets) => ({
        json: JSON.parse(decoderTexte(octets)),
        empreinte: sha256Hex(octets),
      }));
      this._documents.set(entree.fichier, promesse);
      // Un échec de lecture ne doit pas rester en cache : la lecture pourra être retentée.
      promesse.catch(() => this._documents.delete(entree.fichier));
    }
    const document = await promesse;
    entree.perime = document.empreinte !== entree.empreinte;
    return extraireShader(document.json, entree.index);
  }

  /** Libère les documents mis en cache (appelé lors du changement de catalogue). */
  vider() {
    this._documents.clear();
  }
}

// ---------------------------------------------------------------------------
// Source 1 : manifeste publié avec le site
// ---------------------------------------------------------------------------

function validerManifeste(manifeste) {
  if (manifeste === null || typeof manifeste !== 'object' || manifeste.version !== VERSION_MANIFESTE) {
    throw new Error(`Manifeste non reconnu (version ${VERSION_MANIFESTE} attendue).`);
  }
  if (!Array.isArray(manifeste.fichiers)) throw new Error('Manifeste invalide : liste « fichiers » absente.');
  for (const f of manifeste.fichiers) {
    if (
      f === null || typeof f !== 'object' || typeof f.fichier !== 'string' ||
      !Array.isArray(f.shaders) || typeof f.empreinte !== 'string'
    ) {
      throw new Error('Manifeste invalide : entrée de fichier mal formée.');
    }
  }
}

/**
 * Charge le catalogue depuis shaders/manifest.json (même origine que la page).
 * @param {{ url?: string, dossier?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<Catalogue>}
 * @throws {Error} si le manifeste est inaccessible ou invalide ; l'interface propose alors les replis locaux
 */
export async function chargerManifeste({ url = URL_MANIFESTE, dossier = DOSSIER_SHADERS, fetchFn = globalThis.fetch } = {}) {
  let reponse;
  try {
    reponse = await fetchFn(url, { credentials: 'same-origin', cache: 'no-cache' });
  } catch (e) {
    throw new Error(`Lecture de ${url} impossible (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!reponse.ok) throw new Error(`Lecture de ${url} impossible (HTTP ${reponse.status}).`);
  const octetsManifeste = new Uint8Array(await reponse.arrayBuffer());
  let manifeste;
  try {
    manifeste = JSON.parse(decoderTexte(octetsManifeste));
  } catch (e) {
    throw new Error(`${url} n'est pas un JSON valide (${e instanceof Error ? e.message : String(e)}).`);
  }
  validerManifeste(manifeste);

  const requeteOctets = async (adresse) => {
    let r;
    try {
      r = await fetchFn(adresse, { credentials: 'same-origin', cache: 'no-cache' });
    } catch (e) {
      throw new Error(`Lecture de ${adresse} impossible (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (!r.ok) throw new Error(`Lecture de ${adresse} impossible (HTTP ${r.status}).`);
    return new Uint8Array(await r.arrayBuffer());
  };
  const lecteur = (fichier) => requeteOctets(`${dossier}/${encodeURIComponent(fichier)}`);
  const lecteurMedia = (nom) => requeteOctets(`${dossier}/media/${encodeURIComponent(nom)}`);
  const media = new Set(Array.isArray(manifeste.media) ? manifeste.media.filter((n) => typeof n === 'string') : []);
  const catalogue = new Catalogue(SOURCES.MANIFESTE, manifeste.fichiers, lecteur, { media, lecteurMedia });
  catalogue.empreinteManifeste = sha256Hex(octetsManifeste);
  return catalogue;
}

/**
 * Relit `shaders/manifest.json` et indique s'il a changé depuis la dernière lecture
 * (ajout, suppression ou modification d'un fichier de `shaders/`, régénéré par
 * `node tools/build-manifest.mjs`) — sans construire un nouveau catalogue : appelée
 * en sondage périodique (voir js/app.js) pour détecter qu'un rechargement est utile
 * avant de le faire, une page statique ne pouvant pas observer le dossier lui-même.
 * @param {string} empreinteConnue `catalogue.empreinteManifeste` de la dernière lecture
 * @param {{ url?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<boolean>} vrai si le contenu diffère (ou si la relecture échoue :
 *          un manifeste temporairement inaccessible n'est pas un changement avéré, mais ne
 *          doit pas non plus déclencher un rechargement sur une fausse détection de différence)
 */
export async function manifesteAChange(empreinteConnue, { url = URL_MANIFESTE, fetchFn = globalThis.fetch } = {}) {
  try {
    const reponse = await fetchFn(url, { credentials: 'same-origin', cache: 'no-cache' });
    if (!reponse.ok) return false;
    const octets = new Uint8Array(await reponse.arrayBuffer());
    return sha256Hex(octets) !== empreinteConnue;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sources 2 et 3 : fichiers locaux (dossier choisi, fichiers ou dossiers déposés)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FichierLocal
 * @property {string} nom nom du fichier
 * @property {string} chemin chemin relatif complet, séparateur « / » (ex. « shaders/a.json »)
 * @property {() => Promise<Uint8Array>} lire
 */

/**
 * Adapte un objet File (sélecteur, glisser-déposer) au format interne.
 * @param {File} fichier
 * @param {string} [chemin] chemin relatif ; à défaut `webkitRelativePath`, puis le nom
 * @returns {FichierLocal}
 */
export function fichierLocalDepuisFile(fichier, chemin) {
  return {
    nom: fichier.name,
    chemin: chemin || fichier.webkitRelativePath || fichier.name,
    lire: async () => new Uint8Array(await fichier.arrayBuffer()),
  };
}

function dossierParent(chemin) {
  const i = chemin.lastIndexOf('/');
  return i === -1 ? '' : chemin.slice(0, i);
}

/**
 * Choisit, parmi tous les fichiers fournis, les .json à cataloguer.
 * Un dossier choisi peut être `shaders/` lui-même ou la racine du projet :
 * on retient les .json situés à la racine de la sélection ; à défaut, ceux d'un
 * sous-dossier `shaders` ; à défaut, tous les .json (fichiers déposés isolément).
 * Les fichiers `manifest.json` sont toujours écartés.
 * @param {FichierLocal[]} fichiers
 * @returns {FichierLocal[]}
 */
export function selectionnerJson(fichiers) {
  const json = fichiers.filter((f) => /\.json$/i.test(f.nom) && f.nom !== NOM_MANIFESTE);
  if (json.length === 0) return [];

  const profondeur = (f) => f.chemin.split('/').length;
  const racines = Math.min(...json.map(profondeur));
  const alaRacine = json.filter((f) => profondeur(f) === racines);
  const sousShaders = json.filter((f) => dossierParent(f.chemin).split('/').slice(-1)[0] === DOSSIER_SHADERS);

  // Un seul niveau de dossier commun (sélection de shaders/) : on garde ces fichiers.
  // Sinon, si un dossier « shaders » existe plus bas (racine du projet), on garde son contenu direct.
  if (alaRacine.length === json.length) return alaRacine;
  if (sousShaders.length > 0) {
    const cible = dossierParent(sousShaders[0].chemin);
    return sousShaders.filter((f) => dossierParent(f.chemin) === cible);
  }
  return alaRacine;
}

/**
 * Choisit, parmi tous les fichiers fournis (dossier choisi ou glissé-déposé, mêmes
 * fichiers que selectionnerJson), ceux qui composent `shaders/media/` : situés dans
 * un dossier `media` directement sous `shaders` (ou sous la racine de la sélection,
 * si `shaders/` n'a pas été inclus), voir media.js pour la résolution des canaux.
 * Deux fichiers de même nom (dossiers différents) : le premier rencontré est retenu.
 * @param {FichierLocal[]} fichiers
 * @returns {Map<string, FichierLocal>} nom de fichier → fichier local
 */
export function selectionnerMedia(fichiers) {
  const parNom = new Map();
  for (const f of fichiers) {
    const segments = f.chemin.split('/');
    const indexMedia = segments.lastIndexOf('media');
    const estMedia = indexMedia !== -1 && indexMedia === segments.length - 2;
    if (estMedia && !parNom.has(f.nom)) parNom.set(f.nom, f);
  }
  return parNom;
}

/**
 * Construit un catalogue à partir de fichiers locaux, sans manifeste.
 * Chaque fichier est lu et analysé isolément : une lecture ou une analyse en échec
 * produit une entrée en erreur sans bloquer les autres.
 * @param {FichierLocal[]} fichiers
 * @param {{ source?: string, surProgres?: (fait: number, total: number) => void }} [options]
 * @returns {Promise<Catalogue>}
 */
export async function catalogueDepuisFichiers(fichiers, { source = SOURCES.FICHIERS, surProgres } = {}) {
  const retenus = selectionnerJson(fichiers).sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0));
  const parNomMedia = selectionnerMedia(fichiers);
  const parNom = new Map();
  const analyses = [];

  for (let i = 0; i < retenus.length; i += 1) {
    const f = retenus[i];
    // Deux fichiers de même nom (dossiers différents) : le premier est conservé, le suivant signalé.
    if (parNom.has(f.nom)) {
      analyses.push({
        fichier: f.nom, taille: 0, empreinte: '', format: null, shaders: [],
        erreur: `Nom en double (${f.chemin}) : ce fichier est ignoré.`,
      });
    } else {
      parNom.set(f.nom, f);
      try {
        analyses.push(analyserFichier(f.nom, await f.lire()));
      } catch (e) {
        analyses.push({
          fichier: f.nom, taille: 0, empreinte: '', format: null, shaders: [],
          erreur: `Lecture impossible : ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    if (surProgres) surProgres(i + 1, retenus.length);
  }

  const lecteur = async (nom) => {
    const f = parNom.get(nom);
    if (f === undefined) throw new Error(`Fichier « ${nom} » absent de la sélection.`);
    return f.lire();
  };
  const lecteurMedia = async (nom) => {
    const f = parNomMedia.get(nom);
    if (f === undefined) throw new Error(`Média « ${nom} » absent de la sélection locale.`);
    return f.lire();
  };
  return new Catalogue(source, analyses, lecteur, { media: new Set(parNomMedia.keys()), lecteurMedia });
}

// ---------------------------------------------------------------------------
// Collecte des fichiers : sélecteur de dossier
// ---------------------------------------------------------------------------

/** Vrai si le navigateur propose l'API File System Access pour choisir un dossier. */
export function dossierNatifDisponible() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

async function parcourirHandle(handle, chemin, profondeur, sortie) {
  for await (const [nom, enfant] of handle.entries()) {
    if (enfant.kind === 'file') {
      sortie.push({
        nom,
        chemin: `${chemin}/${nom}`,
        lire: async () => new Uint8Array(await (await enfant.getFile()).arrayBuffer()),
      });
    } else if (enfant.kind === 'directory' && profondeur < PROFONDEUR_MAX && !DOSSIERS_IGNORES.has(nom)) {
      await parcourirHandle(enfant, `${chemin}/${nom}`, profondeur + 1, sortie);
    }
  }
}

/**
 * Ouvre le sélecteur de dossier natif (File System Access API) et collecte ses fichiers.
 * Le handle est renvoyé avec les fichiers pour permettre un nouveau parcours ultérieur
 * sans redemander la permission (voir reanalyserDossierNatif, sondage périodique côté
 * js/app.js — une page statique ne peut pas observer elle-même les changements du dossier).
 * @returns {Promise<{ fichiers: FichierLocal[], handle: FileSystemDirectoryHandle }|null>} null si l'utilisateur annule
 */
export async function choisirDossierNatif() {
  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({ id: 'shaderview-shaders', mode: 'read' });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return null;
    throw e;
  }
  const sortie = [];
  await parcourirHandle(handle, handle.name, 0, sortie);
  return { fichiers: sortie, handle };
}

/**
 * Reparcourt un dossier déjà ouvert (voir choisirDossierNatif) sans redemander la
 * permission à l'utilisateur, pour détecter les fichiers ajoutés, supprimés ou
 * modifiés depuis le dernier parcours.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<FichierLocal[]>}
 * @throws {Error} si la permission accordée a été révoquée depuis (ex. dossier déplacé) ;
 *         l'appelant doit alors proposer de rouvrir le sélecteur
 */
export async function reanalyserDossierNatif(handle) {
  if (typeof handle.queryPermission === 'function') {
    const permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') throw new Error('Permission d\'accès au dossier révoquée : rouvrez-le.');
  }
  const sortie = [];
  await parcourirHandle(handle, handle.name, 0, sortie);
  return sortie;
}

/**
 * Convertit une liste de fichiers issue d'un `<input type="file">` (avec ou sans `webkitdirectory`).
 * @param {FileList|File[]} liste
 * @returns {FichierLocal[]}
 */
export function fichiersDepuisSelection(liste) {
  return Array.from(liste, (f) => fichierLocalDepuisFile(f));
}

// ---------------------------------------------------------------------------
// Collecte des fichiers : glisser-déposer
// ---------------------------------------------------------------------------

function lireEntreeFichier(entree) {
  return new Promise((resolu, rejete) => entree.file(resolu, rejete));
}

function lireTousLesEnfants(lecteur) {
  return new Promise((resolu, rejete) => {
    const tous = [];
    const suite = () => {
      lecteur.readEntries((lot) => {
        if (lot.length === 0) resolu(tous);
        else {
          tous.push(...lot);
          suite();
        }
      }, rejete);
    };
    suite();
  });
}

async function parcourirEntree(entree, parent, profondeur, sortie) {
  const chemin = parent === '' ? entree.name : `${parent}/${entree.name}`;
  if (entree.isFile) {
    const fichier = await lireEntreeFichier(entree);
    sortie.push(fichierLocalDepuisFile(fichier, chemin));
  } else if (entree.isDirectory && profondeur < PROFONDEUR_MAX && !DOSSIERS_IGNORES.has(entree.name)) {
    const enfants = await lireTousLesEnfants(entree.createReader());
    for (const enfant of enfants) await parcourirEntree(enfant, chemin, profondeur + 1, sortie);
  }
}

/**
 * Collecte les fichiers d'un glisser-déposer, dossiers compris.
 * Les entrées sont capturées de façon synchrone (le DataTransfer n'est valide que pendant l'événement).
 * @param {DataTransfer} transfert
 * @returns {Promise<FichierLocal[]>}
 */
export async function collecterDepot(transfert) {
  const items = Array.from(transfert.items ?? []);
  const entrees = items
    .filter((item) => item.kind === 'file')
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));

  // Sans accès aux entrées de système de fichiers (ancien navigateur) : fichiers à plat.
  if (entrees.length === 0 || entrees.some((e) => e === null)) {
    return fichiersDepuisSelection(transfert.files ?? []);
  }
  const sortie = [];
  for (const entree of entrees) await parcourirEntree(entree, '', 0, sortie);
  return sortie;
}

// ---------------------------------------------------------------------------
// Bibliothèque audio (audio/manifest.json) : musiques de remplacement choisies
// manuellement pour les canaux music/musicstream dont le fichier d'origine n'est
// pas fourni dans shaders/media/ (voir js/media.js, js/inspector.js).
// ---------------------------------------------------------------------------

export const DOSSIER_AUDIO = 'audio';
export const URL_MANIFESTE_AUDIO = `${DOSSIER_AUDIO}/manifest.json`;
export const VERSION_MANIFESTE_AUDIO = 1;

/**
 * Bibliothèque de pistes audio disponibles pour remplacer manuellement un canal
 * music/musicstream non résolu. Contrairement au catalogue des shaders, une seule
 * instance suffit pour toute la session (la bibliothèque ne change pas selon le
 * shader affiché) ; `lire(nom)` ne met rien en cache, comme `Catalogue.contenuMedia`.
 */
export class BibliothequeAudio {
  /**
   * @param {string[]} pistes noms de fichiers, tels que listés par audio/manifest.json
   * @param {(nom: string) => Promise<Uint8Array>} lecteur
   */
  constructor(pistes, lecteur) {
    this.pistes = pistes;
    this._lecteur = lecteur;
  }

  /**
   * Lit le contenu brut d'une piste par son nom (voir `pistes`).
   * @param {string} nom
   * @returns {Promise<Uint8Array>}
   */
  async lire(nom) {
    if (!this.pistes.includes(nom)) throw new Error(`Piste « ${nom} » absente de la bibliothèque audio.`);
    return this._lecteur(nom);
  }
}

function validerManifesteAudio(manifeste) {
  if (manifeste === null || typeof manifeste !== 'object' || manifeste.version !== VERSION_MANIFESTE_AUDIO) {
    throw new Error(`Manifeste audio non reconnu (version ${VERSION_MANIFESTE_AUDIO} attendue).`);
  }
  if (!Array.isArray(manifeste.pistes) || manifeste.pistes.some((p) => typeof p !== 'string')) {
    throw new Error('Manifeste audio invalide : liste « pistes » absente ou mal formée.');
  }
}

/**
 * Charge la bibliothèque audio depuis audio/manifest.json (même origine que la page).
 * Absence de dossier audio/ ou de manifeste : non bloquant, l'appelant reçoit une
 * bibliothèque vide plutôt qu'une exception (la fonctionnalité est optionnelle).
 * @param {{ url?: string, dossier?: string, fetchFn?: typeof fetch }} [options]
 * @returns {Promise<BibliothequeAudio>}
 */
export async function chargerBibliothequeAudio({ url = URL_MANIFESTE_AUDIO, dossier = DOSSIER_AUDIO, fetchFn = globalThis.fetch } = {}) {
  let reponse;
  try {
    reponse = await fetchFn(url, { credentials: 'same-origin', cache: 'no-cache' });
  } catch {
    return new BibliothequeAudio([], async () => { throw new Error('Bibliothèque audio indisponible.'); });
  }
  if (!reponse.ok) return new BibliothequeAudio([], async () => { throw new Error('Bibliothèque audio indisponible.'); });
  let manifeste;
  try {
    manifeste = JSON.parse(decoderTexte(new Uint8Array(await reponse.arrayBuffer())));
    validerManifesteAudio(manifeste);
  } catch {
    return new BibliothequeAudio([], async () => { throw new Error('Bibliothèque audio indisponible.'); });
  }
  const lecteur = async (nom) => {
    const adresse = `${dossier}/${encodeURIComponent(nom)}`;
    let r;
    try {
      r = await fetchFn(adresse, { credentials: 'same-origin', cache: 'no-cache' });
    } catch (e) {
      throw new Error(`Lecture de ${adresse} impossible (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (!r.ok) throw new Error(`Lecture de ${adresse} impossible (HTTP ${r.status}).`);
    return new Uint8Array(await r.arrayBuffer());
  };
  return new BibliothequeAudio(manifeste.pistes, lecteur);
}
