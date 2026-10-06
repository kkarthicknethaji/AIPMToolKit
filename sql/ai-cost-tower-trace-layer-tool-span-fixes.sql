-- AI Trace Layer — mt_ai_record_tool_span() code-review fixes
-- Found via code review (not live testing this time), same bug classes
-- already fixed once in the sibling mt_ai_record_usage_event_with_span():
--
-- 1. Ambiguous column reference: this function's own RETURNS TABLE
--    declares span_id/trace_id as OUT parameters, so the bare
--    `WHERE span_id = p_parent_span_id AND trace_id = v_trace_id` in the
--    parent_span_id check is genuinely ambiguous against mt_ai_spans' own
--    columns of the same name. Any POST /v1/tool-spans call with a
--    non-null parent_span_id would raise SQLSTATE 42702 and a 500.
-- 2. Dead code: v_existing_trace_session was fetched but never used —
--    this function has no p_session_id parameter to ever compare it
--    against (leftover from copy-pasting the richer usage-event RPC's
--    block without trimming it).
--
-- The signature (parameter list, return type) is unchanged — only the
-- function body changed — so CREATE OR REPLACE works in place, no DROP
-- FUNCTION needed.
--
-- Run this against pgt-dev (which already has the pre-fix version
-- deployed from the original migration run). pgt-prod doesn't need this
-- as a separate step — the main migration file
-- (ai-cost-tower-trace-layer-migration.sql) already has both fixes baked
-- in for a fresh first-time run.

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

-- Verify: expect one row, confirming the function's signature is intact.
SELECT p.proname, pg_get_function_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS returns
FROM pg_proc p
WHERE p.proname = 'mt_ai_record_tool_span';
