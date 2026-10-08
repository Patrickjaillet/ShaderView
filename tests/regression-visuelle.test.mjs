// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Outils du banc de régression visuelle (décodage PNG, comparaison) et cohérence du corpus. Le rendu lui-même
// exige un navigateur : `node tools/regression-visuelle.mjs`.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { comparerImages, imageVariee } from '../tools/lib/comparaison.mjs';
import { decoderPng } from '../tools/lib/png.mjs';
import { listerCatalogue, listerCorpus } from '../tools/regression-visuelle.mjs';
import { parserShader } from '../js/parser.js';

const RACINE = fileURLToPath(new URL('..', import.meta.url));

function crc32(tampon) {
  let c;
  let crc = 0xffffffff;
  for (const octet of tampon) {
    c = (crc ^ octet) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function morceau(type, donnees) {
  const entete = Buffer.alloc(8);
  entete.writeUInt32BE(donnees.length, 0);
  entete.write(type, 4, 'latin1');
  const fin = Buffer.alloc(4);
  fin.writeUInt32BE(crc32(Buffer.concat([entete.subarray(4), donnees])), 0);
  return Buffer.concat([entete, donnees, fin]);
}

// Encode un PNG 8 bits : `lignes` = tableaux d'octets déjà filtrés (octet de filtre en tête de chaque ligne).
function fabriquerPng(largeur, hauteur, typeCouleur, lignesFiltrees) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8;
  ihdr[9] = typeCouleur;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    morceau('IHDR', ihdr),
    morceau('IDAT', deflateSync(Buffer.from(lignesFiltrees.flat()))),
    morceau('IEND', Buffer.alloc(0)),
  ]);
}

test('decoderPng : RVBA sans filtre', () => {
  const png = fabriquerPng(2, 1, 6, [[0, 10, 20, 30, 40, 50, 60, 70, 80]]);
  const image = decoderPng(png);
  assert.deepEqual([image.largeur, image.hauteur], [2, 1]);
  assert.deepEqual([...image.rgba], [10, 20, 30, 40, 50, 60, 70, 80]);
});

test('decoderPng : les cinq filtres (aucun, Sub, Up, Average, Paeth) sur du RVB', () => {
  // Image 2 × 5 en RVB ; chaque ligne utilise un filtre différent et reconstitue les mêmes pixels attendus.
  const pixels = [[10, 20, 30, 40, 50, 60], [15, 25, 35, 45, 55, 65], [20, 30, 40, 50, 60, 70], [25, 35, 45, 55, 65, 75], [30, 40, 50, 60, 70, 80]];
  const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c); };
  const lignes = pixels.map((ligne, y) => {
    const haut = y > 0 ? pixels[y - 1] : [0, 0, 0, 0, 0, 0];
    const filtre = y;
    return [filtre, ...ligne.map((v, i) => {
      const gauche = i >= 3 ? ligne[i - 3] : 0;
      const hautGauche = y > 0 && i >= 3 ? haut[i - 3] : 0;
      const predit = [0, gauche, haut[i], (gauche + haut[i]) >> 1, paeth(gauche, haut[i], hautGauche)][filtre];
      return (v - predit) & 0xff;
    })];
  });
  const image = decoderPng(fabriquerPng(2, 5, 2, lignes));
  const attendu = pixels.flatMap((l) => [l[0], l[1], l[2], 255, l[3], l[4], l[5], 255]);
  assert.deepEqual([...image.rgba], attendu);
});

test('decoderPng : niveaux de gris et gris + alpha', () => {
  assert.deepEqual([...decoderPng(fabriquerPng(1, 1, 0, [[0, 77]])).rgba], [77, 77, 77, 255]);
  assert.deepEqual([...decoderPng(fabriquerPng(1, 1, 4, [[0, 77, 12]])).rgba], [77, 77, 77, 12]);
});

test('decoderPng : refuse une signature invalide, un format non géré et des données tronquées', () => {
  assert.throws(() => decoderPng(Buffer.from('pas un png')), /signature/);
  const interlace = fabriquerPng(1, 1, 6, [[0, 1, 2, 3, 4]]);
  interlace[28] = 1; // octet d'entrelacement de l'IHDR
  assert.throws(() => decoderPng(interlace), /entrelacée/);
  assert.throws(() => decoderPng(fabriquerPng(2, 2, 6, [[0, 1, 2, 3, 4, 5, 6, 7, 8]])), /incohérente/);
});

const image = (largeur, hauteur, remplissage) => ({ largeur, hauteur, rgba: Uint8Array.from({ length: largeur * hauteur * 4 }, (_, i) => remplissage(i)) });

test('comparerImages : identiques, écart sous la tolérance, écart réel et dimensions différentes', () => {
  const a = image(10, 10, () => 100);
  assert.equal(comparerImages(a, image(10, 10, () => 100)).identiques, true);
  assert.equal(comparerImages(a, image(10, 10, () => 105)).identiques, true, 'écart de 5 sous la tolérance de 8');
  const b = comparerImages(a, image(10, 10, () => 120));
  assert.equal(b.identiques, false);
  assert.equal(b.ecartMax, 20);
  assert.equal(b.partDifferente, 1);
  const c = comparerImages(a, image(10, 5, () => 100));
  assert.equal(c.identiques, false);
  assert.match(c.raison, /dimensions/);
});

test('comparerImages : une petite part de pixels différents reste tolérée sous partMax', () => {
  const a = image(100, 100, () => 0);
  const b = image(100, 100, (i) => (i < 4 * 20 ? 255 : 0)); // 20 pixels sur 10 000 = 0,2 %
  assert.equal(comparerImages(a, b).identiques, true);
  assert.equal(comparerImages(a, b, { partMax: 0.001 }).identiques, false);
});

test('imageVariee : détecte une couleur unie', () => {
  assert.equal(imageVariee(image(4, 4, () => 0)), false);
  assert.equal(imageVariee(image(4, 4, (i) => (i === 40 ? 9 : 0))), true);
});

test('corpus : chaque entrée est un shader valide, nommé de façon unique, avec sa référence PNG', () => {
  const entrees = listerCorpus(RACINE);
  assert.ok(entrees.length >= 30, `${entrees.length} entrées`);
  const noms = new Set();
  for (const { nom, shader, options } of entrees) {
    assert.ok(!noms.has(nom), `nom en double : ${nom}`);
    noms.add(nom);
    assert.doesNotThrow(() => parserShader(shader), nom);
    assert.ok(options.temps === undefined || options.temps >= 0, nom);
    assert.ok(existsSync(join(RACINE, 'tests', 'references', `${nom}.png`)), `référence absente : ${nom}`);
  }
});

test('corpus : les références sont des PNG décodables de dimensions identiques et non unis', () => {
  const dimensions = new Set();
  for (const { nom } of listerCorpus(RACINE)) {
    const decodee = decoderPng(readFileSync(join(RACINE, 'tests', 'references', `${nom}.png`)));
    dimensions.add(`${decodee.largeur}×${decodee.hauteur}`);
    assert.ok(imageVariee(decodee), `référence unie : ${nom}`);
  }
  assert.equal(dimensions.size, 1, [...dimensions].join(', '));
});

test('corpus : couvre les fonctionnalités de la phase 13 (volume, cubemap, mipmap, rétroaction, ES 1.00, mainVR)', () => {
  const noms = listerCorpus(RACINE).map((e) => e.nom);
  for (const attendu of ['volume-3d', 'volume-lod', 'cubemap-statique', 'cubemap-passe', 'cubemap-passe-mipmap', 'buffer-mipmap',
    'buffer-retroaction', 'filtres-echantillonnage', 'glsl-es1-historique', 'main-vr-ignore', 'texel-fetch', 'derivees', 'clavier']) {
    assert.ok(noms.includes(attendu), `corpus : « ${attendu} » absent`);
  }
});

test('catalogue : les fichiers cités par le corpus existent dans shaders/ et listerCatalogue les voit', () => {
  const liste = JSON.parse(readFileSync(join(RACINE, 'tests', 'corpus', 'catalogue.json'), 'utf8')).fichiers;
  assert.ok(liste.length > 0);
  for (const { fichier } of liste) assert.ok(existsSync(join(RACINE, 'shaders', fichier)), fichier);
  assert.ok(listerCatalogue(RACINE).length >= 400);
});
