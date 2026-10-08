// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Moteur de rendu WebGL2 : contexte, wrapper GLSL ES 3.00 autour du code utilisateur
// Shadertoy (`mainImage`), uniforms standard, compilation avec correspondance des
// erreurs sur les numéros de ligne du code d'origine, horloge maîtrisée, souris
// Shadertoy, perte/restauration de contexte, détection des extensions utiles, et
// exécution complète du graphe multipasse (buffers A à D en ping-pong, cubemaps à
// six faces, entrée clavier) d'un shader normalisé par parser.js.
//
// L'échantillonnage par défaut (voir ECHANTILLONNAGE_PAR_DEFAUT) est partagé avec
// parser.js : une entrée sans sampler explicite et une cible de rendu interne
// (buffer, cubemap) suivent la même convention Shadertoy (filtre linéaire, bord).
//
// La passe son (Phase 6) et la résolution des médias externes — textures, volumes,
// vidéo (Phase 5) — restent hors de ce module : les canaux qui en dépendent sont
// liés à une texture de repli (voir texturePlaceholder) jusqu'à leur écriture.
//
// Comme parser.js et shader-meta.js, la partie purement logique de ce module
// (construction du GLSL, conversion GLES 1.00 → 3.00, correspondance des lignes,
// horloge, état de la souris, texture clavier) est indépendante du DOM et testable
// sans contexte WebGL ; seules les sections « Contexte WebGL2 », « Textures et
// cibles de rendu » et « Moteur de rendu multipasse » appellent l'API WebGL elle-même.

import { ECHANTILLONNAGE_PAR_DEFAUT, LETTRES_BUFFERS } from './parser.js';

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/** Erreur de compilation ou de liaison d'un programme, avec erreurs mappées sur le code utilisateur. */
export class ErreurCompilation extends Error {
  /**
   * @param {string} message
   * @param {ErreurLigne[]} erreursLigne
   * @param {string|null} [idPasse] identifiant de la passe fautive (ex. « buffer-A », « image » —
   *        voir inspector.js, construireOnglets, dont les identifiants sont les mêmes), si connu
   */
  constructor(message, erreursLigne = [], idPasse = null) {
    super(message);
    this.name = 'ErreurCompilation';
    this.erreursLigne = erreursLigne;
    this.idPasse = idPasse;
  }
}

/** WebGL2 indisponible dans ce navigateur (ou contexte perdu sans restauration possible). */
export class ErreurContexte extends Error {
  constructor(message) {
    super(message);
    this.name = 'ErreurContexte';
  }
}

// ---------------------------------------------------------------------------
// Wrapper GLSL ES 3.00 : en-tête Shadertoy et point d'entrée
// ---------------------------------------------------------------------------

// Types de canal dont l'entrée Shadertoy n'est pas une texture 2D (`sampler2D`) :
// un cubemap se lit par `samplerCube`, un volume par `sampler3D`.
const ECHANTILLONNEUR_PAR_TYPE_CANAL = Object.freeze({ cubemap: 'samplerCube', volume: 'sampler3D' });

/**
 * Déclare les uniforms standard Shadertoy, avec le type d'échantillonneur de chaque
 * canal (`sampler2D` par défaut, `samplerCube` pour une entrée de type « cubemap »,
 * `sampler3D` pour une entrée de type « volume »).
 * @param {('texture'|'cubemap'|'volume'|'buffer'|'keyboard'|'mic'|'music'|'musicstream'|'webcam'|'video'|'misc')[]} typesCanaux
 *        type de canal pour iChannel0 à 3 (longueur 4, valeur quelconque pour un canal inutilisé)
 * @returns {string}
 */
export function construireDeclarationUniforms(typesCanaux = ['texture', 'texture', 'texture', 'texture']) {
  const lignesCanaux = typesCanaux
    .map((type, n) => `uniform ${ECHANTILLONNEUR_PAR_TYPE_CANAL[type] ?? 'sampler2D'} iChannel${n};`)
    .join('\n');
  return [
    'uniform vec3 iResolution;',
    'uniform float iTime;',
    'uniform float iTimeDelta;',
    'uniform int iFrame;',
    'uniform float iFrameRate;',
    'uniform vec4 iMouse;',
    'uniform vec4 iDate;',
    'uniform float iSampleRate;',
    'uniform float iChannelTime[4];',
    'uniform vec3 iChannelResolution[4];',
    lignesCanaux,
  ].join('\n');
}

/** Uniforms standard Shadertoy (canaux `sampler2D` par défaut), déclarés avant le code utilisateur. */
export const DECLARATION_UNIFORMS = Object.freeze(construireDeclarationUniforms());

const SOMMETS_QUAD = Object.freeze(`#version 300 es
// Quad plein écran : deux triangles couvrant le repère de clip (-1..1), sans tampon
// de sommets (gl_VertexID), utilisé pour toute passe (image, buffer ou cubemap).
const vec2 SOMMETS[6] = vec2[6](
  vec2(-1., -1.), vec2(1., -1.), vec2(-1., 1.),
  vec2(-1., 1.), vec2(1., -1.), vec2(1., 1.)
);
void main() {
  gl_Position = vec4(SOMMETS[gl_VertexID], 0., 1.);
}
`);

// Les six faces d'un cubemap WebGL, dans l'ordre de TEXTURE_CUBE_MAP_POSITIVE_X et
// suivants, avec le repère (avant, haut) Shadertoy de chaque face (convention
// main-droite, Y vers le haut) utilisé pour calculer le rayon transmis à `mainCubemap`.
export const FACES_CUBEMAP = Object.freeze([
  { avant: [1, 0, 0], haut: [0, -1, 0] },
  { avant: [-1, 0, 0], haut: [0, -1, 0] },
  { avant: [0, 1, 0], haut: [0, 0, 1] },
  { avant: [0, -1, 0], haut: [0, 0, -1] },
  { avant: [0, 0, 1], haut: [0, -1, 0] },
  { avant: [0, 0, -1], haut: [0, -1, 0] },
]);

/**
 * Construit le fragment shader GLSL ES 3.00 complet d'une passe : en-tête Shadertoy
 * (version, précision, uniforms) suivi du code « common » éventuel, du code
 * utilisateur de la passe, puis d'un `main()` appelant le point d'entrée Shadertoy
 * de la passe — `mainImage(fragColor, fragCoord)` pour une passe « image » ou
 * « buffer », `mainCubemap(fragColor, fragCoord, rayOri, rayDir)` pour une passe
 * « cubemap » (le rayon est calculé dans `main()` à partir d'uniforms propres à la
 * face courante, voir matriceRepereFace, et n'est jamais recalculé par le code
 * utilisateur), ou `mainSound(samp, time)` pour une passe « son » (Phase 6, voir
 * audio.js) — chaque pixel du bloc rendu correspond à un échantillon stéréo, son
 * index absolu étant `iBlockOffset + numéro de pixel` (balayage ligne par ligne).
 * Le nombre de lignes insérées avant le code utilisateur est renvoyé pour permettre
 * la correspondance des numéros de ligne des erreurs de compilation (voir mapperErreurs).
 * @param {string} code code utilisateur de la passe (après conversion GLES 1.00 → 3.00)
 * @param {string|null} commun code de la passe « common », déjà converti, ou null
 * @param {{ cubemap?: boolean, son?: boolean, typesCanaux?: string[] }} [options]
 * @returns {{ source: string, decalageLignes: number }}
 */
export function construireFragmentShader(code, commun, { cubemap = false, son = false, typesCanaux } = {}) {
  const entete = [
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    'precision highp sampler2D;',
    'precision highp samplerCube;',
    'precision highp sampler3D;',
    // Macro définie par Shadertoy : 1 sur un matériel de bureau, 0 sur un appareil peu puissant. ShaderView la fixe à 1.
    '#define HW_PERFORMANCE 1',
    'out vec4 shaderview_sortieFragment;',
    typesCanaux !== undefined ? construireDeclarationUniforms(typesCanaux) : DECLARATION_UNIFORMS,
    cubemap ? 'uniform vec3 shaderview_rayOrigine;\nuniform mat3 shaderview_repereFace;' : '',
    son ? 'uniform int iBlockOffset;' : '',
    '',
  ].join('\n');
  const decalageLignes = entete.split('\n').length + (commun !== null ? commun.split('\n').length : 0);
  let main;
  if (cubemap) {
    main = [
      'void main() {',
      '  vec2 shaderview_uv = (gl_FragCoord.xy / iResolution.xy) * 2. - 1.;',
      '  vec3 shaderview_rayon = normalize(shaderview_repereFace * vec3(shaderview_uv, -1.));',
      '  mainCubemap(shaderview_sortieFragment, gl_FragCoord.xy, shaderview_rayOrigine, shaderview_rayon);',
      '}',
    ];
  } else if (son) {
    main = [
      'void main() {',
      '  int shaderview_x = int(gl_FragCoord.x);',
      '  int shaderview_y = int(gl_FragCoord.y);',
      '  int shaderview_echantillon = iBlockOffset + shaderview_y * int(iResolution.x) + shaderview_x;',
      '  float shaderview_temps = float(shaderview_echantillon) / iSampleRate;',
      '  shaderview_sortieFragment = vec4(mainSound(shaderview_echantillon, shaderview_temps), 0., 1.);',
      '}',
    ];
  } else {
    main = [
      'void main() {',
      '  mainImage(shaderview_sortieFragment, gl_FragCoord.xy);',
      '}',
    ];
  }
  const corps = [
    entete,
    ...(commun !== null ? [commun] : []),
    code,
    '',
    ...main,
    '',
  ].join('\n');
  return { source: corps, decalageLignes };
}

// ---------------------------------------------------------------------------
// Compatibilité GLSL ES 1.00 → 3.00
// ---------------------------------------------------------------------------

// Remplacements lexicaux sûrs : chaque motif cible un appel de fonction complet
// (nom suivi de « ( ») pour ne jamais altérer un identifiant qui ne serait qu'un
// préfixe (ex. « texture2DFoo »), ni une chaîne ou un commentaire — le code
// Shadertoy n'imbrique pas ces noms dans des littéraux de chaîne (GLSL n'en a pas).
const REMPLACEMENTS_GLES1 = Object.freeze([
  [/\btexture2DLodEXT\s*\(/g, 'textureLod('],
  [/\btexture2DProjLodEXT\s*\(/g, 'textureProjLod('],
  [/\btextureCubeLodEXT\s*\(/g, 'textureLod('],
  [/\btexture2DLod\s*\(/g, 'textureLod('],
  [/\btexture2DProj\s*\(/g, 'textureProj('],
  [/\btextureCubeLod\s*\(/g, 'textureLod('],
  [/\btexture2D\s*\(/g, 'texture('],
  [/\btextureCube\s*\(/g, 'texture('],
  [/\bshadow2D\s*\(/g, 'texture('],
  [/\bshadow2DProj\s*\(/g, 'textureProj('],
]);

// Qualificatifs de variables (hors fonctions) propres au GLSL ES 1.00 : un fragment
// shader n'y déclare jamais « attribute » et le mot-clé « varying » est devenu « in ».
const REMPLACEMENTS_QUALIFICATEURS = Object.freeze([
  [/\bvarying\b/g, 'in'],
]);

// Déclarations `uniform` des uniforms standard par le code utilisateur (shaders exportés d'autres moteurs) :
// l'en-tête les déclare déjà, une seconde déclaration serait une erreur de redéfinition. Retirées (la ligne
// reste vide, pour que les numéros de ligne restent exacts).
const DECLARATION_UNIFORM_STANDARD = /^[ \t]*uniform[ \t]+(?:(?:highp|mediump|lowp)[ \t]+)?\w+[ \t]+(iResolution|iTime|iTimeDelta|iFrame|iFrameRate|iMouse|iDate|iSampleRate|iChannelTime|iChannelResolution|iChannel[0-3])(?:[ \t]*\[[^\]]*\])?[ \t]*;[ \t]*/gm;

// Nom lisible de l'ancien identifiant visé par un motif de remplacement (« texture2D »
// pour /\btexture2D\s*\(/ ; « varying » pour /\bvarying\b/), pour le rapport de compatibilité.
function nomRemplace(motif) {
  return motif.source.replace(/^\\b/, '').replace(/\\s\*\\\($/, '').replace(/\\b$/, '');
}

function retirerCommentaires(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/**
 * Convertit un code GLSL ES 1.00 historique (shaders Shadertoy anciens) vers une
 * forme compatible GLSL ES 3.00 : fonctions de texturage renommées (`texture2D` →
 * `texture`, etc.) et qualificatif `varying` → `in`. Le code est inspecté pour
 * décider si la conversion des qualificatifs est nécessaire (un fragment shader
 * Shadertoy n'a normalement pas de `varying`, donc ce remplacement est sans effet
 * sur l'immense majorité des shaders et n'est appliqué que si le motif apparaît).
 * @param {string} code
 * @returns {string}
 */
export function convertirGles1VersGles3(code) {
  let resultat = code;
  for (const [motif, remplacement] of REMPLACEMENTS_GLES1) resultat = resultat.replace(motif, remplacement);
  for (const [motif, remplacement] of REMPLACEMENTS_QUALIFICATEURS) resultat = resultat.replace(motif, remplacement);
  return resultat.replace(DECLARATION_UNIFORM_STANDARD, '');
}

function convertirPasse(passe) {
  return { ...passe, code: convertirGles1VersGles3(passe.code) };
}

/**
 * Convertit le code GLES 1.00 → 3.00 (voir convertirGles1VersGles3) de toutes les
 * passes d'un shader normalisé (common, buffers, image, cubemaps), sans toucher aux
 * autres champs (entrées, ordre de rendu déjà résolu par parser.js). Partagé par le
 * viewport principal (js/app.js) et les miniatures (js/thumbnails.js) : les deux
 * doivent compiler exactement le même code.
 * @param {import('./parser.js').ShaderNormalise} normalise
 * @returns {import('./parser.js').ShaderNormalise}
 */
export function convertirShaderNormalise(normalise) {
  const buffers = {};
  for (const [lettre, passe] of Object.entries(normalise.buffers)) buffers[lettre] = convertirPasse(passe);
  const cubemaps = {};
  for (const [nom, passe] of Object.entries(normalise.cubemaps)) cubemaps[nom] = convertirPasse(passe);
  return {
    ...normalise,
    commun: normalise.commun !== null ? convertirPasse(normalise.commun) : null,
    buffers,
    cubemaps,
    image: convertirPasse(normalise.image),
  };
}

/**
 * @typedef {object} RapportCompatibilite
 * @property {{ passe: string, de: string, vers: string, occurrences: number }[]} conversions
 *           adaptations GLSL ES 1.00 → 3.00 réellement appliquées au code (commentaires exclus)
 * @property {{ code: 'mainVR', passe: string }[]} avertissements fonctions Shadertoy sans équivalent ici
 */

/**
 * Établit le rapport de compatibilité d'un shader normalisé **avant** conversion : quelles
 * adaptations convertirGles1VersGles3 va appliquer (par passe, avec le nombre d'occurrences),
 * et quelles fonctions Shadertoy sont ignorées — `mainVR` (réalité virtuelle) est compilé
 * mais jamais appelé : seul `mainImage` produit l'image affichée. Les occurrences situées
 * dans des commentaires ne comptent pas.
 * @param {import('./parser.js').ShaderNormalise} normalise
 * @returns {RapportCompatibilite}
 */
export function analyserCompatibilite(normalise) {
  const passes = [];
  if (normalise.commun !== null) passes.push(['common', normalise.commun]);
  for (const lettre of Object.keys(normalise.buffers).sort()) passes.push([`buffer-${lettre}`, normalise.buffers[lettre]]);
  for (const nom of Object.keys(normalise.cubemaps)) passes.push([`cubemap-${nom}`, normalise.cubemaps[nom]]);
  passes.push(['image', normalise.image]);
  const conversions = [];
  const avertissements = [];
  for (const [idPasse, passe] of passes) {
    const code = retirerCommentaires(passe.code);
    for (const [motif, remplacement] of [...REMPLACEMENTS_GLES1, ...REMPLACEMENTS_QUALIFICATEURS]) {
      const occurrences = (code.match(motif) ?? []).length;
      if (occurrences > 0) conversions.push({ passe: idPasse, de: nomRemplace(motif), vers: remplacement.replace(/\($/, ''), occurrences });
    }
    for (const declaration of code.matchAll(DECLARATION_UNIFORM_STANDARD)) {
      conversions.push({ passe: idPasse, de: `uniform ${declaration[1]}`, vers: 'déclaration retirée (déjà fournie)', occurrences: 1 });
    }
    if (/\bvoid\s+mainVR\s*\(/.test(code)) avertissements.push({ code: 'mainVR', passe: idPasse });
  }
  return { conversions, avertissements };
}

// ---------------------------------------------------------------------------
// Correspondance des erreurs de compilation sur les numéros de ligne d'origine
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ErreurLigne
 * @property {number|null} ligne numéro de ligne dans le code utilisateur d'origine (1-indexé), ou null si hors de celui-ci
 * @property {number|null} colonne colonne si fournie par le pilote, sinon null
 * @property {string} message texte de l'erreur, sans le numéro de ligne du pilote
 * @property {string} brut ligne brute du journal de compilation
 */

// Formats usuels des journaux WebGL : « ERROR: 0:12: 'x' : ... » (ANGLE / Chrome, Firefox ;
// le premier nombre est l'indice de fichier, toujours 0 pour une source unique, le second
// le numéro de ligne — ANGLE ne fournit pas de colonne) ou « 12:34(5): error: ... » (pilotes
// Mesa ; ligne, colonne, puis un numéro de version de shader entre parenthèses, ignoré).
const MOTIF_ANGLE = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/;
const MOTIF_MESA = /^(\d+):(\d+)\(\d+\)\s*:\s*(.*)$/;

/**
 * Analyse une ligne brute du journal de compilation d'un pilote WebGL.
 * @param {string} ligneBrute
 * @returns {{ ligneSource: number, colonne: number|null, message: string }|null} null si le format n'est pas reconnu
 */
function analyserLigneJournal(ligneBrute) {
  const correspondanceAngle = MOTIF_ANGLE.exec(ligneBrute);
  if (correspondanceAngle !== null) {
    return { ligneSource: Number(correspondanceAngle[1]), colonne: null, message: correspondanceAngle[2] };
  }
  const correspondanceMesa = MOTIF_MESA.exec(ligneBrute);
  if (correspondanceMesa !== null) {
    return { ligneSource: Number(correspondanceMesa[1]), colonne: Number(correspondanceMesa[2]), message: correspondanceMesa[3] };
  }
  return null;
}

/**
 * Convertit le journal brut d'un pilote WebGL (`getShaderInfoLog`) en erreurs dont
 * le numéro de ligne est ramené au code utilisateur d'origine (celui donné dans le
 * JSON Shadertoy), en retranchant le décalage introduit par l'en-tête injecté et le
 * code « common ». Une ligne du journal antérieure à `decalageLignes` (donc dans
 * l'en-tête lui-même, qui ne peut normalement pas être fautif) ou dans le code
 * « common » (fautif, mais hors du fichier affiché) renvoie une `ligne` nulle :
 * l'inspecteur affiche alors le message sans correspondance cliquable.
 * @param {string} journal texte brut renvoyé par `getShaderInfoLog`
 * @param {number} decalageLignes nombre de lignes insérées avant le code utilisateur (voir construireFragmentShader)
 * @returns {ErreurLigne[]}
 */
export function mapperErreurs(journal, decalageLignes) {
  if (typeof journal !== 'string' || journal.trim() === '') return [];
  return journal
    .split('\n')
    .map((brut) => brut.trim())
    .filter((brut) => brut !== '')
    .map((brut) => {
      const analyse = analyserLigneJournal(brut);
      if (analyse === null) return { ligne: null, colonne: null, message: brut, brut };
      const ligneUtilisateur = analyse.ligneSource - decalageLignes;
      return {
        ligne: ligneUtilisateur >= 1 ? ligneUtilisateur : null,
        colonne: analyse.colonne,
        message: analyse.message,
        brut,
      };
    });
}

// ---------------------------------------------------------------------------
// Horloge maîtrisée (lecture, pause, remise à zéro, pas à pas, saut temporel)
// ---------------------------------------------------------------------------

/**
 * Horloge de rendu indépendante de `performance.now()` : le temps n'avance que par
 * `avancer`, ce qui permet à la même horloge de servir à l'affichage interactif
 * (avancée proportionnelle au temps réel écoulé entre deux images) et à l'export
 * déterministe de la Phase 9 (avancée fixe de `1 / fps` par image, indépendamment
 * de la vitesse réelle de rendu).
 */
export class Horloge {
  constructor() {
    this._temps = 0;
    this._image = 0;
    this._deltaTemps = 0;
    this._enMarche = false;
  }

  /** Temps courant en secondes (`iTime`). */
  get temps() { return this._temps; }

  /** Numéro de l'image courante depuis la dernière remise à zéro (`iFrame`). */
  get image() { return this._image; }

  /** Durée écoulée depuis l'image précédente, en secondes (`iTimeDelta`). */
  get deltaTemps() { return this._deltaTemps; }

  /** Vrai si l'horloge avance (lecture), faux à l'arrêt (pause). */
  get enMarche() { return this._enMarche; }

  lire() { this._enMarche = true; }

  pause() { this._enMarche = false; }

  /** Remet le temps, le compteur d'image et le delta à zéro ; l'état lecture/pause est conservé. */
  remettreAZero() {
    this._temps = 0;
    this._image = 0;
    this._deltaTemps = 0;
  }

  /**
   * Avance l'horloge d'une durée fixe et incrémente le compteur d'image, que
   * l'horloge soit en marche ou non (le pas à pas appelle `avancer` à l'arrêt).
   * @param {number} deltaSecondes durée à ajouter, en secondes (toujours positive)
   */
  avancer(deltaSecondes) {
    const delta = Number.isFinite(deltaSecondes) && deltaSecondes > 0 ? deltaSecondes : 0;
    this._deltaTemps = delta;
    this._temps += delta;
    this._image += 1;
  }

  /**
   * Avance l'horloge d'une seule image, à une fréquence donnée, sans la mettre en
   * marche (pas à pas manuel, utilisable à l'arrêt comme en lecture).
   * @param {number} fps
   */
  pasAPas(fps) {
    this.avancer(1 / fps);
  }

  /**
   * Déplace le temps à une valeur donnée, sans changer l'état lecture/pause. Le
   * compteur d'image n'est remis à zéro que si le saut recule le temps avant zéro
   * (équivalent à une remise à zéro) ; un saut en avant conserve le compteur, car
   * `iFrame` doit rester croissant pour les buffers de rétroaction (Phase 4).
   * @param {number} secondes
   */
  sauterA(secondes) {
    const cible = Number.isFinite(secondes) && secondes > 0 ? secondes : 0;
    this._deltaTemps = cible - this._temps;
    this._temps = cible;
    if (cible === 0) this._image = 0;
  }

  /**
   * Fixe explicitement l'état de l'horloge pour un rendu déterministe hors ligne.
   * @param {number} temps secondes depuis le début du shader
   * @param {number} image index de frame
   * @param {number} deltaTemps durée de frame
   */
  definirEtat(temps, image, deltaTemps) {
    if (![temps, image, deltaTemps].every(Number.isFinite) || temps < 0 || image < 0 || deltaTemps < 0) {
      throw new RangeError('État d’horloge invalide.');
    }
    this._temps = temps;
    this._image = Math.floor(image);
    this._deltaTemps = deltaTemps;
  }
}

/**
 * Détecte un shader trop lent pour l'interface : après `imagesConsecutives` mesures consécutives sous
 * `seuilFps`, `observer` renvoie vrai **une seule fois** (jusqu'à `reinitialiser`), pour proposer à
 * l'utilisateur de suspendre le rendu. Une mesure rapide remet le compteur à zéro : un à-coup isolé
 * (compilation, changement d'onglet) ne déclenche rien.
 */
export class SuiviLenteur {
  /**
   * @param {number} [seuilFps] cadence en dessous de laquelle une mesure est dite lente
   * @param {number} [imagesConsecutives] nombre de mesures lentes consécutives avant l'alerte
   */
  constructor(seuilFps = 12, imagesConsecutives = 90) {
    this.seuilFps = seuilFps;
    this.imagesConsecutives = imagesConsecutives;
    this.reinitialiser();
  }

  reinitialiser() {
    this._lentes = 0;
    this._signale = false;
  }

  /**
   * @param {number} fps cadence lissée mesurée (0 ou non fini : mesure ignorée)
   * @returns {boolean} vrai au moment où l'alerte doit être affichée
   */
  observer(fps) {
    if (!Number.isFinite(fps) || fps <= 0) return false;
    this._lentes = fps < this.seuilFps ? this._lentes + 1 : 0;
    if (this._signale || this._lentes < this.imagesConsecutives) return false;
    this._signale = true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Souris Shadertoy (iMouse : position, clic, état précédent)
// ---------------------------------------------------------------------------

/**
 * État de la souris au format `iMouse` : `xy` position courante (origine en bas à
 * gauche, comme `gl_FragCoord`), `zw` position au dernier clic, signée négativement
 * tant qu'aucun bouton n'est enfoncé (convention Shadertoy exploitée par de
 * nombreux shaders pour détecter le relâchement du bouton).
 */
export class EtatSouris {
  constructor() {
    this._x = 0;
    this._y = 0;
    this._clicX = 0;
    this._clicY = 0;
    this._enfoncee = false;
  }

  /**
   * Met à jour la position courante, convertie en repère bas-gauche.
   * @param {number} xPixels position en pixels depuis la gauche du canevas
   * @param {number} yPixelsDepuisHaut position en pixels depuis le haut du canevas
   * @param {number} hauteurCanevas hauteur du canevas en pixels, pour l'inversion verticale
   */
  deplacer(xPixels, yPixelsDepuisHaut, hauteurCanevas) {
    this._x = xPixels;
    this._y = hauteurCanevas - yPixelsDepuisHaut;
  }

  /** Enregistre l'appui : la position de clic se fige à la position courante. */
  appuyer() {
    this._enfoncee = true;
    this._clicX = this._x;
    this._clicY = this._y;
  }

  /** Enregistre le relâchement : la position de clic (`zw`) reste visible au repère précédent. */
  relacher() {
    this._enfoncee = false;
  }

  /** Valeur à transmettre à l'uniform `iMouse` (vec4). */
  get iMouse() {
    return [this._x, this._y, this._enfoncee ? this._clicX : -this._clicX, this._enfoncee ? this._clicY : -this._clicY];
  }
}

// ---------------------------------------------------------------------------
// Entrée clavier (texture 256 × 3 : état, appui, bascule)
// ---------------------------------------------------------------------------

export const LARGEUR_TEXTURE_CLAVIER = 256;

// Lignes de la texture clavier Shadertoy, par code de touche (0 à 255) : ligne 0 vrai
// tant que la touche est enfoncée, ligne 1 vrai une seule image après l'appui (front
// montant), ligne 2 inversée à chaque appui (bascule, utile pour les interrupteurs).
export const LIGNE_CLAVIER = Object.freeze({ ENFONCEE: 0, APPUYEE: 1, BASCULE: 2 });

/**
 * État du clavier Shadertoy : trois lignes de 256 octets (un par code de touche
 * `KeyboardEvent.keyCode`, convention historique conservée par Shadertoy), prêtes à
 * charger dans une texture R8 256 × 3 (voir MoteurRendu._mettreAJourTextureClavier).
 */
export class EtatClavier {
  constructor() {
    this._octets = new Uint8Array(LARGEUR_TEXTURE_CLAVIER * 3);
    // Touches dont le prochain appui doit être signalé une seule image (ligne APPUYEE) ;
    // vidé à chaque appel de consommerAppuis (une fois le rendu de l'image effectué).
    this._appuiesCetteImage = new Set();
  }

  /** Les octets des trois lignes (ENFONCEE, APPUYEE, BASCULE), prêts pour `texSubImage2D`. */
  get octets() { return this._octets; }

  /**
   * Enregistre l'appui d'une touche : enfoncée, signalée pour cette image, bascule inversée.
   * Un appui répété (répétition automatique du système) ne doit pas inverser la bascule
   * à nouveau : `repetition` le signale pour que seul le premier appui physique compte.
   * @param {number} code `KeyboardEvent.keyCode` (0 à 255 ; hors plage, ignoré)
   * @param {boolean} [repetition] vrai si cet événement est une répétition automatique
   */
  appuyer(code, repetition = false) {
    if (!Number.isInteger(code) || code < 0 || code >= LARGEUR_TEXTURE_CLAVIER) return;
    this._octets[LIGNE_CLAVIER.ENFONCEE * LARGEUR_TEXTURE_CLAVIER + code] = 255;
    if (!repetition) {
      this._appuiesCetteImage.add(code);
      this._octets[LIGNE_CLAVIER.APPUYEE * LARGEUR_TEXTURE_CLAVIER + code] = 255;
      const indexBascule = LIGNE_CLAVIER.BASCULE * LARGEUR_TEXTURE_CLAVIER + code;
      this._octets[indexBascule] = this._octets[indexBascule] === 0 ? 255 : 0;
    }
  }

  /**
   * Enregistre le relâchement d'une touche : enfoncée à faux ; la bascule n'est pas affectée.
   * @param {number} code
   */
  relacher(code) {
    if (!Number.isInteger(code) || code < 0 || code >= LARGEUR_TEXTURE_CLAVIER) return;
    this._octets[LIGNE_CLAVIER.ENFONCEE * LARGEUR_TEXTURE_CLAVIER + code] = 0;
  }

  /**
   * Met à zéro la ligne APPUYEE des touches signalées à l'image précédente : à appeler
   * une fois par image, après l'envoi de la texture au rendu (la ligne APPUYEE ne doit
   * rester à 255 que pendant l'image qui suit l'appui, comme sur Shadertoy).
   */
  consommerAppuis() {
    for (const code of this._appuiesCetteImage) this._octets[LIGNE_CLAVIER.APPUYEE * LARGEUR_TEXTURE_CLAVIER + code] = 0;
    this._appuiesCetteImage.clear();
  }
}

// ---------------------------------------------------------------------------
// Calcul des valeurs d'uniforms (indépendant de WebGL : valeurs prêtes à envoyer)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ValeursUniforms
 * @property {[number, number, number]} iResolution largeur, hauteur, rapport pixels (toujours 1 : pas de mise à l'échelle par device pixel ratio côté rendu)
 * @property {number} iTime
 * @property {number} iTimeDelta
 * @property {number} iFrame
 * @property {number} iFrameRate
 * @property {[number, number, number, number]} iMouse
 * @property {[number, number, number, number]} iDate année, mois (1-12), jour, secondes depuis minuit (heure locale)
 * @property {number} iSampleRate
 */

/**
 * Calcule les valeurs des uniforms standard pour une image donnée, à partir de
 * l'horloge et de l'état de la souris. `iFrameRate` est l'inverse de `iTimeDelta`
 * (0 si celui-ci est nul, à la première image). `iDate` reflète l'instant réel de
 * rendu (heure locale), sauf si `maintenant` est fourni explicitement — utilisé par
 * l'export (Phase 9) pour un rendu déterministe indépendant de l'horloge système.
 * @param {{ largeur: number, hauteur: number }} resolution résolution du viewport, en pixels
 * @param {Horloge} horloge
 * @param {EtatSouris} souris
 * @param {{ frequenceEchantillonnage?: number, maintenant?: Date }} [options]
 * @returns {ValeursUniforms}
 */
export function calculerUniforms(resolution, horloge, souris, { frequenceEchantillonnage = 44100, maintenant = new Date() } = {}) {
  const debutAnnee = new Date(maintenant.getFullYear(), 0, 1);
  const secondesDepuisMinuit = (maintenant.getTime() - new Date(
    maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate(),
  ).getTime()) / 1000;
  return {
    iResolution: [resolution.largeur, resolution.hauteur, 1],
    iTime: horloge.temps,
    iTimeDelta: horloge.deltaTemps,
    iFrame: horloge.image,
    iFrameRate: horloge.deltaTemps > 0 ? 1 / horloge.deltaTemps : 0,
    iMouse: souris.iMouse,
    iDate: [maintenant.getFullYear(), maintenant.getMonth() + 1, maintenant.getDate(), secondesDepuisMinuit],
    iSampleRate: frequenceEchantillonnage,
    // Conservé pour référence interne (non un uniform Shadertoy) : jours écoulés depuis le 1er janvier.
    _joursDepuisDebutAnnee: Math.floor((maintenant.getTime() - debutAnnee.getTime()) / 86400000),
  };
}

// ---------------------------------------------------------------------------
// Contexte WebGL2 : création, extensions, perte et restauration
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ExtensionsDisponibles
 * @property {boolean} flottantsRenderables `EXT_color_buffer_float` : textures RGBA32F utilisables comme cibles de rendu (buffers Phase 4)
 * @property {boolean} filtrageLineaireFlottant `OES_texture_float_linear` : filtrage linéaire des textures flottantes
 * @property {boolean} precisionHauteFragment les `float` des fragment shaders ont au moins 23 bits de mantisse (`highp` complet) ;
 *           WebGL2 l'impose, la valeur ne sert qu'à signaler un pilote hors spécification
 */

/**
 * Détecte les extensions WebGL2 utiles au rendu Shadertoy. Leur absence n'empêche
 * pas le rendu : les buffers de rétroaction (Phase 4) replient alors sur RGBA16F
 * (support flottant de base, garanti par WebGL2) ou sur un filtrage au plus proche.
 * @param {WebGL2RenderingContext} gl
 * @returns {ExtensionsDisponibles}
 */
export function detecterExtensions(gl) {
  return {
    flottantsRenderables: gl.getExtension('EXT_color_buffer_float') !== null,
    filtrageLineaireFlottant: gl.getExtension('OES_texture_float_linear') !== null,
    precisionHauteFragment: (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ?? 0) >= 23,
  };
}

/**
 * Le filtrage linéaire est-il possible sur les cibles de rendu flottantes ? Les buffers
 * sont en RGBA32F quand `EXT_color_buffer_float` est présente (filtrage linéaire alors
 * conditionné par `OES_texture_float_linear`), sinon en RGBA16F, toujours filtrable.
 * @param {ExtensionsDisponibles} extensions
 * @returns {boolean}
 */
export function filtrageLineaireCiblesPossible(extensions) {
  return !extensions.flottantsRenderables || extensions.filtrageLineaireFlottant;
}

/**
 * Peut-on générer une chaîne de mipmaps sur les cibles de rendu flottantes ? Exige un format
 * à la fois rendable et filtrable (`generateMipmap`), donc les deux extensions.
 * @param {ExtensionsDisponibles} extensions
 * @returns {boolean}
 */
export function mipmapsCiblesPossibles(extensions) {
  return extensions.flottantsRenderables && extensions.filtrageLineaireFlottant;
}

/**
 * Crée le contexte WebGL2 d'un canevas.
 * @param {HTMLCanvasElement} canevas
 * @param {WebGLContextAttributes} [attributs]
 * @returns {WebGL2RenderingContext}
 * @throws {ErreurContexte} si WebGL2 n'est pas disponible dans ce navigateur
 */
export function creerContexte(canevas, attributs = { alpha: false, antialias: false, preserveDrawingBuffer: false }) {
  const gl = canevas.getContext('webgl2', attributs);
  if (gl === null) {
    throw new ErreurContexte(
      'WebGL2 indisponible : ce navigateur ou ce matériel ne peut pas afficher les shaders. '
      + 'Mettez à jour votre navigateur ou vérifiez que l\'accélération graphique est activée.',
    );
  }
  return gl;
}

/**
 * Installe les gestionnaires de perte et de restauration de contexte WebGL.
 * À la perte, tout objet GL existant (programmes, textures, tampons) devient
 * invalide : `surPerte` doit suspendre le rendu. À la restauration, un nouveau
 * contexte utilisable est en place et `surRestauration` doit recompiler les
 * programmes et recréer les ressources (buffers compris, remis à zéro).
 * @param {HTMLCanvasElement} canevas
 * @param {() => void} surPerte
 * @param {() => void} surRestauration
 * @returns {() => void} fonction de nettoyage, à appeler pour retirer les gestionnaires
 */
export function surveillerPerteContexte(canevas, surPerte, surRestauration) {
  const gestionnairePerte = (evenement) => {
    // preventDefault est requis par la spécification pour autoriser la restauration ;
    // sans cet appel, le navigateur considère le contexte définitivement perdu.
    evenement.preventDefault();
    surPerte();
  };
  const gestionnaireRestauration = () => surRestauration();
  canevas.addEventListener('webglcontextlost', gestionnairePerte, false);
  canevas.addEventListener('webglcontextrestored', gestionnaireRestauration, false);
  return () => {
    canevas.removeEventListener('webglcontextlost', gestionnairePerte, false);
    canevas.removeEventListener('webglcontextrestored', gestionnaireRestauration, false);
  };
}

// ---------------------------------------------------------------------------
// Textures et cibles de rendu (buffers A à D, cubemaps, clavier)
// ---------------------------------------------------------------------------

/**
 * Choisit le format interne flottant d'une cible de rendu selon les extensions
 * disponibles : RGBA32F si `EXT_color_buffer_float` est présente (précision pleine,
 * nécessaire à certains shaders de simulation), sinon RGBA16F (support flottant de
 * base de WebGL2, toujours utilisable comme cible de rendu sans extension).
 * @param {ExtensionsDisponibles} extensions
 * @returns {{ interne: number, type: number }} `interne` et `type` au sens de `gl.texImage2D` (les constantes elles-mêmes, préfixées gl., sont résolues par l'appelant)
 */
function choisirFormatFlottant(gl, extensions) {
  return extensions.flottantsRenderables
    ? { interne: gl.RGBA32F, type: gl.FLOAT }
    : { interne: gl.RGBA16F, type: gl.HALF_FLOAT };
}

/**
 * Filtres de minification et d'agrandissement à appliquer pour l'échantillonnage demandé.
 * Une texture 8 bits (image, volume local) se filtre toujours ; une cible de rendu
 * flottante (buffer, cubemap rendu) ne se filtre ou ne se mipmappe que si le matériel
 * le permet (voir filtrageLineaireCiblesPossible, mipmapsCiblesPossibles), avec repli
 * progressif mipmap → linéaire → plus proche voisin.
 * @param {{ NEAREST: number, LINEAR: number, LINEAR_MIPMAP_LINEAR: number }} gl constantes WebGL
 * @param {import('./parser.js').Echantillonnage} echantillonnage
 * @param {ExtensionsDisponibles} extensions
 * @param {boolean} cibleFlottante vrai pour un buffer ou un cubemap rendu, faux pour une texture de média
 * @returns {{ min: number, mag: number }}
 */
export function choisirFiltres(gl, echantillonnage, extensions, cibleFlottante) {
  const lineaire = !cibleFlottante || filtrageLineaireCiblesPossible(extensions);
  const mipmap = !cibleFlottante || mipmapsCiblesPossibles(extensions);
  const filtreLineaire = lineaire ? gl.LINEAR : gl.NEAREST;
  if (echantillonnage.filtre === 'nearest') return { min: gl.NEAREST, mag: gl.NEAREST };
  if (echantillonnage.filtre === 'mipmap') return { min: mipmap ? gl.LINEAR_MIPMAP_LINEAR : filtreLineaire, mag: filtreLineaire };
  return { min: filtreLineaire, mag: filtreLineaire };
}

function appliquerEchantillonnage(gl, cible, echantillonnage, extensions, cibleFlottante = true) {
  const { min, mag } = choisirFiltres(gl, echantillonnage, extensions, cibleFlottante);
  const repetition = echantillonnage.repetition === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(cible, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(cible, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(cible, gl.TEXTURE_WRAP_S, repetition);
  gl.texParameteri(cible, gl.TEXTURE_WRAP_T, repetition);
  if (cible === gl.TEXTURE_CUBE_MAP || cible === gl.TEXTURE_3D) gl.texParameteri(cible, gl.TEXTURE_WRAP_R, repetition);
}

/**
 * Cible de rendu d'un buffer (A à D) : deux textures 2D flottantes avec leur
 * tampon de cadre (« ping-pong »), pour qu'une passe puisse lire sa propre sortie de
 * la frame précédente (rétroaction) tout en écrivant la frame courante dans l'autre.
 * `avant()` est la texture à lire (résultat de la dernière frame rendue, ou vide à la
 * création) ; `permuter()` échange les deux après le rendu de chaque frame.
 */
export class Tampon {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} largeur
   * @param {number} hauteur
   * @param {ExtensionsDisponibles} extensions
   * @param {{ mipmaps?: boolean }} [options] `mipmaps` : une passe lit ce buffer en filtre « mipmap » ; la chaîne de
   *        mipmaps est alors régénérée après chaque rendu (si le matériel le permet, voir mipmapsCiblesPossibles)
   */
  constructor(gl, largeur, hauteur, extensions, { mipmaps = false } = {}) {
    this.gl = gl;
    this.largeur = largeur;
    this.hauteur = hauteur;
    this.extensions = extensions;
    this.mipmaps = mipmaps && mipmapsCiblesPossibles(extensions);
    this._paires = [this._creerPaire(), this._creerPaire()];
    this._indexAvant = 0;
    this._genererMipmapsDeToutes();
  }

  _genererMipmapsDeToutes() {
    if (!this.mipmaps) return;
    const { gl } = this;
    for (const { texture } of this._paires) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  /**
   * Régénère les mipmaps de la texture qui vient d'être écrite (celle de `arriere()`) ; à appeler
   * après le rendu et avant `permuter()`. Sans effet si ce buffer n'est pas lu en filtre « mipmap ».
   */
  genererMipmaps() {
    if (!this.mipmaps) return;
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this._paires[1 - this._indexAvant].texture);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  _creerPaire() {
    const { gl } = this;
    const { interne, type } = choisirFormatFlottant(gl, this.extensions);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, interne, this.largeur, this.hauteur, 0, gl.RGBA, type, null);
    appliquerEchantillonnage(gl, gl.TEXTURE_2D, ECHANTILLONNAGE_PAR_DEFAUT, this.extensions);
    const tamponCadre = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tamponCadre);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, tamponCadre };
  }

  /** Texture à lire : résultat de la dernière frame rendue (vide tant qu'aucune frame n'a été rendue). */
  avant() { return this._paires[this._indexAvant].texture; }

  /** Tampon de cadre à écrire pour la frame courante. */
  arriere() { return this._paires[1 - this._indexAvant].tamponCadre; }

  /** Échange lecture et écriture ; à appeler après chaque rendu de ce buffer. */
  permuter() { this._indexAvant = 1 - this._indexAvant; }

  /**
   * Remet les deux textures à zéro (pixels transparents), pour une remise à zéro de
   * l'horloge : un buffer de rétroaction ne doit pas repartir avec le contenu de la
   * dernière lecture avant l'arrêt.
   */
  vider() {
    const { gl } = this;
    for (const { tamponCadre } of this._paires) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, tamponCadre);
      gl.viewport(0, 0, this.largeur, this.hauteur);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._genererMipmapsDeToutes();
  }

  /** Libère les deux textures et tampons de cadre. */
  detruire() {
    const { gl } = this;
    for (const { texture, tamponCadre } of this._paires) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(tamponCadre);
    }
  }
}

/**
 * Cible de rendu d'une passe cubemap : une texture cube et, pour chacune de ses six
 * faces, un tampon de cadre dédié (une texture cube ne peut être attachée qu'une
 * face à la fois). Pas de ping-pong : les cubemaps Shadertoy ne lisent pas leur
 * propre sortie de la frame précédente.
 */
export class TamponCubemap {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} taille longueur du côté de chaque face, en pixels
   * @param {ExtensionsDisponibles} extensions
   * @param {{ mipmaps?: boolean }} [options] voir Tampon
   */
  constructor(gl, taille, extensions, { mipmaps = false } = {}) {
    this.gl = gl;
    this.taille = taille;
    this.mipmaps = mipmaps && mipmapsCiblesPossibles(extensions);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.texture);
    const { interne, type } = choisirFormatFlottant(gl, extensions);
    for (let face = 0; face < 6; face += 1) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, interne, taille, taille, 0, gl.RGBA, type, null);
    }
    appliquerEchantillonnage(gl, gl.TEXTURE_CUBE_MAP, ECHANTILLONNAGE_PAR_DEFAUT, extensions);
    this._tamponsCadre = Array.from({ length: 6 }, (_, face) => {
      const tamponCadre = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, tamponCadre);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, this.texture, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return tamponCadre;
    });
    this.genererMipmaps();
  }

  /** Régénère les mipmaps des six faces ; à appeler après le rendu de la dernière face. Sans effet hors filtre « mipmap ». */
  genererMipmaps() {
    if (!this.mipmaps) return;
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.texture);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  }

  /** Tampon de cadre à écrire pour une face donnée (0 à 5, ordre de FACES_CUBEMAP). */
  tamponCadre(face) { return this._tamponsCadre[face]; }

  /** Libère la texture cube et les six tampons de cadre. */
  detruire() {
    const { gl } = this;
    gl.deleteTexture(this.texture);
    for (const tamponCadre of this._tamponsCadre) gl.deleteFramebuffer(tamponCadre);
  }
}

/**
 * Crée la texture clavier (R8, 256 × 3, voir EtatClavier), vide initialement : aucune
 * touche enfoncée, aucune bascule active.
 * @param {WebGL2RenderingContext} gl
 * @returns {WebGLTexture}
 */
export function creerTextureClavier(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, LARGEUR_TEXTURE_CLAVIER, 3, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * Transfère l'état courant du clavier (EtatClavier.octets) vers sa texture.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {Uint8Array} octets
 */
export function mettreAJourTextureClavier(gl, texture, octets) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LARGEUR_TEXTURE_CLAVIER, 3, gl.RED, gl.UNSIGNED_BYTE, octets);
}

/**
 * Crée une texture de repli 1 × 1 (noir opaque) pour un canal dont le média n'est pas
 * encore résolu (texture, volume, vidéo : Phase 5 ; webcam, micro : jamais dans les
 * miniatures ni l'export). Un canal lié à cette texture produit un `texture(iChannelN, …)`
 * valide (noir) plutôt qu'un comportement indéfini ou une erreur de liaison de programme.
 * @param {WebGL2RenderingContext} gl
 * @returns {WebGLTexture}
 */
export function creerTexturePlaceholder(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

/** Repli 1 × 1 × 1 (noir opaque) d'un canal `volume` dont le média n'est pas encore prêt (échantillonneur `sampler3D`). */
export function creerTexturePlaceholder3D(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

/** Repli 1 × 1 par face (noir opaque) d'un canal `cubemap` dont le média n'est pas encore prêt (échantillonneur `samplerCube`). */
export function creerTexturePlaceholderCube(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
  for (let face = 0; face < 6; face += 1) {
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

// ---------------------------------------------------------------------------
// Compilation d'une passe
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CompilationPasse
 * @property {WebGLProgram} programme
 * @property {Record<string, WebGLUniformLocation|null>} emplacements emplacements des uniforms standard, par nom (null si l'uniform n'est pas utilisé par le shader, donc optimisé par le compilateur)
 * @property {number} decalageLignes voir construireFragmentShader
 */

const NOMS_UNIFORMS = Object.freeze([
  'iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iFrameRate', 'iMouse', 'iDate',
  'iSampleRate', 'iChannelTime', 'iChannelResolution', 'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3',
  'shaderview_rayOrigine', 'shaderview_repereFace', 'iBlockOffset',
]);

function compilerEtape(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const journal = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    return { shader: null, journal };
  }
  return { shader, journal: gl.getShaderInfoLog(shader) ?? '' };
}

/**
 * Compile et lie le programme d'une passe à partir de son code utilisateur déjà
 * converti (voir convertirGles1VersGles3) et du code « common » éventuel. Les
 * erreurs du fragment shader sont mappées sur les numéros de ligne du code
 * utilisateur d'origine (voir mapperErreurs) et portées par `ErreurCompilation`.
 * @param {WebGL2RenderingContext} gl
 * @param {string} code code utilisateur de la passe (après conversion GLES 1.00 → 3.00)
 * @param {string|null} commun code « common », déjà converti, ou null
 * @param {{ cubemap?: boolean, son?: boolean, typesCanaux?: string[] }} [options] voir construireFragmentShader
 * @returns {CompilationPasse}
 * @throws {ErreurCompilation}
 */
export function compilerPasse(gl, code, commun, options = {}) {
  const { source: sourceFragment, decalageLignes } = construireFragmentShader(code, commun, options);

  const { shader: sommets, journal: journalSommets } = compilerEtape(gl, gl.VERTEX_SHADER, SOMMETS_QUAD);
  if (sommets === null) {
    throw new ErreurCompilation(`Échec de compilation du shader de sommets (interne à ShaderView) : ${journalSommets}`, []);
  }
  const { shader: fragment, journal: journalFragment } = compilerEtape(gl, gl.FRAGMENT_SHADER, sourceFragment);
  if (fragment === null) {
    gl.deleteShader(sommets);
    const erreursLigne = mapperErreurs(journalFragment, decalageLignes);
    throw new ErreurCompilation(`Échec de compilation du fragment shader : ${journalFragment}`, erreursLigne);
  }

  const programme = gl.createProgram();
  gl.attachShader(programme, sommets);
  gl.attachShader(programme, fragment);
  gl.linkProgram(programme);
  gl.deleteShader(sommets);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(programme, gl.LINK_STATUS)) {
    const journalLiaison = gl.getProgramInfoLog(programme) ?? '';
    gl.deleteProgram(programme);
    throw new ErreurCompilation(`Échec de liaison du programme : ${journalLiaison}`, []);
  }

  const emplacements = {};
  for (const nom of NOMS_UNIFORMS) emplacements[nom] = gl.getUniformLocation(programme, nom);
  // Chaque échantillonneur iChannelN lit l'unité de texture N (celle que lierCanal active). Sans cette affectation,
  // tous les canaux liraient l'unité 0, valeur par défaut d'un uniform d'échantillonneur.
  gl.useProgram(programme);
  for (let canal = 0; canal < 4; canal += 1) {
    const emplacement = emplacements[`iChannel${canal}`];
    if (emplacement !== null) gl.uniform1i(emplacement, canal);
  }
  return { programme, emplacements, decalageLignes };
}

/**
 * Envoie les valeurs d'uniforms standard calculées (voir calculerUniforms) au
 * programme actif. Un emplacement `null` (uniform absent du shader compilé, donc
 * optimisé) est silencieusement ignoré.
 * @param {WebGL2RenderingContext} gl
 * @param {Record<string, WebGLUniformLocation|null>} emplacements
 * @param {ValeursUniforms} valeurs
 */
export function envoyerUniforms(gl, emplacements, valeurs) {
  if (emplacements.iResolution !== null) gl.uniform3fv(emplacements.iResolution, valeurs.iResolution);
  if (emplacements.iTime !== null) gl.uniform1f(emplacements.iTime, valeurs.iTime);
  if (emplacements.iTimeDelta !== null) gl.uniform1f(emplacements.iTimeDelta, valeurs.iTimeDelta);
  if (emplacements.iFrame !== null) gl.uniform1i(emplacements.iFrame, valeurs.iFrame);
  if (emplacements.iFrameRate !== null) gl.uniform1f(emplacements.iFrameRate, valeurs.iFrameRate);
  if (emplacements.iMouse !== null) gl.uniform4fv(emplacements.iMouse, valeurs.iMouse);
  if (emplacements.iDate !== null) gl.uniform4fv(emplacements.iDate, valeurs.iDate);
  if (emplacements.iSampleRate !== null) gl.uniform1f(emplacements.iSampleRate, valeurs.iSampleRate);
}

/**
 * Envoie `iChannelResolution[]` (largeur, hauteur, profondeur par canal — profondeur 1
 * hors volume, 0 pour un canal inutilisé) et `iChannelTime[]` pour la passe courante.
 * @param {WebGL2RenderingContext} gl
 * @param {Record<string, WebGLUniformLocation|null>} emplacements
 * @param {{ largeur: number, hauteur: number, profondeur?: number }[]} resolutionsCanaux longueur 4 ; { largeur: 0, hauteur: 0 } pour un canal inutilisé
 * @param {number|number[]} tempsCanaux temps de chaque canal (tableau de 4) ; un nombre est répété sur les quatre canaux
 */
export function envoyerUniformsCanaux(gl, emplacements, resolutionsCanaux, tempsCanaux) {
  if (emplacements.iChannelResolution !== null) {
    const valeurs = new Float32Array(12);
    for (let i = 0; i < 4; i += 1) {
      valeurs[i * 3] = resolutionsCanaux[i]?.largeur ?? 0;
      valeurs[i * 3 + 1] = resolutionsCanaux[i]?.hauteur ?? 0;
      valeurs[i * 3 + 2] = resolutionsCanaux[i]?.profondeur ?? 1;
    }
    gl.uniform3fv(emplacements.iChannelResolution, valeurs);
  }
  if (emplacements.iChannelTime !== null) {
    const temps = Array.isArray(tempsCanaux) ? Float32Array.from({ length: 4 }, (_, i) => tempsCanaux[i] ?? 0) : new Float32Array(4).fill(tempsCanaux);
    gl.uniform1fv(emplacements.iChannelTime, temps);
  }
}

/**
 * Envoie les uniforms propres à une face de cubemap (`shaderview_rayOrigine`,
 * `shaderview_repereFace`, voir construireFragmentShader et matriceRepereFace).
 * @param {WebGL2RenderingContext} gl
 * @param {Record<string, WebGLUniformLocation|null>} emplacements
 * @param {[number, number, number]} origine position de la caméra cubemap (centre du cube, (0,0,0) sur Shadertoy)
 * @param {Float32Array} repereFace voir matriceRepereFace
 */
export function envoyerUniformsFace(gl, emplacements, origine, repereFace) {
  if (emplacements.shaderview_rayOrigine !== null) gl.uniform3fv(emplacements.shaderview_rayOrigine, origine);
  if (emplacements.shaderview_repereFace !== null) gl.uniformMatrix3fv(emplacements.shaderview_repereFace, false, repereFace);
}

/**
 * Dessine le quad plein écran avec le programme actif (`gl.useProgram` doit avoir
 * été appelé au préalable). Aucun tampon de sommets n'est nécessaire : le shader
 * de sommets calcule ses positions depuis `gl_VertexID` (voir SOMMETS_QUAD).
 * @param {WebGL2RenderingContext} gl
 */
export function dessinerQuad(gl) {
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/**
 * Lie une texture (2D ou cube) à l'unité de texture d'un canal (`iChannel0` à 3) et
 * applique l'échantillonnage demandé par le JSON pour cette entrée. L'échantillonnage
 * est réappliqué à chaque image plutôt qu'une seule fois à la création de la texture :
 * une même texture (ex. un buffer) peut être lue avec des réglages différents par
 * plusieurs passes, comme le permet le format Shadertoy.
 * @param {WebGL2RenderingContext} gl
 * @param {number} canal 0 à 3
 * @param {WebGLTexture} texture
 * @param {boolean|'2d'|'cube'|'3d'} genre dimension de la texture (`true` équivaut à `'cube'`, `false` à `'2d'`)
 * @param {import('./parser.js').Echantillonnage} echantillonnage
 * @param {ExtensionsDisponibles} extensions
 * @param {boolean} [cibleFlottante] vrai pour un buffer ou un cubemap rendu (voir choisirFiltres), faux pour un média
 */
export function lierCanal(gl, canal, texture, genre, echantillonnage, extensions, cibleFlottante = true) {
  const cible = (genre === true || genre === 'cube') ? gl.TEXTURE_CUBE_MAP : (genre === '3d' ? gl.TEXTURE_3D : gl.TEXTURE_2D);
  gl.activeTexture(gl.TEXTURE0 + canal);
  gl.bindTexture(cible, texture);
  appliquerEchantillonnage(gl, cible, echantillonnage, extensions, cibleFlottante);
}

/**
 * Calcule le repère (colonnes = axe X, axe Y, axe -Z de la caméra) d'une face de
 * cubemap, pour l'uniforme `shaderview_repereFace` de construireFragmentShader : le
 * rayon de chaque pixel est `repereFace * vec3(uv, -1.)` normalisé.
 * @param {{ avant: number[], haut: number[] }} face voir FACES_CUBEMAP
 * @returns {Float32Array} matrice 3×3 en ordre colonne (format attendu par `gl.uniformMatrix3fv`)
 */
export function matriceRepereFace(face) {
  const produitVectoriel = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const droite = produitVectoriel(face.avant, face.haut);
  // Ordre colonne : X (droite), Y (haut), -Z (avant, car le rayon regarde vers -Z du repère local).
  return new Float32Array([...droite, ...face.haut, ...face.avant.map((v) => -v)]);
}

// ---------------------------------------------------------------------------
// Moteur de rendu multipasse
// ---------------------------------------------------------------------------

// Taille d'une face de cubemap : Shadertoy n'expose pas ce réglage dans le JSON,
// une résolution fixe raisonnable suffit (les cubemaps servent surtout de source de
// réflexion/éclairage pour la passe image, jamais affichés directement). Exportée
// pour l'inspecteur (Phase 7), qui l'affiche parmi les résolutions de buffers.
export const TAILLE_FACE_CUBEMAP = 256;
// Origine de la caméra cubemap : centre du cube, convention Shadertoy (rayOri = 0).
const ORIGINE_CUBEMAP = Object.freeze([0, 0, 0]);
// La texture clavier se lit toujours au plus proche voisin (une touche = un texel, sans interpolation).
const ECHANTILLONNAGE_CLAVIER = Object.freeze({ ...ECHANTILLONNAGE_PAR_DEFAUT, filtre: 'nearest' });

/**
 * Détermine, pour chaque canal (0 à 3) d'une passe normalisée, la source à lier au
 * rendu : un buffer interne (par sa lettre), une passe cubemap interne (par son nom),
 * la texture clavier, un média externe (par son `src`, résolu ou substitué par
 * `app.js`/`media.js` — tant qu'aucune texture n'a été fournie pour ce `src`, la
 * texture de repli est utilisée, voir creerTexturePlaceholder et
 * MoteurRendu.definirTexturesMedia), ou aucune (canal inutilisé). L'association des
 * buffers et cubemaps se fait par `idSortie` (voir parser.js), jamais par `src`.
 * @param {import('./parser.js').Passe} passe
 * @param {import('./parser.js').ShaderNormalise} normalise
 * @returns {('keyboard'|'aucune'|{ genre: 'buffer'|'cubemap'|'media' })[]} longueur 4
 */
export function resoudreSourcesCanaux(passe, normalise) {
  const sources = ['aucune', 'aucune', 'aucune', 'aucune'];
  for (const entree of passe.entrees) {
    if (entree.type === 'keyboard') { sources[entree.canal] = 'keyboard'; continue; }
    if (entree.type === 'buffer' && entree.idSortie !== null) {
      const lettre = LETTRES_BUFFERS.find((l) => normalise.buffers[l]?.idSortie === entree.idSortie);
      if (lettre !== undefined) { sources[entree.canal] = { genre: 'buffer', lettre, echantillonnage: entree.echantillonnage }; continue; }
    }
    if (entree.type === 'cubemap' && entree.idSortie !== null) {
      const nom = Object.keys(normalise.cubemaps).find((n) => normalise.cubemaps[n].idSortie === entree.idSortie);
      if (nom !== undefined) { sources[entree.canal] = { genre: 'cubemap', nom, echantillonnage: entree.echantillonnage }; continue; }
    }
    // Tout autre type reconnu (texture, volume, vidéo, webcam, micro, musique) référence
    // un média externe, résolu ou substitué ailleurs (voir media.js) ; sans texture
    // fournie pour ce src, lierCanal utilise la texture de repli (voir _lierCanaux).
    sources[entree.canal] = { genre: 'media', src: entree.src, type: entree.type, echantillonnage: entree.echantillonnage };
  }
  return sources;
}

export function typesCanauxDe(passe) {
  const types = ['texture', 'texture', 'texture', 'texture'];
  for (const entree of passe.entrees) types[entree.canal] = entree.type;
  return types;
}

/**
 * Canaux « libres » (sans entrée dans le JSON) dont le nom figure sur une ligne en erreur du code utilisateur.
 * Quand un export Shadertoy a perdu ses `inputs`, le code lit pourtant `iChannel1` comme un cubemap ou un volume :
 * ces lignes indiquent quels canaux changer de type d'échantillonneur.
 * @param {string} code code utilisateur de la passe
 * @param {ErreurLigne[]} erreursLigne
 * @param {Set<number>} canauxLibres
 * @returns {number[]}
 */
export function canauxMentionnes(code, erreursLigne, canauxLibres) {
  const lignes = code.split('\n');
  const trouves = new Set();
  for (const { ligne } of erreursLigne) {
    if (ligne === null) continue;
    for (const m of (lignes[ligne - 1] ?? '').matchAll(/\biChannel([0-3])\b/g)) {
      if (canauxLibres.has(Number(m[1]))) trouves.add(Number(m[1]));
    }
  }
  return [...trouves];
}

/**
 * Cherche un type d'échantillonneur (`texture` = 2D, `cubemap`, `volume` = 3D) pour chaque canal libre qui fasse
 * compiler la passe, à partir des lignes en erreur : exploration en profondeur bornée, le cubemap étant essayé
 * avant le volume. Une passe qui compile du premier coup n'est jamais explorée.
 * @param {(types: string[]) => { ok: true, valeur: any } | { ok: false, erreur: ErreurCompilation }} essayer compile avec ces types de canaux
 * @param {string[]} typesInitiaux types déclarés (longueur 4)
 * @param {Set<number>} canauxLibres canaux sans entrée dans le JSON
 * @param {string} code code utilisateur de la passe (pour lire les lignes en erreur)
 * @param {{ budget?: number }} [options] nombre maximal de compilations
 * @returns {{ ok: true, valeur: any, types: string[] } | { ok: false, erreur: ErreurCompilation }}
 */
export function rechercherTypesCanaux(essayer, typesInitiaux, canauxLibres, code, { budget = 24 } = {}) {
  const vus = new Set();
  const pile = [typesInitiaux];
  let premiereErreur = null;
  let restant = budget;
  while (pile.length > 0 && restant > 0) {
    const types = pile.pop();
    const cle = types.join(',');
    if (vus.has(cle)) continue;
    vus.add(cle);
    restant -= 1;
    const essai = essayer(types);
    if (essai.ok) return { ok: true, valeur: essai.valeur, types };
    premiereErreur ??= essai.erreur;
    // Pile : le dernier empilé est essayé en premier, donc « cubemap » en dernier ici.
    for (const canal of canauxMentionnes(code, essai.erreur.erreursLigne, canauxLibres)) {
      for (const type of ['texture', 'volume', 'cubemap']) {
        if (type !== types[canal]) pile.push(types.map((t, i) => (i === canal ? type : t)));
      }
    }
  }
  return { ok: false, erreur: premiereErreur };
}

/**
 * Position de lecture d'une vidéo pour un temps de shader donné : la vidéo boucle sur sa durée.
 * @returns {number|null} null si la durée n'est pas (encore) connue
 */
export function positionVideo(temps, duree) {
  if (!Number.isFinite(duree) || duree <= 0 || !Number.isFinite(temps) || temps < 0) return null;
  return temps % duree;
}

/**
 * Écart circulaire (en secondes) entre deux positions d'une vidéo en boucle.
 */
export function ecartVideo(position, cible, duree) {
  const ecart = Math.abs(position - cible);
  return Math.min(ecart, Math.max(0, duree - ecart));
}

/** Tolérance de dérive avant de resynchroniser une vidéo qui joue (secondes). */
export const DERIVE_VIDEO_MAX = 0.3;

/**
 * Cale un élément vidéo sur l'horloge du shader. Horloge en marche : la vidéo joue et n'est repositionnée que si elle
 * dérive de plus de DERIVE_VIDEO_MAX ; horloge arrêtée : la vidéo est en pause sur l'image correspondant au temps.
 * @param {{ duration: number, currentTime: number, paused: boolean, seeking: boolean, play: Function, pause: Function }} video
 * @returns {boolean} vrai si un repositionnement a été demandé
 */
export function synchroniserVideo(video, temps, enMarche) {
  const cible = positionVideo(temps, video.duration);
  if (cible === null) return false;
  let saut = false;
  if (enMarche) {
    if (video.paused) { const lecture = video.play(); if (lecture?.catch) lecture.catch(() => {}); }
    if (!video.seeking && ecartVideo(video.currentTime, cible, video.duration) > DERIVE_VIDEO_MAX) { video.currentTime = cible; saut = true; }
  } else {
    if (!video.paused) video.pause();
    if (!video.seeking && ecartVideo(video.currentTime, cible, video.duration) > 0.001) { video.currentTime = cible; saut = true; }
  }
  return saut;
}

/**
 * Moteur de rendu d'un shader normalisé (modèle `ShaderNormalise` de parser.js) dans
 * un canevas fixe 800 × 450 : exécute dans l'ordre les buffers A à D (résolu par
 * parser.js, rétroaction comprise), les passes cubemap (six faces chacune), puis la
 * passe « image » vers le canevas. Gère la création du contexte, la compilation de
 * chaque passe, les cibles de rendu (Tampon, TamponCubemap), la texture clavier,
 * les textures de médias externes (fournies par `definirTexturesMedia`, voir
 * media.js/app.js pour leur résolution), l'horloge, la souris et la perte/restauration
 * de contexte. La passe « sound » (Phase 6) reste hors de ce moteur. Un canal dont le
 * média n'a pas encore été fourni (chargement en cours, ou substitution non encore
 * calculée) reste lié à la texture de repli, voir creerTexturePlaceholder.
 */
export class MoteurRendu {
  /**
   * @param {HTMLCanvasElement} canevas
   */
  constructor(canevas) {
    this.canevas = canevas;
    this.horloge = new Horloge();
    this.souris = new EtatSouris();
    this.clavier = new EtatClavier();
    this.gl = creerContexte(canevas);
    this.extensions = detecterExtensions(this.gl);
    this._normalise = null;
    this._programmesBuffers = {};
    this._programmesCubemaps = {};
    this._programmeImage = null;
    this._tampons = {};
    this._tamponsCubemaps = {};
    this._textureClavier = creerTextureClavier(this.gl);
    this._texturePlaceholder = creerTexturePlaceholder(this.gl);
    this._texturePlaceholder3D = creerTexturePlaceholder3D(this.gl);
    this._texturePlaceholderCube = creerTexturePlaceholderCube(this.gl);
    this._buffersMipmap = new Set(); // lettres des buffers lus en filtre « mipmap » par au moins une passe
    this._cubemapsMipmap = new Set(); // idem pour les passes cubemap
    this.tempsMedia = null; // (src) => secondes|null : position d'un média audio (music/musicstream), fournie par l'application
    this._texturesMedia = new Map(); // src → { texture, largeur, hauteur[, profondeur, volume, flottant][, video, retournementVertical] }
    this._videosConnues = new Map(); // src → { video, retournementVertical } : recréées après une perte de contexte
    this._arreterSurveillance = surveillerPerteContexte(
      canevas,
      () => { this._libererProgrammes(); this._libererTampons(); this._libererTexturesMedia(); },
      () => {
        this.gl = creerContexte(canevas);
        this.extensions = detecterExtensions(this.gl);
        this._textureClavier = creerTextureClavier(this.gl);
        this._texturePlaceholder = creerTexturePlaceholder(this.gl);
        this._texturePlaceholder3D = creerTexturePlaceholder3D(this.gl);
        this._texturePlaceholderCube = creerTexturePlaceholderCube(this.gl);
        // Les textures de médias doivent être redonnées par l'appelant (definirTexturesMedia) :
        // leurs octets décodés ne sont pas conservés par ce moteur après le premier envoi au GPU.
        this._texturesMedia = new Map();
        for (const [src, { video, retournementVertical }] of this._videosConnues) {
          this._texturesMedia.set(src, this._creerTextureVideo(video, retournementVertical));
        }
        if (this._normalise !== null) this.compiler(this._normalise);
      },
    );
  }

  _libererTexturesMedia() {
    for (const { texture } of this._texturesMedia.values()) this.gl.deleteTexture(texture);
    this._texturesMedia = new Map();
  }

  /**
   * Fournit les textures de médias externes déjà décodées, par `src` (le chemin JSON
   * d'origine, tel que porté par les entrées normalisées — voir resoudreSourcesCanaux).
   * Remplace entièrement l'ensemble précédent : les textures qui ne sont plus fournies
   * sont libérées. À appeler après `compiler`, une fois la résolution des médias
   * terminée (voir media.js, app.js) ; tant qu'un canal n'a pas de texture ici, il
   * reste lié à la texture de repli (voir _lierCanaux).
   * @param {Map<string, { octets: Uint8Array, largeur: number, hauteur: number, cubemap?: boolean }>} decodees RGBA prêts pour `texImage2D`, par src
   *        ou `{ video: HTMLVideoElement, retournementVertical?: boolean }` pour une vidéo locale (rafraîchie à chaque image)
   * @param {{ fusionner?: boolean }} [options] `fusionner` : ajoute ou remplace ces seules entrées sans libérer les autres (mises à jour par image)
   */
  definirTexturesMedia(decodees, { fusionner = false } = {}) {
    const { gl } = this;
    const suivant = fusionner ? new Map(this._texturesMedia) : new Map();
    if (!fusionner) this._videosConnues = new Map();
    for (const [src, media] of decodees) {
      const existante = this._texturesMedia.get(src);
      if (media.video !== undefined) {
        // Vidéo locale : la texture est rafraîchie à chaque image par mettreAJourVideos.
        const retournementVertical = media.retournementVertical === true;
        this._videosConnues.set(src, { video: media.video, retournementVertical });
        if (existante !== undefined && existante.video === media.video) { suivant.set(src, existante); continue; }
        if (existante !== undefined) gl.deleteTexture(existante.texture);
        suivant.set(src, this._creerTextureVideo(media.video, retournementVertical));
        continue;
      }
      if (existante?.video !== undefined) this._videosConnues.delete(src);
      if (media.profondeur !== undefined) {
        suivant.set(src, this._definirVolume(existante, media));
        continue;
      }
      const { octets, largeur, hauteur, cubemap = false, srgb = false } = media;
      const cible = cubemap ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
      // Entrée marquée `srgb` dans le JSON : texels stockés en sRGB, convertis en linéaire à l'échantillonnage (comme Shadertoy).
      const interne = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA;
      // Réutilise la texture existante si sa nature et ses dimensions n'ont pas changé (ex. une
      // substitution procédurale régénérée à l'identique) ; sinon la (re)crée.
      if (existante !== undefined && existante.video === undefined && !existante.volume && existante.cubemap === cubemap
        && existante.srgb === srgb && existante.largeur === largeur && existante.hauteur === hauteur) {
        gl.bindTexture(cible, existante.texture);
        if (cubemap) for (let face = 0; face < 6; face += 1) gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, 0, 0, largeur, hauteur, gl.RGBA, gl.UNSIGNED_BYTE, octets);
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, largeur, hauteur, gl.RGBA, gl.UNSIGNED_BYTE, octets);
        gl.generateMipmap(cible);
        suivant.set(src, existante);
        continue;
      }
      if (existante !== undefined) gl.deleteTexture(existante.texture);
      const texture = gl.createTexture();
      gl.bindTexture(cible, texture);
      if (cubemap) for (let face = 0; face < 6; face += 1) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, interne, largeur, hauteur, 0, gl.RGBA, gl.UNSIGNED_BYTE, octets);
      else gl.texImage2D(gl.TEXTURE_2D, 0, interne, largeur, hauteur, 0, gl.RGBA, gl.UNSIGNED_BYTE, octets);
      // Chaîne de mipmaps pour les filtres « mipmap » (cubemap compris, sinon la texture serait incomplète donc noire).
      gl.generateMipmap(cible);
      suivant.set(src, { texture, largeur, hauteur, cubemap, srgb });
    }
    if (!fusionner) {
      for (const [src, { texture }] of this._texturesMedia) if (!suivant.has(src)) gl.deleteTexture(texture);
    }
    this._texturesMedia = suivant;
  }

  /**
   * Crée ou met à jour la texture 3D d'un canal `volume` (voir decoderVolume dans media.js pour le format des données).
   * @param {{ texture: WebGLTexture, volume?: boolean, largeur: number, hauteur: number, profondeur?: number, canaux?: number, flottant?: boolean }|undefined} existante
   * @param {{ octets: ArrayBufferView, largeur: number, hauteur: number, profondeur: number, canaux: 1|2|4, flottant?: boolean }} media
   */
  _definirVolume(existante, media) {
    const { gl } = this;
    const { octets, largeur, hauteur, profondeur, canaux, flottant = false } = media;
    const formats = {
      1: flottant ? [gl.R32F, gl.RED, gl.FLOAT] : [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
      2: flottant ? [gl.RG32F, gl.RG, gl.FLOAT] : [gl.RG8, gl.RG, gl.UNSIGNED_BYTE],
      4: flottant ? [gl.RGBA32F, gl.RGBA, gl.FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    };
    const [interne, format, type] = formats[canaux];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let texture;
    if (existante?.volume && existante.largeur === largeur && existante.hauteur === hauteur && existante.profondeur === profondeur
      && existante.canaux === canaux && existante.flottant === flottant) {
      texture = existante.texture;
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, largeur, hauteur, profondeur, format, type, octets);
    } else {
      if (existante !== undefined) gl.deleteTexture(existante.texture);
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texImage3D(gl.TEXTURE_3D, 0, interne, largeur, hauteur, profondeur, 0, format, type, octets);
    }
    // Les mipmaps d'un volume 8 bits sont toujours générés (filtre « mipmap ») ; un volume flottant 32 bits n'en a pas.
    if (!flottant) gl.generateMipmap(gl.TEXTURE_3D);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    return { texture, largeur, hauteur, profondeur, canaux, flottant, volume: true };
  }

  _creerTextureVideo(video, retournementVertical) {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Noir opaque jusqu'à la première image décodée.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return { texture, largeur: 1, hauteur: 1, video, retournementVertical, derniereImage: null };
  }

  /**
   * Cale les vidéos locales sur l'horloge puis envoie leur image courante au GPU. Une vidéo qui n'a pas encore d'image
   * décodée garde son noir initial. Appelée à chaque image de rendu.
   */
  mettreAJourVideos() {
    const { gl } = this;
    for (const entree of this._texturesMedia.values()) {
      const { video } = entree;
      if (video === undefined) continue;
      synchroniserVideo(video, this.horloge.temps, this.horloge.enMarche);
      if (video.readyState < 2 || !(video.videoWidth > 0)) continue;
      if (entree.derniereImage === video.currentTime && entree.largeur === video.videoWidth) continue;
      gl.bindTexture(gl.TEXTURE_2D, entree.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, entree.retournementVertical);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      entree.largeur = video.videoWidth;
      entree.hauteur = video.videoHeight;
      entree.derniereImage = video.currentTime;
    }
  }

  /**
   * Positionne chaque vidéo exactement sur le temps courant de l'horloge et attend que l'image soit décodée. Sert à
   * l'export, où l'horloge est virtuelle : sans cette attente, l'image rendue dépendrait de la vitesse de décodage.
   * @param {number} [delaiMs] attente maximale par vidéo
   */
  async preparerVideos(delaiMs = 2000) {
    const attentes = [];
    for (const { video } of this._texturesMedia.values()) {
      if (video === undefined) continue;
      if (!video.paused) video.pause();
      const cible = positionVideo(this.horloge.temps, video.duration);
      if (cible === null || ecartVideo(video.currentTime, cible, video.duration) <= 0.001) continue;
      attentes.push(new Promise((resolu) => {
        const fin = () => { video.removeEventListener('seeked', fin); clearTimeout(minuteur); resolu(); };
        const minuteur = setTimeout(fin, delaiMs);
        video.addEventListener('seeked', fin);
        video.currentTime = cible;
      }));
    }
    await Promise.all(attentes);
  }

  _libererProgrammes() {
    const { gl } = this;
    for (const { programme } of Object.values(this._programmesBuffers)) gl.deleteProgram(programme);
    for (const { programme } of Object.values(this._programmesCubemaps)) gl.deleteProgram(programme);
    if (this._programmeImage !== null) gl.deleteProgram(this._programmeImage.programme);
    this._programmesBuffers = {};
    this._programmesCubemaps = {};
    this._programmeImage = null;
  }

  _libererTampons() {
    for (const tampon of Object.values(this._tampons)) tampon.detruire();
    for (const tampon of Object.values(this._tamponsCubemaps)) tampon.detruire();
    this._tampons = {};
    this._tamponsCubemaps = {};
  }

  /**
   * Compile toutes les passes d'un shader normalisé (buffers, cubemaps, image) et
   * (re)crée leurs cibles de rendu. À appeler à chaque changement de shader
   * sélectionné, et automatiquement après restauration du contexte. En cas d'échec
   * de compilation d'une passe (ErreurCompilation propagée telle quelle), les passes
   * déjà compilées pour ce shader sont conservées à l'état précédent — aucun rendu
   * partiel n'est tenté avec un programme manquant (`rendre` ne dessine rien tant que
   * `compiler` n'a pas entièrement réussi).
   * @param {import('./parser.js').ShaderNormalise} normalise
   * @throws {ErreurCompilation}
   */
  compiler(normalise) {
    const { gl } = this;
    const commun = normalise.commun !== null ? normalise.commun.code : null;

    const inferences = [];
    const compilerAvecId = (idPasse, passe, options) => {
      const libres = new Set([0, 1, 2, 3].filter((canal) => !passe.entrees.some((e) => e.canal === canal)));
      const resultat = rechercherTypesCanaux((types) => {
        try {
          return { ok: true, valeur: compilerPasse(gl, passe.code, commun, { ...options, typesCanaux: types }) };
        } catch (e) {
          if (e instanceof ErreurCompilation) return { ok: false, erreur: e };
          throw e;
        }
      }, options.typesCanaux, libres, passe.code);
      if (!resultat.ok) throw new ErreurCompilation(resultat.erreur.message, resultat.erreur.erreursLigne, idPasse);
      resultat.types.forEach((type, canal) => {
        if (libres.has(canal) && type !== options.typesCanaux[canal]) inferences.push({ passe: idPasse, canal, type });
      });
      return { ...resultat.valeur, typesCanaux: resultat.types };
    };

    const programmesBuffers = {};
    for (const lettre of normalise.ordreBuffers) {
      const passe = normalise.buffers[lettre];
      programmesBuffers[lettre] = compilerAvecId(`buffer-${lettre}`, passe, { typesCanaux: typesCanauxDe(passe) });
    }
    const programmesCubemaps = {};
    for (const [nom, passe] of Object.entries(normalise.cubemaps)) {
      programmesCubemaps[nom] = compilerAvecId(`cubemap-${nom}`, passe, { cubemap: true, typesCanaux: typesCanauxDe(passe) });
    }
    const programmeImage = compilerAvecId('image', normalise.image, { typesCanaux: typesCanauxDe(normalise.image) });

    // Toutes les compilations ont réussi (une erreur aurait levé avant cette ligne) :
    // seulement maintenant on remplace l'état précédent et recrée les cibles de rendu.
    this._libererProgrammes();
    this._programmesBuffers = programmesBuffers;
    this._programmesCubemaps = programmesCubemaps;
    this._programmeImage = programmeImage;
    this._normalise = normalise;
    /** Canaux sans entrée dans le JSON dont le type d'échantillonneur a été déduit du code : `{ passe, canal, type }[]`. */
    this.inferences = inferences;
    this._recreerTampons();
  }

  /**
   * Détermine quels buffers et cubemaps rendus sont lus en filtre « mipmap » par au moins une passe : seuls ceux-là
   * voient leur chaîne de mipmaps régénérée après chaque rendu (sinon la texture lue serait incomplète, donc noire).
   */
  _analyserMipmaps() {
    this._buffersMipmap = new Set();
    this._cubemapsMipmap = new Set();
    const n = this._normalise;
    const passes = [...Object.values(n.buffers), ...Object.values(n.cubemaps), n.image];
    for (const passe of passes) {
      for (const source of resoudreSourcesCanaux(passe, n)) {
        if (source === 'aucune' || source === 'keyboard' || source.echantillonnage?.filtre !== 'mipmap') continue;
        if (source.genre === 'buffer') this._buffersMipmap.add(source.lettre);
        else if (source.genre === 'cubemap') this._cubemapsMipmap.add(source.nom);
      }
    }
  }

  _recreerTampons() {
    this._libererTampons();
    const { gl, extensions } = this;
    const { width: largeur, height: hauteur } = this.canevas;
    this._analyserMipmaps();
    for (const lettre of Object.keys(this._programmesBuffers)) {
      this._tampons[lettre] = new Tampon(gl, largeur, hauteur, extensions, { mipmaps: this._buffersMipmap.has(lettre) });
    }
    for (const nom of Object.keys(this._programmesCubemaps)) {
      this._tamponsCubemaps[nom] = new TamponCubemap(gl, TAILLE_FACE_CUBEMAP, extensions, { mipmaps: this._cubemapsMipmap.has(nom) });
    }
  }

  /**
   * Redimensionne le canevas et recrée les buffers A à D à la nouvelle résolution
   * (les cubemaps, de taille fixe, ne sont pas concernés). Le viewport interactif
   * reste fixe 800 × 450 (mise à l'échelle CSS uniquement) et n'appelle jamais cette
   * méthode ; elle sert à l'export (Phase 9), qui peut demander jusqu'à 1920 × 1080.
   * Le contenu des buffers de rétroaction est perdu (équivalent à reinitialiserTampons).
   * @param {number} largeur
   * @param {number} hauteur
   */
  redimensionner(largeur, hauteur) {
    this.canevas.width = largeur;
    this.canevas.height = hauteur;
    if (this._normalise !== null) this._recreerTampons();
  }

  /**
   * Remet à zéro le contenu de tous les buffers de rétroaction (pixels transparents),
   * sans recompiler : à appeler en même temps que `horloge.remettreAZero()`, pour
   * qu'un shader avec rétroaction reparte d'un état vide plutôt que du contenu accumulé
   * avant l'arrêt.
   */
  reinitialiserTampons() {
    for (const tampon of Object.values(this._tampons)) tampon.vider();
  }

  _resolutionCanal(source) {
    if (source === 'keyboard') return { largeur: LARGEUR_TEXTURE_CLAVIER, hauteur: 3 };
    if (source === 'aucune') return { largeur: 0, hauteur: 0 };
    if (source.genre === 'buffer') return { largeur: this.canevas.width, hauteur: this.canevas.height };
    if (source.genre === 'cubemap') return { largeur: TAILLE_FACE_CUBEMAP, hauteur: TAILLE_FACE_CUBEMAP };
    const texture = this._texturesMedia.get(source.src);
    if (texture === undefined) return { largeur: 0, hauteur: 0 };
    return { largeur: texture.largeur, hauteur: texture.hauteur, profondeur: texture.profondeur ?? 1 };
  }

  /**
   * `iChannelTime[]` d'une passe, comme Shadertoy : la position de lecture (secondes) d'un canal vidéo ou audio
   * (music, musicstream), 0 pour tout autre canal. La position audio est fournie par l'application (`tempsMedia`).
   */
  _tempsCanaux(sources) {
    return sources.map((source) => {
      if (source === 'aucune' || source === 'keyboard' || source.genre !== 'media') return 0;
      if (source.type === 'video') return this._texturesMedia.get(source.src)?.video?.currentTime ?? 0;
      if (source.type === 'music' || source.type === 'musicstream') return this.tempsMedia?.(source.src) ?? 0;
      return 0;
    });
  }

  _lierCanaux(sources, compilation) {
    const { gl } = this;
    for (let canal = 0; canal < 4; canal += 1) {
      const source = sources[canal];
      if (source === 'aucune') {
        // Canal sans entrée dans le JSON : un repli noir du type d'échantillonneur déclaré (déduit du code si besoin),
        // pour qu'un shader qui le lit voie du noir plutôt que la texture restée liée à cette unité par une autre passe.
        const type = compilation.typesCanaux?.[canal];
        if (type === 'cubemap') lierCanal(gl, canal, this._texturePlaceholderCube, 'cube', ECHANTILLONNAGE_CLAVIER, this.extensions, false);
        else if (type === 'volume') lierCanal(gl, canal, this._texturePlaceholder3D, '3d', ECHANTILLONNAGE_CLAVIER, this.extensions, false);
        else lierCanal(gl, canal, this._texturePlaceholder, '2d', ECHANTILLONNAGE_CLAVIER, this.extensions, false);
        continue;
      }
      if (source === 'keyboard') { lierCanal(gl, canal, this._textureClavier, '2d', ECHANTILLONNAGE_CLAVIER, this.extensions, false); continue; }
      if (source.genre === 'buffer') { lierCanal(gl, canal, this._tampons[source.lettre].avant(), '2d', source.echantillonnage, this.extensions); continue; }
      if (source.genre === 'cubemap') { lierCanal(gl, canal, this._tamponsCubemaps[source.nom].texture, 'cube', source.echantillonnage, this.extensions); continue; }
      // genre === 'media' : texture fournie par définirTexturesMedia, sinon repli (voir creerTexturePlaceholder).
      // Le genre de la texture liée suit le type du canal (l'échantillonneur déclaré en dépend) : un volume
      // ou un cubemap encore absent reçoit un repli de même dimension, jamais la texture 2D.
      const texture = this._texturesMedia.get(source.src);
      if (source.type === 'volume') {
        // Un volume flottant 32 bits ne se filtre qu'avec OES_texture_float_linear et n'a pas de mipmaps générés ici.
        const flottant = texture?.flottant === true;
        const echantillonnage = flottant && source.echantillonnage.filtre === 'mipmap' ? { ...source.echantillonnage, filtre: 'linear' } : source.echantillonnage;
        const extensions = flottant ? { ...this.extensions, flottantsRenderables: true } : this.extensions;
        lierCanal(gl, canal, texture?.volume ? texture.texture : this._texturePlaceholder3D, '3d', echantillonnage, extensions, flottant);
      } else if (source.type === 'cubemap') {
        lierCanal(gl, canal, texture !== undefined ? texture.texture : this._texturePlaceholderCube, 'cube', source.echantillonnage, this.extensions, false);
      } else {
        lierCanal(gl, canal, texture !== undefined ? texture.texture : this._texturePlaceholder, '2d', source.echantillonnage, this.extensions, false);
      }
    }
  }

  /**
   * Rend une passe plein écran (buffer ou image) dans le tampon de cadre donné
   * (`null` pour le canevas lui-même). Lie les canaux, envoie les uniforms (globaux,
   * canaux, puis dessine) ; met à jour la texture clavier une seule fois par image
   * (voir rendre), pas par passe.
   */
  _rendrePassePleinEcran(compilation, passe, framebuffer, largeur, hauteur, valeursGlobales) {
    const { gl } = this;
    const sources = resoudreSourcesCanaux(passe, this._normalise);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, largeur, hauteur);
    gl.useProgram(compilation.programme);
    this._lierCanaux(sources, compilation);
    envoyerUniforms(gl, compilation.emplacements, valeursGlobales);
    envoyerUniformsCanaux(gl, compilation.emplacements, sources.map((s) => this._resolutionCanal(s)), this._tempsCanaux(sources));
    dessinerQuad(gl);
  }

  /**
   * Rend une image complète : avance la texture clavier, exécute les buffers dans
   * l'ordre résolu par parser.js (rétroaction : chaque buffer lit son `avant()` avant
   * son propre rendu, puis permute), les passes cubemap (six faces), puis la passe
   * « image » dans le canevas. Sans compilation réussie au préalable, ne dessine rien.
   */
  rendre() {
    // Pas de rendu tant que le contexte est perdu ou que les programmes n'ont pas été recréés après restauration :
    // une exception ici interromprait la boucle d'animation de l'application, qui ne repartirait pas.
    if (this._normalise === null || this._programmeImage === null || this.gl.isContextLost()) return;
    const { gl } = this;
    mettreAJourTextureClavier(gl, this._textureClavier, this.clavier.octets);
    this.clavier.consommerAppuis();
    this.mettreAJourVideos();

    const valeursGlobales = calculerUniforms({ largeur: this.canevas.width, hauteur: this.canevas.height }, this.horloge, this.souris);

    for (const lettre of this._normalise.ordreBuffers) {
      const tampon = this._tampons[lettre];
      this._rendrePassePleinEcran(this._programmesBuffers[lettre], this._normalise.buffers[lettre], tampon.arriere(), tampon.largeur, tampon.hauteur, valeursGlobales);
      if (this._buffersMipmap.has(lettre)) tampon.genererMipmaps();
      tampon.permuter();
    }

    for (const [nom, passe] of Object.entries(this._normalise.cubemaps)) {
      const tampon = this._tamponsCubemaps[nom];
      const compilation = this._programmesCubemaps[nom];
      const sources = resoudreSourcesCanaux(passe, this._normalise);
      for (let face = 0; face < FACES_CUBEMAP.length; face += 1) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, tampon.tamponCadre(face));
        gl.viewport(0, 0, tampon.taille, tampon.taille);
        gl.useProgram(compilation.programme);
        this._lierCanaux(sources, compilation);
        envoyerUniforms(gl, compilation.emplacements, { ...valeursGlobales, iResolution: [tampon.taille, tampon.taille, 1] });
        envoyerUniformsCanaux(gl, compilation.emplacements, sources.map((s) => this._resolutionCanal(s)), this._tempsCanaux(sources));
        envoyerUniformsFace(gl, compilation.emplacements, ORIGINE_CUBEMAP, matriceRepereFace(FACES_CUBEMAP[face]));
        dessinerQuad(gl);
      }
      if (this._cubemapsMipmap.has(nom)) tampon.genererMipmaps();
    }

    this._rendrePassePleinEcran(this._programmeImage, this._normalise.image, null, this.canevas.width, this.canevas.height, valeursGlobales);
  }

  /** Libère tous les programmes, cibles de rendu et textures, et retire les gestionnaires de perte de contexte. */
  detruire() {
    this._libererProgrammes();
    this._libererTampons();
    this._libererTexturesMedia();
    this._videosConnues = new Map();
    this.gl.deleteTexture(this._textureClavier);
    this.gl.deleteTexture(this._texturePlaceholder);
    this.gl.deleteTexture(this._texturePlaceholder3D);
    this.gl.deleteTexture(this._texturePlaceholderCube);
    this._normalise = null;
    this._arreterSurveillance();
  }
}
