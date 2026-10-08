// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERVALLE_ECONOMIE_MS, ModeEconomie, batterieFaible } from '../js/economie.js';

function stockage(initial = null) {
  const donnees = new Map(initial === null ? [] : [['shaderview.economie', initial]]);
  return { donnees, getItem: (c) => donnees.get(c) ?? null, setItem: (c, v) => donnees.set(c, v) };
}

test('ModeEconomie : désactivé par défaut, choix mémorisé et relu', () => {
  const s = stockage();
  const mode = new ModeEconomie(s);
  assert.equal(mode.actif, false);
  assert.equal(mode.choixExplicite, null);
  mode.definir(true);
  assert.equal(s.donnees.get('shaderview.economie'), 'oui');
  assert.equal(new ModeEconomie(s).actif, true);
  mode.definir(false);
  assert.equal(new ModeEconomie(s).actif, false);
  assert.equal(new ModeEconomie(s).choixExplicite, false);
});

test('ModeEconomie : stockage absent ou en échec, aucune exception', () => {
  assert.equal(new ModeEconomie(null).actif, false);
  const casse = { getItem() { throw new Error('refusé'); }, setItem() { throw new Error('refusé'); } };
  const mode = new ModeEconomie(casse);
  mode.definir(true);
  assert.equal(mode.actif, true);
});

test('ModeEconomie.suggerer : seulement sans choix explicite, jamais mémorisé', () => {
  const s = stockage();
  const mode = new ModeEconomie(s);
  assert.equal(mode.suggerer(), true);
  assert.equal(mode.actif, true);
  assert.equal(mode.suggerer(), false, 'déjà actif');
  assert.equal(s.donnees.size, 0, 'une suggestion n\'est pas un choix');
  assert.equal(new ModeEconomie(s).actif, false);
  assert.equal(new ModeEconomie(stockage('non')).suggerer(), false, 'refus explicite respecté');
});

test('ModeEconomie.doitSauter : 30 i/s en lecture, rien hors économie, à l\'arrêt ou avant le premier rendu', () => {
  const mode = new ModeEconomie(stockage('oui'));
  assert.equal(mode.doitSauter(1016.7, 1000, true), true, 'image à 60 Hz suivante : sautée');
  assert.equal(mode.doitSauter(1033.3, 1000, true), false, 'une image sur deux est rendue');
  assert.equal(mode.doitSauter(1000 + INTERVALLE_ECONOMIE_MS, 1000, true), false);
  assert.equal(mode.doitSauter(1016, 1000, false), false, 'horloge arrêtée : rendu à la demande, jamais sauté');
  assert.equal(mode.doitSauter(1016, null, true), false);
  mode.definir(false);
  assert.equal(mode.doitSauter(1016, 1000, true), false);
});

test('ModeEconomie : sur un écran à 60 Hz, une image sur deux est sautée (cadence 30 i/s)', () => {
  const mode = new ModeEconomie(stockage('oui'));
  let dernier = null;
  let rendus = 0;
  for (let i = 0; i < 600; i += 1) {
    const t = i * (1000 / 60);
    if (mode.doitSauter(t, dernier, true)) continue;
    dernier = t;
    rendus += 1;
  }
  assert.equal(rendus, 300);
});

test('batterieFaible : niveau bas ET pas de recharge', () => {
  assert.equal(batterieFaible({ level: 0.15, charging: false }), true);
  assert.equal(batterieFaible({ level: 0.2, charging: false }), true);
  assert.equal(batterieFaible({ level: 0.15, charging: true }), false);
  assert.equal(batterieFaible({ level: 0.9, charging: false }), false);
  assert.equal(batterieFaible(null), false);
  assert.equal(batterieFaible({}), false);
});
