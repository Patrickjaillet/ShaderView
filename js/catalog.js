// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Catalogue des shaders : lecture de shaders/manifest.json (requête de même origine),
// chargement paresseux du contenu de chaque .json, et replis locaux sans manifeste
// (sélecteur de dossier, glisser-déposer de dossiers ou de fichiers).
//
// Aucune requête ne quitte le site : la seule requête réseau est la lecture, sur la même
// origine, de fichiers publiés avec la page (manifeste et fichiers .json de shaders/).

import { analyserFichier, decoderTexte, extraireShader, sha256Hex } from './shader-meta.js';

export const DOSSIER_SHADERS = 'shaders';
export const URL_MANIFESTE = `${DOSSIER_SHADERS}/manifest.json`;
export const VERSION_MANIFESTE = 1;

const NOM_MANIFESTE = 'manifest.json';
const DOSSIERS_IGNORES = new Set(['.git', 'node_modules']);
const PROFONDEUR_MAX = 4;

/** Sources possibles d'un catalogue. */
export const SOURCES = Object.freeze({ MANIFESTE: 'manifeste', DOSSIER: 'dossier', FICHIERS: 'fichiers' });

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Entree
 * @property {string} cle identifiant unique dans le catalogue (« fichier » ou « fichier#index »)
 * @property {string} fichier nom du fichier .json
 * @property {number|null} index position du shader dans le fichier (null si le fichier est illisible)
 * @property {string} titre
 * @property {string|null} auteur
 * @property {string[]} passes
 * @property {boolean} multipasse
 * @property {boolean} son
 * @property {string|null} erreur anomalie bloquante (fichier ou shader), sinon null
 * @property {string[]} avertissements
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
   */
  constructor(source, fichiers, lecteur) {
    this.source = source;
    this.fichiers = fichiers;
    this.entrees = aplatir(fichiers);
    this._lecteur = lecteur;
    this._documents = new Map();
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
  let manifeste;
  try {
    manifeste = await reponse.json();
  } catch (e) {
    throw new Error(`${url} n'est pas un JSON valide (${e instanceof Error ? e.message : String(e)}).`);
  }
  validerManifeste(manifeste);

  const lecteur = async (fichier) => {
    const adresse = `${dossier}/${encodeURIComponent(fichier)}`;
    let r;
    try {
      r = await fetchFn(adresse, { credentials: 'same-origin', cache: 'no-cache' });
    } catch (e) {
      throw new Error(`Lecture de ${adresse} impossible (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (!r.ok) throw new Error(`Lecture de ${adresse} impossible (HTTP ${r.status}).`);
    return new Uint8Array(await r.arrayBuffer());
  };
  return new Catalogue(SOURCES.MANIFESTE, manifeste.fichiers, lecteur);
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
 * Construit un catalogue à partir de fichiers locaux, sans manifeste.
 * Chaque fichier est lu et analysé isolément : une lecture ou une analyse en échec
 * produit une entrée en erreur sans bloquer les autres.
 * @param {FichierLocal[]} fichiers
 * @param {{ source?: string, surProgres?: (fait: number, total: number) => void }} [options]
 * @returns {Promise<Catalogue>}
 */
export async function catalogueDepuisFichiers(fichiers, { source = SOURCES.FICHIERS, surProgres } = {}) {
  const retenus = selectionnerJson(fichiers).sort((a, b) => (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0));
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
  return new Catalogue(source, analyses, lecteur);
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
 * @returns {Promise<FichierLocal[]|null>} null si l'utilisateur annule
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
