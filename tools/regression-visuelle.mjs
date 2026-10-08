#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Banc de régression visuelle : rend chaque shader du corpus (tests/corpus/*.json, plus les fichiers de shaders/
// listés dans tests/corpus/catalogue.json) dans un navigateur Chromium sans écran, avec le vrai moteur de js/, à
// un instant fixe, puis compare l'image à la référence de tests/references/. Le rendu logiciel (SwiftShader) est
// déterministe sur une même machine ; la comparaison tolère de petits écarts d'arrondi entre pilotes.
//
// Les références sont des rendus de ShaderView relus et validés à l'œil : elles détectent une régression, elles ne
// prouvent pas l'identité avec Shadertoy.com (aucun accès réseau, par principe du projet).
//
// Usage :
//   node tools/regression-visuelle.mjs                     compare tout le corpus aux références
//   node tools/regression-visuelle.mjs --enregistrer       (ré)écrit les références
//   node tools/regression-visuelle.mjs --filtre bruit      limite aux entrées dont le nom contient « bruit »
//   node tools/regression-visuelle.mjs --navigateur CHEMIN navigateur Chromium (sinon SHADERVIEW_NAVIGATEUR, puis détection)
//   node tools/regression-visuelle.mjs --rapport DOSSIER   écrit les rendus courants (PNG) dans DOSSIER
//   node tools/regression-visuelle.mjs --fichier F.json --rapport D   rend un shader quelconque (diagnostic, sans comparaison)
//   node tools/regression-visuelle.mjs --export           exporte en navigateur réel (MP4, WebM, annulation) et relit les fichiers
//   node tools/regression-visuelle.mjs --sync-av          mesure l'écart audio/vidéo d'un export MP4 (AAC) et WebM (Opus)
//   node tools/regression-visuelle.mjs --perte-contexte   perd puis restaure le contexte WebGL pendant un rendu
//   node tools/regression-visuelle.mjs --compilation       compile (sans rendre) tous les shaders de shaders/ et liste les échecs
// Code de sortie : 0 si tout est conforme, 1 sinon.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparerImages, imageVariee } from './lib/comparaison.mjs';
import { decoderPng } from './lib/png.mjs';
import { analyserMp4, analyserWebm } from './lib/conteneurs.mjs';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const DOSSIER_CORPUS = join(RACINE, 'tests', 'corpus');
const DOSSIER_REFERENCES = join(RACINE, 'tests', 'references');
const TYPES_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg' };

const NAVIGATEURS_PAR_DEFAUT = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * Liste les entrées du corpus : les shaders synthétiques de tests/corpus/*.json et ceux de shaders/ listés dans
 * tests/corpus/catalogue.json. Chaque entrée porte un nom, le shader et ses réglages de rendu (`temps`, `fps`, `souris`).
 * @param {string} [racine]
 * @returns {{ nom: string, shader: object, options: object }[]}
 */
export function listerCorpus(racine = RACINE) {
  const dossier = join(racine, 'tests', 'corpus');
  const entrees = [];
  for (const fichier of readdirSync(dossier).sort()) {
    if (!fichier.endsWith('.json') || fichier === 'catalogue.json') continue;
    const shader = JSON.parse(readFileSync(join(dossier, fichier), 'utf8'));
    const { reglages = {}, ...reste } = shader;
    entrees.push({ nom: basename(fichier, '.json'), shader: reste, options: reglages });
  }
  const cheminCatalogue = join(dossier, 'catalogue.json');
  if (existsSync(cheminCatalogue)) {
    for (const { fichier, ...options } of JSON.parse(readFileSync(cheminCatalogue, 'utf8')).fichiers) {
      entrees.push({ nom: `catalogue-${basename(fichier, '.json')}`, shader: JSON.parse(readFileSync(join(racine, 'shaders', fichier), 'utf8')), options });
    }
  }
  return entrees;
}

/** Tous les shaders de shaders/ (un par fichier, le premier d'un export multiple). */
export function listerCatalogue(racine = RACINE) {
  const dossier = join(racine, 'shaders');
  const entrees = [];
  for (const fichier of readdirSync(dossier).sort()) {
    if (!fichier.endsWith('.json') || fichier === 'manifest.json') continue;
    const contenu = JSON.parse(readFileSync(join(dossier, fichier), 'utf8'));
    (Array.isArray(contenu) ? contenu : [contenu]).forEach((shader, i) => entrees.push({ nom: `${basename(fichier, '.json')}${i > 0 ? `#${i}` : ''}`, shader, options: {} }));
  }
  return entrees;
}

export function trouverNavigateur(demande) {
  const candidats = [demande, process.env.SHADERVIEW_NAVIGATEUR, ...NAVIGATEURS_PAR_DEFAUT].filter(Boolean);
  const trouve = candidats.find((chemin) => existsSync(chemin));
  if (trouve === undefined) throw new Error('Aucun navigateur Chromium trouvé : utiliser --navigateur CHEMIN ou SHADERVIEW_NAVIGATEUR.');
  return trouve;
}

export function demarrerServeur(racineBrute, portDemande = 0) {
  const racine = normalize(racineBrute).replace(/[\\/]+$/, '');
  const serveur = createServer((requete, reponse) => {
    let chemin = normalize(join(racine, decodeURIComponent(new URL(requete.url, 'http://x').pathname)));
    if (!chemin.startsWith(racine + sep) && chemin !== racine) { reponse.writeHead(403).end(); return; }
    try {
      if (statSync(chemin).isDirectory()) chemin = join(chemin, 'index.html');
      const contenu = readFileSync(chemin);
      reponse.writeHead(200, { 'Content-Type': TYPES_MIME[extname(chemin)] ?? 'application/octet-stream' });
      reponse.end(contenu);
    } catch {
      reponse.writeHead(404).end();
    }
  });
  return new Promise((resolu) => serveur.listen(portDemande, '127.0.0.1', () => resolu({ serveur, port: serveur.address().port })));
}

// Client minimal du protocole DevTools (WebSocket global de Node).
class SessionDevTools {
  constructor(socket) {
    this.socket = socket;
    this.suivant = 1;
    this.attentes = new Map();
    socket.addEventListener('message', (evenement) => {
      const message = JSON.parse(evenement.data);
      // Erreurs de la page (module non chargé, exception) : affichées, elles expliquent un banc qui ne répond pas.
      if (message.method === 'Runtime.exceptionThrown') console.error(`[page] ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') console.error(`[page] ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      const attente = this.attentes.get(message.id);
      if (attente === undefined) return;
      this.attentes.delete(message.id);
      if (message.error) attente.rejeter(new Error(message.error.message)); else attente.resoudre(message.result);
    });
  }

  static async ouvrir(url) {
    const socket = new WebSocket(url);
    await new Promise((resolu, rejeter) => { socket.addEventListener('open', resolu, { once: true }); socket.addEventListener('error', () => rejeter(new Error('Connexion DevTools impossible.')), { once: true }); });
    return new SessionDevTools(socket);
  }

  envoyer(methode, params = {}) {
    const id = this.suivant++;
    return new Promise((resoudre, rejeter) => {
      this.attentes.set(id, { resoudre, rejeter });
      this.socket.send(JSON.stringify({ id, method: methode, params }));
    });
  }

  async evaluer(expression) {
    const { result, exceptionDetails } = await this.envoyer('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }
}

const pause = (ms) => new Promise((resolu) => setTimeout(resolu, ms));

export async function lancerNavigateur(chemin, urlPage) {
  const profil = mkdtempSync(join(tmpdir(), 'shaderview-regression-'));
  const processus = spawn(chemin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profil}`, '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--hide-scrollbars', urlPage,
  ], { stdio: 'ignore' });
  const fichierPort = join(profil, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 100 && port === null; i += 1) {
    try {
      // Le navigateur peut encore écrire le fichier (EBUSY sous Windows) : réessayer au tour suivant.
      const lu = existsSync(fichierPort) ? Number(readFileSync(fichierPort, 'utf8').split('\n')[0]) : NaN;
      if (Number.isInteger(lu) && lu > 0) port = lu;
    } catch { /* fichier verrouillé ou incomplet */ }
    if (port === null) await pause(100);
  }
  if (port === null) { processus.kill(); throw new Error('Le navigateur ne s’est pas lancé (DevToolsActivePort absent).'); }
  let cible = null;
  for (let i = 0; i < 100 && cible === null; i += 1) {
    const cibles = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    cible = cibles.find((c) => c.type === 'page' && (c.url.startsWith('http://127.0.0.1') || c.url === urlPage)) ?? null;
    if (cible === null) await pause(100);
  }
  if (cible === null) { processus.kill(); throw new Error('Page de test introuvable dans le navigateur.'); }
  const session = await SessionDevTools.ouvrir(cible.webSocketDebuggerUrl);
  await session.envoyer('Runtime.enable');
  await session.envoyer('Page.reload');
  const arreter = async () => {
    try { session.socket.close(); } catch { /* déjà fermé */ }
    processus.kill();
    await pause(300);
    try { rmSync(profil, { recursive: true, force: true }); } catch { /* le navigateur libère le profil en retard : sans importance */ }
  };
  return { session, arreter };
}

async function principal() {
  const args = process.argv.slice(2);
  const valeur = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : null; };
  const enregistrer = args.includes('--enregistrer');
  const filtre = valeur('--filtre');
  const dossierRapport = valeur('--rapport');
  const compilation = args.includes('--compilation');
  const modeControle = ['--export', '--export-long', '--perte-contexte', '--sync-av'].some((o) => args.includes(o));
  const fichier = valeur('--fichier');
  const source = fichier !== null
    ? [{ nom: basename(fichier, '.json'), shader: JSON.parse(readFileSync(fichier, 'utf8')), options: {} }]
    : (compilation ? listerCatalogue() : listerCorpus());
  const entrees = source.filter((e) => filtre === null || e.nom.includes(filtre));
  if (entrees.length === 0) { console.error('Aucune entrée de corpus à traiter.'); process.exit(1); }
  mkdirSync(DOSSIER_REFERENCES, { recursive: true });
  if (dossierRapport !== null) mkdirSync(dossierRapport, { recursive: true });

  const { serveur, port } = await demarrerServeur(RACINE);
  const { session, arreter } = await lancerNavigateur(trouverNavigateur(valeur('--navigateur')), `http://127.0.0.1:${port}/tools/regression/page.html`);
  const echecs = [];
  try {
    for (let i = 0; i < 100 && (await session.evaluer('window.banc ?? null')) !== 'pret'; i += 1) await pause(100);
    if ((await session.evaluer('window.banc ?? null')) !== 'pret') {
      throw new Error(`Page de test non chargée : ${await session.evaluer('location.href + " | " + document.readyState')}`);
    }
    const shaderRetroaction = listerCorpus().find((e) => e.nom === 'buffer-retroaction').shader;
    if (args.includes('--perte-contexte')) {
      const r = JSON.parse(await session.evaluer(`window.perteContexteTest(${JSON.stringify(shaderRetroaction)}).then(JSON.stringify)`));
      if (r.ignore) console.log(`○ perte de contexte ignorée : ${r.ignore}`);
      else if (r.erreur || !r.identique || r.erreursGl.length > 0) echecs.push(`perte de contexte : ${r.erreur ?? `rendu ${r.identique ? 'identique' : 'DIFFÉRENT'} après restauration, erreurs WebGL ${r.erreursGl.join(',') || 'aucune'}`}`);
      else console.log(`✓ perte et restauration du contexte : rendu identique (rendu pendant la perte : ${r.renduPendantPerte ?? 'sans exception'})`);
    }
    if (args.includes('--sync-av')) {
      for (const format of ['mp4', 'webm']) {
        const r = JSON.parse(await session.evaluer(`window.syncAvTest({ format: ${JSON.stringify(format)} }).then(JSON.stringify)`));
        if (r.erreur) { echecs.push(`synchro A/V ${format} : ${r.erreur}`); console.log(`✗ synchro A/V ${format}`); continue; }
        const resume = `image blanche à ${r.instantVideo} s, clic à ${r.instantSon === null ? 'introuvable' : r.instantSon.toFixed(3)} s, écart ${r.ecartMs} ms (durées relues : vidéo ${r.dureeVideo?.toFixed(2)} s, audio ${r.dureeAudio?.toFixed(2)} s)`;
        // Tolérance : une image à 30 i/s (33 ms) de résolution temporelle de mesure, plus le retard d'amorçage d'un encodeur audio.
        if (r.ecartMs === null || Math.abs(r.ecartMs) > 80) { echecs.push(`synchro A/V ${format} : ${resume}`); console.log(`✗ synchro A/V ${format} : ${resume}`); }
        else console.log(`✓ synchro A/V ${format} : ${resume}`);
      }
    }
    if (args.includes('--export-long')) {
      // Export long en haute définition : le pic du tas JavaScript doit rester faible grâce au stockage temporaire OPFS.
      for (const format of ['mp4', 'webm']) {
        const options = { format, largeur: 1920, hauteur: 1080, fps: 60, duree: 10, bitrate: 8_000_000 };
        const r = JSON.parse(await session.evaluer(`window.exporterTest(${JSON.stringify(shaderRetroaction)}, ${JSON.stringify(options)}).then(JSON.stringify)`));
        if (r.ignore) { console.log(`○ export long ${format} ignoré : ${r.ignore}`); continue; }
        if (r.erreur) { echecs.push(`export long ${format} : ${r.erreur}`); console.log(`✗ export long ${format}`); continue; }
        const problemes = [];
        if (!r.lecture.ok) problemes.push('relecture impossible');
        else if (Math.abs(r.lecture.duree - 10) > 0.2 || r.lecture.largeur !== 1920) problemes.push(`relu ${r.lecture.duree} s ${r.lecture.largeur}×${r.lecture.hauteur}`);
        if (r.restesOpfs !== 0) problemes.push(`${r.restesOpfs} fichier(s) OPFS restant(s)`);
        console.log(`  export long ${format} : 1920×1080, 60 i/s, 10 s (600 images) en ${(r.ms / 1000).toFixed(1)} s, ${(r.taille / 1048576).toFixed(1)} Mo, pic du tas JS ${r.picTasMo} Mo, OPFS ${r.spoolActif ? 'utilisé' : 'non utilisé'}`);
        if (problemes.length > 0) { echecs.push(`export long ${format} : ${problemes.join(' ; ')}`); console.log(`✗ export long ${format}`); } else console.log(`✓ export long ${format}`);
      }
    }
    if (args.includes('--export')) {
      const cas = [
        { nom: 'mp4', options: { format: 'mp4' } },
        { nom: 'webm', options: { format: 'webm' } },
        { nom: 'mp4-annule', options: { format: 'mp4', annulerApres: 10 } },
      ];
      for (const { nom, options } of cas) {
        const r = JSON.parse(await session.evaluer(`window.exporterTest(${JSON.stringify(shaderRetroaction)}, ${JSON.stringify({ largeur: 320, hauteur: 180, fps: 30, duree: 1, ...options })}).then(JSON.stringify)`));
        if (r.ignore) { console.log(`○ export ${nom} ignoré : ${r.ignore}`); continue; }
        if (r.erreur) { echecs.push(`export ${nom} : ${r.erreur}`); console.log(`✗ export ${nom}`); continue; }
        const problemes = [];
        if (r.restesOpfs !== 0) problemes.push(`${r.restesOpfs} fichier(s) temporaire(s) OPFS restant(s)`);
        if (options.annulerApres !== undefined) {
          if (!r.annule) problemes.push('l’annulation n’a pas interrompu l’export');
          if (r.abandons < 1) problemes.push('le fichier partiel n’a pas été abandonné');
          if (r.fermeture !== 0) problemes.push('le flux a été fermé malgré l’annulation');
        } else {
          const octets = Buffer.from(r.base64, 'base64');
          if (dossierRapport !== null) writeFileSync(join(dossierRapport, `export.${options.format}`), octets);
          const structure = options.format === 'mp4' ? analyserMp4(octets) : analyserWebm(octets);
          problemes.push(...structure.erreurs);
          if (options.format === 'mp4' && (!structure.moovAvantMdat || structure.pistes !== 1)) problemes.push(`MP4 : moov avant mdat = ${structure.moovAvantMdat}, pistes = ${structure.pistes}`);
          if (r.fermeture !== 1) problemes.push(`flux fermé ${r.fermeture} fois`);
          if (!r.lecture.ok) problemes.push(`relecture dans <video> impossible (${r.lecture.message || `code ${r.lecture.code}`})`);
          else {
            if (Math.abs(r.lecture.duree - 1) > 0.15) problemes.push(`durée relue ${r.lecture.duree} s (1 s attendue)`);
            if (r.lecture.largeur !== 320 || r.lecture.hauteur !== 180) problemes.push(`dimensions relues ${r.lecture.largeur}×${r.lecture.hauteur}`);
            if (!(r.lecture.luminanceMoyenne > 3)) problemes.push(`image relue noire (luminance ${r.lecture.luminanceMoyenne})`);
          }
          console.log(`  ${nom} : ${r.taille} octets en ${r.ms} ms, OPFS ${r.opfsDisponible ? (r.spoolActif ? 'utilisé' : 'disponible mais non utilisé') : 'indisponible'}, relecture ${r.lecture.ok ? `${r.lecture.duree.toFixed(2)} s ${r.lecture.largeur}×${r.lecture.hauteur}` : 'impossible'}`);
        }
        if (problemes.length > 0) { echecs.push(`export ${nom} : ${problemes.join(' ; ')}`); console.log(`✗ export ${nom}`); } else console.log(`✓ export ${nom}`);
      }
    }
    if (compilation) {
      let total = 0;
      for (const { nom, shader } of entrees) {
        total += 1;
        const r = JSON.parse(await session.evaluer(`JSON.stringify(window.compilerShader(${JSON.stringify(shader)}))`));
        if (!r.ok) echecs.push(`${nom} : ${r.erreur}${r.lignes ? ` | ${r.lignes.join(' | ')}` : ''}`);
      }
      console.log(`${total - echecs.length} / ${total} shaders compilent.`);
    }
    for (const { nom, shader, options } of compilation || modeControle ? [] : entrees) {
      const rendu = JSON.parse(await session.evaluer(`JSON.stringify(window.rendreShader(${JSON.stringify(shader)}, ${JSON.stringify(options)}))`));
      if (rendu.erreur !== undefined) { echecs.push(`${nom} : ${rendu.erreur}${rendu.lignes ? `\n    ${rendu.lignes.join('\n    ')}` : ''}`); console.log(`✗ ${nom} (erreur)`); continue; }
      const octets = Buffer.from(rendu.png.replace(/^data:image\/png;base64,/, ''), 'base64');
      if (dossierRapport !== null) writeFileSync(join(dossierRapport, `${nom}.png`), octets);
      if (rendu.erreursGl.length > 0) { echecs.push(`${nom} : erreurs WebGL ${rendu.erreursGl.join(', ')}`); console.log(`✗ ${nom} (WebGL)`); continue; }
      if (fichier !== null) { console.log(`● ${nom} rendu (diagnostic, aucune comparaison)`); continue; }
      const courante = decoderPng(octets);
      if (!imageVariee(courante) && !options.uni) { echecs.push(`${nom} : image de couleur unie (rendu vide ?)`); console.log(`✗ ${nom} (uni)`); continue; }
      const cheminReference = join(DOSSIER_REFERENCES, `${nom}.png`);
      if (enregistrer) { writeFileSync(cheminReference, octets); console.log(`● ${nom} enregistré`); continue; }
      if (!existsSync(cheminReference)) { echecs.push(`${nom} : référence absente (lancer avec --enregistrer)`); console.log(`✗ ${nom} (sans référence)`); continue; }
      const resultat = comparerImages(courante, decoderPng(readFileSync(cheminReference)));
      if (resultat.identiques) console.log(`✓ ${nom} (écart max ${resultat.ecartMax})`);
      else { echecs.push(`${nom} : ${resultat.raison ?? `${(resultat.partDifferente * 100).toFixed(2)} % de pixels différents, écart max ${resultat.ecartMax}`}`); console.log(`✗ ${nom}`); }
    }
  } finally {
    await arreter();
    serveur.close();
  }
  if (echecs.length > 0) { console.error(`\n${echecs.length} échec(s) :\n- ${echecs.join('\n- ')}`); process.exit(1); }
  if (modeControle) console.log('\nContrôles en navigateur réel : tout est conforme.');
  else console.log(enregistrer ? '\nRéférences enregistrées.' : '\nRégression visuelle : tout est conforme.');
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  principal().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
