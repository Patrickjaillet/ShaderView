#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Produit les icônes PNG de l'application (branding/icone-192.png, icone-512.png et icone-maskable-512.png) à partir de
// branding/favicon.svg, en les dessinant dans un navigateur Chromium sans écran. L'icône « maskable » est pleine page sur le fond
// de l'interface, avec le motif réduit pour rester dans la zone de sécurité des masques de lanceur.
// Usage : node tools/generer-icones.mjs [--navigateur CHEMIN]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lancerNavigateur, trouverNavigateur } from './regression-visuelle.mjs';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const FOND = '#0b0f1a';
const ICONES = [
  { fichier: 'icone-192.png', taille: 192, marge: 0 },
  { fichier: 'icone-512.png', taille: 512, marge: 0 },
  { fichier: 'icone-maskable-512.png', taille: 512, marge: 0.18 },
];

async function principal() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--navigateur');
  const svg = readFileSync(join(RACINE, 'branding', 'favicon.svg'), 'utf8');
  const { session, arreter } = await lancerNavigateur(trouverNavigateur(i >= 0 ? args[i + 1] : null), 'about:blank');
  try {
    for (const { fichier, taille, marge } of ICONES) {
      const url = await session.evaluer(`(async () => {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
        await image.decode();
        const canevas = document.createElement('canvas');
        canevas.width = ${taille}; canevas.height = ${taille};
        const ctx = canevas.getContext('2d');
        ${marge > 0 ? `ctx.fillStyle = '${FOND}'; ctx.fillRect(0, 0, ${taille}, ${taille});` : ''}
        const m = ${Math.round(taille * marge)};
        ctx.drawImage(image, m, m, ${taille} - 2 * m, ${taille} - 2 * m);
        return canevas.toDataURL('image/png');
      })()`);
      writeFileSync(join(RACINE, 'branding', fichier), Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
      console.log(`branding/${fichier} (${taille} × ${taille})`);
    }
  } finally {
    await arreter();
  }
  process.exit(0);
}

principal().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
