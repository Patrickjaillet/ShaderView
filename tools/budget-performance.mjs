#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Budget de performance en navigateur réel (Chromium, Chrome ou Edge sans écran, rendu logiciel SwiftShader) :
//   1. démarrage : « DOMContentLoaded » et affichage de la liste du catalogue ;
//   2. stabilité : après un échauffement, 100 changements de shader ne doivent faire croître ni le nombre d'objets
//      WebGL vivants (textures, programmes, tampons de cadre, tampons), ni le nombre de contextes, ni le tas JavaScript
//      (après ramasse-miettes), ni le nombre de nœuds du document.
// Les seuils de démarrage sont larges (le rendu logiciel est lent) ; les seuils de stabilité sont stricts.
// Usage : node tools/budget-performance.mjs [--navigateur CHEMIN] [--selections N]
// Code de sortie : 0 si le budget est respecté, 1 sinon.

import { fileURLToPath } from 'node:url';
import { demarrerServeur, lancerNavigateur, trouverNavigateur } from './regression-visuelle.mjs';

const RACINE = fileURLToPath(new URL('..', import.meta.url));

/** Seuils du budget. */
export const BUDGET = Object.freeze({
  demarrageDclMs: 3000,
  listeAfficheeMs: 6000,
  croissanceObjetsGl: 0,
  croissanceContextes: 0,
  croissanceTasMo: 15,
  croissanceNoeuds: 50,
  selectionMoyenneMs: 8000,
});

// Shaders sans passe son (un rendu audio hors-ligne alourdirait inutilement la mesure), mono-passe, multipasse, cubemap déduit.
const SHADERS = ['Bump_Grid', 'Divers_003', 'Divers_054', 'Electric_Dr_Who_Waves', 'Sablier', 'Tunnel_324', 'Raymarching_190', 'Grand_Theft_Auto_BloodyStreets'];

// Compte les objets WebGL vivants (créés moins supprimés) et les contextes, avant tout script de la page.
const SONDE = `(() => {
  const vivants = { texture: 0, programme: 0, tamponCadre: 0, tampon: 0, shader: 0 };
  const P = WebGL2RenderingContext.prototype;
  const paires = [['createTexture', 'deleteTexture', 'texture'], ['createProgram', 'deleteProgram', 'programme'],
    ['createFramebuffer', 'deleteFramebuffer', 'tamponCadre'], ['createBuffer', 'deleteBuffer', 'tampon'], ['createShader', 'deleteShader', 'shader']];
  for (const [creer, supprimer, cle] of paires) {
    const c = P[creer]; const s = P[supprimer];
    P[creer] = function (...a) { const o = c.apply(this, a); if (o) vivants[cle] += 1; return o; };
    P[supprimer] = function (o, ...a) { if (o) vivants[cle] -= 1; return s.call(this, o, ...a); };
  }
  let contextes = 0;
  const gc = HTMLCanvasElement.prototype.getContext;
  const vus = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (type, ...a) { const r = gc.call(this, type, ...a); if (r && !vus.has(this) && String(type).startsWith('webgl')) { vus.add(this); contextes += 1; } return r; };
  window.__sonde = () => ({ ...vivants, contextes });
})();`;

const pause = (ms) => new Promise((resolu) => setTimeout(resolu, ms));

/**
 * Évalue un relevé du budget (pure) : liste des dépassements.
 * @param {{ dcl: number, listeMs: number, selectionMoyenneMs: number }} demarrage
 * @param {{ gl: Record<string, number>, contextes: number, tasMo: number, noeuds: number }} base relevé après échauffement
 * @param {{ gl: Record<string, number>, contextes: number, tasMo: number, noeuds: number }} fin relevé final
 * @param {typeof BUDGET} [budget]
 * @returns {string[]}
 */
export function evaluerBudget(demarrage, base, fin, budget = BUDGET) {
  const problemes = [];
  if (demarrage.dcl > budget.demarrageDclMs) problemes.push(`DOMContentLoaded en ${demarrage.dcl} ms (budget ${budget.demarrageDclMs} ms)`);
  if (demarrage.listeMs > budget.listeAfficheeMs) problemes.push(`liste affichée en ${demarrage.listeMs} ms (budget ${budget.listeAfficheeMs} ms)`);
  if (demarrage.selectionMoyenneMs > budget.selectionMoyenneMs) problemes.push(`sélection moyenne ${Math.round(demarrage.selectionMoyenneMs)} ms (budget ${budget.selectionMoyenneMs} ms)`);
  for (const cle of Object.keys(base.gl)) {
    const delta = fin.gl[cle] - base.gl[cle];
    if (delta > budget.croissanceObjetsGl) problemes.push(`objets WebGL « ${cle} » : +${delta} après 100 sélections`);
  }
  if (fin.contextes - base.contextes > budget.croissanceContextes) problemes.push(`contextes WebGL : +${fin.contextes - base.contextes}`);
  if (fin.tasMo - base.tasMo > budget.croissanceTasMo) problemes.push(`tas JavaScript : +${(fin.tasMo - base.tasMo).toFixed(1)} Mo (budget ${budget.croissanceTasMo} Mo)`);
  if (fin.noeuds - base.noeuds > budget.croissanceNoeuds) problemes.push(`nœuds du document : +${fin.noeuds - base.noeuds}`);
  return problemes;
}

async function principal() {
  const args = process.argv.slice(2);
  const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
  const selections = Number(valeur('--selections') ?? 100);
  const { serveur, port } = await demarrerServeur(RACINE);
  const { session, arreter } = await lancerNavigateur(trouverNavigateur(valeur('--navigateur')), 'about:blank');
  try {
    await session.envoyer('Page.enable');
    await session.envoyer('Page.addScriptToEvaluateOnNewDocument', { source: SONDE });
    await session.envoyer('HeapProfiler.enable');
    const debut = Date.now();
    await session.envoyer('Page.navigate', { url: `http://127.0.0.1:${port}/index.html` });
    let nombre = 0;
    while (nombre === 0 && Date.now() - debut < 30000) {
      await pause(50);
      try { nombre = await session.evaluer("document.querySelectorAll('#catalogue-liste li').length"); } catch { nombre = 0; }
    }
    const listeMs = Date.now() - debut;
    const dcl = await session.evaluer('Math.round(performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd)');
    if (nombre === 0) throw new Error('La liste du catalogue ne s’est pas affichée en 30 s.');

    const selectionner = async (nom) => {
      const t0 = Date.now();
      const ok = await session.evaluer(`(() => { const b = [...document.querySelectorAll('#catalogue-liste [data-cle]')].find((x) => x.dataset.cle.includes(${JSON.stringify(nom)})); if (!b) return false; b.click(); return true; })()`);
      if (!ok) throw new Error(`Shader « ${nom} » introuvable dans la liste.`);
      // Compilation et premier rendu synchrones dans le clic. L'horloge est ensuite arrêtée : en rendu logiciel, un shader qui
      // tourne en continu bloquerait la page des secondes entières et fausserait la mesure ; l'image reste rendue.
      await session.evaluer("(() => { const b = document.getElementById('transport-lecture'); if (b && b.getAttribute('aria-pressed') === 'true') b.click(); })()");
      await pause(250);
      if (process.env.BUDGET_DEBUG) console.error(`  sélection ${nom} : ${Date.now() - t0} ms`);
      return Date.now() - t0;
    };
    const releve = async () => {
      await session.envoyer('HeapProfiler.collectGarbage');
      await pause(100);
      return JSON.parse(await session.evaluer(`JSON.stringify({ gl: (() => { const { contextes, ...gl } = window.__sonde(); return gl; })(), contextes: window.__sonde().contextes,
        tasMo: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 104857.6) / 10, noeuds: document.getElementsByTagName('*').length })`));
    };

    for (let i = 0; i < 2 * SHADERS.length; i += 1) await selectionner(SHADERS[i % SHADERS.length]);
    const base = await releve();
    let total = 0;
    for (let i = 0; i < selections; i += 1) total += await selectionner(SHADERS[i % SHADERS.length]);
    const fin = await releve();

    console.log(`Démarrage : DOMContentLoaded ${dcl} ms, liste (${nombre} entrées) affichée après ${listeMs} ms`);
    console.log(`${selections} sélections de ${SHADERS.length} shaders (mono-passe, multipasse, cubemap déduit) : ${(total / selections).toFixed(0)} ms en moyenne, 250 ms d'attente comprises`);
    console.log(`Objets WebGL vivants : ${JSON.stringify(base.gl)} → ${JSON.stringify(fin.gl)} ; contextes ${base.contextes} → ${fin.contextes}`);
    console.log(`Tas JavaScript : ${base.tasMo} → ${fin.tasMo} Mo ; nœuds du document : ${base.noeuds} → ${fin.noeuds}`);
    const problemes = evaluerBudget({ dcl, listeMs, selectionMoyenneMs: total / selections }, base, fin);
    if (problemes.length > 0) { console.error(`\nBudget dépassé :\n- ${problemes.join('\n- ')}`); process.exitCode = 1; } else console.log('\nBudget de performance respecté.');
  } finally {
    await arreter();
    serveur.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
