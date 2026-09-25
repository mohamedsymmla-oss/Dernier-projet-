/**
 * Couche d'abstraction fournisseur.
 * Chaque fournisseur WhatsApp implémente ProviderConnector. Le reste de l'application
 * ne connaît que ces types : changer ou ajouter un fournisseur ne touche pas aux automatisations.
 */

export type ProviderId = 'sendzen';

/** Niveau de confiance d'une capacité, affiché tel quel dans l'interface. */
export type CapabilityStatus =
  | 'SUPPORTED' // Implémenté et confirmé par une source officielle du fournisseur
  | 'UNVERIFIED' // Implémenté selon le format du fournisseur, à valider avec « Tester sur mon numéro »
  | 'NOT_AVAILABLE'; // Non développé / non confirmé : bouton désactivé « Non disponible »

export interface Capability {
  status: CapabilityStatus;
  note: string;
}

export interface ProviderCapabilities {
  sendText: Capability;
  sendAudio: Capability;
  /** Vrai message vocal (PTT). Ne jamais le déclarer SUPPORTED sans confirmation officielle. */
  sendVoiceNote: Capability;
  sendImage: Capability;
  sendTemplate: Capability;
  listTemplates: Capability;
  listAccounts: Capability;
  webhookSignature: Capability;
  fetchLogs: Capability;
  webhookConfigCheck: Capability;
  partnerOnboarding: Capability;
  sandbox: Capability;
  audioFormats: string[];
  imageFormats: string[];
  maxAudioBytes: number;
  maxImageBytes: number;
}

export interface ConnectionCredentials {
  apiKey: string;
  webhookSecret?: string | null;
  /** Base URL de l'API (permet un mode TEST/sandbox si le fournisseur en expose une). */
  apiBaseUrl?: string | null;
}

export interface SenderIdentity {
  /** Numéro de l'expéditeur au format E.164. */
  phoneNumber: string;
  phoneNumberId: string;
  wabaId: string;
}

export interface ProviderPhoneNumber {
  projectId: string;
  projectName: string;
  wabaId: string;
  wabaName: string | null;
  phoneNumberId: string;
  phoneNumber: string; // E.164
  status: string; // Statut brut du fournisseur
  isConnected: boolean;
  raw: Record<string, unknown>;
}

export type MediaRef = { link: string } | { id: string };

export type OutboundMessage =
  | { kind: 'text'; body: string; previewUrl?: boolean }
  | { kind: 'audio'; media: MediaRef; asVoiceNote?: boolean }
  | { kind: 'image'; media: MediaRef; caption?: string }
  | { kind: 'template'; name: string; languageCode: string; components?: unknown[] };

export interface SendResult {
  providerMessageId: string;
  /** Statut renvoyé par l'API à la soumission (ex: queued). Ce n'est PAS « livré » ni « lu ». */
  providerStatus: string | null;
  httpStatus: number;
  requestId: string | null;
  raw: unknown;
}

export type ProviderErrorKind =
  | 'TRANSIENT' // timeout, réseau, 5xx : on peut réessayer
  | 'RATE_LIMITED' // 429 : réessayer après le délai indiqué
  | 'AUTH' // clé refusée : ne pas réessayer, suspendre
  | 'WINDOW_CLOSED' // hors fenêtre de conversation : modèle WhatsApp requis
  | 'INVALID_RECIPIENT'
  | 'INVALID_MEDIA'
  | 'PERMANENT' // autre erreur définitive
  | 'NOT_AVAILABLE'; // fonctionnalité non disponible pour ce fournisseur

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly details: {
      httpStatus?: number;
      code?: string | null;
      retryAfterMs?: number | null;
      requestId?: string | null;
      raw?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.kind === 'TRANSIENT' || this.kind === 'RATE_LIMITED';
  }
}

/** Événement normalisé extrait d'un webhook ou des logs fournisseur. */
export type NormalizedEvent =
  | {
      type: 'inbound_message';
      /** Clé d'unicité stable (anti-doublon) */
      dedupeKey: string;
      providerMessageId: string;
      from: string; // E.164
      toPhoneNumberId: string | null;
      toPhoneNumber: string | null;
      messageType: string;
      text: string | null;
      timestamp: Date;
      raw: unknown;
    }
  | {
      type: 'message_status';
      dedupeKey: string;
      providerMessageId: string;
      status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
      recipient: string | null;
      timestamp: Date;
      errorCode: string | null;
      errorMessage: string | null;
      raw: unknown;
    }
  | {
      type: 'other';
      dedupeKey: string;
      name: string;
      timestamp: Date;
      raw: unknown;
    };

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export type WebhookVerification =
  | { verified: true; method: string }
  | { verified: false; reason: string; signaturePresent: boolean };

/** Observateur des appels HTTP : alimente le journal technique (sans secrets). */
export interface HttpCallRecord {
  provider: ProviderId;
  method: string;
  endpoint: string;
  httpStatus: number | null;
  requestId: string | null;
  providerMessageId: string | null;
  durationMs: number;
  error: string | null;
  responseSnippet: string | null;
}

export type HttpObserver = (record: HttpCallRecord) => void | Promise<void>;

export interface LogsPage {
  events: NormalizedEvent[];
  nextCursor: string | null;
}

export interface ProviderConnector {
  readonly id: ProviderId;
  readonly displayName: string;
  capabilities(): ProviderCapabilities;

  /** Vérifie la clé API auprès du fournisseur. */
  testAuth(): Promise<{ ok: true } | { ok: false; error: ProviderError }>;
  /** Projets, WABA et numéros accessibles avec cette clé. */
  getPhoneNumbers(): Promise<ProviderPhoneNumber[]>;
  send(sender: SenderIdentity, to: string, message: OutboundMessage): Promise<SendResult>;
  listTemplates(wabaId: string): Promise<ProviderTemplate[]>;
  verifyWebhook(req: WebhookRequest): WebhookVerification;
  parseWebhook(payload: unknown, rawBody: Buffer): NormalizedEvent[];
  /** Récupère les événements manqués (logs). Lève NOT_AVAILABLE si non supporté. */
  fetchLogs(params: { since: Date; cursor?: string | null }): Promise<LogsPage>;
}

export interface ProviderTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string | null;
  /** Nombre de variables : l'application n'envoie que les modèles sans variable pour l'instant. */
  variableCount: number;
  raw: unknown;
}
