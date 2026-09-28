import { SENDZEN_MEDIA_LIMITS, ProviderError, type LogsPage, type NormalizedEvent, type OutboundMessage, type ProviderCapabilities,
  type ProviderConnector, type ProviderPhoneNumber, type ProviderTemplate, type SendResult, type SenderIdentity,
  type WebhookVerification } from '@wa/provider-connectors';
import type { AppContext } from '../context.js';
import { getVoiceNote } from './audio.js';
import { getQrSettings, triggerEmergencyStop } from './safety.js';
import type { QrSocket } from './socket-port.js';

export interface QrSocketProvider {
  connectedSocket(): QrSocket | null;
}

/** Registre du processus : le worker qui détient la session y enregistre son gestionnaire. */
export const qrRuntime: { manager: QrSocketProvider | null } = { manager: null };

export function phoneToJid(e164: string): string {
  return `${e164.replace(/[^\d]/g, '')}@s.whatsapp.net`;
}

const cap = (note: string) => ({ status: 'SUPPORTED' as const, note });
const na = (note: string) => ({ status: 'NOT_AVAILABLE' as const, note });

export const QR_CAPABILITIES: ProviderCapabilities = {
  sendText: cap('Texte via WhatsApp lié (QR)'),
  sendAudio: cap('Audio via WhatsApp lié (QR)'),
  sendVoiceNote: cap('Vrai message vocal (OGG/Opus, ptt) via WhatsApp lié'),
  sendImage: cap('Images via WhatsApp lié (QR)'),
  sendTemplate: na('Les modèles WhatsApp n’existent que sur l’API officielle'),
  listTemplates: na('Non applicable au canal QR'),
  listAccounts: na('Non applicable au canal QR'),
  webhookSignature: na('Pas de webhook : événements reçus directement par la session'),
  fetchLogs: na('Non applicable au canal QR'),
  webhookConfigCheck: na('Non applicable au canal QR'),
  partnerOnboarding: na('Non applicable au canal QR'),
  sandbox: na('Non applicable au canal QR'),
  audioFormats: SENDZEN_MEDIA_LIMITS.audioFormats,
  imageFormats: SENDZEN_MEDIA_LIMITS.imageFormats,
  maxAudioBytes: SENDZEN_MEDIA_LIMITS.maxAudioBytes,
  maxImageBytes: SENDZEN_MEDIA_LIMITS.maxImageBytes,
};

/** Détecte les erreurs Baileys signalant une restriction du compte : on arrête tout immédiatement. */
function isRestrictionSignal(e: unknown): string | null {
  const err = e as { message?: string; output?: { statusCode?: number }; data?: unknown };
  const code = err?.output?.statusCode;
  const msg = String(err?.message ?? '').toLowerCase();
  if (code === 401) return 'session refusée par WhatsApp (401)';
  if (code === 403 || msg.includes('forbidden')) return 'accès refusé par WhatsApp (403)';
  if (code === 429 || msg.includes('rate-overlimit') || msg.includes('rate limit')) return 'limite de débit WhatsApp atteinte';
  return null;
}

/**
 * Canal QR vu par le moteur d'envoi : même interface que le fournisseur (ProviderConnector).
 * Envoi « humain » : présence composing/recording avant chaque élément.
 */
export class QrConnector implements ProviderConnector {
  readonly id = 'qr' as const;
  readonly displayName = 'WhatsApp QR';

  constructor(
    private readonly ctx: AppContext,
    private readonly provider: QrSocketProvider | null = qrRuntime.manager,
  ) {}

  capabilities(): ProviderCapabilities {
    return QR_CAPABILITIES;
  }

  private socket(): QrSocket {
    const sock = this.provider?.connectedSocket() ?? null;
    if (!sock) {
      throw new ProviderError(
        'UNAVAILABLE',
        this.provider ? 'WhatsApp QR déconnecté : reconnectez-le (scan du QR) puis reprenez' : 'Session WhatsApp QR gérée par un autre processus',
      );
    }
    return sock;
  }

  private async simulatePresence(sock: QrSocket, jid: string, kind: 'composing' | 'recording', ms: number) {
    try {
      await sock.sendPresenceUpdate(kind, jid);
      await this.ctx.clock.sleep(ms);
      await sock.sendPresenceUpdate('paused', jid);
    } catch {
      // La présence est un confort : son échec n'empêche pas l'envoi.
    }
  }

  async send(_sender: SenderIdentity, to: string, message: OutboundMessage): Promise<SendResult> {
    const settings = await getQrSettings(this.ctx);
    if (settings.emergency_stopped) {
      throw new ProviderError('UNAVAILABLE', `Arrêt d'urgence WhatsApp QR : ${settings.emergency_reason ?? ''}`);
    }
    const sock = this.socket();
    const jid = phoneToJid(to);
    let content: Record<string, unknown>;
    let presence: { kind: 'composing' | 'recording'; ms: number } | null = null;
    switch (message.kind) {
      case 'text':
        content = { text: message.body };
        presence = { kind: 'composing', ms: Math.min(8000, Math.max(1500, message.body.length * 45)) };
        break;
      case 'image':
        content = { image: 'link' in message.media ? { url: message.media.link } : { url: '' } };
        if (message.caption) content.caption = message.caption;
        presence = { kind: 'composing', ms: 1200 + Math.floor(Math.random() * 1500) };
        break;
      case 'audio': {
        const voice = message.mediaId ? await getVoiceNote(this.ctx, message.mediaId) : null;
        if (voice) {
          content = { audio: voice.data, mimetype: voice.mime, ptt: !!message.asVoiceNote && voice.converted };
          if (voice.seconds) content.seconds = voice.seconds;
        } else {
          content = { audio: { url: 'link' in message.media ? message.media.link : '' }, mimetype: 'audio/mpeg' };
        }
        presence = { kind: 'recording', ms: Math.min(8000, Math.max(2000, (voice?.seconds ?? 5) * 400)) };
        break;
      }
      case 'template':
        throw new ProviderError('NOT_AVAILABLE', 'Les modèles WhatsApp ne sont pas disponibles sur le canal QR');
    }
    if (settings.typing_simulation && presence) await this.simulatePresence(sock, jid, presence.kind, presence.ms);
    try {
      const res = await sock.sendMessage(jid, content);
      const id = res?.key?.id;
      if (!id) throw new ProviderError('PERMANENT', 'WhatsApp n’a pas renvoyé d’identifiant : envoi non confirmé');
      return { providerMessageId: id, providerStatus: 'server_ack', httpStatus: 200, requestId: null, raw: null };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const restriction = isRestrictionSignal(e);
      if (restriction) {
        await triggerEmergencyStop(this.ctx, restriction);
        throw new ProviderError('UNAVAILABLE', `Arrêt d'urgence WhatsApp QR : ${restriction}`);
      }
      const msg = (e as Error)?.message ?? String(e);
      if (/connection closed|not open|timed out|lost/i.test(msg)) {
        throw new ProviderError('UNAVAILABLE', 'WhatsApp QR déconnecté pendant l’envoi : reprise après reconnexion');
      }
      throw new ProviderError('PERMANENT', `Échec d'envoi WhatsApp QR : ${msg}`);
    }
  }

  async testAuth() {
    return this.provider?.connectedSocket()
      ? { ok: true as const }
      : { ok: false as const, error: new ProviderError('UNAVAILABLE', 'WhatsApp QR non connecté') };
  }
  async getPhoneNumbers(): Promise<ProviderPhoneNumber[]> {
    return [];
  }
  async listTemplates(): Promise<ProviderTemplate[]> {
    return [];
  }
  verifyWebhook(): WebhookVerification {
    return { verified: false, reason: 'Pas de webhook sur le canal QR', signaturePresent: false };
  }
  parseWebhook(): NormalizedEvent[] {
    return [];
  }
  async fetchLogs(): Promise<LogsPage> {
    throw new ProviderError('NOT_AVAILABLE', 'Non applicable au canal QR');
  }
}
