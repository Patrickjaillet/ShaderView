// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Shaders synthétiques utilisés par les tests (mono-passe, multipasse, son, formats d'enveloppe).

export const encoder = (texte) => new TextEncoder().encode(texte);

export function passe(type, extra = {}) {
  return { type, name: type, code: `// ${type}\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(0.); }`, inputs: [], outputs: [], ...extra };
}

export function shaderSimple(nom = 'Simple', extraInfo = {}) {
  return { ver: '0.1', info: { id: 'AAAAAA', name: nom, username: 'auteur', description: 'd', tags: ['t1', 't2'], ...extraInfo }, renderpass: [passe('image')] };
}

export function shaderMultipasse() {
  return {
    ver: '0.1',
    info: { id: 'BBBBBB', name: 'Multipasse', username: 'm', tags: [] },
    renderpass: [
      passe('common'),
      passe('buffer', { name: 'Buffer A', inputs: [{ channel: 0, ctype: 'buffer', src: '/media/previz/buffer00.png' }, { channel: 1, ctype: 'texture', src: '/media/a/tex.jpg' }] }),
      passe('sound', { name: 'Sound' }),
      passe('image', { inputs: [{ channel: 0, ctype: 'buffer', src: '/media/previz/buffer00.png' }, { channel: 2, ctype: 'keyboard', src: '/presets/tex00.jpg' }, { channel: 3, ctype: 'music', src: '/media/a/musique.mp3' }] }),
    ],
  };
}
