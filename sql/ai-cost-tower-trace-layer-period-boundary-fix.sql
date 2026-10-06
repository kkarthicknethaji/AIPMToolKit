-- AI Cost Control Tower: AI Trace Layer — period-boundary attribution fix
-- (mt_ai_trace_detail_list, mt_ai_cost_by_agent)
--
-- Corrects a code-review finding from the "remaining five widgets" build
-- (sql/ai-cost-tower-trace-layer-remaining-widgets-migration.sql, already
-- applied to pgt-dev). Not run by Claude Code — apply manually, dev
-- (pgt-dev) first, then prod (pgt-prod), per this project's unbroken
-- convention for every prior Cost Tower migration.
--
-- THE BUG: both functions bounded only the TRACE's own started_at against
-- [p_period_start, p_period_end) and then joined every span of a matching
-- trace unconditionally — no bound on the span's own started_at (or the
-- underlying usage event's request_started_at). Every other Cost Tower
-- RPC (mt_ai_cost_events_list) attributes each individual call to whichever
-- period ITS OWN timestamp falls in. A conversation that starts just before
-- a period boundary and continues just after it had its entire cost/
-- duration attributed to the period it STARTED in — including calls that
-- actually happened in the next period — disagreeing with Request
-- Explorer/Overview's per-call totals for the same period, and completely
-- omitting that later activity from the period it actually belongs to.
--
-- THE FIX: bound each SPAN's own started_at against the period instead of
-- (only) the trace's. This is a bigger change than swapping one column
-- reference, because "which traces are candidates for this period" can no
-- longer be "traces that started in this period" — a trace that started
-- in an earlier period but has a span in this period must still surface
-- here, or that span's cost silently disappears from every period's view.
-- mt_ai_trace_detail_list's cap (100 conversations) is therefore now "100
-- traces with the most recent in-period span activity," not "100 traces
-- that started in this period." mt_ai_cost_by_agent's trace_count now
-- means "traces with at least one span in this period," not "traces that
-- started in this period" — both are the more correct reading for a
-- period-scoped report.
--
-- No frontend change needed — both RPCs' RETURNS TABLE shape and every
-- column name are unchanged, so scripts/cost-tower.js needs no edits.
-- A visible side effect: a trace's own status classification
-- (completed/recovered/abandoned in scripts/cost-tower.js's
-- actBuildTraceSummaries) is now computed from whichever of that trace's
-- spans fall in the selected period, not the trace's full lifetime — the
-- same scoping every other per-period figure on this screen already uses.
--
-- Plain CREATE OR REPLACE is correct for both — neither function's
-- signature or RETURNS TABLE shape changes, only the query body.

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

  -- period_spans: every span whose OWN started_at falls in the period,
  -- for this company/app — the same per-call attribution rule
  -- mt_ai_cost_events_list already uses. A trace is reachable here purely
  -- because it has a span here, regardless of when the trace itself began.
  RETURN QUERY
  WITH period_spans AS (
    SELECT
      s.trace_id, s.span_id, s.parent_span_id, s.span_type, s.tool_name, s.usage_event_id,
      s.sequence_order, s.attempt_number, s.status AS span_status, s.started_at AS span_started_at,
      s.duration_ms AS span_duration_ms
    FROM mt_ai_spans s
    JOIN mt_ai_traces t ON t.trace_id = s.trace_id
    WHERE t.company_id = p_company_id
      AND t.app_id = p_app_id
      AND s.started_at >= p_period_start
      AND s.started_at < p_period_end
  ),
  -- Cap applies to DISTINCT TRACES (ranked by their most recent in-period
  -- span activity), not raw rows — same reasoning as the original
  -- migration's own cap, just ranked on activity instead of trace start.
  capped_traces AS (
    SELECT trace_id, MAX(span_started_at) AS most_recent_span_at
    FROM period_spans
    GROUP BY trace_id
    ORDER BY MAX(span_started_at) DESC
    LIMIT 100
  )
  SELECT
    t.trace_id, t.agent_name, t.client_trace_id, t.started_at, t.completed_at, t.outcome_id,
    ps.span_id, ps.parent_span_id, ps.span_type, ps.tool_name, ps.usage_event_id,
    ps.sequence_order, ps.attempt_number, ps.span_status, ps.span_started_at, ps.span_duration_ms,
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
  JOIN period_spans ps ON ps.trace_id = ct.trace_id
  JOIN mt_ai_traces t ON t.trace_id = ct.trace_id
  LEFT JOIN mt_ai_usage_events e ON e.id = ps.usage_event_id
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  ORDER BY ct.most_recent_span_at DESC, ps.sequence_order ASC;
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

  -- Same fix as mt_ai_trace_detail_list: bound on s.started_at (each
  -- span's own timestamp), not t.started_at (the trace's). trace_count
  -- now means "traces with at least one span in this period," not
  -- "traces that started in this period."
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
    AND s.started_at >= p_period_start
    AND s.started_at < p_period_end
  GROUP BY t.agent_name
  ORDER BY total_cost DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_by_agent(uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_by_agent(uuid, text, timestamptz, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════
-- C — verification
-- ═══════════════════════════════════════════════════════════════════

-- 1. Both functions still exist with the same return shape as before.
SELECT p.proname, pg_get_function_result(p.oid) AS returns
FROM pg_proc p WHERE p.proname IN ('mt_ai_trace_detail_list', 'mt_ai_cost_by_agent');

-- 2. Grants unaffected — authenticated can execute, anon cannot.
SELECT
  has_function_privilege('authenticated', 'public.mt_ai_trace_detail_list(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS trace_detail_authenticated,
  has_function_privilege('anon', 'public.mt_ai_trace_detail_list(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS trace_detail_anon,
  has_function_privilege('authenticated', 'public.mt_ai_cost_by_agent(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS cost_by_agent_authenticated,
  has_function_privilege('anon', 'public.mt_ai_cost_by_agent(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS cost_by_agent_anon;
-- expect: both *_authenticated = true, both *_anon = false

-- 3. Sanity check the actual fix: for any trace with spans in two
--    different calendar months, confirm mt_ai_trace_detail_list no longer
--    returns a next-month span when queried for THIS month's period, and
--    that querying next month's period DOES return that span (previously
--    it would have shown in neither, or only in the trace's start month).
--    Replace the placeholders with a real company/app and two adjacent
--    month boundaries once a cross-boundary trace exists in dev data.
-- SELECT * FROM mt_ai_trace_detail_list('<company>', '<app_id>', '<this_month_start>', '<this_month_end>');
-- SELECT * FROM mt_ai_trace_detail_list('<company>', '<app_id>', '<next_month_start>', '<next_month_end>');

-- 4. Confirm mt_ai_cost_by_agent's total_cost for a given period now
--    matches the sum of calculated_cost from mt_ai_cost_events_list for
--    the same period/company/app, restricted to rows whose trace_id is
--    non-null (only traced calls are comparable — untraced calls have no
--    agent_name to attribute to and are correctly excluded from this RPC).
