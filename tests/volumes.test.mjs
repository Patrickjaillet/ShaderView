// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decoderVolume, genererVolumeSubstitue } from '../js/media.js';

// Construit un fichier volume .bin : signature, [type], dimensions, canaux, disposition, format, données.
function fabriquerBin({ x, y, z, canaux, format = 0, avecType = false, donnees }) {
  const entete = Buffer.alloc(avecType ? 24 : 20);
  entete.writeUInt32LE(0x004e4942, 0);
  let decalage = 4;
  if (avecType) { entete.writeUInt32LE(0, decalage); decalage += 4; }
  entete.writeUInt32LE(x, decalage);
  entete.writeUInt32LE(y, decalage + 4);
  entete.writeUInt32LE(z, decalage + 8);
  entete.writeUInt8(canaux, decalage + 12);
  entete.writeUInt8(0, decalage + 13);
  entete.writeUInt16LE(format, decalage + 14);
  return new Uint8Array(Buffer.concat([entete, Buffer.from(donnees.buffer ?? donnees, donnees.byteOffset ?? 0, donnees.byteLength)]));
}

test('decoderVolume : en-tête de 20 octets, un canal 8 bits', () => {
  const donnees = Uint8Array.from({ length: 2 * 3 * 4 }, (_, i) => i);
  const volume = decoderVolume(fabriquerBin({ x: 2, y: 3, z: 4, canaux: 1, donnees }));
  assert.deepEqual([volume.largeur, volume.hauteur, volume.profondeur, volume.canaux, volume.flottant], [2, 3, 4, 1, false]);
  assert.deepEqual([...volume.octets], [...donnees]);
});

test('decoderVolume : en-tête de 24 octets (avec type), quatre canaux 8 bits', () => {
  const donnees = Uint8Array.from({ length: 2 * 2 * 2 * 4 }, (_, i) => 255 - i);
  const volume = decoderVolume(fabriquerBin({ x: 2, y: 2, z: 2, canaux: 4, avecType: true, donnees }));
  assert.deepEqual([volume.largeur, volume.hauteur, volume.profondeur, volume.canaux], [2, 2, 2, 4]);
  assert.deepEqual([...volume.octets], [...donnees]);
});

test('decoderVolume : trois canaux complétés en RGBA avec un alpha opaque', () => {
  const donnees = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const volume = decoderVolume(fabriquerBin({ x: 2, y: 1, z: 1, canaux: 3, donnees }));
  assert.equal(volume.canaux, 4);
  assert.deepEqual([...volume.octets], [1, 2, 3, 255, 4, 5, 6, 255]);
});

test('decoderVolume : composantes flottantes 32 bits', () => {
  const donnees = new Float32Array([0.25, 0.5, 0.75, 1]);
  const volume = decoderVolume(fabriquerBin({ x: 2, y: 2, z: 1, canaux: 1, format: 10, donnees }));
  assert.equal(volume.flottant, true);
  assert.ok(volume.octets instanceof Float32Array);
  assert.deepEqual([...volume.octets], [0.25, 0.5, 0.75, 1]);
});

test('decoderVolume : trois canaux flottants complétés avec un alpha de 1', () => {
  const donnees = new Float32Array([0.1, 0.2, 0.3]);
  const volume = decoderVolume(fabriquerBin({ x: 1, y: 1, z: 1, canaux: 3, format: 10, donnees }));
  assert.equal(volume.canaux, 4);
  assert.equal(volume.octets.length, 4);
  assert.equal(volume.octets[3], 1);
  assert.ok(Math.abs(volume.octets[0] - 0.1) < 1e-6);
});

test('decoderVolume : refuse une taille de données incohérente, un format inconnu et un fichier trop court', () => {
  assert.throws(() => decoderVolume(fabriquerBin({ x: 2, y: 2, z: 2, canaux: 1, donnees: new Uint8Array(7) })), /non reconnu/);
  assert.throws(() => decoderVolume(fabriquerBin({ x: 2, y: 2, z: 2, canaux: 1, format: 7, donnees: new Uint8Array(8) })), /non reconnu/);
  assert.throws(() => decoderVolume(new Uint8Array(10)), /non reconnu/);
  assert.throws(() => decoderVolume(fabriquerBin({ x: 0, y: 2, z: 2, canaux: 1, donnees: new Uint8Array(0) })), /non reconnu/);
});

test('decoderVolume : accepte une vue sur un tampon partagé (décalage non nul)', () => {
  const fichier = fabriquerBin({ x: 2, y: 1, z: 1, canaux: 1, donnees: Uint8Array.from([9, 8]) });
  const partage = new Uint8Array(fichier.length + 5);
  partage.set(fichier, 5);
  assert.deepEqual([...decoderVolume(partage.subarray(5)).octets], [9, 8]);
});

test('genererVolumeSubstitue : cube RGBA déterministe, différent selon la source', () => {
  const a = genererVolumeSubstitue('/media/a/x.bin');
  assert.deepEqual([a.largeur, a.hauteur, a.profondeur, a.canaux, a.flottant], [32, 32, 32, 4, false]);
  assert.equal(a.octets.length, 32 * 32 * 32 * 4);
  assert.deepEqual([...a.octets.subarray(0, 64)], [...genererVolumeSubstitue('/media/a/x.bin').octets.subarray(0, 64)]);
  assert.notDeepEqual([...a.octets.subarray(0, 64)], [...genererVolumeSubstitue('/media/a/y.bin').octets.subarray(0, 64)]);
  assert.equal(genererVolumeSubstitue('x', 4).octets.length, 4 * 4 * 4 * 4);
});
