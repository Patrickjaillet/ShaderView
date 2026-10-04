// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Analyse des fichiers .json Shadertoy : détection du format, validation légère
// et extraction des métadonnées du catalogue.
//
// Ce module est volontairement indépendant du DOM et du réseau : il est utilisé
// à l'identique par l'outil de construction du manifeste (Node, tools/build-manifest.mjs)
// et par le navigateur (catalog.js, repli « dossier » et « glisser-déposer »).
// Le parseur complet et la résolution du graphe de passes relèvent de parser.js (Phase 2).

export const TYPES_PASSES = Object.freeze(['image', 'buffer', 'sound', 'cubemap', 'common']);

export const TYPES_CANAUX = Object.freeze([
  'texture', 'cubemap', 'volume', 'buffer', 'keyboard',
  'mic', 'music', 'musicstream', 'webcam', 'video', 'misc',
]);

// Types de canaux dont `src`/`filepath` désigne un média distant de Shadertoy (voir Phase 5, media.js).
export const CANAUX_AVEC_MEDIA = new Set(['texture', 'cubemap', 'volume', 'video', 'music', 'musicstream']);

const NOMBRE_CANAUX = 4;

// ---------------------------------------------------------------------------
// Empreinte SHA-256 (implémentation autonome : fonctionne aussi hors contexte sécurisé)
// ---------------------------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotd(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Calcule le SHA-256 d'une suite d'octets.
 * @param {Uint8Array} octets
 * @returns {string} empreinte hexadécimale en minuscules (64 caractères)
 */
export function sha256Hex(octets) {
  const longueur = octets.length;
  const total = (((longueur + 9 + 63) >>> 6) << 6);
  const tampon = new Uint8Array(total);
  tampon.set(octets);
  tampon[longueur] = 0x80;
  const vue = new DataView(tampon.buffer);
  vue.setUint32(total - 8, Math.floor(longueur / 0x20000000), false);
  vue.setUint32(total - 4, (longueur << 3) >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let bloc = 0; bloc < total; bloc += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = vue.getUint32(bloc + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotd(w[i - 15], 7) ^ rotd(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotd(w[i - 2], 17) ^ rotd(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotd(e, 6) ^ rotd(e, 11) ^ rotd(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotd(a, 2) ^ rotd(a, 13) ^ rotd(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (mot) => mot.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// Décodage et détection du format
// ---------------------------------------------------------------------------

/**
 * Décode des octets UTF-8 en texte, en retirant un éventuel BOM.
 * @param {Uint8Array} octets
 * @returns {string}
 */
export function decoderTexte(octets) {
  const texte = new TextDecoder('utf-8').decode(octets);
  return texte.charCodeAt(0) === 0xfeff ? texte.slice(1) : texte;
}

function estObjet(valeur) {
  return valeur !== null && typeof valeur === 'object' && !Array.isArray(valeur);
}

// Une réponse de l'API Shadertoy enveloppe le shader dans { "Shader": { ... } }.
function deballer(element) {
  return estObjet(element) && estObjet(element.Shader) ? element.Shader : element;
}

/**
 * Détecte le format d'un document JSON et en extrait la liste des shaders.
 * Formats reconnus : export unique (objet), export multiple (tableau de shaders),
 * et enveloppe de l'API `{ "Shader": { ... } }` (seule ou en tableau).
 * Chaque élément du tableau est renvoyé tel quel, même invalide : la validation
 * se fait ensuite shader par shader.
 * @param {unknown} json
 * @returns {{ format: 'objet'|'tableau', shaders: unknown[] }}
 * @throws {Error} si la racine n'est ni un shader ni un tableau de shaders
 */
export function detecterFormat(json) {
  if (Array.isArray(json)) {
    if (json.length === 0) throw new Error('Tableau vide : aucun shader.');
    return { format: 'tableau', shaders: json.map(deballer) };
  }
  if (estObjet(json)) {
    const shader = deballer(json);
    if (estObjet(shader) && 'renderpass' in shader) return { format: 'objet', shaders: [shader] };
  }
  throw new Error('Format non reconnu : ni export Shadertoy (clé « renderpass »), ni tableau de shaders.');
}

// ---------------------------------------------------------------------------
// Analyse d'un shader
// ---------------------------------------------------------------------------

function chaineNonVide(valeur) {
  return typeof valeur === 'string' && valeur.trim() !== '' ? valeur.trim() : null;
}

// `info.date` est un horodatage Unix (secondes) donné en chaîne par l'API Shadertoy.
function entierOuNul(valeur) {
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return Math.trunc(valeur);
  if (typeof valeur === 'string' && valeur.trim() !== '' && Number.isFinite(Number(valeur))) return Math.trunc(Number(valeur));
  return null;
}

function triUnique(valeurs) {
  return Array.from(new Set(valeurs)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Valide un shader et en extrait les métadonnées du catalogue.
 * Les anomalies bloquantes renseignent `erreur` ; les anomalies tolérables
 * sont listées dans `avertissements`.
 * @param {unknown} shader
 * @param {number} index position du shader dans le fichier
 * @param {string} nomFichier nom du fichier, utilisé comme titre de repli
 */
export function analyserShader(shader, index, nomFichier) {
  const titreRepli = nomFichier.replace(/\.json$/i, '');
  const resultat = {
    index,
    id: null,
    titre: titreRepli,
    auteur: null,
    description: null,
    tags: [],
    date: null,
    passes: [],
    multipasse: false,
    son: false,
    canaux: [],
    medias: [],
    avertissements: [],
    erreur: null,
  };

  if (!estObjet(shader)) {
    resultat.erreur = 'Élément invalide : un objet shader est attendu.';
    return resultat;
  }

  const info = estObjet(shader.info) ? shader.info : null;
  if (info === null) {
    resultat.avertissements.push('Bloc « info » absent : titre déduit du nom de fichier.');
  } else {
    resultat.id = chaineNonVide(info.id);
    resultat.titre = chaineNonVide(info.name) ?? titreRepli;
    resultat.auteur = chaineNonVide(info.username);
    resultat.description = chaineNonVide(info.description);
    resultat.date = entierOuNul(info.date);
    if (Array.isArray(info.tags)) {
      resultat.tags = info.tags.filter((t) => typeof t === 'string' && t.trim() !== '').map((t) => t.trim());
    }
  }

  if (!Array.isArray(shader.renderpass) || shader.renderpass.length === 0) {
    resultat.erreur = 'Aucune passe : « renderpass » doit être un tableau non vide.';
    return resultat;
  }

  const passes = [];
  const canaux = [];
  const medias = [];

  for (let n = 0; n < shader.renderpass.length; n += 1) {
    const passe = shader.renderpass[n];
    if (!estObjet(passe)) {
      resultat.erreur = `Passe ${n + 1} invalide : un objet est attendu.`;
      return resultat;
    }
    const type = typeof passe.type === 'string' ? passe.type.toLowerCase() : '';
    if (!TYPES_PASSES.includes(type)) {
      resultat.erreur = `Passe ${n + 1} : type « ${String(passe.type)} » inconnu (attendu : ${TYPES_PASSES.join(', ')}).`;
      return resultat;
    }
    if (typeof passe.code !== 'string' || passe.code.trim() === '') {
      resultat.erreur = `Passe ${n + 1} (${type}) : code source absent ou vide.`;
      return resultat;
    }
    passes.push(type);

    const entrees = Array.isArray(passe.inputs) ? passe.inputs : [];
    for (const entree of entrees) {
      if (!estObjet(entree)) {
        resultat.avertissements.push(`Passe ${n + 1} (${type}) : entrée ignorée (objet attendu).`);
        continue;
      }
      const typeCanal = String(entree.ctype ?? entree.type ?? '').toLowerCase();
      if (!TYPES_CANAUX.includes(typeCanal)) {
        resultat.avertissements.push(`Passe ${n + 1} (${type}) : type de canal « ${typeCanal} » inconnu.`);
        continue;
      }
      if (!Number.isInteger(entree.channel) || entree.channel < 0 || entree.channel >= NOMBRE_CANAUX) {
        resultat.avertissements.push(
          `Passe ${n + 1} (${type}) : canal « ${String(entree.channel)} » hors de 0 à ${NOMBRE_CANAUX - 1}.`,
        );
      }
      canaux.push(typeCanal);
      // « filepath » (export API Shadertoy, format réellement rencontré dans shaders/)
      // ou « src » (éditeur en ligne, exports plus anciens) : voir parser.js, parserEntree.
      const src = chaineNonVide(entree.filepath) ?? chaineNonVide(entree.src);
      if (src !== null && CANAUX_AVEC_MEDIA.has(typeCanal)) medias.push(src);
    }
  }

  if (!passes.includes('image')) {
    resultat.erreur = 'Aucune passe « image » : le shader ne peut pas être affiché.';
    return resultat;
  }

  resultat.passes = passes;
  resultat.multipasse = passes.includes('buffer') || passes.includes('cubemap');
  resultat.son = passes.includes('sound');
  resultat.canaux = triUnique(canaux);
  resultat.medias = triUnique(medias);
  return resultat;
}

// ---------------------------------------------------------------------------
// Analyse d'un fichier complet
// ---------------------------------------------------------------------------

/**
 * Analyse le contenu brut d'un fichier .json.
 * Ne lève jamais d'exception : toute anomalie est consignée dans `erreur`
 * (fichier entier) ou dans `shaders[i].erreur` (un seul shader d'un tableau).
 * @param {string} nom nom du fichier (sans chemin)
 * @param {Uint8Array} octets contenu brut
 * @returns {{ fichier: string, taille: number, empreinte: string, format: string|null,
 *            erreur: string|null, shaders: object[] }}
 */
export function analyserFichier(nom, octets) {
  const resultat = {
    fichier: nom,
    taille: octets.length,
    empreinte: sha256Hex(octets),
    format: null,
    erreur: null,
    shaders: [],
  };
  let json;
  try {
    json = JSON.parse(decoderTexte(octets));
  } catch (e) {
    resultat.erreur = `JSON invalide : ${e instanceof Error ? e.message : String(e)}`;
    return resultat;
  }
  let detection;
  try {
    detection = detecterFormat(json);
  } catch (e) {
    resultat.erreur = e instanceof Error ? e.message : String(e);
    return resultat;
  }
  resultat.format = detection.format;
  resultat.shaders = detection.shaders.map((shader, index) => analyserShader(shader, index, nom));
  return resultat;
}

/**
 * Extrait un shader d'un document JSON déjà lu (chargement paresseux).
 * @param {unknown} json document complet
 * @param {number} index position du shader dans le fichier
 * @returns {object} le shader (objet Shadertoy)
 * @throws {Error} si le document n'est pas reconnu ou si l'index n'existe pas
 */
export function extraireShader(json, index) {
  const { shaders } = detecterFormat(json);
  if (!Number.isInteger(index) || index < 0 || index >= shaders.length) {
    throw new Error(`Shader n° ${index} introuvable : le fichier en contient ${shaders.length}.`);
  }
  return shaders[index];
}
