import { A2_DELAY_MAX_SECONDS, A2_DELAY_MIN_SECONDS, A2_MAX_PHOTOS, type AutomationType } from '@wa/shared';
import { many, one, type DbClient } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export interface AutomationConfigRow {
  automation_type: AutomationType;
  audio_media_id: string | null;
  text1: string;
  text2: string;
  photo_media_ids: string[];
  photo_count: number;
  delay_between_contacts_seconds: number;
  window_policy: 'ALLOW_UNKNOWN' | 'REQUIRE_KNOWN';
  content_version: number;
  updated_at: Date;
}

export interface SnapshotStep {
  kind: 'audio' | 'text' | 'image' | 'template';
  label: string;
  mediaId?: string;
  mediaName?: string;
  text?: string;
  template?: { name: string; language: string };
}

export interface RunSnapshot {
  steps: SnapshotStep[];
  windowPolicy: 'ALLOW_UNKNOWN' | 'REQUIRE_KNOWN';
  delaySecondsAtStart?: number;
}

export async function getConfig(db: DbClient, type: AutomationType): Promise<AutomationConfigRow> {
  const row = await one<AutomationConfigRow>(db, 'SELECT * FROM automation_configs WHERE automation_type=$1', [type]);
  if (!row) throw new Error('Configuration introuvable');
  return row;
}

async function assertMedia(db: DbClient, id: string, kind: 'audio' | 'image') {
  const m = await one(db, 'SELECT id, kind, status, deleted_at FROM media_assets WHERE id=$1', [id]);
  if (!m || m.deleted_at) throw badRequest('Média introuvable ou supprimé');
  if (m.kind !== kind) throw badRequest(`Ce média n'est pas de type ${kind === 'audio' ? 'audio' : 'image'}`);
  if (m.status !== 'VALID') throw badRequest("Ce média n'a pas passé la validation");
}

/*
 * Chaque fonction ci-dessous ne modifie QU'UNE colonne (ou le couple texte d'A1) :
 * c'est la garantie d'isolation des réglages (ex : changer le délai ne touche jamais aux médias).
 */

export async function setAudio(db: DbClient, type: AutomationType, mediaId: string | null) {
  if (mediaId) await assertMedia(db, mediaId, 'audio');
  return one<AutomationConfigRow>(
    db,
    `UPDATE automation_configs SET audio_media_id=$2, content_version=content_version+1, updated_at=now()
     WHERE automation_type=$1 RETURNING *`,
    [type, mediaId],
  );
}

export async function setText(db: DbClient, which: 'text1' | 'text2', value: string) {
  if (value.length > 4096) throw badRequest('Texte trop long (4096 caractères maximum pour WhatsApp)');
  return one<AutomationConfigRow>(
    db,
    `UPDATE automation_configs SET ${which === 'text1' ? 'text1' : 'text2'}=$1, content_version=content_version+1, updated_at=now()
     WHERE automation_type='A1' RETURNING *`,
    [value],
  );
}

export async function setPhotos(db: DbClient, mediaIds: string[]) {
  if (mediaIds.length > A2_MAX_PHOTOS) throw badRequest(`${A2_MAX_PHOTOS} photos maximum`);
  if (new Set(mediaIds).size !== mediaIds.length) throw badRequest('La même photo est présente deux fois');
  for (const id of mediaIds) await assertMedia(db, id, 'image');
  return one<AutomationConfigRow>(
    db,
    `UPDATE automation_configs SET photo_media_ids=$1::uuid[], content_version=content_version+1, updated_at=now()
     WHERE automation_type='A2' RETURNING *`,
    [mediaIds],
  );
}

export async function setPhotoCount(db: DbClient, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > A2_MAX_PHOTOS) throw badRequest('Nombre de photos entre 1 et 10');
  return one<AutomationConfigRow>(
    db,
    `UPDATE automation_configs SET photo_count=$1, content_version=content_version+1, updated_at=now()
     WHERE automation_type='A2' RETURNING *`,
    [count],
  );
}

/** Minuteur Automation 2 : champ indépendant, n'incrémente pas la version du contenu. */
export async function setDelay(db: DbClient, seconds: number) {
  if (!Number.isInteger(seconds) || seconds < A2_DELAY_MIN_SECONDS || seconds > A2_DELAY_MAX_SECONDS) {
    throw badRequest(`Le délai doit être compris entre ${A2_DELAY_MIN_SECONDS} seconde et ${A2_DELAY_MAX_SECONDS / 60} minutes`);
  }
  return one<AutomationConfigRow>(
    db,
    `UPDATE automation_configs SET delay_between_contacts_seconds=$1, updated_at=now()
     WHERE automation_type='A2' RETURNING *`,
    [seconds],
  );
}

export async function setWindowPolicy(db: DbClient, type: AutomationType, policy: 'ALLOW_UNKNOWN' | 'REQUIRE_KNOWN') {
  return one<AutomationConfigRow>(
    db,
    `UPDATE automation_configs SET window_policy=$2, updated_at=now() WHERE automation_type=$1 RETURNING *`,
    [type, policy],
  );
}

export interface SnapshotProblem {
  field: string;
  message: string;
}

/** Construit la séquence figée d'une campagne. Lève une erreur lisible si la configuration est incomplète. */
export async function buildSnapshot(db: DbClient, type: AutomationType): Promise<{ snapshot: RunSnapshot; version: number }> {
  const cfg = await getConfig(db, type);
  const problems: SnapshotProblem[] = [];
  const ids = [cfg.audio_media_id, ...cfg.photo_media_ids].filter(Boolean) as string[];
  const media = new Map(
    (await many(db, 'SELECT id, name, kind, status, deleted_at FROM media_assets WHERE id = ANY($1::uuid[])', [ids])).map((m) => [m.id, m]),
  );
  const okMedia = (id: string | null) => {
    const m = id ? media.get(id) : null;
    return m && !m.deleted_at && m.status === 'VALID' ? m : null;
  };

  const steps: SnapshotStep[] = [];
  const audio = okMedia(cfg.audio_media_id);
  if (!audio) problems.push({ field: 'audio', message: 'Audio non configuré ou invalide' });
  else steps.push({ kind: 'audio', label: 'Audio', mediaId: audio.id, mediaName: audio.name });

  if (type === 'A1') {
    if (!cfg.text1.trim()) problems.push({ field: 'text1', message: 'Texte 1 vide' });
    if (!cfg.text2.trim()) problems.push({ field: 'text2', message: 'Texte 2 vide' });
    steps.push({ kind: 'text', label: 'Texte 1', text: cfg.text1 });
    steps.push({ kind: 'text', label: 'Texte 2', text: cfg.text2 });
  } else {
    const chosen = cfg.photo_media_ids.slice(0, cfg.photo_count);
    if (chosen.length < cfg.photo_count) {
      problems.push({ field: 'photos', message: `${cfg.photo_count} photos demandées mais ${chosen.length} configurées` });
    }
    chosen.forEach((id, i) => {
      const m = okMedia(id);
      if (!m) problems.push({ field: `photo${i + 1}`, message: `Photo ${i + 1} invalide ou supprimée` });
      else steps.push({ kind: 'image', label: `Photo ${i + 1}`, mediaId: m.id, mediaName: m.name });
    });
  }
  if (problems.length) throw badRequest('Configuration incomplète', problems);
  return {
    snapshot: {
      steps,
      windowPolicy: cfg.window_policy,
      delaySecondsAtStart: type === 'A2' ? cfg.delay_between_contacts_seconds : undefined,
    },
    version: cfg.content_version,
  };
}
