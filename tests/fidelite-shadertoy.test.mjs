// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Phase 13 — fidélité Shadertoy : échantillonneurs 3D, filtrage et mipmaps, compatibilité GLSL, inférence des
// types de canaux, iChannelTime. Logique pure uniquement (le rendu réel est couvert par le banc de régression
// visuelle, tools/regression-visuelle.mjs, qui exige un navigateur).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SuiviLenteur,
  analyserCompatibilite,
  canauxMentionnes,
  choisirFiltres,
  construireDeclarationUniforms,
  construireFragmentShader,
  convertirGles1VersGles3,
  envoyerUniformsCanaux,
  filtrageLineaireCiblesPossible,
  lierCanal,
  mipmapsCiblesPossibles,
  rechercherTypesCanaux,
  ErreurCompilation,
} from '../js/renderer.js';
import { parserShader } from '../js/parser.js';
import { passe, shaderSimple } from './fixtures.mjs';

const GL = Object.freeze({ NEAREST: 9728, LINEAR: 9729, LINEAR_MIPMAP_LINEAR: 9987 });
const TOUT = { flottantsRenderables: true, filtrageLineaireFlottant: true, precisionHauteFragment: true };
const SANS_FILTRAGE_FLOTTANT = { flottantsRenderables: true, filtrageLineaireFlottant: false, precisionHauteFragment: true };
const SANS_FLOTTANTS = { flottantsRenderables: false, filtrageLineaireFlottant: false, precisionHauteFragment: true };

// ---------------------------------------------------------------------------
// En-tête et échantillonneurs
// ---------------------------------------------------------------------------

test('construireDeclarationUniforms : sampler3D pour un volume, samplerCube pour un cubemap, sampler2D sinon', () => {
  const declaration = construireDeclarationUniforms(['volume', 'cubemap', 'texture', 'keyboard']);
  assert.match(declaration, /uniform sampler3D iChannel0;/);
  assert.match(declaration, /uniform samplerCube iChannel1;/);
  assert.match(declaration, /uniform sampler2D iChannel2;/);
  assert.match(declaration, /uniform sampler2D iChannel3;/);
});

test('construireFragmentShader : précision sampler3D et macro HW_PERFORMANCE de Shadertoy', () => {
  const { source } = construireFragmentShader('void mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }', null);
  assert.match(source, /precision highp sampler3D;/);
  assert.match(source, /#define HW_PERFORMANCE 1/);
});

// ---------------------------------------------------------------------------
// Filtrage et mipmaps
// ---------------------------------------------------------------------------

test('choisirFiltres : une texture de média se filtre toujours, mipmap compris', () => {
  for (const extensions of [TOUT, SANS_FILTRAGE_FLOTTANT, SANS_FLOTTANTS]) {
    assert.deepEqual(choisirFiltres(GL, { filtre: 'linear' }, extensions, false), { min: GL.LINEAR, mag: GL.LINEAR });
    assert.deepEqual(choisirFiltres(GL, { filtre: 'mipmap' }, extensions, false), { min: GL.LINEAR_MIPMAP_LINEAR, mag: GL.LINEAR });
    assert.deepEqual(choisirFiltres(GL, { filtre: 'nearest' }, extensions, false), { min: GL.NEAREST, mag: GL.NEAREST });
  }
});

test('choisirFiltres : cible flottante, repli mipmap → linéaire → plus proche voisin selon le matériel', () => {
  assert.deepEqual(choisirFiltres(GL, { filtre: 'mipmap' }, TOUT, true), { min: GL.LINEAR_MIPMAP_LINEAR, mag: GL.LINEAR });
  // RGBA32F sans OES_texture_float_linear : ni linéaire ni mipmap.
  assert.deepEqual(choisirFiltres(GL, { filtre: 'mipmap' }, SANS_FILTRAGE_FLOTTANT, true), { min: GL.NEAREST, mag: GL.NEAREST });
  assert.deepEqual(choisirFiltres(GL, { filtre: 'linear' }, SANS_FILTRAGE_FLOTTANT, true), { min: GL.NEAREST, mag: GL.NEAREST });
  // RGBA16F (pas d'EXT_color_buffer_float) : toujours filtrable en linéaire, mais pas de mipmaps générés.
  assert.deepEqual(choisirFiltres(GL, { filtre: 'linear' }, SANS_FLOTTANTS, true), { min: GL.LINEAR, mag: GL.LINEAR });
  assert.deepEqual(choisirFiltres(GL, { filtre: 'mipmap' }, SANS_FLOTTANTS, true), { min: GL.LINEAR, mag: GL.LINEAR });
});

test('filtrageLineaireCiblesPossible et mipmapsCiblesPossibles suivent les extensions', () => {
  assert.equal(filtrageLineaireCiblesPossible(TOUT), true);
  assert.equal(filtrageLineaireCiblesPossible(SANS_FILTRAGE_FLOTTANT), false);
  assert.equal(filtrageLineaireCiblesPossible(SANS_FLOTTANTS), true);
  assert.equal(mipmapsCiblesPossibles(TOUT), true);
  assert.equal(mipmapsCiblesPossibles(SANS_FILTRAGE_FLOTTANT), false);
  assert.equal(mipmapsCiblesPossibles(SANS_FLOTTANTS), false);
});

test('lierCanal : cible 2D, cube ou 3D selon le genre, WRAP_R pour cube et 3D seulement', () => {
  const appels = [];
  const gl = {
    ...GL,
    TEXTURE0: 33984, TEXTURE_2D: 3553, TEXTURE_3D: 32879, TEXTURE_CUBE_MAP: 34067,
    TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240, TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, TEXTURE_WRAP_R: 32882,
    REPEAT: 10497, CLAMP_TO_EDGE: 33071,
    activeTexture: (unite) => appels.push(['unite', unite]),
    bindTexture: (cible) => appels.push(['liaison', cible]),
    texParameteri: (cible, nom) => appels.push(['param', cible, nom]),
  };
  const echantillonnage = { filtre: 'linear', repetition: 'repeat' };
  for (const [genre, cible, avecR] of [['2d', 3553, false], [false, 3553, false], ['cube', 34067, true], [true, 34067, true], ['3d', 32879, true]]) {
    appels.length = 0;
    lierCanal(gl, 2, {}, genre, echantillonnage, TOUT, false);
    assert.deepEqual(appels[0], ['unite', 33984 + 2]);
    assert.deepEqual(appels[1], ['liaison', cible]);
    assert.equal(appels.some((a) => a[0] === 'param' && a[2] === 32882), avecR, `WRAP_R pour ${String(genre)}`);
  }
});

// ---------------------------------------------------------------------------
// iChannelResolution / iChannelTime
// ---------------------------------------------------------------------------

function glEnregistreur() {
  const envois = {};
  return { envois, uniform3fv: (_, v) => { envois.resolution = [...v]; }, uniform1fv: (_, v) => { envois.temps = [...v]; } };
}

test('envoyerUniformsCanaux : profondeur d\'un volume dans iChannelResolution.z, 1 par défaut', () => {
  const gl = glEnregistreur();
  envoyerUniformsCanaux(gl, { iChannelResolution: {}, iChannelTime: null }, [{ largeur: 32, hauteur: 32, profondeur: 16 }, { largeur: 256, hauteur: 128 }], 0);
  assert.deepEqual(gl.envois.resolution, [32, 32, 16, 256, 128, 1, 0, 0, 1, 0, 0, 1]);
});

test('envoyerUniformsCanaux : iChannelTime par canal (tableau) ou répété (nombre)', () => {
  const gl = glEnregistreur();
  envoyerUniformsCanaux(gl, { iChannelResolution: null, iChannelTime: {} }, [], [0, 1.5, 0, 2.25]);
  assert.deepEqual(gl.envois.temps, [0, 1.5, 0, 2.25]);
  envoyerUniformsCanaux(gl, { iChannelResolution: null, iChannelTime: {} }, [], 3);
  assert.deepEqual(gl.envois.temps, [3, 3, 3, 3]);
  envoyerUniformsCanaux(gl, { iChannelResolution: null, iChannelTime: {} }, [], [4]);
  assert.deepEqual(gl.envois.temps, [4, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// Compatibilité GLSL et rapport
// ---------------------------------------------------------------------------

test('convertirGles1VersGles3 : retire la redéclaration d\'un uniform standard en gardant les numéros de ligne', () => {
  const code = [
    'uniform vec3 iResolution;',
    'uniform float iTime;',
    'uniform highp vec4 iMouse;',
    'uniform sampler2D iChannel0;',
    'uniform float iChannelTime[4];',
    'uniform float monReglage;',
    'void mainImage(out vec4 c, in vec2 p) { c = vec4(monReglage); }',
  ].join('\n');
  const converti = convertirGles1VersGles3(code);
  assert.equal(converti.split('\n').length, code.split('\n').length);
  assert.doesNotMatch(converti, /iResolution|iTime|iMouse|iChannel0|iChannelTime/);
  assert.match(converti, /uniform float monReglage;/);
});

test('convertirGles1VersGles3 : une utilisation d\'un uniform standard reste intacte', () => {
  const code = 'void mainImage(out vec4 c, in vec2 p) { c = vec4(p / iResolution.xy, iTime, 1.); }';
  assert.equal(convertirGles1VersGles3(code), code);
});

function shaderAvecCode(code) {
  return parserShader({ ver: '0.1', info: { id: 'XXXXXX', name: 'x', username: 'u', tags: [] }, renderpass: [passe('image', { code })] });
}

test('analyserCompatibilite : compte les conversions effectivement appliquées, hors commentaires', () => {
  const normalise = shaderAvecCode([
    '// texture2D(a, b) dans un commentaire',
    '/* textureCube(c, d) */',
    'void mainImage(out vec4 c, in vec2 p) {',
    '  c = texture2D(iChannel0, p) + texture2D(iChannel0, p * 2.) + texture2DLodEXT(iChannel1, p, 2.);',
    '}',
  ].join('\n'));
  const { conversions, avertissements } = analyserCompatibilite(normalise);
  assert.deepEqual(avertissements, []);
  assert.deepEqual(conversions.map((c) => [c.passe, c.de, c.vers, c.occurrences]), [
    ['image', 'texture2DLodEXT', 'textureLod', 1],
    ['image', 'texture2D', 'texture', 2],
  ]);
});

test('analyserCompatibilite : mainVR signalée, uniform redéclaré listé, shader moderne sans rapport', () => {
  const vr = analyserCompatibilite(shaderAvecCode('void mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }\nvoid mainVR(out vec4 c, in vec2 p, in vec3 o, in vec3 d) { c = vec4(d, 1.); }'));
  assert.deepEqual(vr.avertissements, [{ code: 'mainVR', passe: 'image' }]);
  const uniforme = analyserCompatibilite(shaderAvecCode('uniform float iTime;\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(iTime); }'));
  assert.deepEqual(uniforme.conversions.map((c) => c.de), ['uniform iTime']);
  const moderne = analyserCompatibilite(shaderAvecCode('void mainImage(out vec4 c, in vec2 p) { c = texture(iChannel0, p); }'));
  assert.deepEqual(moderne, { conversions: [], avertissements: [] });
});

test('analyserCompatibilite : une mention de mainVR dans un commentaire n\'est pas un avertissement', () => {
  const { avertissements } = analyserCompatibilite(shaderAvecCode('// void mainVR( ) non défini\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }'));
  assert.deepEqual(avertissements, []);
});

// ---------------------------------------------------------------------------
// Inférence des types d'échantillonneur des canaux sans entrée
// ---------------------------------------------------------------------------

test('canauxMentionnes : seuls les canaux libres cités sur une ligne en erreur sont retenus', () => {
  const code = 'a\nvec3 c = texture(iChannel1, v).rgb + texture(iChannel0, uv).rgb;\nb\nx = iChannel2;';
  assert.deepEqual(canauxMentionnes(code, [{ ligne: 2 }], new Set([1, 2, 3])), [1]);
  assert.deepEqual(canauxMentionnes(code, [{ ligne: 2 }, { ligne: 4 }], new Set([0, 1, 2])).sort(), [0, 1, 2]);
  assert.deepEqual(canauxMentionnes(code, [{ ligne: null }, { ligne: 99 }], new Set([0, 1, 2])), []);
});

function erreurSur(ligne) {
  return new ErreurCompilation('échec', [{ ligne, colonne: null, message: 'x', brut: 'x' }]);
}

test('rechercherTypesCanaux : sans erreur, aucune exploration (un seul essai)', () => {
  let essais = 0;
  const r = rechercherTypesCanaux(() => { essais += 1; return { ok: true, valeur: 'v' }; }, ['texture', 'texture', 'texture', 'texture'], new Set([0, 1, 2, 3]), 'code');
  assert.equal(r.ok, true);
  assert.equal(essais, 1);
  assert.deepEqual(r.types, ['texture', 'texture', 'texture', 'texture']);
});

test('rechercherTypesCanaux : un canal lu en vec3 devient cubemap (essayé avant volume)', () => {
  const code = 'texture(iChannel1, d);';
  const essayes = [];
  const r = rechercherTypesCanaux((types) => {
    essayes.push(types[1]);
    return types[1] === 'cubemap' ? { ok: true, valeur: 'ok' } : { ok: false, erreur: erreurSur(1) };
  }, ['texture', 'texture', 'texture', 'texture'], new Set([1]), code);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['texture', 'cubemap', 'texture', 'texture']);
  assert.deepEqual(essayes, ['texture', 'cubemap']);
});

test('rechercherTypesCanaux : volume quand le cubemap échoue aussi, deux canaux indépendants', () => {
  const code = 'texture(iChannel0, a);\ntexture(iChannel2, b);';
  const r = rechercherTypesCanaux((types) => {
    const bon = types[0] === 'volume' && types[2] === 'cubemap';
    if (bon) return { ok: true, valeur: 'ok' };
    return { ok: false, erreur: new ErreurCompilation('échec', [
      ...(types[0] === 'volume' ? [] : [{ ligne: 1, colonne: null, message: 'x', brut: 'x' }]),
      ...(types[2] === 'cubemap' ? [] : [{ ligne: 2, colonne: null, message: 'x', brut: 'x' }]),
    ]) };
  }, ['texture', 'texture', 'texture', 'texture'], new Set([0, 2]), code);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['volume', 'texture', 'cubemap', 'texture']);
});

test('rechercherTypesCanaux : un canal déclaré (non libre) n\'est jamais modifié, l\'erreur d\'origine est renvoyée', () => {
  const code = 'texture(iChannel1, d);';
  let essais = 0;
  const premiere = erreurSur(1);
  const r = rechercherTypesCanaux(() => { essais += 1; return { ok: false, erreur: essais === 1 ? premiere : erreurSur(1) }; }, ['texture', 'texture', 'texture', 'texture'], new Set([0, 2, 3]), code);
  assert.equal(r.ok, false);
  assert.equal(r.erreur, premiere);
  assert.equal(essais, 1);
});

test('rechercherTypesCanaux : le budget borne le nombre de compilations', () => {
  const code = 'texture(iChannel0, a) + texture(iChannel1, a) + texture(iChannel2, a) + texture(iChannel3, a);';
  let essais = 0;
  const r = rechercherTypesCanaux(() => { essais += 1; return { ok: false, erreur: erreurSur(1) }; }, ['texture', 'texture', 'texture', 'texture'], new Set([0, 1, 2, 3]), code, { budget: 7 });
  assert.equal(r.ok, false);
  assert.equal(essais, 7);
});

// ---------------------------------------------------------------------------
// Garde-fou de lenteur
// ---------------------------------------------------------------------------

test('SuiviLenteur : alerte une seule fois après assez de mesures lentes consécutives', () => {
  const suivi = new SuiviLenteur(12, 3);
  assert.equal(suivi.observer(5), false);
  assert.equal(suivi.observer(5), false);
  assert.equal(suivi.observer(5), true);
  assert.equal(suivi.observer(5), false, 'pas de seconde alerte');
  suivi.reinitialiser();
  assert.equal(suivi.observer(5), false);
});

test('SuiviLenteur : une mesure rapide remet le compteur à zéro, les mesures nulles sont ignorées', () => {
  const suivi = new SuiviLenteur(12, 3);
  suivi.observer(5);
  suivi.observer(5);
  assert.equal(suivi.observer(60), false);
  assert.equal(suivi.observer(0), false);
  assert.equal(suivi.observer(Number.NaN), false);
  assert.equal(suivi.observer(5), false);
  assert.equal(suivi.observer(5), false);
  assert.equal(suivi.observer(5), true);
});

// ---------------------------------------------------------------------------
// Corpus : le shader simple de test reste analysable
// ---------------------------------------------------------------------------

test('analyserCompatibilite : accepte un shader normalisé minimal', () => {
  assert.deepEqual(analyserCompatibilite(parserShader(shaderSimple())), { conversions: [], avertissements: [] });
});
