// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { construireManifeste, serialiser } from '../tools/build-manifest.mjs';
import { shaderMultipasse, shaderSimple } from './fixtures.mjs';

const OUTIL = fileURLToPath(new URL('../tools/build-manifest.mjs', import.meta.url));

function dossierTemporaire() {
  const dossier = mkdtempSync(join(tmpdir(), 'shaderview-'));
  writeFileSync(join(dossier, 'b.json'), JSON.stringify(shaderMultipasse()));
  writeFileSync(join(dossier, 'a.json'), JSON.stringify(shaderSimple('A')));
  writeFileSync(join(dossier, 'casse.json'), '{ pas du json');
  writeFileSync(join(dossier, 'notes.txt'), 'ignoré');
  mkdirSync(join(dossier, 'media'));
  writeFileSync(join(dossier, 'media', 'x.json'), JSON.stringify(shaderSimple('Sous-dossier')));
  return dossier;
}

function lancer(dossier, ...options) {
  return spawnSync(process.execPath, [OUTIL, '--dossier', dossier, ...options], { encoding: 'utf8' });
}

test('construireManifeste : ordre alphabétique, non récursif, erreurs consignées', () => {
  const dossier = dossierTemporaire();
  try {
    const manifeste = construireManifeste(dossier);
    assert.equal(manifeste.version, 1);
    assert.deepEqual(manifeste.fichiers.map((f) => f.fichier), ['a.json', 'b.json', 'casse.json']);
    const b = manifeste.fichiers[1];
    assert.deepEqual(b.shaders[0].passes, ['common', 'buffer', 'sound', 'image']);
    assert.equal(b.shaders[0].son, true);
    assert.match(manifeste.fichiers[2].erreur, /JSON invalide/);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('manifeste ignoré par lui-même et sérialisation déterministe', () => {
  const dossier = dossierTemporaire();
  try {
    assert.equal(lancer(dossier).status, 0);
    const premier = readFileSync(join(dossier, 'manifest.json'), 'utf8');
    assert.equal(lancer(dossier).status, 0);
    assert.equal(readFileSync(join(dossier, 'manifest.json'), 'utf8'), premier);
    assert.equal(premier, serialiser(construireManifeste(dossier)));
    assert.ok(!JSON.parse(premier).fichiers.some((f) => f.fichier === 'manifest.json'));
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('--check : échoue si le manifeste est absent ou périmé', () => {
  const dossier = dossierTemporaire();
  try {
    assert.equal(lancer(dossier, '--check').status, 1);
    assert.ok(!existsSync(join(dossier, 'manifest.json')));
    lancer(dossier);
    assert.equal(lancer(dossier, '--check').status, 0);
    writeFileSync(join(dossier, 'c.json'), JSON.stringify(shaderSimple('C')));
    assert.equal(lancer(dossier, '--check').status, 1);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('--strict : code de sortie 1 si un fichier est en erreur', () => {
  const dossier = dossierTemporaire();
  try {
    assert.equal(lancer(dossier).status, 0);
    assert.equal(lancer(dossier, '--strict').status, 1);
    rmSync(join(dossier, 'casse.json'));
    assert.equal(lancer(dossier, '--strict').status, 0);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test('arguments invalides et dossier introuvable', () => {
  assert.equal(spawnSync(process.execPath, [OUTIL, '--inconnue'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [OUTIL, '--dossier'], { encoding: 'utf8' }).status, 2);
  assert.equal(lancer(join(tmpdir(), 'shaderview-inexistant-xyz')).status, 2);
});

test('le manifeste du dépôt est à jour', { skip: !existsSync(fileURLToPath(new URL('../shaders', import.meta.url))) }, () => {
  const resultat = spawnSync(process.execPath, [OUTIL, '--check'], { encoding: 'utf8' });
  assert.equal(resultat.status, 0, resultat.stderr);
});
