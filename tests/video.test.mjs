// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DERIVE_VIDEO_MAX, ecartVideo, positionVideo, synchroniserVideo } from '../js/renderer.js';
import { typeMimeVideo } from '../js/media.js';

function fausseVideo({ duration = 10, currentTime = 0, paused = true, seeking = false } = {}) {
  return {
    duration, currentTime, paused, seeking, appelsPlay: 0, appelsPause: 0,
    play() { this.paused = false; this.appelsPlay += 1; return Promise.resolve(); },
    pause() { this.paused = true; this.appelsPause += 1; },
  };
}

test('positionVideo : la vidéo boucle sur sa durée, null si durée inconnue', () => {
  assert.equal(positionVideo(3, 10), 3);
  assert.equal(positionVideo(25, 10), 5);
  assert.equal(positionVideo(3, Number.NaN), null);
  assert.equal(positionVideo(3, Infinity), null);
  assert.equal(positionVideo(-1, 10), null);
});

test('ecartVideo : écart circulaire autour du point de bouclage', () => {
  assert.equal(ecartVideo(1, 4, 10), 3);
  assert.ok(Math.abs(ecartVideo(9.9, 0.1, 10) - 0.2) < 1e-9);
});

test('synchroniserVideo : horloge en marche, lance la lecture sans saut si la dérive est faible', () => {
  const video = fausseVideo({ currentTime: 2.1 });
  assert.equal(synchroniserVideo(video, 2.2, true), false);
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 2.1);
});

test('synchroniserVideo : horloge en marche, repositionne au-delà de la dérive tolérée', () => {
  const video = fausseVideo({ currentTime: 2, paused: false });
  assert.equal(synchroniserVideo(video, 2 + DERIVE_VIDEO_MAX + 0.5, true), true);
  assert.equal(video.currentTime, 2 + DERIVE_VIDEO_MAX + 0.5);
});

test('synchroniserVideo : horloge arrêtée, met en pause sur l’image exacte', () => {
  const video = fausseVideo({ currentTime: 2, paused: false });
  assert.equal(synchroniserVideo(video, 7.25, false), true);
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 7.25);
  assert.equal(synchroniserVideo(video, 7.25, false), false);
});

test('synchroniserVideo : ne repositionne pas pendant un déplacement en cours ni sans durée connue', () => {
  const enCours = fausseVideo({ seeking: true, currentTime: 1 });
  assert.equal(synchroniserVideo(enCours, 8, false), false);
  assert.equal(enCours.currentTime, 1);
  const sansDuree = fausseVideo({ duration: Number.NaN });
  assert.equal(synchroniserVideo(sansDuree, 3, true), false);
  assert.equal(sansDuree.appelsPlay, 0);
});

test('typeMimeVideo : type MIME selon l’extension, vide si inconnue', () => {
  assert.equal(typeMimeVideo('clip.MP4'), 'video/mp4');
  assert.equal(typeMimeVideo('a.b.webm'), 'video/webm');
  assert.equal(typeMimeVideo('x.mov'), 'video/quicktime');
  assert.equal(typeMimeVideo('x.avi'), '');
});
