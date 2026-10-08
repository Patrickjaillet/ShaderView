// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { creerSpool } from '../js/export/spool.js';
import { ExportVideo, FORMAT_EXPORT } from '../js/export/video.js';
import { construireFluxWebM } from '../js/export/webm.js';
import { construireFluxMP4 } from '../js/export/mp4.js';

// Faux système de fichiers privé : un fichier = un tableau d'octets en mémoire.
function fauxStockage({ sansEcriture = false } = {}) {
  const fichiers = new Map();
  const racine = {
    async getFileHandle(nom, { create } = {}) {
      if (!fichiers.has(nom)) {
        if (!create) throw new Error('absent');
        fichiers.set(nom, []);
      }
      const octets = fichiers.get(nom);
      const handle = {
        async getFile() { return new Blob(octets); },
      };
      if (!sansEcriture) {
        handle.createWritable = async () => ({
          async write(donnees) { octets.push(new Uint8Array(donnees)); },
          async close() {},
          async abort() {},
        });
      }
      return handle;
    },
    async removeEntry(nom) { fichiers.delete(nom); },
  };
  return { fichiers, stockage: { getDirectory: async () => racine } };
}

test('creerSpool : renvoie null sans OPFS ou sans createWritable', async () => {
  assert.equal(await creerSpool({ stockage: undefined }), null);
  const { stockage, fichiers } = fauxStockage({ sansEcriture: true });
  assert.equal(await creerSpool({ stockage }), null);
  assert.equal(fichiers.size, 0, 'le fichier temporaire inutilisable est supprimé');
});

test('creerSpool : relit exactement les octets écrits puis supprime le fichier', async () => {
  const { stockage, fichiers } = fauxStockage();
  const spool = await creerSpool({ stockage });
  const a = spool.ajouter(Uint8Array.of(1, 2, 3));
  const b = spool.ajouter(Uint8Array.of(4, 5));
  assert.deepEqual([a.offset, a.taille, b.offset, b.taille], [0, 3, 3, 2]);
  await spool.terminer();
  assert.deepEqual(Array.from(await b.lire()), [4, 5]);
  assert.deepEqual(Array.from(await a.lire()), [1, 2, 3]);
  await spool.liberer();
  assert.equal(fichiers.size, 0);
});

function chunks(nombre, octet) {
  return Array.from({ length: nombre }, (_, index) => ({
    data: Uint8Array.of(octet, index, index + 1),
    timestamp: index * 500_000,
    duration: 500_000,
    type: index === 0 ? 'key' : 'delta',
  }));
}

async function aplatir(parties) {
  const sortie = [];
  for (const partie of parties) sortie.push(partie instanceof Uint8Array ? partie : await partie.lire());
  return Buffer.concat(sortie);
}

test('construireFluxWebM : des paquets différés donnent les mêmes octets que des paquets en mémoire', async () => {
  const memoire = chunks(3, 0x30);
  const differes = memoire.map((c) => ({ ...c, data: null, taille: c.data.length, lire: async () => c.data }));
  const options = { videoCodec: 'vp9', largeur: 64, hauteur: 64, fps: 2, duree: 1.5 };
  const attendu = await aplatir(construireFluxWebM({ ...options, videoChunks: memoire }));
  const obtenu = await aplatir(construireFluxWebM({ ...options, videoChunks: differes }));
  assert.deepEqual(obtenu, attendu);
});

test('construireFluxMP4 : des paquets différés donnent les mêmes octets que des paquets en mémoire', async () => {
  const memoire = chunks(3, 0x40);
  const differes = memoire.map((c) => ({ ...c, data: null, taille: c.data.length, lire: async () => c.data }));
  const avcC = Uint8Array.of(1, 0x42, 0xe0, 0x1e, 0xff, 0xe1, 0, 4, 0x67, 1, 2, 3, 1, 0, 2, 0x68, 1);
  const options = { codec: 'avc1.42E01E', codecPrivate: avcC, width: 64, height: 64, fps: 2, duration: 1.5 };
  const attendu = await aplatir(construireFluxMP4({ ...options, chunks: memoire }));
  const obtenu = await aplatir(construireFluxMP4({ ...options, chunks: differes }));
  assert.deepEqual(obtenu, attendu);
});

test('exportVideo : l’export avec stockage temporaire est identique à l’export en mémoire', async () => {
  const precedent = { VideoEncoder: globalThis.VideoEncoder, VideoFrame: globalThis.VideoFrame, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.VideoEncoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor({ output }) { this.output = output; }
    configure() {}
    encode(frame) {
      const data = Uint8Array.of(frame.timestamp === 0 ? 0x11 : 0x22, frame.timestamp / 1000 & 0xff);
      this.output({ byteLength: data.length, timestamp: frame.timestamp, duration: frame.duration, type: frame.timestamp === 0 ? 'key' : 'delta', copyTo: (cible) => cible.set(data) });
    }
    async flush() {}
    close() {}
  };
  globalThis.VideoFrame = class { constructor(source, options) { Object.assign(this, options); } close() {} };
  const exporter = async () => {
    const ecrit = [];
    const destination = { write: async (c) => ecrit.push(Buffer.from(c)), close: async () => {} };
    await new ExportVideo({ format: FORMAT_EXPORT.WEBM, largeur: 64, hauteur: 64, fps: 2, duree: 1 })
      .exporterVersDestination(async () => ({}), destination);
    return Buffer.concat(ecrit);
  };
  try {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    const enMemoire = await exporter();
    const { stockage, fichiers } = fauxStockage();
    Object.defineProperty(globalThis, 'navigator', { value: { storage: stockage }, configurable: true });
    const avecSpool = await exporter();
    assert.deepEqual(avecSpool, enMemoire);
    assert.equal(fichiers.size, 0, 'le fichier temporaire est supprimé après l’export');
  } finally {
    globalThis.VideoEncoder = precedent.VideoEncoder;
    globalThis.VideoFrame = precedent.VideoFrame;
    if (precedent.navigator) Object.defineProperty(globalThis, 'navigator', precedent.navigator);
    else delete globalThis.navigator;
  }
});
