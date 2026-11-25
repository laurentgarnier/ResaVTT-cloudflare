# Essai Cloudflare — plan de réalisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** faire tourner l'API de l'appli dans un Cloudflare Worker (données D1, traces KV), la liste des adhérents et les
mails restant chez Google via une passerelle Apps Script, et mesurer le gain de vitesse — sans toucher à l'appli actuelle.

**Architecture:** le noyau métier (`backend/noyau`, `site/sorties/js/logique`) reste inchangé et **synchrone**. Le
Worker charge d'un coup les tables utiles depuis D1, exécute `traiter` sur un dépôt en mémoire qui **enregistre** ses
écritures, puis les applique à D1 en un lot. Ce dont le noyau a besoin à l'extérieur pendant l'exécution (météo,
géocodage, contenu d'un GPX) est noté comme « besoin » : le Worker va le chercher puis **rejoue** la requête sur un état
neuf. Les mails sont mis en file et confiés à la passerelle après l'exécution.

**Tech Stack:** Cloudflare Workers (module ES), D1, KV, Pages ; `wrangler` 4 (par `npx`, outil de développement
seulement) ; Google Apps Script (passerelle, `clasp`) ; Node 22 `node:test` et `node:sqlite` pour les tests.

**Spec:** `docs/superpowers/specs/2026-11-25-essai-cloudflare-design.md`

## Global Constraints
- Offre gratuite uniquement : pas de R2, **pas de Cron Trigger Cloudflare** (les 5 du compte sont pris) ; le tic est
  appelé par la passerelle Apps Script.
- Noyau, site et tests existants inchangés, sauf `site/sorties/config.js` (adresse de l'API) ; `npm test` reste vert.
- Aucune dépendance d'exécution ajoutée ; `wrangler` et `clasp` passent par `npx`.
- Le secret partagé ne figure ni dans le dépôt ni dans le site (`wrangler secret`, propriétés du script).
- Pendant l'essai, la passerelle n'envoie de mail **qu'à l'adresse du porteur** (propriété `PORTEUR_EMAIL`), quels que
  soient les destinataires demandés.
- Jamais de numéro de téléphone ni d'adresse mail réels dans le dépôt.
- Chaque création ou publication chez Cloudflare, Google ou GitHub attend l'accord de Laurent.
- Commentaires et messages en français, comme le reste du projet.

## Review Focus
1. **Deux inscriptions simultanées** sur la même sortie (deux requêtes lisent avant d'écrire) : les deux restent
   enregistrées, aucune n'écrase l'autre → test de la tâche 3.
2. **Passerelle injoignable** : la connexion d'un numéro inconnu du cache répond une erreur claire
   (`service_indisponible`), les autres actions marchent avec la liste en cache → test de la tâche 5.
3. **Échec d'envoi d'un mail** après la réponse : une ligne `Journal` (`envoi`) le signale, la requête ne tombe pas →
   test de la tâche 4.
4. **Champs inconnus** dans une ligne écrite par le noyau (`_rid` renvoyé par le site, colonne absente du schéma) :
   ignorés, jamais d'erreur SQL → test de la tâche 3.
5. **Appel du tic non signé, signature fausse ou de plus de 5 minutes** : refusé (401), rien n'est exécuté → test de la
   tâche 6.

---

### Task 1: Dépôt d'essai prêt (CI sans GitHub Pages)

**Files:**
- Modify: `.github/workflows/pages.yml` → renommer en `.github/workflows/tests.yml` (tests seulement, sur toute branche)
- Modify: `README.md` (en tête : « Essai Cloudflare de l'appli des sorties ; l'appli en service est dans ResaVTT »)
- Modify: `.gitignore` (ajouter `.wrangler/`, `passerelle/.clasp.json`)

- [ ] **Step 1:** workflow `tests.yml` : `on: [push, pull_request]`, une tâche `npm test` (Node 22), plus aucune étape Pages.
- [ ] **Step 2:** `npm test` → Expected: tout passe (même nombre qu'au départ).
- [ ] **Step 3: Commit** `chore: dépôt d'essai Cloudflare (tests seuls en CI, pas de GitHub Pages)`

### Task 2: Empreinte SHA-256 synchrone et signature HMAC

**Files:**
- Create: `worker/crypto.js`
- Test: `tests/worker-crypto.test.js`

**Interfaces:**
- Produces: `sha256Hex(texte: string): string` (synchrone, UTF-8) ; `async signer(secret: string, horodatage: number, corps: string): Promise<string>` (HMAC-SHA256 de `${horodatage}.${corps}`, hexadécimal, via `crypto.subtle`) ; `async verifier(secret, horodatage, corps, signature, maintenant = Date.now()): Promise<boolean>` (faux si signature différente ou `|maintenant − horodatage| > 300 000` ms).

- [ ] **Step 1: tests** — `sha256Hex` égale `createHash('sha256')` de Node pour `''`, `'abc'`, `'é🚵'` et 1 Mo de texte ; `signer` égale `createHmac('sha256')` de Node ; `verifier` vrai pour une bonne signature, faux pour une signature modifiée, un autre secret, un horodatage à +301 s et à −301 s.
- [ ] **Step 2:** `node --test tests/worker-crypto.test.js` → Expected: FAIL (module absent).
- [ ] **Step 3:** implémenter (`sha256Hex` : SHA-256 en JavaScript pur sur `TextEncoder`, car le noyau appelle `hacher` de façon synchrone).
- [ ] **Step 4:** même commande → Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): SHA-256 synchrone et signature HMAC`

### Task 3: Dépôt D1 (lecture groupée, écritures enregistrées puis appliquées)

**Files:**
- Create: `worker/depot-d1.js`
- Create: `tests/aides/d1-factice.js` (D1 imité sur `node:sqlite` en mémoire : `prepare(sql).bind(...).all()/run()`, `batch([...])`)
- Test: `tests/worker-depot.test.js`

**Interfaces:**
- Consumes: `ONGLETS` (`backend/noyau/schema.js`).
- Produces:
  - `async assurerSchema(db): Promise<void>` — une table par onglet, colonnes = `ONGLETS[onglet]` en `TEXT` + `_rid INTEGER PRIMARY KEY` ; ajoute les colonnes manquantes d'une table existante ; mémorisé par instance du Worker.
  - `async chargerTables(db, onglets: string[]): Promise<Record<string, object[]>>` — un seul `db.batch`, valeurs décodées (`JSON.parse` de la cellule), `_rid` conservé.
  - `creerDepotEnregistreur(tables): { lire, ajouter, modifier, supprimer, changements(): Changement[] }` — même interface synchrone que `creerDepotMemoire` ; les lignes gardent `_rid`.
  - `async appliquerChangements(db, changements): Promise<void>` — un seul `db.batch` : `INSERT` (colonnes du schéma seulement, valeurs `JSON.stringify`), `UPDATE … WHERE _rid = ?` (champs modifiés seulement), `DELETE … WHERE _rid IN (…)`.
  - Constante `ONGLETS_REQUETE` = tous les onglets sauf `Journal` et `Bilan` ; `ONGLETS_TOUS`.

- [ ] **Step 1: tests**
  - aller-retour des types : `true`, `'TRUE'`, nombre, chaîne vide, texte multiligne et emoji reviennent à l'identique ;
  - `modifier` puis `appliquerChangements` ne touche que les lignes visées (par `_rid`) et que les champs donnés ;
  - `supprimer` retire seulement les lignes filtrées ;
  - **(Review Focus 4)** une ligne ajoutée avec `_rid` et un champ `inconnu` s'insère sans erreur, `inconnu` ignoré ;
  - **(Review Focus 1)** deux dépôts chargés sur la même base, chacun ajoute une inscription différente et modifie une
    sortie différente ; après les deux `appliquerChangements`, les deux inscriptions et les deux modifications sont là ;
  - `assurerSchema` sur une table `Regles` sans `autres_departs` ajoute la colonne, les lignes existantes restent ;
  - le jeu de démonstration (`creerDonneesDemo`) écrit puis relu donne les mêmes lignes (hors `_rid`).
- [ ] **Step 2:** `node --test tests/worker-depot.test.js` → Expected: FAIL.
- [ ] **Step 3:** implémenter.
- [ ] **Step 4:** même commande → Expected: PASS ; `npm test` vert.
- [ ] **Step 5: Commit** `feat(worker): dépôt D1 (lecture groupée, écritures en un lot)`

### Task 4: Contexte Cloudflare et exécution d'une requête

**Files:**
- Create: `worker/contexte.js`
- Test: `tests/worker-contexte.test.js`

**Interfaces:**
- Consumes: Task 2 (`sha256Hex`), Task 3 (dépôt), `traiter` et `ticNoyau` du noyau, `TRACES_DEMO`.
- Produces:
  - `async executer(env, travail: (ctx) => any, { onglets, adherents }): Promise<any>` — boucle d'au plus 4 passes :
    charge les tables, construit le contexte, exécute `travail(ctx)` ; s'il reste des besoins non satisfaits, les
    satisfait (fetch HTTP, lecture KV) et recommence sur un état neuf ; sinon applique les changements D1, les écritures
    et suppressions KV, puis envoie les mails par `env.passerelle.mail(...)`. Renvoie le résultat de `travail`.
  - Contexte : `depot`, `adherents.lire()` (liste fournie), `services` = `maintenant` (`new Date()`), `uuid`
    (`crypto.randomUUID`), `hacher` (`sha256Hex`), `mail(dest, objet, texte, html)` (mise en file), `http(url)`
    (réponse déjà obtenue, sinon note le besoin et lève une erreur), `fichiers.enregistrer(nom, contenu)` (id
    `kv:<uuid>`, écriture KV en file), `fichiers.lire(id)` (`demo:` → `TRACES_DEMO`, `kv:` déjà lu sinon besoin),
    `fichiers.supprimer(id)` (en file) ; `journal(type, detail)` → ligne `Journal`.
- [ ] **Step 1: tests** (D1 imité, KV = `Map`, passerelle imitée qui note les mails, `fetch` imité pour Open-Meteo)
  - **parité** : connexion de Ben puis `calendrier` via `executer` donnent les mêmes `data` que `contexteTest()` (hors
    jeton et horodatages) ;
  - une `inscription` est relue par la requête suivante (persistée dans D1) ;
  - `trace_ajouter` écrit le GPX dans KV, `trace_lire` le relit à l'identique (2 passes) ;
  - `rappel_envoyer_maintenant` (admin vérifié) : la météo est cherchée une fois (2 passes), un mail part par la passerelle ;
  - **(Review Focus 3)** passerelle qui échoue à l'envoi : la requête répond `ok`, une ligne `Journal` de type `envoi` est écrite ;
  - plus de 4 passes : erreur `erreur_interne`, rien n'est écrit.
- [ ] **Step 2:** `node --test tests/worker-contexte.test.js` → Expected: FAIL.
- [ ] **Step 3:** implémenter.
- [ ] **Step 4:** même commande → Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): exécution du noyau sur D1, besoins extérieurs rejoués`

### Task 5: Liste des adhérents (cache KV, passerelle)

**Files:**
- Create: `worker/adherents.js`, `worker/passerelle-client.js`
- Test: `tests/worker-adherents.test.js`

**Interfaces:**
- Consumes: Task 2 (`signer`).
- Produces:
  - `creerPasserelle({ url, secret, fetchImpl }) → { adherents(): Promise<object[]>, mail({to, subject, body, html, name}): Promise<void> }` — POST JSON `{ action, ... }` signé (en-têtes `X-Horodatage`, `X-Signature` sur le corps), erreur si la réponse n'est pas `ok`. C'est `env.passerelle` utilisé par la tâche 4.
  - `async adherentsPourRequete(env, requete): Promise<object[]>` — KV `adherents` (`{ lu_a, liste }`) gardé 1 h ;
    relu à la passerelle s'il est périmé, ou si `requete.action === 'connexion'` avec un numéro (normalisé par
    `normaliserTelephone`) absent de la liste.
- [ ] **Step 1: tests** — cache frais : aucun appel ; cache de plus d'1 h : un appel, KV mis à jour ; connexion d'un numéro absent : un appel, puis connexion réussie si la passerelle le connaît ; **(Review Focus 2)** passerelle en échec : liste en cache utilisée, et connexion d'un numéro inconnu → `{ ok: false, erreur: 'service_indisponible' }` ; requête signée vérifiable par `verifier`.
- [ ] **Step 2–4:** FAIL → implémenter → PASS.
- [ ] **Step 5: Commit** `feat(worker): adhérents depuis la passerelle, gardés une heure`

### Task 6: Point d'entrée du Worker

**Files:**
- Create: `worker/index.js`, `worker/wrangler.toml`
- Test: `tests/worker-index.test.js`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `export default { async fetch(request, env) }` :
  - `GET /` → `API Sorties VTT : OK` (texte) ;
  - `POST /` → corps JSON (texte brut accepté, comme Apps Script) → `traiter` via `executer` ; JSON invalide →
    `requete_invalide` ; `mesure: true` → `mesure.total_ms` ; en-tête `Access-Control-Allow-Origin: *` ; `OPTIONS` → 204 ;
  - `POST /tic` signé (secret `env.SECRET_PASSERELLE`) → `ticNoyau` sur `ONGLETS_TOUS`, réponse `{ ok: true }`.
  - `wrangler.toml` : `name = "resavtt-essai"`, `main = "index.js"`, `compatibility_date = "2026-11-01"`, liaisons
    `DB` (D1 `resavtt-essai`) et `TRACES` (KV), variable `URL_PASSERELLE`, aucun `[triggers]`.
- [ ] **Step 1: tests** — `GET /` ; POST `calendrier` après connexion ; JSON invalide ; CORS ; `OPTIONS` ; **(Review Focus 5)** `/tic` sans signature, signature fausse, horodatage de 6 min → 401 et aucune écriture ; `/tic` signé → les sorties récurrentes de la quinzaine sont générées.
- [ ] **Step 2–4:** FAIL → implémenter → PASS ; `npx --yes wrangler@4 deploy --dry-run -c worker/wrangler.toml` → Expected: bundle construit sans erreur.
- [ ] **Step 5: Commit** `feat(worker): point d'entrée (API, CORS, tic signé)`

### Task 7: Passerelle Apps Script

**Files:**
- Create: `passerelle/Passerelle.js`, `passerelle/appsscript.json`
- Test: `tests/passerelle.test.js` (exécution dans `vm` avec un Google imité : `PropertiesService`, `SpreadsheetApp`, `MailApp`, `UrlFetchApp`, `Utilities.computeHmacSha256Signature`, `ScriptApp`)

**Interfaces:**
- Consumes: même signature que Task 2 (calculée par `Utilities.computeHmacSha256Signature`).
- Produces: `doPost(e)` — actions `adherents_lire` (première feuille du fichier `ADHERENTS_ID`, colonnes `nom, telephone, email, actif, admin`, lecture seule) et `mail_envoyer` ; `ticHoraire()` (POST signé vers `URL_WORKER + '/tic'`) ; `installer()` (un seul déclencheur horaire `ticHoraire`). Propriétés : `SECRET_PASSERELLE`, `ADHERENTS_ID`, `URL_WORKER`, `PORTEUR_EMAIL`, `MODE_ESSAI` (`oui` par défaut).
- [ ] **Step 1: tests** — signature calculée par la passerelle = `signer` (Task 2) ; requête non signée ou périmée → `{ ok: false, erreur: 'refuse' }`, aucune lecture du fichier ; `adherents_lire` renvoie les lignes du fichier imité ; **en mode essai**, `mail_envoyer` à `liste@club.example` part à `PORTEUR_EMAIL` seulement, objet préfixé « [Essai] » ; `ticHoraire` envoie un POST signé à `/tic` ; `installer` deux fois → un seul déclencheur.
- [ ] **Step 2–4:** FAIL → implémenter → PASS.
- [ ] **Step 5: Commit** `feat(passerelle): adhérents, mails et tic horaire pour le Worker`

### Task 8: Données d'essai dans D1

**Files:**
- Create: `outils/cf-donnees.js`
- Modify: `package.json` (scripts `cf:demo`, `cf:vierge`)
- Test: `tests/cf-donnees.test.js`

**Interfaces:**
- Consumes: Task 3 (schéma, encodage des valeurs), `creerDonneesDemo`, `creerDonneesVierges`.
- Produces: `sqlDonnees(donnees): string` (DELETE de chaque table puis INSERT, valeurs encodées comme Task 3) ; le
  script écrit `.wrangler/donnees.sql` puis lance `wrangler d1 execute resavtt-essai --remote --file …` ; la liste des
  adhérents n'est pas écrite dans D1 (elle vient de la passerelle).
- [ ] **Step 1: tests** — le SQL du jeu de démonstration, exécuté sur le D1 imité puis relu par `chargerTables`, redonne les tables de `creerDonneesDemo` (hors `_rid`) ; idem pour `creerDonneesVierges`.
- [ ] **Step 2–4:** FAIL → implémenter → PASS.
- [ ] **Step 5: Commit** `feat(outils): données d'essai pour D1`

### Task 9: Mise en ligne de l'essai (avec l'accord de Laurent à chaque étape)

**Files:**
- Create: `docs/ESSAI-CLOUDFLARE.md` (pas à pas : base, KV, secret, déploiement, passerelle, Pages)
- Modify: `site/sorties/config.js` (`urlApi` = adresse `workers.dev` du Worker), `package.json` (`cf:deployer`, `cf:pages`, `passerelle:pousser`)

- [ ] **Step 1:** `wrangler d1 create resavtt-essai` et `wrangler kv namespace create TRACES` → identifiants dans `wrangler.toml`.
- [ ] **Step 2:** projet Apps Script de la passerelle (`clasp create --type standalone`), propriétés posées par Laurent ; `npm run passerelle:pousser` ; déploiement en application web ; `URL_PASSERELLE` dans `wrangler.toml`.
- [ ] **Step 3:** `wrangler secret put SECRET_PASSERELLE` (même valeur que la propriété du script), `npm run cf:deployer`, `npm run cf:demo`.
- [ ] **Step 4:** vérifier : `curl <worker>/` → `API Sorties VTT : OK` ; connexion + calendrier par `curl` → `ok: true`.
- [ ] **Step 5:** `config.js` → Worker ; `npm run cf:pages` (projet `resavtt-essai`) ; ouverture de l'adresse `pages.dev`, parcours connexion → calendrier → fiche → inscription dans le navigateur.
- [ ] **Step 6:** `installer()` dans l'éditeur de la passerelle ; à l'heure suivante, la ligne `Journal`/les sorties générées prouvent que le tic est passé.
- [ ] **Step 7: Commit** `chore: essai Cloudflare en ligne (Worker, D1, KV, Pages, passerelle)`

### Task 10: Mesure et compte rendu

**Files:**
- Create: `outils/mesurer.js`, `docs/ESSAI-CLOUDFLARE-mesures.md`

- [ ] **Step 1:** `outils/mesurer.js <url> <téléphone> [n=20]` : connexion puis `n` fois `calendrier` et `discussion_lire`, affiche médiane et 90 % (ms) côté client.
- [ ] **Step 2:** mesurer l'API Apps Script actuelle (jeu de démonstration) et le Worker, depuis le même poste.
- [ ] **Step 3:** compte rendu : tableau des temps, consommation du jour (tableau de bord Cloudflare), critère « calendrier < 300 ms en médiane » atteint ou non, et suites possibles (reprise des vraies données, notifications).
- [ ] **Step 4: Commit** `docs: mesures de l'essai Cloudflare`
