// Données de l'essai Cloudflare dans D1 : jeu de démonstration complet ou données vierges (faux adhérents seulement,
// comme une nouvelle installation). La liste des adhérents n'est pas écrite : elle vient de la passerelle.
//   PORTEUR_NOM=… PORTEUR_TEL=… PORTEUR_EMAIL=… node outils/cf-donnees.js demo|vierge [--sans-envoi]
// Écrit .wrangler/donnees.sql puis l'exécute sur la base D1 distante (wrangler d1 execute --remote).
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ONGLETS_TOUS, instructionsCreation, nom, colonnes } from '../worker/depot-d1.js';
import { creerDonneesDemo, creerDonneesVierges } from '../backend/noyau/donnees-demo.js';
import { aujourdhuiLocal } from '../site/sorties/js/logique/dates.js';
import { normaliserTelephone } from '../site/sorties/js/logique/telephone.js';

const litteral = (valeur) => `'${JSON.stringify(valeur).replace(/'/g, "''")}'`;

export function sqlDonnees(donnees) {
  const lignes = [...instructionsCreation()];
  for (const o of ONGLETS_TOUS) lignes.push(`DELETE FROM ${nom(o)}`);
  for (const [o, objets] of Object.entries(donnees.tables)) {
    for (const objet of objets) {
      const cols = colonnes(o).filter((c) => objet[c] !== undefined);
      lignes.push(cols.length
        ? `INSERT INTO ${nom(o)} (${cols.map(nom).join(', ')}) VALUES (${cols.map((c) => litteral(objet[c])).join(', ')})`
        : `INSERT INTO ${nom(o)} DEFAULT VALUES`);
    }
  }
  return `${lignes.join(';\n')};\n`;
}

function principal(argv) {
  const mode = argv[2];
  if (!['demo', 'vierge'].includes(mode)) throw new Error('Usage : node outils/cf-donnees.js demo|vierge [--sans-envoi]');
  const porteur = { nom: process.env.PORTEUR_NOM, telephone: normaliserTelephone(process.env.PORTEUR_TEL || ''), email: process.env.PORTEUR_EMAIL };
  if (!porteur.nom || !porteur.telephone || !String(porteur.email).includes('@')) {
    throw new Error('Renseignez PORTEUR_NOM, PORTEUR_TEL et PORTEUR_EMAIL (le porteur doit aussi figurer dans le fichier des adhérents lu par la passerelle).');
  }
  const donnees = mode === 'demo' ? creerDonneesDemo(aujourdhuiLocal(new Date()), porteur) : creerDonneesVierges(porteur);
  mkdirSync('.wrangler', { recursive: true });
  writeFileSync('.wrangler/donnees.sql', sqlDonnees(donnees));
  console.log(`.wrangler/donnees.sql écrit (${mode}).`);
  if (argv.includes('--sans-envoi')) return;
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'resavtt-essai', '--remote', '--file', '.wrangler/donnees.sql', '-c', 'worker/wrangler.toml'], { stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status || 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal(process.argv);
