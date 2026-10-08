// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import { tailleDonnees, donneesOuDescripteur, estDiffere } from './spool.js';

const ECHELLE_TEMPS_MP4 = 1_000_000;

function concatener(...morceaux) {
  const taille = morceaux.reduce((total, morceau) => total + morceau.length, 0);
  const resultat = new Uint8Array(taille);
  let offset = 0;
  for (const morceau of morceaux) {
    resultat.set(morceau, offset);
    offset += morceau.length;
  }
  return resultat;
}

function entier(valeur, longueur) {
  if (!Number.isSafeInteger(valeur) || valeur < 0 || BigInt(valeur) >= (1n << BigInt(longueur * 8))) {
    throw new RangeError(`Valeur MP4 hors limites pour un entier de ${longueur} octets.`);
  }
  const resultat = new Uint8Array(longueur);
  let restant = BigInt(valeur);
  for (let index = longueur - 1; index >= 0; index -= 1) {
    resultat[index] = Number(restant & 0xffn);
    restant >>= 8n;
  }
  return resultat;
}

function entierSigne(valeur, longueur) {
  const limite = 1n << BigInt(longueur * 8);
  const signe = BigInt(valeur);
  if (signe < -(limite >> 1n) || signe >= (limite >> 1n)) {
    throw new RangeError('Valeur signée MP4 hors limites.');
  }
  return entier(Number(signe < 0n ? limite + signe : signe), longueur);
}

function texte(valeur) {
  return new TextEncoder().encode(valeur);
}

function enteteBoite(type, tailleContenu) {
  const taille = tailleContenu + 8;
  if (!Number.isSafeInteger(taille) || taille > 0xffffffff) throw new RangeError(`Atome MP4 ${type} trop volumineux.`);
  return concatener(entier(taille, 4), texte(type));
}

function boite(type, ...contenu) {
  const donnees = concatener(...contenu);
  return concatener(enteteBoite(type, donnees.length), donnees);
}

function fullBox(type, version, flags, ...contenu) {
  return boite(type, Uint8Array.of(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...contenu);
}

function matriceIdentite() {
  return concatener(
    entier(0x00010000, 4), entier(0, 4), entier(0, 4),
    entier(0, 4), entier(0x00010000, 4), entier(0, 4),
    entier(0, 4), entier(0, 4), entier(0x40000000, 4),
  );
}

function dureesCompressees(durees) {
  const groupes = [];
  for (const duree of durees) {
    const precedent = groupes[groupes.length - 1];
    if (precedent && precedent.delta === duree) precedent.compte += 1;
    else groupes.push({ compte: 1, delta: duree });
  }
  return fullBox('stts', 0, 0, entier(groupes.length, 4), ...groupes.flatMap(({ compte, delta }) => [entier(compte, 4), entier(delta, 4)]));
}

function tableEchantillons(samples, offset, sync = false) {
  const stsc = fullBox('stsc', 0, 0, entier(1, 4), entier(1, 4), entier(samples.length, 4), entier(1, 4));
  const stsz = fullBox('stsz', 0, 0, entier(0, 4), entier(samples.length, 4), ...samples.map((sample) => entier(tailleDonnees(sample), 4)));
  const stco = fullBox('stco', 0, 0, entier(1, 4), entier(offset, 4));
  const stss = sync
    ? fullBox('stss', 0, 0, entier(samples.filter((sample) => sample.type === 'key').length, 4),
      ...samples.flatMap((sample, index) => sample.type === 'key' ? [entier(index + 1, 4)] : []))
    : null;
  return { stsc, stsz, stco, stss };
}

function entreeAvc(width, height, avcC) {
  const champs = concatener(
    new Uint8Array(6),
    entier(1, 2),
    entier(0, 2), entier(0, 2),
    entier(0, 4), entier(0, 4), entier(0, 4),
    entier(width, 2), entier(height, 2),
    entier(0x00480000, 4), entier(0x00480000, 4),
    entier(0, 4),
    entier(1, 2),
    new Uint8Array(32),
    entier(0x0018, 2),
    entier(0xffff, 2),
  );
  return boite('avc1', champs, boite('avcC', avcC));
}

function longueurDescriptor(longueur) {
  if (!Number.isSafeInteger(longueur) || longueur < 0 || longueur > 0x0fffffff) {
    throw new RangeError('Descripteur MPEG-4 trop volumineux.');
  }
  const octets = [longueur & 0x7f];
  let restant = Math.floor(longueur / 128);
  while (restant > 0) {
    octets.unshift((restant & 0x7f) | 0x80);
    restant = Math.floor(restant / 128);
  }
  return Uint8Array.from(octets);
}

function descriptorMpeg4(tag, payload) {
  return concatener(Uint8Array.of(tag), longueurDescriptor(payload.length), payload);
}

function entreeAac(audio) {
  const asc = audio.codecPrivate;
  const configurationDecodeur = concatener(
    Uint8Array.of(0x40, 0x15, 0, 0, 0),
    entier(audio.bitrate, 4),
    entier(audio.bitrate, 4),
    descriptorMpeg4(0x05, asc),
  );
  const esDescriptor = concatener(
    entier(1, 2),
    Uint8Array.of(0),
    descriptorMpeg4(0x04, configurationDecodeur),
    descriptorMpeg4(0x06, Uint8Array.of(2)),
  );
  const champs = concatener(
    new Uint8Array(6),
    entier(1, 2),
    entier(0, 2), entier(0, 2),
    entier(0, 4),
    entier(audio.channels, 2),
    entier(16, 2),
    entier(0, 2), entier(0, 2),
    entier(audio.sampleRate * 0x10000, 4),
  );
  return boite('mp4a', champs, fullBox('esds', 0, 0, descriptorMpeg4(0x03, esDescriptor)));
}

function descriptionEchantillon(description) {
  return fullBox('stsd', 0, 0, entier(1, 4), description);
}

function construireStblVideo(video, width, height, avcC, offset) {
  const tables = tableEchantillons(video, offset, true);
  return boite('stbl',
    descriptionEchantillon(entreeAvc(width, height, avcC)),
    dureesCompressees(video.map((sample) => sample.duration)),
    tables.stsc,
    tables.stsz,
    tables.stco,
    tables.stss,
  );
}

function construireStblAudio(audio, offset) {
  const tables = tableEchantillons(audio.samples, offset);
  return boite('stbl',
    descriptionEchantillon(entreeAac(audio)),
    dureesCompressees(audio.samples.map((sample) => sample.duration)),
    tables.stsc,
    tables.stsz,
    tables.stco,
  );
}

function construireDinf() {
  const url = fullBox('url ', 0, 1);
  return boite('dinf', fullBox('dref', 0, 0, entier(1, 4), url));
}

function construireEdts(dureeMovie) {
  const entry = concatener(entier(dureeMovie, 4), entierSigne(0, 4), entier(1, 2), entier(0, 2));
  return boite('edts', fullBox('elst', 0, 0, entier(1, 4), entry));
}

function construireTrak({ id, dureeMovie, dureeMedia, timescale, handler, largeur = 0, hauteur = 0, stbl }) {
  const tkhd = fullBox('tkhd', 0, 7,
    entier(0, 4), entier(0, 4), entier(id, 4), entier(0, 4), entier(dureeMovie, 4),
    new Uint8Array(8),
    entier(0, 2), entier(0, 2), entier(handler === 'soun' ? 0x0100 : 0, 2), entier(0, 2),
    matriceIdentite(),
    entier(largeur * 0x10000, 4), entier(hauteur * 0x10000, 4),
  );
  const mdhd = fullBox('mdhd', 0, 0,
    entier(0, 4), entier(0, 4), entier(timescale, 4), entier(dureeMedia, 4), entier(0x55c4, 2), entier(0, 2),
  );
  const hdlr = fullBox('hdlr', 0, 0, entier(0, 4), texte(handler), new Uint8Array(12), texte(handler === 'soun' ? 'ShaderView Audio\0' : 'ShaderView Video\0'));
  const header = handler === 'soun'
    ? fullBox('smhd', 0, 0, entier(0, 2), entier(0, 2))
    : fullBox('vmhd', 0, 1, entier(0, 2), entier(0, 2), entier(0, 2), entier(0, 2));
  const minf = boite('minf', header, construireDinf(), stbl);
  const mdia = boite('mdia', mdhd, hdlr, minf);
  return boite('trak', tkhd, construireEdts(dureeMovie), mdia);
}

function construireMoov({ video, audio, width, height, avcC, dureeMovie, offsetVideo = 0, offsetAudio = 0 }) {
  const stblVideo = construireStblVideo(video, width, height, avcC, offsetVideo);
  const trakVideo = construireTrak({
    id: 1,
    dureeMovie,
    dureeMedia: video.reduce((somme, sample) => somme + sample.duration, 0),
    timescale: ECHELLE_TEMPS_MP4,
    handler: 'vide',
    largeur: width,
    hauteur: height,
    stbl: stblVideo,
  });
  const morceauxTrak = [trakVideo];
  if (audio !== null) {
    const stblAudio = construireStblAudio(audio, offsetAudio);
    morceauxTrak.push(construireTrak({
      id: 2,
      dureeMovie,
      dureeMedia: audio.samples.reduce((somme, sample) => somme + sample.duration, 0),
      timescale: audio.sampleRate,
      handler: 'soun',
      stbl: stblAudio,
    }));
  }
  const mvhd = fullBox('mvhd', 0, 0,
    entier(0, 4), entier(0, 4), entier(ECHELLE_TEMPS_MP4, 4), entier(dureeMovie, 4),
    entier(0x00010000, 4), entier(0x0100, 2), new Uint8Array(10),
    matriceIdentite(), new Uint8Array(24), entier(audio === null ? 2 : 3, 4),
  );

  return boite('moov', mvhd, ...morceauxTrak);
}

function normaliserEchantillons(chunks, { timescale, dureeParDefaut, nom }) {
  if (!Array.isArray(chunks) || chunks.length === 0) throw new TypeError(`Le flux ${nom} ne contient aucun échantillon encodé.`);
  const tries = [...chunks].sort((a, b) => a.timestamp - b.timestamp);
  const timestamps = tries.map((sample) => Number(sample.timestamp));
  if (timestamps.some((timestamp) => !Number.isFinite(timestamp) || timestamp < 0)) {
    throw new TypeError(`Horodatage invalide dans le flux ${nom}.`);
  }
  if (timestamps[0] !== 0) throw new RangeError(`Le flux ${nom} doit commencer à zéro pour préserver la synchronisation A/V.`);
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] <= timestamps[index - 1]) throw new RangeError(`Horodatages non croissants dans le flux ${nom}.`);
  }
  return tries.map((sample, index) => {
    if (tailleDonnees(sample) === 0) {
      throw new TypeError(`Échantillon vide ou invalide dans le flux ${nom}.`);
    }
    const timeUnits = Math.round(timestamps[index] * timescale / ECHELLE_TEMPS_MP4);
    const nextDelta = index + 1 < timestamps.length
      ? Math.round((timestamps[index + 1] - timestamps[index]) * timescale / ECHELLE_TEMPS_MP4)
      : 0;
    const supplied = Number(sample.duration);
    const suppliedUnits = Number.isFinite(supplied) && supplied > 0
      ? Math.round(supplied * timescale / ECHELLE_TEMPS_MP4)
      : 0;
    if (nextDelta > 0 && suppliedUnits > 0 && Math.abs(nextDelta - suppliedUnits) > 1) {
      throw new RangeError(`Écart temporel irrégulier entre échantillons dans le flux ${nom}.`);
    }
    const duration = nextDelta > 0 ? nextDelta : suppliedUnits > 0 ? suppliedUnits : dureeParDefaut;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 0xffffffff) {
      throw new RangeError(`Durée d’échantillon invalide dans le flux ${nom}.`);
    }
    return { ...sample, timestampUnits: timeUnits, duration };
  });
}

export function construireFluxMP4({
  chunks,
  codec,
  codecPrivate,
  width,
  height,
  fps,
  audioChunks = [],
  audioCodec = null,
  audioCodecPrivate = null,
  sampleRate = 48000,
  channels = 2,
  bitrateAudio = 128_000,
  duration = null,
}) {
  if (codec !== 'avc1.42E01E' && !(typeof codec === 'string' && codec.startsWith('avc1.'))) {
    throw new TypeError(`Codec MP4 non pris en charge : ${codec}.`);
  }
  if (!(codecPrivate instanceof Uint8Array) || codecPrivate.length < 7) {
    throw new TypeError('Le muxage H.264 nécessite la configuration avcC de VideoEncoder.');
  }
  if (![width, height, fps].every((value) => Number.isInteger(value) && value > 0) || width > 0xffff || height > 0xffff) {
    throw new RangeError('Résolution ou cadence MP4 invalide.');
  }
  if (!Array.isArray(chunks) || chunks.length === 0) throw new TypeError('Le muxage MP4 nécessite des images encodées.');
  const video = normaliserEchantillons(chunks, {
    timescale: ECHELLE_TEMPS_MP4,
    dureeParDefaut: Math.round(ECHELLE_TEMPS_MP4 / fps),
    nom: 'vidéo',
  });
  if (video[0].type !== 'key') throw new TypeError('Le premier échantillon vidéo MP4 doit être une image clé.');

  let audio = null;
  if (audioChunks.length > 0) {
    if (audioCodec !== 'mp4a.40.2') throw new TypeError(`Codec audio MP4 non pris en charge : ${audioCodec}.`);
    if (!(audioCodecPrivate instanceof Uint8Array) || audioCodecPrivate.length === 0) {
      throw new TypeError('Le muxage AAC nécessite la configuration AudioSpecificConfig de AudioEncoder.');
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 65535
      || !Number.isInteger(channels) || channels < 1 || channels > 2
      || !Number.isInteger(bitrateAudio) || bitrateAudio < 1) {
      throw new RangeError('Configuration audio AAC invalide.');
    }
    const samples = normaliserEchantillons(audioChunks, {
      timescale: sampleRate,
      dureeParDefaut: 1024,
      nom: 'audio AAC',
    });
    audio = { samples, codecPrivate: audioCodecPrivate, sampleRate, channels, bitrate: bitrateAudio };
  }

  const dureeDemandee = duration === null
    ? video.reduce((somme, sample) => somme + sample.duration, 0)
    : Math.round(Number(duration) * ECHELLE_TEMPS_MP4);
  if (!Number.isSafeInteger(dureeDemandee) || dureeDemandee <= 0 || dureeDemandee > 0xffffffff) {
    throw new RangeError('Durée de la vidéo MP4 invalide ou trop longue.');
  }
  if (video.reduce((somme, sample) => somme + sample.duration, 0) < dureeDemandee) {
    throw new RangeError('Les échantillons vidéo sont plus courts que la durée MP4 demandée.');
  }
  if (audio !== null && audio.samples.reduce((somme, sample) => somme + sample.duration, 0)
    < Math.ceil(dureeDemandee * audio.sampleRate / ECHELLE_TEMPS_MP4)) {
    throw new RangeError('Les échantillons AAC sont plus courts que la durée MP4 demandée.');
  }
  const ftyp = boite('ftyp', texte('isom'), entier(0x200, 4), texte('isomiso2avc1mp41'));
  const tailleVideo = video.reduce((somme, sample) => somme + tailleDonnees(sample), 0);
  const tailleAudio = audio === null ? 0 : audio.samples.reduce((somme, sample) => somme + tailleDonnees(sample), 0);
  const donneesOffset = ftyp.length + 8;
  const moovProvisoire = construireMoov({
    video, audio, width, height, avcC: codecPrivate, dureeMovie: dureeDemandee,
  });
  const offsetVideo = donneesOffset + moovProvisoire.length;
  const offsetAudio = audio === null ? undefined : offsetVideo + tailleVideo;
  const moov = construireMoov({
    video, audio, width, height, avcC: codecPrivate, dureeMovie: dureeDemandee, offsetVideo, offsetAudio,
  });
  if (moov.length !== moovProvisoire.length) throw new Error('La taille de moov a changé pendant le calcul des offsets.');
  return [
    ftyp,
    moov,
    enteteBoite('mdat', tailleVideo + tailleAudio),
    ...video.map(donneesOuDescripteur),
    ...(audio === null ? [] : audio.samples.map(donneesOuDescripteur)),
  ];
}

export function construireMP4(options) {
  const parties = construireFluxMP4(options);
  if (parties.some(estDiffere)) throw new TypeError('Des paquets stockés hors mémoire exigent construireFluxMP4.');
  return concatener(...parties);
}
