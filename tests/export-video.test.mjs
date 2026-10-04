// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ExportVideo,
  FORMAT_EXPORT,
  calculerDeltaTemps,
  calculerTempsVirtuel,
  detecterSupportAudioCodecs,
  detecterSupportWebCodecs,
  nomFichierExport,
} from '../js/export/video.js';
import { construireWebM, construireFluxWebM } from '../js/export/webm.js';
import { construireMP4, construireFluxMP4 } from '../js/export/mp4.js';

function lireBoites(bytes, debut = 0, fin = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boites = [];
  for (let offset = debut; offset + 8 <= fin;) {
    const taille = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (taille < 8 || offset + taille > fin) throw new Error(`Atome ${type} invalide.`);
    boites.push({
      type,
      idHex: Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('hex'),
      debut: offset,
      contenu: offset + 8,
      fin: offset + taille,
    });
    offset += taille;
  }
  return boites;
}

function trouverOctets(bytes, motif) {
  for (let index = 0; index <= bytes.length - motif.length; index += 1) {
    if (motif.every((byte, offset) => bytes[index + offset] === byte)) return index;
  }
  return -1;
}

function lireElementsEbml(bytes, debut = 0, fin = bytes.length) {
  const longueurVint = (offset) => {
    let longueur = 1;
    let masque = 0x80;
    while (longueur <= 8 && (bytes[offset] & masque) === 0) {
      longueur += 1;
      masque >>= 1;
    }
    if (longueur > 8 || offset + longueur > fin) throw new Error('VINT EBML invalide.');
    return longueur;
  };
  const elements = [];
  for (let offset = debut; offset < fin;) {
    const debutElement = offset;
    const longueurId = longueurVint(offset);
    const idHex = Buffer.from(bytes.subarray(offset, offset + longueurId)).toString('hex');
    offset += longueurId;
    const longueurTaille = longueurVint(offset);
    let taille = BigInt(bytes[offset] & (0xff >>> longueurTaille));
    for (let index = 1; index < longueurTaille; index += 1) {
      taille = (taille << 8n) | BigInt(bytes[offset + index]);
    }
    offset += longueurTaille;
    const finElement = offset + Number(taille);
    if (finElement > fin) throw new Error(`Élément EBML ${idHex} tronqué.`);
    elements.push({ idHex, debut: debutElement, contenu: offset, fin: finElement });
    offset = finElement;
  }
  return elements;
}

test('calculerTempsVirtuel : horloge virtuelle déterministe', () => {
  assert.equal(calculerTempsVirtuel(0, 30), 0);
  assert.equal(calculerTempsVirtuel(30, 30), 1);
  assert.equal(calculerTempsVirtuel(45, 30), 1.5);
});

test('calculerDeltaTemps : delta stable par FPS', () => {
  assert.equal(calculerDeltaTemps(30), 1 / 30);
  assert.equal(calculerDeltaTemps(60), 1 / 60);
});

test('nomFichierExport : utilise le titre nettoyé avec repli sûr', () => {
  assert.equal(nomFichierExport('  Étoiles / nuit : #2  ', FORMAT_EXPORT.MP4), 'etoiles-nuit-2.mp4');
  assert.equal(nomFichierExport('🔥', FORMAT_EXPORT.WEBM), 'shader.webm');
  assert.equal(nomFichierExport(null, FORMAT_EXPORT.WEBM), 'shader.webm');
  assert.throws(() => nomFichierExport('titre', 'avi'), /Format d’export invalide/);
});

test('construireWebM : écrit une structure EBML avec piste et cluster vidéo', () => {
  const bytes = construireWebM({
    videoChunks: [{ data: Uint8Array.of(0x10, 0x20), timestamp: 0, duration: 500_000, type: 'key' }],
    videoCodec: 'vp09.00.10.08',
    largeur: 800,
    hauteur: 450,
    fps: 2,
    duree: 0.5,
  });
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
  assert.ok(bytes.some((value, index) => value === 0x1f && bytes[index + 1] === 0x43 && bytes[index + 2] === 0xb6 && bytes[index + 3] === 0x75));
  assert.ok(bytes.some((value, index) => value === 0x1c && bytes[index + 1] === 0x53 && bytes[index + 2] === 0xbb && bytes[index + 3] === 0x6b));
  assert.ok(new TextDecoder().decode(bytes).includes('V_VP9'));
  assert.ok(bytes.includes(0x10));
});

test('construireFluxWebM : fournit les mêmes octets sans concaténer les données des paquets', () => {
  const options = {
    videoChunks: [
      { data: Uint8Array.of(1, 2, 3), timestamp: 0, duration: 500_000, type: 'key' },
      { data: Uint8Array.of(4, 5), timestamp: 500_000, duration: 500_000, type: 'delta' },
    ],
    videoCodec: 'vp09.00.10.08',
    largeur: 64,
    hauteur: 64,
    fps: 2,
    duree: 1,
  };
  const flux = construireFluxWebM(options);
  const bytes = construireWebM(options);
  const concatene = new Uint8Array(flux.reduce((somme, partie) => somme + partie.length, 0));
  let offset = 0;
  for (const partie of flux) {
    concatene.set(partie, offset);
    offset += partie.length;
  }
  assert.deepEqual(concatene, bytes);
  assert.ok(flux.includes(options.videoChunks[0].data));
  assert.ok(flux.includes(options.videoChunks[1].data));
});

test('construireWebM : refuse un codec absent de la table WebM implémentée', () => {
  assert.throws(() => construireWebM({
    videoChunks: [{ data: Uint8Array.of(1), timestamp: 0, type: 'key' }],
    videoCodec: 'avc1.42E01E',
    largeur: 1,
    hauteur: 1,
    fps: 30,
    duree: 1,
  }), /Codec vidéo WebM non pris en charge/);
});

  test('construireWebM : exige la configuration codec AV1 retournée par l’encodeur', () => {
    const options = {
      videoChunks: [{ data: Uint8Array.of(1), timestamp: 0, type: 'key' }],
      videoCodec: 'av01.0.04M.08',
      largeur: 1,
      hauteur: 1,
      fps: 30,
      duree: 1,
    };
    assert.throws(() => construireWebM(options), /configuration av1C/);
    const bytes = construireWebM({ ...options, videoCodecPrivate: Uint8Array.of(0x81, 0x00) });
    assert.ok(bytes.some((value, index) => value === 0x63 && bytes[index + 1] === 0xa2));
  });

  test('construireWebM : ajoute un cue par cluster vidéo indexé', () => {
    const bytes = construireWebM({
      videoChunks: [
        { data: Uint8Array.of(1), timestamp: 0, type: 'key' },
        { data: Uint8Array.of(2), timestamp: 10_000_000, type: 'key' },
      ],
      videoCodec: 'vp09.00.10.08',
      largeur: 64,
      hauteur: 64,
      fps: 1,
      duree: 11,
    });
    const idCluster = [0x1f, 0x43, 0xb6, 0x75];
    const idCue = [0x1c, 0x53, 0xbb, 0x6b];
    const trouver = (id, depart = 0) => {
      for (let i = depart; i <= bytes.length - id.length; i += 1) {
        if (id.every((byte, index) => bytes[i + index] === byte)) return i;
      }
      return -1;
    };
    const premierCluster = trouver(idCluster);
    const secondCluster = trouver(idCluster, premierCluster + 1);
    const cues = trouver(idCue, secondCluster + idCluster.length);
    assert.ok(premierCluster >= 0);
    assert.ok(secondCluster > premierCluster);
    assert.ok(cues > secondCluster);
    assert.equal(bytes.filter((value, index) => value === 0xbb && index >= cues).length, 3);
  });

  test('construireWebM : SeekHead contient des offsets valides vers Info, Tracks et Cues', () => {
    const bytes = construireWebM({
      videoChunks: [
        { data: Uint8Array.of(1), timestamp: 0, duration: 10_000_000, type: 'key' },
        { data: Uint8Array.of(2), timestamp: 10_000_000, duration: 10_000_000, type: 'key' },
      ],
      videoCodec: 'vp09.00.10.08',
      largeur: 64,
      hauteur: 64,
      fps: 1,
      duree: 20,
    });
    const segmentId = trouverOctets(bytes, [0x18, 0x53, 0x80, 0x67]);
    const segmentFirstSizeByte = bytes[segmentId + 4];
    let segmentSizeLength = 1;
    while ((segmentFirstSizeByte & (0x80 >> (segmentSizeLength - 1))) === 0) segmentSizeLength += 1;
    const segmentData = segmentId + 4 + segmentSizeLength;
    const segment = lireElementsEbml(bytes, segmentData);
    const seekHead = segment.find((box) => box.idHex === '114d9b74');
    assert.ok(seekHead);
    const seeks = lireElementsEbml(bytes, seekHead.contenu, seekHead.fin)
      .filter((box) => box.idHex === '4dbb');
    const indexed = new Map();
    for (const seek of seeks) {
      const children = lireElementsEbml(bytes, seek.contenu, seek.fin);
      const id = children.find((box) => box.idHex === '53ab');
      const position = children.find((box) => box.idHex === '53ac');
      assert.ok(id && position);
      const seekId = Buffer.from(bytes.subarray(id.contenu, id.fin)).toString('hex');
      let valeur = 0;
      for (const octet of bytes.subarray(position.contenu, position.fin)) valeur = valeur * 256 + octet;
      indexed.set(seekId, segmentData + valeur);
    }
    for (const id of ['1549a966', '1654ae6b', '1c53bb6b']) {
      const cible = segment.find((box) => box.idHex === id);
      assert.ok(cible);
      assert.equal(indexed.get(id), cible.debut);
    }
    assert.ok(segment.findIndex((box) => box.idHex === '114d9b74') < segment.findIndex((box) => box.idHex === '1549a966'));
  });

  test('construireWebM : refuse les paquets espacés au-delà de la plage temporelle d’un cluster', () => {
    assert.throws(() => construireWebM({
      videoChunks: [{ data: Uint8Array.of(1), timestamp: 0, type: 'key' }, { data: Uint8Array.of(2), timestamp: 40_000_000, type: 'delta' }],
      videoCodec: 'vp09.00.10.08',
      largeur: 64,
      hauteur: 64,
      fps: 1,
      duree: 40,
    }), /trop espacés/);
  });

    test('construireMP4 : assemble ftyp, moov avec avcC et mdat avec les échantillons', () => {
    const bytes = construireMP4({
      chunks: [
        { data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), timestamp: 0, type: 'key' },
        { data: Uint8Array.of(0, 0, 0, 2, 0x41, 0x99), timestamp: 500_000, type: 'delta' },
      ],
      codec: 'avc1.42E01E',
      codecPrivate: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1, 0),
      width: 800,
      height: 450,
      fps: 2,
    });
    const texteFichier = new TextDecoder().decode(bytes);
    assert.equal(texteFichier.slice(4, 8), 'ftyp');
    assert.ok(texteFichier.includes('moov'));
    assert.ok(texteFichier.includes('avc1'));
    assert.ok(texteFichier.includes('avcC'));
    assert.ok(texteFichier.includes('stss'));
    assert.ok(texteFichier.includes('mdat'));
    assert.ok(bytes.includes(0x65));
    assert.ok(bytes.includes(0x41));
  });

  test('construireFluxMP4 : fournit les mêmes octets avec les paquets vidéo référencés directement', () => {
    const options = {
      chunks: [
        { data: Uint8Array.of(0, 0, 0, 2, 0x65, 0x88), timestamp: 0, duration: 500_000, type: 'key' },
        { data: Uint8Array.of(0, 0, 0, 2, 0x41, 0x99), timestamp: 500_000, duration: 500_000, type: 'delta' },
      ],
      codec: 'avc1.42E01E',
      codecPrivate: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1, 0),
      width: 800,
      height: 450,
      fps: 2,
    };
    const flux = construireFluxMP4(options);
    const bytes = construireMP4(options);
    const concatene = new Uint8Array(flux.reduce((somme, partie) => somme + partie.length, 0));
    let offset = 0;
    for (const partie of flux) {
      concatene.set(partie, offset);
      offset += partie.length;
    }
    assert.deepEqual(concatene, bytes);
    assert.ok(flux.includes(options.chunks[0].data));
    assert.ok(flux.includes(options.chunks[1].data));
  });

test('construireMP4 : muxer AAC, décrire les échantillons et placer moov avant mdat', () => {
  const videoData = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88, 0, 0, 0, 2, 0x41, 0x99);
  const audioData = Uint8Array.of(0x11, 0x22, 0x33);
  const bytes = construireMP4({
    chunks: [
      { data: videoData.subarray(0, 6), timestamp: 0, duration: 500_000, type: 'key' },
      { data: videoData.subarray(6), timestamp: 500_000, duration: 500_000, type: 'delta' },
    ],
    codec: 'avc1.42E01E',
    codecPrivate: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1, 0),
    width: 800,
    height: 450,
    fps: 2,
    duration: 0.04,
    audioChunks: [
      { data: audioData.subarray(0, 1), timestamp: 0, duration: 21_333, type: 'key' },
      { data: audioData.subarray(1), timestamp: 21_333, duration: 21_333, type: 'key' },
    ],
    audioCodec: 'mp4a.40.2',
    audioCodecPrivate: Uint8Array.of(0x11, 0x90),
    sampleRate: 48_000,
    channels: 2,
    bitrateAudio: 128_000,
  });
  const top = lireBoites(bytes);
  assert.deepEqual(top.map((box) => box.type), ['ftyp', 'moov', 'mdat']);
  const moov = top[1];
  const mdat = top[2];
  assert.equal(new TextDecoder().decode(bytes.subarray(moov.debut, moov.fin)).includes('esds'), true);
  assert.equal(new TextDecoder().decode(bytes.subarray(moov.debut, moov.fin)).includes('mp4a'), true);
  const tracks = lireBoites(bytes, moov.contenu, moov.fin).filter((box) => box.type === 'trak');
  assert.equal(tracks.length, 2);
  assert.ok(tracks.some((track) => new TextDecoder().decode(bytes.subarray(track.debut, track.fin)).includes('soun')));
  const offsets = [];
  for (let index = 0; index < bytes.length - 16; index += 1) {
    if (new TextDecoder().decode(bytes.subarray(index + 4, index + 8)) === 'stco') {
      offsets.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(index + 16));
    }
  }
  assert.equal(offsets.length, 2);
  assert.equal(offsets[0], mdat.contenu);
  assert.equal(offsets[1], mdat.contenu + videoData.length);
  assert.deepEqual(Array.from(bytes.subarray(offsets[0], offsets[0] + videoData.length)), Array.from(videoData));
  assert.deepEqual(Array.from(bytes.subarray(offsets[1], offsets[1] + audioData.length)), Array.from(audioData));
});

test('construireMP4 : rejette les pistes décalées qui compromettraient la synchronisation', () => {
  assert.throws(() => construireMP4({
    chunks: [{ data: Uint8Array.of(1), timestamp: 0, type: 'key' }],
    codec: 'avc1.42E01E',
    codecPrivate: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1, 0),
    width: 64,
    height: 64,
    fps: 30,
    audioChunks: [{ data: Uint8Array.of(2), timestamp: 1000, duration: 21_333 }],
    audioCodec: 'mp4a.40.2',
    audioCodecPrivate: Uint8Array.of(0x11, 0x90),
    duration: 1,
  }), /doit commencer à zéro/);
});

test('exportVideo : signale l’absence de WebCodecs au lieu de créer une fausse vidéo', async () => {
  const exporteur = new ExportVideo({ format: FORMAT_EXPORT.WEBM, duree: 1, fps: 2 });
  await assert.rejects(
    exporteur.exporter(async ({ iFrame, iTime, iTimeDelta }) => ({ iFrame, iTime, iTimeDelta })),
    /VideoEncoder est indisponible/,
  );
});

test('exportVideo : encode et mux H.264 en MP4 avec la configuration avcC', async () => {
  const saved = { VideoEncoder: globalThis.VideoEncoder, VideoFrame: globalThis.VideoFrame };
  const avcC = Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1, 0);
  let configEncodeur = null;
  let timestampFrame = 0;
  class StubVideoEncoder {
    static async isConfigSupported(config) { return { supported: config.codec === 'avc1.42E01E' }; }
    constructor({ output }) { this.output = output; }
    configure(config) { configEncodeur = config; }
    encode(frame) {
      const data = Uint8Array.of(0, 0, 0, 2, 0x65, 0x88);
      this.output({
        byteLength: data.length,
        timestamp: timestampFrame * 41_667,
        duration: 41_667,
        type: 'key',
        copyTo: (target) => target.set(data),
      }, { decoderConfig: { description: avcC } });
      timestampFrame += 1;
    }
    async flush() {}
    close() {}
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  globalThis.VideoFrame = class VideoFrame {
    constructor(source, options) { this.source = source; Object.assign(this, options); }
    close() {}
  };
  try {
    const exporteur = new ExportVideo({ format: FORMAT_EXPORT.MP4, largeur: 800, hauteur: 450, fps: 24, duree: 1 });
    const blob = await exporteur.exporter(async () => ({ width: 800, height: 450 }));
    assert.deepEqual(configEncodeur.avc, { format: 'avc' });
    assert.equal(blob.type, 'video/mp4');
    const content = new TextDecoder().decode(await blob.arrayBuffer());
    assert.ok(content.includes('hvcC') === false);
    assert.ok(content.includes('avcC'));
    assert.ok(content.includes('stss'));
    assert.ok(content.includes('mdat'));
  } finally {
    globalThis.VideoEncoder = saved.VideoEncoder;
    globalThis.VideoFrame = saved.VideoFrame;
  }
});

test('detecterSupportWebCodecs : retourne les codecs de chaque format', async () => {
  const original = globalThis.VideoEncoder;
  class StubVideoEncoder {
    static async isConfigSupported(config) {
      return { supported: config.codec === 'vp09.00.10.08' || config.codec === 'avc1.42E01E' };
    }
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  try {
    const support = await detecterSupportWebCodecs();
    assert.ok(support.webm.includes('vp09.00.10.08'));
    assert.ok(support.mp4.includes('avc1.42E01E'));
  } finally {
    globalThis.VideoEncoder = original;
  }
});

test('detecterSupportAudioCodecs : détecte les codecs audio supportés', async () => {
  const original = globalThis.AudioEncoder;
  class StubAudioEncoder {
    static async isConfigSupported(config) {
      return { supported: config.codec === 'opus' || config.codec === 'mp4a.40.2' };
    }
  }
  globalThis.AudioEncoder = StubAudioEncoder;
  try {
    const support = await detecterSupportAudioCodecs();
    assert.ok(support.webm.includes('opus'));
    assert.ok(support.mp4.includes('mp4a.40.2'));
  } finally {
    globalThis.AudioEncoder = original;
  }
});

test('exportVideo : exporterAudioSeule normalise un rendu audio synthétique', async () => {
  const exporteur = new ExportVideo({ format: FORMAT_EXPORT.WEBM, fps: 2, duree: 1 });
  const blob = await exporteur.exporterAudioSeule(async () => ({
    left: Float32Array.from([0, 0.25, -0.25, 0.5]),
    right: Float32Array.from([0, -0.25, 0.25, -0.5]),
    sampleRate: 48000,
  }));
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 48_000 * 4);
  const wav = new DataView(await blob.arrayBuffer());
  assert.equal(wav.getUint32(40, true), 48_000 * 4);
});

test('exportVideo : refuse de muxer sans paquets réellement encodés', async () => {
  const exporteur = new ExportVideo({ format: FORMAT_EXPORT.WEBM, fps: 2, duree: 1 });
  await assert.rejects(exporteur.finaliserExport(), /Aucun paquet vidéo encodé/);
});

test('exportVideo : enregistre via le sélecteur de fichier quand il est disponible', async () => {
  const exporteur = new ExportVideo({ format: FORMAT_EXPORT.MP4, fps: 24, duree: 1 });
  const writes = [];
  globalThis.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => ({
      write: async (chunk) => writes.push({ chunk, suggestedName }),
      close: async () => undefined,
    }),
    suggestedName,
  });
  try {
    const blob = new Blob(['ok'], { type: 'video/mp4' });
    const resultat = await exporteur.enregistrerBlob(blob, { suggestedName: 'demo.mp4' });
    assert.equal(resultat.size, blob.size);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].suggestedName, 'demo.mp4');
    assert.ok(writes[0].chunk instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(writes[0].chunk), 'ok');
  } finally {
    delete globalThis.showSaveFilePicker;
  }
});

test('exportVideo : écrit un Blob en flux et rapporte les octets et le temps restant', async () => {
  const exporteur = new ExportVideo({ format: FORMAT_EXPORT.MP4 });
  const originale = {
    showSaveFilePicker: globalThis.showSaveFilePicker,
    BlobStream: Blob.prototype.stream,
  };
  const ecrits = [];
  let ferme = false;
  globalThis.showSaveFilePicker = async ({ suggestedName }) => {
    assert.equal(suggestedName, 'long.mp4');
    return {
      createWritable: async () => ({
        write: async (chunk) => ecrits.push(new Uint8Array(chunk)),
        close: async () => { ferme = true; },
      }),
    };
  };
  const progression = [];
  try {
    const blob = new Blob([new Uint8Array(2_500_000).fill(0x5a)], { type: 'video/mp4' });
    const destination = await exporteur.ouvrirDestination({ suggestedName: 'long.mp4' });
    await exporteur.enregistrerBlob(blob, {
      destination,
      suggestedName: 'long.mp4',
      onProgress: (event) => progression.push(event),
    });
    assert.ok(ecrits.length >= 2);
    assert.equal(ecrits.reduce((somme, chunk) => somme + chunk.length, 0), blob.size);
    assert.equal(ferme, true);
    assert.ok(progression.some((event) => event.etape === 'ecriture' && event.tempsRestant !== null));
    assert.equal(progression.at(-1).progres, 1);
  } finally {
    if (originale.showSaveFilePicker === undefined) delete globalThis.showSaveFilePicker;
    else globalThis.showSaveFilePicker = originale.showSaveFilePicker;
    Blob.prototype.stream = originale.BlobStream;
  }
});

test('exportVideo : annule et abandonne une écriture en flux', async () => {
  const exporteur = new ExportVideo({ format: FORMAT_EXPORT.MP4 });
  const annulation = new AbortController();
  let annuleEcriture = false;
  const destination = {
    write: async () => {
      annulation.abort();
    },
    close: async () => assert.fail('Un flux annulé ne doit pas être fermé comme un succès.'),
    abort: async () => { annuleEcriture = true; },
  };
  await assert.rejects(
    exporteur.enregistrerBlob(new Blob([new Uint8Array(200_000)]), {
      destination,
      signal: annulation.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(annuleEcriture, true);
});

test('exportVideo : mux directement vers le fichier sans Blob final et libère chaque échantillon écrit', async () => {
  const previous = { VideoEncoder: globalThis.VideoEncoder, VideoFrame: globalThis.VideoFrame };
  const samples = [];
  class StubVideoEncoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    encode(frame) {
      const data = Uint8Array.of(frame.timestamp === 0 ? 0x11 : 0x22);
      samples.push(data);
      this.output({
        byteLength: data.length,
        timestamp: frame.timestamp,
        duration: frame.duration,
        type: frame.timestamp === 0 ? 'key' : 'delta',
        copyTo: (target) => target.set(data),
      });
    }
    async flush() {}
    close() {}
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  globalThis.VideoFrame = class VideoFrame {
    constructor(source, options) { this.source = source; Object.assign(this, options); }
    close() {}
  };
  const written = [];
  const progress = [];
  let echantillonsMuxes = [];
  let closed = false;
  const destination = {
    write: async (chunk) => written.push(new Uint8Array(chunk)),
    close: async () => { closed = true; },
    abort: async () => assert.fail('Un export réussi ne doit pas être abandonné.'),
  };
  try {
    const exporter = new ExportVideo({ format: FORMAT_EXPORT.WEBM, largeur: 64, hauteur: 64, fps: 2, duree: 1 });
    const construireParties = exporter._construirePartiesConteneur.bind(exporter);
    exporter._construirePartiesConteneur = () => {
      const parties = construireParties();
      echantillonsMuxes = exporter._fluxVideo.chunks;
      return parties;
    };
    const result = await exporter.exporterVersDestination(
      async ({ frame }) => ({ frame }),
      destination,
      { onProgress: (event) => progress.push(event) },
    );
    assert.deepEqual(result, { format: 'webm', taille: written.reduce((sum, chunk) => sum + chunk.length, 0), duree: 1, fps: 2, audioInclus: false });
    assert.equal(closed, true);
    assert.deepEqual(samples.map((sample) => sample[0]), [0x11, 0x22]);
    assert.ok(echantillonsMuxes.every((sample) => sample.data === null));
    assert.equal(exporter._fluxVideo, null);
    const bytes = new Uint8Array(result.taille);
    let offset = 0;
    for (const chunk of written) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(progress.some((event) => event.etape === 'muxage' && event.progres === 1));
    assert.ok(progress.some((event) => event.etape === 'ecriture' && event.octetsEcrits > 0));
  } finally {
    globalThis.VideoEncoder = previous.VideoEncoder;
    globalThis.VideoFrame = previous.VideoFrame;
  }
});

test('exportVideo : utilise un codec WebCodecs quand il est disponible', async () => {
  const originalVideoEncoder = globalThis.VideoEncoder;
  const originalVideoFrame = globalThis.VideoFrame;
  const chunks = [];
  class StubVideoEncoder {
    static async isConfigSupported(config) {
      return { supported: true };
    }

    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.configured = false;
    }

    configure(config) {
      this.configured = true;
      this.config = config;
    }

    encode(frame) {
      chunks.push(frame);
      if (this.output) {
        const data = Uint8Array.from([0x82, 0x49, 0x83]);
        this.output({
          byteLength: data.length,
          timestamp: (chunks.length - 1) * 500_000,
          duration: 500_000,
          type: 'key',
          copyTo: (target) => target.set(data),
        });

      }
    }

    async flush() {
      return null;
    }

    close() {
      this.closed = true;
    }
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  globalThis.VideoFrame = class VideoFrame {
    constructor(source) {
      this.source = source;
    }
  };

  try {
    const exporteur = new ExportVideo({ format: FORMAT_EXPORT.WEBM, fps: 2, duree: 1 });
    const blob = await exporteur.exporter(async ({ iFrame }) => ({ iFrame, width: 8, height: 8 }));
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'video/webm');
    assert.ok(chunks.length >= 1);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(bytes.includes(0x82));
  } finally {
    globalThis.VideoEncoder = originalVideoEncoder;
    globalThis.VideoFrame = originalVideoFrame;
  }
});

test('exportVideo : expose la progression de rendu et une estimation restante', async () => {
  const originalVideoEncoder = globalThis.VideoEncoder;
  const originalVideoFrame = globalThis.VideoFrame;
  const originalImageBitmap = globalThis.ImageBitmap;
  class StubVideoEncoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    encode(frame) {
      const data = Uint8Array.of(0x31);
      this.output({
        byteLength: data.length,
        timestamp: frame.timestamp,
        duration: 500_000,
        type: 'key',
        copyTo: (target) => target.set(data),
      });
    }
    async flush() {}
    close() {}
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  globalThis.VideoFrame = class VideoFrame {
    constructor(source, options) { this.source = source; Object.assign(this, options); }
    close() {}
  };
  delete globalThis.ImageBitmap;
  const progression = [];
  try {
    const exporteur = new ExportVideo({ format: FORMAT_EXPORT.WEBM, fps: 2, duree: 1 });
    await exporteur.exporter(async () => ({ width: 8, height: 8 }), { onProgress: (event) => progression.push(event) });
    const rendu = progression.filter((event) => event.etape === 'rendu');
    assert.equal(rendu.length, 2);
    assert.equal(rendu[0].total, 2);
    assert.equal(rendu[0].progres, 0.5);
    assert.ok(rendu[0].tempsRestant >= 0);
    assert.equal(rendu[1].tempsRestant, 0);
    assert.ok(progression.some((event) => event.etape === 'encodage-video' && event.tempsRestant !== null));
    assert.equal(progression.at(-1).etape, 'muxage');
    assert.equal(progression.at(-1).progres, 1);
  } finally {
    globalThis.VideoEncoder = originalVideoEncoder;
    globalThis.VideoFrame = originalVideoFrame;
    if (originalImageBitmap === undefined) delete globalThis.ImageBitmap;
    else globalThis.ImageBitmap = originalImageBitmap;
  }
});

test('exportVideo : muxe les paquets Opus et vidéo dans un seul WebM', async () => {
  const saved = {
    VideoEncoder: globalThis.VideoEncoder,
    AudioEncoder: globalThis.AudioEncoder,
    VideoFrame: globalThis.VideoFrame,
    AudioData: globalThis.AudioData,
  };
  const paquet = (stamp, byte) => ({
    byteLength: 1,
    timestamp: stamp,
    duration: 500_000,
    type: 'key',
    copyTo: (target) => { target[0] = byte; },
  });
  class StubVideoEncoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    encode() { this.output(paquet(0, 0x11)); }
    async flush() {}
    close() {}
  }
  class StubAudioEncoder {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    encode(audioData) { this.output(paquet(audioData.timestamp, 0x22)); }
    async flush() {}
    close() {}
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  globalThis.AudioEncoder = StubAudioEncoder;
  globalThis.VideoFrame = class VideoFrame {
    constructor(source) { this.source = source; }
    close() {}
  };
  globalThis.AudioData = class AudioData {
    constructor(options) { Object.assign(this, options); }
    close() {}
  };

  try {
    const exporteur = new ExportVideo({ format: FORMAT_EXPORT.WEBM, fps: 2, duree: 0.5 });
    const resultat = await exporteur.exporterAvecAudio(
      async () => ({ width: 8, height: 8 }),
      async () => ({
        left: Float32Array.of(0, 0.25),
        right: Float32Array.of(0, -0.25),
        sampleRate: 48000,
      }),
    );
    assert.equal(resultat.video.type, 'video/webm');
    assert.equal(resultat.metadata.audioInclus, true);
    const bytes = new Uint8Array(await resultat.video.arrayBuffer());
    assert.ok(new TextDecoder().decode(bytes).includes('A_OPUS'));
    assert.ok(bytes.includes(0x11));
    assert.ok(bytes.includes(0x22));
  } finally {
    globalThis.VideoEncoder = saved.VideoEncoder;
    globalThis.AudioEncoder = saved.AudioEncoder;
    globalThis.VideoFrame = saved.VideoFrame;
    globalThis.AudioData = saved.AudioData;
  }
});

test('exportVideo : encode AAC et mux les deux pistes MP4 synchronisées', async () => {
  const saved = {
    VideoEncoder: globalThis.VideoEncoder,
    AudioEncoder: globalThis.AudioEncoder,
    VideoFrame: globalThis.VideoFrame,
    AudioData: globalThis.AudioData,
  };
  const avcC = Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1, 0);
  const audioSpecificConfig = Uint8Array.of(0x11, 0x90);
  class StubVideoEncoder {
    static async isConfigSupported(config) { return { supported: config.codec === 'avc1.42E01E' }; }
    constructor({ output }) { this.output = output; }
    configure(config) { assert.deepEqual(config.avc, { format: 'avc' }); }
    encode(frame) {
      const data = Uint8Array.of(0, 0, 0, 2, frame.timestamp === 0 ? 0x65 : 0x41, 0x88);
      this.output({
        byteLength: data.length,
        timestamp: frame.timestamp,
        duration: 500_000,
        type: frame.timestamp === 0 ? 'key' : 'delta',
        copyTo: (target) => target.set(data),
      }, { decoderConfig: { description: avcC } });
    }
    async flush() {}
    close() {}
  }
  class StubAudioEncoder {
    static async isConfigSupported(config) { return { supported: config.codec === 'mp4a.40.2' }; }
    constructor({ output }) { this.output = output; }
    configure(config) { assert.equal(config.codec, 'mp4a.40.2'); }
    encode(audioData) {
      const frameCount = Math.ceil(audioData.numberOfFrames / 1024);
      for (let index = 0; index < frameCount; index += 1) {
        const data = Uint8Array.of(0x20 + index);
        this.output({
          byteLength: data.length,
          timestamp: audioData.timestamp + Math.round(index * 1024 * 1_000_000 / audioData.sampleRate),
          duration: Math.round(1024 * 1_000_000 / audioData.sampleRate),
          type: 'key',
          copyTo: (target) => target.set(data),
        }, { decoderConfig: { description: audioSpecificConfig } });
      }
    }
    async flush() {}
    close() {}
  }
  globalThis.VideoEncoder = StubVideoEncoder;
  globalThis.AudioEncoder = StubAudioEncoder;
  globalThis.VideoFrame = class VideoFrame {
    constructor(source, options) { this.source = source; Object.assign(this, options); }
    close() {}
  };
  globalThis.AudioData = class AudioData {
    constructor(options) { Object.assign(this, options); }
    close() {}
  };

  try {
    const exporteur = new ExportVideo({
      format: FORMAT_EXPORT.MP4,
      largeur: 64,
      hauteur: 64,
      fps: 2,
      duree: 0.5,
    });
    const resultat = await exporteur.exporterAvecAudio(
      async ({ frame }) => ({ frame }),
      async () => ({
        left: new Float32Array(24_000),
        right: new Float32Array(24_000),
        sampleRate: 48000,
      }),
    );
    assert.equal(resultat.video.type, 'video/mp4');
    assert.equal(resultat.metadata.audioInclus, true);
    const bytes = new Uint8Array(await resultat.video.arrayBuffer());
    const contenu = new TextDecoder().decode(bytes);
    assert.ok(contenu.includes('avcC'));
    assert.ok(contenu.includes('esds'));
    assert.ok(contenu.includes('mp4a'));
    assert.ok(contenu.includes('soun'));
    const top = lireBoites(bytes);
    assert.deepEqual(top.map((box) => box.type), ['ftyp', 'moov', 'mdat']);
  } finally {
    globalThis.VideoEncoder = saved.VideoEncoder;
    globalThis.AudioEncoder = saved.AudioEncoder;
    globalThis.VideoFrame = saved.VideoFrame;
    globalThis.AudioData = saved.AudioData;
  }
});
