// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Diagnostic local : journal borné des erreurs d'exécution et texte récapitulatif (navigateur, GPU, extensions WebGL,
// codecs, shader courant) que l'utilisateur copie lui-même dans un signalement. Rien n'est jamais envoyé : aucune
// requête réseau (voir tools/audit-reseau.mjs). Comme les autres modules de logique, la construction du texte et le
// journal sont indépendants du DOM ; seule `installerCaptureErreurs` touche à `window`.

/** Version de l'application affichée dans le diagnostic (alignée sur package.json, vérifiée par un test). */
export const VERSION_APPLICATION = '1.1.0';

/** Nombre maximal d'entrées conservées dans le journal : les plus anciennes sont écartées. */
export const TAILLE_MAX_JOURNAL = 50;

// Longueur maximale d'un message ou d'une trace, pour qu'une erreur répétée ne grossisse pas le diagnostic.
const LONGUEUR_MAX_MESSAGE = 500;
const LONGUEUR_MAX_TRACE = 1200;

function tronquer(texte, longueur) {
  const s = String(texte ?? '');
  return s.length > longueur ? `${s.slice(0, longueur)}…` : s;
}

/**
 * Journal borné des erreurs d'exécution. Une erreur identique à la dernière consécutive incrémente un compteur au lieu
 * d'ajouter une ligne, pour qu'une erreur levée à chaque image n'efface pas les autres.
 */
export class JournalErreurs {
  /**
   * @param {number} [taille] nombre maximal d'entrées
   * @param {() => number} [horloge] source de l'heure en millisecondes (injectable pour les tests)
   */
  constructor(taille = TAILLE_MAX_JOURNAL, horloge = () => Date.now()) {
    this.taille = taille;
    this._horloge = horloge;
    this._entrees = [];
    this._abonnes = new Set();
  }

  /** Copie des entrées, de la plus ancienne à la plus récente. */
  get entrees() { return this._entrees.map((e) => ({ ...e })); }

  get longueur() { return this._entrees.length; }

  /**
   * @param {string} source origine de l'erreur (« error », « promise », « shader »…)
   * @param {string} message
   * @param {string} [trace]
   */
  ajouter(source, message, trace = '') {
    const msg = tronquer(message, LONGUEUR_MAX_MESSAGE);
    const dernier = this._entrees[this._entrees.length - 1];
    if (dernier !== undefined && dernier.source === source && dernier.message === msg) {
      dernier.occurrences += 1;
      dernier.instant = this._horloge();
    } else {
      this._entrees.push({ source, message: msg, trace: tronquer(trace, LONGUEUR_MAX_TRACE), instant: this._horloge(), occurrences: 1 });
      while (this._entrees.length > this.taille) this._entrees.shift();
    }
    for (const abonne of this._abonnes) abonne(this);
  }

  vider() {
    this._entrees = [];
    for (const abonne of this._abonnes) abonne(this);
  }

  /** @param {(journal: JournalErreurs) => void} rappel appelé après chaque ajout ou vidage ; renvoie la fonction de désabonnement */
  surChangement(rappel) {
    this._abonnes.add(rappel);
    return () => this._abonnes.delete(rappel);
  }
}

/**
 * Branche le journal sur les erreurs non interceptées et les promesses rejetées sans gestionnaire d'une fenêtre.
 * @param {JournalErreurs} journal
 * @param {{ addEventListener: Function, removeEventListener: Function }} fenetre
 * @returns {() => void} fonction de retrait des écouteurs
 */
export function installerCaptureErreurs(journal, fenetre) {
  const surErreur = (evenement) => {
    const lieu = evenement.filename ? ` (${String(evenement.filename).split('/').pop()}:${evenement.lineno ?? '?'})` : '';
    journal.ajouter('error', `${evenement.message ?? 'Erreur inconnue'}${lieu}`, evenement.error?.stack ?? '');
  };
  const surRejet = (evenement) => {
    const raison = evenement.reason;
    journal.ajouter('promise', raison instanceof Error ? `${raison.name} : ${raison.message}` : String(raison), raison?.stack ?? '');
  };
  fenetre.addEventListener('error', surErreur);
  fenetre.addEventListener('unhandledrejection', surRejet);
  return () => {
    fenetre.removeEventListener('error', surErreur);
    fenetre.removeEventListener('unhandledrejection', surRejet);
  };
}

function ligne(libelle, valeur) {
  return `${libelle} : ${valeur === undefined || valeur === null || valeur === '' ? 'inconnu' : valeur}`;
}

function oui(valeur) { return valeur ? 'oui' : 'non'; }

/**
 * @typedef {object} InfosDiagnostic
 * @property {string} version
 * @property {string} langue langue de l'interface
 * @property {string} date date ISO du diagnostic
 * @property {{ userAgent?: string, plateforme?: string, langues?: string, coeurs?: number, memoireGo?: number }} navigateur
 * @property {{ rendu?: string, fabricant?: string, version?: string, tailleTextureMax?: number, taille3dMax?: number, extensions?: Record<string, boolean>, precisionHaute?: boolean }|null} webgl null si WebGL2 est indisponible
 * @property {{ videoEncoder: boolean, audioEncoder: boolean, opfs: boolean, selecteurFichier: boolean, audioContext: boolean, webm: string[], mp4: string[] }} capacites
 * @property {{ fichier?: string, titre?: string, alerte?: string|null, inferences?: { passe: string, canal: number, type: string }[] }|null} shader
 * @property {{ source: string, message: string, trace: string, occurrences: number, instant: number }[]} erreurs
 * @property {{ entrees: number, octets: number }|null} [cacheMiniatures] null si IndexedDB est indisponible
 * @property {{ possible: boolean, actif: boolean }} [horsLigne] état du Service Worker
 * @property {'worker'|'principal'|'inconnu'} [modeMiniatures] où les miniatures sont rendues
 */

/**
 * Construit le texte du diagnostic.
 * @param {InfosDiagnostic} infos
 * @returns {string}
 */
export function construireDiagnostic(infos) {
  const lignes = [
    `ShaderView ${infos.version} — diagnostic du ${infos.date}`,
    ligne('Langue de l’interface', infos.langue),
    '',
    '[Navigateur]',
    ligne('Agent', infos.navigateur.userAgent),
    ligne('Plateforme', infos.navigateur.plateforme),
    ligne('Langues', infos.navigateur.langues),
    ligne('Cœurs logiques', infos.navigateur.coeurs),
    ligne('Mémoire (Go, indicatif)', infos.navigateur.memoireGo),
    '',
    '[WebGL2]',
  ];
  if (infos.webgl === null) {
    lignes.push('WebGL2 indisponible.');
  } else {
    const w = infos.webgl;
    lignes.push(
      ligne('Rendu', w.rendu), ligne('Fabricant', w.fabricant), ligne('Version', w.version),
      ligne('Taille de texture max', w.tailleTextureMax), ligne('Taille de texture 3D max', w.taille3dMax),
      ligne('Précision flottante haute (fragment)', oui(w.precisionHaute)),
    );
    for (const [nom, present] of Object.entries(w.extensions ?? {})) lignes.push(`  ${nom} : ${oui(present)}`);
  }
  const c = infos.capacites;
  lignes.push(
    '',
    '[Export et audio]',
    ligne('VideoEncoder', oui(c.videoEncoder)), ligne('AudioEncoder', oui(c.audioEncoder)),
    ligne('Stockage temporaire (OPFS)', oui(c.opfs)), ligne('Sélecteur de fichier', oui(c.selecteurFichier)),
    ligne('AudioContext', oui(c.audioContext)),
    ligne('Codecs WebM acceptés', c.webm.length > 0 ? c.webm.join(', ') : 'aucun'),
    ligne('Codecs MP4 acceptés', c.mp4.length > 0 ? c.mp4.join(', ') : 'aucun'),
    '',
    '[Shader sélectionné]',
  );
  if (infos.shader === null || infos.shader === undefined) {
    lignes.push('Aucun.');
  } else {
    lignes.push(ligne('Fichier', infos.shader.fichier), ligne('Titre', infos.shader.titre), ligne('Alerte', infos.shader.alerte ?? 'aucune'));
    for (const i of infos.shader.inferences ?? []) lignes.push(`  ${i.passe} : iChannel${i.canal} déduit « ${i.type} »`);
  }
  lignes.push('', '[Hors-ligne]');
  if (infos.horsLigne === undefined) lignes.push('Non évalué.');
  else if (!infos.horsLigne.possible) lignes.push('Service Worker indisponible (contexte non sécurisé ou navigateur sans prise en charge).');
  else lignes.push(infos.horsLigne.actif ? 'Service Worker actif : la page est servie par le cache si la connexion tombe.' : 'Service Worker enregistré, pas encore actif sur cette page (rechargez).');
  lignes.push('', '[Cache des miniatures]');
  if (infos.cacheMiniatures === null || infos.cacheMiniatures === undefined) lignes.push('IndexedDB indisponible : miniatures régénérées à chaque visite.');
  else lignes.push(`${infos.cacheMiniatures.entrees} image(s), ${(infos.cacheMiniatures.octets / 1048576).toFixed(1)} Mo`);
  const modes = { worker: 'dans un Worker (OffscreenCanvas)', principal: 'sur le fil principal', inconnu: 'pas encore rendues' };
  lignes.push(`Rendu des miniatures : ${modes[infos.modeMiniatures ?? 'inconnu'] ?? 'inconnu'}`);
  lignes.push('', `[Erreurs d’exécution : ${infos.erreurs.length}]`);
  if (infos.erreurs.length === 0) lignes.push('Aucune.');
  for (const e of infos.erreurs) {
    lignes.push(`- ${e.source}${e.occurrences > 1 ? ` ×${e.occurrences}` : ''} : ${e.message}`);
    if (e.trace) lignes.push(...e.trace.split('\n').slice(0, 4).map((t) => `    ${t.trim()}`));
  }
  return lignes.join('\n');
}

/**
 * Taille estimée d'un export, en octets : (débit vidéo + débit audio) × durée / 8. Sert à prévenir avant un
 * téléchargement qui garderait tout le fichier en mémoire.
 * @param {{ bitrate: number, bitrateAudio?: number, duree: number, audio?: boolean }} options
 * @returns {number}
 */
export function estimerTailleExport({ bitrate, bitrateAudio = 0, duree, audio = false }) {
  const debit = (Number.isFinite(bitrate) ? bitrate : 0) + (audio && Number.isFinite(bitrateAudio) ? bitrateAudio : 0);
  return Math.max(0, Math.round((debit * (Number.isFinite(duree) ? duree : 0)) / 8));
}

/** Au-delà de cette taille, un export sans écriture directe (téléchargement en mémoire) déclenche un avertissement. */
export const SEUIL_AVERTISSEMENT_TELECHARGEMENT = 500 * 1024 * 1024;
