#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Contrôle de l'utilisation hors-ligne en navigateur réel (Chromium, Chrome ou Edge sans écran), sur une copie du site :
//   1. première visite : le Service Worker s'installe et prend le contrôle de la page ;
//   2. « Garder tout hors-ligne » charge le catalogue ;
//   3. le serveur est arrêté : la page se recharge et un shader jamais ouvert s'affiche depuis le cache ;
//   4. une nouvelle version du site est publiée : une proposition de mise à jour apparaît, l'ancienne version reste
//      en place jusqu'au clic sur « Recharger », puis seule la nouvelle coque subsiste.
// Usage : node tools/controle-hors-ligne.mjs [--navigateur CHEMIN]
// Code de sortie : 0 si tout est conforme, 1 sinon.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contenuAttendu } from './generer-sw.mjs';
import { demarrerServeur, lancerNavigateur, trouverNavigateur } from './regression-visuelle.mjs';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolu) => setTimeout(resolu, ms));

async function attendre(session, expression, delaiMs = 20000) {
  const debut = Date.now();
  for (;;) {
    let valeur = null;
    try { valeur = await session.evaluer(expression); } catch { /* page en cours de rechargement */ }
    if (valeur) return valeur;
    if (Date.now() - debut > delaiMs) throw new Error(`Délai dépassé : ${expression}`);
    await pause(100);
  }
}

function copierSite() {
  const copie = mkdtempSync(join(tmpdir(), 'shaderview-site-'));
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) cpSync(join(RACINE, f), join(copie, f));
  for (const d of ['css', 'js', 'branding', 'shaders']) cpSync(join(RACINE, d), join(copie, d), { recursive: true });
  mkdirSync(join(copie, 'audio'));
  writeFileSync(join(copie, 'audio', 'manifest.json'), JSON.stringify({ pistes: [] }));
  return copie;
}

const selectionner = (nom) => `(() => { const b = [...document.querySelectorAll('#catalogue-liste [data-cle]')].find((x) => x.dataset.cle.includes(${JSON.stringify(nom)})); if (!b) return false; b.click(); return true; })()`;

async function principal() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--navigateur');
  const copie = copierSite();
  let { serveur, port } = await demarrerServeur(copie);
  const { session, arreter } = await lancerNavigateur(trouverNavigateur(i >= 0 ? args[i + 1] : null), `http://127.0.0.1:${port}/index.html`);
  const echecs = [];
  const verifier = (condition, message) => { console.log(`${condition ? '✓' : '✗'} ${message}`); if (!condition) echecs.push(message); };
  try {
    // 1. Première visite.
    await attendre(session, "document.querySelectorAll('#catalogue-liste li').length > 0");
    await attendre(session, 'navigator.serviceWorker.controller !== null');
    verifier(true, 'Service Worker installé, il contrôle la page');

    // 2. Tout garder hors-ligne.
    await session.evaluer("document.getElementById('btn-diagnostic').click()");
    await session.evaluer("document.getElementById('diagnostic-hors-ligne').click()");
    const etatFinal = await attendre(session, "(() => { const t = document.getElementById('diagnostic-etat').textContent; return /hors-ligne|offline/i.test(t) && !/…/.test(t) ? t : null; })()", 120000);
    verifier(/\b4\d\d\b/.test(etatFinal), `préparation hors-ligne : « ${etatFinal} »`);
    await session.evaluer("document.getElementById('diagnostic-fermer').click()");

    // 3. Serveur arrêté : rechargement et shader jamais ouvert.
    serveur.closeAllConnections?.();
    await new Promise((resolu) => serveur.close(resolu));
    await session.envoyer('Page.reload');
    const nombre = await attendre(session, "(() => { const n = document.querySelectorAll('#catalogue-liste li').length; return n > 0 ? n : null; })()");
    verifier(nombre > 400, `serveur arrêté : la page se recharge et la liste affiche ${nombre} entrées`);
    await attendre(session, selectionner('Divers_054'));
    const titre = await attendre(session, "(() => { const t = document.getElementById('detail-titre').textContent; return t.includes('Divers 054') ? t : null; })()");
    const alerte = await session.evaluer("document.getElementById('detail-alerte').hidden ? null : document.getElementById('detail-alerte').textContent");
    verifier(titre !== null && alerte === null, `serveur arrêté : « ${titre} » (jamais ouvert) s'affiche sans erreur`);
    const voyants = await session.evaluer("document.getElementById('viewport').width");
    verifier(voyants === 800, 'serveur arrêté : le viewport 800 × 450 est actif');

    // 4. Nouvelle version : proposition, pas de remplacement tant qu'on n'accepte pas.
    const versionAvant = (await session.evaluer("caches.keys().then((k) => k.filter((n) => n.startsWith('shaderview-coque-')).join(','))"));
    const modifie = join(copie, 'js', 'diagnostic.js');
    writeFileSync(modifie, `${readFileSync(modifie, 'utf8')}\n// version suivante\n`);
    const swSource = readFileSync(join(copie, 'sw.js'), 'utf8');
    writeFileSync(join(copie, 'sw.js'), contenuAttendu(swSource, copie));
    ({ serveur } = await demarrerServeur(copie, port));
    await session.envoyer('Page.reload');
    await attendre(session, "document.getElementById('bandeau-maj') && !document.getElementById('bandeau-maj').hidden", 30000);
    const pendantAttente = await session.evaluer("caches.keys().then((k) => k.filter((n) => n.startsWith('shaderview-coque-')).length)");
    verifier(pendantAttente === 2, `nouvelle version proposée, ancienne et nouvelle coques présentes (${pendantAttente})`);
    await session.evaluer("document.getElementById('btn-maj').click()");
    await attendre(session, "document.querySelectorAll('#catalogue-liste li').length > 0 && navigator.serviceWorker.controller !== null", 30000);
    const apres = await attendre(session, "caches.keys().then((k) => { const c = k.filter((n) => n.startsWith('shaderview-coque-')); return c.length === 1 ? c.join(',') : null; })", 30000);
    verifier(apres !== versionAvant, `après « Recharger » : une seule coque, la nouvelle (${versionAvant} → ${apres})`);
  } finally {
    await arreter();
    serveur.closeAllConnections?.();
    serveur.close();
    try { rmSync(copie, { recursive: true, force: true }); } catch { /* nettoyage du dossier temporaire */ }
  }
  if (echecs.length > 0) { console.error(`\n${echecs.length} échec(s) :\n- ${echecs.join('\n- ')}`); process.exit(1); }
  console.log('\nUtilisation hors-ligne : tout est conforme.');
  process.exit(0);
}

principal().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
