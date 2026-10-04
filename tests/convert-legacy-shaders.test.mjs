// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { convertirFormatHerite, estFormatHerite } from '../tools/convert-legacy-shaders.mjs';
import { parserShader } from '../js/parser.js';
import { shaderSimple } from './fixtures.mjs';

const OUTIL = fileURLToPath(new URL('../tools/convert-legacy-shaders.mjs', import.meta.url));

function lancer(dossier, ...options) {
  return spawnSync(process.execPath, [OUTIL, '--dossier', dossier, ...options], { encoding: 'utf8' });
}

// --- estFormatHerite ---------------------------------------------------

test('estFormatHerite : reconnaît le schéma num/title/category/file/unsupported/source', () => {
  assert.equal(estFormatHerite({ num: '1', title: 'T', category: 'c', file: 'x', unsupported: false, source: 'code' }), true);
});

test('estFormatHerite : un export Shadertoy (clé renderpass) n\'est jamais reconnu, même avec des champs similaires', () => {
  assert.equal(estFormatHerite({ title: 'T', source: 'code', renderpass: [] }), false);
});

test('estFormatHerite : title ou source absent, manquant ou vide, non reconnu', () => {
  assert.equal(estFormatHerite({ source: 'code' }), false);
  assert.equal(estFormatHerite({ title: 'T' }), false);
  assert.equal(estFormatHerite({ title: 'T', source: '' }), false);
  assert.equal(estFormatHerite({ title: 'T', source: '   ' }), false);
  assert.equal(estFormatHerite({ title: 123, source: 'code' }), false);
});

test('estFormatHerite : valeur non-objet ou tableau, non reconnu', () => {
  assert.equal(estFormatHerite(null), false);
  assert.equal(estFormatHerite('texte'), false);
  assert.equal(estFormatHerite([{ title: 'T', source: 'code' }]), false);
  assert.equal(estFormatHerite(42), false);
});

// --- convertirFormatHerite -----------------------------------------------

test('convertirFormatHerite : produit un export Shadertoy minimal valide, parsable sans avertissement', () => {
  const herite = { num: '360', title: 'Water 360', category: 'water', file: 'water/360.glsl', unsupported: false, source: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }' };
  const converti = convertirFormatHerite(herite);
  assert.equal(converti.ver, '0.1');
  assert.equal(converti.info.name, 'Water 360');
  assert.deepEqual(converti.info.tags, ['water']);
  assert.equal(converti.info.id, 'water-360');
  assert.equal(converti.renderpass.length, 1);
  assert.equal(converti.renderpass[0].type, 'image');
  assert.equal(converti.renderpass[0].code, herite.source);
  assert.deepEqual(converti.renderpass[0].inputs, []);

  const r = parserShader(converti, 'water-360.json');
  assert.equal(r.avertissements.length, 0);
  assert.equal(r.image.type, 'image');
});

test('convertirFormatHerite : titre avec espaces superflus, nettoyé', () => {
  const converti = convertirFormatHerite({ title: '  Mon Titre  ', source: 'x', category: 'c', num: 1 });
  assert.equal(converti.info.name, 'Mon Titre');
});

test('convertirFormatHerite : category absente ou vide, aucun tag', () => {
  assert.deepEqual(convertirFormatHerite({ title: 'T', source: 'x' }).info.tags, []);
  assert.deepEqual(convertirFormatHerite({ title: 'T', source: 'x', category: '' }).info.tags, []);
});

test('convertirFormatHerite : num/category absents, id null', () => {
  assert.equal(convertirFormatHerite({ title: 'T', source: 'x' }).info.id, null);
});

test('convertirFormatHerite : num numérique accepté (pas seulement une chaîne)', () => {
  assert.equal(convertirFormatHerite({ title: 'T', source: 'x', category: 'water', num: 42 }).info.id, 'water-42');
});

// --- CLI -----------------------------------------------------------------

function dossierTemporaire() {
  const dossier = mkdtempSync(join(tmpdir(), 'shaderview-legacy-'));
  writeFileSync(join(dossier, 'legacy.json'), JSON.stringify({
    num: '1', title: 'Legacy', category: 'test', file: 'x', unsupported: false,
    source: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }',
  }));
  writeFileSync(join(dossier, 'deja-shadertoy.json'), JSON.stringify(shaderSimple('DejaShadertoy')));
  writeFileSync(join(dossier, 'casse.json'), '{ pas du json');
  writeFileSync(join(dossier, 'manifest.json'), '{"version":1,"fichiers":[],"media":[]}');
  return dossier;
}

test('CLI : --verifier ne modifie aucun fichier', () => {
  const dossier = dossierTemporaire();
  try {
    const avant = readFileSync(join(dossier, 'legacy.json'), 'utf8');
    const resultat = lancer(dossier, '--verifier');
    assert.equal(resultat.status, 0);
    assert.match(resultat.stdout, /1 fichier\(s\) seraient convertis/);
    assert.equal(readFileSync(join(dossier, 'legacy.json'), 'utf8'), avant);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('CLI : convertit le fichier hérité, laisse l\'export Shadertoy et manifest.json intacts', () => {
  const dossier = dossierTemporaire();
  try {
    const avantShadertoy = readFileSync(join(dossier, 'deja-shadertoy.json'), 'utf8');
    const avantManifeste = readFileSync(join(dossier, 'manifest.json'), 'utf8');
    const resultat = lancer(dossier);
    assert.equal(resultat.status, 0);
    assert.match(resultat.stdout, /1 fichier\(s\) convertis/);

    const converti = JSON.parse(readFileSync(join(dossier, 'legacy.json'), 'utf8'));
    assert.ok('renderpass' in converti);
    assert.equal(converti.info.name, 'Legacy');

    assert.equal(readFileSync(join(dossier, 'deja-shadertoy.json'), 'utf8'), avantShadertoy);
    assert.equal(readFileSync(join(dossier, 'manifest.json'), 'utf8'), avantManifeste);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('CLI : un fichier JSON invalide est signalé, ignoré, jamais écrasé', () => {
  const dossier = dossierTemporaire();
  try {
    const avant = readFileSync(join(dossier, 'casse.json'), 'utf8');
    const resultat = lancer(dossier);
    assert.equal(resultat.status, 0);
    assert.match(resultat.stderr, /casse\.json : JSON invalide/);
    assert.equal(readFileSync(join(dossier, 'casse.json'), 'utf8'), avant);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('CLI : relancer sur un dossier déjà converti ne reconvertit rien (idempotent)', () => {
  const dossier = dossierTemporaire();
  try {
    lancer(dossier);
    const apresPremiereConversion = readFileSync(join(dossier, 'legacy.json'), 'utf8');
    const resultat = lancer(dossier);
    assert.match(resultat.stdout, /0 fichier\(s\) convertis/);
    assert.equal(readFileSync(join(dossier, 'legacy.json'), 'utf8'), apresPremiereConversion);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('CLI : arguments invalides et dossier introuvable', () => {
  assert.equal(spawnSync(process.execPath, [OUTIL, '--inconnue'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [OUTIL, '--dossier'], { encoding: 'utf8' }).status, 2);
  assert.notEqual(lancer(join(tmpdir(), 'shaderview-legacy-inexistant-xyz')).status, 0);
});
