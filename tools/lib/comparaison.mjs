// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Comparaison tolérante de deux images RVBA pour la régression visuelle : un pixel est « différent » si l'un de ses
// canaux s'écarte de plus de `tolerancePixel` ; les images diffèrent si la part de pixels différents dépasse
// `partMax`. La tolérance absorbe les écarts d'arrondi entre pilotes graphiques sans masquer un vrai changement.

/**
 * @typedef {object} ResultatComparaison
 * @property {boolean} identiques vrai si l'écart reste dans les tolérances
 * @property {number} pixelsDifferents
 * @property {number} partDifferente part de pixels différents (0 à 1)
 * @property {number} ecartMax plus grand écart de canal observé (0 à 255)
 * @property {string|null} raison explication si les dimensions diffèrent
 */

/**
 * @param {{ largeur: number, hauteur: number, rgba: Uint8Array }} a
 * @param {{ largeur: number, hauteur: number, rgba: Uint8Array }} b
 * @param {{ tolerancePixel?: number, partMax?: number }} [options]
 * @returns {ResultatComparaison}
 */
export function comparerImages(a, b, { tolerancePixel = 8, partMax = 0.005 } = {}) {
  if (a.largeur !== b.largeur || a.hauteur !== b.hauteur) {
    return { identiques: false, pixelsDifferents: Math.max(a.largeur * a.hauteur, b.largeur * b.hauteur), partDifferente: 1, ecartMax: 255,
      raison: `dimensions différentes (${a.largeur}×${a.hauteur} contre ${b.largeur}×${b.hauteur})` };
  }
  const total = a.largeur * a.hauteur;
  let pixelsDifferents = 0;
  let ecartMax = 0;
  for (let p = 0; p < total; p += 1) {
    let ecartPixel = 0;
    for (let c = 0; c < 4; c += 1) {
      const ecart = Math.abs(a.rgba[p * 4 + c] - b.rgba[p * 4 + c]);
      if (ecart > ecartPixel) ecartPixel = ecart;
    }
    if (ecartPixel > ecartMax) ecartMax = ecartPixel;
    if (ecartPixel > tolerancePixel) pixelsDifferents += 1;
  }
  const partDifferente = total > 0 ? pixelsDifferents / total : 0;
  return { identiques: partDifferente <= partMax, pixelsDifferents, partDifferente, ecartMax, raison: null };
}

/**
 * Vrai si l'image n'est pas une couleur unie : sert à détecter un rendu entièrement noir (texture incomplète,
 * canal non lié) que la comparaison à une référence tout aussi noire ne signalerait pas.
 * @param {{ largeur: number, hauteur: number, rgba: Uint8Array }} image
 * @returns {boolean}
 */
export function imageVariee(image) {
  const { rgba } = image;
  for (let i = 4; i < rgba.length; i += 4) {
    if (rgba[i] !== rgba[0] || rgba[i + 1] !== rgba[1] || rgba[i + 2] !== rgba[2]) return true;
  }
  return false;
}
