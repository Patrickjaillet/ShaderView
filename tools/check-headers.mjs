#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Vérifie que chaque fichier source du dépôt porte l'en-tête SPDX attendu.
//
// Usage :
//   node tools/check-headers.mjs            contrôle tous les fichiers sources
//   node tools/check-headers.mjs --staged   contrôle uniquement les fichiers indexés par Git
//
// Code de sortie : 0 si tous les fichiers sont conformes, 1 sinon.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.svg']);
const DOSSIERS_EXCLUS = new Set(['.git', 'node_modules', 'dist', 'vendor', 'shaders']);
const MARQUEUR = 'SPDX-License-Identifier: GPL-3.0-or-later';
const COPYRIGHT = '© 2026 SANDEFJORD / Patrick JAILLET';
const MENTION = 'Distribué sous licence GPL-3.0-or-later';
const LIGNES_EXAMINEES = 12;

function extension(chemin) {
  const i = chemin.lastIndexOf('.');
  return i === -1 ? '' : chemin.slice(i).toLowerCase();
}

function estExclu(cheminRelatif) {
  return cheminRelatif.split(sep).some((segment) => DOSSIERS_EXCLUS.has(segment));
}

function parcourir(dossier, resultat) {
  for (const nom of readdirSync(dossier)) {
    const chemin = join(dossier, nom);
    const rel = relative(RACINE, chemin);
    if (estExclu(rel)) continue;
    if (statSync(chemin).isDirectory()) parcourir(chemin, resultat);
    else if (EXTENSIONS.has(extension(nom))) resultat.push(rel);
  }
  return resultat;
}

function fichiersIndexes() {
  const sortie = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'],
    { cwd: RACINE, encoding: 'utf8' },
  );
  return sortie
    .split('\0')
    .filter((rel) => rel && EXTENSIONS.has(extension(rel)) && !estExclu(rel));
}

function verifier(rel) {
  const contenu = readFileSync(join(RACINE, rel), 'utf8');
  const debut = contenu.split('\n', LIGNES_EXAMINEES).join('\n');
  const manques = [];
  if (!debut.includes(MARQUEUR)) manques.push('identifiant SPDX');
  if (!debut.includes(COPYRIGHT)) manques.push('copyright');
  if (!debut.includes(MENTION)) manques.push('mention de licence');
  return manques;
}

const modeIndex = process.argv.includes('--staged');
const fichiers = modeIndex ? fichiersIndexes() : parcourir(RACINE, []);
let erreurs = 0;

for (const rel of fichiers) {
  const manques = verifier(rel);
  if (manques.length > 0) {
    erreurs += 1;
    console.error(`${rel} : en-tête incomplet (${manques.join(', ')})`);
  }
}

if (erreurs > 0) {
  console.error(`\n${erreurs} fichier(s) non conforme(s) sur ${fichiers.length}.`);
  console.error('Modèles : tools/headers/');
  process.exit(1);
}
console.log(`En-têtes conformes : ${fichiers.length} fichier(s) vérifié(s).`);
