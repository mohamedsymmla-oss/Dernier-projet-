# Architecture technique

## Vue d’ensemble

```
 Téléphone Android / navigateur          Serveur (Railway)                         Fournisseur
 ┌──────────────────────┐   HTTPS   ┌───────────────────────────────┐   HTTPS   ┌──────────┐
 │ App Flutter          │ ───────▶  │ API Fastify (auth JWT)        │ ───────▶  │ SendZen  │
 │ (aucun secret)       │           │ Workers BullMQ                │ ◀───────  │ webhooks │
 └──────────────────────┘           │  • a1-recipients (parallèle)  │           └──────────┘
                                    │  • a2-sequential (1 à la fois)│
                                    │  • webhook-events             │
                                    └───────┬───────────────┬───────┘
                                            │               │
                                     PostgreSQL          Redis
                                   (source de vérité)  (files, débit)
```

`APP_ROLE=all` (défaut) lance l’API et les workers dans le même processus ; `api` / `worker` permettent de les séparer.

## Données (migrations : `apps/backend/migrations`)

| Table | Rôle |
|---|---|
| `users`, `user_sessions` | comptes et sessions révocables |
| `provider_connections` | connexions fournisseur (clé API et secret webhook **chiffrés**), mode PRODUCTION/TEST |
| `whatsapp_numbers` | identité durable d’un numéro, survit aux reconnexions |
| `contacts` | numéro E.164, date d’ajout, dernier message reçu, statuts A1/A2, réponse après A1, erreurs |
| `contact_imports`, `contact_import_items` | chaque liste importée, ligne par ligne, avec la raison des rejets |
| `automation_configs` | une ligne par automatisation ; **un endpoint par champ** (isolation) |
| `automation_runs` | campagnes ; contenu figé (`config_snapshot`), statut, position, dernier contact terminé |
| `automation_recipients` | un destinataire par contact et par automatisation (**clé d’idempotence unique**) |
| `automation_steps` | étapes de la séquence (audio, texte, image, modèle) avec statut persistant |
| `outbound_messages` | cycle de vie : SUBMITTING → ACCEPTED → SENT → DELIVERED → READ / FAILED |
| `inbound_messages`, `message_status_events` | événements entrants dédoublonnés |
| `webhook_events` | chaque webhook brut, stocké durablement (anti-doublon par hash/ID) |
| `media_assets` | audios / images vérifiés (upload S3 ou URL publique) |
| `queue_jobs` | trace des jobs programmés (diagnostic) |
| `provider_logs` | journal technique des appels HTTP (sans secrets) |
| `audit_logs` | actions de l’utilisateur et du système |
| `saved_presets` | présets (sans données de connexion) |
| `sync_runs` | synchronisations des événements manqués |

## Garanties du moteur (`apps/backend/src/services/engine.ts`)

- **Anti-doublon** : clé `MODE:TYPE:contactId` unique. Elle n’inclut pas l’identifiant de connexion :
  une reconnexion (nouvelle clé, nouvelle connexion) ne permet jamais de renvoyer une automatisation déjà faite.
  La version du contenu est conservée sur chaque destinataire (`content_version`) pour l’historique.
- **Étapes persistantes** : une étape `ACCEPTED` n’est jamais renvoyée. Après une erreur temporaire épuisée,
  « Relancer » ne renvoie que les étapes manquantes.
- **Crash pendant un appel HTTP** : l’étape reste `SUBMITTING` → devient `UNCERTAIN` → destinataire
  « Vérification requise ». Pas de renvoi automatique (le client a peut-être reçu le message).
- **Bail (lease)** : un destinataire en cours est verrouillé 2 minutes (renouvelé) : deux workers ne peuvent
  pas traiter le même contact.
- **Erreurs** : temporaires (timeout, 5xx, 429) → backoff exponentiel + gigue, `Retry-After` respecté, nombre
  de tentatives limité ; définitives (numéro, média, paramètre) → enregistrées, pas de boucle ;
  authentification refusée → campagne mise en pause automatiquement.
- **Fenêtre de 24 h** : vérifiée avant chaque message libre ; au-delà → « Modèle WhatsApp requis ».
  Un refus du fournisseur (131047) donne le même statut. Envoi d’un modèle approuvé possible depuis l’écran.

## Automation 2 : minuteur

Un seul « tick » actif par campagne (compare-and-swap sur `tick_seq`), worker de concurrence 1.
Après le traitement complet d’un contact (toutes ses étapes acceptées par l’API), le serveur enregistre
`last_contact_finished_at`. Le contact suivant ne démarre jamais avant
`last_contact_finished_at + delay_between_contacts_seconds` (valeur lue en base à chaque fois).

- Un job en avance ou en double est ignoré (vérification du délai et du numéro de séquence).
- Redémarrage / perte de Redis : `recoverRuns()` reprogramme le tick à partir de PostgreSQL, avec le temps restant.
- Pause : la position et l’heure de fin du dernier contact sont conservées ; reprise au bon contact.
- Modifier le délai pendant une campagne s’applique à l’attente en cours.
- Un contact pour lequel rien n’a été envoyé (ex. modèle requis) ne déclenche pas d’attente.

## Reprise après panne

Au démarrage des workers puis toutes les 60 s, `recoverRuns()` :
- remet en file les destinataires en attente des campagnes `RUNNING` (Automation 1) ;
- reprogramme le tick des campagnes Automation 2 ;
- retraite les webhooks stockés mais pas encore traités.
Toutes ces opérations sont idempotentes : aucune ne peut provoquer de double envoi.

## Observabilité

Logs JSON (pino) avec `run_id`, `recipient_id`, `step_id`, `message_id`, `event_id`. Les en-têtes
d’authentification et les champs sensibles sont masqués automatiquement. Le journal technique de l’application
(`provider_logs`) contient endpoint, statut HTTP, request ID, message ID, erreur, tentative, durée.
