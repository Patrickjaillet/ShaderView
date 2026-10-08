// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HAUTEUR_LIGNE, SEUIL_VIRTUALISATION, SURPLUS_LIGNES, calculerFenetre, defilementPour } from '../js/inspector.js';

test('calculerFenetre : en haut de liste, lignes visibles plus marge, espaceur du bas', () => {
  const f = calculerFenetre({ defilement: 0, hauteurVue: 450, total: 5000 });
  assert.equal(f.debut, 0);
  assert.equal(f.fin, Math.ceil(450 / HAUTEUR_LIGNE) + SURPLUS_LIGNES);
  assert.equal(f.espaceHaut, 0);
  assert.equal(f.espaceBas, (5000 - f.fin) * HAUTEUR_LIGNE);
  assert.equal(f.hauteurTotale, 5000 * HAUTEUR_LIGNE);
});

test('calculerFenetre : au milieu, marge de chaque côté, hauteur totale conservée par les espaceurs', () => {
  const defilement = 2000 * HAUTEUR_LIGNE;
  const f = calculerFenetre({ defilement, hauteurVue: 540, total: 5000 });
  assert.equal(f.debut, 2000 - SURPLUS_LIGNES);
  assert.equal(f.fin, 2000 + 6 + SURPLUS_LIGNES);
  assert.equal(f.espaceHaut + (f.fin - f.debut) * HAUTEUR_LIGNE + f.espaceBas, f.hauteurTotale);
});

test('calculerFenetre : en bas de liste, la fin est bornée, aucun espaceur inférieur', () => {
  const f = calculerFenetre({ defilement: 5000 * HAUTEUR_LIGNE, hauteurVue: 540, total: 5000 });
  assert.equal(f.fin, 5000);
  assert.equal(f.espaceBas, 0);
  assert.ok(f.debut >= 5000 - 6 - SURPLUS_LIGNES - 1);
});

test('calculerFenetre : liste vide, défilement négatif, vue nulle, peu d\'entrées', () => {
  assert.deepEqual(calculerFenetre({ defilement: 0, hauteurVue: 500, total: 0 }), { debut: 0, fin: 0, espaceHaut: 0, espaceBas: 0, hauteurTotale: 0 });
  assert.equal(calculerFenetre({ defilement: -50, hauteurVue: 500, total: 100 }).debut, 0);
  const peu = calculerFenetre({ defilement: 0, hauteurVue: 500, total: 3 });
  assert.deepEqual([peu.debut, peu.fin, peu.espaceBas], [0, 3, 0]);
  assert.ok(calculerFenetre({ defilement: 900, hauteurVue: 0, total: 100 }).fin >= calculerFenetre({ defilement: 900, hauteurVue: 0, total: 100 }).debut);
});

test('calculerFenetre : le nombre de lignes montées reste borné quelle que soit la taille du catalogue', () => {
  for (const total of [1001, 10_000, 1_000_000]) {
    const f = calculerFenetre({ defilement: Math.floor(total / 2) * HAUTEUR_LIGNE, hauteurVue: 800, total });
    assert.ok(f.fin - f.debut <= Math.ceil(800 / HAUTEUR_LIGNE) + 2 * SURPLUS_LIGNES + 1);
  }
});

test('defilementPour : ligne déjà visible inchangée, au-dessus ou au-dessous ramenée au bord', () => {
  const vue = { defilement: 1800, hauteurVue: 450 };
  assert.equal(defilementPour(22, vue), 1800, 'ligne 22 (1980–2070) visible');
  assert.equal(defilementPour(10, vue), 900, 'au-dessus : alignée en haut');
  assert.equal(defilementPour(40, vue), 40 * HAUTEUR_LIGNE + HAUTEUR_LIGNE - 450, 'au-dessous : alignée en bas');
  assert.equal(defilementPour(0, { defilement: 0, hauteurVue: 450 }), 0);
  assert.ok(defilementPour(1, { defilement: 0, hauteurVue: 50 }) >= 0);
});

test('seuil de virtualisation et pas de ligne alignés sur la feuille de style', () => {
  assert.equal(SEUIL_VIRTUALISATION, 1000);
  const css = readFileSync(new URL('../css/main.css', import.meta.url), 'utf8');
  const hauteur = Number(/\.catalogue__liste--virtuelle > li:not\(\.catalogue__espace\) \{\s*height: (\d+)px;\s*margin-bottom: (\d+)px;/.exec(css)?.slice(1).reduce((a, b) => Number(a) + Number(b)));
  assert.equal(hauteur, HAUTEUR_LIGNE, 'hauteur + marge de la ligne CSS = HAUTEUR_LIGNE');
});
