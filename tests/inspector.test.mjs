// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FILTRES,
  PREFERENCES_PAR_DEFAUT,
  TRIS,
  aDesMediasManquants,
  composerListe,
  correspondRecherche,
  ecrirePreferences,
  filtrerEntrees,
  lirePreferences,
  tokeniserGlsl,
  trierEntrees,
  validerPreferences,
} from '../js/inspector.js';

function entree(partiel) {
  return {
    cle: partiel.fichier ?? 'f.json',
    fichier: 'f.json',
    index: 0,
    id: null,
    titre: 'Titre',
    auteur: null,
    description: null,
    tags: [],
    date: null,
    passes: ['image'],
    multipasse: false,
    son: false,
    canaux: [],
    medias: [],
    avertissements: [],
    erreur: null,
    taille: 100,
    empreinte: 'x',
    perime: false,
    ...partiel,
  };
}

// ---------------------------------------------------------------------------
// correspondRecherche
// ---------------------------------------------------------------------------

test('correspondRecherche : requête vide correspond à tout', () => {
  assert.equal(correspondRecherche(entree({}), ''), true);
});

test('correspondRecherche : insensible à la casse et aux accents', () => {
  assert.equal(correspondRecherche(entree({ titre: 'Démo Été' }), 'demo'), true);
  assert.equal(correspondRecherche(entree({ titre: 'Démo Été' }), 'ETE'), true);
});

test('correspondRecherche : trouve par auteur, fichier ou tag', () => {
  assert.equal(correspondRecherche(entree({ auteur: 'Zavie' }), 'zavie'), true);
  assert.equal(correspondRecherche(entree({ fichier: 'mon-super-shader.json' }), 'super'), true);
  assert.equal(correspondRecherche(entree({ tags: ['raymarching', 'fractal'] }), 'fractal'), true);
});

test('correspondRecherche : auteur absent (null) n\'empêche pas la recherche sur les autres champs', () => {
  assert.equal(correspondRecherche(entree({ auteur: null, titre: 'Abc' }), 'abc'), true);
});

test('correspondRecherche : aucune correspondance', () => {
  assert.equal(correspondRecherche(entree({ titre: 'Abc' }), 'xyz'), false);
});

// ---------------------------------------------------------------------------
// aDesMediasManquants / filtrerEntrees
// ---------------------------------------------------------------------------

test('aDesMediasManquants : aucun média référencé, jamais manquant', () => {
  assert.equal(aDesMediasManquants(entree({ medias: [] }), new Set()), false);
});

test('aDesMediasManquants : média référencé et absent de l\'ensemble disponible', () => {
  assert.equal(aDesMediasManquants(entree({ medias: ['/media/a/x.png'] }), new Set()), true);
  assert.equal(aDesMediasManquants(entree({ medias: ['/media/a/x.png'] }), new Set(['y.png'])), true);
});

test('aDesMediasManquants : média référencé et présent, non manquant', () => {
  assert.equal(aDesMediasManquants(entree({ medias: ['/media/a/x.png'] }), new Set(['x.png'])), false);
});

test('filtrerEntrees : MULTIPASSE, SON, ERREURS appliqués en ET logique', () => {
  const entrees = [
    entree({ fichier: 'a', multipasse: true, son: false, erreur: null }),
    entree({ fichier: 'b', multipasse: true, son: true, erreur: null }),
    entree({ fichier: 'c', multipasse: false, son: true, erreur: null }),
  ];
  const resultat = filtrerEntrees(entrees, new Set([FILTRES.MULTIPASSE, FILTRES.SON]), new Set());
  assert.deepEqual(resultat.map((e) => e.fichier), ['b']);
});

test('filtrerEntrees : ERREURS garde seulement les entrées en erreur', () => {
  const entrees = [entree({ fichier: 'a', erreur: null }), entree({ fichier: 'b', erreur: 'oups' })];
  assert.deepEqual(filtrerEntrees(entrees, new Set([FILTRES.ERREURS]), new Set()).map((e) => e.fichier), ['b']);
});

test('filtrerEntrees : MEDIAS_MANQUANTS', () => {
  const entrees = [
    entree({ fichier: 'a', medias: ['/media/a/x.png'] }),
    entree({ fichier: 'b', medias: [] }),
  ];
  assert.deepEqual(filtrerEntrees(entrees, new Set([FILTRES.MEDIAS_MANQUANTS]), new Set()).map((e) => e.fichier), ['a']);
});

test('filtrerEntrees : aucun filtre actif, tout passe', () => {
  const entrees = [entree({ fichier: 'a' }), entree({ fichier: 'b' })];
  assert.equal(filtrerEntrees(entrees, new Set(), new Set()).length, 2);
});

// ---------------------------------------------------------------------------
// trierEntrees
// ---------------------------------------------------------------------------

test('trierEntrees : par nom de fichier, insensible à la casse/accents', () => {
  const entrees = [entree({ fichier: 'Zebre.json' }), entree({ fichier: 'ane.json' }), entree({ fichier: 'Écureuil.json' })];
  assert.deepEqual(trierEntrees(entrees, TRIS.NOM).map((e) => e.fichier), ['ane.json', 'Écureuil.json', 'Zebre.json']);
});

test('trierEntrees : par titre', () => {
  const entrees = [entree({ fichier: 'a', titre: 'Zebre' }), entree({ fichier: 'b', titre: 'Ane' })];
  assert.deepEqual(trierEntrees(entrees, TRIS.TITRE).map((e) => e.fichier), ['b', 'a']);
});

test('trierEntrees : par auteur, les entrées sans auteur viennent en premier', () => {
  const entrees = [entree({ fichier: 'a', auteur: 'Zavie' }), entree({ fichier: 'b', auteur: null })];
  assert.deepEqual(trierEntrees(entrees, TRIS.AUTEUR).map((e) => e.fichier), ['b', 'a']);
});

test('trierEntrees : par taille, croissant', () => {
  const entrees = [entree({ fichier: 'a', taille: 500 }), entree({ fichier: 'b', taille: 100 })];
  assert.deepEqual(trierEntrees(entrees, TRIS.TAILLE).map((e) => e.fichier), ['b', 'a']);
});

test('trierEntrees : par date, les entrées sans date viennent en premier', () => {
  const entrees = [entree({ fichier: 'a', date: 200 }), entree({ fichier: 'b', date: null }), entree({ fichier: 'c', date: 100 })];
  assert.deepEqual(trierEntrees(entrees, TRIS.DATE).map((e) => e.fichier), ['b', 'c', 'a']);
});

test('trierEntrees : decroissant inverse l\'ordre', () => {
  const entrees = [entree({ fichier: 'a', taille: 100 }), entree({ fichier: 'b', taille: 500 })];
  assert.deepEqual(trierEntrees(entrees, TRIS.TAILLE, true).map((e) => e.fichier), ['b', 'a']);
});

test('trierEntrees : ne mute pas le tableau d\'entrée', () => {
  const entrees = [entree({ fichier: 'b' }), entree({ fichier: 'a' })];
  const copie = [...entrees];
  trierEntrees(entrees, TRIS.NOM);
  assert.deepEqual(entrees, copie);
});

test('trierEntrees : clé inconnue replie sur le tri par nom', () => {
  const entrees = [entree({ fichier: 'b' }), entree({ fichier: 'a' })];
  assert.deepEqual(trierEntrees(entrees, 'inconnu').map((e) => e.fichier), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// composerListe
// ---------------------------------------------------------------------------

test('composerListe : combine recherche, filtres et tri', () => {
  const entrees = [
    entree({ fichier: 'a', titre: 'Fractal A', son: true, taille: 500 }),
    entree({ fichier: 'b', titre: 'Fractal B', son: true, taille: 100 }),
    entree({ fichier: 'c', titre: 'Autre', son: false, taille: 50 }),
  ];
  const resultat = composerListe(entrees, { requete: 'fractal', filtresActifs: new Set([FILTRES.SON]), tri: TRIS.TAILLE });
  assert.deepEqual(resultat.map((e) => e.fichier), ['b', 'a']);
});

test('composerListe : options par défaut, équivaut à aucun filtre/recherche, tri par nom', () => {
  const entrees = [entree({ fichier: 'b' }), entree({ fichier: 'a' })];
  assert.deepEqual(composerListe(entrees).map((e) => e.fichier), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Préférences
// ---------------------------------------------------------------------------

test('validerPreferences : objet valide, conservé tel quel', () => {
  const p = { volume: 0.5, filtresActifs: [FILTRES.SON], tri: TRIS.TAILLE, decroissant: true, dernierShader: 'x.json' };
  assert.deepEqual(validerPreferences(p), p);
});

test('validerPreferences : valeurs invalides ou absentes remplacées par les défauts', () => {
  assert.deepEqual(validerPreferences({}), PREFERENCES_PAR_DEFAUT);
  assert.deepEqual(validerPreferences(null), PREFERENCES_PAR_DEFAUT);
  assert.deepEqual(validerPreferences('texte'), PREFERENCES_PAR_DEFAUT);
  assert.deepEqual(validerPreferences({ volume: 5, tri: 'inconnu' }), PREFERENCES_PAR_DEFAUT);
});

test('validerPreferences : filtresActifs filtre les valeurs non reconnues', () => {
  const r = validerPreferences({ filtresActifs: [FILTRES.SON, 'inconnu', FILTRES.MULTIPASSE] });
  assert.deepEqual(r.filtresActifs, [FILTRES.SON, FILTRES.MULTIPASSE]);
});

function stockageFactice() {
  const donnees = new Map();
  return {
    getItem: (k) => (donnees.has(k) ? donnees.get(k) : null),
    setItem: (k, v) => donnees.set(k, v),
    removeItem: (k) => donnees.delete(k),
  };
}

test('lirePreferences/ecrirePreferences : aller-retour', () => {
  const stockage = stockageFactice();
  const p = { volume: 0.3, filtresActifs: [FILTRES.ERREURS], tri: TRIS.DATE, decroissant: true, dernierShader: 'a.json' };
  ecrirePreferences(p, { stockage });
  assert.deepEqual(lirePreferences({ stockage }), p);
});

test('lirePreferences : rien enregistré, préférences par défaut', () => {
  assert.deepEqual(lirePreferences({ stockage: stockageFactice() }), PREFERENCES_PAR_DEFAUT);
});

test('lirePreferences : contenu corrompu (JSON invalide), préférences par défaut sans exception', () => {
  const stockage = stockageFactice();
  stockage.setItem('shaderview.preferences', '{ pas du json');
  assert.deepEqual(lirePreferences({ stockage }), PREFERENCES_PAR_DEFAUT);
});

test('lirePreferences/ecrirePreferences : stockage absent (getItem/setItem lancent), sans exception', () => {
  const stockage = {
    getItem: () => { throw new Error('indisponible'); },
    setItem: () => { throw new Error('indisponible'); },
  };
  assert.deepEqual(lirePreferences({ stockage }), PREFERENCES_PAR_DEFAUT);
  assert.doesNotThrow(() => ecrirePreferences(PREFERENCES_PAR_DEFAUT, { stockage }));
});

// ---------------------------------------------------------------------------
// tokeniserGlsl
// ---------------------------------------------------------------------------

test('tokeniserGlsl : reconstitue exactement le code d\'origine', () => {
  const code = 'void mainImage(out vec4 c, in vec2 p) {\n  c = vec4(1., 0., .5, 1);\n}\n';
  const jetons = tokeniserGlsl(code);
  assert.equal(jetons.map((j) => j.texte).join(''), code);
});

test('tokeniserGlsl : reconnaît les mots-clés et les types', () => {
  const jetons = tokeniserGlsl('uniform vec3 iResolution;');
  assert.deepEqual(jetons.filter((j) => j.categorie === 'motcle').map((j) => j.texte), ['uniform']);
  assert.deepEqual(jetons.filter((j) => j.categorie === 'type').map((j) => j.texte), ['vec3']);
  assert.deepEqual(jetons.filter((j) => j.categorie === 'identifiant').map((j) => j.texte), ['iResolution']);
});

test('tokeniserGlsl : commentaires de ligne et de bloc', () => {
  const jetons = tokeniserGlsl('// ligne\n/* bloc\nsur deux lignes */');
  assert.deepEqual(jetons.filter((j) => j.categorie === 'commentaire').map((j) => j.texte), ['// ligne', '/* bloc\nsur deux lignes */']);
});

test('tokeniserGlsl : nombres sous toutes leurs formes GLSL', () => {
  const jetons = tokeniserGlsl('float a = 0.; float b = .5; float c = 2.5e-3; int d = 3u;');
  assert.deepEqual(jetons.filter((j) => j.categorie === 'nombre').map((j) => j.texte), ['0.', '.5', '2.5e-3', '3u']);
});

test('tokeniserGlsl : chaîne (rare en GLSL, mais acceptée par certains préprocesseurs/commentaires)', () => {
  const jetons = tokeniserGlsl('"texte"');
  assert.deepEqual(jetons.filter((j) => j.categorie === 'chaine').map((j) => j.texte), ['"texte"']);
});

test('tokeniserGlsl : code vide', () => {
  assert.deepEqual(tokeniserGlsl(''), []);
});

test('tokeniserGlsl : accès de type swizzle (x.y) n\'est pas pris pour un nombre', () => {
  const jetons = tokeniserGlsl('a.xyz');
  assert.deepEqual(jetons.filter((j) => j.categorie === 'nombre'), []);
});
