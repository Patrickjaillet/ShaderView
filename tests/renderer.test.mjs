// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DECLARATION_UNIFORMS,
  EtatClavier,
  EtatSouris,
  FACES_CUBEMAP,
  Horloge,
  LARGEUR_TEXTURE_CLAVIER,
  LIGNE_CLAVIER,
  calculerUniforms,
  construireDeclarationUniforms,
  construireFragmentShader,
  convertirGles1VersGles3,
  convertirShaderNormalise,
  mapperErreurs,
  matriceRepereFace,
  resoudreSourcesCanaux,
  typesCanauxDe,
} from '../js/renderer.js';
import { passe, shaderCubemap, shaderMultipasseAvecGraphe } from './fixtures.mjs';
import { parserShader } from '../js/parser.js';

// ---------------------------------------------------------------------------
// construireFragmentShader
// ---------------------------------------------------------------------------

test('construireFragmentShader : en-tête, uniforms, code utilisateur et main() dans l\'ordre', () => {
  const { source } = construireFragmentShader('void mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }', null);
  assert.match(source, /^#version 300 es/);
  assert.match(source, /precision highp float;/);
  assert.ok(source.includes(DECLARATION_UNIFORMS));
  assert.ok(source.includes('void mainImage(out vec4 c, in vec2 p)'));
  assert.match(source, /void main\(\) \{\s*\n\s*mainImage\(shaderview_sortieFragment, gl_FragCoord\.xy\);/);
  const indexEntete = source.indexOf('uniform vec3 iResolution');
  const indexCode = source.indexOf('void mainImage');
  const indexMain = source.indexOf('void main()');
  assert.ok(indexEntete < indexCode);
  assert.ok(indexCode < indexMain);
});

test('construireFragmentShader : insère le code common avant le code utilisateur', () => {
  const { source } = construireFragmentShader('void mainImage(out vec4 c, in vec2 p) { c = vec4(X); }', 'const float X = 1.;');
  const indexCommun = source.indexOf('const float X');
  const indexCode = source.indexOf('void mainImage');
  assert.ok(indexCommun < indexCode);
});

test('construireFragmentShader : decalageLignes compte l\'en-tête seul sans common', () => {
  const sansCommun = construireFragmentShader('CODE', null);
  const avecCommun = construireFragmentShader('CODE', 'LIGNE1\nLIGNE2\nLIGNE3');
  assert.equal(avecCommun.decalageLignes - sansCommun.decalageLignes, 3);
});

test('construireFragmentShader : le décalage correspond exactement au nombre de lignes avant le code utilisateur', () => {
  const { source, decalageLignes } = construireFragmentShader('CODE_UTILISATEUR', 'COMMUN');
  const lignes = source.split('\n');
  assert.equal(lignes[decalageLignes], 'CODE_UTILISATEUR');
});

// ---------------------------------------------------------------------------
// convertirGles1VersGles3
// ---------------------------------------------------------------------------

test('convertirGles1VersGles3 : renomme les fonctions de texturage GLES 1.00', () => {
  assert.equal(convertirGles1VersGles3('texture2D(iChannel0, uv)'), 'texture(iChannel0, uv)');
  assert.equal(convertirGles1VersGles3('textureCube(iChannel0, d)'), 'texture(iChannel0, d)');
  assert.equal(convertirGles1VersGles3('texture2DLod(a, b, c)'), 'textureLod(a, b, c)');
  assert.equal(convertirGles1VersGles3('texture2DProj(a, b)'), 'textureProj(a, b)');
});

test('convertirGles1VersGles3 : ne touche pas un identifiant qui ne fait que commencer pareil', () => {
  assert.equal(convertirGles1VersGles3('float texture2DFoo = 1.;'), 'float texture2DFoo = 1.;');
});

test('convertirGles1VersGles3 : varying devient in', () => {
  assert.equal(convertirGles1VersGles3('varying vec2 vUv;'), 'in vec2 vUv;');
});

test('convertirGles1VersGles3 : code GLES 3.00 déjà conforme, inchangé', () => {
  const code = 'void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p); }';
  assert.equal(convertirGles1VersGles3(code), code);
});

// ---------------------------------------------------------------------------
// mapperErreurs
// ---------------------------------------------------------------------------

test('mapperErreurs : format ANGLE/Chrome, ligne ramenée au code utilisateur', () => {
  const r = mapperErreurs("ERROR: 0:15: 'foo' : undeclared identifier", 10);
  assert.equal(r.length, 1);
  assert.equal(r[0].ligne, 5);
  assert.equal(r[0].colonne, null);
  assert.match(r[0].message, /undeclared identifier/);
});

test('mapperErreurs : format Mesa', () => {
  const r = mapperErreurs('12:3(7): error: no matching function for call', 10);
  assert.equal(r[0].ligne, 2);
  assert.equal(r[0].colonne, 3);
});

test('mapperErreurs : plusieurs lignes, lignes vides ignorées', () => {
  const r = mapperErreurs("ERROR: 0:11: premier\n\nERROR: 0:12: second", 10);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((e) => e.ligne), [1, 2]);
});

test('mapperErreurs : ligne dans l\'en-tête injecté ou le code common, ligne nulle', () => {
  const r = mapperErreurs('ERROR: 0:3: erreur interne', 10);
  assert.equal(r[0].ligne, null);
  assert.equal(r[0].message, 'erreur interne');
});

test('mapperErreurs : format non reconnu, conservé tel quel avec ligne nulle', () => {
  const r = mapperErreurs('un message de pilote inattendu', 10);
  assert.equal(r.length, 1);
  assert.equal(r[0].ligne, null);
  assert.equal(r[0].message, 'un message de pilote inattendu');
});

test('mapperErreurs : journal vide ou absent, tableau vide', () => {
  assert.deepEqual(mapperErreurs('', 10), []);
  assert.deepEqual(mapperErreurs('   ', 10), []);
  assert.deepEqual(mapperErreurs(undefined, 10), []);
});

// ---------------------------------------------------------------------------
// Horloge
// ---------------------------------------------------------------------------

test('Horloge : état initial', () => {
  const h = new Horloge();
  assert.equal(h.temps, 0);
  assert.equal(h.image, 0);
  assert.equal(h.deltaTemps, 0);
  assert.equal(h.enMarche, false);
});

test('Horloge : lire/pause changent enMarche sans toucher au temps', () => {
  const h = new Horloge();
  h.lire();
  assert.equal(h.enMarche, true);
  h.pause();
  assert.equal(h.enMarche, false);
  assert.equal(h.temps, 0);
});

test('Horloge : avancer cumule le temps et incrémente l\'image', () => {
  const h = new Horloge();
  h.avancer(0.5);
  h.avancer(0.25);
  assert.equal(h.temps, 0.75);
  assert.equal(h.image, 2);
  assert.equal(h.deltaTemps, 0.25);
});

test('Horloge : avancer avec une durée négative ou non finie n\'avance pas le temps mais incrémente l\'image', () => {
  const h = new Horloge();
  h.avancer(-1);
  assert.equal(h.temps, 0);
  assert.equal(h.image, 1);
  h.avancer(NaN);
  assert.equal(h.temps, 0);
  assert.equal(h.image, 2);
});

test('Horloge : remettreAZero remet temps, image et delta, conserve enMarche', () => {
  const h = new Horloge();
  h.lire();
  h.avancer(1);
  h.remettreAZero();
  assert.equal(h.temps, 0);
  assert.equal(h.image, 0);
  assert.equal(h.deltaTemps, 0);
  assert.equal(h.enMarche, true);
});

test('Horloge : pasAPas avance d\'exactement une image à 1/fps', () => {
  const h = new Horloge();
  h.pasAPas(50);
  assert.equal(h.temps, 0.02);
  assert.equal(h.image, 1);
});

test('Horloge : sauterA en avant conserve le compteur d\'image', () => {
  const h = new Horloge();
  h.avancer(1);
  h.avancer(1);
  h.sauterA(10);
  assert.equal(h.temps, 10);
  assert.equal(h.image, 2);
  assert.equal(h.deltaTemps, 8);
});

test('Horloge : sauterA(0) remet le compteur d\'image à zéro', () => {
  const h = new Horloge();
  h.avancer(1);
  h.sauterA(0);
  assert.equal(h.temps, 0);
  assert.equal(h.image, 0);
});

test('Horloge : definirEtat fixe précisément le temps et les uniforms d’export', () => {
  const h = new Horloge();
  h.definirEtat(3.5, 105, 1 / 30);
  assert.equal(h.temps, 3.5);
  assert.equal(h.image, 105);
  assert.equal(h.deltaTemps, 1 / 30);
  assert.throws(() => h.definirEtat(-1, 0, 1 / 30), RangeError);
});

// ---------------------------------------------------------------------------
// EtatSouris
// ---------------------------------------------------------------------------

test('EtatSouris : état initial, bouton relâché, clic négatif', () => {
  const s = new EtatSouris();
  assert.deepEqual(s.iMouse, [0, 0, -0, -0]);
});

test('EtatSouris : deplacer convertit en repère bas-gauche', () => {
  const s = new EtatSouris();
  s.deplacer(100, 50, 450);
  assert.deepEqual(s.iMouse.slice(0, 2), [100, 400]);
});

test('EtatSouris : appuyer fige la position de clic, zw positif tant que le bouton est enfoncé', () => {
  const s = new EtatSouris();
  s.deplacer(10, 20, 450);
  s.appuyer();
  s.deplacer(90, 20, 450);
  const [x, y, clicX, clicY] = s.iMouse;
  assert.equal(x, 90);
  assert.equal(clicX, 10);
  assert.ok(clicY > 0);
  assert.equal(y, 430);
});

test('EtatSouris : relacher rend zw négatif, position de clic conservée', () => {
  const s = new EtatSouris();
  s.deplacer(10, 20, 450);
  s.appuyer();
  s.relacher();
  const [, , clicX, clicY] = s.iMouse;
  assert.equal(clicX, -10);
  assert.equal(clicY, -430);
});

// ---------------------------------------------------------------------------
// calculerUniforms
// ---------------------------------------------------------------------------

test('calculerUniforms : iResolution, iTime, iFrame, iSampleRate repris de l\'horloge et des options', () => {
  const h = new Horloge();
  h.avancer(0.5);
  const s = new EtatSouris();
  const u = calculerUniforms({ largeur: 800, hauteur: 450 }, h, s, { frequenceEchantillonnage: 48000, maintenant: new Date(2026, 0, 15, 13, 0, 0) });
  assert.deepEqual(u.iResolution, [800, 450, 1]);
  assert.equal(u.iTime, 0.5);
  assert.equal(u.iFrame, 1);
  assert.equal(u.iSampleRate, 48000);
});

test('calculerUniforms : iFrameRate est l\'inverse de iTimeDelta, nul à la première image', () => {
  const h = new Horloge();
  const s = new EtatSouris();
  assert.equal(calculerUniforms({ largeur: 1, hauteur: 1 }, h, s).iFrameRate, 0);
  h.avancer(0.1);
  assert.equal(calculerUniforms({ largeur: 1, hauteur: 1 }, h, s).iFrameRate, 10);
});

test('calculerUniforms : iDate reflète la date fournie (année, mois 1-indexé, jour, secondes depuis minuit)', () => {
  const h = new Horloge();
  const s = new EtatSouris();
  const u = calculerUniforms({ largeur: 1, hauteur: 1 }, h, s, { maintenant: new Date(2026, 9, 4, 1, 2, 3) });
  assert.equal(u.iDate[0], 2026);
  assert.equal(u.iDate[1], 10);
  assert.equal(u.iDate[2], 4);
  assert.equal(Math.round(u.iDate[3]), 3723);
});

test('calculerUniforms : iMouse repris de l\'état de la souris', () => {
  const h = new Horloge();
  const s = new EtatSouris();
  s.deplacer(5, 5, 450);
  assert.deepEqual(calculerUniforms({ largeur: 1, hauteur: 1 }, h, s).iMouse, s.iMouse);
});

// ---------------------------------------------------------------------------
// construireDeclarationUniforms / construireFragmentShader (cubemap, canaux)
// ---------------------------------------------------------------------------

test('construireDeclarationUniforms : sampler2D par défaut sur les quatre canaux', () => {
  const d = construireDeclarationUniforms();
  assert.match(d, /uniform sampler2D iChannel0;/);
  assert.match(d, /uniform sampler2D iChannel3;/);
  assert.doesNotMatch(d, /samplerCube/);
});

test('construireDeclarationUniforms : samplerCube pour un canal de type cubemap', () => {
  const d = construireDeclarationUniforms(['texture', 'cubemap', 'texture', 'texture']);
  assert.match(d, /uniform sampler2D iChannel0;/);
  assert.match(d, /uniform samplerCube iChannel1;/);
  assert.match(d, /uniform sampler2D iChannel2;/);
});

test('construireFragmentShader : option cubemap ajoute les uniforms de face et appelle mainCubemap', () => {
  const { source } = construireFragmentShader('void mainCubemap(out vec4 c, in vec2 p, in vec3 o, in vec3 d) { c = vec4(0.); }', null, { cubemap: true });
  assert.match(source, /uniform vec3 shaderview_rayOrigine;/);
  assert.match(source, /uniform mat3 shaderview_repereFace;/);
  assert.match(source, /mainCubemap\(shaderview_sortieFragment, gl_FragCoord\.xy, shaderview_rayOrigine, shaderview_rayon\)/);
  assert.doesNotMatch(source, /mainImage\(/);
});

test('construireFragmentShader : sans cubemap, appelle mainImage et n\'ajoute pas les uniforms de face', () => {
  const { source } = construireFragmentShader('CODE', null);
  assert.doesNotMatch(source, /shaderview_rayOrigine/);
  assert.match(source, /mainImage\(/);
});

test('construireFragmentShader : decalageLignes correct avec l\'option cubemap (ligne supplémentaire des uniforms de face)', () => {
  const sansCubemap = construireFragmentShader('CODE', null);
  const avecCubemap = construireFragmentShader('CODE', null, { cubemap: true });
  const lignes = avecCubemap.source.split('\n');
  assert.equal(lignes[avecCubemap.decalageLignes], 'CODE');
  assert.ok(avecCubemap.decalageLignes > sansCubemap.decalageLignes);
});

test('construireFragmentShader : option son ajoute iBlockOffset et appelle mainSound avec l\'échantillon et le temps calculés', () => {
  const { source } = construireFragmentShader('vec2 mainSound(int samp, float time) { return vec2(0.); }', null, { son: true });
  assert.match(source, /uniform int iBlockOffset;/);
  assert.match(source, /mainSound\(shaderview_echantillon, shaderview_temps\)/);
  assert.match(source, /shaderview_echantillon = iBlockOffset \+ shaderview_y \* int\(iResolution\.x\) \+ shaderview_x/);
  assert.match(source, /shaderview_temps = float\(shaderview_echantillon\) \/ iSampleRate/);
  assert.doesNotMatch(source, /mainImage\(/);
  assert.doesNotMatch(source, /mainCubemap\(/);
});

test('construireFragmentShader : sans son, n\'ajoute pas iBlockOffset', () => {
  const { source } = construireFragmentShader('CODE', null);
  assert.doesNotMatch(source, /iBlockOffset/);
});

// ---------------------------------------------------------------------------
// matriceRepereFace
// ---------------------------------------------------------------------------

test('matriceRepereFace : face +X, droite = -Z, haut = -Y, avant = -X (colonnes)', () => {
  const m = matriceRepereFace(FACES_CUBEMAP[0]);
  assert.deepEqual(Array.from(m, (v) => v + 0), [0, 0, -1, 0, -1, 0, -1, 0, 0]);
});

test('matriceRepereFace : les six faces produisent une base orthonormée', () => {
  for (const face of FACES_CUBEMAP) {
    const m = matriceRepereFace(face);
    const colonne = (i) => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
    const norme = (v) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
    for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(norme(colonne(i)) - 1) < 1e-9);
  }
});

// ---------------------------------------------------------------------------
// EtatClavier
// ---------------------------------------------------------------------------

test('EtatClavier : état initial, toutes lignes à zéro', () => {
  const c = new EtatClavier();
  assert.ok(c.octets.every((o) => o === 0));
  assert.equal(c.octets.length, LARGEUR_TEXTURE_CLAVIER * 3);
});

test('EtatClavier : appuyer met ENFONCEE et APPUYEE à 255, inverse BASCULE', () => {
  const c = new EtatClavier();
  c.appuyer(32);
  assert.equal(c.octets[LIGNE_CLAVIER.ENFONCEE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
  assert.equal(c.octets[LIGNE_CLAVIER.APPUYEE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
  assert.equal(c.octets[LIGNE_CLAVIER.BASCULE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
});

test('EtatClavier : consommerAppuis remet APPUYEE à zéro sans toucher ENFONCEE ni BASCULE', () => {
  const c = new EtatClavier();
  c.appuyer(32);
  c.consommerAppuis();
  assert.equal(c.octets[LIGNE_CLAVIER.APPUYEE * LARGEUR_TEXTURE_CLAVIER + 32], 0);
  assert.equal(c.octets[LIGNE_CLAVIER.ENFONCEE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
  assert.equal(c.octets[LIGNE_CLAVIER.BASCULE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
});

test('EtatClavier : relacher remet ENFONCEE à zéro, conserve BASCULE', () => {
  const c = new EtatClavier();
  c.appuyer(32);
  c.consommerAppuis();
  c.relacher(32);
  assert.equal(c.octets[LIGNE_CLAVIER.ENFONCEE * LARGEUR_TEXTURE_CLAVIER + 32], 0);
  assert.equal(c.octets[LIGNE_CLAVIER.BASCULE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
});

test('EtatClavier : un second appui inverse la bascule à nouveau', () => {
  const c = new EtatClavier();
  c.appuyer(32);
  c.consommerAppuis();
  c.relacher(32);
  c.appuyer(32);
  assert.equal(c.octets[LIGNE_CLAVIER.BASCULE * LARGEUR_TEXTURE_CLAVIER + 32], 0);
});

test('EtatClavier : une répétition automatique ne signale pas un nouvel appui ni n\'inverse la bascule', () => {
  const c = new EtatClavier();
  c.appuyer(32);
  c.consommerAppuis();
  c.appuyer(32, true);
  assert.equal(c.octets[LIGNE_CLAVIER.APPUYEE * LARGEUR_TEXTURE_CLAVIER + 32], 0);
  assert.equal(c.octets[LIGNE_CLAVIER.BASCULE * LARGEUR_TEXTURE_CLAVIER + 32], 255);
});

test('EtatClavier : code hors plage ignoré sans exception', () => {
  const c = new EtatClavier();
  c.appuyer(-1);
  c.appuyer(256);
  c.relacher(999);
  assert.ok(c.octets.every((o) => o === 0));
});

// ---------------------------------------------------------------------------
// typesCanauxDe / resoudreSourcesCanaux
// ---------------------------------------------------------------------------

test('typesCanauxDe : type texture par défaut pour un canal sans entrée', () => {
  const normalise = parserShader({ info: {}, renderpass: [passe('image')] });
  assert.deepEqual(typesCanauxDe(normalise.image), ['texture', 'texture', 'texture', 'texture']);
});

test('typesCanauxDe : reprend le type de chaque entrée au bon canal', () => {
  const shader = { info: {}, renderpass: [passe('image', { inputs: [{ channel: 2, ctype: 'keyboard' }] })] };
  const normalise = parserShader(shader);
  assert.deepEqual(typesCanauxDe(normalise.image), ['texture', 'texture', 'keyboard', 'texture']);
});

test('resoudreSourcesCanaux : lie un canal buffer à la lettre dont la sortie correspond', () => {
  const normalise = parserShader(shaderMultipasseAvecGraphe());
  const sources = resoudreSourcesCanaux(normalise.image, normalise);
  assert.deepEqual(sources[0], { genre: 'buffer', lettre: 'A', echantillonnage: normalise.image.entrees[0].echantillonnage });
  assert.equal(sources[1], 'aucune');
});

test('resoudreSourcesCanaux : lie un canal cubemap à la passe cubemap dont la sortie correspond', () => {
  const normalise = parserShader(shaderCubemap());
  const sources = resoudreSourcesCanaux(normalise.image, normalise);
  assert.deepEqual(sources[0], { genre: 'cubemap', nom: 'Cube A', echantillonnage: normalise.image.entrees[0].echantillonnage });
});

test('resoudreSourcesCanaux : canal clavier reconnu quelle que soit sa cible', () => {
  const shader = { info: {}, renderpass: [passe('image', { inputs: [{ channel: 0, ctype: 'keyboard' }] })] };
  const normalise = parserShader(shader);
  assert.equal(resoudreSourcesCanaux(normalise.image, normalise)[0], 'keyboard');
});

test('resoudreSourcesCanaux : type texture/volume/vidéo référencé comme média (src transmis), résolu ailleurs (media.js/app.js)', () => {
  const shader = { info: {}, renderpass: [passe('image', { inputs: [{ channel: 0, ctype: 'texture', src: '/media/a/x.jpg' }] })] };
  const normalise = parserShader(shader);
  const source = resoudreSourcesCanaux(normalise.image, normalise)[0];
  assert.deepEqual(source, { genre: 'media', src: '/media/a/x.jpg', type: 'texture', echantillonnage: normalise.image.entrees[0].echantillonnage });
});

test('resoudreSourcesCanaux : canal buffer dont la cible n\'existe pas (shader incomplet) retombe sur un média sans src (texture de repli au rendu)', () => {
  const shader = { info: {}, renderpass: [passe('image', { inputs: [{ channel: 0, ctype: 'buffer', id: 'inconnu' }] })] };
  const normalise = parserShader(shader);
  const source = resoudreSourcesCanaux(normalise.image, normalise)[0];
  assert.deepEqual(source, { genre: 'media', src: null, type: 'buffer', echantillonnage: normalise.image.entrees[0].echantillonnage });
});

// ---------------------------------------------------------------------------
// convertirShaderNormalise
// ---------------------------------------------------------------------------

test('convertirShaderNormalise : convertit common, buffers, cubemaps et image, sans toucher au reste', () => {
  const normalise = parserShader(shaderMultipasseAvecGraphe());
  const ancien = 'vec4 f(sampler2D s, vec2 p) { return texture2D(s, p); }';
  normalise.commun = { ...normalise.commun, code: ancien };
  normalise.image = { ...normalise.image, code: ancien };
  for (const lettre of Object.keys(normalise.buffers)) normalise.buffers[lettre] = { ...normalise.buffers[lettre], code: ancien };

  const converti = convertirShaderNormalise(normalise);
  const attendu = 'vec4 f(sampler2D s, vec2 p) { return texture(s, p); }';
  assert.equal(converti.commun.code, attendu);
  assert.equal(converti.image.code, attendu);
  for (const lettre of Object.keys(normalise.buffers)) assert.equal(converti.buffers[lettre].code, attendu);
  assert.deepEqual(converti.ordreBuffers, normalise.ordreBuffers);
  assert.deepEqual(converti.image.entrees, normalise.image.entrees);
  assert.equal(normalise.image.code, ancien, 'l\'original n\'est pas modifié');
});

test('convertirShaderNormalise : cubemaps convertis, common absent conservé à null', () => {
  const normalise = parserShader(shaderCubemap());
  normalise.cubemaps = Object.fromEntries(Object.entries(normalise.cubemaps).map(([nom, p]) => [nom, { ...p, code: 'x = textureCube(t, d);' }]));
  const converti = convertirShaderNormalise(normalise);
  for (const p of Object.values(converti.cubemaps)) assert.equal(p.code, 'x = texture(t, d);');
  assert.equal(converti.commun, null);
});
