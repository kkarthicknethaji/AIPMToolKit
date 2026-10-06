-- AI Trace Layer — Step 4 reconciliation
-- Run this against pgt-dev to replace the first (incomplete) version of
-- mt_ai_record_usage_event_with_span() with the corrected one — this is
-- the same Step 4 already updated in ai-cost-tower-trace-layer-migration.sql,
-- pulled out here standalone so it can be run on its own without re-running
-- the whole migration file.
--
-- Steps 1, 2, 3, 5, 6 of that file are unaffected by this and do not need
-- to be re-run.

-- ═══════════════════════════════════════════════════════════════════
-- Remove the old, incomplete overload first.
-- CREATE OR REPLACE only replaces a function with an IDENTICAL
-- argument-type signature — since the corrected version below adds new
-- parameters, re-running CREATE OR REPLACE without this DROP first would
-- create a second, ambiguous overload instead of replacing the original.
-- ═══════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS mt_ai_record_usage_event_with_span(
  uuid, text, uuid, text, uuid, uuid, uuid, text, text, text, text, text,
  text, integer, integer, jsonb, text, timestamptz, integer, uuid, text, text
);

-- ═══════════════════════════════════════════════════════════════════
-- Corrected version — adds the 12 columns the first version was missing
-- (session_type, prompt_version, settings_model, the three cache-token
-- columns, provider_http_status, error_type, failure_phase, request_bytes,
-- response_bytes, units_generated) plus was_duplicate on the return shape,
-- so POST /v1/usage-events can preserve its already-shipped per-item
-- `deduplicated` response field.
-- ═══════════════════════════════════════════════════════════════════

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
-- Verify: expect one row, confirming the function exists with a 34-arg
-- signature and the was_duplicate return field.
-- ═══════════════════════════════════════════════════════════════════

SELECT p.proname, pg_get_function_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS returns
FROM pg_proc p
WHERE p.proname = 'mt_ai_record_usage_event_with_span';
