// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Worker de rendu des miniatures : un moteur WebGL2 sur un OffscreenCanvas de 160 × 90, hors du fil principal, pour que la
// compilation et le rendu d'un shader lourd ne figent pas l'interface. Il reçoit un shader déjà normalisé et converti (voir
// thumbnails.js) et renvoie l'image PNG en ArrayBuffer. Les échecs sont renvoyés sous forme de données simples (nom,
// message, lignes d'erreur) : le fil principal reconstruit l'erreur d'origine. Aucune requête réseau.

import { MoteurRendu } from './renderer.js';

const LARGEUR = 160;
const HAUTEUR = 90;
let moteur = null;

function decrire(erreur) {
  return {
    nom: erreur?.name ?? 'Error',
    message: erreur instanceof Error ? erreur.message : String(erreur),
    erreursLigne: erreur?.erreursLigne ?? null,
    idPasse: erreur?.idPasse ?? null,
  };
}

self.addEventListener('message', async ({ data }) => {
  const { id, normalise, temps } = data;
  try {
    moteur ??= new MoteurRendu(new OffscreenCanvas(LARGEUR, HAUTEUR));
    moteur.compiler(normalise);
    moteur.reinitialiserTampons();
    moteur.horloge.remettreAZero();
    moteur.horloge.sauterA(temps);
    moteur.rendre();
    // La capture se déclenche dans la même tâche que le dessin : le tampon de dessin est encore valide.
    const blob = await moteur.canevas.convertToBlob({ type: 'image/png' });
    const octets = await blob.arrayBuffer();
    self.postMessage({ id, ok: true, octets }, [octets]);
  } catch (erreur) {
    self.postMessage({ id, ok: false, erreur: decrire(erreur) });
  }
});
