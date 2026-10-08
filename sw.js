// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Service Worker : permet d'ouvrir ShaderView hors-ligne après une première visite. Il ne touche qu'aux fichiers du
// site lui-même (même origine) ; aucune ressource externe n'est jamais demandée.
//
//   - Coque de l'application (index.html, CSS, JavaScript, icônes) : mise en cache complète à l'installation, servie
//     d'abord depuis le cache. Une nouvelle version s'installe en arrière-plan et attend : l'application propose alors
//     à l'utilisateur de recharger (message « activer »), la version en cours n'est jamais remplacée sans son accord.
//   - Données (shaders, médias, audio, manifestes) : réseau d'abord, copie du cache en secours hors-ligne. En ligne,
//     le contenu est donc toujours à jour ; chaque fichier lu une fois reste disponible sans connexion.
//
// Les lignes entre les marqueurs « généré » sont produites par `node tools/generer-sw.mjs` (la version est une empreinte de la
// coque : tout changement d'un fichier de la coque change la version, donc le cache) ; ne pas les modifier à la main.

// <généré>
const VERSION = '324e435bf55f';
const COQUE = [
  './',
  'branding/favicon.svg',
  'branding/icone-192.png',
  'branding/icone-512.png',
  'branding/icone-maskable-512.png',
  'css/main.css',
  'index.html',
  'js/.gitkeep',
  'js/app.js',
  'js/audio.js',
  'js/cache-miniatures.js',
  'js/catalog.js',
  'js/diagnostic.js',
  'js/economie.js',
  'js/export/.gitkeep',
  'js/export/index.js',
  'js/export/mp4.js',
  'js/export/spool.js',
  'js/export/video.js',
  'js/export/webm.js',
  'js/hors-ligne.js',
  'js/i18n.js',
  'js/inspector.js',
  'js/media.js',
  'js/miniatures-worker.js',
  'js/parser.js',
  'js/renderer.js',
  'js/shader-meta.js',
  'js/thumbnails.js',
  'js/vendor/.gitkeep',
  'manifest.webmanifest',
];
// </généré>

const CACHE_COQUE = `shaderview-coque-${VERSION}`;
const CACHE_DONNEES = 'shaderview-donnees';

/** Chemins (relatifs à l'emplacement du Service Worker) traités comme des données : réseau d'abord. */
const DOSSIERS_DONNEES = ['shaders/', 'audio/'];

function estDonnee(url, base) {
  if (url.origin !== base.origin) return false;
  const chemin = url.pathname.slice(base.pathname.length);
  return DOSSIERS_DONNEES.some((dossier) => chemin.startsWith(dossier));
}

async function installer() {
  const cache = await caches.open(CACHE_COQUE);
  // `reload` : la coque est lue au réseau, pas dans le cache HTTP du navigateur, pour que la version mise en cache soit celle du serveur.
  await cache.addAll(COQUE.map((chemin) => new Request(chemin, { cache: 'reload' })));
}

async function activer() {
  const noms = await caches.keys();
  await Promise.all(noms.filter((nom) => nom.startsWith('shaderview-coque-') && nom !== CACHE_COQUE).map((nom) => caches.delete(nom)));
  await self.clients.claim();
}

async function depuisCoque(requete) {
  const cache = await caches.open(CACHE_COQUE);
  // `ignoreSearch` : « index.html?x » et « ./ » servent la même coque ; la navigation vers un dossier renvoie index.html.
  const reponse = await cache.match(requete, { ignoreSearch: true });
  if (reponse !== undefined) return reponse;
  if (requete.mode === 'navigate') {
    const accueil = await cache.match(new URL('index.html', self.registration.scope).href);
    if (accueil !== undefined) return accueil;
  }
  return fetch(requete);
}

async function reseauPuisCache(requete) {
  const cache = await caches.open(CACHE_DONNEES);
  try {
    const reponse = await fetch(requete);
    // Seules les réponses complètes et réussies sont conservées (pas de 404, pas de réponse partielle à une requête d'intervalle).
    if (reponse.ok && reponse.status === 200) await cache.put(requete, reponse.clone());
    return reponse;
  } catch (erreur) {
    const copie = await cache.match(requete);
    if (copie !== undefined) return copie;
    throw erreur;
  }
}

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(installer());
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(activer());
});

self.addEventListener('message', (evenement) => {
  if (evenement.data === 'activer') self.skipWaiting();
  else if (evenement.data === 'version') evenement.source?.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;
  if (requete.method !== 'GET') return;
  const url = new URL(requete.url);
  const base = new URL(self.registration.scope);
  if (url.origin !== base.origin) return; // jamais d'interception hors du site
  if (estDonnee(url, base)) evenement.respondWith(reseauPuisCache(requete));
  else evenement.respondWith(depuisCoque(requete));
});
