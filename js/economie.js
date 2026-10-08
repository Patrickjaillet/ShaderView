// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Mode économie : limite le rendu interactif à 30 images par seconde (moins de charge GPU et de batterie sur un écran
// à 60 Hz ou plus). Le choix est mémorisé localement ; il est proposé automatiquement une seule fois quand la batterie
// est faible et ne se décharge pas, et l'utilisateur garde toujours la main (une case à cocher). Le rendu
// déterministe de l'export n'en dépend jamais. Logique indépendante du DOM, testable sous Node.

const CLE_STOCKAGE = 'shaderview.economie';

/** Intervalle minimal entre deux rendus en mode économie : 30 i/s, avec une marge pour la gigue d'un écran à 60 Hz. */
export const INTERVALLE_ECONOMIE_MS = 30;

/** Niveau de batterie (0 à 1) à partir duquel l'économie est proposée si l'appareil ne se recharge pas. */
export const NIVEAU_BATTERIE_FAIBLE = 0.2;

/**
 * @param {{ level?: number, charging?: boolean }|null|undefined} batterie objet `BatteryManager`
 * @returns {boolean} vrai si la batterie est faible et ne se recharge pas
 */
export function batterieFaible(batterie) {
  return typeof batterie?.level === 'number' && batterie.level <= NIVEAU_BATTERIE_FAIBLE && batterie.charging === false;
}

export class ModeEconomie {
  /**
   * @param {{ getItem: Function, setItem: Function }|null} [stockage]
   */
  constructor(stockage = globalThis.localStorage ?? null) {
    this._stockage = stockage;
    let enregistre = null;
    try { enregistre = stockage?.getItem(CLE_STOCKAGE) ?? null; } catch { /* stockage inaccessible : mode désactivé par défaut */ }
    /** Choix explicite de l'utilisateur, ou null s'il n'a jamais décidé (seul cas où la batterie peut le proposer). */
    this.choixExplicite = enregistre === 'oui' ? true : (enregistre === 'non' ? false : null);
    this.actif = this.choixExplicite === true;
  }

  /** Choix de l'utilisateur : mémorisé, et il prime désormais sur toute suggestion automatique. */
  definir(actif) {
    this.actif = actif === true;
    this.choixExplicite = this.actif;
    try { this._stockage?.setItem(CLE_STOCKAGE, this.actif ? 'oui' : 'non'); } catch { /* non mémorisé : valable pour la session */ }
  }

  /**
   * Active le mode sur suggestion automatique (batterie faible) sans le mémoriser comme choix : seulement si l'utilisateur
   * n'a jamais tranché.
   * @returns {boolean} vrai si le mode vient d'être activé
   */
  suggerer() {
    if (this.choixExplicite !== null || this.actif) return false;
    this.actif = true;
    return true;
  }

  /**
   * Faut-il sauter cette image d'affichage ? Seulement en mode économie, pendant la lecture, si la précédente a été
   * rendue il y a moins d'un intervalle.
   * @param {number} horodatage instant de l'image d'affichage (ms)
   * @param {number|null} dernierRendu instant du dernier rendu effectif (ms), null avant le premier
   * @param {boolean} enMarche vrai si l'horloge du shader tourne
   */
  doitSauter(horodatage, dernierRendu, enMarche) {
    return this.actif && enMarche && dernierRendu !== null && horodatage - dernierRendu < INTERVALLE_ECONOMIE_MS;
  }
}
