// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DUREE_PAR_DEFAUT_SECONDES,
  ECHANTILLONS_PAR_BLOC,
  TAILLE_BLOC_SON,
  TAILLE_FFT,
  appliquerFenetreHann,
  calculerFenetreTrame,
  calculerNombreBlocs,
  calculerNombreEchantillons,
  calculerSpectre,
  construireTextureVisualiseur,
  copierBlocVersEchantillons,
  fft,
} from '../js/audio.js';

// ---------------------------------------------------------------------------
// Dimensionnement des blocs
// ---------------------------------------------------------------------------

test('calculerNombreBlocs : un bloc couvre exactement sa capacité à 44100 Hz', () => {
  const dureeExacte = ECHANTILLONS_PAR_BLOC / 44100;
  assert.equal(calculerNombreBlocs(dureeExacte, 44100), 1);
});

test('calculerNombreBlocs : arrondit au bloc supérieur', () => {
  const dureeUnPeuPlus = (ECHANTILLONS_PAR_BLOC + 1) / 44100;
  assert.equal(calculerNombreBlocs(dureeUnPeuPlus, 44100), 2);
});

test('calculerNombreBlocs : durée nulle ou négative, zéro bloc', () => {
  assert.equal(calculerNombreBlocs(0, 44100), 0);
  assert.equal(calculerNombreBlocs(-5, 44100), 0);
});

test('calculerNombreEchantillons : proportionnel à la durée et à la fréquence', () => {
  assert.equal(calculerNombreEchantillons(1, 44100), 44100);
  assert.equal(calculerNombreEchantillons(2.5, 1000), 2500);
});

test('calculerNombreEchantillons : durée négative, zéro', () => {
  assert.equal(calculerNombreEchantillons(-1, 44100), 0);
});

test('DUREE_PAR_DEFAUT_SECONDES et TAILLE_BLOC_SON ont les valeurs documentées', () => {
  assert.equal(DUREE_PAR_DEFAUT_SECONDES, 60);
  assert.equal(TAILLE_BLOC_SON, 512);
  assert.equal(ECHANTILLONS_PAR_BLOC, 512 * 512);
});

// ---------------------------------------------------------------------------
// copierBlocVersEchantillons
// ---------------------------------------------------------------------------

function blocDeTest(n, valeurGauche, valeurDroite) {
  const pixels = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) { pixels[i * 4] = valeurGauche; pixels[i * 4 + 1] = valeurDroite; }
  return pixels;
}

test('copierBlocVersEchantillons : copie R vers gauche, G vers droite', () => {
  const pixels = blocDeTest(4, 0.5, -0.25);
  const gauche = new Float32Array(4);
  const droite = new Float32Array(4);
  copierBlocVersEchantillons(pixels, gauche, droite, 0, 4);
  assert.deepEqual(Array.from(gauche), [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(Array.from(droite), [-0.25, -0.25, -0.25, -0.25]);
});

test('copierBlocVersEchantillons : limite les valeurs à [-1, 1]', () => {
  const pixels = blocDeTest(2, 3.5, -7.2);
  const gauche = new Float32Array(2);
  const droite = new Float32Array(2);
  copierBlocVersEchantillons(pixels, gauche, droite, 0, 2);
  assert.deepEqual(Array.from(gauche), [1, 1]);
  assert.deepEqual(Array.from(droite), [-1, -1]);
});

test('copierBlocVersEchantillons : s\'arrête au nombre total d\'échantillons voulu (dernier bloc partiel)', () => {
  const pixels = blocDeTest(10, 1, 1);
  const gauche = new Float32Array(10);
  const droite = new Float32Array(10);
  copierBlocVersEchantillons(pixels, gauche, droite, 7, 10);
  assert.deepEqual(Array.from(gauche), [0, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
});

test('copierBlocVersEchantillons : décalage au-delà du total, ne copie rien', () => {
  const pixels = blocDeTest(4, 1, 1);
  const gauche = new Float32Array(4);
  const droite = new Float32Array(4);
  copierBlocVersEchantillons(pixels, gauche, droite, 10, 10);
  assert.deepEqual(Array.from(gauche), [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// calculerFenetreTrame
// ---------------------------------------------------------------------------

test('calculerFenetreTrame : en plein milieu du tampon, fenêtre entièrement valide', () => {
  const r = calculerFenetreTrame(2, 1000, 10000, 512);
  assert.equal(r.indexDebut, 2000 - 512);
  assert.equal(r.decalageSortie, 0);
  assert.equal(r.longueur, 512);
});

test('calculerFenetreTrame : au tout début (position 0), silence sur toute la fenêtre', () => {
  const r = calculerFenetreTrame(0, 1000, 10000, 512);
  assert.equal(r.indexDebut, 0);
  assert.equal(r.decalageSortie, 512);
  assert.equal(r.longueur, 0);
});

test('calculerFenetreTrame : fenêtre à cheval sur le début, partiellement valide', () => {
  const r = calculerFenetreTrame(0.1, 1000, 10000, 512);
  // indexFin = 100, fenêtre voudrait commencer à -412.
  assert.equal(r.indexDebut, 0);
  assert.equal(r.decalageSortie, 412);
  assert.equal(r.longueur, 100);
});

test('calculerFenetreTrame : position au-delà de la fin du tampon, bornée à la fin', () => {
  const r = calculerFenetreTrame(1000, 1000, 10000, 512);
  assert.equal(r.indexDebut, 10000 - 512);
  assert.equal(r.longueur, 512);
});

// ---------------------------------------------------------------------------
// fft
// ---------------------------------------------------------------------------

test('fft : détecte la fréquence d\'un ton pur au bon rang', () => {
  const n = TAILLE_FFT;
  const rang = 10;
  const reel = Float32Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * rang * i) / n));
  const imag = new Float32Array(n);
  fft(reel, imag);
  let rangMax = 0;
  let magnitudeMax = 0;
  for (let i = 0; i < n / 2; i += 1) {
    const magnitude = Math.hypot(reel[i], imag[i]);
    if (magnitude > magnitudeMax) { magnitudeMax = magnitude; rangMax = i; }
  }
  assert.equal(rangMax, rang);
});

test('fft : signal nul produit un spectre nul', () => {
  const n = TAILLE_FFT;
  const reel = new Float32Array(n);
  const imag = new Float32Array(n);
  fft(reel, imag);
  assert.ok(reel.every((v) => v === 0));
  assert.ok(imag.every((v) => v === 0));
});

test('fft : composante continue (signal constant) concentrée au rang 0', () => {
  const n = TAILLE_FFT;
  const reel = new Float32Array(n).fill(1);
  const imag = new Float32Array(n);
  fft(reel, imag);
  assert.ok(Math.abs(reel[0] - n) < 1e-3);
  for (let i = 1; i < n; i += 1) assert.ok(Math.hypot(reel[i], imag[i]) < 1e-3);
});

// ---------------------------------------------------------------------------
// appliquerFenetreHann
// ---------------------------------------------------------------------------

test('appliquerFenetreHann : atténue les bords à zéro, conserve le centre', () => {
  const signal = new Float32Array(TAILLE_FFT).fill(1);
  appliquerFenetreHann(signal);
  assert.ok(Math.abs(signal[0]) < 1e-6);
  assert.ok(Math.abs(signal[signal.length - 1]) < 1e-6);
  assert.ok(Math.abs(signal[Math.floor(signal.length / 2)] - 1) < 1e-2);
});

// ---------------------------------------------------------------------------
// calculerSpectre / construireTextureVisualiseur
// ---------------------------------------------------------------------------

test('calculerSpectre : longueur TAILLE_FFT / 2, valeurs dans [0, 1]', () => {
  const trame = Float32Array.from({ length: TAILLE_FFT }, (_, i) => Math.sin((2 * Math.PI * 20 * i) / TAILLE_FFT));
  const spectre = calculerSpectre(trame);
  assert.equal(spectre.length, TAILLE_FFT / 2);
  assert.ok(spectre.every((v) => v >= 0 && v <= 1));
});

test('calculerSpectre : silence produit un spectre quasi nul', () => {
  const spectre = calculerSpectre(new Float32Array(TAILLE_FFT));
  assert.ok(spectre.every((v) => v < 1e-3));
});

test('construireTextureVisualiseur : dimensions 512 × 2 RGBA, alpha opaque', () => {
  const trame = new Float32Array(TAILLE_FFT);
  const octets = construireTextureVisualiseur(trame);
  assert.equal(octets.length, TAILLE_FFT * 2 * 4);
  for (let i = 3; i < octets.length; i += 4) assert.equal(octets[i], 255);
});

test('construireTextureVisualiseur : silence, forme d\'onde au centre (0,5 → 128)', () => {
  const octets = construireTextureVisualiseur(new Float32Array(TAILLE_FFT));
  const indexOnde = (TAILLE_FFT + 5) * 4;
  assert.equal(octets[indexOnde], 128);
});

test('construireTextureVisualiseur : échantillon à +1 sature la forme d\'onde à 255', () => {
  const trame = new Float32Array(TAILLE_FFT);
  trame[3] = 1;
  const octets = construireTextureVisualiseur(trame);
  const indexOnde = (TAILLE_FFT + 3) * 4;
  assert.equal(octets[indexOnde], 255);
});
