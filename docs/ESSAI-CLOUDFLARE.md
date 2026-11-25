# Essai Cloudflare — mise en place

Conception : `docs/superpowers/specs/2026-11-25-essai-cloudflare-design.md`. Plan : `docs/superpowers/plans/2026-11-25-essai-cloudflare.md`.

## Cloudflare (Worker, D1, KV, Durable Object)
1. `npx wrangler d1 create resavtt-essai` et `npx wrangler kv namespace create resavtt-essai-traces` ; reporter les
   identifiants dans `worker/wrangler.toml`.
2. Secret partagé : générer 64 caractères hexadécimaux (`.wrangler/secret-passerelle.txt`, ignoré par git), puis
   `npx wrangler secret put SECRET_PASSERELLE -c worker/wrangler.toml`.
3. `npx wrangler deploy -c worker/wrangler.toml` (le Durable Object `VerrouSorties` est créé au premier déploiement).
4. Données : `PORTEUR_NOM=… PORTEUR_TEL=… PORTEUR_EMAIL=… npm run cf:demo` (ou `cf:vierge`).

## Passerelle Apps Script (compte Google)
1. Copie du fichier des adhérents (Fichier → Créer une copie).
2. `cd passerelle && npx @google/clasp create-script --type standalone --title "…" --rootDir .`, puis
   `git checkout passerelle/appsscript.json` (clasp l'écrase) et `npx @google/clasp push -f`.
3. Propriétés du script : `SECRET_PASSERELLE`, `ADHERENTS_ID` (identifiant complet de la copie), `URL_WORKER`,
   `PORTEUR_EMAIL` ; `MODE_ESSAI` absent = mails au seul porteur.
4. Exécuter `installer` (autorisations, déclencheur horaire du tic), puis Déployer → Application Web (moi, tout le
   monde). Une mise à jour : `npx @google/clasp create-deployment -i <id du déploiement>` (même adresse).
5. Adresse `/exec` dans `URL_PASSERELLE` de `worker/wrangler.toml`, puis redéployer le Worker.

## Vérifier
- `curl <worker>/` → `API Sorties VTT : OK` ; `node outils/mesurer.js <worker> 0600000002` (faux adhérent).
