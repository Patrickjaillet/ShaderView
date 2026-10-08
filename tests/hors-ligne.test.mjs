// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { calculerVersion, contenuAttendu, genererBloc, listerCoque } from '../tools/generer-sw.mjs';
import { enregistrerServiceWorker, etatHorsLigne, preparerHorsLigne, serviceWorkerPossible } from '../js/hors-ligne.js';

const RACINE = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// js/hors-ligne.js
// ---------------------------------------------------------------------------

function navigateurFactice({ controller = null, waiting = null, echecEnregistrement = false } = {}) {
  const ecouteursConteneur = new Map();
  const ecouteursRegistration = new Map();
  const registration = {
    waiting,
    installing: null,
    addEventListener: (nom, f) => ecouteursRegistration.set(nom, f),
    update: async () => { registration.misesAJour = (registration.misesAJour ?? 0) + 1; },
  };
  const conteneur = {
    controller,
    register: async (adresse) => { if (echecEnregistrement) throw new Error('refusé'); registration.adresse = adresse; return registration; },
    addEventListener: (nom, f) => ecouteursConteneur.set(nom, f),
  };
  return { navigateur: { serviceWorker: conteneur }, registration, ecouteursConteneur, ecouteursRegistration };
}

test('serviceWorkerPossible : exige l\'API et un contexte sécurisé', () => {
  assert.equal(serviceWorkerPossible({ serviceWorker: { register() {} } }, { isSecureContext: true }), true);
  assert.equal(serviceWorkerPossible({ serviceWorker: { register() {} } }, { isSecureContext: false }), false);
  assert.equal(serviceWorkerPossible({}, { isSecureContext: true }), false);
  assert.equal(serviceWorkerPossible(undefined, { isSecureContext: true }), false);
});

test('enregistrerServiceWorker : indisponible ou refusé, renvoie null sans exception', async () => {
  assert.equal(await enregistrerServiceWorker({ navigateur: {}, contexte: { isSecureContext: true }, surMiseAJour() {} }), null);
  const refuse = navigateurFactice({ echecEnregistrement: true });
  assert.equal(await enregistrerServiceWorker({ navigateur: refuse.navigateur, contexte: { isSecureContext: true }, surMiseAJour() {}, minuteur() {} }), null);
});

test('enregistrerServiceWorker : première installation, aucune proposition de mise à jour ni rechargement', async () => {
  const env = navigateurFactice({ controller: null });
  let propositions = 0;
  let rechargements = 0;
  await enregistrerServiceWorker({ navigateur: env.navigateur, contexte: { isSecureContext: true }, surMiseAJour: () => { propositions += 1; }, recharger: () => { rechargements += 1; }, minuteur() {} });
  assert.equal(env.registration.adresse, 'sw.js');
  const nouveau = { state: 'installing', postMessage() {}, addEventListener: (nom, f) => { nouveau.rappel = f; } };
  env.registration.installing = nouveau;
  env.ecouteursRegistration.get('updatefound')();
  nouveau.state = 'installed';
  nouveau.rappel();
  assert.equal(propositions, 0, 'aucun contrôleur : c\'est la première installation');
  env.ecouteursConteneur.get('controllerchange')();
  assert.equal(rechargements, 0);
});

test('enregistrerServiceWorker : une nouvelle version n\'est appliquée et la page rechargée qu\'après la demande', async () => {
  const env = navigateurFactice({ controller: {} });
  const messages = [];
  let appliquer = null;
  let rechargements = 0;
  await enregistrerServiceWorker({ navigateur: env.navigateur, contexte: { isSecureContext: true }, surMiseAJour: (f) => { appliquer = f; }, recharger: () => { rechargements += 1; }, minuteur() {} });
  const nouveau = { state: 'installing', postMessage: (m) => messages.push(m), addEventListener: (nom, f) => { nouveau.rappel = f; } };
  env.registration.installing = nouveau;
  env.ecouteursRegistration.get('updatefound')();
  nouveau.state = 'installed';
  nouveau.rappel();
  assert.equal(typeof appliquer, 'function');
  env.ecouteursConteneur.get('controllerchange')();
  assert.equal(rechargements, 0, 'changement de contrôleur sans demande : pas de rechargement');
  appliquer();
  assert.deepEqual(messages, ['activer']);
  env.ecouteursConteneur.get('controllerchange')();
  env.ecouteursConteneur.get('controllerchange')();
  assert.equal(rechargements, 1, 'un seul rechargement');
});

test('enregistrerServiceWorker : une version déjà en attente au chargement est proposée', async () => {
  const attente = { postMessage() {} };
  const env = navigateurFactice({ controller: {}, waiting: attente });
  let proposee = false;
  await enregistrerServiceWorker({ navigateur: env.navigateur, contexte: { isSecureContext: true }, surMiseAJour: () => { proposee = true; }, minuteur() {} });
  assert.equal(proposee, true);
});

test('enregistrerServiceWorker : vérification périodique, échec hors-ligne ignoré', async () => {
  const env = navigateurFactice({ controller: {} });
  let intervalle = null;
  const r = await enregistrerServiceWorker({ navigateur: env.navigateur, contexte: { isSecureContext: true }, surMiseAJour() {}, minuteur: (f, d) => { intervalle = d; } });
  assert.equal(intervalle, 3600 * 1000);
  await r.verifier();
  assert.equal(env.registration.misesAJour, 1);
  env.registration.update = async () => { throw new Error('hors-ligne'); };
  await assert.doesNotReject(r.verifier());
});

test('etatHorsLigne : possible et actif selon le contrôleur', () => {
  assert.deepEqual(etatHorsLigne({ serviceWorker: { register() {}, controller: {} } }, { isSecureContext: true }), { possible: true, actif: true });
  assert.deepEqual(etatHorsLigne({ serviceWorker: { register() {}, controller: null } }, { isSecureContext: true }), { possible: true, actif: false });
  assert.deepEqual(etatHorsLigne({}, { isSecureContext: true }), { possible: false, actif: false });
});

test('preparerHorsLigne : tout est chargé, progression, concurrence bornée, un échec n\'interrompt pas la suite', async () => {
  let enCours = 0;
  let pic = 0;
  const vus = [];
  const progres = [];
  const resultat = await preparerHorsLigne(['a', 'b', 'c', 'd', 'e', 'f', 'g'], async (x) => {
    enCours += 1;
    pic = Math.max(pic, enCours);
    await new Promise((r) => setTimeout(r, 2));
    enCours -= 1;
    vus.push(x);
    if (x === 'c') throw new Error('absent');
  }, { concurrence: 3, surProgres: (fait, total, echecs) => progres.push([fait, total, echecs]) });
  assert.deepEqual(resultat, { total: 7, reussis: 6, echecs: 1, annule: false });
  assert.equal(vus.length, 7);
  assert.ok(pic <= 3);
  assert.deepEqual(progres[progres.length - 1], [7, 7, 1]);
});

test('preparerHorsLigne : liste vide, annulation', async () => {
  assert.deepEqual(await preparerHorsLigne([], async () => {}), { total: 0, reussis: 0, echecs: 0, annule: false });
  const controleur = new AbortController();
  let n = 0;
  const r = await preparerHorsLigne(Array.from({ length: 20 }, (_, i) => i), async () => { n += 1; if (n === 3) controleur.abort(); }, { concurrence: 1, signal: controleur.signal });
  assert.equal(r.annule, true);
  assert.equal(n, 3);
});

// ---------------------------------------------------------------------------
// tools/generer-sw.mjs
// ---------------------------------------------------------------------------

test('listerCoque : page, manifeste, icônes, CSS et JavaScript, sans shaders ni tests ni outils', () => {
  const coque = listerCoque(RACINE);
  for (const attendu of ['index.html', 'manifest.webmanifest', 'branding/favicon.svg', 'css/main.css', 'js/app.js', 'js/export/video.js', 'js/hors-ligne.js']) {
    assert.ok(coque.includes(attendu), `${attendu} absent de la coque`);
  }
  assert.ok(coque.every((f) => !f.startsWith('shaders/') && !f.startsWith('tests/') && !f.startsWith('tools/') && f !== 'sw.js'));
  assert.deepEqual(coque, [...coque].sort());
});

test('calculerVersion : stable, insensible aux fins de ligne, sensible au contenu', () => {
  const racine = mkdtempSync(join(tmpdir(), 'sv-sw-'));
  writeFileSync(join(racine, 'a.js'), 'ligne1\nligne2\n');
  const v1 = calculerVersion(racine, ['a.js']);
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.equal(calculerVersion(racine, ['a.js']), v1);
  writeFileSync(join(racine, 'a.js'), 'ligne1\r\nligne2\r\n');
  assert.equal(calculerVersion(racine, ['a.js']), v1, 'CRLF et LF donnent la même version');
  writeFileSync(join(racine, 'a.js'), 'ligne1\nligne2 modifiée\n');
  assert.notEqual(calculerVersion(racine, ['a.js']), v1);
});

test('genererBloc : version et liste de la coque, « ./ » en tête', () => {
  const bloc = genererBloc('abc123', ['index.html', 'js/app.js']);
  assert.match(bloc, /const VERSION = 'abc123';/);
  assert.match(bloc, /const COQUE = \[\n  '\.\/',\n  'index\.html',\n  'js\/app\.js',\n\];/);
});

test('sw.js du dépôt est à jour (node tools/generer-sw.mjs)', () => {
  const source = readFileSync(join(RACINE, 'sw.js'), 'utf8');
  assert.equal(source.replace(/\r\n/g, '\n'), contenuAttendu(source, RACINE));
});

test('contenuAttendu : marqueurs absents refusés', () => {
  assert.throws(() => contenuAttendu('rien', RACINE), /Marqueurs/);
});

// ---------------------------------------------------------------------------
// sw.js : comportement des stratégies, dans un bac à sable
// ---------------------------------------------------------------------------

function creerSw({ reseau, version = 'v1' }) {
  const stocks = new Map();
  const fabriqueCache = (nom) => {
    if (!stocks.has(nom)) stocks.set(nom, new Map());
    const m = stocks.get(nom);
    const cle = (r, ignoreSearch) => { const u = new URL(typeof r === 'string' ? r : r.url); if (ignoreSearch) u.search = ''; return u.href; };
    return {
      addAll: async (requetes) => { for (const r of requetes) { const rep = await reseau(r); if (!rep.ok) throw new Error('échec'); m.set(cle(r), rep); } },
      put: async (r, rep) => { m.set(cle(r), rep); },
      match: async (r, { ignoreSearch = false } = {}) => {
        const attendue = cle(r, ignoreSearch);
        for (const [k, v] of m) if ((ignoreSearch ? cle(k, true) : k) === attendue) return v.clone();
        return undefined;
      },
    };
  };
  const ecouteurs = new Map();
  const messages = [];
  const appels = { skipWaiting: 0, claim: 0, reseau: [] };
  const sandbox = {
    URL, Response, console,
    // Dans un vrai Service Worker, une adresse relative se résout par rapport à l'adresse du script.
    Request: class extends Request { constructor(adresse, options) { super(typeof adresse === 'string' ? new URL(adresse, 'https://site.test/app/sw.js').href : adresse, options); } },
    caches: {
      open: async (nom) => fabriqueCache(nom),
      keys: async () => [...stocks.keys()],
      delete: async (nom) => stocks.delete(nom),
    },
    fetch: async (r) => { appels.reseau.push(typeof r === 'string' ? r : r.url); return reseau(r); },
    self: {
      addEventListener: (nom, f) => ecouteurs.set(nom, f),
      registration: { scope: 'https://site.test/app/' },
      clients: { claim: async () => { appels.claim += 1; } },
      skipWaiting: () => { appels.skipWaiting += 1; },
    },
  };
  const source = readFileSync(join(RACINE, 'sw.js'), 'utf8')
    .replace(/\/\/ <généré>[\s\S]*\/\/ <\/généré>/, `const VERSION = '${version}';\nconst COQUE = ['./', 'index.html', 'js/app.js'];`);
  vm.runInNewContext(source, sandbox);
  const requeteFetch = async (url, { mode = 'cors', method = 'GET' } = {}) => {
    const requete = new Request(url, { method });
    Object.defineProperty(requete, 'mode', { value: mode });
    let reponse;
    ecouteurs.get('fetch')({ request: requete, respondWith: (p) => { reponse = p; } });
    return reponse === undefined ? undefined : reponse;
  };
  return { ecouteurs, stocks, appels, messages, requeteFetch, sandbox };
}

const ok = (corps) => new Response(corps, { status: 200 });
const evenementAttente = () => { let p; return { waitUntil: (x) => { p = x; }, attente: () => p }; };

test('sw.js : installation de la coque, activation (anciennes coques supprimées), prise de contrôle', async () => {
  const sw = creerSw({ reseau: async (r) => ok(`contenu de ${typeof r === 'string' ? r : r.url}`), version: 'v2' });
  sw.stocks.set('shaderview-coque-v1', new Map([['x', ok('ancien')]]));
  sw.stocks.set('shaderview-donnees', new Map([['d', ok('donnée')]]));
  const installation = evenementAttente();
  sw.ecouteurs.get('install')(installation);
  await installation.attente();
  assert.deepEqual([...sw.stocks.get('shaderview-coque-v2').keys()].sort(), ['https://site.test/app/', 'https://site.test/app/index.html', 'https://site.test/app/js/app.js']);
  const activation = evenementAttente();
  sw.ecouteurs.get('activate')(activation);
  await activation.attente();
  assert.deepEqual([...sw.stocks.keys()].sort(), ['shaderview-coque-v2', 'shaderview-donnees'], 'ancienne coque supprimée, données conservées');
  assert.equal(sw.appels.claim, 1);
});

test('sw.js : la coque est servie depuis le cache sans toucher au réseau', async () => {
  const sw = creerSw({ reseau: async (r) => ok(`contenu de ${typeof r === 'string' ? r : r.url}`) });
  const installation = evenementAttente();
  sw.ecouteurs.get('install')(installation);
  await installation.attente();
  sw.appels.reseau.length = 0;
  const reponse = await (await sw.requeteFetch('https://site.test/app/js/app.js'));
  assert.equal(await reponse.text(), 'contenu de https://site.test/app/js/app.js');
  const avecRecherche = await (await sw.requeteFetch('https://site.test/app/index.html?x=1'));
  assert.match(await avecRecherche.text(), /index\.html/);
  const navigation = await (await sw.requeteFetch('https://site.test/app/autre', { mode: 'navigate' }));
  assert.match(await navigation.text(), /index\.html/, 'navigation inconnue : repli sur la page d\'accueil');
  assert.deepEqual(sw.appels.reseau, []);
});

test('sw.js : les données passent par le réseau, une copie sert hors-ligne, les échecs ne sont pas conservés', async () => {
  let enLigne = true;
  const sw = creerSw({ reseau: async (r) => {
    if (!enLigne) throw new TypeError('hors-ligne');
    const url = typeof r === 'string' ? r : r.url;
    return url.includes('absent') ? new Response('non', { status: 404 }) : ok(`donnée ${url}`);
  } });
  const a = await (await sw.requeteFetch('https://site.test/app/shaders/a.json'));
  assert.equal(await a.text(), 'donnée https://site.test/app/shaders/a.json');
  const absent = await (await sw.requeteFetch('https://site.test/app/shaders/absent.json'));
  assert.equal(absent.status, 404);
  enLigne = false;
  const copie = await (await sw.requeteFetch('https://site.test/app/shaders/a.json'));
  assert.equal(await copie.text(), 'donnée https://site.test/app/shaders/a.json', 'copie du cache hors-ligne');
  await assert.rejects(sw.requeteFetch('https://site.test/app/shaders/absent.json'), /hors-ligne/);
  await assert.rejects(sw.requeteFetch('https://site.test/app/audio/jamais-vu.mp3'), /hors-ligne/);
});

test('sw.js : en ligne, les données sont toujours relues (réseau d\'abord)', async () => {
  let version = 1;
  const sw = creerSw({ reseau: async () => ok(`manifeste v${version}`) });
  assert.equal(await (await sw.requeteFetch('https://site.test/app/shaders/manifest.json')).text(), 'manifeste v1');
  version = 2;
  assert.equal(await (await sw.requeteFetch('https://site.test/app/shaders/manifest.json')).text(), 'manifeste v2');
});

test('sw.js : n\'intercepte ni les autres origines ni les méthodes autres que GET', async () => {
  const sw = creerSw({ reseau: async () => ok('x') });
  assert.equal(await sw.requeteFetch('https://autre.test/app/shaders/a.json'), undefined);
  assert.equal(await sw.requeteFetch('https://site.test/app/shaders/a.json', { method: 'POST' }), undefined);
});

test('sw.js : la nouvelle version attend, ne s\'active que sur le message « activer »', () => {
  const sw = creerSw({ reseau: async () => ok('x') });
  const installation = evenementAttente();
  sw.ecouteurs.get('install')(installation);
  assert.equal(sw.appels.skipWaiting, 0, 'pas de skipWaiting automatique');
  sw.ecouteurs.get('message')({ data: 'autre' });
  assert.equal(sw.appels.skipWaiting, 0);
  sw.ecouteurs.get('message')({ data: 'activer' });
  assert.equal(sw.appels.skipWaiting, 1);
  const recus = [];
  sw.ecouteurs.get('message')({ data: 'version', source: { postMessage: (m) => recus.push(m) } });
  assert.deepEqual(JSON.parse(JSON.stringify(recus)), [{ type: 'version', version: 'v1' }]);
});

// Une copie du dépôt n'est pas nécessaire : le test de fraîcheur ci-dessus lit le vrai sw.js.
test('contenuAttendu : fonctionne sur une copie de la coque (racine alternative)', () => {
  const racine = mkdtempSync(join(tmpdir(), 'sv-coque-'));
  mkdirSync(join(racine, 'js'));
  mkdirSync(join(racine, 'css'));
  mkdirSync(join(racine, 'branding'));
  writeFileSync(join(racine, 'index.html'), '<html></html>');
  writeFileSync(join(racine, 'manifest.webmanifest'), '{}');
  writeFileSync(join(racine, 'branding', 'favicon.svg'), '<svg/>');
  writeFileSync(join(racine, 'js', 'a.js'), 'a');
  writeFileSync(join(racine, 'css', 'a.css'), 'a');
  cpSync(join(RACINE, 'sw.js'), join(racine, 'sw.js'));
  const attendu = contenuAttendu(readFileSync(join(racine, 'sw.js'), 'utf8'), racine);
  assert.match(attendu, /'css\/a\.css',\n  'index\.html',\n  'js\/a\.js',\n  'manifest\.webmanifest',/);
});

test('enregistrerServiceWorker : une mise à jour déjà en cours d\'installation à l\'enregistrement est surveillée', async () => {
  const env = navigateurFactice({ controller: {} });
  const ecouteursInstallation = new Map();
  env.registration.installing = {
    state: 'installing', postMessage() {},
    addEventListener: (nom, f) => ecouteursInstallation.set(nom, f),
  };
  let proposee = 0;
  await enregistrerServiceWorker({ navigateur: env.navigateur, contexte: { isSecureContext: true }, surMiseAJour: () => { proposee += 1; }, minuteur() {} });
  assert.equal(proposee, 0);
  env.registration.installing.state = 'installed';
  ecouteursInstallation.get('statechange')();
  assert.equal(proposee, 1);
});

test('enregistrerServiceWorker : une installation déjà terminée à l\'enregistrement est proposée aussitôt', async () => {
  const env = navigateurFactice({ controller: {} });
  env.registration.installing = { state: 'installed', postMessage() {}, addEventListener() {} };
  let proposee = 0;
  await enregistrerServiceWorker({ navigateur: env.navigateur, contexte: { isSecureContext: true }, surMiseAJour: () => { proposee += 1; }, minuteur() {} });
  assert.equal(proposee, 1);
});
