# Partie « WhatsApp QR » (appareil lié)

Deuxième façon d’envoyer, **totalement séparée** de la partie fournisseur (SendZen) :
votre WhatsApp Business est lié au serveur comme un appareil (comme WhatsApp Web), en scannant un QR code.

## Ce qui est identique à la partie fournisseur

- Automation 1 (vocal, texte 1, texte 2) et Automation 2 (vocal + 1 à 10 photos).
- Import des numéros (coller / CSV / TXT), analyse, confirmation avant démarrage, protection double clic.
- Pause, reprise, arrêt, reprise après panne, relance des échecs, numéro de test, présets, historique, logs.

## Ce qui est séparé (rien ne se mélange)

| Élément | Où c’est rangé |
|---|---|
| Réglages A1 / A2 | `automation_configs` avec `channel = 'QR'` |
| Campagnes, destinataires, listes, présets | colonne `channel = 'QR'` |
| Anti-doublon | clé préfixée `QR:` : un contact traité côté fournisseur reste éligible côté QR, et inversement |
| Statuts des contacts (A1, A2, a répondu) | table `qr_contact_status` (les colonnes de `contacts` restent au fournisseur) |
| Connexion | ligne `provider_connections` avec `provider = 'qr'`, invisible dans l’écran du fournisseur |

Les deux parties peuvent tourner en même temps.

## Connexion

1. Menu **Connexion QR → Connecter** : le serveur affiche un QR (renouvelé toutes les ~20 s).
2. Téléphone : WhatsApp Business → menu → *Appareils connectés* → *Connecter un appareil* → scanner.
3. La connexion est détectée automatiquement. La session est enregistrée **chiffrée dans PostgreSQL**
   (table `qr_auth`, clé `ENCRYPTION_KEY`) : aucun nouveau scan après un redémarrage ou un déploiement.

Reconnexion automatique après une coupure (attente croissante). Pas de reconnexion en boucle si le téléphone
a délié l’appareil (401), si WhatsApp refuse (403) ou si la session est ouverte ailleurs (440) : une alerte
s’affiche dans toute l’application. Un seul socket actif à la fois (verrou PostgreSQL).

## Protection du numéro (réglable dans l’écran Connexion QR)

- **Un contact à la fois** pour Automation 1 et 2, avec le minuteur (1 s – 2 min).
- **Plafond quotidien** de messages (défaut 150), en comptant la séquence entière du prochain contact.
- **Montée progressive** : plafond divisé par 2 pendant les 7 premiers jours d’une nouvelle session.
- **Heures calmes** (défaut 21:00 – 08:00, fuseau Africa/Bamako) : rien ne part, reprise automatique.
- **« En train d’écrire / d’enregistrer »** avant chaque message.
- **Vrai message vocal** : l’audio est converti en OGG/Opus (FFmpeg) et envoyé avec `ptt` ; sans FFmpeg,
  il part en audio standard (et l’application ne prétend pas le contraire).
- **Arrêt d’urgence automatique** au premier signal de restriction (401, 403, limite de débit) :
  tous les envois QR s’arrêtent jusqu’à ce que vous le leviez manuellement.

La règle des 24 h de l’API officielle ne s’applique pas à ce canal ; ce sont ces garde-fous qui la remplacent.

## Limite importante

Baileys (`@whiskeysockets/baileys`) est une bibliothèque **non officielle**. WhatsApp peut restreindre ou
bannir un numéro qui l’utilise, quelles que soient les précautions. Commencez avec de petits volumes, sur des
personnes qui vous connaissent. La partie fournisseur (API officielle) reste la voie sans ce risque.

## Technique

- Code : `apps/backend/src/qr/` (session, stockage chiffré, connecteur, garde-fous, conversion audio).
- Le socket tourne dans le worker (`APP_ROLE=all` ou `worker`), piloté par la file BullMQ `qr-control`.
- Migration : `apps/backend/migrations/002_qr_channel.sql` (ajouts uniquement, données existantes conservées).
- Tests : `apps/backend/test/qr.test.ts`, `qr-api.test.ts` (socket simulé ; conversion FFmpeg réelle).
