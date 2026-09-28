-- Canal « WhatsApp QR » (appareil lié, Baileys), totalement séparé du canal fournisseur (SendZen).
-- Les données existantes ne sont ni supprimées ni recréées : chaque table partagée reçoit une colonne
-- `channel` dont la valeur par défaut 'PROVIDER' conserve exactement le comportement actuel.

-- 1. Réglages d'automatisation : un jeu séparé par canal
ALTER TABLE automation_configs ADD COLUMN channel text NOT NULL DEFAULT 'PROVIDER'
  CHECK (channel IN ('PROVIDER', 'QR'));
ALTER TABLE automation_configs DROP CONSTRAINT automation_configs_pkey;
ALTER TABLE automation_configs ADD PRIMARY KEY (channel, automation_type);
-- Côté QR, Automation 1 est aussi traitée un contact à la fois : délai par défaut 60 s.
INSERT INTO automation_configs (channel, automation_type, delay_between_contacts_seconds)
VALUES ('QR', 'A1', 60), ('QR', 'A2', 60);

-- 2. Campagnes, destinataires, imports, présets : étiquetés par canal
ALTER TABLE automation_runs ADD COLUMN channel text NOT NULL DEFAULT 'PROVIDER' CHECK (channel IN ('PROVIDER', 'QR'));
DROP INDEX automation_runs_one_active;
CREATE UNIQUE INDEX automation_runs_one_active ON automation_runs(channel, automation_type, kind)
  WHERE status IN ('RUNNING', 'PAUSED') AND kind <> 'TEST';
ALTER TABLE automation_recipients ADD COLUMN channel text NOT NULL DEFAULT 'PROVIDER' CHECK (channel IN ('PROVIDER', 'QR'));
ALTER TABLE contact_imports ADD COLUMN channel text NOT NULL DEFAULT 'PROVIDER' CHECK (channel IN ('PROVIDER', 'QR'));
ALTER TABLE saved_presets ADD COLUMN channel text NOT NULL DEFAULT 'PROVIDER' CHECK (channel IN ('PROVIDER', 'QR'));
ALTER TABLE saved_presets DROP CONSTRAINT saved_presets_automation_type_name_key;
ALTER TABLE saved_presets ADD CONSTRAINT saved_presets_channel_type_name_key UNIQUE (channel, automation_type, name);

-- 3. Session QR (une seule session active). La connexion associée est une ligne provider_connections
--    avec provider = 'qr' (aucune clé API) : les envois et l'historique réutilisent le même moteur.
CREATE TABLE qr_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL UNIQUE REFERENCES provider_connections(id),
  status text NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (status IN ('WAITING_SCAN', 'CONNECTING', 'CONNECTED', 'DISCONNECTED', 'LOGGED_OUT')),
  desired_state text NOT NULL DEFAULT 'STOPPED' CHECK (desired_state IN ('RUNNING', 'STOPPED')),
  qr text,
  qr_updated_at timestamptz,
  phone_number text,
  push_name text,
  paired_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_disconnect_code int,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- État d'authentification Baileys : chaque valeur chiffrée (AES-256-GCM, ENCRYPTION_KEY). Aucun fichier local.
CREATE TABLE qr_auth (
  session_id uuid NOT NULL REFERENCES qr_sessions(id) ON DELETE CASCADE,
  key text NOT NULL,
  value_enc text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, key)
);

-- 4. Statuts des contacts côté QR (le côté fournisseur garde ses colonnes dans `contacts`)
CREATE TABLE qr_contact_status (
  contact_id uuid PRIMARY KEY REFERENCES contacts(id),
  a1_status text NOT NULL DEFAULT 'NONE',
  a1_first_sent_at timestamptz,
  a1_completed_at timestamptz,
  a1_run_id uuid,
  responded_after_a1 boolean NOT NULL DEFAULT false,
  responded_after_a1_at timestamptz,
  responded_after_a1_message_id text,
  responded_after_a1_message_type text,
  a2_status text NOT NULL DEFAULT 'NONE',
  a2_first_sent_at timestamptz,
  a2_completed_at timestamptz,
  a2_run_id uuid,
  last_inbound_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON qr_contact_status(responded_after_a1) WHERE responded_after_a1;

-- 5. Protection du numéro : plafonds, heures calmes, montée progressive, arrêt d'urgence
CREATE TABLE qr_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  daily_message_cap int NOT NULL DEFAULT 150 CHECK (daily_message_cap BETWEEN 1 AND 5000),
  quiet_hours_enabled boolean NOT NULL DEFAULT true,
  quiet_start time NOT NULL DEFAULT '21:00',
  quiet_end time NOT NULL DEFAULT '08:00',
  timezone text NOT NULL DEFAULT 'Africa/Bamako',
  warmup_days int NOT NULL DEFAULT 7 CHECK (warmup_days BETWEEN 0 AND 60),
  typing_simulation boolean NOT NULL DEFAULT true,
  emergency_stopped boolean NOT NULL DEFAULT false,
  emergency_reason text,
  emergency_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO qr_settings (id) VALUES (1);

-- 6. Journal des connexions / déconnexions / erreurs de la session QR
CREATE TABLE qr_events (
  id bigserial PRIMARY KEY,
  session_id uuid REFERENCES qr_sessions(id) ON DELETE SET NULL,
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON qr_events(created_at DESC);

-- 7. Audios convertis en OGG/Opus (message vocal) mis en cache : pas besoin de stockage S3
CREATE TABLE qr_media_cache (
  media_id uuid NOT NULL REFERENCES media_assets(id),
  variant text NOT NULL,
  data bytea NOT NULL,
  mime text NOT NULL,
  seconds int,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, variant)
);
