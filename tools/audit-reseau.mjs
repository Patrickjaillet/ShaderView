// SPDX-License-Identifier: GPL-3.0-or-later
// ShaderView — © 2026 SANDEFJORD / Patrick JAILLET
// Distribué sous licence GPL-3.0-or-later

// Audit statique de l'absence de requête réseau à l'exécution : API réseau du navigateur, URL absolues chargées
// par le code, ressources externes dans index.html/CSS et politique CSP (default-src 'self').
// Usage : node tools/audit-reseau.mjs   (code de sortie 1 si une anomalie est trouvée)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = fileURLToPath(new URL('..', import.meta.url));

// API réseau interdites partout ; fetch est toléré seulement dans les fichiers listés (lecture de fichiers du site).
const API_INTERDITES = [
  /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/,
  /\bRTCPeerConnection\b/, /\bnavigator\.serviceWorker\b/, /\bimport\s*\(\s*['"`]https?:/,
];
const FETCH_AUTORISE = new Set(['js/catalog.js']);
const URL_ABSOLUE = /(?:(?:src|href)=|url\(|import\s+[^;]*from\s*|fetch\(\s*)['"(]?\s*(?:https?:)?\/\/[^\s'")]+/gi;
const LIENS_AUTORISES = /^https:\/\/patrickjaillet\.github\.io\/shaderview/;

function fichiers(dossier, extensions, sortie = []) {
  for (const nom of readdirSync(dossier)) {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) fichiers(chemin, extensions, sortie);
    else if (extensions.some((ext) => nom.endsWith(ext))) sortie.push(chemin);
  }
  return sortie;
}

export function auditerSource(chemin, contenu) {
  const anomalies = [];
  const lignes = contenu.split('\n');
  lignes.forEach((ligne, index) => {
    const code = ligne.replace(/\/\/.*$/, '');
    for (const motif of API_INTERDITES) {
      if (motif.test(code)) anomalies.push(`${chemin}:${index + 1} API réseau interdite (${motif.source})`);
    }
    if (/\bfetch\s*\(/.test(code) && !FETCH_AUTORISE.has(chemin)) {
      anomalies.push(`${chemin}:${index + 1} fetch() hors des fichiers autorisés`);
    }
    for (const trouve of ligne.matchAll(URL_ABSOLUE)) {
      const url = trouve[0].match(/(?:https?:)?\/\/.*/)[0];
      const estLien = /<a\s[^>]*href/i.test(ligne) && LIENS_AUTORISES.test(url);
      if (!estLien && !url.startsWith('http://www.w3.org/')) anomalies.push(`${chemin}:${index + 1} URL externe : ${url}`);
    }
  });
  return anomalies;
}

export function auditerCsp(html) {
  const meta = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]*)"/i);
  if (!meta) return ['index.html : politique CSP absente'];
  const directives = new Map(meta[1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [nom, ...valeurs] = d.split(/\s+/);
    return [nom, valeurs];
  }));
  const anomalies = [];
  if (directives.get('default-src')?.join(' ') !== "'self'") anomalies.push("CSP : default-src doit valoir 'self'");
  if (directives.get('connect-src')?.join(' ') !== "'self'") anomalies.push("CSP : connect-src doit valoir 'self'");
  for (const [nom, valeurs] of directives) {
    for (const valeur of valeurs) {
      if (/^(https?:|\*|ws:|wss:)/.test(valeur) || valeur === "'unsafe-eval'") anomalies.push(`CSP : ${nom} autorise ${valeur}`);
    }
  }
  return anomalies;
}

export function auditerDepot(racine = RACINE) {
  const anomalies = [];
  const sources = [
    ...fichiers(join(racine, 'js'), ['.js']),
    ...fichiers(join(racine, 'css'), ['.css']),
    join(racine, 'index.html'),
  ];
  for (const chemin of sources) {
    const relatif = relative(racine, chemin).split(sep).join('/');
    anomalies.push(...auditerSource(relatif, readFileSync(chemin, 'utf8')));
  }
  anomalies.push(...auditerCsp(readFileSync(join(racine, 'index.html'), 'utf8')));
  return { fichiers: sources.length, anomalies };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { fichiers: nombre, anomalies } = auditerDepot();
  if (anomalies.length > 0) {
    for (const anomalie of anomalies) console.error(anomalie);
    process.exit(1);
  }
  console.log(`Audit réseau conforme : ${nombre} fichier(s) vérifié(s), CSP restrictive.`);
}
