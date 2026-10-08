// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import { tailleDonnees, donneesOuDescripteur, longueurPartie, estDiffere } from './spool.js';

const encoderTaille = (taille) => {
  for (let longueur = 1; longueur <= 8; longueur += 1) {
    const maximum = 2 ** (7 * longueur) - 2;
    if (taille <= maximum) {
      let valeur = BigInt(taille) | (1n << BigInt(7 * longueur));
      const octets = new Uint8Array(longueur);
      for (let i = longueur - 1; i >= 0; i -= 1) {
        octets[i] = Number(valeur & 0xffn);
        valeur >>= 8n;
      }
      return octets;
    }
  }
  throw new RangeError('Élément EBML trop volumineux.');
};

function concatener(...morceaux) {
  const taille = morceaux.reduce((total, morceau) => total + morceau.length, 0);
  const sortie = new Uint8Array(taille);
  let offset = 0;
  for (const morceau of morceaux) {
    sortie.set(morceau, offset);
    offset += morceau.length;
  }
  return sortie;
}

function octetsIdentifiant(id) {
  return typeof id === 'number'
    ? Uint8Array.of(id)
    : Uint8Array.from(id.match(/../g), (octet) => Number.parseInt(octet, 16));
}

function enteteElement(id, taille) {
  return concatener(octetsIdentifiant(id), encoderTaille(taille));
}

function element(id, valeur) {
  const identifiant = octetsIdentifiant(id);
  return concatener(identifiant, encoderTaille(valeur.length), valeur);
}

function entier(valeur, longueur = 1) {
  const sortie = new Uint8Array(longueur);
  let nombre = BigInt(valeur);
  for (let i = longueur - 1; i >= 0; i -= 1) {
    sortie[i] = Number(nombre & 0xffn);
    nombre >>= 8n;
  }
  return sortie;
}

function entierMinimal(valeur) {
  let longueur = 1;
  while (longueur < 8 && BigInt(valeur) >= (1n << BigInt(longueur * 8))) longueur += 1;
  return entier(valeur, longueur);
}

function entierLE(valeur, longueur) {
  const sortie = new Uint8Array(longueur);
  let nombre = BigInt(valeur);
  for (let i = 0; i < longueur; i += 1) {
    sortie[i] = Number(nombre & 0xffn);
    nombre >>= 8n;
  }
  return sortie;
}

function texte(valeur) {
  return new TextEncoder().encode(valeur);
}

function flottant64(valeur) {
  const sortie = new Uint8Array(8);
  new DataView(sortie.buffer).setFloat64(0, valeur, false);
  return sortie;
}

function blocSimple(piste, temps, cle, donnees) {
  if (temps < -32768 || temps > 32767) throw new RangeError('Décalage de cluster WebM hors limites.');
  const prefixe = concatener(Uint8Array.of(0x80 | piste), entier(temps & 0xffff, 2), Uint8Array.of(cle ? 0x80 : 0));
  const taille = prefixe.length + longueurPartie(donnees);
  return {
    parties: [enteteElement('a3', taille), prefixe, donnees],
    taille: enteteElement('a3', taille).length + taille,
  };
}

function entreePisteVideo(codec, largeur, hauteur, fps, codecPrivate) {
  const codecId = codec.startsWith('av01') || codec === 'av1' ? 'V_AV1' : 'V_VP9';
  const description = codecId === 'V_AV1' ? element('63a2', codecPrivate) : new Uint8Array();
  const defaultDuration = Math.round(1_000_000_000 / fps);
  const video = element('e0', concatener(
    element('b0', entier(largeur, largeur > 0xffff ? 4 : 2)),
    element('ba', entier(hauteur, hauteur > 0xffff ? 4 : 2)),
  ));
  return element('ae', concatener(
    element('d7', entier(1)),
    element('73c5', entier(1)),
    element('83', entier(1)),
    element('86', texte(codecId)),
    description,
    element('23e383', entierMinimal(defaultDuration)),
    video,
  ));
}

function entreePisteAudio(sampleRate, channels) {
  const opusHead = concatener(
    texte('OpusHead'),
    Uint8Array.of(1, channels),
    entierLE(0, 2),
    entierLE(sampleRate, 4),
    entierLE(0, 2),
    Uint8Array.of(0),
  );
  const audio = element('e1', concatener(
    element('b5', flottant64(sampleRate)),
    element('9f', entier(channels)),
  ));
  return element('ae', concatener(
    element('d7', entier(2)),
    element('73c5', entier(2)),
    element('83', entier(2)),
    element('86', texte('A_OPUS')),
    element('63a2', opusHead),
    element('56aa', entier(6_500_000, 4)),
    element('56bb', entier(80_000_000, 4)),
    audio,
  ));
}

function entreeSeek(id, position) {
  return element('4dbb', concatener(
    element('53ab', Uint8Array.from(id.match(/../g), (octet) => Number.parseInt(octet, 16))),
    element('53ac', entierMinimal(position)),
  ));
}

function construireSeekHead(positions) {
  return element('114d9b74', concatener(
    entreeSeek('1549a966', positions.info),
    entreeSeek('1654ae6b', positions.tracks),
    entreeSeek('1c53bb6b', positions.cues),
  ));
}

export function construireFluxWebM({
  videoChunks,
  videoCodec,
  videoCodecPrivate = null,
  largeur,
  hauteur,
  fps,
  duree,
  audioChunks = [],
  audioCodec = 'opus',
  sampleRate = 48000,
  channels = 2,
}) {
  if (!Array.isArray(videoChunks) || videoChunks.length === 0) {
    throw new TypeError('Le muxage WebM nécessite au moins une image vidéo encodée.');
  }
  if (!Number.isFinite(duree) || duree <= 0 || !Number.isFinite(fps) || fps <= 0
    || !Number.isInteger(largeur) || largeur < 1 || largeur > 0xffffffff
    || !Number.isInteger(hauteur) || hauteur < 1 || hauteur > 0xffffffff) {
    throw new RangeError('Durée, cadence ou résolution WebM invalide.');
  }
  if (!Array.isArray(audioChunks) || !Number.isInteger(sampleRate) || sampleRate < 8000
    || !Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new RangeError('Configuration audio WebM invalide.');
  }
  if (audioChunks.length > 0 && audioCodec !== 'opus') {
    throw new TypeError(`Codec audio WebM non pris en charge par le muxeur : ${audioCodec}.`);
  }
  // VP9 (« vp9 » ou « vp09.… ») et AV1 (« av1 » ou « av01.… ») quel que soit le niveau : seule la famille choisit
  // l'identifiant de piste Matroska, le niveau ne figure pas dans le fichier.
  if (!/^(vp9|vp09\.\d\d\.\d\d\.\d\d|av1|av01\.\d\.\d\d[MH]\.\d\d)$/.test(String(videoCodec))) {
    throw new TypeError(`Codec vidéo WebM non pris en charge par le muxeur : ${videoCodec}.`);
  }
  const codecAv1 = videoCodec.startsWith('av01') || videoCodec === 'av1';
  if (codecAv1 && !(videoCodecPrivate instanceof Uint8Array) && !(videoCodecPrivate instanceof ArrayBuffer)) {
    throw new TypeError('Le muxage AV1/WebM nécessite la configuration av1C fournie par VideoEncoder.');
  }

  const descriptionVideo = videoCodecPrivate instanceof ArrayBuffer ? new Uint8Array(videoCodecPrivate) : videoCodecPrivate;
  const pistes = [entreePisteVideo(videoCodec, largeur, hauteur, fps, descriptionVideo)];
  if (audioChunks.length > 0) pistes.push(entreePisteAudio(sampleRate, channels));
  const info = element('1549a966', concatener(
    element('2ad7b1', entier(1_000_000, 3)),
    element('4d80', texte('ShaderView')),
    element('5741', texte('ShaderView')),
    element('4489', flottant64(duree * 1000)),
  ));
  const tracks = element('1654ae6b', concatener(...pistes));

  const evenements = [
    ...videoChunks.map((chunk) => ({ ...chunk, track: 1 })),
    ...audioChunks.map((chunk) => ({ ...chunk, track: 2 })),
  ].sort((a, b) => a.timestamp - b.timestamp || a.track - b.track);
  for (const evenement of evenements) {
    if (!Number.isFinite(evenement.timestamp) || evenement.timestamp < 0
      || tailleDonnees(evenement) === 0) {
      throw new TypeError('Un paquet WebM contient un horodatage ou des données invalides.');
    }
  }
  const verifierFlux = (chunks, nom) => {
    const tries = [...chunks].sort((a, b) => a.timestamp - b.timestamp);
    if (tries.length > 0 && tries[0].timestamp !== 0) {
      throw new RangeError(`Le flux ${nom} doit commencer à zéro pour préserver la synchronisation A/V.`);
    }
    if (tries.some((chunk, index) => index > 0 && chunk.timestamp <= tries[index - 1].timestamp)) {
      throw new RangeError(`Horodatages non croissants dans le flux ${nom}.`);
    }
    return tries;
  };
  const videoTries = verifierFlux(videoChunks, 'vidéo');
  verifierFlux(audioChunks, 'audio');
  if (videoTries[0].type !== 'key') throw new TypeError('Le premier paquet vidéo WebM doit être une image clé.');
  const blocs = [];
  const reperes = [];
  let base = 0;
  let groupes = [];
  let dernierKeyframe = 0;
  let decalageClusters = 0;
  const finaliserCluster = () => {
    if (groupes.length === 0) return;
    const timecode = element('e7', entier(base, 4));
    const tailleContenu = timecode.length + groupes.reduce((somme, bloc) => somme + bloc.taille, 0);
    const enteteCluster = enteteElement('1f43b675', tailleContenu);
    const partiesCluster = [enteteCluster, timecode, ...groupes.flatMap((bloc) => bloc.parties)];
    const tailleCluster = enteteCluster.length + tailleContenu;
    blocs.push(partiesCluster);
    reperes.push({ time: base, position: decalageClusters });
    decalageClusters += tailleCluster;
    groupes = [];
  };
  for (const evenement of evenements) {
    const temps = Math.round(evenement.timestamp / 1000);
    const videoKeyframe = evenement.track === 1 && evenement.type === 'key';
    if (videoKeyframe && groupes.length > 0 && temps - dernierKeyframe >= 10_000) {
      finaliserCluster();
      base = temps;
    }
    if (videoKeyframe) dernierKeyframe = temps;
    if (temps - base < -32768 || temps - base > 32767) {
      throw new RangeError('Les paquets WebM sont trop espacés pour un décalage de cluster valide.');
    }
    groupes.push(blocSimple(evenement.track, temps - base, evenement.track === 2 || videoKeyframe, donneesOuDescripteur(evenement)));
  }
  finaliserCluster();

  let seekHead = construireSeekHead({ info: 0, tracks: 0, cues: 0 });
  let cues = element('1c53bb6b', new Uint8Array());
  let longueurCues = -1;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    cues = element('1c53bb6b', concatener(...reperes.map((repere) => element('bb', concatener(
      element('b3', entierMinimal(repere.time)),
      element('b7', concatener(
        element('f7', entier(1)),
        element('f1', entierMinimal(seekHead.length + info.length + tracks.length + repere.position)),
      )),
    )))));
    const positions = {
      info: seekHead.length,
      tracks: seekHead.length + info.length,
      cues: seekHead.length + info.length + tracks.length + decalageClusters,
    };
    const suivant = construireSeekHead(positions);
    if (suivant.length === seekHead.length && cues.length === longueurCues) {
      seekHead = suivant;
      break;
    }
    seekHead = suivant;
    longueurCues = cues.length;
    if (iteration === 7) throw new Error('Impossible de stabiliser les offsets du SeekHead WebM.');
  }
  cues = element('1c53bb6b', concatener(...reperes.map((repere) => element('bb', concatener(
    element('b3', entierMinimal(repere.time)),
    element('b7', concatener(
      element('f7', entier(1)),
      element('f1', entierMinimal(seekHead.length + info.length + tracks.length + repere.position)),
    )),
  )))));
  seekHead = construireSeekHead({
    info: seekHead.length,
    tracks: seekHead.length + info.length,
    cues: seekHead.length + info.length + tracks.length + decalageClusters,
  });
  const ebml = element('1a45dfa3', concatener(
    element('4286', entier(1)),
    element('42f7', entier(1)),
    element('42f2', entier(4)),
    element('42f3', entier(8)),
    element('4282', texte('webm')),
    element('4287', entier(4)),
    element('4285', entier(2)),
  ));
  const partiesSegment = [seekHead, info, tracks, ...blocs.flat(), cues];
  const tailleSegment = partiesSegment.reduce((somme, partie) => somme + longueurPartie(partie), 0);
  return [ebml, Uint8Array.from([0x18, 0x53, 0x80, 0x67]), encoderTaille(tailleSegment), ...partiesSegment];
}

export function construireWebM(options) {
  const parties = construireFluxWebM(options);
  if (parties.some(estDiffere)) throw new TypeError('Des paquets stockés hors mémoire exigent construireFluxWebM.');
  return concatener(...parties);
}
