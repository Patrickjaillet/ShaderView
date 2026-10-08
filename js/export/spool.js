// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Stockage temporaire des paquets encodés : ils sont écrits au fur et à mesure dans un fichier du système de fichiers
// privé d'origine (OPFS) au lieu de rester en mémoire jusqu'au muxage. Les muxeurs ne manipulent alors que des
// descripteurs { taille, lire } lus à la demande au moment de l'écriture finale.

export function tailleDonnees(echantillon) {
  if (echantillon.data instanceof Uint8Array) return echantillon.data.length;
  return Number.isSafeInteger(echantillon.taille) && echantillon.taille > 0 ? echantillon.taille : 0;
}

export function donneesOuDescripteur(echantillon) {
  if (echantillon.data instanceof Uint8Array) return echantillon.data;
  return { differe: true, taille: tailleDonnees(echantillon), lire: echantillon.lire };
}

export function longueurPartie(partie) {
  return partie instanceof Uint8Array ? partie.length : partie.taille;
}

export function estDiffere(partie) {
  return partie !== null && typeof partie === 'object' && partie.differe === true;
}

export async function resoudrePartie(partie) {
  if (partie instanceof Uint8Array) return partie;
  if (!estDiffere(partie) || typeof partie.lire !== 'function') throw new TypeError('Partie de fichier invalide.');
  const octets = await partie.lire();
  if (!(octets instanceof Uint8Array) || octets.length !== partie.taille) {
    throw new Error('Le paquet relu depuis le stockage temporaire est incomplet.');
  }
  return octets;
}

class SpoolFichier {
  constructor(racine, nom, handle, flux) {
    this._racine = racine;
    this._nom = nom;
    this._handle = handle;
    this._flux = flux;
    this._fichier = null;
    this._position = 0;
    this._chaine = Promise.resolve();
    this._erreur = null;
    this._termine = false;
  }

  // Réserve la position immédiatement (appel synchrone depuis le callback de l'encodeur) ; l'écriture suit en file.
  ajouter(donnees) {
    const offset = this._position;
    const taille = donnees.length;
    this._position += taille;
    this._chaine = this._chaine
      .then(() => (this._erreur === null ? this._flux.write(donnees) : undefined))
      .catch((erreur) => { this._erreur ??= erreur; });
    return { offset, taille, lire: () => this.lire(offset, taille) };
  }

  async terminer() {
    await this._chaine;
    if (this._erreur !== null) throw this._erreur;
    await this._flux.close();
    this._termine = true;
    this._fichier = await this._handle.getFile();
  }

  async lire(offset, taille) {
    if (this._fichier === null) throw new Error('Le stockage temporaire n’est pas encore finalisé.');
    return new Uint8Array(await this._fichier.slice(offset, offset + taille).arrayBuffer());
  }

  async liberer() {
    try {
      await this._chaine;
      if (!this._termine && typeof this._flux.abort === 'function') await this._flux.abort();
    } catch {
      // Le fichier temporaire est supprimé ci-dessous quoi qu'il arrive.
    }
    this._fichier = null;
    try {
      await this._racine.removeEntry(this._nom);
    } catch {
      // Déjà supprimé ou inaccessible : rien de plus à faire.
    }
  }
}

// Renvoie null lorsque OPFS n'est pas utilisable (navigateur sans createWritable, contexte non sécurisé, quota…) :
// l'appelant conserve alors les paquets en mémoire.
export async function creerSpool({ stockage = globalThis.navigator?.storage } = {}) {
  if (typeof stockage?.getDirectory !== 'function') return null;
  let racine = null;
  let nom = null;
  try {
    racine = await stockage.getDirectory();
    nom = `shaderview-export-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
    const handle = await racine.getFileHandle(nom, { create: true });
    if (typeof handle.createWritable !== 'function') throw new Error('createWritable indisponible');
    const flux = await handle.createWritable();
    return new SpoolFichier(racine, nom, handle, flux);
  } catch {
    if (racine !== null && nom !== null) {
      try { await racine.removeEntry(nom); } catch { /* rien à nettoyer */ }
    }
    return null;
  }
}
