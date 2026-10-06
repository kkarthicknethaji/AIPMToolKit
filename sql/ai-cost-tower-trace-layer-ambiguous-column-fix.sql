-- AI Trace Layer — ambiguous-column bug fix
-- Found via live testing against pgt-dev (Tests 10/11, replaying an existing
-- client_call_id): "column reference \"trace_id\" is ambiguous". Confirmed
-- directly against the live function via pg_get_functiondef() — the bug
-- predates this build, present in every version of the spec (v0.7-v0.11);
-- it was never caught by four critic rounds or three independent review
-- passes because none of them executed this branch against real Postgres.
--
-- Root cause: this function's own RETURNS TABLE declares a `trace_id` OUT
-- parameter. The client_call_id-replay check below had an UNQUALIFIED
-- `trace_id` in its SELECT list, which Postgres can't resolve between that
-- OUT parameter and mt_ai_usage_events.trace_id — it raises an error rather
-- than guessing, every single time an existing client_call_id is replayed
-- (the exact scenario client_call_id's idempotency guarantee exists for).
--
-- The signature (parameter list, return type) is UNCHANGED from what's
-- already live on pgt-dev — only the function body's SELECT statement is
-- fixed, so CREATE OR REPLACE works in place. No DROP FUNCTION needed this
-- time (unlike the earlier 12-parameter reconciliation, which changed the
-- signature and did need one).
--
-- Run this as one file against pgt-dev.

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
    -- THE FIX: every column below is now table-qualified, matching the
    -- mt_ai_traces lookup above it, instead of the bare, ambiguous
    -- `id, trace_id, outcome_id, caller, requested_model` this SELECT had.
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
-- Verify the fix: replay an already-recorded client_call_id and confirm it
-- no longer raises "column reference is ambiguous". Uses the same test row
-- from the earlier testing-guide session (client_call_id
-- 22222222-2222-2222-2222-222222222222) if it's still present; harmless to
-- skip if it's been cleaned up already.
-- ═══════════════════════════════════════════════════════════════════

SELECT * FROM mt_ai_record_usage_event_with_span(
  p_company_id            := (SELECT company_id FROM mt_ai_usage_events WHERE client_call_id = '22222222-2222-2222-2222-222222222222' LIMIT 1),
  p_app_id                := 'product-studio',
  p_client_call_id        := '22222222-2222-2222-2222-222222222222',
  p_provider              := 'anthropic',
  p_product_id            := NULL,
  p_session_id            := '11111111-1111-1111-1111-111111111111',
  p_session_type          := NULL,
  p_user_id               := NULL,
  p_user_role_at_call     := 'engineer',
  p_caller                := 'test-caller',
  p_prompt_version        := NULL,
  p_requested_model       := 'claude-x',
  p_response_model        := NULL,
  p_settings_mode         := 'external',
  p_settings_model        := NULL,
  p_selection_rule        := 'external',
  p_input_tokens          := NULL,
  p_output_tokens         := NULL,
  p_cache_creation_5m_tokens := NULL,
  p_cache_creation_1h_tokens := NULL,
  p_cache_read_tokens     := NULL,
  p_provider_usage_raw    := NULL,
  p_status                := 'success',
  p_provider_http_status  := NULL,
  p_error_type            := NULL,
  p_failure_phase         := NULL,
  p_request_started_at    := '2026-09-10T10:00:00Z',
  p_duration_ms           := NULL,
  p_request_bytes         := NULL,
  p_response_bytes        := NULL,
  p_outcome_id            := NULL,
  p_units_generated       := NULL,
  p_client_trace_id       := 'test-trace-001',
  p_agent_name            := 'test-agent'
);
-- Expected: one row, was_duplicate = true, no error. (If the test row from
-- the earlier session was already cleaned up, p_company_id above resolves
-- to NULL and this insert attempt will behave differently — that's fine,
-- the point is just confirming no "ambiguous" error, not exercising the
-- exact same data again.)
