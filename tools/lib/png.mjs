// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Décodeur PNG minimal (Node, sans dépendance) pour la régression visuelle : images 8 bits non entrelacées,
// types de couleur « niveaux de gris », « RVB », « niveaux de gris + alpha » et « RVBA », ce que produisent
// les navigateurs pour `canvas.toDataURL('image/png')`. Tout autre format est refusé explicitement.

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CANAUX_PAR_TYPE = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });

function predicteurPaeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Décode un PNG en pixels RVBA 8 bits.
 * @param {Uint8Array|Buffer} donnees contenu du fichier
 * @returns {{ largeur: number, hauteur: number, rgba: Uint8Array }}
 * @throws {Error} signature invalide, format non géré ou données corrompues
 */
export function decoderPng(donnees) {
  const tampon = Buffer.from(donnees);
  if (tampon.length < 8 || !tampon.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG invalide : signature absente.');
  let largeur = 0;
  let hauteur = 0;
  let canaux = 0;
  let typeCouleur = 0;
  const morceaux = [];
  let decalage = 8;
  while (decalage + 8 <= tampon.length) {
    const longueur = tampon.readUInt32BE(decalage);
    const type = tampon.toString('latin1', decalage + 4, decalage + 8);
    const debut = decalage + 8;
    if (debut + longueur + 4 > tampon.length) throw new Error('PNG invalide : morceau tronqué.');
    if (type === 'IHDR') {
      largeur = tampon.readUInt32BE(debut);
      hauteur = tampon.readUInt32BE(debut + 4);
      const profondeur = tampon[debut + 8];
      typeCouleur = tampon[debut + 9];
      const entrelace = tampon[debut + 12];
      if (profondeur !== 8) throw new Error(`PNG non géré : profondeur ${profondeur} bits (8 attendus).`);
      if (entrelace !== 0) throw new Error('PNG non géré : image entrelacée.');
      canaux = CANAUX_PAR_TYPE[typeCouleur];
      if (canaux === undefined) throw new Error(`PNG non géré : type de couleur ${typeCouleur}.`);
    } else if (type === 'IDAT') {
      morceaux.push(tampon.subarray(debut, debut + longueur));
    } else if (type === 'IEND') {
      break;
    }
    decalage = debut + longueur + 4;
  }
  if (largeur === 0 || hauteur === 0 || canaux === 0) throw new Error('PNG invalide : en-tête IHDR absent.');
  const brut = inflateSync(Buffer.concat(morceaux));
  const pas = largeur * canaux;
  if (brut.length !== (pas + 1) * hauteur) throw new Error('PNG invalide : taille des données décompressées incohérente.');

  const pixels = new Uint8Array(pas * hauteur);
  for (let y = 0; y < hauteur; y += 1) {
    const filtre = brut[y * (pas + 1)];
    const source = y * (pas + 1) + 1;
    const ligne = y * pas;
    for (let i = 0; i < pas; i += 1) {
      const gauche = i >= canaux ? pixels[ligne + i - canaux] : 0;
      const haut = y > 0 ? pixels[ligne - pas + i] : 0;
      const hautGauche = y > 0 && i >= canaux ? pixels[ligne - pas + i - canaux] : 0;
      let predit;
      if (filtre === 0) predit = 0;
      else if (filtre === 1) predit = gauche;
      else if (filtre === 2) predit = haut;
      else if (filtre === 3) predit = (gauche + haut) >> 1;
      else if (filtre === 4) predit = predicteurPaeth(gauche, haut, hautGauche);
      else throw new Error(`PNG invalide : filtre ${filtre} inconnu.`);
      pixels[ligne + i] = (brut[source + i] + predit) & 0xff;
    }
  }

  const rgba = new Uint8Array(largeur * hauteur * 4);
  for (let p = 0; p < largeur * hauteur; p += 1) {
    const s = p * canaux;
    const d = p * 4;
    if (typeCouleur === 6) { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = pixels[s + 3]; }
    else if (typeCouleur === 2) { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = 255; }
    else if (typeCouleur === 0) { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s]; rgba[d + 2] = pixels[s]; rgba[d + 3] = 255; }
    else { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s]; rgba[d + 2] = pixels[s]; rgba[d + 3] = pixels[s + 1]; }
  }
  return { largeur, hauteur, rgba };
}
