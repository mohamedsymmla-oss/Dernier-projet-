/**
 * Abstraction des files d'attente utilisée par le moteur.
 * Implémentation production : BullMQ/Redis (queues.ts). Tests : implémentation mémoire.
 */
export interface JobScheduler {
  /** Automatisation 1 : un job par destinataire (concurrence contrôlée). */
  enqueueRecipient(runId: string, recipientId: string, epoch: number): Promise<void>;
  /** Automatisation 2 : un seul « tick » programmé à la fois, séquentiel. */
  scheduleA2Tick(runId: string, seq: number, delayMs: number): Promise<void>;
  enqueueWebhookEvent(eventId: string): Promise<void>;
}
