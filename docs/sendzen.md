# Connecteur SendZen

## Sources utilisées

La documentation web de SendZen n’était pas accessible depuis l’environnement de développement. Le connecteur
a donc été construit **uniquement** à partir de sources officielles SendZen lisibles :

1. le nœud n8n officiel : `github.com/sendzen-io/n8n-nodes-sendzen` (v1.0.8) ;
2. le SDK TypeScript publié par SendZen : `wa-api-message-node-js` (npm) ;
3. les extraits publics de https://www.sendzen.io/docs (formats et tailles des médias).

Rien n’a été inventé : ce qui n’est pas confirmé est désactivé et affiché « Non disponible » / « À configurer ».
Tous les chemins d’API sont regroupés dans
`packages/provider-connectors/src/sendzen/endpoints.ts` pour une mise à jour facile.

## Confirmé et implémenté

| Fonction | Appel |
|---|---|
| Authentification | `Authorization: Bearer <clé>` — base `https://api.sendzen.io` |
| Test de la clé | `GET /v1/auth/api_key` (200 = valide, 401/403 = refusée) |
| Projets, WABA, numéros | `GET /v1/waba` → `data.projects[].wabas[]` (`waba_id`, `phone_number_id`, `phone_number`, `number_status`) |
| Texte | `POST /v1/messages` `{from, to, type:"text", text:{body, preview_url}}` |
| Audio | `POST /v1/messages` `{from, to, type:"audio", audio:{link}}` |
| Image | `POST /v1/messages` `{from, to, type:"image", image:{link, caption?}}` |
| Modèle | `POST /v1/messages` `{from, to, type:"template", template:{name, lang_code, components}}` |
| Liste des modèles | `GET /v1/{wabaId}/message_templates` |
| Réponse d’envoi | `{message, data:[{message_id, status, timestamp, to}]}` |
| Erreurs | `{message, error:{code, details}}` |
| Webhook | format WhatsApp Cloud API (`entry[].changes[].value.messages / statuses`) |
| Signature webhook | `X-Hub-Signature-256: sha256=<HMAC-SHA256(secret, corps brut)>` |
| Formats médias | audio AAC, AMR, MP3, OGG, M4A (16 Mo) ; images JPEG, PNG (5 Mo) |

`from` = numéro de l’expéditeur (champ `phone_number` renvoyé par `/v1/waba`), `to` = numéro E.164.

## Non disponible / à configurer

| Fonction | État | Ce qu’il faut |
|---|---|---|
| **Message vocal (PTT)** | Non disponible → **« Audio standard »** | Aucun paramètre « voice » n’est documenté par SendZen. L’audio est envoyé comme fichier audio. Le bouton « Tester » permet de vérifier l’affichage sur votre téléphone. La conversion FFmpeg en OGG/Opus est proposée mais n’est **pas** présentée comme une garantie de message vocal. |
| **Logs SendZen** (synchronisation des événements manqués) | À configurer | Renseigner `logs` dans `endpoints.ts` et le parseur dans `connector.ts#fetchLogs` à partir de la documentation. Le mécanisme (pagination, anti-doublon webhook ↔ logs) est déjà développé et testé. En attendant, « Événements manqués » retraite les webhooks stockés non traités. |
| **Vérification de la configuration du webhook** | Non vérifiable par API | Le test de connexion l’indique et affiche l’URL à coller dans SendZen. La réception réelle est vérifiée par la date du dernier webhook reçu. |
| **Partner API / Embedded Onboarding** | À configurer | Variable `SENDZEN_PARTNER_API_KEY` prévue ; capacité `partnerOnboarding` à implémenter dans le connecteur quand les endpoints seront disponibles. |
| **Sandbox** | À vérifier | Une connexion peut être créée en mode **TEST** (clé de test, URL d’API optionnelle `SENDZEN_SANDBOX_API_BASE_URL`). Les campagnes TEST ne modifient jamais les statuts de production des contacts. |
| **Modèles avec variables** | Non pris en charge | Seuls les modèles approuvés **sans variable** sont proposés (les autres sont affichés grisés avec la raison). |

## Ajouter un autre fournisseur

1. Créer `packages/provider-connectors/src/<fournisseur>/` qui implémente `ProviderConnector` (`types.ts`).
2. Déclarer honnêtement ses capacités (`SUPPORTED` / `UNVERIFIED` / `NOT_AVAILABLE`).
3. L’ajouter dans `registry.ts` (`PROVIDERS` + `createConnector`) et dans l’enum `provider` des routes.
Les automatisations, l’anti-doublon, les files et l’interface n’ont pas à changer.
