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

// Shaders ci-dessous destinés au parseur (Phase 2) : liaison des buffers par
// `outputs[].id` / `inputs[].id`, seule référence fiable (le `src` n'est que cosmétique).

export function shaderMonoPasse() {
  return { ver: '0.1', info: { id: 'CCCCCC', name: 'Mono', username: 'u', tags: [] }, renderpass: [passe('image', { outputs: [{ id: 'img0', channel: 0 }] })] };
}

// Buffer A lit sa propre sortie (rétroaction) et le buffer B ; le buffer B ne dépend
// de rien ; l'image lit A. Ordre de rendu attendu : B avant A (A dépend de B, pas de cycle réel).
export function shaderMultipasseAvecGraphe() {
  return {
    ver: '0.1',
    info: { id: 'DDDDDD', name: 'Graphe', username: 'g', tags: [] },
    renderpass: [
      passe('common', { code: '// commun partagé' }),
      passe('buffer', {
        name: 'Buffer A',
        outputs: [{ id: 'bufA', channel: 0 }],
        inputs: [
          { channel: 0, ctype: 'buffer', id: 'bufA', src: '/media/previz/buffer00.png' },
          { channel: 1, ctype: 'buffer', id: 'bufB', src: '/media/previz/buffer01.png' },
        ],
      }),
      passe('buffer', { name: 'Buffer B', outputs: [{ id: 'bufB', channel: 0 }] }),
      passe('sound', { name: 'Sound' }),
      passe('image', {
        outputs: [{ id: 'img0', channel: 0 }],
        inputs: [{ channel: 0, ctype: 'buffer', id: 'bufA', src: '/media/previz/buffer00.png' }],
      }),
    ],
  };
}

// Cycle réel entre deux buffers distincts (A lit B, B lit A) : sans rétroaction, cet
// ordre n'existe pas vraiment, mais le parseur doit le signaler sans lever d'exception.
export function shaderCycleBuffers() {
  return {
    ver: '0.1',
    info: { id: 'EEEEEE', name: 'Cycle', username: 'c', tags: [] },
    renderpass: [
      passe('buffer', {
        name: 'Buffer A',
        outputs: [{ id: 'bufA', channel: 0 }],
        inputs: [{ channel: 0, ctype: 'buffer', id: 'bufB', src: '/media/previz/buffer01.png' }],
      }),
      passe('buffer', {
        name: 'Buffer B',
        outputs: [{ id: 'bufB', channel: 0 }],
        inputs: [{ channel: 0, ctype: 'buffer', id: 'bufA', src: '/media/previz/buffer00.png' }],
      }),
      passe('image', { outputs: [{ id: 'img0', channel: 0 }] }),
    ],
  };
}

export function shaderCubemap() {
  return {
    ver: '0.1',
    info: { id: 'FFFFFF', name: 'Cube', username: 'c', tags: [] },
    renderpass: [
      passe('cubemap', { name: 'Cube A', outputs: [{ id: 'cubeA', channel: 0 }] }),
      passe('image', { inputs: [{ channel: 0, ctype: 'cubemap', id: 'cubeA', src: '/media/previz/cube00.png' }], outputs: [{ id: 'img0', channel: 0 }] }),
    ],
  };
}
