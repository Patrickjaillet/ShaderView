// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependancesNonConsignees, fichiersPublicationManquants } from '../tools/build.mjs';

test('dépôt : aucune dépendance non consignée et fichiers de publication présents', () => {
  assert.deepEqual(dependancesNonConsignees(), []);
  assert.deepEqual(fichiersPublicationManquants(), []);
});

test('dépendances : un fichier de js/vendor absent des avis est signalé', () => {
  const racine = mkdtempSync(join(tmpdir(), 'sv-build-'));
  mkdirSync(join(racine, 'js', 'vendor'), { recursive: true });
  writeFileSync(join(racine, 'THIRD_PARTY_NOTICES.md'), '| lib-a.js | 1.0 |');
  writeFileSync(join(racine, 'js', 'vendor', 'lib-a.js'), '');
  writeFileSync(join(racine, 'js', 'vendor', 'lib-b.js'), '');
  writeFileSync(join(racine, 'js', 'vendor', 'LICENSE-lib-a'), '');
  assert.deepEqual(dependancesNonConsignees(racine), ['js/vendor/lib-b.js']);
});

test('publication : les fichiers manquants sont listés', () => {
  const racine = mkdtempSync(join(tmpdir(), 'sv-pub-'));
  assert.ok(fichiersPublicationManquants(racine).includes('.nojekyll'));
});
