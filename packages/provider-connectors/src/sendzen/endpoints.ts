/**
 * Points d'accès SendZen — SOURCE UNIQUE À METTRE À JOUR si l'API change.
 *
 * Sources vérifiées (septembre 2026) :
 *  - Nœud n8n officiel SendZen  : github.com/sendzen-io/n8n-nodes-sendzen (v1.0.8)
 *  - SDK TypeScript SendZen     : npm « wa-api-message-node-js »
 *  - Documentation publique     : https://www.sendzen.io/docs (formats médias)
 *
 * Ce qui est CONFIRMÉ :
 *  - Base URL https://api.sendzen.io, en-tête Authorization: Bearer <API_KEY>
 *  - GET  /v1/auth/api_key                    → 200 si clé valide, 401/403 sinon
 *  - GET  /v1/waba                            → { data: { projects: [{ id, project_name, wabas: [...] }] } }
 *  - POST /v1/messages                        → { from, to, type, text|audio|image|template }
 *  - GET  /v1/{wabaId}/message_templates      → { data: { data: [...] } }
 *  - Webhook : signature X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(secret, corps brut)
 *  - Erreurs : { message, error: { code, details } }
 *
 * Ce qui N'EST PAS CONFIRMÉ (donc non implémenté / marqué « À configurer ») :
 *  - Endpoint de logs (synchronisation des événements manqués)
 *  - Vérification de la configuration du webhook via l'API
 *  - Message vocal (PTT) : aucun paramètre « voice » documenté
 *  - Partner API / Embedded Onboarding
 */
export const SENDZEN_DEFAULT_BASE_URL = 'https://api.sendzen.io';

export const SENDZEN_ENDPOINTS = {
  authCheck: '/v1/auth/api_key',
  wabaAccounts: '/v1/waba',
  sendMessage: '/v1/messages',
  templates: (wabaId: string) => `/v1/${encodeURIComponent(wabaId)}/message_templates`,
  /** Endpoint des logs : inconnu. Laisser null tant qu'il n'est pas confirmé par la documentation. */
  logs: null as string | null,
} as const;

export const SENDZEN_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Formats et tailles publiés par SendZen (documentation « Send Media Message »). */
export const SENDZEN_MEDIA_LIMITS = {
  audioFormats: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/ogg', 'audio/mp4'],
  audioExtensions: ['aac', 'amr', 'mp3', 'ogg', 'opus', 'm4a'],
  imageFormats: ['image/jpeg', 'image/png'],
  imageExtensions: ['jpg', 'jpeg', 'png'],
  maxAudioBytes: 16 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
};
