# Essai Cloudflare — mesures (25/11/2026)

Même parcours sur les deux API, depuis le même poste (France), 20 appels par série, jeu de démonstration (faux
adhérents), mesure côté client (`node outils/mesurer.js <url> <téléphone> 20`) :

| | Apps Script + Google Sheets (actuel) | Worker + D1 (essai) | Rapport |
|---|---|---|---|
| Connexion | 5 090 ms | 291 ms | ×17 |
| Calendrier, médiane | 1 169 ms | **69 ms** | ×17 |
| Calendrier, 90 % | 1 463 ms | 80 ms | |
| Relecture de la discussion, médiane | 1 210 ms | 49 ms | ×25 |
| Relecture de la discussion, 90 % | 1 381 ms | 61 ms | |

Temps serveur du calendrier sur le Worker (`mesure: true`) : 12 ms, dont le calcul du noyau (0,12 ms en local).

**Critère de réussite** (calendrier < 300 ms en médiane) : atteint.

## Ce qui reste lent, et pourquoi
- Tout ce qui passe par Google : relecture de la liste des adhérents (au plus une fois par heure, ou pour un numéro
  inconnu à la connexion) et envoi d'un mail (une requête qui envoie un mail attend la passerelle, 1 à 2 s).

## Quotas (à suivre dans le tableau de bord Cloudflare, Workers & Pages → Usage)
- Requêtes Worker et Durable Object : quelques milliers par jour prévus, limite 100 000.
- D1 : lignes lues par jour (limite 5 millions) — chaque action ne lit que ses tables ; à surveiller avec l'usage réel.

## Suites possibles
- Publier le site d'essai sur Cloudflare Pages (`site/sorties/config.js` → adresse du Worker) pour un essai complet au
  téléphone.
- Reprise des vraies données (export des onglets du classeur vers D1) si le club adopte cette architecture.
- Notifications sur le téléphone (Web Push), possibles depuis le Worker.
