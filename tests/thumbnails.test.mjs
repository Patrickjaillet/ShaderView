// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ETAT_MINIATURE,
  GenerateurMiniatures,
  HAUTEUR_MINIATURE,
  LARGEUR_MINIATURE,
  TEMPS_CAPTURE_SECONDES,
  cleMiniature,
  resumerErreur,
  resumerErreurCompilation,
} from '../js/thumbnails.js';
import { ErreurCompilation, ErreurContexte } from '../js/renderer.js';
import { passe, shaderSimple } from './fixtures.mjs';

// ---------------------------------------------------------------------------
// Dépendances factices
// ---------------------------------------------------------------------------

function entree(cle, extra = {}) {
  return { cle, fichier: `${cle}.json`, empreinte: 'e1', erreur: null, ...extra };
}

/** Environnement complet : journal des appels, moteur partagé factice, canevas factices, planificateur manuel. */
function creerEnvironnement({ shaders = {}, echecCompilation = {}, echecMoteur = null } = {}) {
  const journal = [];
  const taches = [];
  const compteurs = { moteurs: 0, canevas: 0, lectures: 0 };
  const canevasGl = { id: 'canevas-gl' };

  const creerMoteur = () => {
    compteurs.moteurs += 1;
    if (echecMoteur !== null) throw echecMoteur;
    return {
      canevas: canevasGl,
      horloge: {
        remettreAZero: () => journal.push('zero'),
        sauterA: (t) => journal.push(`saut:${t}`),
      },
      compiler: (normalise) => {
        journal.push(`compiler:${normalise.info.nom}`);
        const echec = echecCompilation[normalise.info.nom];
        if (echec !== undefined) throw echec;
      },
      reinitialiserTampons: () => journal.push('tampons'),
      rendre: () => journal.push('rendre'),
      detruire: () => journal.push('detruire'),
    };
  };

  const creerCanevas = () => {
    compteurs.canevas += 1;
    const contexte = { drawImage: (...args) => journal.push(`copie:${args.slice(1).join(',')}`) };
    return { dataset: {}, title: '', getContext: (type) => (type === '2d' ? contexte : null) };
  };

  const lireShader = async (e) => {
    compteurs.lectures += 1;
    journal.push(`lire:${e.cle}`);
    const shader = shaders[e.cle];
    if (shader === undefined) throw new Error(`Lecture de ${e.fichier} impossible.`);
    return shader;
  };

  const generateur = new GenerateurMiniatures({ lireShader, creerMoteur, creerCanevas, planifier: (t) => taches.push(t) });

  /** Exécute les tâches planifiées jusqu'à épuisement de la file. */
  async function vider() {
    while (taches.length > 0) {
      taches.shift()();
      await new Promise((r) => setImmediate(r));
    }
  }
  return { generateur, journal, compteurs, vider, taches };
}

const shaderNomme = (nom) => shaderSimple(nom);

// ---------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------

test('cleMiniature : dépend de la clé et de l\'empreinte', () => {
  assert.notEqual(cleMiniature(entree('a')), cleMiniature(entree('b')));
  assert.notEqual(cleMiniature(entree('a', { empreinte: 'x' })), cleMiniature(entree('a', { empreinte: 'y' })));
  assert.equal(cleMiniature(entree('a')), cleMiniature(entree('a')));
});

test('resumerErreur : première ligne non vide, tronquée', () => {
  assert.equal(resumerErreur(new Error('\n  \n première \n seconde')), 'première');
  assert.equal(resumerErreur('texte'), 'texte');
  const long = resumerErreur(new Error('x'.repeat(500)));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('resumerErreurCompilation : passe fautive et première erreur localisée', () => {
  const e = new ErreurCompilation('Échec général', [
    { ligne: null, colonne: null, message: 'dans l\'en-tête', brut: '' },
    { ligne: 12, colonne: null, message: "'x' : identifiant non déclaré", brut: '' },
  ], 'buffer-A');
  assert.equal(resumerErreurCompilation(e), "Compilation (buffer-A), ligne 12 : 'x' : identifiant non déclaré");
});

test('resumerErreurCompilation : sans erreur détaillée, repli sur le message général', () => {
  const e = new ErreurCompilation('Échec de liaison du programme : trop de uniforms', []);
  assert.equal(resumerErreurCompilation(e), 'Compilation (image), Échec de liaison du programme : trop de uniforms');
});

// ---------------------------------------------------------------------------
// Canevas dédiés
// ---------------------------------------------------------------------------

test('canevasPour : un canevas dédié par entrée, toujours le même pour une même entrée', () => {
  const { generateur, compteurs } = creerEnvironnement();
  const a = generateur.canevasPour(entree('a'));
  const b = generateur.canevasPour(entree('b'));
  assert.notEqual(a, b);
  assert.equal(generateur.canevasPour(entree('a')), a);
  assert.equal(compteurs.canevas, 2);
  assert.equal(a.dataset.etat, ETAT_MINIATURE.EN_ATTENTE);
});

test('constantes : miniature 160 × 90 (16:9)', () => {
  assert.equal(LARGEUR_MINIATURE, 160);
  assert.equal(HAUTEUR_MINIATURE, 90);
  assert.equal(LARGEUR_MINIATURE / HAUTEUR_MINIATURE, 16 / 9);
});

// ---------------------------------------------------------------------------
// Génération
// ---------------------------------------------------------------------------

test('génération : chaque entrée est compilée, rendue au temps de capture puis copiée en 160 × 90', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A') } });
  const a = entree('a');
  const canevas = env.generateur.canevasPour(a);
  env.generateur.demander([a]);
  await env.vider();

  assert.equal(canevas.dataset.etat, ETAT_MINIATURE.PRETE);
  assert.deepEqual(env.journal, [
    'lire:a', 'compiler:A', 'tampons', 'zero', `saut:${TEMPS_CAPTURE_SECONDES}`, 'rendre', 'copie:0,0,160,90',
  ]);
});

test('génération : la copie suit immédiatement le rendu (aucune étape entre les deux)', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A'), b: shaderNomme('B') } });
  const liste = [entree('a'), entree('b')];
  env.generateur.demander(liste);
  await env.vider();
  for (let i = 0; i < env.journal.length; i += 1) {
    if (env.journal[i] === 'rendre') assert.ok(env.journal[i + 1].startsWith('copie:'), 'copie juste après rendre');
  }
});

test('génération : un seul moteur partagé par toutes les miniatures', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A'), b: shaderNomme('B'), c: shaderNomme('C') } });
  env.generateur.demander([entree('a'), entree('b'), entree('c')]);
  await env.vider();
  assert.equal(env.compteurs.moteurs, 1);
  assert.equal(env.journal.filter((j) => j === 'rendre').length, 3);
});

test('génération : le moteur n\'est créé qu\'au premier besoin', () => {
  const env = creerEnvironnement();
  env.generateur.canevasPour(entree('a'));
  assert.equal(env.compteurs.moteurs, 0);
});

test('génération : les entrées sont traitées dans l\'ordre d\'affichage, une par tâche planifiée', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A'), b: shaderNomme('B'), c: shaderNomme('C') } });
  env.generateur.demander([entree('c'), entree('a'), entree('b')]);
  assert.equal(env.taches.length, 1, 'une seule tâche planifiée à la fois');
  await env.vider();
  assert.deepEqual(env.journal.filter((j) => j.startsWith('lire:')), ['lire:c', 'lire:a', 'lire:b']);
});

test('demander : un nouvel ordre redonne la priorité aux entrées affichées', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A'), b: shaderNomme('B'), c: shaderNomme('C') } });
  env.generateur.demander([entree('a'), entree('b'), entree('c')]);
  env.generateur.demander([entree('c')]); // filtre : seule c est affichée
  await env.vider();
  assert.deepEqual(env.journal.filter((j) => j.startsWith('lire:')), ['lire:c']);
  assert.equal(env.generateur.etatDe(entree('a')).etat, ETAT_MINIATURE.EN_ATTENTE);
});

test('demander : une miniature déjà prête n\'est jamais régénérée', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A') } });
  env.generateur.demander([entree('a')]);
  await env.vider();
  env.generateur.demander([entree('a')]);
  await env.vider();
  assert.equal(env.compteurs.lectures, 1);
});

test('génération : le shader est converti en GLSL ES 3.00 avant compilation', async () => {
  const shader = { ...shaderSimple('Ancien'), renderpass: [passe('image', { code: 'void mainImage(out vec4 c, in vec2 p) { c = texture2D(iChannel0, p); }' })] };
  const vues = [];
  const generateur = new GenerateurMiniatures({
    lireShader: async () => shader,
    creerMoteur: () => ({
      canevas: {},
      horloge: { remettreAZero() {}, sauterA() {} },
      compiler: (n) => vues.push(n.image.code),
      reinitialiserTampons() {},
      rendre() {},
    }),
    creerCanevas: () => ({ dataset: {}, getContext: () => ({ drawImage() {} }) }),
    planifier: (t) => setImmediate(t),
  });
  generateur.demander([entree('a')]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(vues.length, 1);
  assert.match(vues[0], /texture\(iChannel0/);
  assert.doesNotMatch(vues[0], /texture2D/);
});

// ---------------------------------------------------------------------------
// Échecs
// ---------------------------------------------------------------------------

test('échec : une entrée déjà en erreur au catalogue n\'est ni lue ni rendue', async () => {
  const env = creerEnvironnement();
  const e = entree('x', { erreur: 'JSON invalide.' });
  const canevas = env.generateur.canevasPour(e);
  env.generateur.demander([e]);
  await env.vider();
  assert.equal(canevas.dataset.etat, ETAT_MINIATURE.ERREUR);
  assert.equal(canevas.title, 'JSON invalide.');
  assert.equal(env.compteurs.lectures, 0);
  assert.equal(env.compteurs.moteurs, 0);
});

test('échec : un shader qui ne compile pas n\'arrête pas les suivants', async () => {
  const env = creerEnvironnement({
    shaders: { a: shaderNomme('A'), b: shaderNomme('B') },
    echecCompilation: { A: new ErreurCompilation('Échec', [{ ligne: 3, colonne: null, message: 'erreur de syntaxe', brut: '' }], 'image') },
  });
  env.generateur.demander([entree('a'), entree('b')]);
  await env.vider();
  assert.deepEqual(env.generateur.etatDe(entree('a')), { etat: ETAT_MINIATURE.ERREUR, message: 'Compilation (image), ligne 3 : erreur de syntaxe' });
  assert.equal(env.generateur.etatDe(entree('b')).etat, ETAT_MINIATURE.PRETE);
  assert.equal(env.journal.filter((j) => j.startsWith('copie:')).length, 1, 'aucune copie pour le shader fautif');
});

test('échec : shader invalide (sans passe image) consigné comme tel', async () => {
  const env = creerEnvironnement({ shaders: { a: { info: { name: 'Vide' }, renderpass: [] } } });
  env.generateur.demander([entree('a')]);
  await env.vider();
  const etat = env.generateur.etatDe(entree('a'));
  assert.equal(etat.etat, ETAT_MINIATURE.ERREUR);
  assert.match(etat.message, /^Shader invalide : /);
});

test('échec : fichier illisible consigné sans bloquer la file', async () => {
  const env = creerEnvironnement({ shaders: { b: shaderNomme('B') } }); // « a » absent : la lecture échoue
  env.generateur.demander([entree('a'), entree('b')]);
  await env.vider();
  assert.match(env.generateur.etatDe(entree('a')).message, /impossible/);
  assert.equal(env.generateur.etatDe(entree('b')).etat, ETAT_MINIATURE.PRETE);
});

test('échec : WebGL2 absent met toutes les entrées en erreur, sans retenter le moteur', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A'), b: shaderNomme('B') }, echecMoteur: new ErreurContexte('WebGL2 indisponible.') });
  const liste = [entree('a'), entree('b')];
  env.generateur.demander(liste);
  await env.vider();
  assert.equal(env.generateur.etatDe(entree('a')).etat, ETAT_MINIATURE.ERREUR);
  assert.equal(env.generateur.etatDe(entree('b')).etat, ETAT_MINIATURE.ERREUR);
  assert.equal(env.compteurs.moteurs, 1);
  // Une entrée découverte plus tard hérite de l'indisponibilité.
  const tardive = env.generateur.canevasPour(entree('c'));
  assert.equal(tardive.dataset.etat, ETAT_MINIATURE.ERREUR);
});

// ---------------------------------------------------------------------------
// Changement de catalogue
// ---------------------------------------------------------------------------

test('catalogue : les miniatures des entrées conservées (même empreinte) sont gardées, les autres libérées', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A'), b: shaderNomme('B') } });
  const canevasA = env.generateur.canevasPour(entree('a'));
  env.generateur.canevasPour(entree('b'));
  env.generateur.demander([entree('a'), entree('b')]);
  await env.vider();

  env.generateur.definirCatalogue({ entrees: [entree('a'), entree('b', { empreinte: 'e2' })] });
  assert.equal(env.generateur.canevasPour(entree('a')), canevasA, 'a inchangée : même canevas, déjà prêt');
  assert.equal(env.generateur.etatDe(entree('a')).etat, ETAT_MINIATURE.PRETE);
  assert.equal(env.generateur.etatDe(entree('b')), null, 'ancienne version de b libérée');
  assert.equal(env.generateur.canevasPour(entree('b', { empreinte: 'e2' })).dataset.etat, ETAT_MINIATURE.EN_ATTENTE);
});

test('catalogue : un résultat obtenu pour l\'ancien catalogue est écarté', async () => {
  let liberer;
  const attente = new Promise((r) => { liberer = r; });
  const journal = [];
  const generateur = new GenerateurMiniatures({
    lireShader: async () => { await attente; return shaderNomme('A'); },
    creerMoteur: () => ({
      canevas: {}, horloge: { remettreAZero() {}, sauterA() {} },
      compiler: () => journal.push('compiler'), reinitialiserTampons() {}, rendre: () => journal.push('rendre'),
    }),
    creerCanevas: () => ({ dataset: {}, getContext: () => ({ drawImage: () => journal.push('copie') }) }),
    planifier: (t) => setImmediate(t),
  });
  const a = entree('a');
  generateur.demander([a]);
  await new Promise((r) => setTimeout(r, 10)); // lecture en cours
  assert.equal(generateur.etatDe(a).etat, ETAT_MINIATURE.EN_COURS);

  generateur.definirCatalogue({ entrees: [a] }); // rechargement automatique du catalogue
  liberer();
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(journal, [], 'ni compilation, ni rendu, ni copie');
  assert.equal(generateur.etatDe(a).etat, ETAT_MINIATURE.EN_ATTENTE, 'redemandée par la liste');
});

test('detruire : libère le moteur et oublie les miniatures', async () => {
  const env = creerEnvironnement({ shaders: { a: shaderNomme('A') } });
  env.generateur.demander([entree('a')]);
  await env.vider();
  env.generateur.detruire();
  assert.ok(env.journal.includes('detruire'));
  assert.equal(env.generateur.etatDe(entree('a')), null);
});
