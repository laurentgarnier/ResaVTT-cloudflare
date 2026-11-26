# Appli de sorties du club de VTT : spécifications techniques de l'architecture hybride (Cloudflare + Google)

*26/11/2026. Décrit l'architecture en service sur l'essai : API sur Cloudflare (Worker, D1, KV, Durable Object),
liste des adhérents tenue dans Google Sheets et mails envoyés par Google, via une passerelle Apps Script. Les règles
métier, l'API (actions, paramètres, réponses) et le front sont ceux de
[2026-11-11-inscriptions-specs-techniques.md](2026-11-11-inscriptions-specs-techniques.md) : ce document ne décrit
que ce qui change. Conception d'origine : `docs/superpowers/specs/2026-11-25-essai-cloudflare-design.md` ; mise en
place pas à pas : `docs/ESSAI-CLOUDFLARE.md` ; mesures : `docs/ESSAI-CLOUDFLARE-mesures.md`.*

## 1. Pourquoi une architecture hybride
- **Vitesse** : sur Apps Script, chaque appel coûte 1,2 à 5 s (démarrage du script, ouverture du classeur). Sur le
  Worker, le calendrier répond en 69 ms (médiane), la connexion en 291 ms.
- **Le secrétaire garde son outil** : la liste des adhérents reste un Google Sheet, modifiable comme avant.
- **Les mails partent de Google** (MailApp), comme avant : même expéditeur, pas de service d'envoi à ouvrir.
- **Gratuit** : tout tient dans les offres gratuites de Cloudflare et d'un compte Google.

## 2. Vue d'ensemble

```
 Téléphone / PC (PWA)                       Cloudflare                                   Google
 ───────────────────                        ──────────                                   ──────
 site/sorties (statique) ──POST JSON──▶ Worker « resavtt-essai »
   servi par :                              │  Durable Object VerrouSorties
   - Worker de fichiers                     │  (une requête à la fois,
     « resavtt-essai-site »                 │   liste des adhérents en mémoire)
   - GitHub Pages (démo ResaVTT)            │        │
                                            │        ├── D1 « resavtt-essai » : toutes les données
                                            │        ├── KV « resavtt-essai-traces » : fichiers GPX,
                                            │        │     copie de secours de la liste des adhérents
                                            │        └── passerelle (HTTPS signé) ──────▶ Apps Script autonome
                                            │                                              ├─ lit le Sheet Adhérents
                                            ◀──── POST /tic signé, toutes les heures ──────┤  (ADHERENTS_ID)
                                                                                           └─ envoie les mails (MailApp)
```

| Élément | Où | Rôle |
|---|---|---|
| Site (PWA) | `site/` ; `wrangler.jsonc` (Worker de fichiers `resavtt-essai-site`) ; aussi GitHub Pages pour la démo ResaVTT | Interface, inchangée. `site/sorties/config.js` → `urlApi` = adresse du Worker. |
| Worker API | `worker/index.js`, `worker/wrangler.toml` | Même API que `doPost` d'Apps Script : `POST /` (actions), `POST /tic` (automate), `GET /` (« API Sorties VTT : OK »). |
| Noyau métier | `backend/noyau/` (identique à ResaVTT) | Règles, actions, rappels, purge, statistiques, remorque. Synchrone, sans dépendance à Google ni à Cloudflare. |
| Durable Object | `VerrouSorties` (dans `worker/index.js`) | Sérialise les POST (équivalent du `LockService`) et garde la liste des adhérents en mémoire. |
| D1 | base `resavtt-essai` | Une table par onglet du classeur d'origine. |
| KV | espace `resavtt-essai-traces` | Fichiers GPX (clés `kv:<uuid>`) et copie de la liste des adhérents (clé `adherents`). |
| Passerelle | `passerelle/Passerelle.js`, projet Apps Script autonome | Lecture des adhérents, envoi des mails, déclenchement horaire du tic. |
| Google Sheet Adhérents | fichier désigné par `ADHERENTS_ID` | Source de vérité des adhérents (colonnes `nom, telephone, email, actif, admin`). Pendant l'essai : une copie du fichier du club. |

## 3. Données

### 3.1 D1 (`worker/depot-d1.js`)
- **Une table par onglet** de `backend/noyau/schema.js` (`ONGLETS`) : Jetons, Personnes, Sorties, Inscriptions,
  Discussions, Traces, Regles, RegleSorties, Fermetures, Parametres, Modeles, Envois, Journal, Rappels, Bilan, Remorque.
- Colonnes = en-têtes de l'onglet, en `TEXT`, plus `_rid INTEGER PRIMARY KEY`. Chaque cellule contient la valeur
  **encodée en JSON** (booléens, nombres et textes reviennent à l'identique) ; une colonne vide (`NULL`) se relit `''`,
  comme une cellule vide de Sheets.
- **Schéma automatique** : `assurerSchema` crée les tables manquantes (`CREATE TABLE IF NOT EXISTS`) et ajoute les
  colonnes manquantes au premier appel. Une nouvelle colonne ou un nouvel onglet du noyau n'exige donc aucune
  migration manuelle.
- **Dépôt synchrone** : le noyau attend `lire / ajouter / modifier / supprimer` synchrones. Les tables utiles sont lues
  d'un coup (un lot), le noyau travaille en mémoire (`creerDepotEnregistreur`), ses écritures sont enregistrées puis
  appliquées à D1 **en un seul lot** à la fin (`appliquerChangements`), en visant les lignes par `_rid`.
- **Tables lues par requête** : par défaut toutes sauf Journal et Bilan (`ONGLETS_REQUETE`). Quelques actions
  fréquentes lisent moins (`TABLES_PAR_ACTION` : `discussion_lire`, `trace_lire`) ; `admin_stats` et le tic lisent
  aussi Bilan. Une table oubliée est chargée à la demande, jamais ignorée.

### 3.2 KV
- **Traces GPX** : le contenu remplace le fichier Drive ; `Traces.drive_id` vaut `kv:<uuid>` (les traces de la démo
  restent `demo:<nom>`, lues dans le code). Écrites après le dernier passage réussi, supprimées de même.
- **Liste des adhérents** (clé `adherents`) : copie de secours, réécrite seulement quand la liste change.

### 3.3 Liste des adhérents (`worker/adherents.js`)
- Jamais écrite dans D1. Le Worker la demande à la passerelle (`adherents_lire`), la normalise (numéros
  `normaliserTelephone`, lignes sans nom ou sans numéro écartées) et la garde **en mémoire dans le Durable Object**.
- **Durée de validité : 1 heure.** Un numéro **inconnu** qui tente de se connecter provoque une relecture immédiate
  (au plus une par minute) : un adhérent ajouté au fichier peut se connecter tout de suite.
- **Conséquence** : un changement sur un adhérent déjà connu (passage administrateur, nouvel email, désactivation)
  est vu **au plus 1 heure** après. Le tic relit toujours la liste à la source (`forcer`), pour la purge.
- **Passerelle en panne** : la liste en mémoire, ou à défaut celle de KV, sert même périmée ; sans aucune liste,
  l'API répond `service_indisponible`.

## 4. Exécution d'une requête

### 4.1 Sérialisation
Toutes les requêtes POST passent par **une seule instance** du Durable Object `VerrouSorties`
(`idFromName('principal')`), qui les traite **une par une** dans l'ordre d'arrivée. Le noyau lit puis écrit (essais
d'un code, génération des sorties récurrentes, inscriptions) : deux requêtes ne doivent pas s'entrelacer. C'est
l'équivalent du verrou du script sur Google.

### 4.2 Passes et besoins extérieurs (`worker/contexte.js`)
Le noyau est synchrone, Cloudflare est asynchrone. `executer(env, travail, {onglets, adherents})` rejoue l'action par
**passes** (8 au plus) :
1. la passe construit le contexte du noyau à partir de ce qui est déjà connu et exécute l'action ;
2. quand le noyau a besoin de l'extérieur, le besoin est **noté** (au lieu d'attendre) et la passe s'arrête sans rien
   écrire : table pas encore lue, réponse HTTP (météo, géocodage), contenu d'un GPX dans KV, **envoi d'un mail** ;
3. les besoins sont satisfaits (lecture D1, `fetch`, KV, mail par la passerelle), puis on rejoue sur un état neuf ;
4. la dernière passe, sans besoin, applique ses effets : écritures KV, lot D1, suppressions KV.

Les passes sont **déterministes** : même heure (`maintenant`) et mêmes identifiants (`uuid`) d'une passe à l'autre,
pour qu'un mail envoyé (un code d'accès, par exemple) corresponde à ce qui est finalement enregistré. Un mail qui a
échoué lève une erreur dans le noyau à la passe suivante, qui la traite comme un échec MailApp (nouvel essai au tic
pour les rappels, journal pour les avis de la remorque).

### 4.3 Particularités par rapport à Apps Script
- **Expéditeur des mails** : le nom de l'association (paramètre `nom_appli`).
- **CORS** : `Access-Control-Allow-Origin: *` ; l'appli envoie du JSON en `text/plain` (pas de préflight), comme
  avec Apps Script.
- **`mesure: true`** : la réponse ajoute `mesure: { total_ms, serveur: 'cloudflare' }`.

## 5. Passerelle Apps Script (`passerelle/Passerelle.js`)
Projet **autonome** (rattaché à aucun classeur), déployé en application Web (exécuter en tant que : moi ; accès :
tout le monde). Retrouver le projet : script.google.com → Mes projets, Google Drive (type « Google Apps Script »),
ou `npx @google/clasp open-script` dans le dossier `passerelle`.

| Fonction | Rôle |
|---|---|
| `doPost` → `adherents_lire` | Première feuille du fichier `ADHERENTS_ID`, en-têtes en ligne 1 (`nom, telephone, email, actif, admin`), lignes vides écartées. |
| `doPost` → `mail_envoyer` | `MailApp.sendEmail` (`to, subject, body, name`, `htmlBody` facultatif). |
| `ticHoraire` | `POST <URL_WORKER>/tic`, signé ; déclenché toutes les heures. |
| `installer` | Crée le déclencheur horaire de `ticHoraire` (sans doublon). À exécuter une fois, il demande aussi les autorisations. |
| `doGet` | « Passerelle Sorties VTT : OK ». |

**Propriétés du script** (⚙ Paramètres du projet → Propriétés du script) :

| Propriété | Valeur |
|---|---|
| `SECRET_PASSERELLE` | Secret partagé avec le Worker (64 caractères hexadécimaux). Ne jamais l'afficher ni le partager. |
| `ADHERENTS_ID` | Identifiant complet du Google Sheet des adhérents. |
| `URL_WORKER` | Adresse du Worker. |
| `PORTEUR_EMAIL` | Seul destinataire des mails en mode essai. |
| `MODE_ESSAI` | **Absent ou autre que `non` : mode essai** — tous les mails (codes d'accès compris) partent au seul `PORTEUR_EMAIL`, objet préfixé « [Essai] ». `non` : mails aux vrais destinataires. Lu à chaque envoi, sans redéploiement. |

Portée OAuth : `spreadsheets` complète (la lecture seule ne suffit pas à `openById`), `script.send_mail`,
`script.external_request`, `script.scriptapp`.

## 6. Sécurité des échanges
- **Worker ↔ passerelle** : enveloppe `{ h, s, c }` — `c` contenu JSON, `h` horodatage (ms), `s` HMAC-SHA256
  hexadécimal de `h.c` avec le secret partagé (`worker/crypto.js`, `passerelle-client.js`). Refusée si la signature
  est fausse ou date de plus de **5 minutes** ; comparaison à durée constante. Même mécanisme pour `POST /tic`
  (réponse 401 sinon).
- **Secret** : côté Cloudflare, secret du Worker (`wrangler secret put SECRET_PASSERELLE`) ; une copie locale dans
  `.wrangler/secret-passerelle.txt`, ignorée par git. Côté Google, propriété du script.
- **Appli ↔ Worker** : inchangé (jeton par appareil, hash SHA-256 dans `Jetons`, droits relus à chaque appel, code
  mail pour l'administration et les gestionnaires de la remorque). Aucun numéro de téléphone ne sort de l'API, sauf
  celui du compte connecté.
- Les identifiants D1 et KV de `worker/wrangler.toml` ne sont pas des secrets (inutilisables sans le compte).

## 7. Tâches automatiques
- **Pas de Cron Trigger Cloudflare** : les 5 du compte gratuit sont pris par une autre appli. Le déclencheur horaire
  Apps Script appelle `POST /tic`.
- Le tic relit la liste des adhérents à la source puis exécute `ticNoyau` (récurrences, rappels individuels et
  groupés, annulations, purge, anonymisation de la remorque), avec Bilan chargé. Règles identiques à la spec technique
  d'origine (§7).
- **Vérifier qu'il tourne** : dans le projet Apps Script, menu **Exécutions** (une ligne `ticHoraire` par heure,
  journal « tic : 200 {"ok":true} ») et **Déclencheurs** (un déclencheur horaire). Admin → Messages → « Derniers
  envois » montre les rappels partis.

## 8. Déploiement et outils (`package.json`)

| Commande | Effet |
|---|---|
| `npm test` | Tests (`node --test`) ; D1 simulée par `node:sqlite` (`tests/aides/d1-factice.js`, `cloudflare-factice.js`). |
| `npm run cf:deployer` | Déploie le Worker (`worker/wrangler.toml`). Nécessaire après tout changement du noyau. |
| `npm run cf:site` | Publie le site statique (`wrangler.jsonc`). |
| `npm run cf:demo` / `cf:vierge` | `PORTEUR_NOM=… PORTEUR_TEL=… PORTEUR_EMAIL=…` : remplace toutes les données D1 par le jeu de démonstration complet / une installation neuve. |
| `npm run cf:repartir` | Demande « oui », puis vide tout sauf Parametres, Modeles, Jetons et Personnes, et supprime les GPX de KV. |
| `node outils/mesurer.js <url> <téléphone> [n]` | Mesure les temps de réponse. |
| `cd passerelle && npx @google/clasp push -f` puis `create-deployment -i <id>` | Met à jour la passerelle à la même adresse `/exec`. |

**Deux dépôts** : `ResaVTT` (Apps Script + Sheets, démo GitHub Pages) et `ResaVTT-cloudflare` (ce document). Le noyau
(`backend/noyau`), la logique et le site (`site/sorties`) sont **identiques** : une évolution se fait dans ResaVTT puis
est recopiée aux mêmes chemins, suivie de `npm test` et `npm run cf:deployer`. Seuls diffèrent `site/sorties/config.js`
(adresse de l'API) et, entre deux publications, le numéro de version. La démo ResaVTT sur GitHub Pages utilise elle
aussi le Worker (`urlApi`) ; l'ancien déploiement Apps Script reste en place, son adresse est en commentaire dans
`config.js`.

## 9. Quotas (offres gratuites)

| Service | Limite | Usage attendu (80 adhérents) |
|---|---|---|
| Requêtes Worker | 100 000 / jour | quelques milliers (relecture du calendrier toutes les 30 s écran ouvert) |
| Durable Object | 100 000 requêtes / jour, stockage SQLite | une par POST ; rien n'y est stocké durablement |
| D1 | 5 M lignes lues / jour, 100 000 écrites, 5 Go | un lot de lecture par requête ; à surveiller dans le tableau de bord |
| KV | 100 000 lectures, 1 000 écritures / jour, 1 Go | GPX ; la liste des adhérents n'est réécrite que si elle change |
| Apps Script | 20 000 UrlFetch / jour, 90 min de déclencheurs / jour | 24 tics + relectures de la liste |
| MailApp (compte gratuit) | 100 destinataires / jour | rappels, codes, annulations, remorque |

Suivi : Cloudflare → Workers & Pages → Usage ; Apps Script → Exécutions.

## 10. Limites connues
- Changement sur un adhérent existant vu jusqu'à 1 heure après (§3.3) ; réductible en baissant
  `DUREE_CACHE_ADHERENTS_MS`.
- Une requête qui envoie un mail attend la passerelle (1 à 2 s).
- `POST /tic` répond `ok` même si un traitement du tic a échoué (le détail est au journal) et ne vérifie pas que
  l'action signée est bien `tic`.
- La passerelle ne capture pas les erreurs MailApp : un échec revient au Worker comme une erreur de passerelle.
- Mode essai actif par défaut : penser à `MODE_ESSAI = non` avant un usage réel, après avoir vérifié les adresses
  des Paramètres (liste de diffusion, destinataires WhatsApp, gestionnaires de la remorque).
- Reprise des vraies données (export des onglets du classeur vers D1) : non outillée à ce jour.
