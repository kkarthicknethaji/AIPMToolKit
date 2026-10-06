-- AI Cost Control Tower: AI Trace Layer — schema migration
-- Source: ai-trace-layer-spec-v0.11-final.md, Parts B.1, B.2, B.4, B.5, B.6.
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify every step below,
-- THEN prod (pgt-prod). Per this project's convention: not run by Claude
-- Code, executed manually.
--
-- Deliberately excludes mt_ai_trace_payloads (spec Part B.3) and its RPC
-- surface: the spec's own Part D.7 requires credential scopes, a
-- payload_capture_enabled toggle, and a purge mechanism to exist before
-- that table's write path is enabled for any real credential, and none of
-- those are built yet. Add it as its own, later migration once that
-- infrastructure is designed.
--
-- Run each numbered step individually and confirm its expected result
-- before moving to the next.

-- ═══════════════════════════════════════════════════════════════════
-- STEP 1 — mt_ai_traces: one row per traced conversation
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mt_ai_traces (
  trace_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES mt_companies(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES mt_apps(app_id),
  product_id      UUID,
  session_id      UUID,
  outcome_id      UUID REFERENCES mt_outcomes(outcome_id) ON DELETE SET NULL,
  agent_name      TEXT NOT NULL,
  client_trace_id TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  UNIQUE (company_id, app_id, client_trace_id)
);

CREATE INDEX IF NOT EXISTS mt_ai_traces_company_agent_idx
  ON mt_ai_traces (company_id, agent_name, started_at);
CREATE INDEX IF NOT EXISTS mt_ai_traces_product_idx ON mt_ai_traces (product_id);
CREATE INDEX IF NOT EXISTS mt_ai_traces_outcome_idx ON mt_ai_traces (outcome_id);

ALTER TABLE mt_ai_traces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ai_traces FROM anon, authenticated, PUBLIC;

-- Verify: expect one row describing mt_ai_traces with 10 columns.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_traces'
ORDER BY ordinal_position;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 2 — mt_ai_spans: one row per traced call (llm_call or tool_call)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS mt_ai_spans (
  span_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id         UUID NOT NULL REFERENCES mt_ai_traces(trace_id) ON DELETE CASCADE,
  parent_span_id   UUID REFERENCES mt_ai_spans(span_id) ON DELETE SET NULL,
  span_type        TEXT NOT NULL CHECK (span_type IN ('llm_call','tool_call')),
  tool_name        TEXT,
  usage_event_id   UUID UNIQUE REFERENCES mt_ai_usage_events(id) ON DELETE CASCADE,
  sequence_order   INTEGER NOT NULL,
  attempt_number   INTEGER CHECK (attempt_number IS NULL OR attempt_number >= 1),
  status           TEXT NOT NULL DEFAULT 'success'
                   CHECK (status IN ('success','error','timeout')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  duration_ms      INTEGER,

  CONSTRAINT mt_ai_spans_shape_matches_type CHECK (
    (span_type = 'llm_call' AND usage_event_id IS NOT NULL AND tool_name IS NULL)
    OR
    (span_type = 'tool_call' AND usage_event_id IS NULL AND tool_name IS NOT NULL)
  ),
  UNIQUE (trace_id, sequence_order)
);

CREATE INDEX IF NOT EXISTS mt_ai_spans_trace_idx ON mt_ai_spans (trace_id, sequence_order);
CREATE INDEX IF NOT EXISTS mt_ai_spans_parent_idx ON mt_ai_spans (parent_span_id);

ALTER TABLE mt_ai_spans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mt_ai_spans FROM anon, authenticated, PUBLIC;

-- Verify: expect one row describing mt_ai_spans with 12 columns, plus
-- confirmation the shape-matches-type CHECK constraint exists.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_spans'
ORDER BY ordinal_position;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'mt_ai_spans'::regclass AND contype = 'c';

-- ═══════════════════════════════════════════════════════════════════
-- STEP 3 — mt_ai_usage_events: one new column
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE mt_ai_usage_events
  ADD COLUMN IF NOT EXISTS trace_id UUID REFERENCES mt_ai_traces(trace_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mt_ai_usage_events_trace_idx ON mt_ai_usage_events (trace_id);

-- Verify: expect one row, trace_id / uuid / YES (nullable).
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'mt_ai_usage_events' AND column_name = 'trace_id';

-- ═══════════════════════════════════════════════════════════════════
-- STEP 4 — mt_ai_record_usage_event_with_span(): the one transactional
-- write path for a traced or untraced usage event (spec Part B.4)
-- ═══════════════════════════════════════════════════════════════════

-- Reconciliation note (post-review): the version of this function first run
-- against pgt-dev was missing 12 parameters/columns that
-- _insertAiUsageEvent() (proxy/server.js) and usageEvents.js's _buildRow()
-- both actively populate today — session_type, prompt_version,
-- settings_model, the three cache-token columns, provider_http_status,
-- error_type, failure_phase, request_bytes, response_bytes, and
-- units_generated. Silently dropping these on every future insert would
-- have broken cache-aware cost calculation, error diagnostics, and Yield
-- outcome-cost attribution entirely. If you already ran the version of
-- this file without this note, run this first to remove the old, incomplete
-- overload before re-running the corrected CREATE OR REPLACE below —
-- otherwise Postgres creates a second, ambiguous overload instead of
-- replacing it (CREATE OR REPLACE only replaces a function with an
-- IDENTICAL argument-type signature):
--
-- DROP FUNCTION IF EXISTS mt_ai_record_usage_event_with_span(
--   uuid, text, uuid, text, uuid, uuid, uuid, text, text, text, text, text,
--   text, integer, integer, jsonb, text, timestamptz, integer, uuid, text, text
-- );

CREATE OR REPLACE FUNCTION mt_ai_record_usage_event_with_span(
  p_company_id                UUID,
  p_app_id                    TEXT,
  p_client_call_id            UUID,
  p_provider                  TEXT,
  p_product_id                UUID,
  p_session_id                UUID,
  p_session_type              TEXT,
  p_user_id                   UUID,
  p_user_role_at_call         TEXT,
  p_caller                    TEXT,
  p_prompt_version            TEXT,
  p_requested_model           TEXT,
  p_response_model            TEXT,
  p_settings_mode             TEXT,
  p_settings_model            TEXT,
  p_selection_rule            TEXT,
  p_input_tokens              INTEGER,
  p_output_tokens             INTEGER,
  p_cache_creation_5m_tokens  INTEGER,
  p_cache_creation_1h_tokens  INTEGER,
  p_cache_read_tokens         INTEGER,
  p_provider_usage_raw        JSONB,
  p_status                    TEXT,
  p_provider_http_status      INTEGER,
  p_error_type                TEXT,
  p_failure_phase             TEXT,
  p_request_started_at        TIMESTAMPTZ,
  p_duration_ms                INTEGER,
  p_request_bytes             INTEGER,
  p_response_bytes            INTEGER,
  p_outcome_id                UUID,
  p_units_generated           INTEGER,
  p_client_trace_id           TEXT,
  p_agent_name                TEXT
-- was_duplicate lets POST /v1/usage-events (proxy/routes/v1/usageEvents.js)
-- preserve its already-shipped per-item `deduplicated` response field now
-- that the insert-with-ON-CONFLICT logic lives in this RPC instead of in
-- insertIdempotent()'s own {id, deduplicated} return shape.
) RETURNS TABLE (usage_event_id UUID, trace_id UUID, span_id UUID, was_duplicate BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trace_id               UUID;
  v_usage_event_id         UUID;
  v_span_id                UUID;
  v_next_seq               INTEGER;
  v_existing               RECORD;
  v_existing_trace_agent   TEXT;
  v_existing_trace_session UUID;
BEGIN
  IF p_client_trace_id IS NOT NULL AND p_agent_name IS NULL THEN
    RAISE EXCEPTION 'p_agent_name is required when p_client_trace_id is supplied'
      USING ERRCODE = '22023';
  END IF;

  IF p_client_trace_id IS NOT NULL THEN
    INSERT INTO mt_ai_traces (company_id, app_id, agent_name, session_id, product_id, outcome_id, client_trace_id)
    VALUES (p_company_id, p_app_id, p_agent_name, p_session_id, p_product_id, p_outcome_id, p_client_trace_id)
    ON CONFLICT (company_id, app_id, client_trace_id) DO NOTHING
    RETURNING mt_ai_traces.trace_id INTO v_trace_id;

    IF v_trace_id IS NULL THEN
      SELECT mt_ai_traces.trace_id, mt_ai_traces.agent_name, mt_ai_traces.session_id
        INTO v_trace_id, v_existing_trace_agent, v_existing_trace_session
        FROM mt_ai_traces
        WHERE company_id = p_company_id AND app_id = p_app_id
          AND client_trace_id = p_client_trace_id
        FOR UPDATE;

      IF v_existing_trace_agent IS DISTINCT FROM p_agent_name
         OR v_existing_trace_session IS DISTINCT FROM p_session_id THEN
        RAISE EXCEPTION 'client_trace_id replay with different agent_name/session_id'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      PERFORM 1 FROM mt_ai_traces WHERE mt_ai_traces.trace_id = v_trace_id FOR UPDATE;
    END IF;
  END IF;

  INSERT INTO mt_ai_usage_events (
    company_id, app_id, client_call_id, provider, product_id, session_id, session_type, user_id,
    user_role_at_call, caller, prompt_version, requested_model, response_model, settings_mode,
    settings_model, selection_rule, input_tokens, output_tokens, cache_creation_5m_tokens,
    cache_creation_1h_tokens, cache_read_tokens, provider_usage_raw, status,
    provider_http_status, error_type, failure_phase,
    request_started_at, duration_ms, request_bytes, response_bytes, outcome_id, units_generated, trace_id
  ) VALUES (
    p_company_id, p_app_id, p_client_call_id, p_provider, p_product_id, p_session_id, p_session_type, p_user_id,
    p_user_role_at_call, p_caller, p_prompt_version, p_requested_model, p_response_model, p_settings_mode,
    p_settings_model, p_selection_rule, p_input_tokens, p_output_tokens, p_cache_creation_5m_tokens,
    p_cache_creation_1h_tokens, p_cache_read_tokens, p_provider_usage_raw, p_status,
    p_provider_http_status, p_error_type, p_failure_phase,
    p_request_started_at, p_duration_ms, p_request_bytes, p_response_bytes, p_outcome_id, p_units_generated, v_trace_id
  )
  ON CONFLICT (company_id, app_id, client_call_id) DO NOTHING
  RETURNING id INTO v_usage_event_id;

  IF v_usage_event_id IS NULL THEN
    -- Bug fix (found via live testing, not caught by any prior review round):
    -- this SELECT's column list must be table-qualified, matching the
    -- mt_ai_traces lookup two branches above — this function's own
    -- RETURNS TABLE declares a `trace_id` OUT parameter, and an unqualified
    -- bare `trace_id` here is genuinely ambiguous between that variable and
    -- mt_ai_usage_events.trace_id, raising "column reference is ambiguous"
    -- on every single client_call_id replay (i.e. on the exact path this
    -- idempotency column exists to make safe).
    SELECT mt_ai_usage_events.id, mt_ai_usage_events.trace_id, mt_ai_usage_events.outcome_id,
           mt_ai_usage_events.caller, mt_ai_usage_events.requested_model
      INTO v_existing
      FROM mt_ai_usage_events
      WHERE company_id = p_company_id AND app_id = p_app_id
        AND client_call_id = p_client_call_id;

    IF v_existing.trace_id IS DISTINCT FROM v_trace_id
       OR v_existing.outcome_id IS DISTINCT FROM p_outcome_id
       OR v_existing.caller IS DISTINCT FROM p_caller
       OR v_existing.requested_model IS DISTINCT FROM p_requested_model THEN
      RAISE EXCEPTION 'client_call_id replay with different identity fields'
        USING ERRCODE = '23514';
    END IF;

    RETURN QUERY
      SELECT v_existing.id, v_existing.trace_id,
        (SELECT s.span_id FROM mt_ai_spans s WHERE s.usage_event_id = v_existing.id),
        true;
    RETURN;
  END IF;

  IF v_trace_id IS NOT NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1 INTO v_next_seq
      FROM mt_ai_spans WHERE mt_ai_spans.trace_id = v_trace_id;

    INSERT INTO mt_ai_spans (usage_event_id, trace_id, span_type, sequence_order, status)
    VALUES (v_usage_event_id, v_trace_id, 'llm_call', v_next_seq, p_status)
    RETURNING mt_ai_spans.span_id INTO v_span_id;
  END IF;

  RETURN QUERY SELECT v_usage_event_id, v_trace_id, v_span_id, false;
END;
$$;

REVOKE ALL ON FUNCTION mt_ai_record_usage_event_with_span FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 5 — mt_ai_record_tool_span(): second write path, tool_call spans
-- (spec Part B.5)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mt_ai_record_tool_span(
  p_company_id      UUID,
  p_app_id          TEXT,
  p_client_trace_id TEXT,
  p_agent_name      TEXT,
  p_tool_name       TEXT,
  p_parent_span_id  UUID,
  p_attempt_number  INTEGER,
  p_status          TEXT,
  p_duration_ms     INTEGER
) RETURNS TABLE (span_id UUID, trace_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trace_id UUID;
  v_next_seq INTEGER;
  v_span_id  UUID;
  v_existing_trace_agent   TEXT;
BEGIN
  INSERT INTO mt_ai_traces (company_id, app_id, agent_name, client_trace_id)
  VALUES (p_company_id, p_app_id, p_agent_name, p_client_trace_id)
  ON CONFLICT (company_id, app_id, client_trace_id) DO NOTHING
  RETURNING mt_ai_traces.trace_id INTO v_trace_id;

  IF v_trace_id IS NULL THEN
    SELECT mt_ai_traces.trace_id, mt_ai_traces.agent_name
      INTO v_trace_id, v_existing_trace_agent
      FROM mt_ai_traces
      WHERE company_id = p_company_id AND app_id = p_app_id
        AND client_trace_id = p_client_trace_id
      FOR UPDATE;

    IF v_existing_trace_agent IS DISTINCT FROM p_agent_name THEN
      RAISE EXCEPTION 'client_trace_id replay with different agent_name'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    PERFORM 1 FROM mt_ai_traces WHERE mt_ai_traces.trace_id = v_trace_id FOR UPDATE;
  END IF;

  -- Bug fix (found via code review, same class already found live in the
  -- sibling mt_ai_record_usage_event_with_span()): this function's own
  -- RETURNS TABLE declares span_id/trace_id as OUT parameters, so the bare
  -- column references below are ambiguous against mt_ai_spans' own columns
  -- of the same name — table-qualified to match.
  IF p_parent_span_id IS NOT NULL THEN
    PERFORM 1 FROM mt_ai_spans WHERE mt_ai_spans.span_id = p_parent_span_id AND mt_ai_spans.trace_id = v_trace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent_span_id does not belong to this trace'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(MAX(sequence_order), 0) + 1 INTO v_next_seq
    FROM mt_ai_spans WHERE mt_ai_spans.trace_id = v_trace_id;

  INSERT INTO mt_ai_spans (
    trace_id, parent_span_id, span_type, tool_name,
    sequence_order, attempt_number, status, duration_ms
  ) VALUES (
    v_trace_id, p_parent_span_id, 'tool_call', p_tool_name,
    v_next_seq, p_attempt_number, p_status, p_duration_ms
  )
  RETURNING mt_ai_spans.span_id INTO v_span_id;

  RETURN QUERY SELECT v_span_id, v_trace_id;
END;
$$;

REVOKE ALL ON FUNCTION mt_ai_record_tool_span FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 6 — final sanity check: confirm both tables, both RPCs, and the
-- new column all exist before calling this migration done.
-- ═══════════════════════════════════════════════════════════════════

SELECT table_name FROM information_schema.tables
WHERE table_name IN ('mt_ai_traces', 'mt_ai_spans') AND table_schema = 'public';

SELECT routine_name FROM information_schema.routines
WHERE routine_name IN ('mt_ai_record_usage_event_with_span', 'mt_ai_record_tool_span')
  AND routine_schema = 'public';

SELECT column_name FROM information_schema.columns
WHERE table_name = 'mt_ai_usage_events' AND column_name = 'trace_id';
