// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUDGET, evaluerBudget } from '../tools/budget-performance.mjs';

const demarrage = { dcl: 400, listeMs: 700, selectionMoyenneMs: 1200 };
const releve = (extra = {}) => ({ gl: { texture: 10, programme: 3, tamponCadre: 2 }, contextes: 2, tasMo: 3, noeuds: 4000, ...extra });

test('evaluerBudget : aucun dépassement quand tout est stable', () => {
  assert.deepEqual(evaluerBudget(demarrage, releve(), releve({ tasMo: 4.5, noeuds: 4010 })), []);
});

test('evaluerBudget : fuite d\'objets WebGL, de contextes, de mémoire ou de nœuds signalée', () => {
  const fin = releve({ gl: { texture: 12, programme: 3, tamponCadre: 2 }, contextes: 3, tasMo: 30, noeuds: 4200 });
  const problemes = evaluerBudget(demarrage, releve(), fin);
  assert.equal(problemes.length, 4);
  assert.ok(problemes.some((p) => /texture.*\+2/.test(p)));
  assert.ok(problemes.some((p) => /contextes/.test(p)));
  assert.ok(problemes.some((p) => /tas/.test(p)));
  assert.ok(problemes.some((p) => /nœuds/.test(p)));
});

test('evaluerBudget : démarrage et sélection trop lents signalés', () => {
  const p = evaluerBudget({ dcl: BUDGET.demarrageDclMs + 1, listeMs: BUDGET.listeAfficheeMs + 1, selectionMoyenneMs: BUDGET.selectionMoyenneMs + 1 }, releve(), releve());
  assert.equal(p.length, 3);
});

test('evaluerBudget : une décroissance (objets libérés) n\'est jamais un dépassement', () => {
  assert.deepEqual(evaluerBudget(demarrage, releve(), releve({ gl: { texture: 5, programme: 1, tamponCadre: 0 }, tasMo: 1, noeuds: 3000 })), []);
});
