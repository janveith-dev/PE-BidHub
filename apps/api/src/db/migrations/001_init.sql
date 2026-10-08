CREATE EXTENSION IF NOT EXISTS vector;

-- Wissensbasis ----------------------------------------------------------------

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Alle Versionen desselben Dokuments teilen eine family_id.
  family_id         uuid NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  is_current        boolean NOT NULL DEFAULT true,
  title             text NOT NULL,
  category          text NOT NULL,
  vendor            text,
  tags              text[] NOT NULL DEFAULT '{}',
  language          text,
  valid_from        date,
  valid_until       date,
  filename          text NOT NULL,
  mime              text NOT NULL,
  size_bytes        bigint NOT NULL,
  sha256            text NOT NULL,
  storage_path      text NOT NULL,
  content_text      text NOT NULL,
  extraction_method text NOT NULL,
  uploaded_by_role  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_family_idx ON documents (family_id, version DESC);
CREATE INDEX documents_current_idx ON documents (is_current, category);

CREATE TABLE chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal     integer NOT NULL,
  heading     text,
  page        integer,
  content     text NOT NULL,
  -- Deutsch und Englisch gemeinsam: Unterlagen kommen in beiden Sprachen.
  tsv         tsvector GENERATED ALWAYS AS (
                to_tsvector('german', coalesce(heading, '') || ' ' || content) ||
                to_tsvector('english', coalesce(heading, '') || ' ' || content)
              ) STORED,
  -- Vektoren verschiedener Modelle sind nicht vergleichbar; gesucht wird nur im aktuellen Modell.
  embedding_model text,
  embedding   vector(384)
);
CREATE INDEX chunks_document_idx ON chunks (document_id, ordinal);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- Sales-Chat ----------------------------------------------------------------------

CREATE TABLE chat_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text NOT NULL,
  role       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  sources    jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_session_idx ON chat_messages (session_id, created_at);

-- Bid-Studio -------------------------------------------------------------------------

CREATE TABLE bids (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  customer   text NOT NULL,
  deadline   date,
  language   text NOT NULL DEFAULT 'de',
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bid_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id       uuid NOT NULL REFERENCES bids (id) ON DELETE CASCADE,
  filename     text NOT NULL,
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL,
  storage_path text NOT NULL,
  content_text text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  filename     text NOT NULL,
  storage_path text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bid_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id              uuid NOT NULL REFERENCES bids (id) ON DELETE CASCADE,
  title               text NOT NULL,
  spec_file_id        uuid REFERENCES bid_files (id) ON DELETE SET NULL,
  spec_text           text NOT NULL,
  status              text NOT NULL DEFAULT 'draft',
  analysis            jsonb,
  outline_approved_at timestamptz,
  coverage            jsonb,
  findings            jsonb,
  review_summary      text,
  template_id         uuid REFERENCES templates (id) ON DELETE SET NULL,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bid_documents_bid_idx ON bid_documents (bid_id);

CREATE TABLE bid_sections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_document_id uuid NOT NULL REFERENCES bid_documents (id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  outline_id      text NOT NULL,
  number          text NOT NULL,
  title           text NOT NULL,
  level           integer NOT NULL DEFAULT 1,
  purpose         text NOT NULL DEFAULT '',
  requirement_ids text[] NOT NULL DEFAULT '{}',
  author_role     text NOT NULL,
  target_words    integer,
  max_words       integer,
  status          text NOT NULL DEFAULT 'pending',
  facts           jsonb NOT NULL DEFAULT '[]',
  content         text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  version         integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bid_sections_doc_idx ON bid_sections (bid_document_id, ordinal);

-- Jede Fassung eines Kapitels bleibt erhalten, damit KI-Überarbeitungen zurückgenommen werden können.
CREATE TABLE bid_section_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES bid_sections (id) ON DELETE CASCADE,
  version    integer NOT NULL,
  content    text NOT NULL,
  author     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bid_section_versions_idx ON bid_section_versions (section_id, version DESC);

CREATE TABLE agent_events (
  id              bigserial PRIMARY KEY,
  bid_document_id uuid NOT NULL REFERENCES bid_documents (id) ON DELETE CASCADE,
  section_id      uuid,
  agent           text NOT NULL,
  kind            text NOT NULL,
  message         text NOT NULL,
  data            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_doc_idx ON agent_events (bid_document_id, id);
