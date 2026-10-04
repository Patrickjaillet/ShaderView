// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Catalogue, SOURCES, aplatir, catalogueDepuisFichiers, chargerManifeste, collecterDepot,
  fichierLocalDepuisFile, fichiersDepuisSelection, selectionnerJson,
} from '../js/catalog.js';
import { analyserFichier } from '../js/shader-meta.js';
import { encoder, shaderMultipasse, shaderSimple } from './fixtures.mjs';

// --- Aides -----------------------------------------------------------------

function local(chemin, contenu) {
  const octets = typeof contenu === 'string' ? encoder(contenu) : contenu;
  return { nom: chemin.split('/').pop(), chemin, lire: async () => octets };
}

/** Serveur factice : table adresse → contenu ; compte les requêtes. */
function serveur(table) {
  const appels = [];
  const fetchFn = async (url) => {
    appels.push(url);
    if (!(url in table)) return { ok: false, status: 404 };
    const corps = table[url];
    const octets = typeof corps === 'string' ? encoder(corps) : corps;
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(new TextDecoder().decode(octets)),
      arrayBuffer: async () => octets.buffer.slice(octets.byteOffset, octets.byteOffset + octets.byteLength),
    };
  };
  return { fetchFn, appels };
}

function manifesteDe(fichiers) {
  return JSON.stringify({ version: 1, fichiers });
}

// --- aplatir ---------------------------------------------------------------

test('aplatir : une entrée par shader, clé distincte pour un fichier multi-shaders', () => {
  const simple = analyserFichier('a.json', encoder(JSON.stringify(shaderSimple('A'))));
  const multi = analyserFichier('b.json', encoder(JSON.stringify([shaderSimple('B1'), shaderMultipasse()])));
  const entrees = aplatir([simple, multi]);
  assert.deepEqual(entrees.map((e) => e.cle), ['a.json', 'b.json#0', 'b.json#1']);
  assert.deepEqual(entrees.map((e) => e.index), [0, 0, 1]);
  assert.ok(entrees.every((e) => e.erreur === null));
});

test('aplatir : un fichier illisible devient une entrée en erreur', () => {
  const mauvais = analyserFichier('casse.json', encoder('{ x'));
  const [entree] = aplatir([mauvais]);
  assert.equal(entree.cle, 'casse.json');
  assert.equal(entree.index, null);
  assert.equal(entree.titre, 'casse');
  assert.match(entree.erreur, /JSON invalide/);
});

// --- chargerManifeste ------------------------------------------------------

test('chargerManifeste : charge le catalogue et lit les fichiers à la demande', async () => {
  const contenu = JSON.stringify(shaderSimple('Un'));
  const fichier = analyserFichier('un.json', encoder(contenu));
  const { fetchFn, appels } = serveur({
    'shaders/manifest.json': manifesteDe([fichier]),
    'shaders/un.json': contenu,
  });
  const catalogue = await chargerManifeste({ fetchFn });
  assert.equal(catalogue.source, SOURCES.MANIFESTE);
  assert.equal(catalogue.entrees.length, 1);
  // Chargement paresseux : seul le manifeste a été demandé.
  assert.deepEqual(appels, ['shaders/manifest.json']);

  const shader = await catalogue.contenu(catalogue.entrees[0]);
  assert.equal(shader.info.name, 'Un');
  assert.equal(catalogue.entrees[0].perime, false);
  assert.deepEqual(appels, ['shaders/manifest.json', 'shaders/un.json']);
});

test('contenu : un fichier multi-shaders n\'est lu qu\'une fois', async () => {
  const contenu = JSON.stringify([shaderSimple('A'), shaderSimple('B')]);
  const fichier = analyserFichier('duo.json', encoder(contenu));
  const { fetchFn, appels } = serveur({ 'shaders/manifest.json': manifesteDe([fichier]), 'shaders/duo.json': contenu });
  const catalogue = await chargerManifeste({ fetchFn });
  const [a, b] = catalogue.entrees;
  const [sa, sb] = await Promise.all([catalogue.contenu(a), catalogue.contenu(b)]);
  assert.equal(sa.info.name, 'A');
  assert.equal(sb.info.name, 'B');
  assert.equal(appels.filter((u) => u === 'shaders/duo.json').length, 1);
});

test('contenu : détecte un manifeste périmé (empreinte différente)', async () => {
  const original = JSON.stringify(shaderSimple('Avant'));
  const fichier = analyserFichier('x.json', encoder(original));
  const modifie = JSON.stringify(shaderSimple('Après'));
  const { fetchFn } = serveur({ 'shaders/manifest.json': manifesteDe([fichier]), 'shaders/x.json': modifie });
  const catalogue = await chargerManifeste({ fetchFn });
  const shader = await catalogue.contenu(catalogue.entrees[0]);
  assert.equal(shader.info.name, 'Après');
  assert.equal(catalogue.entrees[0].perime, true);
});

test('contenu : un échec de lecture n\'est pas mis en cache', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('r.json', encoder(contenu));
  const table = { 'shaders/manifest.json': manifesteDe([fichier]) };
  const { fetchFn } = serveur(table);
  const catalogue = await chargerManifeste({ fetchFn });
  await assert.rejects(catalogue.contenu(catalogue.entrees[0]), /HTTP 404/);
  table['shaders/r.json'] = contenu;
  const shader = await catalogue.contenu(catalogue.entrees[0]);
  assert.equal(shader.info.name, 'Simple');
});

test('contenu : refuse une entrée en erreur', async () => {
  const catalogue = new Catalogue(SOURCES.FICHIERS, [analyserFichier('c.json', encoder('{'))], async () => new Uint8Array());
  await assert.rejects(catalogue.contenu(catalogue.entrees[0]), /JSON invalide/);
});

test('chargerManifeste : encode les noms de fichiers dans l\'adresse', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('mon shader #1.json', encoder(contenu));
  const { fetchFn, appels } = serveur({
    'shaders/manifest.json': manifesteDe([fichier]),
    'shaders/mon%20shader%20%231.json': contenu,
  });
  const catalogue = await chargerManifeste({ fetchFn });
  await catalogue.contenu(catalogue.entrees[0]);
  assert.equal(appels.at(-1), 'shaders/mon%20shader%20%231.json');
});

test('chargerManifeste : erreurs explicites', async () => {
  await assert.rejects(chargerManifeste({ fetchFn: async () => { throw new TypeError('Failed to fetch'); } }), /Lecture de shaders\/manifest\.json impossible \(Failed to fetch\)/);
  await assert.rejects(chargerManifeste({ fetchFn: serveur({}).fetchFn }), /HTTP 404/);
  await assert.rejects(chargerManifeste({ fetchFn: serveur({ 'shaders/manifest.json': 'pas du json' }).fetchFn }), /pas un JSON valide/);
  await assert.rejects(chargerManifeste({ fetchFn: serveur({ 'shaders/manifest.json': '{"version":99,"fichiers":[]}' }).fetchFn }), /non reconnu/);
  await assert.rejects(chargerManifeste({ fetchFn: serveur({ 'shaders/manifest.json': '{"version":1}' }).fetchFn }), /« fichiers » absente/);
  await assert.rejects(chargerManifeste({ fetchFn: serveur({ 'shaders/manifest.json': '{"version":1,"fichiers":[{"fichier":1}]}' }).fetchFn }), /mal formée/);
});

// --- selectionnerJson ------------------------------------------------------

test('selectionnerJson : dossier shaders/ choisi directement', () => {
  const f = [local('shaders/a.json', '{}'), local('shaders/b.json', '{}'), local('shaders/manifest.json', '{}'), local('shaders/leo.txt', '')];
  assert.deepEqual(selectionnerJson(f).map((x) => x.nom), ['a.json', 'b.json']);
});

test('selectionnerJson : racine du projet, seul le dossier shaders/ est retenu', () => {
  const f = [
    local('shaderview/package.json', '{}'),
    local('shaderview/shaders/a.json', '{}'),
    local('shaderview/shaders/media/x.json', '{}'),
    local('shaderview/tools/y.json', '{}'),
  ];
  assert.deepEqual(selectionnerJson(f).map((x) => x.chemin), ['shaderview/shaders/a.json']);
});

test('selectionnerJson : fichiers déposés isolément', () => {
  const f = [local('un.json', '{}'), local('deux.json', '{}')];
  assert.equal(selectionnerJson(f).length, 2);
  assert.deepEqual(selectionnerJson([local('lisez-moi.txt', '')]), []);
});

// --- catalogueDepuisFichiers -----------------------------------------------

test('catalogueDepuisFichiers : une erreur sur un fichier ne bloque pas les autres', async () => {
  const progres = [];
  const catalogue = await catalogueDepuisFichiers([
    local('shaders/bon.json', JSON.stringify(shaderSimple('Bon'))),
    local('shaders/casse.json', '{ pas du json'),
    local('shaders/inconnu.json', '{"a":1}'),
    local('shaders/multi.json', JSON.stringify([shaderSimple('M1'), { renderpass: [] }])),
    { nom: 'illisible.json', chemin: 'shaders/illisible.json', lire: async () => { throw new Error('accès refusé'); } },
  ], { source: SOURCES.DOSSIER, surProgres: (fait, total) => progres.push([fait, total]) });

  assert.equal(catalogue.source, SOURCES.DOSSIER);
  const parCle = Object.fromEntries(catalogue.entrees.map((e) => [e.cle, e]));
  assert.equal(parCle['bon.json'].erreur, null);
  assert.match(parCle['casse.json'].erreur, /JSON invalide/);
  assert.match(parCle['inconnu.json'].erreur, /non reconnu/);
  assert.equal(parCle['multi.json#0'].erreur, null);
  assert.match(parCle['multi.json#1'].erreur, /Aucune passe/);
  assert.match(parCle['illisible.json'].erreur, /accès refusé/);
  assert.equal(catalogue.nbErreurs, 4);
  assert.deepEqual(progres.at(-1), [5, 5]);
  // Ordre alphabétique des fichiers.
  assert.deepEqual(catalogue.fichiers.map((f) => f.fichier), ['bon.json', 'casse.json', 'illisible.json', 'inconnu.json', 'multi.json']);
});

test('catalogueDepuisFichiers : chargement paresseux depuis les fichiers locaux', async () => {
  let lectures = 0;
  const contenu = encoder(JSON.stringify(shaderSimple('Local')));
  const f = { nom: 'l.json', chemin: 'l.json', lire: async () => { lectures += 1; return contenu; } };
  const catalogue = await catalogueDepuisFichiers([f]);
  assert.equal(lectures, 1); // lecture d'analyse
  const shader = await catalogue.contenu(catalogue.entrees[0]);
  assert.equal(shader.info.name, 'Local');
  assert.equal(catalogue.entrees[0].perime, false);
  await catalogue.contenu(catalogue.entrees[0]);
  assert.equal(lectures, 2); // une seule lecture supplémentaire, ensuite en cache
});

test('catalogueDepuisFichiers : nom en double signalé, premier conservé', async () => {
  const catalogue = await catalogueDepuisFichiers([
    local('a/s.json', JSON.stringify(shaderSimple('Premier'))),
    local('a/s.json'.replace('a/', 'b/'), JSON.stringify(shaderSimple('Second'))),
  ]);
  // Deux chemins de même profondeur, même nom : un seul reste.
  const erreurs = catalogue.entrees.filter((e) => e.erreur !== null);
  assert.equal(catalogue.entrees.length, 2);
  assert.equal(erreurs.length, 1);
  assert.match(erreurs[0].erreur, /Nom en double/);
});

test('catalogueDepuisFichiers : sélection vide', async () => {
  const catalogue = await catalogueDepuisFichiers([local('notes.txt', 'x')]);
  assert.equal(catalogue.entrees.length, 0);
});

// --- Adaptateurs File / DataTransfer ---------------------------------------

test('fichierLocalDepuisFile : lit les octets, chemin explicite prioritaire', async () => {
  const file = new File([encoder('{"a":1}')], 'a.json');
  const f = fichierLocalDepuisFile(file, 'dossier/a.json');
  assert.equal(f.nom, 'a.json');
  assert.equal(f.chemin, 'dossier/a.json');
  assert.equal(new TextDecoder().decode(await f.lire()), '{"a":1}');
  assert.equal(fichiersDepuisSelection([file])[0].chemin, 'a.json');
});

function entreeFichier(nom, contenu) {
  return { isFile: true, isDirectory: false, name: nom, file: (ok) => ok(new File([encoder(contenu)], nom)) };
}

function entreeDossier(nom, enfants, tailleLot = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name: nom,
    createReader() {
      let reste = [...enfants];
      return { readEntries: (ok) => ok(reste.splice(0, tailleLot)) };
    },
  };
}

test('collecterDepot : parcourt un dossier déposé, lecture par lots, dossiers ignorés', async () => {
  const racine = entreeDossier('shaders', [
    entreeFichier('a.json', '{}'),
    entreeFichier('b.json', '{}'),
    entreeFichier('c.json', '{}'),
    entreeDossier('node_modules', [entreeFichier('piege.json', '{}')]),
    entreeDossier('media', [entreeFichier('d.json', '{}')]),
  ]);
  const transfert = { items: [{ kind: 'file', webkitGetAsEntry: () => racine }], files: [] };
  const fichiers = await collecterDepot(transfert);
  assert.deepEqual(fichiers.map((f) => f.chemin).sort(), ['shaders/a.json', 'shaders/b.json', 'shaders/c.json', 'shaders/media/d.json']);
  assert.deepEqual(selectionnerJson(fichiers).map((f) => f.nom).sort(), ['a.json', 'b.json', 'c.json']);
});

test('collecterDepot : fichiers .json déposés isolément', async () => {
  const transfert = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => entreeFichier('un.json', '{}') },
      { kind: 'file', webkitGetAsEntry: () => entreeFichier('deux.json', '{}') },
    ],
    files: [],
  };
  const fichiers = await collecterDepot(transfert);
  assert.deepEqual(fichiers.map((f) => f.chemin), ['un.json', 'deux.json']);
});

test('collecterDepot : repli sur la liste de fichiers sans webkitGetAsEntry', async () => {
  const transfert = { items: [{ kind: 'file' }], files: [new File([encoder('{}')], 'plat.json')] };
  const fichiers = await collecterDepot(transfert);
  assert.deepEqual(fichiers.map((f) => f.chemin), ['plat.json']);
});
