import { FREE_FORM_WINDOW_HOURS } from '@wa/shared';

export type WindowDecision =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string };

/**
 * Règle de conformité WhatsApp : un message libre (non-modèle) n'est autorisé que dans les 24 h
 * suivant le dernier message reçu du client. On ne contourne jamais cette règle.
 *  - Dernier message connu il y a > 24 h  → bloqué : « Modèle WhatsApp requis ».
 *  - Aucun message connu dans notre base :
 *      ALLOW_UNKNOWN  → autorisé ; le fournisseur refusera lui-même si la fenêtre est fermée
 *                       (erreur 131047 → marqué « Modèle WhatsApp requis »).
 *      REQUIRE_KNOWN  → bloqué tant qu'aucun message entrant récent n'est enregistré.
 */
export function checkFreeFormWindow(
  lastInboundAt: Date | null,
  policy: 'ALLOW_UNKNOWN' | 'REQUIRE_KNOWN',
  now: Date,
): WindowDecision {
  if (lastInboundAt) {
    const ageMs = now.getTime() - new Date(lastInboundAt).getTime();
    if (ageMs <= FREE_FORM_WINDOW_HOURS * 3600_000) return { allowed: true, reason: 'Fenêtre de 24 h ouverte' };
    return { allowed: false, reason: 'Dernier message du client il y a plus de 24 h : modèle WhatsApp requis' };
  }
  if (policy === 'ALLOW_UNKNOWN') {
    return { allowed: true, reason: 'Fenêtre inconnue : le fournisseur vérifiera' };
  }
  return { allowed: false, reason: 'Aucun message entrant connu : modèle WhatsApp requis' };
}
