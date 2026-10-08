// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Analyse structurelle minimale des fichiers produits par l'export (MP4 / ISO BMFF et WebM / Matroska), pour
// contrôler en navigateur réel que le fichier est bien formé indépendamment du lecteur qui le relit. Ce n'est pas
// un démultiplexeur : seules les boîtes et éléments de premier niveau utiles au contrôle sont lus.

/**
 * Boîtes de premier niveau d'un MP4 et résumé de `moov`.
 * @param {Uint8Array} octets
 * @returns {{ boites: { type: string, taille: number, decalage: number }[], moovAvantMdat: boolean, pistes: number, echelleTemps: number|null, duree: number|null, tailleCoherente: boolean, erreurs: string[] }}
 */
export function analyserMp4(octets) {
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const erreurs = [];
  const boites = [];
  const lireBoites = (debut, fin, sortie) => {
    let position = debut;
    while (position + 8 <= fin) {
      let taille = vue.getUint32(position);
      const type = String.fromCharCode(...octets.subarray(position + 4, position + 8));
      let entete = 8;
      if (taille === 1) { taille = Number(vue.getBigUint64(position + 8)); entete = 16; }
      else if (taille === 0) taille = fin - position;
      if (taille < entete || position + taille > fin) { erreurs.push(`boîte « ${type} » à ${position} : taille ${taille} hors du fichier`); break; }
      sortie.push({ type, taille, decalage: position, entete });
      position += taille;
    }
    return position;
  };
  const fin = lireBoites(0, octets.byteLength, boites);
  const tailleCoherente = fin === octets.byteLength && erreurs.length === 0;
  const types = boites.map((b) => b.type);
  if (types[0] !== 'ftyp') erreurs.push('la première boîte n’est pas « ftyp »');
  if (!types.includes('moov')) erreurs.push('boîte « moov » absente');
  if (!types.includes('mdat')) erreurs.push('boîte « mdat » absente');
  const moov = boites.find((b) => b.type === 'moov');
  let pistes = 0;
  let echelleTemps = null;
  let duree = null;
  if (moov !== undefined) {
    const enfants = [];
    lireBoites(moov.decalage + moov.entete, moov.decalage + moov.taille, enfants);
    pistes = enfants.filter((b) => b.type === 'trak').length;
    const mvhd = enfants.find((b) => b.type === 'mvhd');
    if (mvhd !== undefined) {
      const d = mvhd.decalage + mvhd.entete;
      const version = octets[d];
      echelleTemps = vue.getUint32(d + (version === 1 ? 20 : 12));
      duree = version === 1 ? Number(vue.getBigUint64(d + 24)) : vue.getUint32(d + 16);
    }
  }
  return {
    boites: boites.map(({ type, taille, decalage }) => ({ type, taille, decalage })),
    moovAvantMdat: types.indexOf('moov') !== -1 && types.indexOf('moov') < types.indexOf('mdat'),
    pistes, echelleTemps, duree, tailleCoherente, erreurs,
  };
}

const ID = Object.freeze({ EBML: 0x1a45dfa3, SEGMENT: 0x18538067, INFO: 0x1549a966, TRACKS: 0x1654ae6b, CLUSTER: 0x1f43b675, CUES: 0x1c53bb6b, SEEKHEAD: 0x114d9b74 });

// Identifiant EBML : l'octet de tête indique la longueur (1 à 4), marqueur inclus dans la valeur.
function lireId(octets, position) {
  const premier = octets[position];
  let longueur = 1;
  while (longueur <= 4 && (premier & (0x80 >> (longueur - 1))) === 0) longueur += 1;
  if (longueur > 4 || position + longueur > octets.length) return null;
  let valeur = 0;
  for (let i = 0; i < longueur; i += 1) valeur = valeur * 256 + octets[position + i];
  return { valeur, longueur };
}

// Taille EBML : longueur 1 à 8, marqueur retiré ; toutes les valeurs à 1 = taille inconnue (null).
function lireTaille(octets, position) {
  const premier = octets[position];
  let longueur = 1;
  while (longueur <= 8 && (premier & (0x80 >> (longueur - 1))) === 0) longueur += 1;
  if (longueur > 8 || position + longueur > octets.length) return null;
  let valeur = premier & (0xff >> longueur);
  let toutAUn = valeur === (0xff >> longueur);
  for (let i = 1; i < longueur; i += 1) {
    valeur = valeur * 256 + octets[position + i];
    if (octets[position + i] !== 0xff) toutAUn = false;
  }
  return { valeur: toutAUn ? null : valeur, longueur };
}

/**
 * Éléments de premier niveau d'un WebM : en-tête EBML, segment, puis dans le segment les éléments utiles.
 * @param {Uint8Array} octets
 * @returns {{ enteteEbml: boolean, segment: boolean, info: boolean, pistes: boolean, clusters: number, cues: boolean, seekHead: boolean, tailleCoherente: boolean, erreurs: string[] }}
 */
export function analyserWebm(octets) {
  const erreurs = [];
  const resultat = { enteteEbml: false, segment: false, info: false, pistes: false, clusters: 0, cues: false, seekHead: false, tailleCoherente: false, erreurs };
  let position = 0;
  const lireElement = (limite) => {
    const id = lireId(octets, position);
    if (id === null) return null;
    const taille = lireTaille(octets, position + id.longueur);
    if (taille === null) return null;
    const debutDonnees = position + id.longueur + taille.longueur;
    const fin = taille.valeur === null ? limite : debutDonnees + taille.valeur;
    if (fin > limite) { erreurs.push(`élément 0x${id.valeur.toString(16)} à ${position} dépasse son conteneur`); return null; }
    return { id: id.valeur, debutDonnees, fin };
  };
  const entete = lireElement(octets.length);
  if (entete === null || entete.id !== ID.EBML) { erreurs.push('en-tête EBML absent'); return resultat; }
  resultat.enteteEbml = true;
  position = entete.fin;
  const segment = lireElement(octets.length);
  if (segment === null || segment.id !== ID.SEGMENT) { erreurs.push('segment absent'); return resultat; }
  resultat.segment = true;
  position = segment.debutDonnees;
  while (position < segment.fin) {
    const element = lireElement(segment.fin);
    if (element === null) break;
    if (element.id === ID.INFO) resultat.info = true;
    else if (element.id === ID.TRACKS) resultat.pistes = true;
    else if (element.id === ID.CLUSTER) resultat.clusters += 1;
    else if (element.id === ID.CUES) resultat.cues = true;
    else if (element.id === ID.SEEKHEAD) resultat.seekHead = true;
    position = element.fin;
  }
  resultat.tailleCoherente = position === segment.fin && segment.fin === octets.length && erreurs.length === 0;
  if (!resultat.tailleCoherente && erreurs.length === 0) erreurs.push(`éléments du segment lus jusqu'à ${position} sur ${segment.fin}`);
  if (!resultat.info) erreurs.push('élément Info absent');
  if (!resultat.pistes) erreurs.push('élément Tracks absent');
  if (resultat.clusters === 0) erreurs.push('aucun Cluster');
  return resultat;
}
