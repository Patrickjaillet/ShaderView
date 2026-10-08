// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CacheMiniatures } from '../js/cache-miniatures.js';
import { ETAT_MINIATURE, GenerateurMiniatures, PREFIXE_CACHE, cleCache, cleMiniature } from '../js/thumbnails.js';
import { shaderSimple } from './fixtures.mjs';

// ---------------------------------------------------------------------------
// IndexedDB factice : un seul magasin, requêtes asynchrones, transaction terminée quand plus aucune requête n'est en attente.
// ---------------------------------------------------------------------------

function fabriqueFactice({ echecOuverture = false } = {}) {
  const donnees = new Map();
  const base = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const transaction = { oncomplete: null, onerror: null, onabort: null, enAttente: 0, termine: false };
      const terminerSiPossible = () => {
        setTimeout(() => {
          if (transaction.enAttente === 0 && !transaction.termine) { transaction.termine = true; transaction.oncomplete?.(); }
        }, 0);
      };
      const requete = (fournir) => {
        const r = { onsuccess: null, onerror: null, result: undefined };
        transaction.enAttente += 1;
        setTimeout(() => {
          r.result = fournir();
          transaction.enAttente -= 1;
          r.onsuccess?.();
          terminerSiPossible();
        }, 0);
        return r;
      };
      transaction.objectStore = () => ({
        get: (cle) => requete(() => (donnees.has(cle) ? structuredClone(donnees.get(cle)) : undefined)),
        getAll: () => requete(() => [...donnees.values()].map((v) => structuredClone(v))),
        put: (valeur) => requete(() => { donnees.set(valeur.cle, structuredClone(valeur)); }),
        delete: (cle) => requete(() => { donnees.delete(cle); }),
        clear: () => requete(() => { donnees.clear(); }),
      });
      terminerSiPossible();
      return transaction;
    },
  };
  return {
    donnees,
    open() {
      const r = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: base };
      setTimeout(() => {
        if (echecOuverture) { r.onerror?.(); return; }
        r.onupgradeneeded?.();
        r.onsuccess?.();
      }, 0);
      return r;
    },
  };
}

const PNG = (n) => `data:image/png;base64,${Buffer.from(`image-${n}`).toString('base64')}`;

test('CacheMiniatures : écrit puis relit, lecture groupée, clés absentes ignorées', async () => {
  const cache = new CacheMiniatures({ fabrique: fabriqueFactice() });
  assert.equal(await cache.ecrire('a', PNG(1)), true);
  assert.equal(await cache.ecrire('b', PNG(2)), true);
  assert.equal(await cache.lire('a'), PNG(1));
  const lot = await cache.lireLot(['a', 'b', 'absente']);
  assert.deepEqual([...lot.keys()].sort(), ['a', 'b']);
  assert.equal(lot.get('b'), PNG(2));
  assert.deepEqual(await cache.lireLot([]), new Map());
});

test('CacheMiniatures : refuse ce qui n\'est pas une image PNG', async () => {
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique });
  assert.equal(await cache.ecrire('x', 'data:image/svg+xml;utf8,<svg/>'), false);
  assert.equal(await cache.ecrire('x', null), false);
  assert.equal(fabrique.donnees.size, 0);
});

test('CacheMiniatures : statistiques, vidage', async () => {
  const cache = new CacheMiniatures({ fabrique: fabriqueFactice() });
  await cache.ecrire('a', PNG(1));
  await cache.ecrire('b', PNG(22));
  const s = await cache.statistiques();
  assert.equal(s.entrees, 2);
  assert.equal(s.octets, PNG(1).length + PNG(22).length);
  assert.equal(await cache.vider(), 2);
  assert.deepEqual(await cache.statistiques(), { entrees: 0, octets: 0 });
});

test('CacheMiniatures : sans IndexedDB ou en échec d\'ouverture, aucun effet et aucune exception', async () => {
  for (const cache of [new CacheMiniatures({ fabrique: null }), new CacheMiniatures({ fabrique: fabriqueFactice({ echecOuverture: true }) })]) {
    assert.equal(await cache.ecrire('a', PNG(1)), false);
    assert.equal(await cache.lire('a'), null);
    assert.deepEqual(await cache.statistiques(), { entrees: 0, octets: 0 });
    assert.equal(await cache.purger(), 0);
    assert.equal(await cache.vider(), 0);
  }
  assert.equal(new CacheMiniatures({ fabrique: null }).disponible, false);
});

test('CacheMiniatures.purger : supprime les versions périmées puis les moins récentes au-delà de la limite d\'entrées', async () => {
  let t = 0;
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique, horloge: () => (t += 10), entreesMax: 3 });
  await cache.ecrire('v1:ancienne', PNG(0));
  for (let i = 1; i <= 5; i += 1) await cache.ecrire(`v2:${i}`, PNG(i));
  const supprimees = await cache.purger('v2:');
  assert.equal(supprimees, 3, 'une version périmée et deux entrées en trop');
  assert.deepEqual([...fabrique.donnees.keys()].sort(), ['v2:3', 'v2:4', 'v2:5']);
});

test('CacheMiniatures.purger : respecte aussi la limite de volume', async () => {
  let t = 0;
  const fabrique = fabriqueFactice();
  const taille = PNG(1).length;
  const cache = new CacheMiniatures({ fabrique, horloge: () => (t += 10), octetsMax: taille * 2 + 1 });
  for (let i = 1; i <= 4; i += 1) await cache.ecrire(`v2:${i}`, PNG(i));
  assert.equal(await cache.purger('v2:'), 2);
  assert.deepEqual([...fabrique.donnees.keys()].sort(), ['v2:3', 'v2:4']);
});

test('CacheMiniatures : une lecture ancienne rafraîchit la date d\'usage, une lecture récente non', async () => {
  let t = 1_000;
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique, horloge: () => t });
  await cache.ecrire('a', PNG(1));
  t += 1000;
  await cache.lire('a');
  assert.equal(fabrique.donnees.get('a').instant, 1_000, 'lecture récente : pas d\'écriture');
  t += 3 * 24 * 3600 * 1000;
  await cache.lire('a');
  assert.equal(fabrique.donnees.get('a').instant, t);
});

// ---------------------------------------------------------------------------
// Intégration au générateur de miniatures
// ---------------------------------------------------------------------------

function entree(cle) {
  return { cle, fichier: `${cle}.json`, empreinte: 'e1', erreur: null };
}

function environnement(cache) {
  const taches = [];
  const compteurs = { moteurs: 0, rendus: 0, lectures: 0 };
  const canevas = { toDataURL: () => PNG('rendu') };
  const generateur = new GenerateurMiniatures({
    cache,
    lireShader: async () => { compteurs.lectures += 1; return shaderSimple('S'); },
    creerMoteur: () => {
      compteurs.moteurs += 1;
      return { canevas, horloge: { remettreAZero() {}, sauterA() {} }, compiler() {}, reinitialiserTampons() {}, rendre() { compteurs.rendus += 1; } };
    },
    creerImage: () => ({ dataset: {}, src: '', title: '' }),
    planifier: (tache) => taches.push(tache),
  });
  const vider = async () => {
    for (let i = 0; i < 200 && (taches.length > 0 || generateur._enCours || generateur._hydratation !== null); i += 1) {
      const tache = taches.shift();
      if (tache) tache(); else await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 10));
  };
  return { generateur, compteurs, vider };
}

test('cleCache : préfixe de version, clé de catalogue et empreinte', () => {
  const e = entree('a.json#0');
  assert.equal(cleCache(e), `${PREFIXE_CACHE}${cleMiniature(e)}`);
  assert.match(PREFIXE_CACHE, /^v\d+:$/);
});

test('GenerateurMiniatures + cache : première visite rend et enregistre, seconde affiche sans rendu', async () => {
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique });
  const liste = [entree('a'), entree('b'), entree('c')];

  const premiere = environnement(cache);
  premiere.generateur.definirCatalogue({ entrees: liste });
  const images1 = liste.map((e) => premiere.generateur.imagePour(e));
  premiere.generateur.demander(liste);
  await premiere.vider();
  assert.equal(premiere.compteurs.rendus, 3);
  assert.ok(images1.every((i) => i.dataset.etat === ETAT_MINIATURE.PRETE));
  assert.equal(fabrique.donnees.size, 3);

  const seconde = environnement(cache);
  seconde.generateur.definirCatalogue({ entrees: liste });
  const images2 = liste.map((e) => seconde.generateur.imagePour(e));
  seconde.generateur.demander(liste);
  await seconde.vider();
  assert.equal(seconde.compteurs.rendus, 0, 'aucun rendu WebGL');
  assert.equal(seconde.compteurs.moteurs, 0, 'aucun moteur créé');
  assert.equal(seconde.compteurs.lectures, 0, 'aucun shader relu');
  assert.ok(images2.every((i) => i.dataset.etat === ETAT_MINIATURE.PRETE && i.src === PNG('rendu')));
});

test('GenerateurMiniatures + cache : une entrée au cache et une absente, seule l\'absente est rendue', async () => {
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique });
  await cache.ecrire(cleCache(entree('a')), PNG('stocke'));
  const env = environnement(cache);
  const liste = [entree('a'), entree('b')];
  env.generateur.definirCatalogue({ entrees: liste });
  const [imageA, imageB] = liste.map((e) => env.generateur.imagePour(e));
  env.generateur.demander(liste);
  await env.vider();
  assert.equal(imageA.src, PNG('stocke'));
  assert.equal(imageB.src, PNG('rendu'));
  assert.equal(env.compteurs.rendus, 1);
});

test('GenerateurMiniatures + cache : une autre empreinte ou une autre version du rendu invalide l\'image', async () => {
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique });
  await cache.ecrire(cleCache({ ...entree('a'), empreinte: 'ancienne' }), PNG('vieux'));
  await cache.ecrire(`v0:${cleMiniature(entree('a'))}`, PNG('vieille-version'));
  const env = environnement(cache);
  env.generateur.definirCatalogue({ entrees: [entree('a')] });
  const image = env.generateur.imagePour(entree('a'));
  env.generateur.demander([entree('a')]);
  await env.vider();
  assert.equal(image.src, PNG('rendu'));
  assert.equal(env.compteurs.rendus, 1);
});

test('GenerateurMiniatures + cache : un cache en échec n\'empêche pas la génération', async () => {
  const cache = new CacheMiniatures({ fabrique: fabriqueFactice({ echecOuverture: true }) });
  const env = environnement(cache);
  env.generateur.definirCatalogue({ entrees: [entree('a')] });
  const image = env.generateur.imagePour(entree('a'));
  env.generateur.demander([entree('a')]);
  await env.vider();
  assert.equal(image.dataset.etat, ETAT_MINIATURE.PRETE);
  assert.equal(env.compteurs.rendus, 1);
});

test('GenerateurMiniatures : les échecs de rendu ne sont pas enregistrés dans le cache', async () => {
  const fabrique = fabriqueFactice();
  const cache = new CacheMiniatures({ fabrique });
  const generateur = new GenerateurMiniatures({
    cache,
    lireShader: async () => { throw new Error('illisible'); },
    creerMoteur: () => ({}),
    creerImage: () => ({ dataset: {}, src: '', title: '' }),
    planifier: (t) => t(),
  });
  generateur.definirCatalogue({ entrees: [entree('x')] });
  generateur.imagePour(entree('x'));
  generateur.demander([entree('x')]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fabrique.donnees.size, 0);
  assert.equal(generateur.etatDe(entree('x')).etat, ETAT_MINIATURE.ERREUR);
});
