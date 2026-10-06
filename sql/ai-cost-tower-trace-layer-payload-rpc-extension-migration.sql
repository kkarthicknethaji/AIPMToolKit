-- AI Trace Layer — Universal Payload Capture: RPC extension
-- Extends mt_ai_record_usage_event_with_span() to conditionally write to
-- mt_ai_trace_payloads (sql/ai-cost-tower-trace-layer-trace-payloads-
-- migration.sql, already live as of v9.33.02), gated independently of the
-- trace/span condition so payload capture works for every call, including
-- the ~15 feature files that never send client_trace_id. Trace/span logic
-- itself is unchanged.
--
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify the result below
-- (including the transaction-wrapped runtime-executability check), THEN
-- prod (pgt-prod). Per this project's convention: not run by Claude Code,
-- executed manually.
--
-- Signature change, not a body-only fix — CREATE OR REPLACE cannot add
-- parameters to an existing function without leaving the old signature
-- callable alongside the new one as a separate overload. This function's
-- own history already establishes the same pattern: the original 22-arg
-- version was replaced with the current 34-arg version in
-- ai-cost-tower-trace-layer-step4-reconciliation.sql via DROP FUNCTION
-- (old signature) + CREATE OR REPLACE FUNCTION (new signature) for exactly
-- this reason — a subsequent body-only fix
-- (ai-cost-tower-trace-layer-ambiguous-column-fix.sql) needed no DROP
-- because it kept the same 34-arg signature. This migration adds two new
-- parameters, so it needs the DROP again.
--
-- Before running: confirm the exact current signature below still matches
-- what's live on the target database —
--   SELECT oidvectortypes(p.proargtypes) AS args
--   FROM pg_proc p WHERE p.proname = 'mt_ai_record_usage_event_with_span';
-- — rather than trusting this comment or any prior draft's arg count.

-- ═══════════════════════════════════════════════════════════════════
-- STEP 0 — pre-migration capture: owner, schema, config, and ACL, so the
-- post-migration query below has something to diff against rather than
-- asserting correctness in isolation.
-- ═══════════════════════════════════════════════════════════════════

SELECT n.nspname, p.proname, oidvectortypes(p.proargtypes) AS args,
       p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner,
       p.proconfig, p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'mt_ai_record_usage_event_with_span';

-- ═══════════════════════════════════════════════════════════════════
-- STEP 1 — drop the old (34-arg) overload, then create the new (36-arg)
-- one. Signature below matches the live function as of
-- ai-cost-tower-trace-layer-ambiguous-column-fix.sql — reconfirm against
-- STEP 0's output before running.
-- ═══════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS mt_ai_record_usage_event_with_span(
  UUID, TEXT, UUID, TEXT, UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
  JSONB, TEXT, INTEGER, TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER, INTEGER,
  UUID, INTEGER, TEXT, TEXT
);

CREATE FUNCTION mt_ai_record_usage_event_with_span(
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
  p_agent_name                TEXT,
  p_request_payload           JSONB DEFAULT NULL,
  p_response_payload          JSONB DEFAULT NULL
) RETURNS TABLE (
  usage_event_id UUID, trace_id UUID, span_id UUID, was_duplicate BOOLEAN,
  payload_capture_status TEXT
)
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
  v_scope_payloads_write    BOOLEAN;
  v_payload_capture_enabled BOOLEAN;
  v_payload_capture_status  TEXT;
  v_existing_payload        BOOLEAN;
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
    -- Replay of an existing client_call_id — idempotent, no new usage event,
    -- span, or payload row is inserted (mt_ai_trace_payloads.usage_event_id
    -- is UNIQUE, so re-inserting here would violate that constraint even if
    -- the gate allowed it). payload_capture_status on a replay reflects
    -- whether a payload row already exists for the original call, not
    -- whether one was requested/denied on *this* replay — nothing was
    -- requested on this call, but 'not_requested' would misleadingly imply
    -- no payload exists at all for this usage event, which may be false.
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

    SELECT true INTO v_existing_payload
      FROM mt_ai_trace_payloads WHERE mt_ai_trace_payloads.usage_event_id = v_existing.id;
    v_payload_capture_status := CASE WHEN v_existing_payload IS TRUE THEN 'captured' ELSE 'not_requested' END;

    RETURN QUERY
      SELECT v_existing.id, v_existing.trace_id,
        (SELECT s.span_id FROM mt_ai_spans s WHERE s.usage_event_id = v_existing.id),
        true, v_payload_capture_status;
    RETURN;
  END IF;

  IF v_trace_id IS NOT NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1 INTO v_next_seq
      FROM mt_ai_spans WHERE mt_ai_spans.trace_id = v_trace_id;

    INSERT INTO mt_ai_spans (usage_event_id, trace_id, span_type, sequence_order, status)
    VALUES (v_usage_event_id, v_trace_id, 'llm_call', v_next_seq, p_status)
    RETURNING mt_ai_spans.span_id INTO v_span_id;
  END IF;

  -- Payload capture — gated independently of trace/span above, so it works
  -- for every call including the ~15 feature files that never send
  -- client_trace_id. Entitlement (whether this app may persist a non-NULL
  -- payload) is enforced only here, inside the RPC — callers are not
  -- expected to pre-check scope_payloads_write/payload_capture_enabled
  -- themselves. This never fails the usage-event write over a payload-
  -- entitlement question: the event/trace/span above are already recorded
  -- by this point regardless of what happens below.
  --
  -- v_scope_payloads_write/v_payload_capture_enabled are BOOLEAN NOT NULL
  -- DEFAULT false columns on mt_company_apps — an existing row can never
  -- actually have NULL in either. IS TRUE (rather than a bare =) still
  -- matters here because a missing mt_company_apps row (no match for
  -- company_id/app_id) leaves both locals NULL via this SELECT INTO, and
  -- IS TRUE denies on NULL by construction — that is the one real path to
  -- this guard resolving to a denial that "false = false" wouldn't need
  -- IS TRUE to also get right, not a defense against an existing row
  -- somehow holding a NULL in a NOT NULL column.
  SELECT scope_payloads_write, payload_capture_enabled
    INTO v_scope_payloads_write, v_payload_capture_enabled
    FROM mt_company_apps
    WHERE company_id = p_company_id AND app_id = p_app_id;

  IF v_scope_payloads_write IS TRUE AND v_payload_capture_enabled IS TRUE
     AND (p_request_payload IS NOT NULL OR p_response_payload IS NOT NULL) THEN
    INSERT INTO mt_ai_trace_payloads (usage_event_id, company_id, app_id, request_payload, response_payload)
    VALUES (v_usage_event_id, p_company_id, p_app_id, p_request_payload, p_response_payload);
    v_payload_capture_status := 'captured';
  ELSIF p_request_payload IS NOT NULL OR p_response_payload IS NOT NULL THEN
    -- A payload was offered but the gate denied it — observable, not silent.
    v_payload_capture_status := 'gate_disabled';
  ELSE
    v_payload_capture_status := 'not_requested';
  END IF;

  RETURN QUERY SELECT v_usage_event_id, v_trace_id, v_span_id, false, v_payload_capture_status;
END;
$$;

REVOKE ALL ON FUNCTION mt_ai_record_usage_event_with_span FROM PUBLIC, anon, authenticated;

-- Explicit COMMIT here, not left implicit. When a whole multi-statement
-- script like this one is submitted as a single "Run" (Postgres's simple-
-- query protocol wraps an entire multi-statement submission in ONE
-- implicit transaction unless the script's own BEGIN/COMMIT divide it),
-- STEP 3 below opens its own explicit BEGIN...ROLLBACK to make its test
-- call safe to run against real data. Without this COMMIT first, that
-- ROLLBACK doesn't just undo STEP 3's test insert — it undoes everything
-- since the implicit transaction started, including this DROP/CREATE/
-- REVOKE, silently reverting the entire migration while STEP 3's own
-- SELECT still reports success (it's reading the not-yet-committed new
-- function from within the same transaction). Confirmed happening exactly
-- this way on a live run: STEP 3 returned a clean payload_capture_status,
-- but the function was back to its pre-migration 34-arg signature
-- immediately after.
COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 2 — post-migration verification: confirm exactly one signature
-- exists, and that security_definer/owner/search_path/proacl are unchanged
-- from STEP 0's capture (no unexpected grant appeared, none was silently
-- lost).
-- ═══════════════════════════════════════════════════════════════════

SELECT n.nspname, p.proname, oidvectortypes(p.proargtypes) AS args,
       p.prosecdef AS security_definer,
       pg_get_userbyid(p.proowner) AS owner,
       p.proconfig, p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'mt_ai_record_usage_event_with_span';

-- Code-review fix: the SELECT above only *displays* the row count for a
-- human to eyeball — on a database where the live signature didn't exactly
-- match STEP 1's hardcoded DROP list (e.g. undetected prod drift), the DROP
-- would silently no-op and CREATE FUNCTION would either error or succeed as
-- a second, ambiguous overload, and a wide result table makes "2 rows"
-- easy to miss at a glance. This asserts it instead of just showing it.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc WHERE proname = 'mt_ai_record_usage_event_with_span';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 overload of mt_ai_record_usage_event_with_span after migration, found %. STEP 1''s DROP FUNCTION likely did not match the live signature — check for an orphaned old overload before proceeding.', v_count;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════
-- STEP 3 — runtime executability check. Proves supabaseAdmin's service_role
-- key can actually call the new signature on THIS database, rather than
-- inferring it from the REVOKE-only precedent in
-- sql/ai-cost-tower-outcomes-v2-migration.sql (~line 262-270) alone — that
-- precedent describes a different function, and while
-- mt_ai_record_usage_event_with_span has itself been called successfully
-- via supabaseAdmin.rpc() with the same REVOKE-only/no-GRANT setup since
-- before this migration, this check re-confirms it still holds for the new
-- signature specifically.
--
-- Must NOT be a bare direct call with placeholder/NULL values against prod
-- (the "must be run on dev, wrapped, rolled back" requirement below is what
-- makes garbage-ish values safe to use at all) — but real, hand-typed,
-- FK-satisfying values are not actually required to answer the EXECUTE-
-- privilege question this check exists for. In Postgres, a privilege check
-- on a function happens before its body runs — so:
--   * `service_role` truly lacking EXECUTE always surfaces as
--     `42501 permission denied for function ...`, regardless of whether
--     the arguments are real or garbage.
--   * ANY other error (a foreign-key violation, a not-null violation, an
--     invalid-literal error) — or a clean success — already proves EXECUTE
--     works, because Postgres got far enough to start evaluating the
--     function body.
-- So the only thing that actually matters when reading the result is the
-- error code, not whether the row would insert cleanly. p_company_id below
-- is still pulled from a real row via subquery (not hand-typed) purely for
-- convenience, so this runs unmodified rather than needing a lookup first —
-- if that subquery finds nothing on a given database, you'll get a
-- not-null/FK error instead of a clean insert, which is a perfectly valid,
-- informative result for THIS check, not a failure of it. p_user_id is
-- simply NULL — this column has been nullable since
-- ai-cost-tower-openapi-ingestion-user-id-nullable-fix.sql.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;
SELECT * FROM mt_ai_record_usage_event_with_span(
  p_company_id            := (SELECT company_id FROM mt_company_apps WHERE app_id = 'product-studio' LIMIT 1),
  p_app_id                := 'product-studio',
  p_client_call_id        := gen_random_uuid(),
  p_provider              := 'anthropic',
  p_product_id            := NULL,
  p_session_id            := gen_random_uuid(),
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
  p_request_started_at    := now(),
  p_duration_ms           := NULL,
  p_request_bytes         := NULL,
  p_response_bytes        := NULL,
  p_outcome_id            := NULL,
  p_units_generated       := NULL,
  p_client_trace_id       := NULL,
  p_agent_name            := NULL,
  p_request_payload       := '{"test": true}'::jsonb,
  p_response_payload      := '{"test": true}'::jsonb
);
-- Read the result by error code, not by whether the row inserted cleanly:
--   * A clean single row (was_duplicate = false, payload_capture_status
--     'captured' or 'gate_disabled' depending on this row's actual gate
--     columns) — pass. Either status is a pass here; the gate's own logic
--     is STEP 4/§4's truth table, not this check's concern.
--   * Any error OTHER than 42501 (e.g. a not-null/FK violation, if the
--     subquery above found no product-studio row on this database) —
--     still a pass for THIS check. Reaching that error means Postgres
--     already evaluated the function body, which is only possible if
--     EXECUTE succeeded.
--   * `42501 permission denied for function mt_ai_record_usage_event_with_span`
--     specifically — the only actual fail. Means the REVOKE-only precedent
--     does not hold on this database's configuration, and
--     GRANT EXECUTE ON FUNCTION mt_ai_record_usage_event_with_span TO
--     service_role; must be added before this migration is considered
--     complete.
ROLLBACK;

-- On prod, this exact transaction-wrapped check is optional and may be
-- skipped in favor of a controlled server.js smoke test through the
-- normal application path (a real, low-volume test AI call made through
-- the running app, then confirming the resulting row and its
-- payload_capture_status directly) — prod verification's actual goal is
-- confirming the deployed migration works end-to-end, and an
-- application-level smoke test proves that more directly than a raw RPC
-- call would, without needing a rollback around real production
-- infrastructure. Either method is acceptable; a bare, unwrapped,
-- placeholder-argument RPC call against prod is not.

-- ═══════════════════════════════════════════════════════════════════
-- End of migration.
-- ═══════════════════════════════════════════════════════════════════
