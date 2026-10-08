// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Cache persistant des miniatures PNG dans IndexedDB (stockage local du navigateur, aucune requête réseau) : une
// miniature rendue une fois est relue aux visites suivantes sans repasser par WebGL. Chaque entrée est indexée par
// la clé de miniature (clé du catalogue + empreinte du fichier + version du rendu, voir thumbnails.js), donc une
// modification du fichier ou du moteur de rendu invalide l'image.
//
// Aucune méthode ne lève d'exception ni ne rejette : un IndexedDB absent, bloqué (navigation privée) ou en échec
// se traduit par « pas de cache » (lectures vides, écritures ignorées), jamais par une erreur d'interface.
// L'accès à IndexedDB est injecté pour permettre les tests sous Node.

/** Nombre maximal d'entrées conservées ; au-delà, les moins récemment utilisées sont purgées. */
export const ENTREES_MAX = 4000;

/** Volume maximal conservé (somme des tailles des images), en octets. */
export const OCTETS_MAX = 80 * 1024 * 1024;

// Une lecture ne rafraîchit la date d'usage que si elle a plus d'un jour : évite une écriture par lecture.
const RAFRAICHISSEMENT_MS = 24 * 3600 * 1000;

const NOM_BASE = 'shaderview-miniatures';
const NOM_STOCK = 'miniatures';
const VERSION_BASE = 1;

function promesseRequete(requete) {
  return new Promise((resolu, rejeter) => {
    requete.onsuccess = () => resolu(requete.result);
    requete.onerror = () => rejeter(requete.error ?? new Error('Requête IndexedDB en échec.'));
  });
}

function promesseTransaction(transaction) {
  return new Promise((resolu, rejeter) => {
    transaction.oncomplete = () => resolu();
    transaction.onerror = () => rejeter(transaction.error ?? new Error('Transaction IndexedDB en échec.'));
    transaction.onabort = () => rejeter(transaction.error ?? new Error('Transaction IndexedDB annulée.'));
  });
}

export class CacheMiniatures {
  /**
   * @param {object} [options]
   * @param {IDBFactory|null} [options.fabrique] fabrique IndexedDB (`indexedDB` par défaut) ; null ou absente : cache inactif
   * @param {() => number} [options.horloge] heure en millisecondes
   * @param {number} [options.entreesMax]
   * @param {number} [options.octetsMax]
   */
  constructor({ fabrique = globalThis.indexedDB ?? null, horloge = () => Date.now(), entreesMax = ENTREES_MAX, octetsMax = OCTETS_MAX } = {}) {
    this._fabrique = fabrique;
    this._horloge = horloge;
    this.entreesMax = entreesMax;
    this.octetsMax = octetsMax;
    this._base = null; // Promise<IDBDatabase|null>
  }

  /** Vrai si IndexedDB est disponible (l'ouverture elle-même peut encore échouer). */
  get disponible() { return this._fabrique !== null && this._fabrique !== undefined; }

  _ouvrir() {
    if (this._base !== null) return this._base;
    this._base = new Promise((resolu) => {
      if (!this.disponible) { resolu(null); return; }
      try {
        const requete = this._fabrique.open(NOM_BASE, VERSION_BASE);
        requete.onupgradeneeded = () => {
          const base = requete.result;
          if (!base.objectStoreNames.contains(NOM_STOCK)) base.createObjectStore(NOM_STOCK, { keyPath: 'cle' });
        };
        requete.onsuccess = () => resolu(requete.result);
        requete.onerror = () => resolu(null);
        requete.onblocked = () => resolu(null);
      } catch {
        resolu(null);
      }
    });
    return this._base;
  }

  /**
   * Lit des miniatures en une seule transaction.
   * @param {string[]} cles
   * @returns {Promise<Map<string, string>>} clé → URL de données PNG, pour les seules clés présentes
   */
  async lireLot(cles) {
    const resultat = new Map();
    const base = await this._ouvrir();
    if (base === null || cles.length === 0) return resultat;
    try {
      const transaction = base.transaction(NOM_STOCK, 'readwrite');
      const stock = transaction.objectStore(NOM_STOCK);
      const maintenant = this._horloge();
      const lectures = cles.map(async (cle) => {
        const entree = await promesseRequete(stock.get(cle));
        if (entree === undefined || typeof entree.donnees !== 'string') return;
        resultat.set(cle, entree.donnees);
        if (maintenant - entree.instant > RAFRAICHISSEMENT_MS) stock.put({ ...entree, instant: maintenant });
      });
      await Promise.all(lectures);
      await promesseTransaction(transaction);
    } catch {
      // Lecture partielle ou échouée : ce qui a été lu reste valable, le reste sera régénéré.
    }
    return resultat;
  }

  /** @param {string} cle @returns {Promise<string|null>} */
  async lire(cle) {
    return (await this.lireLot([cle])).get(cle) ?? null;
  }

  /**
   * Enregistre une miniature (URL de données PNG). Ignorée si le cache est inactif ou si les données ne sont pas un PNG.
   * @param {string} cle
   * @param {string} donnees
   * @returns {Promise<boolean>} vrai si l'écriture a abouti
   */
  async ecrire(cle, donnees) {
    if (typeof donnees !== 'string' || !donnees.startsWith('data:image/png')) return false;
    const base = await this._ouvrir();
    if (base === null) return false;
    try {
      const transaction = base.transaction(NOM_STOCK, 'readwrite');
      transaction.objectStore(NOM_STOCK).put({ cle, donnees, taille: donnees.length, instant: this._horloge() });
      await promesseTransaction(transaction);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Nombre d'entrées et volume cumulé.
   * @returns {Promise<{ entrees: number, octets: number }>}
   */
  async statistiques() {
    const base = await this._ouvrir();
    if (base === null) return { entrees: 0, octets: 0 };
    try {
      const transaction = base.transaction(NOM_STOCK, 'readonly');
      const tout = await promesseRequete(transaction.objectStore(NOM_STOCK).getAll());
      return { entrees: tout.length, octets: tout.reduce((somme, e) => somme + (e.taille ?? 0), 0) };
    } catch {
      return { entrees: 0, octets: 0 };
    }
  }

  /**
   * Purge automatique : supprime les entrées les moins récemment utilisées tant que le nombre ou le volume dépasse la
   * limite, ainsi que toute entrée dont la clé ne commence pas par `prefixe` (version de rendu périmée).
   * @param {string} [prefixe] préfixe des clés valides ; toute autre clé est supprimée
   * @returns {Promise<number>} nombre d'entrées supprimées
   */
  async purger(prefixe = '') {
    const base = await this._ouvrir();
    if (base === null) return 0;
    try {
      const transaction = base.transaction(NOM_STOCK, 'readwrite');
      const stock = transaction.objectStore(NOM_STOCK);
      const tout = await promesseRequete(stock.getAll());
      const aSupprimer = new Set(tout.filter((e) => !e.cle.startsWith(prefixe)).map((e) => e.cle));
      const gardees = tout.filter((e) => !aSupprimer.has(e.cle)).sort((a, b) => b.instant - a.instant);
      let octets = 0;
      gardees.forEach((e, index) => {
        octets += e.taille ?? 0;
        if (index >= this.entreesMax || octets > this.octetsMax) aSupprimer.add(e.cle);
      });
      for (const cle of aSupprimer) stock.delete(cle);
      await promesseTransaction(transaction);
      return aSupprimer.size;
    } catch {
      return 0;
    }
  }

  /**
   * Supprime toutes les miniatures enregistrées.
   * @returns {Promise<number>} nombre d'entrées supprimées
   */
  async vider() {
    const base = await this._ouvrir();
    if (base === null) return 0;
    try {
      const avant = (await this.statistiques()).entrees;
      const transaction = base.transaction(NOM_STOCK, 'readwrite');
      transaction.objectStore(NOM_STOCK).clear();
      await promesseTransaction(transaction);
      return avant;
    } catch {
      return 0;
    }
  }
}
