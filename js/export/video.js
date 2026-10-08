// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import { creerSpool, longueurPartie, resoudrePartie } from './spool.js';
import { construireWebM, construireFluxWebM } from './webm.js';
import { construireMP4, construireFluxMP4 } from './mp4.js';

export const FORMAT_EXPORT = Object.freeze({
  WEBM: 'webm',
  MP4: 'mp4',
});

// Codecs vidéo par format, par niveau croissant : le premier que le navigateur accepte pour la taille et la cadence
// réellement demandées est retenu (_codecVideoPreferentiel), donc le niveau le plus bas suffisant. Un niveau trop bas
// est refusé pour une grande image (H.264 Baseline 3.0 ne dépasse pas environ 720 × 576), d'où les niveaux supérieurs.
export const CODECS_PAR_FORMAT = Object.freeze({
  [FORMAT_EXPORT.WEBM]: ['vp09.00.10.08', 'vp09.00.31.08', 'vp09.00.41.08', 'vp09.00.51.08', 'av01.0.04M.08', 'av01.0.05M.08'],
  [FORMAT_EXPORT.MP4]: ['avc1.42E01E', 'avc1.4D401F', 'avc1.640028', 'avc1.64002A', 'avc1.640032', 'avc1.640034'],
});

export const AUDIO_CODECS_PAR_FORMAT = Object.freeze({
  [FORMAT_EXPORT.WEBM]: ['opus'],
  [FORMAT_EXPORT.MP4]: ['mp4a.40.2'],
});

function copierBufferSource(valeur) {
  if (valeur instanceof ArrayBuffer) return new Uint8Array(valeur.slice(0));
  if (ArrayBuffer.isView(valeur)) {
    return new Uint8Array(valeur.buffer, valeur.byteOffset, valeur.byteLength).slice();
  }
  throw new TypeError('La configuration du codec doit être un BufferSource.');
}

function horlogeHauteResolution() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function progresEstime(etape, fait, total, horlogeDebut, supplement = {}) {
  const quantite = Math.max(1, Number(total) || 1);
  const termine = Math.min(quantite, Math.max(0, Number(fait) || 0));
  const progres = termine / quantite;
  const tempsEcoule = Math.max(0, horlogeHauteResolution() - horlogeDebut);
  return {
    etape,
    fait: termine,
    total: quantite,
    progres,
    tempsEcoule,
    tempsRestant: progres > 0 ? tempsEcoule * (1 - progres) / progres : null,
    ...supplement,
  };
}

function notifier(onProgress, evenement) {
  if (typeof onProgress === 'function') onProgress(evenement);
}

function prochainTour() {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

export function nomFichierExport(titre, format) {
  if (!Object.values(FORMAT_EXPORT).includes(format)) throw new TypeError(`Format d’export invalide : ${format}.`);
  const nom = String(titre ?? '').trim() || 'shader';
  const propre = nom
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${propre || 'shader'}.${format}`;
}

export function calculerTempsVirtuel(frame, fps) {
  const cadence = Number(fps) > 0 ? Number(fps) : 30;
  return Number(frame) / cadence;
}

export function calculerDeltaTemps(fps) {
  const cadence = Number(fps) > 0 ? Number(fps) : 30;
  return 1 / cadence;
}

export async function detecterSupportWebCodecs() {
  const support = { webm: [], mp4: [] };
  const ctor = globalThis.VideoEncoder;
  if (typeof ctor !== 'function') return support;
  const candidats = [...CODECS_PAR_FORMAT[FORMAT_EXPORT.WEBM], ...CODECS_PAR_FORMAT[FORMAT_EXPORT.MP4]];
  for (const codec of candidats) {
    try {
      if (typeof ctor.isConfigSupported === 'function') {
        const resultat = await ctor.isConfigSupported({
          codec,
          width: 800,
          height: 450,
          bitrate: 2_000_000,
          framerate: 30,
          ...(CODECS_PAR_FORMAT.mp4.includes(codec) ? { avc: { format: 'avc' } } : {}),
        });
        if (resultat && resultat.supported) {
          if (CODECS_PAR_FORMAT.webm.includes(codec)) support.webm.push(codec);
          if (CODECS_PAR_FORMAT.mp4.includes(codec)) support.mp4.push(codec);
        }
      }
    } catch {
      // Certains navigateurs exposent l'API sans prendre en charge le codec demandé.
    }
  }
  return support;
}

export async function detecterSupportAudioCodecs({ sampleRate = 48000, bitrate = 128_000 } = {}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || !Number.isInteger(bitrate) || bitrate < 1) {
    throw new RangeError('Les paramètres de détection du codec audio sont invalides.');
  }
  const support = { webm: [], mp4: [] };
  const ctor = globalThis.AudioEncoder;
  if (typeof ctor !== 'function') return support;
  const candidats = [...AUDIO_CODECS_PAR_FORMAT[FORMAT_EXPORT.WEBM], ...AUDIO_CODECS_PAR_FORMAT[FORMAT_EXPORT.MP4]];
  for (const codec of candidats) {
    try {
      if (typeof ctor.isConfigSupported === 'function') {
        const resultat = await ctor.isConfigSupported({
          codec,
          sampleRate,
          numberOfChannels: 2,
          bitrate,
        });
        if (resultat && resultat.supported) {
          if (AUDIO_CODECS_PAR_FORMAT.webm.includes(codec)) support.webm.push(codec);
          if (AUDIO_CODECS_PAR_FORMAT.mp4.includes(codec)) support.mp4.push(codec);
        }
      }
    } catch {
      // Certaines implémentations exposent l'API audio sans prendre en charge le codec demandé.
    }
  }
  return support;
}

export class ExportVideo {
  constructor({
    format = FORMAT_EXPORT.WEBM,
    largeur = 800,
    hauteur = 450,
    fps = 30,
    duree = 5,
    bitrate = 2_000_000,
    bitrateAudio = 128_000,
    debut = 0,
    audio = null,
    audioCodec = null,
  } = {}) {
    this.format = Object.values(FORMAT_EXPORT).includes(format) ? format : FORMAT_EXPORT.WEBM;
    this.largeur = Number(largeur) > 0 ? Number(largeur) : 800;
    this.hauteur = Number(hauteur) > 0 ? Number(hauteur) : 450;
    this.fps = Number(fps) > 0 ? Number(fps) : 30;
    this.duree = Number(duree) > 0 ? Number(duree) : 1;
    this.debut = Number(debut) >= 0 ? Number(debut) : 0;
    this.imageDebut = Math.round(this.debut * this.fps);
    this.bitrate = Number(bitrate) > 0 ? Number(bitrate) : 2_000_000;
    this.bitrateAudio = Number(bitrateAudio) > 0 ? Number(bitrateAudio) : 128_000;
    this.audio = audio ?? null;
    this.audioCodec = audioCodec ?? (this.format === FORMAT_EXPORT.MP4 ? 'mp4a.40.2' : 'opus');
    this._support = null;
    this._fluxVideo = null;
    this._fluxAudio = null;
    this._spool = null;
  }

  async support() {
    if (this._support === null) this._support = await detecterSupportWebCodecs();
    return this._support;
  }

  tempsFrame(frameIndex) {
    return this.debut + calculerTempsVirtuel(frameIndex, this.fps);
  }

  deltaTemps() {
    return calculerDeltaTemps(this.fps);
  }

  async exporter(renderFrame, options = {}) {
    const { onProgress = null, signal = null } = options;
    const total = Math.max(1, Math.ceil(this.duree * this.fps));
    this._fluxAudio = null;
    if (typeof globalThis.VideoEncoder !== 'function') throw new Error('WebCodecs VideoEncoder est indisponible dans ce navigateur.');
    await this._encoderWebCodecs(this._imagesVirtuelles(renderFrame, { total, onProgress, signal }), { onProgress, signal, total });
    await prochainTour();
    notifier(onProgress, { etape: 'muxage', fait: 0, total: 1, progres: 0, tempsEcoule: 0, tempsRestant: null });
    const blob = this.format === FORMAT_EXPORT.MP4 ? this._assemblerMP4() : this._assemblerWebM();
    notifier(onProgress, { etape: 'muxage', fait: 1, total: 1, progres: 1, tempsEcoule: 0, tempsRestant: 0 });
    return blob;
  }

  async exporterVideoSeule(renderFrame, options = {}) {
    return this.exporter(renderFrame, options);
  }

  async exporterAudioSeule(renderAudio, options = {}) {
    const { onProgress = null, signal = null } = options;
    const audioBuffer = await this._genererAudioBuffer(renderAudio, { onProgress, signal });
    if (audioBuffer === null) return null;
    return this._wavBlob(audioBuffer);
  }

  async exporterAvecAudio(renderFrame, renderAudio, options = {}) {
    const { onProgress = null, signal = null } = options;
    const total = Math.max(1, Math.ceil(this.duree * this.fps));
    this._fluxVideo = null;
    this._fluxAudio = null;
    const audioBuffer = await this._genererAudioBuffer(renderAudio, { onProgress, signal, total });
    if (audioBuffer === null) throw new Error('Le rendu audio n’a produit aucun signal à inclure dans la vidéo.');
    if (typeof globalThis.VideoEncoder !== 'function') throw new Error('WebCodecs VideoEncoder est indisponible dans ce navigateur.');
    await this._encoderWebCodecs(this._imagesVirtuelles(renderFrame, { total, onProgress, signal }), { onProgress, signal, total });
    if (typeof globalThis.AudioEncoder !== 'function') {
      throw new Error(`WebCodecs AudioEncoder est indisponible; l’export combiné ${this.format.toUpperCase()} exige un codec audio compatible.`);
    }
    await this._encoderAudio(audioBuffer, { onProgress, signal, allowWavFallback: false });
    await prochainTour();
    notifier(onProgress, { etape: 'muxage', fait: 0, total: 1, progres: 0, tempsEcoule: 0, tempsRestant: null });
    const conteneur = this.format === FORMAT_EXPORT.MP4 ? this._assemblerMP4() : this._assemblerWebM();
    notifier(onProgress, { etape: 'muxage', fait: 1, total: 1, progres: 1, tempsEcoule: 0, tempsRestant: 0 });
    return {
      video: conteneur,
      audio: null,
      metadata: { format: this.format, fps: this.fps, duree: this.duree, audioInclus: this._fluxAudio.chunks.length > 0 },
    };
  }

  async exporterVersDestination(renderFrame, destination, { renderAudio = null, onProgress = null, signal = null } = {}) {
    if (typeof destination?.write !== 'function' || typeof destination?.close !== 'function') {
      throw new TypeError('Le flux de destination ne permet pas d’écrire et de fermer le fichier.');
    }
    const total = Math.max(1, Math.ceil(this.duree * this.fps));
    this._fluxVideo = null;
    this._fluxAudio = null;
    this._spool = await creerSpool();
    try {
      let audioBuffer = null;
      if (typeof renderAudio === 'function' || this.audio !== null) {
        audioBuffer = await this._genererAudioBuffer(renderAudio, { onProgress, signal, total });
        if (audioBuffer === null) throw new Error('Le rendu audio n’a produit aucun signal à inclure dans la vidéo.');
      }
      if (typeof globalThis.VideoEncoder !== 'function') throw new Error('WebCodecs VideoEncoder est indisponible dans ce navigateur.');
      await this._encoderWebCodecs(this._imagesVirtuelles(renderFrame, { total, onProgress, signal }), { onProgress, signal, total });
      if (audioBuffer !== null) {
        if (typeof globalThis.AudioEncoder !== 'function') {
          throw new Error(`WebCodecs AudioEncoder est indisponible; l’export combiné ${this.format.toUpperCase()} exige un codec audio compatible.`);
        }
        await this._encoderAudio(audioBuffer, { onProgress, signal, allowWavFallback: false });
      }
      if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
      if (this._spool !== null) await this._spool.terminer();
      await prochainTour();
      notifier(onProgress, { etape: 'muxage', fait: 0, total: 1, progres: 0, tempsEcoule: 0, tempsRestant: null });
      const parties = this._construirePartiesConteneur();
      const tailleTotale = parties.reduce((somme, partie) => somme + longueurPartie(partie), 0);
      notifier(onProgress, { etape: 'muxage', fait: 1, total: 1, progres: 1, tempsEcoule: 0, tempsRestant: 0 });
      await this._ecrirePartiesEnFlux(parties, tailleTotale, destination, { onProgress, signal });
      return { format: this.format, taille: tailleTotale, duree: this.duree, fps: this.fps, audioInclus: audioBuffer !== null };
    } catch (erreur) {
      if (typeof destination.abort === 'function') {
        try {
          await destination.abort(erreur);
        } catch (erreurAbandon) {
          throw new AggregateError([erreur, erreurAbandon], 'L’export a échoué et le fichier partiel n’a pas pu être abandonné.');
        }
      }
      throw erreur;
    } finally {
      this._fluxVideo = null;
      this._fluxAudio = null;
      const spool = this._spool;
      this._spool = null;
      if (spool !== null) await spool.liberer();
    }
  }

  // Un paquet encodé est confié au stockage temporaire s'il existe (seule sa référence reste en mémoire).
  _paquet(data, timestamp, duration, type) {
    if (this._spool === null) return { data, timestamp, duration, type };
    const { taille, lire } = this._spool.ajouter(data);
    return { data: null, taille, lire, timestamp, duration, type };
  }

  async *_imagesVirtuelles(renderFrame, { total, onProgress = null, signal = null }) {
    const horlogeDebut = globalThis.performance?.now?.() ?? Date.now();
    for (let frame = 0; frame < total; frame += 1) {
      if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
      const resultat = await renderFrame({
        frame,
        iFrame: this.imageDebut + frame,
        iTime: this.tempsFrame(frame),
        iTimeDelta: this.deltaTemps(),
        iFrameRate: this.fps,
        largeur: this.largeur,
        hauteur: this.hauteur,
      });
      if (typeof onProgress === 'function') {
        const tempsEcoule = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - horlogeDebut);
        const progres = (frame + 1) / total;
        onProgress({
          etape: 'rendu',
          frame: frame + 1,
          total,
          progres,
          tempsEcoule,
          tempsRestant: progres > 0 ? tempsEcoule * (1 - progres) / progres : null,
        });
      }
      yield resultat ?? null;
    }
  }

  async _genererAudioBuffer(renderAudio, { onProgress = null, signal = null, total = null } = {}) {
    const dureeCible = Number(this.duree) > 0 ? Number(this.duree) : 1;
    const quantite = total ?? Math.max(1, Math.ceil(dureeCible * this.fps));
    let audioBuffer = null;

    if (typeof renderAudio === 'function') {
      const audioResultat = await renderAudio({
        duree: dureeCible,
        fps: this.fps,
        sampleRate: 48000,
        frames: quantite,
        total,
      }, { signal, onProgress });
      audioBuffer = this._normaliserAudio(audioResultat ?? this.audio ?? null, { sampleRate: 48000, frames: quantite, duree: dureeCible });
    } else if (this.audio !== null) {
      audioBuffer = this._normaliserAudio(this.audio, { sampleRate: 48000, frames: quantite, duree: dureeCible });
    }

    if (typeof onProgress === 'function' && audioBuffer !== null) {
      onProgress({ frame: quantite, total: quantite, progres: 1 });
    }

    return audioBuffer;
  }

  _normaliserAudio(audio, { sampleRate = 48000, frames = 0, duree = 1 } = {}) {
    if (audio === null || audio === undefined) return null;
    const frequence = Number(audio.sampleRate) > 0 ? Number(audio.sampleRate) : Number(sampleRate) || 48000;
    const nombreCible = Math.max(0, Math.round(Math.max(0, Number(duree) || 0) * frequence));
    let obtenirCanal;
    if (typeof audio.getChannelData === 'function') {
      obtenirCanal = (canal) => audio.getChannelData(Math.min(canal, Math.max(0, (audio.numberOfChannels ?? 1) - 1)));
    } else if (audio.left !== undefined) {
      obtenirCanal = (canal) => canal === 1 ? (audio.right ?? audio.left) : audio.left;
    } else if (audio instanceof Float32Array) {
      if (audio.length % 2 !== 0) throw new TypeError('Le buffer audio intercalé doit contenir un nombre pair d’échantillons.');
      obtenirCanal = (canal) => {
        const resultat = new Float32Array(audio.length / 2);
        for (let index = 0; index < resultat.length; index += 1) resultat[index] = audio[index * 2 + canal];
        return resultat;
      };
    } else if (Array.isArray(audio) && audio.length > 0 && Array.isArray(audio[0])) {
      obtenirCanal = (canal) => audio[Math.min(canal, audio.length - 1)];
    } else {
      throw new TypeError('Le rendu audio doit être un AudioBuffer, deux canaux ou un tableau stéréo intercalé.');
    }

    const canaux = [0, 1].map((canal) => {
      const source = obtenirCanal(canal);
      if (!source || typeof source.length !== 'number') throw new TypeError(`Le canal audio ${canal} est invalide.`);
      const sortie = new Float32Array(nombreCible);
      sortie.set(source.subarray ? source.subarray(0, nombreCible) : Array.from(source).slice(0, nombreCible));
      return sortie;
    });
    return {
      sampleRate: frequence,
      numberOfChannels: 2,
      length: nombreCible,
      duration: nombreCible / frequence,
      getChannelData: (canal) => canaux[Math.min(1, Math.max(0, canal))],
    };
  }

  async supportAudio() {
    return detecterSupportAudioCodecs({ bitrate: this.bitrateAudio });
  }

  async finaliserExport({ onProgress = null } = {}) {
    const blob = this.format === FORMAT_EXPORT.MP4 ? this._assemblerMP4() : this._assemblerWebM();
    if (typeof onProgress === 'function') onProgress({ frame: 1, total: 1, progres: 1 });
    return blob;
  }

  _assemblerWebM() {
    if (!this._fluxVideo || this._fluxVideo.chunks.length === 0) {
      throw new Error('Aucun paquet vidéo encodé n’est disponible pour le muxage WebM.');
    }
    const fluxAudio = this._fluxAudio ?? { chunks: [], sampleRate: 48000, channels: 2 };
    const payload = construireWebM({
      videoChunks: this._fluxVideo.chunks,
      videoCodec: this._fluxVideo.codec,
      largeur: this.largeur,
      hauteur: this.hauteur,
      fps: this.fps,
      duree: this.duree,
      videoCodecPrivate: this._fluxVideo.codecPrivate,
      audioChunks: fluxAudio.chunks,
      audioCodec: fluxAudio.codec,
      sampleRate: fluxAudio.sampleRate,
      channels: fluxAudio.channels,
    });
    return new Blob([payload], { type: 'video/webm' });
  }

  _construirePartiesConteneur() {
    if (this.format === FORMAT_EXPORT.MP4) {
      if (!this._fluxVideo || this._fluxVideo.chunks.length === 0) {
        throw new Error('Aucun paquet H.264 encodé n’est disponible pour le muxage MP4.');
      }
      return construireFluxMP4({
        chunks: this._fluxVideo.chunks,
        codec: this._fluxVideo.codec,
        codecPrivate: this._fluxVideo.codecPrivate,
        width: this.largeur,
        height: this.hauteur,
        fps: this.fps,
        duration: this.duree,
        ...(this._fluxAudio === null ? {} : {
          audioChunks: this._fluxAudio.chunks,
          audioCodec: this._fluxAudio.codec,
          audioCodecPrivate: this._fluxAudio.codecPrivate,
          sampleRate: this._fluxAudio.sampleRate,
          channels: this._fluxAudio.channels,
          bitrateAudio: this.bitrateAudio,
        }),
      });
    }
    if (!this._fluxVideo || this._fluxVideo.chunks.length === 0) {
      throw new Error('Aucun paquet vidéo encodé n’est disponible pour le muxage WebM.');
    }
    const fluxAudio = this._fluxAudio ?? { chunks: [], sampleRate: 48000, channels: 2 };
    return construireFluxWebM({
      videoChunks: this._fluxVideo.chunks,
      videoCodec: this._fluxVideo.codec,
      largeur: this.largeur,
      hauteur: this.hauteur,
      fps: this.fps,
      duree: this.duree,
      videoCodecPrivate: this._fluxVideo.codecPrivate,
      audioChunks: fluxAudio.chunks,
      audioCodec: fluxAudio.codec,
      sampleRate: fluxAudio.sampleRate,
      channels: fluxAudio.channels,
    });
  }

  _assemblerMP4() {
    if (!this._fluxVideo || this._fluxVideo.chunks.length === 0) {
      throw new Error('Aucun paquet H.264 encodé n’est disponible pour le muxage MP4.');
    }
    const payload = construireMP4({
      chunks: this._fluxVideo.chunks,
      codec: this._fluxVideo.codec,
      codecPrivate: this._fluxVideo.codecPrivate,
      width: this.largeur,
      height: this.hauteur,
      fps: this.fps,
      duration: this.duree,
      ...(this._fluxAudio === null ? {} : {
        audioChunks: this._fluxAudio.chunks,
        audioCodec: this._fluxAudio.codec,
        audioCodecPrivate: this._fluxAudio.codecPrivate,
        sampleRate: this._fluxAudio.sampleRate,
        channels: this._fluxAudio.channels,
        bitrateAudio: this.bitrateAudio,
      }),
    });
    return new Blob([payload], { type: 'video/mp4' });
  }

  async telecharger(renderFrame, renderAudio = null, options = {}) {
    const { filename = null, onProgress = null, signal = null } = options;
    const resultat = typeof renderAudio === 'function'
      ? await this.exporterAvecAudio(renderFrame, renderAudio, { onProgress, signal })
      : await this.exporter(renderFrame, { onProgress, signal });
    const blob = typeof resultat === 'object' && resultat && 'video' in resultat ? (resultat.video ?? resultat) : resultat;
    const name = filename ?? `shader-${this.format}-${Date.now()}.${this.format}`;
    return this.enregistrerBlob(blob, { suggestedName: name, onProgress });
  }

  async enregistrerBlob(blob, options = {}) {
    const {
      suggestedName = `shader-${Date.now()}.${this.format}`,
      onProgress = null,
      signal = null,
      destination = null,
    } = options;
    if (!this.estValide(blob)) {
      if (destination !== null) await this.abandonnerDestination(destination);
      if (typeof onProgress === 'function') onProgress({ frame: 1, total: 1, progres: 1 });
      return blob;
    }

    const flux = destination ?? await this.ouvrirDestination({ suggestedName });
    if (flux !== null) {
      await this._ecrireBlobEnFlux(blob, flux, { onProgress, signal });
      return blob;
    }

    if (typeof globalThis.URL !== 'undefined' && typeof globalThis.URL.createObjectURL === 'function') {
      const url = globalThis.URL.createObjectURL(blob);
      const ancre = globalThis.document?.createElement?.('a');
      if (ancre) {
        ancre.href = url;
        ancre.download = suggestedName;
        ancre.style.display = 'none';
        globalThis.document.body?.appendChild?.(ancre);
        ancre.click();
        globalThis.document.body?.removeChild?.(ancre);
        globalThis.URL.revokeObjectURL(url);
      }
    }
    if (typeof onProgress === 'function') onProgress({ frame: 1, total: 1, progres: 1 });
    return blob;
  }

  async ouvrirDestination({ suggestedName = `shader-${Date.now()}.${this.format}` } = {}) {
    if (typeof globalThis.showSaveFilePicker !== 'function') return null;
    const handle = await globalThis.showSaveFilePicker({
      suggestedName,
      types: [{
        description: 'Shader export',
        accept: this.format === FORMAT_EXPORT.WEBM
          ? { 'video/webm': ['.webm'] }
          : { 'video/mp4': ['.mp4'] },
      }],
    });
    return handle.createWritable();
  }

  async abandonnerDestination(destination) {
    if (destination !== null && destination !== undefined && typeof destination.abort === 'function') {
      await destination.abort();
    }
  }

  async _ecrireBlobEnFlux(blob, destination, { onProgress = null, signal = null } = {}) {
    if (typeof destination?.write !== 'function' || typeof destination?.close !== 'function') {
      throw new TypeError('Le flux de destination ne permet pas d’écrire et de fermer le fichier.');
    }
    if (typeof blob.stream !== 'function') {
      await this.abandonnerDestination(destination);
      throw new Error('La lecture en flux du Blob est indisponible dans ce navigateur.');
    }
    const lecteur = blob.stream().getReader();
    let ecrit = 0;
    const horlogeDebut = horlogeHauteResolution();
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
        const { done, value } = await lecteur.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) {
          if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
          const morceau = value.subarray(offset, Math.min(value.byteLength, offset + 1024 * 1024));
          await destination.write(morceau);
          ecrit += morceau.byteLength;
          notifier(onProgress, progresEstime('ecriture', ecrit, blob.size, horlogeDebut, { octetsEcrits: ecrit, octetsTotal: blob.size }));
        }
      }
      if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
      await destination.close();
      notifier(onProgress, progresEstime('ecriture', blob.size, blob.size, horlogeDebut, { octetsEcrits: blob.size, octetsTotal: blob.size }));
    } catch (erreur) {
      await lecteur.cancel(erreur);
      if (typeof destination.abort === 'function') await destination.abort(erreur);
      throw erreur;
    } finally {
      lecteur.releaseLock();
    }
  }

  async _ecrirePartiesEnFlux(parties, tailleTotale, destination, { onProgress = null, signal = null } = {}) {
    let ecrit = 0;
    const horlogeDebut = horlogeHauteResolution();
    const sources = new Map();
    for (const echantillon of [...(this._fluxVideo?.chunks ?? []), ...(this._fluxAudio?.chunks ?? [])]) {
      if (!(echantillon.data instanceof Uint8Array)) continue;
      const regroupees = sources.get(echantillon.data) ?? [];
      regroupees.push(echantillon);
      sources.set(echantillon.data, regroupees);
    }
    for (let index = 0; index < parties.length; index += 1) {
      const reference = parties[index];
      if (!(reference instanceof Uint8Array) && !(reference?.differe === true)) {
        throw new TypeError('Le muxeur a produit une partie de fichier invalide.');
      }
      const partie = await resoudrePartie(reference);
      for (let offset = 0; offset < partie.length; offset += 1024 * 1024) {
        if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
        const morceau = partie.subarray(offset, Math.min(partie.length, offset + 1024 * 1024));
        await destination.write(morceau);
        ecrit += morceau.byteLength;
        notifier(onProgress, progresEstime('ecriture', ecrit, tailleTotale, horlogeDebut, { octetsEcrits: ecrit, octetsTotal: tailleTotale }));
      }
      for (const echantillon of sources.get(partie) ?? []) echantillon.data = null;
      sources.delete(partie);
      parties[index] = null;
    }
    if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
    await destination.close();
    notifier(onProgress, progresEstime('ecriture', tailleTotale, tailleTotale, horlogeDebut, { octetsEcrits: tailleTotale, octetsTotal: tailleTotale }));
  }

  estValide(blob) {
    if (!(blob instanceof Blob)) return false;
    return Number(blob.size) > 0;
  }

  async _encoderWebCodecs(images, { signal = null, onProgress = null, total = null } = {}) {
    const codec = await this._codecVideoPreferentiel();
    if (codec === null) {
      const codecs = CODECS_PAR_FORMAT[this.format].join(', ');
      throw new Error(`Aucun codec vidéo ${this.format.toUpperCase()} supporté (${codecs}).`);
    }
    const config = {
      codec,
      width: this.largeur,
      height: this.hauteur,
      bitrate: this.bitrate,
      framerate: this.fps,
      ...(this.format === FORMAT_EXPORT.MP4 ? { avc: { format: 'avc' } } : {}),
    };
    if (typeof globalThis.VideoEncoder.isConfigSupported === 'function') {
      const support = await globalThis.VideoEncoder.isConfigSupported(config);
      if (!support?.supported) throw new Error(`Le codec vidéo ${codec} n’est pas supporté avec cette résolution/cadence.`);
    }
    const chunks = [];
    const nombreImages = Math.max(1, Number(total) || Math.ceil(this.duree * this.fps));
    const debutEncodage = horlogeHauteResolution();
    let erreurEncoder = null;
    let codecPrivate = null;
    const encoder = new globalThis.VideoEncoder({
      output: (chunk, metadata = {}) => {
        const timestamp = Number(chunk.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < 0) {
          erreurEncoder = new Error('VideoEncoder a produit un horodatage invalide.');
          return;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const duration = Number(chunk.duration);
        chunks.push(this._paquet(data, timestamp, Number.isFinite(duration) && duration > 0 ? duration : 0, chunk.type));
        notifier(onProgress, progresEstime('encodage-video', chunks.length, nombreImages, debutEncodage, { paquets: chunks.length }));
        const description = metadata.decoderConfig?.description;
        if (description !== undefined) {
          try {
            codecPrivate = copierBufferSource(description);
          } catch (erreur) {
            erreurEncoder = erreur;
          }
        }
      },
      error: (erreur) => { erreurEncoder = erreur; },
    });
    encoder.configure(config);

    const VideoFrameCtor = globalThis.VideoFrame;
    const ImageBitmapCtor = globalThis.ImageBitmap;
    let index = 0;
    try {
      for await (const source of images) {
        if (signal && signal.aborted) throw new DOMException('Export annulé.', 'AbortError');
        const image = await this._normaliserImage(source, index);
        let frame = null;
        if (typeof VideoFrameCtor === 'function' && image instanceof VideoFrameCtor) frame = image;
        else if (typeof ImageBitmapCtor === 'function' && typeof VideoFrameCtor === 'function' && image instanceof ImageBitmapCtor) {
          frame = new VideoFrameCtor(image, { timestamp: Math.round(index * 1_000_000 / this.fps), duration: Math.round(1_000_000 / this.fps) });
        } else if (image !== null && typeof image === 'object') {
          frame = image;
        }
        if (frame !== null) {
          const intervalleKeyframe = Math.max(1, Math.round(this.fps * 10));
          try {
            encoder.encode(frame, { keyFrame: index === 0 || index % intervalleKeyframe === 0 });
          } finally {
            if (typeof VideoFrameCtor === 'function' && frame instanceof VideoFrameCtor) frame.close?.();
          }
        }
        index += 1;
      }
      await encoder.flush();
      if (erreurEncoder !== null) throw erreurEncoder;
    } catch (erreur) {
      encoder.close();
      throw erreur;
    }
    encoder.close();
    if (index === 0 || chunks.length === 0) throw new Error('VideoEncoder n’a produit aucun paquet vidéo.');
    notifier(onProgress, progresEstime('encodage-video', nombreImages, nombreImages, debutEncodage, { paquets: chunks.length }));
    this._fluxVideo = { codec, chunks, codecPrivate };
    return this._fluxVideo;
  }

  async _codecVideoPreferentiel() {
    const support = CODECS_PAR_FORMAT[this.format] ?? CODECS_PAR_FORMAT[FORMAT_EXPORT.WEBM];
    if (typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoEncoder.isConfigSupported === 'function') {
      for (const codec of support) {
        try {
          const resultat = await globalThis.VideoEncoder.isConfigSupported({
            codec,
            width: this.largeur,
            height: this.hauteur,
            bitrate: this.bitrate,
            framerate: this.fps,
            ...(this.format === FORMAT_EXPORT.MP4 ? { avc: { format: 'avc' } } : {}),
          });
          if (resultat && resultat.supported) {
            return codec;
          }
        } catch {
          // Le codec n'est pas supporté par ce navigateur.
        }
      }
    }
    return null;
  }

  async _encoderAudio(audioBuffer, { signal = null, onProgress = null, allowWavFallback = true } = {}) {
    if (audioBuffer === null || audioBuffer === undefined) return null;

    if (typeof globalThis.AudioEncoder === 'function') {
      const codec = await this._codecAudioPreferentiel(audioBuffer.sampleRate ?? 48000);
      if (codec !== null) {
        const chunks = [];
        const gauche = audioBuffer.getChannelData(0);
        const nombrePaquets = Math.max(1, Math.ceil(gauche.length / 1024));
        const debutEncodage = horlogeHauteResolution();
        let erreurEncoder = null;
        let codecPrivate = null;
        const encoder = new globalThis.AudioEncoder({
          output: (chunk, metadata = {}) => {
            const timestamp = Number(chunk.timestamp);
            if (!Number.isFinite(timestamp) || timestamp < 0) {
              erreurEncoder = new Error('AudioEncoder a produit un horodatage invalide.');
              return;
            }
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const duration = Number(chunk.duration);
            chunks.push(this._paquet(data, timestamp, Number.isFinite(duration) && duration > 0 ? duration : 0, 'key'));
            notifier(onProgress, progresEstime('encodage-audio', chunks.length, nombrePaquets, debutEncodage, { paquets: chunks.length }));
            const description = metadata.decoderConfig?.description;
            if (description !== undefined) {
              try {
                codecPrivate = copierBufferSource(description);
              } catch (erreur) {
                erreurEncoder = erreur;
              }
            }
          },
          error: (erreur) => { erreurEncoder = erreur; },
        });
        const config = {
          codec,
          numberOfChannels: 2,
          sampleRate: audioBuffer.sampleRate ?? 48000,
          bitrate: this.bitrateAudio,
        };
        encoder.configure(config);

        const droite = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : gauche;
        const samples = new Int16Array(gauche.length * 2);
        for (let i = 0; i < gauche.length; i += 1) {
          samples[i * 2] = Math.max(-32768, Math.min(32767, gauche[i] * 32767));
          samples[i * 2 + 1] = Math.max(-32768, Math.min(32767, droite[i] * 32767));
        }
        const AudioDataCtor = globalThis.AudioData;
        if (typeof AudioDataCtor !== 'function') {
          encoder.close();
          throw new Error('WebCodecs AudioData est indisponible dans ce navigateur.');
        }
        const tailleBloc = 4096;
        try {
          for (let debut = 0; debut < gauche.length; debut += tailleBloc) {
            if (signal?.aborted) throw new DOMException('Export annulé.', 'AbortError');
            const nombre = Math.min(tailleBloc, gauche.length - debut);
            const donnees = samples.slice(debut * 2, (debut + nombre) * 2);
            const audioData = new AudioDataCtor({
              format: 's16',
              sampleRate: config.sampleRate,
              numberOfFrames: nombre,
              numberOfChannels: 2,
              timestamp: Math.round(debut * 1_000_000 / config.sampleRate),
              data: new Uint8Array(donnees.buffer),
            });
            encoder.encode(audioData);
            audioData.close?.();
          }
          await encoder.flush();
          if (erreurEncoder !== null) throw erreurEncoder;
        } catch (erreur) {
          encoder.close();
          throw erreur;
        }
        encoder.close();
        if (chunks.length === 0) throw new Error('AudioEncoder n’a produit aucun paquet audio.');
        if (this.format === FORMAT_EXPORT.MP4 && (!(codecPrivate instanceof Uint8Array) || codecPrivate.length === 0)) {
          throw new Error('AudioEncoder AAC n’a pas fourni AudioSpecificConfig pour le muxage MP4.');
        }
        this._fluxAudio = { codec, chunks, codecPrivate, sampleRate: config.sampleRate, channels: 2 };
        notifier(onProgress, progresEstime('encodage-audio', nombrePaquets, nombrePaquets, debutEncodage, { paquets: chunks.length }));
        return;
      }
    }

    if (allowWavFallback) return this._wavBlob(audioBuffer);
    throw new Error('Aucun codec audio WebM supporté (Opus requis pour l’export combiné).');
  }

  async _codecAudioPreferentiel(sampleRate = 48000) {
    const support = AUDIO_CODECS_PAR_FORMAT[this.format] ?? AUDIO_CODECS_PAR_FORMAT[FORMAT_EXPORT.WEBM];
    if (typeof globalThis.AudioEncoder === 'function' && typeof globalThis.AudioEncoder.isConfigSupported === 'function') {
      for (const codec of support) {
        try {
          const resultat = await globalThis.AudioEncoder.isConfigSupported({
            codec,
            sampleRate,
            numberOfChannels: 2,
            bitrate: this.bitrateAudio,
          });
          if (resultat && resultat.supported) {
            return codec;
          }
        } catch {
          // Codec audio non supporté.
        }
      }
    }
    return null;
  }

  _wavBlob(audioBuffer) {
    const gauche = audioBuffer.getChannelData(0);
    const droite = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : gauche;
    const sampleRate = audioBuffer.sampleRate ?? 48000;
    const nbEchantillons = gauche.length;
    const buffer = new ArrayBuffer(44 + nbEchantillons * 4);
    const view = new DataView(buffer);
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i += 1) view.setUint8(offset + i, string.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + nbEchantillons * 4, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, nbEchantillons * 4, true);

    let offset = 44;
    for (let i = 0; i < nbEchantillons; i += 1) {
      view.setInt16(offset, Math.max(-1, Math.min(1, gauche[i])) * 0x7fff, true);
      view.setInt16(offset + 2, Math.max(-1, Math.min(1, droite[i])) * 0x7fff, true);
      offset += 4;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async _normaliserImage(image, index) {
    const VideoFrameCtor = globalThis.VideoFrame;
    const ImageBitmapCtor = globalThis.ImageBitmap;

    if (image === null || image === undefined) {
      if (typeof globalThis.OffscreenCanvas === 'function') {
        const canvas = new globalThis.OffscreenCanvas(this.largeur, this.hauteur);
        const contexte = canvas.getContext('2d');
        if (contexte !== null) {
          contexte.fillStyle = '#000000';
          contexte.fillRect(0, 0, this.largeur, this.hauteur);
          if (typeof VideoFrameCtor === 'function') {
            return new VideoFrameCtor(canvas, { timestamp: Math.round(index * 1_000_000 / this.fps), duration: Math.round(1_000_000 / this.fps) });
          }
        }
      }
      return null;
    }
    if (typeof VideoFrameCtor === 'function' && image instanceof VideoFrameCtor) {
      return new VideoFrameCtor(image, { timestamp: Math.round(index * 1_000_000 / this.fps), duration: Math.round(1_000_000 / this.fps) });
    }
    if (typeof ImageBitmapCtor === 'function' && typeof VideoFrameCtor === 'function' && image instanceof ImageBitmapCtor) {
      return new VideoFrameCtor(image, { timestamp: Math.round(index * 1_000_000 / this.fps), duration: Math.round(1_000_000 / this.fps) });
    }
    if (typeof VideoFrameCtor === 'function' && image !== null && typeof image === 'object') {
      return new VideoFrameCtor(image, { timestamp: Math.round(index * 1_000_000 / this.fps), duration: Math.round(1_000_000 / this.fps) });
    }
    return image;
  }

}

export default ExportVideo;
