// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ErreurParseur,
  construireGrapheDependances,
  parserEchantillonnage,
  parserEntree,
  parserInfo,
  parserPasse,
  parserShader,
  resoudreOrdre,
} from '../js/parser.js';
import { passe, shaderCubemap, shaderCycleBuffers, shaderMonoPasse, shaderMultipasseAvecGraphe } from './fixtures.mjs';

// ---------------------------------------------------------------------------
// parserInfo
// ---------------------------------------------------------------------------

test('parserInfo : lit tous les champs', () => {
  const r = parserInfo({ id: 'AAAAAA', name: 'Titre', username: 'auteur', description: 'd', tags: [' t1 ', 't2', ''], date: '1700000000' }, 'repli');
  assert.deepEqual(r, { id: 'AAAAAA', nom: 'Titre', description: 'd', auteur: 'auteur', tags: ['t1', 't2'], date: 1700000000 });
});

test('parserInfo : absent ou incomplet, repli sur le nom de fichier', () => {
  assert.deepEqual(parserInfo(undefined, 'f'), { id: null, nom: 'f', description: null, auteur: null, tags: [], date: null });
  assert.deepEqual(parserInfo({}, 'f'), { id: null, nom: 'f', description: null, auteur: null, tags: [], date: null });
  // info.username absent (cas observé sur de vrais exports Shadertoy) : auteur null, pas d'erreur.
  assert.equal(parserInfo({ name: 'x' }, 'f').auteur, null);
});

test('parserInfo : date non numérique ignorée', () => {
  assert.equal(parserInfo({ date: 'hier' }, 'f').date, null);
});

// ---------------------------------------------------------------------------
// parserEchantillonnage
// ---------------------------------------------------------------------------

test('parserEchantillonnage : valeurs par défaut sans sampler', () => {
  assert.deepEqual(parserEchantillonnage(undefined), {
    filtre: 'linear', repetition: 'clamp', retournementVertical: false, srgb: false, interne: null,
  });
});

test('parserEchantillonnage : lit et normalise la casse', () => {
  const r = parserEchantillonnage({ filter: 'MIPMAP', wrap: 'REPEAT', vflip: 'true', srgb: true, internal: 'byte' });
  assert.deepEqual(r, { filtre: 'mipmap', repetition: 'repeat', retournementVertical: true, srgb: true, interne: 'byte' });
});

test('parserEchantillonnage : valeur inconnue remplacée par le repli', () => {
  assert.equal(parserEchantillonnage({ filter: 'bicubique' }).filtre, 'linear');
  assert.equal(parserEchantillonnage({ wrap: 'miroir' }).repetition, 'clamp');
});

// ---------------------------------------------------------------------------
// parserEntree
// ---------------------------------------------------------------------------

test('parserEntree : entrée valide', () => {
  const avert = [];
  const r = parserEntree({ channel: 2, ctype: 'texture', src: '/media/a/tex.jpg', sampler: { filter: 'nearest' } }, 0, 'image', avert);
  assert.equal(avert.length, 0);
  assert.equal(r.canal, 2);
  assert.equal(r.type, 'texture');
  assert.equal(r.src, '/media/a/tex.jpg');
  assert.equal(r.idSortie, null);
  assert.equal(r.echantillonnage.filtre, 'nearest');
});

test('parserEntree : idSortie uniquement pour les canaux de type buffer', () => {
  const avert = [];
  assert.equal(parserEntree({ channel: 0, ctype: 'buffer', id: 'bufA' }, 0, 'p', avert).idSortie, 'bufA');
  assert.equal(parserEntree({ channel: 0, ctype: 'texture', id: 'bufA' }, 0, 'p', avert).idSortie, null);
});

test('parserEntree : canal hors plage ou absent, avertissement et entrée ignorée', () => {
  const avert = [];
  assert.equal(parserEntree({ channel: 7, ctype: 'texture' }, 0, 'p', avert), null);
  assert.equal(parserEntree({ ctype: 'texture' }, 0, 'p', avert), null);
  assert.equal(avert.length, 2);
  assert.match(avert[0], /canal/);
});

test('parserEntree : type de canal inconnu, avertissement et entrée ignorée', () => {
  const avert = [];
  assert.equal(parserEntree({ channel: 0, ctype: 'hologramme' }, 0, 'p', avert), null);
  assert.match(avert[0], /type de canal/);
});

test('parserEntree : objet absent, avertissement et entrée ignorée', () => {
  const avert = [];
  assert.equal(parserEntree(null, 0, 'p', avert), null);
  assert.equal(avert.length, 1);
});

// ---------------------------------------------------------------------------
// parserPasse
// ---------------------------------------------------------------------------

test('parserPasse : passe valide, nom de repli si absent', () => {
  const avert = [];
  const r = parserPasse({ type: 'IMAGE', code: 'x' }, 0, avert);
  assert.equal(r.type, 'image');
  assert.equal(r.nom, 'image');
  assert.equal(r.code, 'x');
  assert.equal(r.idSortie, null);
  assert.deepEqual(r.entrees, []);
});

test('parserPasse : type inconnu, ErreurParseur', () => {
  assert.throws(() => parserPasse({ type: 'vertex', code: 'x' }, 0, []), ErreurParseur);
  assert.throws(() => parserPasse({ type: 'vertex', code: 'x' }, 0, []), /type/);
});

test('parserPasse : code absent ou vide, ErreurParseur', () => {
  assert.throws(() => parserPasse({ type: 'image' }, 0, []), ErreurParseur);
  assert.throws(() => parserPasse({ type: 'image', code: '   ' }, 0, []), ErreurParseur);
});

test('parserPasse : objet absent, ErreurParseur', () => {
  assert.throws(() => parserPasse(null, 0, []), ErreurParseur);
  assert.throws(() => parserPasse([], 0, []), ErreurParseur);
});

test('parserPasse : idSortie lu depuis la première sortie valide', () => {
  const r = parserPasse(passe('buffer', { outputs: [{ id: 'bufA', channel: 0 }] }), 0, []);
  assert.equal(r.idSortie, 'bufA');
});

test('parserPasse : sorties absentes ou mal formées, idSortie null', () => {
  assert.equal(parserPasse(passe('image', { outputs: [] }), 0, []).idSortie, null);
  assert.equal(parserPasse(passe('image', { outputs: [null, 42] }), 0, []).idSortie, null);
});

test('parserPasse : entrées triées par canal, entrées invalides omises', () => {
  const avert = [];
  const r = parserPasse(
    passe('image', { inputs: [{ channel: 2, ctype: 'texture' }, { channel: 0, ctype: 'keyboard' }, { channel: 9, ctype: 'texture' }] }),
    0,
    avert,
  );
  assert.deepEqual(r.entrees.map((e) => e.canal), [0, 2]);
  assert.equal(avert.length, 1);
});

test('parserPasse : deux entrées sur le même canal, la dernière est retenue avec avertissement', () => {
  const avert = [];
  const r = parserPasse(
    passe('image', { inputs: [{ channel: 0, ctype: 'texture', src: 'premier' }, { channel: 0, ctype: 'buffer', src: 'second' }] }),
    0,
    avert,
  );
  assert.equal(r.entrees.length, 1);
  assert.equal(r.entrees[0].src, 'second');
  assert.match(avert[0], /défini plusieurs fois/);
});

// ---------------------------------------------------------------------------
// construireGrapheDependances / resoudreOrdre
// ---------------------------------------------------------------------------

function buffersDeTest() {
  // A lit B (dépendance réelle) et se lit lui-même (rétroaction, ignorée comme dépendance).
  const a = { idSortie: 'bufA', entrees: [{ type: 'buffer', idSortie: 'bufA' }, { type: 'buffer', idSortie: 'bufB' }] };
  const b = { idSortie: 'bufB', entrees: [] };
  return { A: a, B: b };
}

test('construireGrapheDependances : ignore la rétroaction, retient les dépendances réelles', () => {
  const graphe = construireGrapheDependances(buffersDeTest());
  assert.deepEqual([...graphe.get('A')], ['B']);
  assert.deepEqual([...graphe.get('B')], []);
});

test('resoudreOrdre : un buffer est rendu après ceux dont il lit la sortie', () => {
  const avert = [];
  assert.deepEqual(resoudreOrdre(buffersDeTest(), avert), ['B', 'A']);
  assert.equal(avert.length, 0);
});

test('resoudreOrdre : aucun buffer, tableau vide', () => {
  assert.deepEqual(resoudreOrdre({}, []), []);
});

test('resoudreOrdre : buffer sans dépendance, ordre du fichier', () => {
  const buffers = { A: { idSortie: 'bufA', entrees: [] }, B: { idSortie: 'bufB', entrees: [] } };
  assert.deepEqual(resoudreOrdre(buffers, []), ['A', 'B']);
});

test('resoudreOrdre : cycle réel entre deux buffers, signalé sans exception', () => {
  const buffers = {
    A: { idSortie: 'bufA', entrees: [{ type: 'buffer', idSortie: 'bufB' }] },
    B: { idSortie: 'bufB', entrees: [{ type: 'buffer', idSortie: 'bufA' }] },
  };
  const avert = [];
  const ordre = resoudreOrdre(buffers, avert);
  assert.deepEqual(new Set(ordre), new Set(['A', 'B']));
  assert.equal(avert.length, 1);
  assert.match(avert[0], /circulaire/);
});

// ---------------------------------------------------------------------------
// parserShader
// ---------------------------------------------------------------------------

test('parserShader : mono-passe', () => {
  const r = parserShader(shaderMonoPasse());
  assert.equal(r.info.nom, 'Mono');
  assert.equal(r.commun, null);
  assert.deepEqual(r.buffers, {});
  assert.deepEqual(r.ordreBuffers, []);
  assert.equal(r.image.type, 'image');
  assert.equal(r.son, null);
  assert.deepEqual(r.cubemaps, {});
  assert.deepEqual(r.avertissements, []);
});

test('parserShader : multipasse avec graphe de dépendances, common et son', () => {
  const r = parserShader(shaderMultipasseAvecGraphe());
  assert.equal(r.commun.type, 'common');
  assert.equal(Object.keys(r.buffers).length, 2);
  assert.equal(r.buffers.A.nom, 'Buffer A');
  assert.equal(r.buffers.B.nom, 'Buffer B');
  // A dépend de B (dépendance réelle) ; sa propre rétroaction n'influence pas l'ordre.
  assert.deepEqual(r.ordreBuffers, ['B', 'A']);
  assert.equal(r.son.nom, 'Sound');
  assert.equal(r.image.entrees[0].idSortie, 'bufA');
  assert.deepEqual(r.avertissements, []);
});

test('parserShader : cycle réel entre buffers, avertissement sans exception', () => {
  const r = parserShader(shaderCycleBuffers());
  assert.equal(r.avertissements.some((a) => /circulaire/.test(a)), true);
  assert.equal(new Set(r.ordreBuffers).size, 2);
});

test('parserShader : cubemap', () => {
  const r = parserShader(shaderCubemap());
  assert.deepEqual(Object.keys(r.cubemaps), ['Cube A']);
  assert.equal(r.image.entrees[0].type, 'cubemap');
  assert.equal(r.image.entrees[0].idSortie, 'cubeA');
});

test('parserShader : associe les lettres A à D aux passes buffer dans leur ordre d\'apparition', () => {
  const shader = {
    info: { name: 'x' },
    renderpass: [passe('buffer', { name: 'P1' }), passe('image'), passe('buffer', { name: 'P2' })],
  };
  const r = parserShader(shader);
  assert.equal(r.buffers.A.nom, 'P1');
  assert.equal(r.buffers.B.nom, 'P2');
  assert.equal(r.buffers.C, undefined);
});

test('parserShader : plus de quatre buffers, ErreurParseur', () => {
  const shader = {
    info: { name: 'x' },
    renderpass: [...Array.from({ length: 5 }, () => passe('buffer')), passe('image')],
  };
  assert.throws(() => parserShader(shader), ErreurParseur);
  assert.throws(() => parserShader(shader), /maximum/);
});

test('parserShader : aucune passe image, ErreurParseur', () => {
  assert.throws(() => parserShader({ info: {}, renderpass: [passe('buffer')] }), ErreurParseur);
  assert.throws(() => parserShader({ info: {}, renderpass: [passe('buffer')] }), /image/);
});

test('parserShader : renderpass absent ou vide, ErreurParseur', () => {
  assert.throws(() => parserShader({ info: {} }), ErreurParseur);
  assert.throws(() => parserShader({ info: {}, renderpass: [] }), ErreurParseur);
});

test('parserShader : shader non objet, ErreurParseur', () => {
  assert.throws(() => parserShader(null), ErreurParseur);
  assert.throws(() => parserShader('texte'), ErreurParseur);
});

test('parserShader : passes communes, image et son en double, la dernière remplace et un avertissement est consigné', () => {
  const shader = {
    info: { name: 'x' },
    renderpass: [passe('common', { code: '// 1' }), passe('common', { code: '// 2' }), passe('image', { code: '// a' }), passe('image', { code: '// b' })],
  };
  const r = parserShader(shader);
  assert.equal(r.commun.code, '// 2');
  assert.equal(r.image.code, '// b');
  assert.equal(r.avertissements.length, 2);
});
