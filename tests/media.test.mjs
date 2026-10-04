// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ETAT_MEDIA,
  classifierMedia,
  genererBruit,
  genererDamier,
  genererDegrade,
  genererMediaSubstitue,
  hacherGraine,
  nomFichierMedia,
  resoudreNomMedia,
} from '../js/media.js';

// ---------------------------------------------------------------------------
// nomFichierMedia
// ---------------------------------------------------------------------------

test('nomFichierMedia : extrait le dernier segment, séparateurs / et \\', () => {
  assert.equal(nomFichierMedia('/media/a/48e2d9ef.mp3'), '48e2d9ef.mp3');
  assert.equal(nomFichierMedia('/media/previz/buffer00.png'), 'buffer00.png');
  assert.equal(nomFichierMedia('dossier\\sous-dossier\\x.jpg'), 'x.jpg');
  assert.equal(nomFichierMedia('x.jpg'), 'x.jpg');
});

test('nomFichierMedia : chaîne vide, null, séparateur final ou valeur non-chaîne', () => {
  assert.equal(nomFichierMedia(''), '');
  assert.equal(nomFichierMedia('/media/a/'), '');
  assert.equal(nomFichierMedia(null), '');
  assert.equal(nomFichierMedia(undefined), '');
});

// ---------------------------------------------------------------------------
// resoudreNomMedia
// ---------------------------------------------------------------------------

test('resoudreNomMedia : trouve le fichier par nom exact', () => {
  assert.equal(resoudreNomMedia('/media/a/x.png', new Set(['x.png', 'y.mp3'])), 'x.png');
  assert.equal(resoudreNomMedia('/media/a/x.png', ['x.png']), 'x.png');
});

test('resoudreNomMedia : sensible à la casse, aucune correspondance approximative', () => {
  assert.equal(resoudreNomMedia('/media/a/X.PNG', new Set(['x.png'])), null);
});

test('resoudreNomMedia : absent de l\'ensemble disponible', () => {
  assert.equal(resoudreNomMedia('/media/a/absent.png', new Set(['x.png'])), null);
});

test('resoudreNomMedia : src vide ou invalide', () => {
  assert.equal(resoudreNomMedia('', new Set(['x.png'])), null);
  assert.equal(resoudreNomMedia(null, new Set(['x.png'])), null);
});

// ---------------------------------------------------------------------------
// hacherGraine
// ---------------------------------------------------------------------------

test('hacherGraine : déterministe (même texte, même graine)', () => {
  assert.equal(hacherGraine('/media/a/x.png'), hacherGraine('/media/a/x.png'));
});

test('hacherGraine : des textes différents produisent (presque toujours) des graines différentes', () => {
  assert.notEqual(hacherGraine('a'), hacherGraine('b'));
});

test('hacherGraine : texte vide ne provoque pas d\'exception', () => {
  assert.equal(typeof hacherGraine(''), 'number');
});

// ---------------------------------------------------------------------------
// Générateurs procéduraux
// ---------------------------------------------------------------------------

test('genererDamier : dimensions et canal alpha opaque', () => {
  const octets = genererDamier(4, 4, 2);
  assert.equal(octets.length, 4 * 4 * 4);
  for (let i = 0; i < octets.length; i += 4) assert.equal(octets[i + 3], 255);
});

test('genererDamier : alterne deux tons selon la case', () => {
  const octets = genererDamier(4, 4, 1);
  // Cases 1×1 : damier strict, (0,0) et (1,1) de même ton, (1,0) de l'autre.
  const pixel = (x, y) => octets[(y * 4 + x) * 4];
  assert.equal(pixel(0, 0), pixel(1, 1));
  assert.notEqual(pixel(0, 0), pixel(1, 0));
});

test('genererDegrade : déterministe par graine, dimensions correctes', () => {
  const a = genererDegrade(4, 4, 42);
  const b = genererDegrade(4, 4, 42);
  const c = genererDegrade(4, 4, 43);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
  assert.equal(a.length, 4 * 4 * 4);
});

test('genererBruit : déterministe par graine, dimensions correctes, alpha opaque', () => {
  const a = genererBruit(8, 2, 7);
  const b = genererBruit(8, 2, 7);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(a.length, 8 * 2 * 4);
  assert.equal(a[3], 255);
});

test('genererBruit : graine différente produit un résultat différent', () => {
  const a = genererBruit(8, 8, 1);
  const b = genererBruit(8, 8, 2);
  assert.notDeepEqual(Array.from(a), Array.from(b));
});

// ---------------------------------------------------------------------------
// genererMediaSubstitue
// ---------------------------------------------------------------------------

test('genererMediaSubstitue : déterministe par type et src, types différents diffèrent', () => {
  const a = genererMediaSubstitue('texture', '/media/a/x.jpg', 4, 4);
  const b = genererMediaSubstitue('texture', '/media/a/x.jpg', 4, 4);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(a.length, 4 * 4 * 4);
});

test('genererMediaSubstitue : type sans générateur dédié replie sur le bruit', () => {
  const video = genererMediaSubstitue('video', '/media/a/x.mp4', 4, 4);
  const musique = genererMediaSubstitue('music', '/media/a/x.mp3', 4, 4);
  assert.equal(video.length, 4 * 4 * 4);
  assert.equal(musique.length, 4 * 4 * 4);
});

// ---------------------------------------------------------------------------
// classifierMedia
// ---------------------------------------------------------------------------

test('classifierMedia : canal sans média (buffer, keyboard) toujours SANS_OBJET', () => {
  assert.equal(classifierMedia({ type: 'buffer', src: null }, new Set()).etat, ETAT_MEDIA.SANS_OBJET);
  assert.equal(classifierMedia({ type: 'keyboard', src: null }, new Set()).etat, ETAT_MEDIA.SANS_OBJET);
  assert.equal(classifierMedia({ type: 'misc', src: null }, new Set()).etat, ETAT_MEDIA.SANS_OBJET);
});

test('classifierMedia : webcam/mic toujours DESACTIVE, quel que soit le contenu de shaders/media/', () => {
  assert.equal(classifierMedia({ type: 'webcam', src: null }, new Set()).etat, ETAT_MEDIA.DESACTIVE);
  assert.equal(classifierMedia({ type: 'mic', src: null }, new Set(['webcam.png'])).etat, ETAT_MEDIA.DESACTIVE);
});

test('classifierMedia : texture résolue dans shaders/media/', () => {
  const r = classifierMedia({ type: 'texture', src: '/media/a/x.jpg' }, new Set(['x.jpg']));
  assert.equal(r.etat, ETAT_MEDIA.RESOLU);
  assert.equal(r.nomFichier, 'x.jpg');
  assert.equal(r.message, null);
});

test('classifierMedia : texture/volume/music non résolue, SUBSTITUE avec message explicite', () => {
  const r = classifierMedia({ type: 'texture', src: '/media/a/x.jpg' }, new Set());
  assert.equal(r.etat, ETAT_MEDIA.SUBSTITUE);
  assert.equal(r.nomFichier, null);
  assert.match(r.message, /x\.jpg/);
});

test('classifierMedia : video non résolue, MANQUANT (jamais SUBSTITUE)', () => {
  const r = classifierMedia({ type: 'video', src: '/media/a/x.mp4' }, new Set());
  assert.equal(r.etat, ETAT_MEDIA.MANQUANT);
});

test('classifierMedia : video résolue, RESOLU comme les autres types', () => {
  const r = classifierMedia({ type: 'video', src: '/media/a/x.mp4' }, new Set(['x.mp4']));
  assert.equal(r.etat, ETAT_MEDIA.RESOLU);
});

test('classifierMedia : src absent (null), message sans planter sur le nom de fichier', () => {
  const r = classifierMedia({ type: 'texture', src: null }, new Set());
  assert.equal(r.etat, ETAT_MEDIA.SUBSTITUE);
  assert.match(r.message, /nom de fichier inconnu/);
});
