// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErreurCompilation } from '../js/renderer.js';
import { ETAT_MINIATURE, ErreurWorkerMiniatures, GenerateurMiniatures, RenduMiniaturesWorker } from '../js/thumbnails.js';
import { shaderSimple } from './fixtures.mjs';

// Worker factice : conserve les écouteurs et les messages reçus ; `repondre` simule la réponse du vrai Worker.
function workerFactice() {
  const ecouteurs = new Map();
  const worker = {
    recus: [],
    termine: false,
    addEventListener: (nom, f) => ecouteurs.set(nom, f),
    postMessage(message) { worker.recus.push(message); },
    terminate() { worker.termine = true; },
    repondre(donnees) { ecouteurs.get('message')({ data: donnees }); },
    declencher(nom, evenement = {}) { ecouteurs.get(nom)(evenement); },
  };
  return worker;
}

const versUrl = async (octets) => `data:image/png;base64,${Buffer.from(octets).toString('base64')}`;
const normalise = { image: { code: 'x' } };

test('RenduMiniaturesWorker : envoie le shader, reçoit le PNG converti en URL de données', async () => {
  const worker = workerFactice();
  const client = new RenduMiniaturesWorker({ creerWorker: () => worker, versUrlDonnees: versUrl });
  const promesse = client.rendre(normalise, 1);
  assert.deepEqual(worker.recus, [{ id: 1, normalise, temps: 1 }]);
  worker.repondre({ id: 1, ok: true, octets: new Uint8Array([1, 2, 3]).buffer });
  assert.equal(await promesse, `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`);
  assert.equal(client.disponible, true);
});

test('RenduMiniaturesWorker : plusieurs requêtes en vol, réponses associées par identifiant', async () => {
  const worker = workerFactice();
  const client = new RenduMiniaturesWorker({ creerWorker: () => worker, versUrlDonnees: async (o) => `u${new Uint8Array(o)[0]}` });
  const a = client.rendre(normalise, 1);
  const b = client.rendre(normalise, 1);
  worker.repondre({ id: 2, ok: true, octets: Uint8Array.of(2).buffer });
  worker.repondre({ id: 1, ok: true, octets: Uint8Array.of(1).buffer });
  assert.deepEqual([await a, await b], ['u1', 'u2']);
});

test('RenduMiniaturesWorker : une erreur de compilation est reconstruite à l\'identique sans désactiver le Worker', async () => {
  const worker = workerFactice();
  const client = new RenduMiniaturesWorker({ creerWorker: () => worker, versUrlDonnees: versUrl });
  const promesse = client.rendre(normalise, 1);
  const lignes = [{ ligne: 3, colonne: null, message: 'oups', brut: 'ERROR: 0:20: oups' }];
  worker.repondre({ id: 1, ok: false, erreur: { nom: 'ErreurCompilation', message: 'échec', erreursLigne: lignes, idPasse: 'buffer-A' } });
  await assert.rejects(promesse, (e) => e instanceof ErreurCompilation && e.idPasse === 'buffer-A' && e.erreursLigne[0].ligne === 3);
  assert.equal(client.disponible, true);
});

test('RenduMiniaturesWorker : WebGL2 absent du Worker, erreur du Worker et module illisible désactivent le client', async () => {
  for (const declencheur of [
    (w) => w.repondre({ id: 1, ok: false, erreur: { nom: 'ErreurContexte', message: 'pas de WebGL2' } }),
    (w) => w.declencher('error', { message: 'module introuvable' }),
    (w) => w.declencher('messageerror'),
  ]) {
    const worker = workerFactice();
    const client = new RenduMiniaturesWorker({ creerWorker: () => worker, versUrlDonnees: versUrl });
    const promesse = client.rendre(normalise, 1);
    declencheur(worker);
    await assert.rejects(promesse, ErreurWorkerMiniatures);
    assert.equal(client.disponible, false);
    assert.equal(worker.termine, true);
    await assert.rejects(client.rendre(normalise, 1), ErreurWorkerMiniatures);
  }
});

test('RenduMiniaturesWorker : navigateur sans Worker, délai dépassé', async () => {
  const sans = new RenduMiniaturesWorker({ creerWorker: () => null });
  await assert.rejects(sans.rendre(normalise, 1), ErreurWorkerMiniatures);
  assert.equal(sans.disponible, false);
  const lent = new RenduMiniaturesWorker({ creerWorker: () => workerFactice(), delaiMs: 5 });
  await assert.rejects(lent.rendre(normalise, 1), /Délai/);
  assert.equal(lent.disponible, false);
});

test('RenduMiniaturesWorker : erreur de message ordinaire rejetée sans désactiver, détruire libère le Worker', async () => {
  const worker = workerFactice();
  const client = new RenduMiniaturesWorker({ creerWorker: () => worker, versUrlDonnees: versUrl });
  const promesse = client.rendre(normalise, 1);
  worker.repondre({ id: 1, ok: false, erreur: { nom: 'Error', message: 'autre' } });
  await assert.rejects(promesse, /autre/);
  assert.equal(client.disponible, true);
  client.detruire();
  assert.equal(worker.termine, true);
  assert.equal(client.disponible, false);
});

// ---------------------------------------------------------------------------
// Intégration au générateur
// ---------------------------------------------------------------------------

function entree(cle) { return { cle, fichier: `${cle}.json`, empreinte: 'e1', erreur: null }; }

function generateur(rendreExterne) {
  const compteurs = { principal: 0 };
  const g = new GenerateurMiniatures({
    rendreExterne,
    lireShader: async () => shaderSimple('S'),
    creerMoteur: () => ({
      canevas: { toDataURL: () => 'data:image/png;base64,UFJJTkNJUEFM' },
      horloge: { remettreAZero() {}, sauterA() {} }, compiler() {}, reinitialiserTampons() {}, rendre() { compteurs.principal += 1; },
    }),
    creerImage: () => ({ dataset: {}, src: '', title: '' }),
    planifier: (t) => setTimeout(t, 0),
  });
  return { g, compteurs };
}

const attendreFile = () => new Promise((r) => setTimeout(r, 60));

test('GenerateurMiniatures + Worker : le rendu se fait dans le Worker, pas sur le fil principal', async () => {
  const { g, compteurs } = generateur({ disponible: true, rendre: async () => 'data:image/png;base64,V09SS0VS' });
  g.definirCatalogue({ entrees: [entree('a')] });
  const image = g.imagePour(entree('a'));
  g.demander([entree('a')]);
  await attendreFile();
  assert.equal(image.src, 'data:image/png;base64,V09SS0VS');
  assert.equal(image.dataset.etat, ETAT_MINIATURE.PRETE);
  assert.equal(compteurs.principal, 0);
  assert.equal(g.mode, 'worker');
});

test('GenerateurMiniatures + Worker : Worker en panne, repli sur le fil principal pour cette miniature et les suivantes', async () => {
  let panne = false;
  const externe = { get disponible() { return !panne; }, rendre: async () => { panne = true; throw new ErreurWorkerMiniatures('panne'); } };
  const { g, compteurs } = generateur(externe);
  const liste = [entree('a'), entree('b')];
  g.definirCatalogue({ entrees: liste });
  const images = liste.map((e) => g.imagePour(e));
  g.demander(liste);
  await attendreFile();
  await attendreFile();
  assert.deepEqual(images.map((i) => i.src), ['data:image/png;base64,UFJJTkNJUEFM', 'data:image/png;base64,UFJJTkNJUEFM']);
  assert.equal(compteurs.principal, 2);
  assert.equal(g.mode, 'principal');
});

test('GenerateurMiniatures + Worker : un shader qui ne compile pas reste une erreur de miniature, sans repli', async () => {
  const externe = { disponible: true, rendre: async () => { throw new ErreurCompilation('échec', [{ ligne: 2, colonne: null, message: 'bête', brut: 'x' }], 'image'); } };
  const { g, compteurs } = generateur(externe);
  g.definirCatalogue({ entrees: [entree('a')] });
  const image = g.imagePour(entree('a'));
  g.demander([entree('a')]);
  await attendreFile();
  assert.equal(image.dataset.etat, ETAT_MINIATURE.ERREUR);
  assert.match(image.title, /ligne 2/);
  assert.equal(compteurs.principal, 0);
});
