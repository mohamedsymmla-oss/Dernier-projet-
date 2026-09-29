-- Stockage des fichiers médias dans PostgreSQL, utilisé quand aucun stockage S3/R2 n'est configuré.
-- PostgreSQL est persistant sur Railway (contrairement au disque du conteneur).
-- Table nouvelle uniquement : aucune table existante n'est modifiée.
CREATE TABLE media_blobs (
  storage_key text PRIMARY KEY,
  content_type text NOT NULL,
  data bytea NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
