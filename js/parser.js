// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Parseur du format JSON Shadertoy : lecture complète de `info`, `renderpass[]`,
// `inputs[]` (canal, type, source, échantillonnage) et `outputs[]`, résolution du
// graphe de dépendances entre passes et normalisation vers un modèle interne
// unique, indépendant de la version du format d'entrée.
//
// Ce module est, comme shader-meta.js, indépendant du DOM, du réseau et de WebGL :
// il ne fait qu'analyser un objet shader déjà décodé (voir catalog.js / shader-meta.js
// pour l'obtenir) et produire une description que renderer.js et audio.js (Phase 3
// et 6) pourront exécuter sans connaître le format JSON d'origine.
//
// Le modèle interne distingue quatre familles de passes :
//   - `commun`  : code concaténé en tête de chaque autre passe (ou null si absent) ;
//   - `buffers` : jusqu'à quatre passes nommées A, B, C, D (type « buffer »), chacune
//                 avec son ordre d'exécution résolu (voir resoudreOrdre) ;
//   - `image`   : la passe finale affichée (obligatoire) ;
//   - `son`     : la passe `mainSound` (optionnelle) ;
//   - `cubemaps`: les passes de type « cubemap » (optionnelles, par nom).
// Chaque entrée de canal normalisée référence soit un buffer interne (par sa lettre),
// soit un média externe (voir resoudreEntree), de façon à ce que le moteur de rendu
// n'ait jamais à relire le JSON brut.

import { TYPES_CANAUX, TYPES_PASSES } from './shader-meta.js';

export const LETTRES_BUFFERS = Object.freeze(['A', 'B', 'C', 'D']);

const FILTRES = Object.freeze(['nearest', 'linear', 'mipmap']);
const REPETITIONS = Object.freeze(['clamp', 'repeat']);

// ---------------------------------------------------------------------------
// Erreur de parsage
// ---------------------------------------------------------------------------

/** Erreur bloquante levée par `parserShader` : le shader ne peut pas être normalisé. */
export class ErreurParseur extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurParseur';
  }
}

function estObjet(valeur) {
  return valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur);
}

function chaine(valeur, repli = null) {
  return typeof valeur === 'string' ? valeur : repli;
}

function chaineNonVide(valeur) {
  return typeof valeur === 'string' && valeur.trim() !== '' ? valeur.trim() : null;
}

function entier(valeur, repli = null) {
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return Math.trunc(valeur);
  if (typeof valeur === 'string' && valeur.trim() !== '' && Number.isFinite(Number(valeur))) return Math.trunc(Number(valeur));
  return repli;
}

// ---------------------------------------------------------------------------
// `info`
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Info
 * @property {string|null} id
 * @property {string} nom
 * @property {string|null} description
 * @property {string|null} auteur
 * @property {string[]} tags
 * @property {number|null} date date de publication, horodatage Unix en secondes (null si absente ou illisible)
 */

/**
 * Normalise le bloc `info`. Tous les champs sont optionnels dans le JSON d'origine :
 * une valeur absente devient `null` (ou un tableau vide pour `tags`), jamais une erreur.
 * @param {unknown} info
 * @param {string} nomRepli utilisé comme `nom` si `info.name` est absent
 * @returns {Info}
 */
export function parserInfo(info, nomRepli) {
  if (!estObjet(info)) {
    return { id: null, nom: nomRepli, description: null, auteur: null, tags: [], date: null };
  }
  const tags = Array.isArray(info.tags)
    ? info.tags.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim())
    : [];
  return {
    id: chaineNonVide(info.id),
    nom: chaineNonVide(info.name) ?? nomRepli,
    description: chaineNonVide(info.description),
    auteur: chaineNonVide(info.username),
    tags,
    date: entier(info.date),
  };
}

// ---------------------------------------------------------------------------
// `inputs[].sampler`
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Echantillonnage
 * @property {'nearest'|'linear'|'mipmap'} filtre
 * @property {'clamp'|'repeat'} repetition
 * @property {boolean} retournementVertical
 * @property {boolean} srgb
 * @property {string|null} interne format interne demandé (ex. « byte », « float »), tel quel, ou null
 */

export const ECHANTILLONNAGE_PAR_DEFAUT = Object.freeze({
  filtre: 'linear',
  repetition: 'clamp',
  retournementVertical: false,
  srgb: false,
  interne: null,
});

/**
 * Normalise `inputs[].sampler`. Les valeurs inconnues ou absentes reçoivent le
 * repli Shadertoy usuel (filtre linéaire, répétition par bord, pas de retournement).
 * @param {unknown} sampler
 * @returns {Echantillonnage}
 */
export function parserEchantillonnage(sampler) {
  if (!estObjet(sampler)) return { ...ECHANTILLONNAGE_PAR_DEFAUT };
  const filtre = typeof sampler.filter === 'string' ? sampler.filter.toLowerCase() : '';
  const repetition = typeof sampler.wrap === 'string' ? sampler.wrap.toLowerCase() : '';
  return {
    filtre: FILTRES.includes(filtre) ? filtre : ECHANTILLONNAGE_PAR_DEFAUT.filtre,
    repetition: REPETITIONS.includes(repetition) ? repetition : ECHANTILLONNAGE_PAR_DEFAUT.repetition,
    retournementVertical: sampler.vflip === true || sampler.vflip === 'true',
    srgb: sampler.srgb === true || sampler.srgb === 'true',
    interne: chaineNonVide(sampler.internal),
  };
}

// ---------------------------------------------------------------------------
// `renderpass[].inputs[]`
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Entree
 * @property {number} canal numéro de canal (0 à 3) ; `iChannelN`
 * @property {string} type type de canal normalisé (voir TYPES_CANAUX)
 * @property {string|null} src chemin ou identifiant source du JSON, inchangé (résolution en Phase 5)
 * @property {string|null} idSortie identifiant `outputs[].id` référencé, si `type` est « buffer » ou « cubemap »
 * @property {Echantillonnage} echantillonnage
 */

/**
 * Normalise une entrée `inputs[]]`. Une entrée mal formée (canal hors plage, type
 * inconnu, objet absent) produit un avertissement dans `avertissements` et est omise
 * du résultat plutôt que de bloquer l'analyse de la passe entière. Pour les canaux de
 * type « buffer » ou « cubemap », `id` référence la passe source via `outputs[].id`
 * (seule référence fiable ; `src` n'est qu'un chemin cosmétique d'aperçu).
 * @param {unknown} entree
 * @param {number} indexPasse position de la passe, pour le message d'avertissement
 * @param {string} nomPasse
 * @param {string[]} avertissements
 * @returns {Entree|null}
 */
export function parserEntree(entree, indexPasse, nomPasse, avertissements) {
  if (!estObjet(entree)) {
    avertissements.push(`Passe ${indexPasse + 1} (${nomPasse}) : entrée ignorée (objet attendu).`);
    return null;
  }
  const canal = entier(entree.channel);
  if (canal === null || canal < 0 || canal > 3) {
    avertissements.push(`Passe ${indexPasse + 1} (${nomPasse}) : canal « ${String(entree.channel)} » hors de 0 à 3, entrée ignorée.`);
    return null;
  }
  const type = String(entree.ctype ?? entree.type ?? '').toLowerCase();
  if (!TYPES_CANAUX.includes(type)) {
    avertissements.push(`Passe ${indexPasse + 1} (${nomPasse}) : type de canal « ${type} » inconnu, entrée ignorée.`);
    return null;
  }
  return {
    canal,
    type,
    // Le format d'export de l'API Shadertoy nomme ce champ « filepath » ; l'éditeur
    // en ligne (et les exports plus anciens) utilise « src ». Les deux sont acceptés,
    // « filepath » prioritaire s'il est présent (c'est le format réellement rencontré
    // dans shaders/ : voir MEMOIRE.md, Phase 5).
    src: chaine(entree.filepath) ?? chaine(entree.src),
    idSortie: type === 'buffer' || type === 'cubemap' ? chaineNonVide(entree.id) : null,
    echantillonnage: parserEchantillonnage(entree.sampler),
  };
}

// ---------------------------------------------------------------------------
// `renderpass[]` (une passe)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Passe
 * @property {string} type voir TYPES_PASSES
 * @property {string} nom
 * @property {string} code
 * @property {string|null} idSortie `outputs[0].id`, identifiant utilisé par les entrées de type « buffer » qui la ciblent
 * @property {Entree[]} entrees jusqu'à quatre entrées, triées par numéro de canal
 */

/**
 * Normalise une passe `renderpass[]`. Les entrées invalides sont consignées en
 * avertissement puis omises (voir parserEntree) ; seules l'absence de type reconnu
 * ou l'absence de code source sont bloquantes, car la passe serait alors inexécutable.
 * @param {unknown} passe
 * @param {number} index
 * @param {string[]} avertissements
 * @returns {Passe}
 * @throws {ErreurParseur} si le type est inconnu ou le code source absent
 */
export function parserPasse(passe, index, avertissements) {
  if (!estObjet(passe)) throw new ErreurParseur(`Passe ${index + 1} invalide : un objet est attendu.`);
  const type = typeof passe.type === 'string' ? passe.type.toLowerCase() : '';
  if (!TYPES_PASSES.includes(type)) {
    throw new ErreurParseur(`Passe ${index + 1} : type « ${String(passe.type)} » inconnu (attendu : ${TYPES_PASSES.join(', ')}).`);
  }
  if (typeof passe.code !== 'string' || passe.code.trim() === '') {
    throw new ErreurParseur(`Passe ${index + 1} (${type}) : code source absent ou vide.`);
  }
  const nom = chaineNonVide(passe.name) ?? type;
  const sorties = Array.isArray(passe.outputs) ? passe.outputs : [];
  const premiereSortie = sorties.find((s) => estObjet(s));
  const entreesBrutes = Array.isArray(passe.inputs) ? passe.inputs : [];
  const entrees = entreesBrutes
    .map((e) => parserEntree(e, index, nom, avertissements))
    .filter((e) => e !== null)
    .sort((a, b) => a.canal - b.canal);

  // Deux entrées sur le même canal : seule la dernière (ordre du JSON) est retenue,
  // comme le ferait l'affectation d'un uniforme répété ; les précédentes sont signalées.
  const parCanal = new Map();
  for (const e of entrees) {
    if (parCanal.has(e.canal)) avertissements.push(`Passe ${index + 1} (${nom}) : canal ${e.canal} défini plusieurs fois, seule la dernière entrée est retenue.`);
    parCanal.set(e.canal, e);
  }

  return {
    type,
    nom,
    code: passe.code,
    idSortie: premiereSortie !== undefined ? chaineNonVide(premiereSortie.id) : null,
    entrees: Array.from(parCanal.values()).sort((a, b) => a.canal - b.canal),
  };
}

// ---------------------------------------------------------------------------
// Résolution du graphe de dépendances entre buffers
// ---------------------------------------------------------------------------

/**
 * Détermine, pour chaque buffer, l'ensemble des buffers dont il lit la sortie
 * (entrées de type « buffer » dont `idSortie` correspond à la sortie d'un autre buffer).
 * Une entrée « buffer » qui référence sa propre sortie (rétroaction) n'est pas une
 * dépendance d'ordre : un buffer peut toujours lire sa propre image de la frame précédente.
 * @param {Record<string, Passe>} buffers lettre → passe
 * @returns {Map<string, Set<string>>} lettre → ensemble des lettres dont elle dépend
 */
export function construireGrapheDependances(buffers) {
  const idVersLettre = new Map();
  for (const lettre of LETTRES_BUFFERS) {
    const b = buffers[lettre];
    if (b !== undefined && b.idSortie !== null) idVersLettre.set(b.idSortie, lettre);
  }
  const graphe = new Map(LETTRES_BUFFERS.filter((l) => buffers[l] !== undefined).map((l) => [l, new Set()]));
  for (const lettre of graphe.keys()) {
    for (const entree of buffers[lettre].entrees) {
      if (entree.type !== 'buffer' || entree.idSortie === null) continue;
      const source = idVersLettre.get(entree.idSortie);
      if (source !== undefined && source !== lettre) graphe.get(lettre).add(source);
    }
  }
  return graphe;
}

/**
 * Trie les buffers présents selon leur graphe de dépendances (tri topologique) :
 * un buffer est rendu après tous les buffers dont il lit la sortie (hors rétroaction).
 * En cas de dépendance circulaire entre buffers distincts (cycle autre qu'une
 * rétroaction simple), l'ordre d'écriture du JSON est conservé pour les buffers du
 * cycle et un avertissement est consigné : un tel montage n'a pas d'ordre correct
 * et ne peut de toute façon pas être reproduit fidèlement sans rendre deux fois.
 * @param {Record<string, Passe>} buffers
 * @param {string[]} avertissements
 * @returns {string[]} lettres des buffers, dans l'ordre de rendu
 */
export function resoudreOrdre(buffers, avertissements) {
  const presents = LETTRES_BUFFERS.filter((l) => buffers[l] !== undefined);
  const graphe = construireGrapheDependances(buffers);
  const ordre = [];
  const visite = new Set();
  const enCours = new Set();
  let cycleSignale = false;

  const visiter = (lettre) => {
    if (visite.has(lettre)) return;
    if (enCours.has(lettre)) {
      if (!cycleSignale) {
        avertissements.push('Dépendance circulaire entre buffers (hors rétroaction) : ordre du fichier conservé pour les buffers concernés.');
        cycleSignale = true;
      }
      return;
    }
    enCours.add(lettre);
    for (const dependance of graphe.get(lettre)) visiter(dependance);
    enCours.delete(lettre);
    visite.add(lettre);
    ordre.push(lettre);
  };

  for (const lettre of presents) visiter(lettre);
  return ordre;
}

// ---------------------------------------------------------------------------
// Modèle normalisé complet
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ShaderNormalise
 * @property {Info} info
 * @property {Passe|null} commun passe « common », ou null si absente
 * @property {Record<string, Passe>} buffers lettre (A à D) → passe
 * @property {string[]} ordreBuffers lettres des buffers, dans l'ordre de rendu résolu
 * @property {Passe} image passe finale (toujours présente)
 * @property {Passe|null} son passe « sound », ou null si absente
 * @property {Record<string, Passe>} cubemaps nom de la passe → passe
 * @property {string[]} avertissements anomalies non bloquantes rencontrées pendant l'analyse
 */

/**
 * Analyse et normalise un shader Shadertoy déjà décodé (voir shader-meta.js pour
 * l'extraire d'un document JSON) vers le modèle interne unique de ShaderView.
 * @param {unknown} shader
 * @param {string} [nomRepli] utilisé comme titre si `info.name` est absent
 * @returns {ShaderNormalise}
 * @throws {ErreurParseur} si le shader ne peut pas être normalisé (passe invalide,
 *         aucune passe « image », plus de quatre buffers, lettre de buffer en double)
 */
export function parserShader(shader, nomRepli = 'shader') {
  if (!estObjet(shader)) throw new ErreurParseur('Shader invalide : un objet est attendu.');
  if (!Array.isArray(shader.renderpass) || shader.renderpass.length === 0) {
    throw new ErreurParseur('Aucune passe : « renderpass » doit être un tableau non vide.');
  }

  const avertissements = [];
  const info = parserInfo(shader.info, nomRepli);

  let commun = null;
  const buffersBruts = [];
  let image = null;
  let son = null;
  const cubemaps = {};

  for (let n = 0; n < shader.renderpass.length; n += 1) {
    const passe = parserPasse(shader.renderpass[n], n, avertissements);
    switch (passe.type) {
      case 'common':
        if (commun !== null) avertissements.push(`Passe ${n + 1} (common) : une passe « common » était déjà présente, celle-ci la remplace.`);
        commun = passe;
        break;
      case 'buffer':
        buffersBruts.push(passe);
        break;
      case 'image':
        if (image !== null) avertissements.push(`Passe ${n + 1} (image) : une passe « image » était déjà présente, celle-ci la remplace.`);
        image = passe;
        break;
      case 'sound':
        if (son !== null) avertissements.push(`Passe ${n + 1} (sound) : une passe « sound » était déjà présente, celle-ci la remplace.`);
        son = passe;
        break;
      case 'cubemap':
        if (Object.hasOwn(cubemaps, passe.nom)) avertissements.push(`Passe ${n + 1} (cubemap « ${passe.nom} ») : une passe de même nom existait déjà, celle-ci la remplace.`);
        cubemaps[passe.nom] = passe;
        break;
      default:
        // Inatteignable : parserPasse valide déjà le type contre TYPES_PASSES.
        throw new ErreurParseur(`Passe ${n + 1} : type « ${passe.type} » non géré.`);
    }
  }

  if (image === null) throw new ErreurParseur('Aucune passe « image » : le shader ne peut pas être affiché.');
  if (buffersBruts.length > LETTRES_BUFFERS.length) {
    throw new ErreurParseur(`${buffersBruts.length} passes « buffer » déclarées, ${LETTRES_BUFFERS.length} au maximum (A à D).`);
  }

  // Shadertoy associe les buffers aux lettres A, B, C, D dans l'ordre d'apparition
  // dans `renderpass[]` : la position parmi les seules passes « buffer » fait foi,
  // indépendamment des autres types de passe qui peuvent s'intercaler.
  const buffers = {};
  for (let i = 0; i < buffersBruts.length; i += 1) buffers[LETTRES_BUFFERS[i]] = buffersBruts[i];

  const ordreBuffers = resoudreOrdre(buffers, avertissements);

  return { info, commun, buffers, ordreBuffers, image, son, cubemaps, avertissements };
}
