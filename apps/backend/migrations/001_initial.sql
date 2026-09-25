-- Schéma initial. PostgreSQL est la source de vérité permanente :
-- l'état de chaque campagne peut être reconstruit sans Redis.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  ip text
);
CREATE INDEX ON user_sessions(user_id);

CREATE TABLE provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  label text NOT NULL,
  mode text NOT NULL DEFAULT 'PRODUCTION' CHECK (mode IN ('PRODUCTION', 'TEST')),
  status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('UNVERIFIED', 'CONNECTED', 'ERROR', 'DISCONNECTED')),
  status_detail text,
  api_key_enc text,
  api_key_hint text,
  webhook_secret_enc text,
  webhook_secret_hint text,
  api_base_url text,
  project_id text,
  project_name text,
  waba_id text,
  waba_name text,
  phone_number_id text,
  phone_number text,
  number_status text,
  last_test_at timestamptz,
  last_test_result jsonb,
  last_webhook_at timestamptz,
  last_webhook_verified boolean,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz
);

-- Identité durable d'un numéro WhatsApp : survit aux reconnexions.
CREATE TABLE whatsapp_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL UNIQUE,
  provider text NOT NULL,
  phone_number_id text,
  waba_id text,
  project_id text,
  status text,
  last_connection_id uuid REFERENCES provider_connections(id),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_connection_id uuid REFERENCES provider_connections(id),
  test_phone_e164 text,
  default_country text NOT NULL DEFAULT 'ML',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('audio', 'image')),
  source text NOT NULL CHECK (source IN ('upload', 'url')),
  name text NOT NULL,
  storage_key text,
  external_url text,
  mime text,
  extension text,
  size_bytes bigint,
  duration_ms int,
  width int,
  height int,
  sha256 text,
  status text NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'INVALID')),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  derived_from uuid REFERENCES media_assets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON media_assets(kind) WHERE deleted_at IS NULL;

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  first_import_id uuid,
  last_inbound_at timestamptz,
  last_inbound_message_id text,
  last_inbound_type text,
  last_inbound_text text,
  last_reply_at timestamptz,
  a1_status text NOT NULL DEFAULT 'NONE',
  a1_first_sent_at timestamptz,
  a1_completed_at timestamptz,
  a1_run_id uuid,
  responded_after_a1 boolean NOT NULL DEFAULT false,
  responded_after_a1_at timestamptz,
  responded_after_a1_message_id text,
  responded_after_a1_message_type text,
  responded_after_a1_connection_id uuid,
  a2_status text NOT NULL DEFAULT 'NONE',
  a2_first_sent_at timestamptz,
  a2_completed_at timestamptz,
  a2_run_id uuid,
  last_error text
);
CREATE INDEX ON contacts(responded_after_a1) WHERE responded_after_a1;

CREATE TABLE contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_type text CHECK (automation_type IN ('A1', 'A2')),
  source text NOT NULL CHECK (source IN ('paste', 'csv', 'txt', 'responders')),
  filename text,
  default_country text,
  total_lines int NOT NULL DEFAULT 0,
  valid_count int NOT NULL DEFAULT 0,
  invalid_count int NOT NULL DEFAULT 0,
  duplicate_count int NOT NULL DEFAULT 0,
  empty_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE contacts ADD CONSTRAINT contacts_first_import_fk FOREIGN KEY (first_import_id) REFERENCES contact_imports(id);

CREATE TABLE contact_import_items (
  id bigserial PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  line_number int NOT NULL,
  raw_value text NOT NULL,
  status text NOT NULL CHECK (status IN ('VALID', 'INVALID', 'DUPLICATE_IN_LIST', 'EMPTY')),
  phone_e164 text,
  reason text,
  contact_id uuid REFERENCES contacts(id)
);
CREATE INDEX ON contact_import_items(import_id, status);

-- Réglages : une ligne par automatisation, chaque champ modifié indépendamment.
CREATE TABLE automation_configs (
  automation_type text PRIMARY KEY CHECK (automation_type IN ('A1', 'A2')),
  audio_media_id uuid REFERENCES media_assets(id),
  text1 text NOT NULL DEFAULT '',
  text2 text NOT NULL DEFAULT '',
  photo_media_ids uuid[] NOT NULL DEFAULT '{}',
  photo_count int NOT NULL DEFAULT 7 CHECK (photo_count BETWEEN 1 AND 10),
  delay_between_contacts_seconds int NOT NULL DEFAULT 60 CHECK (delay_between_contacts_seconds BETWEEN 1 AND 120),
  window_policy text NOT NULL DEFAULT 'ALLOW_UNKNOWN' CHECK (window_policy IN ('ALLOW_UNKNOWN', 'REQUIRE_KNOWN')),
  content_version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO automation_configs (automation_type) VALUES ('A1'), ('A2');

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_type text NOT NULL CHECK (automation_type IN ('A1', 'A2')),
  kind text NOT NULL DEFAULT 'SEQUENCE' CHECK (kind IN ('SEQUENCE', 'TEMPLATE', 'TEST')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED')),
  mode text NOT NULL CHECK (mode IN ('PRODUCTION', 'TEST')),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  whatsapp_number_id uuid REFERENCES whatsapp_numbers(id),
  sender_phone text NOT NULL,
  client_request_id text NOT NULL UNIQUE,
  import_id uuid REFERENCES contact_imports(id),
  config_snapshot jsonb NOT NULL,
  content_version int NOT NULL,
  total int NOT NULL DEFAULT 0,
  epoch int NOT NULL DEFAULT 1,
  tick_seq int NOT NULL DEFAULT 0,
  current_recipient_id uuid,
  last_contact_finished_at timestamptz,
  pause_reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  paused_at timestamptz,
  stopped_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Une seule campagne active par automatisation (hors tests) : un double clic ne crée pas deux campagnes.
CREATE UNIQUE INDEX automation_runs_one_active ON automation_runs(automation_type, kind)
  WHERE status IN ('RUNNING', 'PAUSED') AND kind <> 'TEST';
CREATE INDEX ON automation_runs(status);

CREATE TABLE automation_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES automation_runs(id),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  phone_e164 text NOT NULL,
  automation_type text NOT NULL,
  -- Clé d'idempotence : un contact ne reçoit jamais deux fois la même automatisation (par mode).
  idempotency_key text NOT NULL UNIQUE,
  position int NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  content_version int NOT NULL,
  lease_until timestamptz,
  delivery_failed boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  last_error_kind text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON automation_recipients(run_id, status, position);
CREATE INDEX ON automation_recipients(contact_id);

CREATE TABLE automation_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES automation_recipients(id) ON DELETE CASCADE,
  step_index int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('audio', 'text', 'image', 'template')),
  label text NOT NULL,
  media_id uuid REFERENCES media_assets(id),
  text_body text,
  template jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUBMITTING', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'SKIPPED')),
  attempts int NOT NULL DEFAULT 0,
  outbound_message_id uuid,
  last_error text,
  last_error_kind text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, step_index)
);

CREATE TABLE outbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  provider text NOT NULL,
  provider_message_id text UNIQUE,
  run_id uuid REFERENCES automation_runs(id),
  recipient_id uuid REFERENCES automation_recipients(id),
  step_id uuid REFERENCES automation_steps(id),
  contact_id uuid REFERENCES contacts(id),
  to_phone text NOT NULL,
  kind text NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'QUEUED',
  attempt int NOT NULL DEFAULT 1,
  http_status int,
  request_id text,
  error_code text,
  error_message text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON outbound_messages(recipient_id);
CREATE INDEX ON outbound_messages(contact_id);
CREATE INDEX ON outbound_messages(status);
ALTER TABLE automation_steps ADD CONSTRAINT steps_outbound_fk FOREIGN KEY (outbound_message_id) REFERENCES outbound_messages(id);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES provider_connections(id),
  provider text NOT NULL,
  source text NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook', 'logs_sync')),
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_verified boolean NOT NULL DEFAULT false,
  verification_note text,
  duplicate_count int NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  process_status text NOT NULL DEFAULT 'PENDING' CHECK (process_status IN ('PENDING', 'PROCESSED', 'FAILED')),
  processed_at timestamptz,
  process_error text,
  event_count int
);
CREATE INDEX ON webhook_events(process_status) WHERE process_status <> 'PROCESSED';
CREATE INDEX ON webhook_events(received_at DESC);

CREATE TABLE inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  provider_message_id text NOT NULL,
  connection_id uuid REFERENCES provider_connections(id),
  webhook_event_id uuid REFERENCES webhook_events(id),
  contact_id uuid REFERENCES contacts(id),
  from_phone text NOT NULL,
  to_phone_number_id text,
  message_type text NOT NULL,
  text text,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb
);
CREATE INDEX ON inbound_messages(contact_id, received_at DESC);

CREATE TABLE message_status_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  provider_message_id text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  error_code text,
  error_message text,
  webhook_event_id uuid REFERENCES webhook_events(id),
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON message_status_events(provider_message_id);

CREATE TABLE queue_jobs (
  id bigserial PRIMARY KEY,
  queue text NOT NULL,
  job_id text NOT NULL,
  run_id uuid,
  recipient_id uuid,
  status text NOT NULL DEFAULT 'QUEUED',
  scheduled_for timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue, job_id)
);

CREATE TABLE provider_logs (
  id bigserial PRIMARY KEY,
  connection_id uuid,
  provider text NOT NULL,
  method text NOT NULL,
  endpoint text NOT NULL,
  http_status int,
  request_id text,
  provider_message_id text,
  error text,
  attempt int,
  duration_ms int,
  run_id uuid,
  recipient_id uuid,
  step_id uuid,
  response_snippet text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON provider_logs(created_at DESC);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs(created_at DESC);
CREATE INDEX ON audit_logs(entity_type, entity_id);

CREATE TABLE saved_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_type text NOT NULL CHECK (automation_type IN ('A1', 'A2')),
  name text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_type, name)
);

CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  status text NOT NULL,
  since timestamptz,
  pages int NOT NULL DEFAULT 0,
  fetched int NOT NULL DEFAULT 0,
  new_events int NOT NULL DEFAULT 0,
  duplicates int NOT NULL DEFAULT 0,
  reprocessed int NOT NULL DEFAULT 0,
  detail text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
