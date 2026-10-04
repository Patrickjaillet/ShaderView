// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BibliothequeAudio, Catalogue, SOURCES, aplatir, catalogueDepuisFichiers, chargerBibliothequeAudio,
  chargerManifeste, collecterDepot, fichierLocalDepuisFile, fichiersDepuisSelection, manifesteAChange,
  reanalyserDossierNatif, selectionnerJson, selectionnerMedia,
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

function manifesteDe(fichiers, media = []) {
  return JSON.stringify({ version: 1, fichiers, media });
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

test('chargerManifeste : expose empreinteManifeste, identique pour un contenu identique', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('s.json', encoder(contenu));
  const { fetchFn } = serveur({ 'shaders/manifest.json': manifesteDe([fichier]), 'shaders/s.json': contenu });
  const catalogue = await chargerManifeste({ fetchFn });
  assert.equal(typeof catalogue.empreinteManifeste, 'string');
  const catalogue2 = await chargerManifeste({ fetchFn });
  assert.equal(catalogue.empreinteManifeste, catalogue2.empreinteManifeste);
});

// --- manifesteAChange -------------------------------------------------

test('manifesteAChange : même contenu, aucun changement détecté', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('s.json', encoder(contenu));
  const texteManifeste = manifesteDe([fichier]);
  const { fetchFn } = serveur({ 'shaders/manifest.json': texteManifeste });
  const empreinte = (await chargerManifeste({ fetchFn: serveur({ 'shaders/manifest.json': texteManifeste, 'shaders/s.json': contenu }).fetchFn })).empreinteManifeste;
  assert.equal(await manifesteAChange(empreinte, { fetchFn }), false);
});

test('manifesteAChange : contenu différent (fichier ajouté), changement détecté', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichierA = analyserFichier('a.json', encoder(contenu));
  const fichierB = analyserFichier('b.json', encoder(contenu));
  const avant = await chargerManifeste({ fetchFn: serveur({ 'shaders/manifest.json': manifesteDe([fichierA]), 'shaders/a.json': contenu }).fetchFn });
  const { fetchFn: fetchApres } = serveur({ 'shaders/manifest.json': manifesteDe([fichierA, fichierB]) });
  assert.equal(await manifesteAChange(avant.empreinteManifeste, { fetchFn: fetchApres }), true);
});

test('manifesteAChange : manifeste temporairement inaccessible, pas un changement avéré', async () => {
  assert.equal(await manifesteAChange('nimporte', { fetchFn: serveur({}).fetchFn }), false);
  assert.equal(await manifesteAChange('nimporte', { fetchFn: async () => { throw new TypeError('Failed to fetch'); } }), false);
});

// --- reanalyserDossierNatif -------------------------------------------

function handleFactice(fichiers) {
  // Un seul niveau (racine) : suffisant pour exercer reanalyserDossierNatif sans
  // réimplémenter toute l'API FileSystemDirectoryHandle.
  return {
    name: 'shaders',
    async *entries() {
      for (const [nom, contenu] of fichiers) {
        yield [nom, { kind: 'file', getFile: async () => new File([encoder(contenu)], nom) }];
      }
    },
  };
}

test('reanalyserDossierNatif : reparcourt le dossier et reflète un fichier ajouté', async () => {
  const handle = handleFactice([['a.json', '{}']]);
  const premier = await reanalyserDossierNatif(handle);
  assert.deepEqual(premier.map((f) => f.nom), ['a.json']);

  handle.entries = async function* () {
    yield ['a.json', { kind: 'file', getFile: async () => new File([encoder('{}')], 'a.json') }];
    yield ['b.json', { kind: 'file', getFile: async () => new File([encoder('{}')], 'b.json') }];
  };
  const second = await reanalyserDossierNatif(handle);
  assert.deepEqual(second.map((f) => f.nom).sort(), ['a.json', 'b.json']);
});

test('reanalyserDossierNatif : permission révoquée (queryPermission), erreur explicite', async () => {
  const handle = handleFactice([]);
  handle.queryPermission = async () => 'denied';
  await assert.rejects(reanalyserDossierNatif(handle), /[Pp]ermission/);
});

test('reanalyserDossierNatif : sans queryPermission (navigateur plus ancien), fonctionne tout de même', async () => {
  const handle = handleFactice([['a.json', '{}']]);
  const fichiers = await reanalyserDossierNatif(handle);
  assert.deepEqual(fichiers.map((f) => f.nom), ['a.json']);
});

// --- media -------------------------------------------------------------

test('chargerManifeste : expose media et lit un fichier de shaders/media/ par requête de même origine', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('s.json', encoder(contenu));
  const { fetchFn, appels } = serveur({
    'shaders/manifest.json': manifesteDe([fichier], ['x.png', 'y.mp3']),
    'shaders/s.json': contenu,
    'shaders/media/x.png': 'octets-image',
  });
  const catalogue = await chargerManifeste({ fetchFn });
  assert.deepEqual(catalogue.media, new Set(['x.png', 'y.mp3']));
  const octets = await catalogue.contenuMedia('x.png');
  assert.equal(new TextDecoder().decode(octets), 'octets-image');
  assert.equal(appels.at(-1), 'shaders/media/x.png');
});

test('chargerManifeste : media absent du manifeste, ensemble vide (jamais une erreur)', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('s.json', encoder(contenu));
  const { fetchFn } = serveur({ 'shaders/manifest.json': JSON.stringify({ version: 1, fichiers: [fichier] }) });
  const catalogue = await chargerManifeste({ fetchFn });
  assert.deepEqual(catalogue.media, new Set());
});

test('contenuMedia : fichier de media/ absent du serveur, erreur explicite', async () => {
  const contenu = JSON.stringify(shaderSimple());
  const fichier = analyserFichier('s.json', encoder(contenu));
  const { fetchFn } = serveur({ 'shaders/manifest.json': manifesteDe([fichier], ['x.png']), 'shaders/s.json': contenu });
  const catalogue = await chargerManifeste({ fetchFn });
  await assert.rejects(catalogue.contenuMedia('x.png'), /HTTP 404/);
});

// --- selectionnerMedia -------------------------------------------------

test('selectionnerMedia : reconnaît un dossier media/ sous shaders/, ignore les sous-dossiers plus profonds', () => {
  const f = [
    local('shaders/media/x.png', 'x'),
    local('shaders/media/y.mp3', 'y'),
    local('shaders/media/sous-dossier/z.png', 'z'),
    local('shaders/a.json', '{}'),
  ];
  const media = selectionnerMedia(f);
  assert.deepEqual([...media.keys()].sort(), ['x.png', 'y.mp3']);
});

test('selectionnerMedia : media/ à la racine de la sélection (shaders/ non inclus)', () => {
  const f = [local('media/x.png', 'x'), local('a.json', '{}')];
  assert.deepEqual([...selectionnerMedia(f).keys()], ['x.png']);
});

test('selectionnerMedia : deux fichiers de même nom, le premier est conservé', () => {
  const f = [local('shaders/media/x.png', 'premier'), local('shaders/media/x.png'.replace('shaders', 'autre'), 'second')];
  const media = selectionnerMedia(f);
  assert.equal(media.size, 1);
});

test('catalogueDepuisFichiers : expose les médias collectés et les lit à la demande', async () => {
  const catalogue = await catalogueDepuisFichiers([
    local('shaders/bon.json', JSON.stringify(shaderSimple('Bon'))),
    local('shaders/media/x.png', 'octets-image'),
  ]);
  assert.deepEqual(catalogue.media, new Set(['x.png']));
  assert.equal(new TextDecoder().decode(await catalogue.contenuMedia('x.png')), 'octets-image');
  await assert.rejects(catalogue.contenuMedia('absent.png'), /absent de la sélection locale/);
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

// --- Bibliothèque audio (audio/manifest.json) -------------------------

function manifesteAudioDe(pistes) {
  return JSON.stringify({ version: 1, pistes });
}

test('BibliothequeAudio.lire : lit une piste connue', async () => {
  const lecteur = async (nom) => encoder(`contenu-${nom}`);
  const bib = new BibliothequeAudio(['a.mp3', 'b.mp3'], lecteur);
  assert.deepEqual(bib.pistes, ['a.mp3', 'b.mp3']);
  assert.equal(new TextDecoder().decode(await bib.lire('a.mp3')), 'contenu-a.mp3');
});

test('BibliothequeAudio.lire : piste inconnue, erreur explicite', async () => {
  const bib = new BibliothequeAudio(['a.mp3'], async () => new Uint8Array());
  await assert.rejects(bib.lire('inconnue.mp3'), /absente de la bibliothèque/);
});

test('chargerBibliothequeAudio : charge la liste et lit une piste par requête de même origine', async () => {
  const { fetchFn, appels } = serveur({
    'audio/manifest.json': manifesteAudioDe(['track01.mp3']),
    'audio/track01.mp3': 'octets-audio',
  });
  const bib = await chargerBibliothequeAudio({ fetchFn });
  assert.deepEqual(bib.pistes, ['track01.mp3']);
  assert.deepEqual(appels, ['audio/manifest.json']);
  const octets = await bib.lire('track01.mp3');
  assert.equal(new TextDecoder().decode(octets), 'octets-audio');
  assert.equal(appels.at(-1), 'audio/track01.mp3');
});

test('chargerBibliothequeAudio : manifeste absent (404), bibliothèque vide sans exception', async () => {
  const bib = await chargerBibliothequeAudio({ fetchFn: serveur({}).fetchFn });
  assert.deepEqual(bib.pistes, []);
  await assert.rejects(bib.lire('x.mp3'));
});

test('chargerBibliothequeAudio : échec réseau, bibliothèque vide sans exception', async () => {
  const bib = await chargerBibliothequeAudio({ fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(bib.pistes, []);
});

test('chargerBibliothequeAudio : manifeste mal formé (version ou pistes invalides), bibliothèque vide', async () => {
  const bibVersion = await chargerBibliothequeAudio({ fetchFn: serveur({ 'audio/manifest.json': '{"version":99,"pistes":[]}' }).fetchFn });
  assert.deepEqual(bibVersion.pistes, []);
  const bibPistes = await chargerBibliothequeAudio({ fetchFn: serveur({ 'audio/manifest.json': '{"version":1,"pistes":"x"}' }).fetchFn });
  assert.deepEqual(bibPistes.pistes, []);
  const bibJsonInvalide = await chargerBibliothequeAudio({ fetchFn: serveur({ 'audio/manifest.json': 'pas du json' }).fetchFn });
  assert.deepEqual(bibJsonInvalide.pistes, []);
});
