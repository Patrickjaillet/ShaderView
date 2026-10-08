#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Contrôle de la liste virtualisée sur un très grand catalogue, en navigateur réel (Chromium, Chrome ou Edge sans écran) : le
// dossier shaders/ est copié dix fois (plus de 4 000 entrées) dans une copie temporaire du site, puis on vérifie que
//   - seules quelques dizaines de lignes existent dans le document, avec la bonne hauteur de défilement ;
//   - le défilement jusqu'en bas monte les dernières lignes ;
//   - la navigation au clavier fait défiler et sélectionne ;
//   - un filtre qui ramène la liste sous le seuil repasse en liste complète.
// Usage : node tools/controle-grand-catalogue.mjs [--navigateur CHEMIN] [--copies N]
// Code de sortie : 0 si tout est conforme, 1 sinon.

import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { construireManifeste, serialiser } from './build-manifest.mjs';
import { demarrerServeur, lancerNavigateur, trouverNavigateur } from './regression-visuelle.mjs';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolu) => setTimeout(resolu, ms));

async function attendre(session, expression, delaiMs = 20000) {
  const debut = Date.now();
  for (;;) {
    let valeur = null;
    try { valeur = await session.evaluer(expression); } catch { /* page en cours de chargement */ }
    if (valeur) return valeur;
    if (Date.now() - debut > delaiMs) throw new Error(`Délai dépassé : ${expression}`);
    await pause(100);
  }
}

function copierSiteAgrandi(copies) {
  const copie = mkdtempSync(join(tmpdir(), 'shaderview-grand-'));
  for (const f of ['index.html', 'manifest.webmanifest']) cpSync(join(RACINE, f), join(copie, f));
  for (const d of ['css', 'js', 'branding']) cpSync(join(RACINE, d), join(copie, d), { recursive: true });
  mkdirSync(join(copie, 'shaders'));
  mkdirSync(join(copie, 'audio'));
  writeFileSync(join(copie, 'audio', 'manifest.json'), JSON.stringify({ pistes: [] }));
  for (const nom of readdirSync(join(RACINE, 'shaders'))) {
    if (!nom.endsWith('.json') || nom === 'manifest.json') continue;
    for (let n = 0; n < copies; n += 1) copyFileSync(join(RACINE, 'shaders', nom), join(copie, 'shaders', n === 0 ? nom : nom.replace(/\.json$/, `__${n}.json`)));
  }
  writeFileSync(join(copie, 'shaders', 'manifest.json'), serialiser(construireManifeste(join(copie, 'shaders'))));
  return copie;
}

async function principal() {
  const args = process.argv.slice(2);
  const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
  const copies = Number(valeur('--copies') ?? 10);
  const copie = copierSiteAgrandi(copies);
  const { serveur, port } = await demarrerServeur(copie);
  const { session, arreter } = await lancerNavigateur(trouverNavigateur(valeur('--navigateur')), `http://127.0.0.1:${port}/index.html`);
  const echecs = [];
  const verifier = (condition, message) => { console.log(`${condition ? '✓' : '✗'} ${message}`); if (!condition) echecs.push(message); };
  try {
    await attendre(session, "document.querySelectorAll('#catalogue-liste li').length > 0", 60000);
    const etat = await session.evaluer("document.getElementById('catalogue-etat').textContent");
    const total = Number(/(\d+)/.exec(etat.replace(/\s/g, ''))?.[1]);
    verifier(total > 1000, `catalogue de ${total} entrées (« ${etat} »)`);
    const mesure = () => session.evaluer(`JSON.stringify({ lignes: document.querySelectorAll('#catalogue-liste .element').length, noeuds: document.getElementsByTagName('*').length,
      hauteur: document.getElementById('catalogue-liste').scrollHeight, defilement: document.getElementById('catalogue-liste').scrollTop,
      premier: document.querySelector('#catalogue-liste .element')?.getAttribute('aria-posinset'), taille: document.querySelector('#catalogue-liste .element')?.getAttribute('aria-setsize') })`).then(JSON.parse);

    const haut = await mesure();
    verifier(haut.lignes > 0 && haut.lignes < 60, `en haut : ${haut.lignes} lignes montées sur ${total}, ${haut.noeuds} nœuds au total`);
    verifier(Math.abs(haut.hauteur - total * 90) < 5, `hauteur de défilement ${haut.hauteur} px pour ${total} × 90 px`);
    verifier(haut.premier === '1' && Number(haut.taille) === total, `ARIA : position ${haut.premier} sur ${haut.taille}`);

    await session.evaluer("(() => { const l = document.getElementById('catalogue-liste'); l.scrollTop = l.scrollHeight; })()");
    await attendre(session, `(() => { const b = [...document.querySelectorAll('#catalogue-liste .element')]; return b.length > 0 && b[b.length - 1].getAttribute('aria-posinset') === '${total}'; })()`);
    const bas = await mesure();
    verifier(bas.lignes < 60, `en bas : ${bas.lignes} lignes montées, la dernière entrée (${total}) est présente`);

    // Navigation au clavier depuis le haut.
    await session.evaluer("(() => { const l = document.getElementById('catalogue-liste'); l.scrollTop = 0; })()");
    await attendre(session, "document.querySelector('#catalogue-liste .element')?.getAttribute('aria-posinset') === '1'");
    await session.evaluer("document.querySelector('#catalogue-liste .element').click()");
    await pause(500);
    await session.evaluer("(() => { const l = document.getElementById('catalogue-liste'); for (let i = 0; i < 25; i += 1) l.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); })()");
    await pause(800);
    const clavier = JSON.parse(await session.evaluer(`JSON.stringify({ defilement: document.getElementById('catalogue-liste').scrollTop,
      selection: document.querySelector('#catalogue-liste .element[aria-selected="true"]')?.getAttribute('aria-posinset') ?? null })`));
    verifier(clavier.selection === '26' && clavier.defilement > 0, `clavier : 25 flèches bas → ligne ${clavier.selection} sélectionnée et visible (défilement ${clavier.defilement})`);

    // Filtre : retour à la liste complète sous le seuil.
    await session.evaluer("(() => { const r = document.getElementById('catalogue-recherche'); r.value = 'Bump_Grid'; r.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await pause(500);
    const filtre = JSON.parse(await session.evaluer(`JSON.stringify({ virtuelle: document.getElementById('catalogue-liste').classList.contains('catalogue__liste--virtuelle'),
      lignes: document.querySelectorAll('#catalogue-liste .element').length })`));
    verifier(!filtre.virtuelle && filtre.lignes === copies, `filtre « Bump_Grid » : ${filtre.lignes} entrées, liste complète (non virtualisée)`);
  } finally {
    await arreter();
    serveur.closeAllConnections?.();
    serveur.close();
    try { rmSync(copie, { recursive: true, force: true }); } catch { /* nettoyage du dossier temporaire */ }
  }
  if (echecs.length > 0) { console.error(`\n${echecs.length} échec(s) :\n- ${echecs.join('\n- ')}`); process.exit(1); }
  console.log('\nGrand catalogue : tout est conforme.');
  process.exit(0);
}

principal().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
