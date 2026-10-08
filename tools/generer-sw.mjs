#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Génère la liste des fichiers de la coque de l'application et sa version dans sw.js (entre les marqueurs « généré »).
// La version est une empreinte du contenu de la coque : elle change dès qu'un fichier change, ce qui renouvelle le cache
// du Service Worker. Les fins de ligne sont normalisées avant le calcul pour que l'empreinte soit la même sous Windows
// (CRLF) et sous Linux (LF).
//
// Usage :
//   node tools/generer-sw.mjs           réécrit le bloc généré de sw.js
//   node tools/generer-sw.mjs --check   échoue (code 1) si sw.js n'est pas à jour
// À lancer avant chaque publication ; `node tools/build.mjs` effectue le contrôle.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const DEBUT = '// <généré>';
const FIN = '// </généré>';

// Fichiers isolés de la coque (le reste vient des dossiers css/ et js/, et des icônes de branding/).
const FICHIERS_FIXES = ['index.html', 'manifest.webmanifest', 'branding/favicon.svg'];
const DOSSIERS = ['css', 'js'];
const EXTENSIONS_TEXTE = new Set(['.html', '.css', '.js', '.json', '.svg', '.webmanifest']);

function parcourir(dossier, sortie = []) {
  if (!existsSync(dossier)) return sortie;
  for (const nom of readdirSync(dossier).sort()) {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) parcourir(chemin, sortie);
    else sortie.push(chemin);
  }
  return sortie;
}

/**
 * Chemins (relatifs à la racine, séparateur « / », triés) des fichiers de la coque : page, manifeste d'application, icônes,
 * feuilles de style et scripts. Les shaders, médias, outils et tests n'en font pas partie.
 * @param {string} [racine]
 * @returns {string[]}
 */
export function listerCoque(racine = RACINE) {
  const relatifs = (chemin) => relative(racine, chemin).split(sep).join('/');
  const icones = parcourir(join(racine, 'branding')).map(relatifs).filter((f) => /\.(png|svg)$/.test(f));
  const fichiers = new Set([...FICHIERS_FIXES, ...icones]);
  for (const dossier of DOSSIERS) for (const chemin of parcourir(join(racine, dossier))) fichiers.add(relatifs(chemin));
  return [...fichiers].filter((f) => existsSync(join(racine, f))).sort();
}

/**
 * Empreinte (12 caractères hexadécimaux) du contenu de la coque.
 * @param {string} racine
 * @param {string[]} fichiers
 * @returns {string}
 */
export function calculerVersion(racine, fichiers) {
  const hachage = createHash('sha256');
  for (const fichier of fichiers) {
    const extension = fichier.slice(fichier.lastIndexOf('.'));
    let contenu = readFileSync(join(racine, fichier));
    if (EXTENSIONS_TEXTE.has(extension)) contenu = Buffer.from(contenu.toString('utf8').replace(/\r\n/g, '\n'));
    hachage.update(fichier).update('\0').update(contenu).update('\0');
  }
  return hachage.digest('hex').slice(0, 12);
}

/**
 * Bloc de code généré (de marqueur à marqueur).
 * @param {string} version
 * @param {string[]} fichiers
 * @returns {string}
 */
export function genererBloc(version, fichiers) {
  const liste = ['./', ...fichiers].map((f) => `  '${f}',`).join('\n');
  return `${DEBUT}\nconst VERSION = '${version}';\nconst COQUE = [\n${liste}\n];\n${FIN}`;
}

/**
 * Calcule le contenu attendu de sw.js.
 * @param {string} source contenu actuel de sw.js
 * @param {string} racine
 * @returns {string}
 */
export function contenuAttendu(source, racine = RACINE) {
  const normalise = source.replace(/\r\n/g, '\n');
  const debut = normalise.indexOf(DEBUT);
  const fin = normalise.indexOf(FIN);
  if (debut === -1 || fin === -1 || fin < debut) throw new Error('Marqueurs « généré » introuvables dans sw.js.');
  const fichiers = listerCoque(racine);
  return normalise.slice(0, debut) + genererBloc(calculerVersion(racine, fichiers), fichiers) + normalise.slice(fin + FIN.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const chemin = join(RACINE, 'sw.js');
  const actuel = readFileSync(chemin, 'utf8');
  const crlf = actuel.includes('\r\n');
  const attendu = contenuAttendu(actuel);
  const attenduFormate = crlf ? attendu.replace(/\n/g, '\r\n') : attendu;
  if (process.argv.includes('--check')) {
    if (actuel.replace(/\r\n/g, '\n') !== attendu) {
      console.error('sw.js n’est pas à jour : lancer « node tools/generer-sw.mjs ».');
      process.exit(1);
    }
    console.log('sw.js : coque et version à jour.');
  } else {
    writeFileSync(chemin, attenduFormate);
    console.log(`sw.js mis à jour : version ${attendu.match(/const VERSION = '([^']+)'/)[1]}, ${listerCoque().length + 1} entrées.`);
  }
}
