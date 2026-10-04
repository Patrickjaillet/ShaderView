// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Son : passe « sound » (rendu hors-ligne des échantillons via WebGL, lecture par
// Web Audio) et entrées `music`/`musicstream` (lecture d'un fichier local, analyse
// FFT alimentant une texture visualiseur). Le rendu de la passe « sound » réutilise
// le wrapper GLSL et la compilation de renderer.js (option `son`, voir ce module) :
// chaque pixel d'un bloc rendu dans une texture flottante porte un échantillon
// stéréo, lu par blocs successifs (`iBlockOffset`) jusqu'à la durée voulue, puis
// assemblé en un unique `AudioBuffer` pour une lecture Web Audio classique.
//
// Comme les autres modules, la part purement logique (dimensionnement des blocs,
// FFT, fenêtrage, assemblage des échantillons en texture visualiseur) est
// indépendante du DOM/WebGL/Web Audio et testable sans navigateur ; seules les
// sections « Rendu WebGL de la passe son » et « Lecture Web Audio » y font appel.

import { compilerPasse } from './renderer.js';

// ---------------------------------------------------------------------------
// Dimensionnement des blocs de rendu
// ---------------------------------------------------------------------------

/** Côté (carré) d'un bloc de rendu de la passe son, en pixels : 512 × 512 échantillons par bloc. */
export const TAILLE_BLOC_SON = 512;

/** Échantillons rendus par bloc (un pixel = un échantillon stéréo). */
export const ECHANTILLONS_PAR_BLOC = TAILLE_BLOC_SON * TAILLE_BLOC_SON;

/** Durée par défaut d'un shader son sans durée déclarée dans le JSON (Shadertoy n'expose pas ce champ). */
export const DUREE_PAR_DEFAUT_SECONDES = 60;

/**
 * Calcule le nombre de blocs nécessaires pour couvrir une durée donnée à une
 * fréquence d'échantillonnage donnée (arrondi au bloc supérieur : le dernier bloc
 * peut dépasser légèrement la durée demandée, les échantillons excédentaires sont
 * tronqués par l'appelant).
 * @param {number} dureeSecondes
 * @param {number} frequenceEchantillonnage
 * @returns {number}
 */
export function calculerNombreBlocs(dureeSecondes, frequenceEchantillonnage) {
  const total = Math.max(0, dureeSecondes) * frequenceEchantillonnage;
  return Math.ceil(total / ECHANTILLONS_PAR_BLOC);
}

/**
 * Calcule le nombre total d'échantillons (stéréo) à produire pour une durée donnée,
 * arrondi à l'entier le plus proche (dernier échantillon partiel inclus).
 * @param {number} dureeSecondes
 * @param {number} frequenceEchantillonnage
 * @returns {number}
 */
export function calculerNombreEchantillons(dureeSecondes, frequenceEchantillonnage) {
  return Math.round(Math.max(0, dureeSecondes) * frequenceEchantillonnage);
}

// ---------------------------------------------------------------------------
// Assemblage des échantillons (lecture des blocs rendus vers un AudioBuffer)
// ---------------------------------------------------------------------------

/**
 * Copie les échantillons utiles d'un bloc rendu (RGBA32F : R=gauche, G=droite, lu
 * ligne par ligne comme le calcule le wrapper GLSL, voir renderer.js
 * construireFragmentShader option `son`) dans les canaux de sortie, en s'arrêtant au
 * nombre total d'échantillons demandé (le dernier bloc est généralement incomplet).
 * @param {Float32Array} pixelsBloc RGBA du bloc, `TAILLE_BLOC_SON * TAILLE_BLOC_SON * 4` valeurs
 * @param {Float32Array} gauche canal gauche de sortie (longueur ≥ nombreEchantillons)
 * @param {Float32Array} droite canal droit de sortie (même longueur)
 * @param {number} decalageBloc index du premier échantillon de ce bloc dans la sortie
 * @param {number} nombreEchantillons nombre total d'échantillons voulus (toutes sorties confondues)
 */
export function copierBlocVersEchantillons(pixelsBloc, gauche, droite, decalageBloc, nombreEchantillons) {
  const disponibles = Math.min(ECHANTILLONS_PAR_BLOC, nombreEchantillons - decalageBloc);
  for (let i = 0; i < disponibles; i += 1) {
    gauche[decalageBloc + i] = clamp(pixelsBloc[i * 4], -1, 1);
    droite[decalageBloc + i] = clamp(pixelsBloc[i * 4 + 1], -1, 1);
  }
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * Calcule la fenêtre d'échantillons à lire dans un tampon audio pour en extraire les
 * `longueurFenetre` derniers échantillons jusqu'à une position de lecture donnée
 * (utilisé par `LecteurAudio.copierTrameRecente` pour alimenter le visualiseur FFT ;
 * extrait en fonction pure pour rester testable sans `AudioBuffer`). Près du début du
 * tampon, la fenêtre dépasserait avant l'échantillon 0 : `decalageSortie` indique alors
 * à partir de quel indice de la sortie copier (les indices précédents restent du silence).
 * @param {number} positionSecondes position de lecture courante
 * @param {number} frequenceEchantillonnage
 * @param {number} longueurTotale nombre d'échantillons du tampon
 * @param {number} longueurFenetre nombre d'échantillons voulus (taille de la sortie)
 * @returns {{ indexDebut: number, decalageSortie: number, longueur: number }} `longueur` échantillons à copier depuis `indexDebut` du tampon vers `sortie[decalageSortie..]`
 */
export function calculerFenetreTrame(positionSecondes, frequenceEchantillonnage, longueurTotale, longueurFenetre) {
  const indexFin = clamp(Math.round(positionSecondes * frequenceEchantillonnage), 0, longueurTotale);
  const indexDebutBrut = indexFin - longueurFenetre;
  const indexDebut = Math.max(0, indexDebutBrut);
  const decalageSortie = Math.max(0, -indexDebutBrut);
  return { indexDebut, decalageSortie, longueur: indexFin - indexDebut };
}

// ---------------------------------------------------------------------------
// FFT (visualiseur `music` / `musicstream`, texture 512 × 2)
// ---------------------------------------------------------------------------

/** Nombre d'échantillons analysés par trame FFT, et largeur de la texture visualiseur. */
export const TAILLE_FFT = 512;

/**
 * Transformée de Fourier rapide (radix-2, itérative, en place) d'un signal réel
 * fenêtré. `TAILLE_FFT` doit être une puissance de deux (512 ici, fixe).
 * @param {Float32Array} partieReelle longueur TAILLE_FFT, modifiée en place
 * @param {Float32Array} partieImaginaire longueur TAILLE_FFT, modifiée en place (initialement nulle)
 */
export function fft(partieReelle, partieImaginaire) {
  const n = partieReelle.length;
  // Permutation en ordre de bits inversés (prérequis de l'algorithme itératif).
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [partieReelle[i], partieReelle[j]] = [partieReelle[j], partieReelle[i]];
      [partieImaginaire[i], partieImaginaire[j]] = [partieImaginaire[j], partieImaginaire[i]];
    }
  }
  for (let taille = 2; taille <= n; taille *= 2) {
    const angle = (-2 * Math.PI) / taille;
    const wReel = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let debut = 0; debut < n; debut += taille) {
      let wkReel = 1;
      let wkImag = 0;
      for (let k = 0; k < taille / 2; k += 1) {
        const iPair = debut + k;
        const iImpair = debut + k + taille / 2;
        const tReel = partieReelle[iImpair] * wkReel - partieImaginaire[iImpair] * wkImag;
        const tImag = partieReelle[iImpair] * wkImag + partieImaginaire[iImpair] * wkReel;
        partieReelle[iImpair] = partieReelle[iPair] - tReel;
        partieImaginaire[iImpair] = partieImaginaire[iPair] - tImag;
        partieReelle[iPair] += tReel;
        partieImaginaire[iPair] += tImag;
        const wkReelSuivant = wkReel * wReel - wkImag * wImag;
        wkImag = wkReel * wImag + wkImag * wReel;
        wkReel = wkReelSuivant;
      }
    }
  }
}

/**
 * Applique une fenêtre de Hann à un signal (atténue les bords d'une trame pour
 * réduire les discontinuités périodiques avant la FFT, pratique courante d'analyse
 * spectrale : sans elle, le spectre serait parasité par la troncature de la trame).
 * @param {Float32Array} signal modifié en place
 */
export function appliquerFenetreHann(signal) {
  const n = signal.length;
  for (let i = 0; i < n; i += 1) {
    signal[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
}

/**
 * Calcule le spectre (magnitude) d'une trame de `TAILLE_FFT` échantillons, fenêtrée
 * puis transformée. Seule la première moitié du spectre est renvoyée (l'autre est le
 * symétrique conjugué pour un signal réel, sans information supplémentaire).
 * @param {Float32Array} trame longueur TAILLE_FFT (copiée, non modifiée)
 * @returns {Float32Array} longueur TAILLE_FFT / 2, magnitude normalisée à [0, 1]
 */
export function calculerSpectre(trame) {
  const reel = Float32Array.from(trame);
  appliquerFenetreHann(reel);
  const imag = new Float32Array(reel.length);
  fft(reel, imag);
  const spectre = new Float32Array(reel.length / 2);
  const normalisation = 2 / reel.length;
  for (let i = 0; i < spectre.length; i += 1) {
    spectre[i] = Math.min(1, Math.hypot(reel[i], imag[i]) * normalisation);
  }
  return spectre;
}

/**
 * Construit la texture visualiseur Shadertoy pour une entrée `music`/`musicstream` :
 * 512 × 2, ligne 0 (bas, `v` proche de 0 dans `texture(iChannelN, vec2(x, 0.))`) le
 * spectre, ligne 1 la forme d'onde brute, chaque valeur sur [0, 1] (0,5 = silence
 * pour la forme d'onde, convention Shadertoy où l'onde est recentrée autour de 0,5).
 * @param {Float32Array} trame longueur TAILLE_FFT, échantillons mono les plus récents
 * @returns {Uint8Array} RGBA, `TAILLE_FFT * 2 * 4` octets (R=G=B=valeur, A=255)
 */
export function construireTextureVisualiseur(trame) {
  const spectre = calculerSpectre(trame);
  const octets = new Uint8Array(TAILLE_FFT * 2 * 4);
  for (let x = 0; x < TAILLE_FFT; x += 1) {
    const valeurSpectre = Math.round((x < spectre.length ? spectre[x] : 0) * 255);
    const indexSpectre = x * 4;
    octets[indexSpectre] = valeurSpectre; octets[indexSpectre + 1] = valeurSpectre;
    octets[indexSpectre + 2] = valeurSpectre; octets[indexSpectre + 3] = 255;

    const valeurOnde = Math.round(clamp(trame[x] * 0.5 + 0.5, 0, 1) * 255);
    const indexOnde = (TAILLE_FFT + x) * 4;
    octets[indexOnde] = valeurOnde; octets[indexOnde + 1] = valeurOnde;
    octets[indexOnde + 2] = valeurOnde; octets[indexOnde + 3] = 255;
  }
  return octets;
}

// ---------------------------------------------------------------------------
// Rendu WebGL de la passe son
// ---------------------------------------------------------------------------

/**
 * Rend hors-ligne la totalité d'une passe « sound » en un `AudioBuffer` stéréo prêt
 * pour Web Audio, en appelant `surProgres` après chaque bloc (pour une barre de
 * progression, Phase 9 notamment). Le rendu est déterministe (une horloge virtuelle
 * `iBlockOffset` croissante, indépendante du temps réel) : deux appels successifs
 * sur le même shader produisent un `AudioBuffer` identique, propriété requise par
 * l'export (Phase 9) pour un son exactement synchronisé à la vidéo exportée.
 *
 * Si `surProgres` renvoie une promesse, elle est attendue avant le bloc suivant :
 * l'export (Phase 9) peut passer un callback synchrone pour un rendu aussi rapide
 * que possible, tandis que l'interface interactive (js/app.js) passe un callback qui
 * rend la main au navigateur entre deux blocs, pour ne pas geler l'affichage pendant
 * potentiellement plusieurs centaines de millisecondes (plusieurs blocs de 262 144
 * échantillons, chacun forçant une synchronisation GPU via `readPixels`).
 * @param {WebGL2RenderingContext} gl
 * @param {AudioContext} contexteAudio utilisé uniquement pour créer l'AudioBuffer (`createBuffer`)
 * @param {string} code code utilisateur de la passe « sound », déjà converti (convertirGles1VersGles3)
 * @param {string|null} commun code « common », déjà converti, ou null
 * @param {{ dureeSecondes?: number, frequenceEchantillonnage?: number, surProgres?: (fait: number, total: number) => void|Promise<void> }} [options]
 * @returns {Promise<AudioBuffer>}
 * @throws {ErreurCompilation}
 */
export async function rendreSonHorsLigne(gl, contexteAudio, code, commun, {
  dureeSecondes = DUREE_PAR_DEFAUT_SECONDES,
  frequenceEchantillonnage = 44100,
  surProgres,
} = {}) {
  const compilation = compilerPasse(gl, code, commun, { son: true });
  const nombreEchantillons = calculerNombreEchantillons(dureeSecondes, frequenceEchantillonnage);
  const nombreBlocs = calculerNombreBlocs(dureeSecondes, frequenceEchantillonnage);

  const gauche = new Float32Array(nombreEchantillons);
  const droite = new Float32Array(nombreEchantillons);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TAILLE_BLOC_SON, TAILLE_BLOC_SON, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const tamponCadre = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, tamponCadre);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  try {
    const pixels = new Float32Array(ECHANTILLONS_PAR_BLOC * 4);
    gl.viewport(0, 0, TAILLE_BLOC_SON, TAILLE_BLOC_SON);
    gl.useProgram(compilation.programme);
    if (compilation.emplacements.iResolution !== null) gl.uniform3fv(compilation.emplacements.iResolution, [TAILLE_BLOC_SON, TAILLE_BLOC_SON, 1]);
    if (compilation.emplacements.iSampleRate !== null) gl.uniform1f(compilation.emplacements.iSampleRate, frequenceEchantillonnage);
    for (let bloc = 0; bloc < nombreBlocs; bloc += 1) {
      const decalageBloc = bloc * ECHANTILLONS_PAR_BLOC;
      if (compilation.emplacements.iBlockOffset !== null) gl.uniform1i(compilation.emplacements.iBlockOffset, decalageBloc);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, TAILLE_BLOC_SON, TAILLE_BLOC_SON, gl.RGBA, gl.FLOAT, pixels);
      copierBlocVersEchantillons(pixels, gauche, droite, decalageBloc, nombreEchantillons);
      if (surProgres) await surProgres(bloc + 1, nombreBlocs);
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tamponCadre);
    gl.deleteTexture(texture);
    gl.deleteProgram(compilation.programme);
  }

  const tampon = contexteAudio.createBuffer(2, nombreEchantillons, frequenceEchantillonnage);
  tampon.copyToChannel(gauche, 0);
  tampon.copyToChannel(droite, 1);
  return tampon;
}

// ---------------------------------------------------------------------------
// Lecture Web Audio (passe « sound » déjà rendue, ou fichier music/musicstream)
// ---------------------------------------------------------------------------

/**
 * Lecteur Web Audio d'un `AudioBuffer` déjà prêt (rendu de la passe son, ou fichier
 * décodé pour `music`/`musicstream`), avec les contrôles standard et le respect de
 * la politique d'autoplay des navigateurs : `lire()` doit être appelée depuis un
 * gestionnaire d'événement utilisateur (clic, touche) la toute première fois, sinon
 * le navigateur refuse silencieusement de démarrer l'audio (`AudioContext` suspendu).
 */
export class LecteurAudio {
  /**
   * @param {AudioContext} contexte
   * @param {AudioBuffer} tampon
   */
  constructor(contexte, tampon) {
    this._contexte = contexte;
    this._tampon = tampon;
    this._gain = contexte.createGain();
    this._gain.connect(contexte.destination);
    this._volume = 1;
    this._muet = false;
    this._source = null;
    this._positionDepart = 0; // position de lecture (secondes) au dernier démarrage/reprise
    this._horodatageDepart = 0; // contexte.currentTime au dernier démarrage/reprise
    this._enMarche = false;
  }

  /** Durée totale du tampon, en secondes. */
  get duree() { return this._tampon.duration; }

  /** Vrai si la lecture est en cours. */
  get enMarche() { return this._enMarche; }

  /** Position de lecture courante, en secondes (stable à l'arrêt, calculée en marche). */
  get position() {
    if (!this._enMarche) return this._positionDepart;
    const ecoulee = this._contexte.currentTime - this._horodatageDepart;
    return Math.min(this._tampon.duration, this._positionDepart + ecoulee);
  }

  /**
   * Copie dans `sortie` les `sortie.length` derniers échantillons (canal gauche)
   * jusqu'à la position de lecture courante (utilisé pour alimenter le visualiseur
   * music/musicstream, voir calculerSpectre/construireTextureVisualiseur dans
   * js/app.js). Les positions avant le début du tampon sont remplies de silence.
   * @param {Float32Array} sortie modifiée en place
   */
  copierTrameRecente(sortie) {
    const { indexDebut, decalageSortie, longueur } = calculerFenetreTrame(this.position, this._tampon.sampleRate, this._tampon.length, sortie.length);
    // Début de lecture : les positions avant le début du tampon n'existent pas, silence.
    if (decalageSortie > 0) sortie.fill(0, 0, decalageSortie);
    if (longueur > 0) this._tampon.copyFromChannel(sortie.subarray(decalageSortie, decalageSortie + longueur), 0, indexDebut);
  }

  /**
   * Démarre ou reprend la lecture à la position courante. Doit être appelée depuis
   * un geste utilisateur lors du tout premier appel (politique d'autoplay) : reprend
   * d'abord le contexte s'il est suspendu.
   * @returns {Promise<void>}
   */
  async lire() {
    if (this._enMarche) return;
    if (this._contexte.state === 'suspended') await this._contexte.resume();
    this._source = this._contexte.createBufferSource();
    this._source.buffer = this._tampon;
    this._source.connect(this._gain);
    this._source.start(0, this._positionDepart);
    this._horodatageDepart = this._contexte.currentTime;
    this._enMarche = true;
    this._source.addEventListener('ended', () => {
      if (this._enMarche) { this._enMarche = false; this._positionDepart = this._tampon.duration; }
    });
  }

  /** Met en pause à la position courante ; sans effet si déjà à l'arrêt. */
  pause() {
    if (!this._enMarche) return;
    this._positionDepart = this.position;
    this._source.stop();
    this._source = null;
    this._enMarche = false;
  }

  /**
   * Déplace la position de lecture ; reprend la lecture à la nouvelle position si
   * elle était en cours.
   * @param {number} secondes
   */
  sauterA(secondes) {
    const enMarcheAvant = this._enMarche;
    if (enMarcheAvant) this.pause();
    this._positionDepart = clamp(secondes, 0, this._tampon.duration);
    if (enMarcheAvant) this.lire();
  }

  /** Volume linéaire (0 à 1), indépendant de l'état muet. */
  get volume() { return this._volume; }

  set volume(v) {
    this._volume = clamp(v, 0, 1);
    this._gain.gain.value = this._muet ? 0 : this._volume;
  }

  /** Vrai si le son est coupé (le volume réglé est conservé pour le réactiver). */
  get muet() { return this._muet; }

  set muet(m) {
    this._muet = Boolean(m);
    this._gain.gain.value = this._muet ? 0 : this._volume;
  }

  /** Arrête la lecture et libère le nœud de gain. */
  detruire() {
    if (this._enMarche) this.pause();
    this._gain.disconnect();
  }
}
