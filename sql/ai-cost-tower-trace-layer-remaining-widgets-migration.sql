-- AI Cost Control Tower: AI Trace Layer — Remaining Five Widgets
-- (By-Trace toggle, By-Conversation ranking, 2 new Failure Cost KPIs,
-- Trace Explorer card, Cost by Agent)
--
-- Per trace-layer-remaining-five-spec-v4.md, approved by Nethaji (cap
-- value 100 confirmed). Not run by Claude Code — apply manually, dev
-- (pgt-dev) first, then prod (pgt-prod), per this project's unbroken
-- convention for every prior Cost Tower migration.
--
-- Both functions below are genuinely new (confirmed: zero matches for
-- either name anywhere in sql/) — plain CREATE OR REPLACE is correct,
-- no DROP FUNCTION needed, no RETURNS TABLE shape to collide with.
--
-- What this migration does, in order:
--   A. Creates mt_ai_trace_detail_list — one row per span, capped to the
--      100 most recent DISTINCT TRACES (not raw rows — a row-level LIMIT
--      would truncate a trace mid-span). Gated by
--      _cost_tower_can_manage_governance (same tier as the payload
--      viewer's mt_ai_trace_payload_get), per spec §1.3/§9 item 3.
--   B. Creates mt_ai_cost_by_agent — a per-agent cost rollup, gated by
--      the more open _cost_tower_can_access, per spec §7/§9 item 5
--      (textual precedent: sql/ai-cost-tower-multi-app-migration.sql's
--      own "canonical list" comment already names mt_ai_cost_events_list
--      as deliberately kept on this open gate; this RPC is the same
--      shape of thing).
--   C. Verification queries.
--
-- Run A and B as separate statements (each is a single CREATE OR REPLACE
-- FUNCTION + REVOKE + GRANT) — no shared transaction needed since neither
-- modifies an existing function's shape.

-- ═══════════════════════════════════════════════════════════════════
-- A — mt_ai_trace_detail_list
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mt_ai_trace_detail_list(
  p_company_id     uuid,
  p_app_id         text,
  p_period_start   timestamp with time zone,
  p_period_end     timestamp with time zone
)
 RETURNS TABLE(
   trace_id           uuid,
   agent_name         text,
   client_trace_id    text,
   trace_started_at   timestamptz,
   trace_completed_at timestamptz,
   outcome_id         uuid,
   span_id            uuid,
   parent_span_id     uuid,
   span_type          text,
   tool_name          text,
   usage_event_id     uuid,
   sequence_order     integer,
   attempt_number     integer,
   span_status        text,
   span_started_at    timestamptz,
   span_duration_ms   integer,
   calculated_cost    numeric,
   request_bytes      integer,
   response_bytes     integer
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT _cost_tower_can_manage_governance(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read trace detail for company %', p_company_id;
  END IF;

  -- Cap applies to DISTINCT TRACES, not raw rows — a row-level LIMIT on
  -- the final SELECT would truncate mid-trace (e.g. keep a trace's first
  -- 3 spans and silently drop its 4th), corrupting the exact grouped view
  -- this RPC exists to support. The CTE selects the 100 most recent
  -- trace_ids first, then joins spans onto that already-bounded set —
  -- every returned trace is guaranteed complete, never partially cut off.
  RETURN QUERY
  WITH capped_traces AS (
    SELECT t.trace_id
    FROM mt_ai_traces t
    WHERE t.company_id = p_company_id
      AND t.app_id = p_app_id
      AND t.started_at >= p_period_start
      AND t.started_at < p_period_end
    ORDER BY t.started_at DESC
    LIMIT 100
  )
  SELECT
    t.trace_id, t.agent_name, t.client_trace_id, t.started_at, t.completed_at, t.outcome_id,
    s.span_id, s.parent_span_id, s.span_type, s.tool_name, s.usage_event_id,
    s.sequence_order, s.attempt_number, s.status,
    s.started_at, s.duration_ms,
    -- calculated_cost mirrors mt_ai_cost_events_list's own formula exactly
    -- (character-for-character) — NULL for tool_call spans, which have no
    -- usage_event_id and thus no pricing row.
    CASE WHEN e.id IS NULL OR p.id IS NULL THEN NULL ELSE
        (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
      + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
      + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
      + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
      + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
    END,
    e.request_bytes, e.response_bytes
  FROM capped_traces ct
  JOIN mt_ai_traces t ON t.trace_id = ct.trace_id
  JOIN mt_ai_spans s ON s.trace_id = ct.trace_id
  LEFT JOIN mt_ai_usage_events e ON e.id = s.usage_event_id
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  ORDER BY t.started_at DESC, s.sequence_order ASC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_trace_detail_list(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_trace_detail_list(uuid, text, timestamptz, timestamptz) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- B — mt_ai_cost_by_agent
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.mt_ai_cost_by_agent(
  p_company_id   uuid,
  p_app_id       text,
  p_period_start timestamp with time zone,
  p_period_end   timestamp with time zone
)
 RETURNS TABLE(
   agent_name      text,
   trace_count     bigint,
   avg_calls_per_trace numeric,
   total_cost      numeric
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read agent cost summary for company %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT
    t.agent_name,
    count(DISTINCT t.trace_id) AS trace_count,
    round(count(s.span_id)::numeric / NULLIF(count(DISTINCT t.trace_id), 0), 1) AS avg_calls_per_trace,
    COALESCE(sum(
      CASE WHEN p.id IS NULL THEN 0 ELSE
          (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
        + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
        + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
        + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
        + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
      END
    ), 0) AS total_cost
  FROM mt_ai_traces t
  JOIN mt_ai_spans s ON s.trace_id = t.trace_id
  LEFT JOIN mt_ai_usage_events e ON e.id = s.usage_event_id
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  WHERE t.company_id = p_company_id
    AND t.app_id = p_app_id
    AND t.started_at >= p_period_start
    AND t.started_at < p_period_end
  GROUP BY t.agent_name
  ORDER BY total_cost DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_by_agent(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_by_agent(uuid, text, timestamptz, timestamptz) TO authenticated;

-- Force PostgREST to pick up both new functions.
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- C — verification
-- ═══════════════════════════════════════════════════════════════════

-- 1. Both functions exist with the expected return shape.
SELECT p.proname, pg_get_function_result(p.oid) AS returns
FROM pg_proc p WHERE p.proname IN ('mt_ai_trace_detail_list', 'mt_ai_cost_by_agent');

-- 2. Grants — authenticated can execute, anon cannot, for both.
SELECT
  has_function_privilege('authenticated', 'public.mt_ai_trace_detail_list(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS trace_detail_authenticated,
  has_function_privilege('anon', 'public.mt_ai_trace_detail_list(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS trace_detail_anon,
  has_function_privilege('authenticated', 'public.mt_ai_cost_by_agent(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS cost_by_agent_authenticated,
  has_function_privilege('anon', 'public.mt_ai_cost_by_agent(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS cost_by_agent_anon;
-- expect: both *_authenticated = true, both *_anon = false

-- 3. Owner can actually read every table each function queries (SECURITY
--    DEFINER runs with the owner's privileges — passing the role check
--    inside the function body does not guarantee table-level SELECT).
WITH fn AS (
  SELECT p.oid::regprocedure::text AS function_signature, p.proowner::regrole::text AS owner_name
  FROM pg_proc p
  WHERE p.oid IN (
    'public.mt_ai_trace_detail_list(uuid,text,timestamptz,timestamptz)'::regprocedure,
    'public.mt_ai_cost_by_agent(uuid,text,timestamptz,timestamptz)'::regprocedure
  )
)
SELECT
  function_signature, owner_name,
  has_table_privilege(owner_name, 'public.mt_ai_traces', 'SELECT') AS can_select_traces,
  has_table_privilege(owner_name, 'public.mt_ai_spans', 'SELECT') AS can_select_spans,
  has_table_privilege(owner_name, 'public.mt_ai_usage_events', 'SELECT') AS can_select_usage_events,
  has_table_privilege(owner_name, 'public.mt_model_pricing', 'SELECT') AS can_select_model_pricing
FROM fn;
-- expect: all four true for both rows.

-- 4. As an admin OR member (role) test user, confirm mt_ai_trace_detail_list
--    returns rows for a period with known Requirement Agent activity, and
--    that a readonly-role test user gets the authorization exception
--    instead of data. Requires a real test user of each role — run once
--    available; not a design blocker.
-- SELECT * FROM mt_ai_trace_detail_list('<company>', '<app_id>', '<period_start>', '<period_end>');

-- 5. Confirm the cap: a period with more than 100 traces returns exactly
--    the 100 most recent, not more, and no trace among those 100 is
--    missing any of its own spans.
-- SELECT trace_id, count(*) FROM mt_ai_trace_detail_list(...) GROUP BY trace_id;
