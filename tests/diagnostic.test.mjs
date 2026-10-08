// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  JournalErreurs,
  SEUIL_AVERTISSEMENT_TELECHARGEMENT,
  TAILLE_MAX_JOURNAL,
  VERSION_APPLICATION,
  construireDiagnostic,
  estimerTailleExport,
  installerCaptureErreurs,
} from '../js/diagnostic.js';
import { traduire, definirLangue } from '../js/i18n.js';

test('VERSION_APPLICATION est alignée sur package.json', () => {
  const paquet = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION_APPLICATION, paquet.version);
});

test('JournalErreurs : ajoute, tronque les messages longs, vide et notifie les abonnés', () => {
  let t = 1000;
  const journal = new JournalErreurs(5, () => (t += 1));
  const appels = [];
  const desabonner = journal.surChangement((j) => appels.push(j.longueur));
  journal.ajouter('error', 'a'.repeat(900), 'trace');
  assert.equal(journal.longueur, 1);
  assert.ok(journal.entrees[0].message.length <= 501);
  assert.ok(journal.entrees[0].message.endsWith('…'));
  journal.vider();
  assert.equal(journal.longueur, 0);
  assert.deepEqual(appels, [1, 0]);
  desabonner();
  journal.ajouter('error', 'x');
  assert.deepEqual(appels, [1, 0], 'désabonné : plus de notification');
});

test('JournalErreurs : une erreur identique consécutive incrémente un compteur', () => {
  const journal = new JournalErreurs();
  for (let i = 0; i < 100; i += 1) journal.ajouter('error', 'même erreur');
  assert.equal(journal.longueur, 1);
  assert.equal(journal.entrees[0].occurrences, 100);
  journal.ajouter('promise', 'même erreur');
  journal.ajouter('error', 'même erreur');
  assert.equal(journal.longueur, 3, 'une autre source ou une autre erreur entre deux coupe la série');
});

test('JournalErreurs : borné à sa taille, les plus anciennes sont écartées', () => {
  const journal = new JournalErreurs(3);
  for (let i = 0; i < 10; i += 1) journal.ajouter('error', `erreur ${i}`);
  assert.deepEqual(journal.entrees.map((e) => e.message), ['erreur 7', 'erreur 8', 'erreur 9']);
  assert.ok(TAILLE_MAX_JOURNAL >= 20);
});

test('JournalErreurs : entrees renvoie des copies', () => {
  const journal = new JournalErreurs();
  journal.ajouter('error', 'a');
  journal.entrees[0].message = 'modifié';
  assert.equal(journal.entrees[0].message, 'a');
});

test('installerCaptureErreurs : erreurs et rejets enregistrés, retrait des écouteurs', () => {
  const ecouteurs = new Map();
  const fenetre = {
    addEventListener: (nom, f) => ecouteurs.set(nom, f),
    removeEventListener: (nom) => ecouteurs.delete(nom),
  };
  const journal = new JournalErreurs();
  const retirer = installerCaptureErreurs(journal, fenetre);
  ecouteurs.get('error')({ message: 'Uncaught boom', filename: 'http://x/js/app.js', lineno: 42, error: new Error('boom') });
  ecouteurs.get('unhandledrejection')({ reason: new TypeError('rejet') });
  ecouteurs.get('unhandledrejection')({ reason: 'texte brut' });
  const [a, b, c] = journal.entrees;
  assert.equal(a.source, 'error');
  assert.match(a.message, /Uncaught boom \(app\.js:42\)/);
  assert.match(a.trace, /boom/);
  assert.equal(b.message, 'TypeError : rejet');
  assert.equal(c.message, 'texte brut');
  retirer();
  assert.equal(ecouteurs.size, 0);
});

const INFOS = {
  version: '9.9.9',
  langue: 'fr',
  date: '2026-01-01T00:00:00.000Z',
  navigateur: { userAgent: 'UA-test', plateforme: 'Plat', langues: 'fr-FR', coeurs: 8, memoireGo: 16 },
  webgl: { rendu: 'GPU-test', fabricant: 'Fab', version: 'WebGL 2.0', tailleTextureMax: 8192, taille3dMax: 2048, precisionHaute: true,
    extensions: { EXT_color_buffer_float: true, OES_texture_float_linear: false } },
  capacites: { videoEncoder: true, audioEncoder: false, opfs: true, selecteurFichier: false, audioContext: true, webm: ['vp09.00.10.08'], mp4: [] },
  shader: { fichier: 'x.json', titre: 'Titre', alerte: null, inferences: [{ passe: 'image', canal: 1, type: 'cubemap' }] },
  erreurs: [{ source: 'error', message: 'Boum', trace: 'a\nb\nc\nd\ne\nf', occurrences: 3, instant: 0 }],
};

test('construireDiagnostic : toutes les rubriques, valeurs et erreurs', () => {
  const texte = construireDiagnostic(INFOS);
  for (const attendu of ['ShaderView 9.9.9', 'Agent : UA-test', 'Rendu : GPU-test', 'EXT_color_buffer_float : oui', 'OES_texture_float_linear : non',
    'VideoEncoder : oui', 'AudioEncoder : non', 'Codecs WebM acceptés : vp09.00.10.08', 'Codecs MP4 acceptés : aucun',
    'Fichier : x.json', 'Alerte : aucune', 'iChannel1 déduit « cubemap »', '[Erreurs d’exécution : 1]', '- error ×3 : Boum']) {
    assert.ok(texte.includes(attendu), `« ${attendu} » absent`);
  }
  assert.ok(!texte.includes('    e'), 'la trace est limitée à quatre lignes');
});

test('construireDiagnostic : WebGL2 indisponible, aucun shader, aucune erreur, valeurs inconnues', () => {
  const texte = construireDiagnostic({ ...INFOS, webgl: null, shader: null, erreurs: [], navigateur: {} });
  assert.match(texte, /WebGL2 indisponible\./);
  assert.match(texte, /\[Shader sélectionné\]\nAucun\./);
  assert.match(texte, /\[Erreurs d’exécution : 0\]\nAucune\./);
  assert.match(texte, /Agent : inconnu/);
});

test('estimerTailleExport : débit total × durée / 8, audio seulement s’il est inclus', () => {
  assert.equal(estimerTailleExport({ bitrate: 8_000_000, bitrateAudio: 128_000, duree: 10, audio: false }), 10_000_000);
  assert.equal(estimerTailleExport({ bitrate: 8_000_000, bitrateAudio: 128_000, duree: 10, audio: true }), 10_160_000);
  assert.equal(estimerTailleExport({ bitrate: Number.NaN, duree: 10 }), 0);
  assert.ok(estimerTailleExport({ bitrate: 20_000_000, duree: 600 }) > SEUIL_AVERTISSEMENT_TELECHARGEMENT);
});

test('textes du diagnostic traduits en français et en anglais', () => {
  for (const [langue, copie] of [['fr', 'Copier'], ['en', 'Copy']]) {
    definirLangue(langue, { stockage: null, document: null });
    assert.equal(traduire('diag.copy'), copie);
    assert.match(traduire('export.largeDownload', { size: 700 }), /700/);
    assert.notEqual(traduire('diag.help'), 'diag.help');
    assert.notEqual(traduire('compat.inference', { pass: 'image', channel: 1, type: 'cubemap' }), 'compat.inference');
  }
  definirLangue('fr', { stockage: null, document: null });
});
