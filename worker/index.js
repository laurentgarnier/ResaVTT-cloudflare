// Point d'entrée du Worker : même API que le serveur Apps Script (POST JSON en texte brut, sans préflight CORS).
//   GET  /      → « API Sorties VTT : OK »
//   POST /      → action de l'appli (traiter du noyau)
//   POST /tic   → récurrences, rappels, annulations, purge ; appelé toutes les heures par la passerelle Apps Script,
//                 signé avec le secret partagé (pas de Cron Trigger Cloudflare).
import { traiter } from '../backend/noyau/actions.js';
import { ticNoyau } from '../backend/noyau/automate.js';
import { executer } from './contexte.js';
import { adherentsPourRequete } from './adherents.js';
import { creerPasserelle } from './passerelle-client.js';
import { verifier } from './crypto.js';
import { ONGLETS_REQUETE } from './depot-d1.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
// Statistiques et purge relisent le Bilan ; le Journal n'est jamais relu (seulement complété).
const ONGLETS_BILAN = [...ONGLETS_REQUETE, 'Bilan'];

const json = (objet, status = 200) => new Response(JSON.stringify(objet), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

// Environnement d'exécution : celui de Cloudflare, complété de la passerelle (sauf si un test la fournit).
function environnement(env) {
  if (env.passerelle) return env;
  return { ...env, passerelle: creerPasserelle({ url: env.URL_PASSERELLE, secret: env.SECRET_PASSERELLE, maintenant: env.maintenant }) };
}

async function api(request, env) {
  const debut = Date.now();
  let requete;
  try {
    requete = JSON.parse(await request.text());
    if (!requete || typeof requete !== 'object') throw new Error();
  } catch (e) {
    return json({ ok: false, erreur: 'requete_invalide', message: 'Requête invalide.' });
  }
  let adherents;
  try {
    adherents = await adherentsPourRequete(env, requete);
  } catch (e) {
    if (e.code) return json({ ok: false, erreur: e.code, message: e.message });
    throw e;
  }
  const onglets = requete.action === 'admin_stats' ? ONGLETS_BILAN : ONGLETS_REQUETE;
  const reponse = await executer(env, (ctx) => traiter(requete, ctx), { onglets, adherents });
  if (requete.mesure) reponse.mesure = { total_ms: Date.now() - debut, serveur: 'cloudflare' };
  return json(reponse);
}

async function tic(request, env) {
  let enveloppe = null;
  try { enveloppe = JSON.parse(await request.text()); } catch (e) { enveloppe = null; }
  const maintenant = (env.maintenant ? env.maintenant() : new Date()).getTime();
  const valide = enveloppe && env.SECRET_PASSERELLE
    && await verifier(env.SECRET_PASSERELLE, enveloppe.h, String(enveloppe.c), enveloppe.s, maintenant);
  if (!valide) return json({ ok: false, erreur: 'refuse', message: 'Signature absente ou invalide.' }, 401);
  // Comme sur Google, la purge s'appuie sur la liste fraîche des adhérents (cache seulement si la passerelle échoue).
  const adherents = await adherentsPourRequete(env, { action: 'tic' }, { forcer: true });
  await executer(env, (ctx) => ticNoyau(ctx), { onglets: ONGLETS_BILAN, adherents });
  return json({ ok: true });
}

export default {
  async fetch(request, envCloudflare) {
    const env = environnement(envCloudflare);
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET') return new Response('API Sorties VTT : OK', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
    if (request.method !== 'POST') return json({ ok: false, erreur: 'methode', message: 'Méthode non prise en charge.' }, 405);
    try {
      return pathname === '/tic' ? await tic(request, env) : await api(request, env);
    } catch (e) {
      return json({ ok: false, erreur: 'erreur_interne', message: 'Erreur technique, réessayez.' }, 500);
    }
  },
};
