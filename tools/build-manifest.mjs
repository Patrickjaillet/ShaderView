#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Génère shaders/manifest.json : le catalogue des fichiers .json du dossier shaders/.
//
// Une page statique ne peut pas lister un dossier du serveur ; le catalogue est donc
// établi avant publication. Chaque fichier est lu, validé et décrit (nom, taille,
// empreinte SHA-256, titre, auteur, types de passes, présence de son, médias référencés).
// Un fichier invalide n'interrompt pas la génération : son erreur est consignée dans
// le manifeste et affichée dans l'inspecteur.
//
// Usage :
//   node tools/build-manifest.mjs                 écrit shaders/manifest.json
//   node tools/build-manifest.mjs --check         échoue si le manifeste n'est pas à jour
//   node tools/build-manifest.mjs --strict        échoue si un fichier contient une erreur
//   node tools/build-manifest.mjs --dossier <d>   cible un autre dossier que shaders/
//
// Le manifeste est déterministe (ordre alphabétique, aucune date) : une régénération
// sans changement de contenu ne produit aucune modification.

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

/**
 * Construit le manifeste d'un dossier.
 * @param {string} dossier chemin absolu du dossier à analyser (non récursif)
 * @returns {{ version: number, fichiers: object[] }}
 */
export function construireManifeste(dossier) {
  const noms = readdirSync(dossier)
    .filter((nom) => /\.json$/i.test(nom) && nom !== NOM_MANIFESTE)
    .filter((nom) => statSync(join(dossier, nom)).isFile())
    .sort(comparer);
  const fichiers = noms.map((nom) => analyserFichier(nom, new Uint8Array(readFileSync(join(dossier, nom)))));
  return { version: VERSION_MANIFESTE, fichiers };
}

export function serialiser(manifeste) {
  return `${JSON.stringify(manifeste, null, 2)}\n`;
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

  if (options.check) {
    const actuel = existsSync(cible) ? readFileSync(cible, 'utf8') : null;
    if (actuel !== texte) {
      console.error(`${NOM_MANIFESTE} absent ou périmé : relancer « node tools/build-manifest.mjs ».`);
      return 1;
    }
    console.log(`${NOM_MANIFESTE} à jour (${manifeste.fichiers.length} fichier(s), ${nbShaders} shader(s)).`);
  } else {
    const identique = existsSync(cible) && readFileSync(cible, 'utf8') === texte;
    if (!identique) writeFileSync(cible, texte);
    console.log(
      `${NOM_MANIFESTE} ${identique ? 'inchangé' : 'écrit'} : ${manifeste.fichiers.length} fichier(s), ` +
      `${nbShaders} shader(s), ${enErreur.length} fichier(s) en erreur.`,
    );
  }

  return options.strict && enErreur.length > 0 ? 1 : 0;
}

// N'exécute le script que lorsqu'il est lancé directement (et non importé par les tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = principal();
}
