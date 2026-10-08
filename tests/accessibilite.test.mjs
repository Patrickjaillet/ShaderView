// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../css/main.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const couleurs = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a, b) {
  const [clair, sombre] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (clair + 0.05) / (sombre + 0.05);
}

test('contraste : les couleurs de texte atteignent 4,5:1 (WCAG AA) sur les fonds', () => {
  for (const texte of ['texte', 'texte-discret', 'accent', 'erreur', 'attention']) {
    for (const fond of ['fond', 'fond-surface']) {
      const ratio = contraste(couleurs[texte], couleurs[fond]);
      assert.ok(ratio >= 4.5, `${texte} sur ${fond} : ${ratio.toFixed(2)}:1`);
    }
  }
});

test('focus : aucune règle ne supprime l’indicateur de focus sans le remplacer', () => {
  assert.ok(!/outline:\s*(none|0)\b/.test(css));
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
});

test('mouvement : prefers-reduced-motion est pris en charge', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('page : langue déclarée et titre présent', () => {
  assert.match(html, /<html[^>]*\slang="[a-z]{2}"/);
  assert.match(html, /<title>[^<]+<\/title>/);
});
