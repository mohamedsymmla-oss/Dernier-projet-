/** Cycle de vie d'un message sortant. L'ordre sert à ne jamais « rétrograder » un statut. */
export const MESSAGE_STATUSES = [
  'QUEUED',
  'SUBMITTING',
  'ACCEPTED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'UNCERTAIN',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  QUEUED: 'En file',
  SUBMITTING: 'Soumission en cours',
  ACCEPTED: "Accepté par l'API",
  SENT: 'Envoyé',
  DELIVERED: 'Livré',
  READ: 'Lu',
  FAILED: 'Échec',
  UNCERTAIN: 'Résultat incertain (vérification requise)',
};

const RANK: Record<MessageStatus, number> = {
  QUEUED: 0,
  SUBMITTING: 1,
  UNCERTAIN: 1,
  ACCEPTED: 2,
  SENT: 3,
  DELIVERED: 4,
  READ: 5,
  FAILED: 6,
};

/**
 * Indique si un nouveau statut provenant d'un webhook doit remplacer le statut courant.
 * - Jamais de rétrogradation (READ ne redevient pas DELIVERED si les webhooks arrivent dans le désordre).
 * - FAILED ne remplace pas un DELIVERED/READ (un message lu n'est plus en échec).
 */
export function shouldApplyStatus(current: MessageStatus, next: MessageStatus): boolean {
  if (current === next) return false;
  if (next === 'FAILED') return RANK[current] < RANK.DELIVERED;
  if (current === 'FAILED') return RANK[next] >= RANK.DELIVERED;
  return RANK[next] > RANK[current];
}

export type AutomationType = 'A1' | 'A2';

export const RUN_STATUSES = ['RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RECIPIENT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'TEMPLATE_REQUIRED',
  'NEEDS_REVIEW',
  'CANCELLED',
  'SKIPPED',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  PENDING: 'En attente',
  IN_PROGRESS: 'En cours',
  COMPLETED: 'Terminé',
  FAILED: 'Échec',
  TEMPLATE_REQUIRED: 'Modèle WhatsApp requis',
  NEEDS_REVIEW: 'Vérification requise',
  CANCELLED: 'Annulé',
  SKIPPED: 'Ignoré',
};

export type StepKind = 'audio' | 'text' | 'image';

export const A2_DELAY_MIN_SECONDS = 1;
export const A2_DELAY_MAX_SECONDS = 120;
export const A2_MAX_PHOTOS = 10;
export const FREE_FORM_WINDOW_HOURS = 24;

export function formatDelay(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
