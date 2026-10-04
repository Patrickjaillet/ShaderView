#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Inline branding/favicon.svg en data URI dans index.html.
// Le lien est délimité par les commentaires « favicon:début » et « favicon:fin » ;
// le script est idempotent et peut être relancé après toute modification de l'icône.
//
// Usage : node tools/inline-favicon.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(RACINE, 'branding', 'favicon.svg');
const PAGE = join(RACINE, 'index.html');

// Réduit le SVG à l'essentiel (sans prologue XML, commentaires ni espaces superflus).
function minifier(svg) {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
}

// Encode en pourcentage les seuls caractères qui posent problème dans un attribut HTML
// délimité par des guillemets doubles et dans une URI.
function encoder(svg) {
  return svg
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/"/g, "'")
    .replace(/\s{2,}/g, ' ');
}

const svg = minifier(readFileSync(SOURCE, 'utf8'));
const uri = `data:image/svg+xml,${encoder(svg)}`;
const lien = `<link rel="icon" type="image/svg+xml" href="${uri}">`;

const page = readFileSync(PAGE, 'utf8');
const motif = /(<!-- favicon:début -->)[\s\S]*?(<!-- favicon:fin -->)/;
if (!motif.test(page)) {
  console.error('Marqueurs « favicon:début » / « favicon:fin » introuvables dans index.html.');
  process.exit(1);
}
const resultat = page.replace(motif, (_, debut, fin) => `${debut}\n  ${lien}\n  ${fin}`);
if (resultat === page) {
  console.log('Favicon déjà à jour dans index.html.');
} else {
  writeFileSync(PAGE, resultat);
  console.log(`Favicon inliné dans index.html (${uri.length} caractères).`);
}
