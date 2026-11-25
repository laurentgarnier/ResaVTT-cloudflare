// Environnement Cloudflare imité pour les tests du Worker : D1 (node:sqlite), KV (Map), passerelle Apps Script
// (mails notés, panne simulable), fetch (Open-Meteo, compteur d'appels), horloge fixe.
import { creerD1Factice } from './d1-factice.js';
import { assurerSchema, chargerTables, creerDepotEnregistreur, appliquerChangements, ONGLETS_TOUS } from '../../worker/depot-d1.js';
import { creerDonneesDemo } from '../../backend/noyau/donnees-demo.js';

export const PORTEUR = { nom: 'Porteur', telephone: '+33611111111', email: 'porteur@example.org' };

export function creerKvFactice() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); } };
}

export async function creerEnvFactice({ maintenant = new Date(2026, 10, 12, 20, 0), aujourdhui = '2026-11-12', donnees } = {}) {
  const DB = creerD1Factice();
  await assurerSchema(DB);
  const d = donnees || creerDonneesDemo(aujourdhui, PORTEUR);
  const depot = creerDepotEnregistreur(await chargerTables(DB, ONGLETS_TOUS));
  for (const [onglet, lignes] of Object.entries(d.tables)) depot.ajouter(onglet, lignes);
  await appliquerChangements(DB, depot.changements());
  const mails = [];
  const appels = [];
  const passerelle = { enPanne: false, mails, mail: async (m) => { if (passerelle.enPanne) throw new Error('passerelle injoignable'); mails.push(m); } };
  const horloge = { maintenant };
  return {
    DB,
    TRACES: creerKvFactice(),
    passerelle,
    appels,
    adherents: d.adherents,
    horloge,
    maintenant: () => new Date(horloge.maintenant.getTime()),
    fetchImpl: async (url) => {
      appels.push(String(url));
      return { ok: true, json: async () => ({ results: [{ name: 'Fontainebleau', admin2: 'Seine-et-Marne', latitude: 48.4, longitude: 2.7 }] }) };
    },
  };
}
