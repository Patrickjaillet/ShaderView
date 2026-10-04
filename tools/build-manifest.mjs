#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Génère shaders/manifest.json : le catalogue des fichiers .json du dossier shaders/,
// et la liste des fichiers disponibles dans shaders/media/ (résolution des médias
// hors-ligne, voir js/media.js et ROADMAP.md, Phase 5). Génère aussi audio/manifest.json
// s'il existe un dossier audio/ à la racine du dépôt : une bibliothèque de musiques de
// remplacement, choisie manuellement par l'utilisateur dans l'inspecteur pour les
// canaux `music`/`musicstream` dont le fichier d'origine n'est pas fourni dans
// shaders/media/ (voir js/catalog.js, chargerBibliothequeAudio, et js/inspector.js).
//
// Une page statique ne peut pas lister un dossier du serveur ; les deux manifestes
// sont donc établis avant publication. Chaque fichier .json de shaders/ est lu, validé
// et décrit (nom, taille, empreinte SHA-256, titre, auteur, types de passes, présence
// de son, médias référencés). Un fichier invalide n'interrompt pas la génération : son
// erreur est consignée dans le manifeste et affichée dans l'inspecteur.
//
// Usage :
//   node tools/build-manifest.mjs                 écrit shaders/manifest.json et audio/manifest.json (s'il existe)
//   node tools/build-manifest.mjs --check         échoue si l'un des deux manifestes n'est pas à jour
//   node tools/build-manifest.mjs --strict        échoue si un fichier de shaders/ contient une erreur
//   node tools/build-manifest.mjs --dossier <d>   cible un autre dossier que shaders/ (audio/ reste à la racine du dépôt)
//
// Les deux manifestes sont déterministes (ordre alphabétique, aucune date) : une
// régénération sans changement de contenu ne produit aucune modification.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyserFichier } from '../js/shader-meta.js';

export const VERSION_MANIFESTE = 1;
export const NOM_MANIFESTE = 'manifest.json';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function comparer(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DOSSIER_MEDIA = 'media';

/**
 * Liste les noms de fichiers présents dans le sous-dossier media/ (non récursif ;
 * les sous-dossiers éventuels — ex. une organisation personnelle de l'utilisateur —
 * ne sont pas pris en charge, le nom seul doit être unique, voir js/media.js).
 * Absent du dépôt par défaut : un tableau vide n'est pas une erreur.
 * @param {string} dossier dossier shaders/ (chemin absolu)
 * @returns {string[]} noms de fichiers, triés
 */
function listerMedia(dossier) {
  const dossierMedia = join(dossier, DOSSIER_MEDIA);
  if (!existsSync(dossierMedia) || !statSync(dossierMedia).isDirectory()) return [];
  return readdirSync(dossierMedia).filter((nom) => statSync(join(dossierMedia, nom)).isFile()).sort(comparer);
}

/**
 * Construit le manifeste d'un dossier.
 * @param {string} dossier chemin absolu du dossier à analyser (non récursif)
 * @returns {{ version: number, fichiers: object[], media: string[] }}
 */
export function construireManifeste(dossier) {
  const noms = readdirSync(dossier)
    .filter((nom) => /\.json$/i.test(nom) && nom !== NOM_MANIFESTE)
    .filter((nom) => statSync(join(dossier, nom)).isFile())
    .sort(comparer);
  const fichiers = noms.map((nom) => analyserFichier(nom, new Uint8Array(readFileSync(join(dossier, nom)))));
  return { version: VERSION_MANIFESTE, fichiers, media: listerMedia(dossier) };
}

export function serialiser(manifeste) {
  return `${JSON.stringify(manifeste, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// audio/manifest.json : bibliothèque de musiques de remplacement
// ---------------------------------------------------------------------------

export const VERSION_MANIFESTE_AUDIO = 1;
const EXTENSIONS_AUDIO = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.opus']);

/**
 * Construit le manifeste de la bibliothèque audio (non récursif, comme shaders/media/) :
 * seuls les fichiers aux extensions audio courantes sont retenus, pour ignorer un
 * éventuel fichier non audio déposé par erreur dans le dossier.
 * @param {string} dossierAudio chemin absolu du dossier audio/
 * @returns {{ version: number, pistes: string[] }}
 */
export function construireManifesteAudio(dossierAudio) {
  const pistes = readdirSync(dossierAudio)
    .filter((nom) => EXTENSIONS_AUDIO.has(nom.slice(nom.lastIndexOf('.')).toLowerCase()))
    .filter((nom) => statSync(join(dossierAudio, nom)).isFile())
    .sort(comparer);
  return { version: VERSION_MANIFESTE_AUDIO, pistes };
}

function lireArguments(argv) {
  const options = { check: false, strict: false, dossier: join(RACINE, 'shaders') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--dossier') {
      i += 1;
      if (i >= argv.length) throw new Error('--dossier attend un chemin.');
      options.dossier = resolve(argv[i]);
    } else throw new Error(`Option inconnue : ${arg}`);
  }
  return options;
}

const NOM_MANIFESTE_AUDIO = 'manifest.json';

/**
 * Génère (ou vérifie) audio/manifest.json, s'il existe un dossier audio/ à la racine
 * du dépôt. Son absence n'est pas une erreur : la bibliothèque est optionnelle, le
 * repli procédural (voir media.js) reste disponible sans elle.
 * @param {string} dossierAudio chemin absolu du dossier audio/
 * @param {{ check: boolean }} options
 * @returns {0|1} code de sortie à combiner avec celui du manifeste des shaders
 */
function traiterManifesteAudio(dossierAudio, { check }) {
  if (!existsSync(dossierAudio) || !statSync(dossierAudio).isDirectory()) return 0;

  const manifeste = construireManifesteAudio(dossierAudio);
  const texte = serialiser(manifeste);
  const cible = join(dossierAudio, NOM_MANIFESTE_AUDIO);

  if (check) {
    const actuel = existsSync(cible) ? readFileSync(cible, 'utf8') : null;
    if (actuel !== texte) {
      console.error(`audio/${NOM_MANIFESTE_AUDIO} absent ou périmé : relancer « node tools/build-manifest.mjs ».`);
      return 1;
    }
    console.log(`audio/${NOM_MANIFESTE_AUDIO} à jour (${manifeste.pistes.length} piste(s)).`);
    return 0;
  }
  const identique = existsSync(cible) && readFileSync(cible, 'utf8') === texte;
  if (!identique) writeFileSync(cible, texte);
  console.log(`audio/${NOM_MANIFESTE_AUDIO} ${identique ? 'inchangé' : 'écrit'} : ${manifeste.pistes.length} piste(s).`);
  return 0;
}

function principal() {
  let options;
  try {
    options = lireArguments(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (!existsSync(options.dossier) || !statSync(options.dossier).isDirectory()) {
    console.error(`Dossier introuvable : ${options.dossier}`);
    return 2;
  }

  const manifeste = construireManifeste(options.dossier);
  const texte = serialiser(manifeste);
  const cible = join(options.dossier, NOM_MANIFESTE);

  const nbShaders = manifeste.fichiers.reduce((n, f) => n + f.shaders.length, 0);
  const enErreur = manifeste.fichiers.filter(
    (f) => f.erreur !== null || f.shaders.some((s) => s.erreur !== null),
  );
  for (const f of manifeste.fichiers) {
    if (f.erreur !== null) console.warn(`${f.fichier} : ${f.erreur}`);
    for (const s of f.shaders) {
      if (s.erreur !== null) console.warn(`${f.fichier} [shader ${s.index}] : ${s.erreur}`);
      for (const a of s.avertissements) console.warn(`${f.fichier} [shader ${s.index}] : ${a}`);
    }
  }

  let codeShaders = 0;
  if (options.check) {
    const actuel = existsSync(cible) ? readFileSync(cible, 'utf8') : null;
    if (actuel !== texte) {
      console.error(`${NOM_MANIFESTE} absent ou périmé : relancer « node tools/build-manifest.mjs ».`);
      codeShaders = 1;
    } else {
      console.log(`${NOM_MANIFESTE} à jour (${manifeste.fichiers.length} fichier(s), ${nbShaders} shader(s)).`);
    }
  } else {
    const identique = existsSync(cible) && readFileSync(cible, 'utf8') === texte;
    if (!identique) writeFileSync(cible, texte);
    console.log(
      `${NOM_MANIFESTE} ${identique ? 'inchangé' : 'écrit'} : ${manifeste.fichiers.length} fichier(s), ` +
      `${nbShaders} shader(s), ${enErreur.length} fichier(s) en erreur.`,
    );
  }
  if (options.strict && enErreur.length > 0) codeShaders = 1;

  const codeAudio = traiterManifesteAudio(join(RACINE, 'audio'), { check: options.check });
  return codeShaders !== 0 ? codeShaders : codeAudio;
}

// N'exécute le script que lorsqu'il est lancé directement (et non importé par les tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = principal();
}
