-- ═══════════════════════════════════════════════════════════════════
-- Requirement Agent — Persistent Document Chunk Retrieval, v14
-- Run in Supabase SQL editor. DEV FIRST, then prod.
-- Per AI_EDITING_RULES.md / RA-Persistent-Doc-RAG-Spec-v14.md: NOT run by
-- Claude. Write to disk only — Nethaji runs this against Supabase on his own
-- timeline. Distinct from sql/ra-requirement-agent.sql (RQ sequence counter,
-- v9.16, unrelated) — never merge the two files.
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS mt_ra_docs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               UUID NOT NULL REFERENCES mt_sessions(id) ON DELETE CASCADE,
  conversation_id          TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 100 AND length(trim(conversation_id)) > 0),
  doc_id                   TEXT NOT NULL CHECK (length(doc_id) BETWEEN 1 AND 100 AND length(trim(doc_id)) > 0),
  doc_name                 TEXT NOT NULL CHECK (length(doc_name) BETWEEN 1 AND 300 AND length(trim(doc_name)) > 0),
  embedding_schema_version TEXT NOT NULL CHECK (length(trim(embedding_schema_version)) > 0),
  content_hash             TEXT NOT NULL,
  chunk_count              INTEGER NOT NULL CHECK (chunk_count > 0),
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  removed_at               TIMESTAMPTZ,
  -- NOT NULL is intentional and permanent for this build (see D9):
  -- tombstone metadata is retained in full, never partially scrubbed.
  -- Do not widen these to nullable without a corresponding governance
  -- decision that actually requires it (D9's retention discussion).
  CONSTRAINT mt_ra_docs_lifecycle_consistency CHECK (
    (status = 'active'  AND removed_at IS NULL) OR
    (status = 'removed' AND removed_at IS NOT NULL)
  ),
  UNIQUE (session_id, conversation_id, doc_id)
);

CREATE INDEX IF NOT EXISTS mt_ra_docs_session_conv_idx ON mt_ra_docs (session_id, conversation_id);
CREATE INDEX IF NOT EXISTS mt_ra_docs_active_idx ON mt_ra_docs (session_id, conversation_id) WHERE status = 'active';

ALTER TABLE mt_ra_docs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ra_docs FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS mt_ra_doc_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ra_doc_id     UUID NOT NULL REFERENCES mt_ra_docs(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_text    TEXT NOT NULL CHECK (length(chunk_text) BETWEEN 1 AND 4000 AND length(trim(chunk_text)) > 0),
  embedding     vector(1536) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ra_doc_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS mt_ra_doc_chunks_doc_idx ON mt_ra_doc_chunks (ra_doc_id);

ALTER TABLE mt_ra_doc_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ra_doc_chunks FROM anon, authenticated;

CREATE OR REPLACE FUNCTION _ra_is_authorized(
  p_session_id      UUID,
  p_conversation_id TEXT,
  p_require_write   BOOLEAN
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mt_sessions s
    JOIN mt_users_companies uc ON uc.company_id = s.company_id
    WHERE s.id = p_session_id
      AND s.user_id = current_app_user()
      AND uc.user_id = current_app_user()
      AND uc.is_active
      AND (NOT p_require_write OR uc.role <> 'readonly')
  ) AND EXISTS (
    SELECT 1 FROM mt_sessions s,
      jsonb_array_elements(COALESCE(s.snapshot->'raConversations','[]'::jsonb)) conv
    WHERE s.id = p_session_id AND conv->>'id' = p_conversation_id
  );
$$;

REVOKE EXECUTE ON FUNCTION _ra_is_authorized(UUID,TEXT,BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION ra_ingest_document_chunks(
  p_session_id               UUID,
  p_conversation_id          TEXT,
  p_doc_id                   TEXT,
  p_doc_name                 TEXT,
  p_embedding_schema_version TEXT,
  p_chunks                   JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_doc_id       UUID;
  v_chunk        JSONB;
  v_idx          INTEGER := 0;
  v_got_lock     BOOLEAN;
  v_existing     RECORD;
  v_content_hash TEXT;
BEGIN
  IF NOT _ra_is_authorized(p_session_id, p_conversation_id, true) THEN
    RAISE EXCEPTION 'Not authorized to ingest documents for session %', p_session_id;
  END IF;

  IF jsonb_array_length(p_chunks) = 0 OR jsonb_array_length(p_chunks) > 200 THEN
    RAISE EXCEPTION 'Chunk count out of bounds for document %', p_doc_name;
  END IF;

  v_got_lock := pg_try_advisory_xact_lock(hashtext('ra_doc_lock:' || p_session_id::text), hashtext(p_conversation_id));
  IF NOT v_got_lock THEN
    RAISE EXCEPTION 'Another document operation is already in progress for this conversation — try again shortly';
  END IF;

  -- CORRECTED COMMENT (v11): the canonical JSON encoding (jsonb_agg
  -- properly delimits each array element) eliminates the specific
  -- structural ambiguity that broke the prior delimiter-free
  -- concatenation -- e.g. "ab"+"c" and "a"+"bc" now produce genuinely
  -- different pre-hash input. This does not make an md5 digest collision
  -- mathematically impossible; it is not claimed to, and does not need
  -- to be, since this hash is a deduplication check, not a security
  -- boundary. Also explicit by design: embedding VECTORS are
  -- deliberately excluded from this fingerprint. Only schema_version +
  -- ordered chunk TEXT are hashed. A retry with identical text/schema
  -- but numerically different embeddings (embedding APIs are not
  -- always byte-deterministic) is still treated as the same idempotent
  -- upload -- whichever embeddings committed first are retained; the
  -- retry's newly-computed embeddings are discarded, not compared.
  SELECT md5(
    jsonb_build_object(
      'schema', p_embedding_schema_version,
      'chunks', jsonb_agg(c->>'chunk_text' ORDER BY ord)
    )::text
  ) INTO v_content_hash
  FROM jsonb_array_elements(p_chunks) WITH ORDINALITY AS t(c, ord);

  SELECT id, status, content_hash INTO v_existing
  FROM mt_ra_docs
  WHERE session_id = p_session_id AND conversation_id = p_conversation_id AND doc_id = p_doc_id
    AND _ra_is_authorized(p_session_id, p_conversation_id, true);

  IF v_existing.id IS NOT NULL THEN
    IF v_existing.status = 'removed' THEN
      RAISE EXCEPTION 'This document was previously removed and cannot be re-ingested under the same upload identity — upload it again as a new document';
    ELSIF v_existing.content_hash = v_content_hash THEN
      -- doc_name is deliberately NOT part of content_hash (display
      -- metadata only, per D4/v12). A retry with a different p_doc_name
      -- but identical schema+text still lands here and is treated as
      -- the same upload -- the ORIGINAL committed doc_name (already in
      -- the row) is what remains stored; p_doc_name from this retry is
      -- silently ignored, never used to update the existing row.
      RETURN v_existing.id;
    ELSE
      RAISE EXCEPTION 'Upload identity % was already used for different content — this indicates a client retry bug, not a legitimate re-upload', p_doc_id;
    END IF;
  END IF;

  IF (SELECT count(*) FROM mt_ra_docs
      WHERE session_id = p_session_id AND conversation_id = p_conversation_id AND status = 'active') >= 5 THEN
    RAISE EXCEPTION 'Maximum 5 documents per conversation reached';
  END IF;

  INSERT INTO mt_ra_docs (session_id, conversation_id, doc_id, doc_name, embedding_schema_version, chunk_count, content_hash, status)
  SELECT p_session_id, p_conversation_id, p_doc_id, p_doc_name, p_embedding_schema_version, jsonb_array_length(p_chunks), v_content_hash, 'active'
  WHERE _ra_is_authorized(p_session_id, p_conversation_id, true)
  RETURNING id INTO v_doc_id;

  IF v_doc_id IS NULL THEN
    RAISE EXCEPTION 'Ingestion rejected for session % — not authorized', p_session_id;
  END IF;

  FOR v_chunk IN SELECT * FROM jsonb_array_elements(p_chunks)
  LOOP
    INSERT INTO mt_ra_doc_chunks (ra_doc_id, chunk_index, chunk_text, embedding)
    VALUES (v_doc_id, v_idx, v_chunk->>'chunk_text', (v_chunk->>'embedding')::vector);
    v_idx := v_idx + 1;
  END LOOP;

  RETURN v_doc_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION ra_ingest_document_chunks(UUID,TEXT,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ra_ingest_document_chunks(UUID,TEXT,TEXT,TEXT,TEXT,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION ra_remove_document(
  p_session_id      UUID,
  p_conversation_id TEXT,
  p_doc_id          TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_got_lock        BOOLEAN;
  v_current_status  TEXT;
  v_removed_id      UUID;
BEGIN
  IF NOT _ra_is_authorized(p_session_id, p_conversation_id, true) THEN
    RAISE EXCEPTION 'Not authorized to remove documents for session %', p_session_id;
  END IF;

  v_got_lock := pg_try_advisory_xact_lock(hashtext('ra_doc_lock:' || p_session_id::text), hashtext(p_conversation_id));
  IF NOT v_got_lock THEN
    RAISE EXCEPTION 'Another document operation is already in progress for this conversation — try again shortly';
  END IF;

  SELECT status INTO v_current_status
  FROM mt_ra_docs
  WHERE session_id = p_session_id AND conversation_id = p_conversation_id AND doc_id = p_doc_id
    AND _ra_is_authorized(p_session_id, p_conversation_id, true);

  IF v_current_status IS NULL THEN
    RETURN FALSE;
  ELSIF v_current_status = 'removed' THEN
    RETURN TRUE;
  END IF;

  UPDATE mt_ra_docs
  SET status = 'removed', removed_at = NOW()
  WHERE session_id = p_session_id AND conversation_id = p_conversation_id AND doc_id = p_doc_id
    AND status = 'active'
    AND _ra_is_authorized(p_session_id, p_conversation_id, true)
  RETURNING id INTO v_removed_id;

  IF v_removed_id IS NOT NULL THEN
    DELETE FROM mt_ra_doc_chunks WHERE ra_doc_id = v_removed_id;
  END IF;

  RETURN v_removed_id IS NOT NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION ra_remove_document(UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ra_remove_document(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION ra_list_documents(
  p_session_id      UUID,
  p_conversation_id TEXT
) RETURNS TABLE (doc_id TEXT, doc_name TEXT, created_at TIMESTAMPTZ, embedding_schema_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT _ra_is_authorized(p_session_id, p_conversation_id, false) THEN
    RAISE EXCEPTION 'Not authorized for session %', p_session_id;
  END IF;

  RETURN QUERY
  SELECT d.doc_id, d.doc_name, d.created_at, d.embedding_schema_version
  FROM mt_ra_docs d
  WHERE d.session_id = p_session_id AND d.conversation_id = p_conversation_id AND d.status = 'active'
    AND _ra_is_authorized(p_session_id, p_conversation_id, false)
  ORDER BY d.created_at ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION ra_list_documents(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ra_list_documents(UUID,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION ra_search_doc_chunks(
  p_session_id             UUID,
  p_conversation_id        TEXT,
  p_query_embedding        vector(1536),
  p_current_schema_version TEXT,
  p_limit                  INTEGER DEFAULT 4
) RETURNS TABLE (chunk_text TEXT, doc_name TEXT, doc_id TEXT, chunk_index INTEGER, similarity FLOAT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit,4),1),10);
BEGIN
  IF NOT _ra_is_authorized(p_session_id, p_conversation_id, true) THEN
    RAISE EXCEPTION 'Not authorized to search document chunks for session %', p_session_id;
  END IF;

  RETURN QUERY
  SELECT c.chunk_text, d.doc_name, d.doc_id, c.chunk_index,
         1 - (c.embedding <=> p_query_embedding) AS similarity
  FROM mt_ra_docs d
  JOIN mt_ra_doc_chunks c ON c.ra_doc_id = d.id
  WHERE d.session_id = p_session_id
    AND d.conversation_id = p_conversation_id
    AND d.status = 'active'
    AND d.embedding_schema_version = p_current_schema_version
    AND _ra_is_authorized(p_session_id, p_conversation_id, true)
  ORDER BY c.embedding <=> p_query_embedding
  LIMIT v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION ra_search_doc_chunks(UUID,TEXT,vector,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ra_search_doc_chunks(UUID,TEXT,vector,TEXT,INTEGER) TO authenticated;

-- ─── Post-flight verification ───
-- SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- SELECT proname, prosecdef FROM pg_proc WHERE proname LIKE 'ra_%' OR proname = '_ra_is_authorized';
-- SELECT has_function_privilege('anon','_ra_is_authorized(UUID,TEXT,BOOLEAN)','EXECUTE'); -- expect false
-- SELECT has_table_privilege('anon','mt_ra_docs','SELECT'); -- expect false
--
-- All v10 matrix-fix and concurrency tests apply unchanged. New in v11:
-- 1. Same payload submitted twice -- confirm content_hash is IDENTICAL
--    both times (canonical encoding is deterministic).
-- 2. ["ab","c"] vs ["a","bc"] as two separate chunk arrays -- confirm
--    DIFFERENT content_hash (already in v10's plan, re-confirm here).
-- 3. Same doc_id, same chunk text, same schema version, but DIFFERENT
--    embedding vectors on the retry -- confirm this is treated as
--    idempotent (existing row returned), and confirm the FIRST
--    committed embeddings are what's actually stored, not the retry's.
-- 4. Remove a document; confirm BOTH: status='removed' AND removed_at
--    IS NOT NULL in the row, AND zero rows remain in mt_ra_doc_chunks
--    for that ra_doc_id (the CHECK constraint only enforces the first
--    half; the second half is a cross-table invariant the RPC
--    guarantees transactionally and must be tested explicitly).
-- 5. With ~1,000 removed (tombstoned) rows and 4 active rows in one
--    conversation, run EXPLAIN ANALYZE on ra_list_documents,
--    ra_search_doc_chunks, and the active-count check inside
--    ra_ingest_document_chunks -- confirm the partial index is used,
--    not a full scan across all tombstones.

-- ═══════════════════════════════════════════════════════════════════
-- NEW IN v14 — orphan reconciliation, closing the raResetState() gap
-- ═══════════════════════════════════════════════════════════════════

-- ── A fifth function. Deliberately does NOT reuse _ra_is_authorized(),
--    because that function's conversation-existence check would make it
--    impossible to use here — this function's entire purpose is finding
--    documents whose conversation no longer exists. Its authorization
--    check is session-level only: does the caller own this session with
--    active, non-readonly membership. It never touches or reveals
--    anything about a specific conversation's existence, so there is no
--    information-disclosure concern in checking session-level access
--    alone.
--    Safe to call repeatedly (idempotent — a document already purged
--    simply won't match the WHERE clause on a later call). Safe to call
--    on any session at any time, including one with no orphans at all
--    (returns 0). Uses the SAME advisory lock key scheme as ingestion
--    and removal, so it can never race a concurrent ingest or removal
--    for the same (session, conversation) pair -- though by construction,
--    if a conversation_id is confirmed absent from the snapshot at the
--    moment this runs, no new ingest could be authorized against it
--    either, so this is defense-in-depth, not a live race this function
--    is actually exposed to in practice.
CREATE OR REPLACE FUNCTION ra_purge_orphaned_documents(
  p_session_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller        UUID := current_app_user();
  v_purged_count  INTEGER := 0;
  v_doc           RECORD;
  v_updated_id    UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mt_sessions s
    JOIN mt_users_companies uc ON uc.company_id = s.company_id
    WHERE s.id = p_session_id
      AND s.user_id = v_caller
      AND uc.user_id = v_caller
      AND uc.is_active
      AND uc.role <> 'readonly'
  ) THEN
    RAISE EXCEPTION 'Not authorized for session %', p_session_id;
  END IF;

  FOR v_doc IN
    SELECT d.id, d.conversation_id
    FROM mt_ra_docs d
    WHERE d.session_id = p_session_id
      AND d.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM mt_sessions s,
          jsonb_array_elements(COALESCE(s.snapshot->'raConversations','[]'::jsonb)) conv
        WHERE s.id = p_session_id AND conv->>'id' = d.conversation_id
      )
  LOOP
    -- Non-blocking, per-conversation: if a lock can't be acquired for
    -- this specific orphan right now (vanishingly unlikely given the
    -- conversation is already confirmed gone), skip it this pass -- it
    -- remains active and orphaned, and will be caught on the next call
    -- to this function, since nothing here permanently gives up on it.
    IF pg_try_advisory_xact_lock(hashtext('ra_doc_lock:' || p_session_id::text), hashtext(v_doc.conversation_id)) THEN
      -- v14 code-review fix (round 2 -- the round-1 fix below had two real
      -- gaps of its own, caught on re-review):
      -- (a) status = 'active' is now required in this WHERE, matching
      --     ra_remove_document's own destructive UPDATE exactly. Without
      --     it, two overlapping purge calls could both match the SAME
      --     already-orphaned document across two transactions (the second
      --     call's loop query ran its SELECT before the first call's
      --     UPDATE committed, so its snapshot still shows status='active') --
      --     the second call would then re-set removed_at, clobbering the
      --     real tombstone timestamp, and both calls would count the same
      --     document as purged, double-reporting v_purged_count. The
      --     advisory lock does not prevent this: it only serializes the two
      --     calls' critical sections, it doesn't stop the second one from
      --     acting on a stale pre-lock snapshot once it's finally granted
      --     the lock after the first call already committed and released it.
      -- (b) session_id = p_session_id is now required too -- the EXISTS
      --     below checks "is the caller authorized for SOME session",
      --     never that row v_doc.id actually BELONGS to that session. The
      --     only thing tying the two together was the loop's own SELECT
      --     (line ~377) -- correct today, but silently disarmed by any
      --     future edit to that query. Binding it directly in the mutating
      --     statement's own WHERE, matching ra_next_seq's row-correlated
      --     EXISTS pattern (sql/ra-requirement-agent.sql), removes that
      --     dependency entirely.
      -- Chunks are only deleted if the UPDATE actually affected a row.
      UPDATE mt_ra_docs
      SET status = 'removed', removed_at = NOW()
      WHERE id = v_doc.id
        AND session_id = p_session_id
        AND status = 'active'
        AND EXISTS (
          SELECT 1 FROM mt_sessions s
          JOIN mt_users_companies uc ON uc.company_id = s.company_id
          WHERE s.id = p_session_id AND s.user_id = v_caller
            AND uc.user_id = v_caller AND uc.is_active AND uc.role <> 'readonly'
        )
      RETURNING id INTO v_updated_id;

      IF v_updated_id IS NOT NULL THEN
        DELETE FROM mt_ra_doc_chunks WHERE ra_doc_id = v_updated_id;
        v_purged_count := v_purged_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_purged_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION ra_purge_orphaned_documents(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION ra_purge_orphaned_documents(UUID) TO authenticated;

-- ─── Post-flight tests, new in v14 ───
-- 1. Ingest a document for conversation X. Directly remove X from the
--    session's raConversations array (simulating what raResetState()
--    does) WITHOUT calling ra_remove_document first. Confirm the
--    document is now unreachable via ra_list_documents/ra_search (as
--    already guaranteed) but still physically present with
--    status='active'.
-- 2. Call ra_purge_orphaned_documents() for that session. Confirm it
--    returns 1, and confirm the document's row now shows
--    status='removed', removed_at set, and zero chunk rows remain.
-- 3. Call it again immediately. Confirm it returns 0 (idempotent,
--    nothing left to purge).
-- 4. Non-owner calls this function against a session they don't own —
--    expect an exception, same as every other function. Note: this test
--    only exercises the top-of-function check (step ~1 in the function
--    body) — the row-level EXISTS inside the loop's UPDATE is defense-in-
--    depth for a same-transaction TOCTOU window (membership revoked mid-
--    call) that this test does not and cannot reach through the RPC
--    surface alone; do not treat this test as covering that guard.
-- 5. A session with zero RA documents at all — confirm it returns 0
--    without error.
-- 6. NEW (round 2 code-review fix) — orphan two conversations' documents
--    in the same session, call this function once, confirm v_purged_count
--    equals 2 (not 1), both rows show status='removed' with removed_at
--    set, and both documents' chunks are gone.
-- 7. NEW (round 2 code-review fix) — concurrency: orphan one document,
--    then fire two overlapping calls to ra_purge_orphaned_documents() for
--    the same session (e.g. two separate connections, timed so the second
--    call's SELECT runs before the first call's UPDATE commits). Confirm
--    the document is purged exactly once: the SUM of both calls'
--    v_purged_count is 1 (not 2), and removed_at reflects only the FIRST
--    transaction's timestamp, never overwritten by the second. This is the
--    scenario the status='active' predicate in the destructive UPDATE
--    exists to close — confirm it actually does.
