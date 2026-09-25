# WA Automation — automatisation privée de WhatsApp Business

Application privée pour automatiser **votre propre** WhatsApp Business via un fournisseur (SendZen en premier).

- **Application Android** (Flutter) = uniquement l’interface. Version **web** disponible avec le même code.
- **Backend cloud** (Node.js + TypeScript + Fastify) = c’est lui qui exécute les automatisations.
  Elles continuent si le téléphone est éteint, l’application fermée, ou si vous changez de téléphone.
- **PostgreSQL** = mémoire permanente (contacts, campagnes, envois, réponses, webhooks).
- **Redis + BullMQ** = files d’attente persistantes. Si Redis est vidé, l’état est reconstruit depuis PostgreSQL.

> Aucune clé API, aucun secret, aucun mot de passe serveur n’est dans l’application Android.

---

## 1. Architecture

```
apps/mobile                  Application Flutter (Android + Web), en français
apps/backend                 API REST, workers, webhooks, migrations SQL, tests
packages/shared              Normalisation des numéros (E.164), statuts, règles communes
packages/provider-connectors Interface ProviderConnector + connecteur SendZen
docs/                        Documentation détaillée
```

Détails : [docs/architecture.md](docs/architecture.md) — SendZen : [docs/sendzen.md](docs/sendzen.md).

**Automation 1** : liste importée → Audio, puis Texte 1, puis Texte 2 (ordre strict). Traitement parallèle
**contrôlé** (concurrence et débit limités, respect des 429).

**Automation 2** : personnes ayant répondu → Audio + 1 à 10 photos. **Un contact à la fois**, avec un délai
réglable de **1 s à 2 min** entre deux contacts, appliqué par le serveur. Pause / reprise / arrêt.

Protections : anti-doublon (un contact ne reçoit jamais deux fois la même automatisation), reprise après
crash (seules les étapes manquantes sont envoyées), retries avec backoff exponentiel, vérification de la
fenêtre WhatsApp de 24 h (« Modèle WhatsApp requis », jamais de contournement), confirmation avant chaque
démarrage, protection contre le double clic.

---

## 2. Installation locale (développement)

Prérequis : Node.js 22, PostgreSQL 16, Redis 7, Flutter 3.47+.

```bash
npm install
cp .env.example .env        # puis remplissez au minimum DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, JWT_SECRET
npm run migrate             # crée toutes les tables (installation depuis zéro)
npm run create-user -- moi@exemple.com "MonMotDePasseLong"
npm run dev                 # backend sur http://localhost:3000 (API + workers)
```

Générer les secrets : `openssl rand -hex 32` (une fois pour `ENCRYPTION_KEY`, une fois pour `JWT_SECRET`).

Application :

```bash
cd apps/mobile
flutter pub get
flutter run --dart-define=BACKEND_URL=http://10.0.2.2:3000   # émulateur Android
flutter run -d chrome --dart-define=BACKEND_URL=http://localhost:3000
```

---

## 3. Déploiement Railway (backend + PostgreSQL + Redis)

1. Sur Railway : **New Project → Deploy from GitHub repo** → choisissez ce dépôt.
   Le fichier `railway.json` indique d’utiliser le `Dockerfile` (FFmpeg inclus) et le health check `/health`.
2. Ajoutez **PostgreSQL** et **Redis** au projet (**+ New → Database**).
3. Dans le service backend → **Variables** :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` — **à conserver précieusement** |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `PUBLIC_BACKEND_URL` | l’URL publique Railway du service, ex. `https://xxx.up.railway.app` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | votre premier compte (créé au premier démarrage) |
| `S3_*` | stockage des médias (section 4) |

4. **Settings → Networking → Generate Domain** pour obtenir l’URL HTTPS.
5. Vérifiez : `https://xxx.up.railway.app/health` doit répondre `"status":"ok"`.

Les migrations s’exécutent automatiquement au démarrage (verrou : sûr avec plusieurs instances).

**Offre Railway gratuite (2 services maximum)** : sans service Redis, laissez `REDIS_URL` vide. L’image démarre
alors un Redis local dans le conteneur. Aucune donnée n’est perdue au redémarrage : PostgreSQL reste la source
de vérité et les files sont reconstruites automatiquement. Un vrai service Redis reste préférable dès que possible.
Pour séparer API et workers : deux services avec `APP_ROLE=api` et `APP_ROLE=worker`.

Toutes les variables : [.env.example](.env.example).

---

## 4. Stockage des médias

Le disque de Railway est effacé à chaque déploiement : les fichiers importés vont dans un stockage **S3
compatible** (Cloudflare R2 recommandé, AWS S3, MinIO…).

Cloudflare R2 : créez un bucket et une clé API R2, puis :
`S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
Le fournisseur WhatsApp reçoit une URL pré-signée temporaire (ou `S3_PUBLIC_BASE_URL` si le bucket est public).

Sans S3 : l’import de fichiers affiche « À configurer », les **URL publiques** fonctionnent toujours.
Chaque média est vérifié avant acceptation : type réel (MIME), extension, taille, durée audio, accessibilité
de l’URL, formats acceptés par le fournisseur.

---

## 5. SendZen

1. Dans l’application : **Connexion WhatsApp → Connecter** → collez votre clé API SendZen (+ secret webhook
   recommandé). La clé est vérifiée auprès de SendZen puis stockée **chiffrée** sur le serveur ; l’interface
   n’affiche que `sk_live_*********789`.
2. Choisissez le numéro WhatsApp (projet, WABA, Phone Number ID sont lus chez SendZen).
3. **Copier le webhook** → collez l’URL dans le tableau de bord SendZen (section Webhooks), avec le même secret.
4. **Tester la connexion** : backend, API, projet, WABA, numéro, webhook, réception, envoi — chaque point est
   vérifié réellement. Envoyez un message WhatsApp à votre numéro pour valider la réception webhook.

Ce qui est confirmé et ce qui reste « À configurer » (logs, PTT, Partner API) : [docs/sendzen.md](docs/sendzen.md).

---

## 6. Webhook

`POST /webhooks/sendzen/<id-connexion>` — réponse 2xx immédiate, traitement en file d’attente.
Signature `X-Hub-Signature-256` vérifiée si un secret est configuré. Chaque webhook est stocké durablement ;
les doublons (même payload renvoyé, même message dans une autre enveloppe, webhook puis synchronisation) ne
sont jamais appliqués deux fois.

---

## 7. APK Android

### Option A — GitHub Actions (sans rien installer)
1. Onglet **Actions → « APK Android (release) » → Run workflow**, saisissez l’URL de votre backend.
2. À la fin, téléchargez l’artefact **wa-automation-apk** → `app-release.apk`.

### Option B — sur votre ordinateur
```bash
cd apps/mobile
flutter build apk --release --dart-define=BACKEND_URL=https://xxx.up.railway.app
```
APK : `apps/mobile/build/app/outputs/flutter-apk/app-release.apk`

### Installer sur votre téléphone
1. Copiez l’APK sur le téléphone (câble, Drive, e-mail…).
2. Ouvrez-le → autorisez « Installer des applis inconnues » pour l’application utilisée.
3. Installez. Aucune publication sur le Play Store n’est nécessaire.

### Changer l’URL du backend
Sur l’écran de connexion : **Serveur : … → saisir l’URL → Vérifier le serveur**, ou **Réglages → Changer l’URL
du backend**. La valeur par défaut vient de `--dart-define=BACKEND_URL`.

### Signature
Sans configuration, l’APK est signé avec la clé de debug (installable, suffisant pour un usage privé).
Pour votre propre clé : créez `apps/mobile/android/key.properties` (jamais commité) ou ajoutez les secrets
GitHub `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Gardez toujours la même clé, sinon Android refusera la mise à jour de l’application.

### Version web
`flutter build web --release --no-web-resources-cdn --dart-define=BACKEND_URL=https://xxx.up.railway.app`
puis hébergez `apps/mobile/build/web` (ajoutez son domaine à `CORS_ORIGINS`).

---

## 8. Tests

```bash
npm test                         # 105 tests : numéros, SendZen, moteur, webhooks, API, BullMQ
cd apps/mobile && flutter test   # tests de l’interface (minuteur, formats)
```
Les tests backend utilisent une vraie base PostgreSQL et un vrai Redis :
`TEST_DATABASE_URL` (défaut `postgres://app:app@localhost:5432/app_test`) et `TEST_REDIS_URL`.
La CI GitHub (`.github/workflows/ci.yml`) les lance à chaque push.

Couverture notable : minuteur Automation 2 pour 1, 5, 10, 20, 60 et 120 s ; isolation des réglages (changer le
délai de 10 à 60 s ne modifie ni audio, ni photos, ni Automation 1, ni connexion, ni contacts) ; reprise après
redémarrage (26 contacts faits → reprise au 27e) ; webhooks dupliqués ; idempotence ; retries ; 429 ; sécurité.

---

## 9. Sauvegardes

- **PostgreSQL** contient tout l’historique : activez les sauvegardes Railway si votre offre les propose (onglet *Backups* du volume
  Postgres) ou faites un export régulier : `pg_dump "$DATABASE_URL" > sauvegarde.sql`.
- **`ENCRYPTION_KEY`** : sans elle, les clés API chiffrées en base sont illisibles. Conservez-la hors de Railway
  (gestionnaire de mots de passe).
- **Médias** : dans votre bucket S3/R2 (activez le versioning si possible).
- **Redis** n’a pas besoin de sauvegarde : l’état des campagnes est reconstruit depuis PostgreSQL.

---

## 10. Sécurité (résumé)

Clés et secrets uniquement côté serveur, via variables d’environnement ; clés API et secrets webhook chiffrés
en base (AES-256-GCM) ; mots de passe hachés (bcrypt) ; sessions JWT révocables ; toutes les routes protégées
sauf `/health`, `/auth/login` et le webhook (signé) ; limitation de débit sur les routes sensibles ; journal
technique sans aucun secret ; protection SSRF sur les URL de médias ; HTTPS obligatoire en release Android.
