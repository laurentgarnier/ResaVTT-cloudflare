// Mesure, côté client, le temps de réponse d'une API de l'appli (Apps Script ou Worker Cloudflare).
//   node outils/mesurer.js <url> <téléphone> [n=20]
// Se connecte, puis appelle n fois « calendrier » et « discussion_lire » ; affiche médiane, 90 % et extrêmes (ms).
// Le téléphone doit être un numéro du jeu de démonstration (faux adhérent), jamais un vrai numéro.

const [, , url, telephone, nArg] = process.argv;
const n = Number(nArg) || 20;
if (!url || !telephone) {
  console.error('Usage : node outils/mesurer.js <url> <téléphone> [n=20]');
  process.exit(1);
}

async function appeler(corps) {
  const debut = performance.now();
  const rep = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(corps) });
  const r = await rep.json();
  return { ms: performance.now() - debut, r };
}

const centile = (valeurs, p) => valeurs[Math.min(valeurs.length - 1, Math.floor((valeurs.length - 1) * p))];

async function serie(nom, corps) {
  const temps = [];
  for (let i = 0; i < n; i++) {
    const { ms, r } = await appeler(corps);
    if (!r.ok) throw new Error(`${nom} : ${r.erreur} ${r.message || ''}`);
    temps.push(ms);
  }
  temps.sort((a, b) => a - b);
  const f = (v) => `${Math.round(v)} ms`;
  console.log(`${nom.padEnd(16)} médiane ${f(centile(temps, 0.5))} · 90 % ${f(centile(temps, 0.9))} · min ${f(temps[0])} · max ${f(temps[temps.length - 1])}`);
}

const cx = await appeler({ action: 'connexion', telephone });
if (!cx.r.ok) throw new Error(`connexion : ${cx.r.erreur}`);
console.log(`${url.slice(0, 60)}…  (connexion : ${Math.round(cx.ms)} ms, ${n} appels par série)`);
const jeton = cx.r.data.jeton;
const cal = await appeler({ action: 'calendrier', jeton });
const sortie = cal.r.data.jours.flatMap((j) => j.sorties)[0];
await serie('calendrier', { action: 'calendrier', jeton });
if (sortie) await serie('discussion_lire', { action: 'discussion_lire', jeton, sortie_id: sortie.id, avec_inscrits: true });
await appeler({ action: 'deconnexion', jeton });
