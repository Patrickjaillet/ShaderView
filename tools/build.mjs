// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Contrôle de publication : enchaîne les vérifications nécessaires avant de pousser le site.
//   1. manifestes à jour (shaders/ et audio/)   2. en-têtes SPDX   3. audit réseau et CSP
//   4. dépendances tierces consignées            5. fichiers de publication GitHub Pages   6. tests
// Usage : node tools/build.mjs [--regenerer] [--sans-tests]
//   --regenerer : régénère les manifestes au lieu de seulement les vérifier.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = fileURLToPath(new URL('..', import.meta.url));

function fichiersDe(dossier, sortie = []) {
  if (!existsSync(dossier)) return sortie;
  for (const nom of readdirSync(dossier)) {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) fichiersDe(chemin, sortie);
    else sortie.push(chemin);
  }
  return sortie;
}

// Chaque fichier de js/vendor/ doit apparaître (par son nom) dans THIRD_PARTY_NOTICES.md.
export function dependancesNonConsignees(racine = RACINE) {
  const avis = readFileSync(join(racine, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  return fichiersDe(join(racine, 'js', 'vendor'))
    .map((chemin) => relative(racine, chemin).split(sep).join('/'))
    .filter((chemin) => !/(^|\/)(LICENSE|COPYING|LICENCE)[^/]*$|(^|\/)\.gitkeep$/i.test(chemin) && !avis.includes(chemin.replace(/^js\/vendor\//, '')));
}

export function fichiersPublicationManquants(racine = RACINE) {
  return ['index.html', '.nojekyll', 'LICENSE', 'COPYING', 'THIRD_PARTY_NOTICES.md', 'README.md',
    'shaders/manifest.json', 'branding/favicon.svg'].filter((f) => !existsSync(join(racine, f)));
}

function lancer(nom, args) {
  const resultat = spawnSync(process.execPath, args, { cwd: RACINE, stdio: 'inherit' });
  return { nom, ok: resultat.status === 0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = new Set(process.argv.slice(2));
  const etapes = [];
  etapes.push(lancer('manifestes', options.has('--regenerer')
    ? ['tools/build-manifest.mjs', '--strict'] : ['tools/build-manifest.mjs', '--check']));
  etapes.push(lancer('en-têtes SPDX', ['tools/check-headers.mjs']));
  etapes.push(lancer('audit réseau', ['tools/audit-reseau.mjs']));

  const nonConsignees = dependancesNonConsignees();
  if (nonConsignees.length > 0) console.error(`Dépendances absentes de THIRD_PARTY_NOTICES.md : ${nonConsignees.join(', ')}`);
  else console.log('Dépendances tierces : toutes consignées.');
  etapes.push({ nom: 'dépendances', ok: nonConsignees.length === 0 });

  const manquants = fichiersPublicationManquants();
  if (manquants.length > 0) console.error(`Fichiers de publication manquants : ${manquants.join(', ')}`);
  else console.log('Fichiers de publication : présents.');
  etapes.push({ nom: 'fichiers de publication', ok: manquants.length === 0 });

  if (!options.has('--sans-tests')) etapes.push(lancer('tests', ['--test', 'tests/*.test.mjs']));

  const echecs = etapes.filter((etape) => !etape.ok);
  if (echecs.length > 0) {
    console.error(`\nÉchec de la vérification : ${echecs.map((e) => e.nom).join(', ')}.`);
    process.exit(1);
  }
  console.log('\nBuild de publication conforme : le dépôt peut être publié.');
}
