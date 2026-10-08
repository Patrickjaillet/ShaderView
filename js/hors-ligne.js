// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Utilisation hors-ligne : enregistrement du Service Worker (sw.js), proposition de mise à jour contrôlée par l'utilisateur et
// préparation volontaire de tout le catalogue pour une utilisation sans connexion. Le Service Worker ne sert que les fichiers
// du site (même origine) ; ce module n'effectue lui-même aucune requête. Le navigateur, la fabrique de chargement et le
// rechargement sont injectés pour les tests sous Node.

/** Intervalle entre deux vérifications de nouvelle version tant que la page reste ouverte (une heure). */
export const INTERVALLE_VERIFICATION_MS = 3600 * 1000;

/**
 * Le Service Worker est-il utilisable ici ? Il exige un contexte sécurisé (HTTPS ou localhost) : pas depuis un fichier local.
 * @param {{ serviceWorker?: object }} [navigateur]
 * @param {{ isSecureContext?: boolean }} [contexte]
 * @returns {boolean}
 */
export function serviceWorkerPossible(navigateur = globalThis.navigator, contexte = globalThis) {
  return typeof navigateur?.serviceWorker?.register === 'function' && contexte.isSecureContext === true;
}

/**
 * Enregistre le Service Worker et surveille les nouvelles versions : quand une version est installée en attente (et qu'une
 * ancienne contrôle déjà la page), `surMiseAJour` reçoit une fonction `appliquer` qui active la nouvelle version puis recharge
 * la page. Rien n'est jamais remplacé sans appel de `appliquer`.
 * @param {object} options
 * @param {object} [options.navigateur]
 * @param {object} [options.contexte]
 * @param {string} [options.adresse] adresse du script, relative à la page
 * @param {(appliquer: () => void) => void} options.surMiseAJour
 * @param {() => void} [options.recharger] rechargement de la page (`location.reload` par défaut)
 * @param {(rappel: () => void, delai: number) => any} [options.minuteur] `setInterval` injectable
 * @returns {Promise<{ registration: object, verifier: () => Promise<void> }|null>} null si le Service Worker est indisponible ou l'enregistrement échoue
 */
export async function enregistrerServiceWorker({
  navigateur = globalThis.navigator,
  contexte = globalThis,
  adresse = 'sw.js',
  surMiseAJour,
  recharger = () => globalThis.location?.reload(),
  minuteur = (rappel, delai) => setInterval(rappel, delai),
} = {}) {
  if (!serviceWorkerPossible(navigateur, contexte)) return null;
  const conteneur = navigateur.serviceWorker;
  let registration;
  try {
    registration = await conteneur.register(adresse);
  } catch {
    return null;
  }
  let rechargementEnCours = false;
  let appliquerDemande = false;
  conteneur.addEventListener?.('controllerchange', () => {
    // Un seul rechargement, et seulement après une demande explicite (la première installation ne recharge rien).
    if (rechargementEnCours || !appliquerDemande) return;
    rechargementEnCours = true;
    recharger();
  });
  const proposer = (version) => {
    surMiseAJour(() => {
      appliquerDemande = true;
      version.postMessage('activer');
    });
  };
  // Une nouvelle version n'est une « mise à jour » que si une ancienne contrôle déjà la page.
  if (registration.waiting && conteneur.controller) proposer(registration.waiting);
  const surveiller = (installation) => {
    if (installation === null || installation === undefined) return;
    // Déjà installée entre-temps : l'événement de changement d'état a pu précéder cet appel.
    if (installation.state === 'installed' && conteneur.controller) { proposer(installation); return; }
    installation.addEventListener('statechange', () => {
      if (installation.state === 'installed' && conteneur.controller) proposer(installation);
    });
  };
  registration.addEventListener?.('updatefound', () => surveiller(registration.installing));
  // Une mise à jour peut avoir été trouvée pendant l'enregistrement lui-même, avant que l'écouteur n'existe.
  if (registration.installing) surveiller(registration.installing);
  const verifier = async () => { try { await registration.update(); } catch { /* hors-ligne : la version en place reste valable */ } };
  minuteur(verifier, INTERVALLE_VERIFICATION_MS);
  return { registration, verifier };
}

/**
 * Charge une liste d'adresses (le Service Worker en garde une copie au passage) avec un nombre limité de requêtes simultanées.
 * Un échec isolé n'interrompt pas la suite ; l'annulation arrête après les requêtes en cours.
 * @param {string[]} adresses
 * @param {(adresse: string) => Promise<unknown>} chargerUne
 * @param {{ concurrence?: number, surProgres?: (fait: number, total: number, echecs: number) => void, signal?: AbortSignal|null }} [options]
 * @returns {Promise<{ total: number, reussis: number, echecs: number, annule: boolean }>}
 */
export async function preparerHorsLigne(adresses, chargerUne, { concurrence = 4, surProgres = () => {}, signal = null } = {}) {
  const total = adresses.length;
  let suivant = 0;
  let fait = 0;
  let echecs = 0;
  const travailleur = async () => {
    while (suivant < total && signal?.aborted !== true) {
      const adresse = adresses[suivant];
      suivant += 1;
      try { await chargerUne(adresse); } catch { echecs += 1; }
      fait += 1;
      surProgres(fait, total, echecs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrence, total)) }, travailleur));
  return { total, reussis: fait - echecs, echecs, annule: signal?.aborted === true && fait < total };
}

/**
 * État du Service Worker pour le diagnostic.
 * @param {object} [navigateur]
 * @param {object} [contexte]
 * @returns {{ possible: boolean, actif: boolean }}
 */
export function etatHorsLigne(navigateur = globalThis.navigator, contexte = globalThis) {
  const possible = serviceWorkerPossible(navigateur, contexte);
  return { possible, actif: possible && Boolean(navigateur.serviceWorker.controller) };
}
