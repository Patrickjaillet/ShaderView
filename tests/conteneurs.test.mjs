// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyserMp4, analyserWebm } from '../tools/lib/conteneurs.mjs';

function boite(type, ...contenus) {
  const corps = Buffer.concat(contenus);
  const entete = Buffer.alloc(8);
  entete.writeUInt32BE(8 + corps.length, 0);
  entete.write(type, 4, 'latin1');
  return Buffer.concat([entete, corps]);
}

function mvhd(echelle, duree) {
  const c = Buffer.alloc(100);
  c.writeUInt32BE(echelle, 12);
  c.writeUInt32BE(duree, 16);
  return boite('mvhd', c);
}

const octets = (b) => new Uint8Array(b);

test('analyserMp4 : fichier bien formé, moov avant mdat (faststart), une piste, durée lue', () => {
  const fichier = Buffer.concat([boite('ftyp', Buffer.from('isom')), boite('moov', mvhd(1000, 2500), boite('trak')), boite('mdat', Buffer.alloc(10))]);
  const r = analyserMp4(octets(fichier));
  assert.deepEqual(r.erreurs, []);
  assert.deepEqual(r.boites.map((b) => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(r.moovAvantMdat, true);
  assert.equal(r.pistes, 1);
  assert.equal(r.echelleTemps, 1000);
  assert.equal(r.duree, 2500);
  assert.equal(r.tailleCoherente, true);
});

test('analyserMp4 : moov après mdat signalé, boîtes manquantes et fichier tronqué détectés', () => {
  const apres = analyserMp4(octets(Buffer.concat([boite('ftyp'), boite('mdat'), boite('moov', mvhd(1, 1))])));
  assert.equal(apres.moovAvantMdat, false);
  const sansMoov = analyserMp4(octets(Buffer.concat([boite('ftyp'), boite('mdat')])));
  assert.ok(sansMoov.erreurs.some((e) => /moov/.test(e)));
  const complet = Buffer.concat([boite('ftyp'), boite('moov', mvhd(1, 1)), boite('mdat', Buffer.alloc(50))]);
  const tronque = analyserMp4(octets(complet.subarray(0, complet.length - 20)));
  assert.equal(tronque.tailleCoherente, false);
  assert.ok(tronque.erreurs.length > 0);
  const mauvaisDebut = analyserMp4(octets(Buffer.concat([boite('free'), boite('moov', mvhd(1, 1)), boite('mdat')])));
  assert.ok(mauvaisDebut.erreurs.some((e) => /ftyp/.test(e)));
});

function element(idHex, ...contenus) {
  const corps = Buffer.concat(contenus);
  assert.ok(corps.length < 127);
  return Buffer.concat([Buffer.from(idHex, 'hex'), Buffer.from([0x80 | corps.length]), corps]);
}

test('analyserWebm : en-tête, segment, Info, Tracks, Clusters, Cues et SeekHead reconnus', () => {
  const segment = element('18538067', element('114d9b74'), element('1549a966'), element('1654ae6b'), element('1f43b675'), element('1f43b675'), element('1c53bb6b'));
  const r = analyserWebm(octets(Buffer.concat([element('1a45dfa3'), segment])));
  assert.deepEqual(r.erreurs, []);
  assert.equal(r.enteteEbml && r.segment && r.info && r.pistes && r.cues && r.seekHead, true);
  assert.equal(r.clusters, 2);
  assert.equal(r.tailleCoherente, true);
});

test('analyserWebm : segment à taille inconnue accepté, fichier sans EBML ou sans cluster refusé', () => {
  const inconnue = Buffer.concat([Buffer.from('18538067', 'hex'), Buffer.from([0xff]), element('1549a966'), element('1654ae6b'), element('1f43b675')]);
  const r = analyserWebm(octets(Buffer.concat([element('1a45dfa3'), inconnue])));
  assert.equal(r.tailleCoherente, true);
  assert.equal(r.clusters, 1);
  assert.ok(analyserWebm(octets(Buffer.from('pas un webm'))).erreurs.length > 0);
  const sansCluster = analyserWebm(octets(Buffer.concat([element('1a45dfa3'), element('18538067', element('1549a966'), element('1654ae6b'))])));
  assert.ok(sansCluster.erreurs.some((e) => /Cluster/.test(e)));
});

test('analyserWebm : élément qui déborde son conteneur détecté', () => {
  const segment = element('18538067', element('1549a966'), element('1654ae6b'));
  const tronque = segment.subarray(0, segment.length - 2);
  const r = analyserWebm(octets(Buffer.concat([element('1a45dfa3'), tronque])));
  assert.equal(r.tailleCoherente, false);
});
