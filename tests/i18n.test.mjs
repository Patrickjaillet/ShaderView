// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appliquerTraductions, definirLangue, initialiserLangue, langue, traduire } from '../js/i18n.js';

test('traduire : français par défaut et remplace les variables de message', () => {
  initialiserLangue({ stockage: { getItem: () => null }, document: null });
  assert.equal(langue(), 'fr');
  assert.equal(traduire('transport.time', { current: '1.25', total: '60.00' }), '1.25 s / 60.00 s');
});

test('traduire : anglais complet pour les commandes de transport et les libellés', () => {
  definirLangue('en', { stockage: null, document: null });
  assert.equal(traduire('transport.play'), 'Play');
  assert.equal(traduire('export.fps30'), '30 fps');
  assert.equal(traduire('catalog.searchPlaceholder'), 'Search (title, author, tag…)');
});

test('definirLangue applique les textes et attributs traduits au document', () => {
  const element = {
    dataset: { i18n: 'transport.reset', i18nAriaLabel: 'transport.position' },
    textContent: '',
    attributs: {},
    setAttribute(nom, valeur) { this.attributs[nom] = valeur; },
  };
  const document = {
    documentElement: { lang: '' },
    querySelectorAll: () => [element],
    dispatchEvent() {},
  };
  const stockage = { setItem() {} };
  definirLangue('fr', { document, stockage });
  appliquerTraductions(document);
  assert.equal(document.documentElement.lang, 'fr');
  assert.equal(element.textContent, 'Remettre à zéro');
  assert.equal(element.attributs['aria-label'], 'Position de lecture, en secondes');
});

test('definirLangue refuse une langue non prise en charge', () => {
  assert.throws(() => definirLangue('de', { document: null, stockage: null }), RangeError);
});
