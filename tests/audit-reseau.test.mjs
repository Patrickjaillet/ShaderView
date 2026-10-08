// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditerCsp, auditerDepot, auditerSource } from '../tools/audit-reseau.mjs';

test('le dépôt ne contient aucune requête réseau ni ressource externe', () => {
  const { anomalies } = auditerDepot();
  assert.deepEqual(anomalies, []);
});

test('auditerSource : détecte XHR, WebSocket, fetch non autorisé et URL externe', () => {
  assert.equal(auditerSource('js/x.js', 'new XMLHttpRequest();').length, 1);
  assert.equal(auditerSource('js/x.js', 'new WebSocket("wss://a");').length, 1);
  assert.equal(auditerSource('js/x.js', 'await fetch(adresse);').length, 1);
  assert.equal(auditerSource('js/catalog.js', 'await fetch(adresse);').length, 0);
  assert.equal(auditerSource('css/a.css', 'a { background: url(https://cdn.example/x.png); }').length, 1);
  assert.equal(auditerSource('index.html', '<script src="https://cdn.example/x.js"></script>').length, 1);
  assert.equal(auditerSource('index.html', '<a href="https://patrickjaillet.github.io/ShaderView">s</a>').length, 0);
});

test('auditerCsp : exige default-src et connect-src \'self\', refuse les origines externes', () => {
  assert.equal(auditerCsp('<html></html>').length, 1);
  const ok = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\'">';
  assert.deepEqual(auditerCsp(ok), []);
  const mauvais = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' https://x.io; script-src \'self\' \'unsafe-eval\'">';
  assert.equal(auditerCsp(mauvais).length, 3);
});
