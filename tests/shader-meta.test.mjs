// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyserFichier, analyserShader, decoderTexte, detecterFormat, extraireShader, sha256Hex } from '../js/shader-meta.js';
import { encoder, passe, shaderMultipasse, shaderSimple } from './fixtures.mjs';

test('sha256Hex : vecteurs connus', () => {
  assert.equal(sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(encoder('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex : identique à node:crypto, y compris autour des limites de bloc', () => {
  for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65537]) {
    const octets = new Uint8Array(randomBytes(n));
    assert.equal(sha256Hex(octets), createHash('sha256').update(octets).digest('hex'), `longueur ${n}`);
  }
});

test('decoderTexte : retire le BOM UTF-8', () => {
  assert.equal(decoderTexte(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), '{}');
});

test('detecterFormat : objet, tableau et enveloppe API', () => {
  const s = shaderSimple();
  assert.deepEqual(detecterFormat(s), { format: 'objet', shaders: [s] });
  assert.deepEqual(detecterFormat({ Shader: s }), { format: 'objet', shaders: [s] });
  assert.equal(detecterFormat([s, shaderMultipasse()]).format, 'tableau');
  assert.equal(detecterFormat([{ Shader: s }]).shaders[0], s);
});

test('detecterFormat : rejette les formats inconnus', () => {
  assert.throws(() => detecterFormat([]), /vide/);
  assert.throws(() => detecterFormat({ foo: 1 }), /non reconnu/);
  assert.throws(() => detecterFormat('texte'), /non reconnu/);
  assert.throws(() => detecterFormat(null), /non reconnu/);
  assert.throws(() => detecterFormat(42), /non reconnu/);
});

test('analyserShader : mono-passe', () => {
  const r = analyserShader(shaderSimple('Titre'), 0, 'f.json');
  assert.equal(r.erreur, null);
  assert.equal(r.titre, 'Titre');
  assert.equal(r.auteur, 'auteur');
  assert.equal(r.id, 'AAAAAA');
  assert.deepEqual(r.passes, ['image']);
  assert.deepEqual(r.tags, ['t1', 't2']);
  assert.equal(r.multipasse, false);
  assert.equal(r.son, false);
});

test('analyserShader : multipasse, son, canaux et médias', () => {
  const r = analyserShader(shaderMultipasse(), 0, 'm.json');
  assert.equal(r.erreur, null);
  assert.deepEqual(r.passes, ['common', 'buffer', 'sound', 'image']);
  assert.equal(r.multipasse, true);
  assert.equal(r.son, true);
  assert.deepEqual(r.canaux, ['buffer', 'keyboard', 'music', 'texture']);
  // Les buffers et le clavier ne sont pas des médias distants.
  assert.deepEqual(r.medias, ['/media/a/musique.mp3', '/media/a/tex.jpg']);
});

test('analyserShader : champs optionnels absents, titre de repli', () => {
  const s = { renderpass: [passe('image')] };
  const r = analyserShader(s, 0, 'mon-shader.json');
  assert.equal(r.erreur, null);
  assert.equal(r.titre, 'mon-shader');
  assert.equal(r.auteur, null);
  assert.equal(r.avertissements.length, 1);
});

test('analyserShader : le type de canal peut être donné par « type » ou « ctype »', () => {
  const s = shaderSimple();
  s.renderpass[0].inputs = [{ channel: 0, type: 'texture', src: '/media/a/x.png' }];
  assert.deepEqual(analyserShader(s, 0, 'f.json').canaux, ['texture']);
});

test('analyserShader : anomalies bloquantes', () => {
  const cas = [
    [null, /objet shader/],
    [{ info: {} }, /Aucune passe/],
    [{ renderpass: [] }, /Aucune passe/],
    [{ renderpass: [42] }, /Passe 1 invalide/],
    [{ renderpass: [passe('inconnue')] }, /type « inconnue » inconnu/],
    [{ renderpass: [passe('image', { code: '' })] }, /code source absent/],
    [{ renderpass: [passe('buffer')] }, /Aucune passe « image »/],
  ];
  for (const [shader, motif] of cas) {
    assert.match(analyserShader(shader, 0, 'f.json').erreur ?? '', motif);
  }
});

test('analyserShader : anomalies tolérées (avertissements)', () => {
  const s = shaderSimple();
  s.renderpass[0].inputs = [
    { channel: 9, ctype: 'texture', src: '/a.png' },
    { channel: 0, ctype: 'hologramme' },
    'x',
  ];
  const r = analyserShader(s, 0, 'f.json');
  assert.equal(r.erreur, null);
  assert.equal(r.avertissements.length, 3);
});

test('analyserFichier : JSON invalide, format inconnu, tableau mixte', () => {
  const invalide = analyserFichier('x.json', encoder('{ pas du json'));
  assert.match(invalide.erreur, /^JSON invalide/);
  assert.equal(invalide.shaders.length, 0);

  const inconnu = analyserFichier('y.json', encoder('{"a":1}'));
  assert.match(inconnu.erreur, /non reconnu/);

  const mixte = analyserFichier('z.json', encoder(JSON.stringify([shaderSimple('Bon'), { renderpass: [] }])));
  assert.equal(mixte.erreur, null);
  assert.equal(mixte.format, 'tableau');
  assert.equal(mixte.shaders.length, 2);
  assert.equal(mixte.shaders[0].erreur, null);
  assert.match(mixte.shaders[1].erreur, /Aucune passe/);
});

test('analyserFichier : taille et empreinte du contenu brut', () => {
  const octets = encoder(JSON.stringify(shaderSimple()));
  const r = analyserFichier('s.json', octets);
  assert.equal(r.taille, octets.length);
  assert.equal(r.empreinte, createHash('sha256').update(octets).digest('hex'));
});

test('extraireShader : sélection par index', () => {
  const doc = [shaderSimple('A'), shaderSimple('B')];
  assert.equal(extraireShader(doc, 1).info.name, 'B');
  assert.throws(() => extraireShader(doc, 2), /introuvable/);
  assert.throws(() => extraireShader(doc, -1), /introuvable/);
});

test('fichier réel du dépôt : mushroomboy3D.json', { skip: !existsSync(fileURLToPath(new URL('../shaders/mushroomboy3D.json', import.meta.url))) }, () => {
  const octets = new Uint8Array(readFileSync(new URL('../shaders/mushroomboy3D.json', import.meta.url)));
  const r = analyserFichier('mushroomboy3D.json', octets);
  assert.equal(r.erreur, null);
  assert.equal(r.shaders.length, 1);
  assert.equal(r.shaders[0].erreur, null);
  assert.deepEqual(r.shaders[0].passes, ['image']);
});
