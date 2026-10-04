#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Convertit les fichiers de shaders/ qui ne sont pas au format d'export Shadertoy
// (reconnu par la clé « renderpass ») mais proviennent d'une autre collection dont le
// schéma est `{ num, title, category, file, unsupported, source }`, `source` portant
// un corps `mainImage` complet. Produit un export Shadertoy minimal à passe unique
// (`image`, sans entrée de canal) en conservant le code source tel quel.
//
// Un fichier qui ne correspond à aucun des deux schémas n'est jamais modifié ni
// supprimé ; son erreur reste visible dans l'inspecteur (voir shader-meta.js), pour
// qu'une anomalie réellement inattendue ne soit jamais convertie à l'aveugle.
//
// Usage :
//   node tools/convert-legacy-shaders.mjs                 convertit en place
//   node tools/convert-legacy-shaders.mjs --verifier       n'écrit rien, liste ce qui serait converti
//   node tools/convert-legacy-shaders.mjs --dossier <d>    cible un autre dossier que shaders/

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOM_MANIFESTE = 'manifest.json';

/**
 * Reconnaît le schéma `{ num, title, category, file, unsupported, source }` d'une
 * autre collection de shaders (jamais celui d'un export Shadertoy, qui porte
 * toujours une clé « renderpass »).
 * @param {unknown} donnees
 * @returns {boolean}
 */
export function estFormatHerite(donnees) {
  return (
    donnees !== null && typeof donnees === 'object' && !Array.isArray(donnees) &&
    !('renderpass' in donnees) &&
    typeof donnees.title === 'string' &&
    typeof donnees.source === 'string' && donnees.source.trim() !== ''
  );
}

/**
 * Construit un identifiant stable et sans espace à partir de `num` et `category`
 * (ex. « water-360 »), utilisé comme `info.id` — jamais lu comme clé par le reste de
 * l'application (voir parser.js, shader-meta.js : purement informatif), seulement
 * utile pour distinguer deux fichiers si on les recombinait un jour.
 * @param {{ num?: unknown, category?: unknown }} donnees
 * @returns {string|null}
 */
function construireId(donnees) {
  const categorie = typeof donnees.category === 'string' ? donnees.category.trim().toLowerCase() : '';
  const num = typeof donnees.num === 'string' || typeof donnees.num === 'number' ? String(donnees.num).trim() : '';
  const id = [categorie, num].filter((s) => s !== '').join('-');
  return id === '' ? null : id;
}

/**
 * Convertit un document au format hérité en export Shadertoy minimal à passe unique.
 * @param {{ title: string, category?: unknown, source: string, num?: unknown }} donnees
 * @returns {object}
 */
export function convertirFormatHerite(donnees) {
  const tags = typeof donnees.category === 'string' && donnees.category.trim() !== '' ? [donnees.category.trim()] : [];
  return {
    ver: '0.1',
    info: {
      id: construireId(donnees),
      name: donnees.title.trim(),
      description: '',
      username: '',
      tags,
      date: '',
    },
    renderpass: [
      { name: 'Image', type: 'image', inputs: [], outputs: [], code: donnees.source },
    ],
  };
}

function serialiser(shader) {
  return `${JSON.stringify(shader, null, 1)}\n`;
}

function lireArguments(argv) {
  const options = { verifier: false, dossier: join(RACINE, 'shaders') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verifier') options.verifier = true;
    else if (arg === '--dossier') {
      i += 1;
      if (i >= argv.length) throw new Error('--dossier attend un chemin.');
      options.dossier = resolve(argv[i]);
    } else throw new Error(`Option inconnue : ${arg}`);
  }
  return options;
}

function principal() {
  let options;
  try {
    options = lireArguments(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const noms = readdirSync(options.dossier)
    .filter((nom) => /\.json$/i.test(nom) && nom !== NOM_MANIFESTE)
    .filter((nom) => statSync(join(options.dossier, nom)).isFile());

  let convertis = 0;
  let ignores = 0;
  let erreursLecture = 0;

  for (const nom of noms) {
    const chemin = join(options.dossier, nom);
    let donnees;
    try {
      donnees = JSON.parse(readFileSync(chemin, 'utf8'));
    } catch (e) {
      erreursLecture += 1;
      console.warn(`${nom} : JSON invalide, ignoré (${e instanceof Error ? e.message : String(e)}).`);
      continue;
    }
    if (!estFormatHerite(donnees)) {
      ignores += 1;
      continue;
    }
    const converti = convertirFormatHerite(donnees);
    if (options.verifier) {
      console.log(`${nom} : « ${donnees.title} » serait converti.`);
    } else {
      writeFileSync(chemin, serialiser(converti));
    }
    convertis += 1;
  }

  const verbe = options.verifier ? 'seraient convertis' : 'convertis';
  console.log(`${convertis} fichier(s) ${verbe}, ${ignores} déjà au format Shadertoy ou non reconnus, ${erreursLecture} illisible(s).`);
  return 0;
}

// N'exécute le script que lorsqu'il est lancé directement (et non importé par les tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = principal();
}
