// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Point d'entrée : charge le catalogue au démarrage (manifeste), propose les replis locaux
// (dossier, fichiers, glisser-déposer) et affiche le détail d'un shader à la sélection.
// L'inspecteur complet (recherche, filtres, tri, code source) est prévu en Phase 7 ;
// cette interface minimale exerce le catalogue de la Phase 1.
//
// Tout le contenu issu des fichiers (titres, messages d'erreur) est inséré avec
// `textContent` : aucun texte provenant d'un shader n'est interprété comme du HTML.

import {
  SOURCES,
  catalogueDepuisFichiers,
  chargerManifeste,
  choisirDossierNatif,
  collecterDepot,
  dossierNatifDisponible,
  fichiersDepuisSelection,
} from './catalog.js';

const LIBELLES_SOURCE = {
  [SOURCES.MANIFESTE]: 'manifeste',
  [SOURCES.DOSSIER]: 'dossier local',
  [SOURCES.FICHIERS]: 'fichiers locaux',
};

const etat = {
  catalogue: null,
  selection: null,
  jetonCatalogue: 0,
  jetonSelection: 0,
};

const el = {};

function noeud(balise, classe, texte) {
  const n = document.createElement(balise);
  if (classe) n.className = classe;
  if (texte !== undefined) n.textContent = texte;
  return n;
}

function pluriel(n, singulier, plurielForme) {
  return `${n} ${n > 1 ? plurielForme : singulier}`;
}

function formaterTaille(octets) {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${(octets / 1024).toFixed(1)} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

function badge(texte, attention = false) {
  return noeud('span', attention ? 'badge badge--attention' : 'badge', texte);
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

function construireElement(entree) {
  const li = document.createElement('li');
  const bouton = noeud('button', entree.erreur === null ? 'element' : 'element element--erreur');
  bouton.type = 'button';
  bouton.dataset.cle = entree.cle;
  bouton.append(noeud('span', 'element__titre', entree.titre), noeud('span', 'element__fichier', entree.fichier));

  if (entree.erreur !== null) {
    bouton.append(noeud('span', 'element__message', entree.erreur));
  } else {
    const badges = noeud('div', 'badges');
    for (const type of new Set(entree.passes)) {
      const nombre = entree.passes.filter((p) => p === type).length;
      badges.append(badge(nombre > 1 ? `${type} ×${nombre}` : type));
    }
    if (entree.multipasse) badges.append(badge('multipasse'));
    if (entree.son) badges.append(badge('son'));
    if (entree.avertissements.length > 0) badges.append(badge(pluriel(entree.avertissements.length, 'avertissement', 'avertissements'), true));
    bouton.append(badges);
  }
  bouton.addEventListener('click', () => selectionner(entree));
  li.append(bouton);
  return li;
}

function afficherCatalogue(catalogue) {
  el.liste.replaceChildren(...catalogue.entrees.map(construireElement));
  const n = catalogue.entrees.length;
  const erreurs = catalogue.nbErreurs;
  let message = `${pluriel(n, 'entrée', 'entrées')} (${LIBELLES_SOURCE[catalogue.source]})`;
  if (n === 0) message = `Aucun fichier .json trouvé (${LIBELLES_SOURCE[catalogue.source]}).`;
  else if (erreurs > 0) message += `, dont ${pluriel(erreurs, 'en erreur', 'en erreur')}`;
  el.etat.textContent = `${message}.`;
}

function appliquerCatalogue(catalogue) {
  if (etat.catalogue !== null) etat.catalogue.vider();
  etat.catalogue = catalogue;
  etat.selection = null;
  etat.jetonSelection += 1;
  el.detail.hidden = true;
  afficherCatalogue(catalogue);
}

// ---------------------------------------------------------------------------
// Détail (chargement paresseux du contenu)
// ---------------------------------------------------------------------------

function marquerSelection(cle) {
  for (const b of el.liste.querySelectorAll('.element')) {
    if (b.dataset.cle === cle) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
}

async function selectionner(entree) {
  const catalogue = etat.catalogue;
  const jeton = ++etat.jetonSelection;
  etat.selection = entree;
  marquerSelection(entree.cle);

  el.detail.hidden = false;
  el.detailTitre.textContent = entree.titre;
  el.detailMeta.textContent = `${entree.fichier} · ${formaterTaille(entree.taille)}`;
  el.detailPasses.replaceChildren();
  el.detailAlerte.hidden = true;

  if (entree.erreur !== null) {
    el.detailAlerte.textContent = entree.erreur;
    el.detailAlerte.hidden = false;
    return;
  }

  let shader;
  try {
    shader = await catalogue.contenu(entree);
  } catch (e) {
    if (jeton !== etat.jetonSelection) return;
    el.detailAlerte.textContent = e instanceof Error ? e.message : String(e);
    el.detailAlerte.hidden = false;
    return;
  }
  if (jeton !== etat.jetonSelection) return;

  const lignes = shader.renderpass.map((passe, n) => {
    const entrees = Array.isArray(passe.inputs) ? passe.inputs.length : 0;
    const nom = typeof passe.name === 'string' && passe.name !== '' ? passe.name : `passe ${n + 1}`;
    return `${nom} — ${passe.type}, ${pluriel(passe.code.split('\n').length, 'ligne', 'lignes')}, ${pluriel(entrees, 'entrée', 'entrées')}`;
  });
  el.detailPasses.replaceChildren(...lignes.map((l) => noeud('li', '', l)));

  const alertes = [];
  if (entree.perime) alertes.push('Le fichier a changé depuis la génération du manifeste : relancer « node tools/build-manifest.mjs ».');
  alertes.push(...entree.avertissements);
  if (alertes.length > 0) {
    el.detailAlerte.textContent = alertes.join(' ');
    el.detailAlerte.hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Sources du catalogue
// ---------------------------------------------------------------------------

async function demarrerAvecManifeste() {
  const jeton = ++etat.jetonCatalogue;
  el.etat.textContent = 'Chargement du catalogue…';
  try {
    const catalogue = await chargerManifeste();
    if (jeton === etat.jetonCatalogue) appliquerCatalogue(catalogue);
  } catch (e) {
    if (jeton !== etat.jetonCatalogue) return;
    const detail = e instanceof Error ? e.message : String(e);
    el.etat.textContent = `Catalogue indisponible : ${detail} Ouvrez le dossier shaders/ ou déposez vos fichiers .json.`;
  }
}

async function chargerFichiersLocaux(fichiers, source) {
  const jeton = ++etat.jetonCatalogue;
  el.etat.textContent = 'Lecture des fichiers…';
  try {
    const catalogue = await catalogueDepuisFichiers(fichiers, {
      source,
      surProgres: (fait, total) => {
        if (jeton === etat.jetonCatalogue) el.etat.textContent = `Lecture des fichiers… ${fait}/${total}`;
      },
    });
    if (jeton === etat.jetonCatalogue) appliquerCatalogue(catalogue);
  } catch (e) {
    if (jeton === etat.jetonCatalogue) {
      el.etat.textContent = `Lecture impossible : ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

async function ouvrirDossier() {
  if (dossierNatifDisponible()) {
    try {
      const fichiers = await choisirDossierNatif();
      if (fichiers !== null) await chargerFichiersLocaux(fichiers, SOURCES.DOSSIER);
      return;
    } catch (e) {
      // Contexte non sécurisé ou accès refusé : repli sur le sélecteur classique.
      el.etat.textContent = `Sélecteur natif indisponible (${e instanceof Error ? e.message : String(e)}), repli sur le sélecteur classique.`;
    }
  }
  el.entreeDossier.click();
}

// ---------------------------------------------------------------------------
// Glisser-déposer
// ---------------------------------------------------------------------------

function contientDesFichiers(evenement) {
  const types = evenement.dataTransfer?.types;
  return types !== undefined && Array.from(types).includes('Files');
}

function brancherDepot() {
  let compteur = 0;
  window.addEventListener('dragenter', (e) => {
    if (!contientDesFichiers(e)) return;
    e.preventDefault();
    compteur += 1;
    el.depot.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!contientDesFichiers(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!contientDesFichiers(e)) return;
    compteur = Math.max(0, compteur - 1);
    if (compteur === 0) el.depot.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!contientDesFichiers(e)) return;
    e.preventDefault();
    compteur = 0;
    el.depot.hidden = true;
    // La collecte démarre ici, de façon synchrone : le DataTransfer n'est valide que pendant l'événement.
    collecterDepot(e.dataTransfer)
      .then((fichiers) => chargerFichiersLocaux(fichiers, SOURCES.FICHIERS))
      .catch((err) => {
        el.etat.textContent = `Dépôt impossible : ${err instanceof Error ? err.message : String(err)}`;
      });
  });
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function demarrer() {
  el.liste = document.getElementById('catalogue-liste');
  el.etat = document.getElementById('catalogue-etat');
  el.detail = document.getElementById('detail');
  el.detailTitre = document.getElementById('detail-titre');
  el.detailMeta = document.getElementById('detail-meta');
  el.detailPasses = document.getElementById('detail-passes');
  el.detailAlerte = document.getElementById('detail-alerte');
  el.depot = document.getElementById('depot');
  el.entreeDossier = document.getElementById('entree-dossier');
  el.entreeFichiers = document.getElementById('entree-fichiers');

  document.getElementById('btn-dossier').addEventListener('click', ouvrirDossier);
  document.getElementById('btn-fichiers').addEventListener('click', () => el.entreeFichiers.click());
  for (const [entree, source] of [[el.entreeDossier, SOURCES.DOSSIER], [el.entreeFichiers, SOURCES.FICHIERS]]) {
    entree.addEventListener('change', () => {
      const fichiers = fichiersDepuisSelection(entree.files);
      entree.value = '';
      if (fichiers.length > 0) chargerFichiersLocaux(fichiers, source);
    });
  }
  brancherDepot();
  demarrerAvecManifeste();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer);
else demarrer();
