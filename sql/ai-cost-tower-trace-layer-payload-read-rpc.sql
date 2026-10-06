-- AI Cost Control Tower: AI Trace Layer — Prompt & Response Payload Viewer
-- (Request Explorer's Prompt column, browser read path)
--
-- Per request-explorer-payload-viewer-spec-v0.13.md, approved by Nethaji.
-- Not run by Claude Code — apply manually, dev (pgt-dev) first, then prod
-- (pgt-prod), per this project's unbroken convention for every prior Cost
-- Tower migration.
--
-- VERSION NOTE: the approved spec names this feature's target release as
-- v9.34, but scripts/config.js's live APP_VERSION and CHANGELOG.md's top
-- entry are already v9.34 ("Universal Payload Capture" — a different,
-- already-shipped feature, applied to pgt-prod per this repo's own commit
-- history). The spec's version label is stale, not a live conflict — this
-- feature ships as v9.35. No SQL below depends on the version number; this
-- note exists so whoever runs this migration doesn't tag it v9.34 by
-- copying the spec's own (outdated) header.
--
-- What this migration does, in order:
--   A. Adds the CHECK constraint mt_ai_trace_payloads was specified with
--      (source: ai-cost-tower-trace-layer-trace-payloads-migration.sql)
--      but never actually got live — confirmed absent 2026-09-12. Run
--      first, independent of everything below.
--   B. Pre-flight: confirms mt_ai_usage_events.id/trace_id/company_id/app_id
--      exist with the expected types. Already confirmed live against this
--      database by Nethaji directly (spec §8.2 item 2) — re-run here as a
--      safety net before the DROP below, not because it's still in doubt.
--   C. Captures mt_ai_cost_events_list's current owner/definition and
--      checks for dependencies, so a rollback or an unexpected dependency
--      has something to act on. Read the output before proceeding past it.
--   D. DROP + CREATE mt_ai_cost_events_list (adds usage_event_id/trace_id,
--      both NULL-masked for non-governance roles) and CREATE
--      mt_ai_trace_payload_get (new), both inside ONE transaction with one
--      NOTIFY at the end — run the whole block as a single paste.
--   E. Post-commit verification: owner check, and the owner/table-privilege
--      check (spec §8.2 item 3) — this can only run after D has committed,
--      since it checks functions that don't exist beforehand.
--   F. §5.2's remaining verification queries.
--
-- Do NOT split D across multiple SQL editor executions, and do NOT skip B.
-- If B's query doesn't return all four columns, stop — do not run D.

-- ═══════════════════════════════════════════════════════════════════
-- A — mt_ai_trace_payloads: add the missing CHECK constraint
-- ═══════════════════════════════════════════════════════════════════

-- Pre-flight: confirm no existing row would violate this constraint.
SELECT count(*) AS rows_that_would_violate
FROM mt_ai_trace_payloads
WHERE request_payload IS NULL AND response_payload IS NULL;
-- Expect 0. If > 0, STOP — review those specific rows before proceeding.
-- Deleting or backfilling existing data is not this migration's call to
-- make unilaterally.

ALTER TABLE mt_ai_trace_payloads
  ADD CONSTRAINT mt_ai_trace_payloads_at_least_one_payload
  CHECK (request_payload IS NOT NULL OR response_payload IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════════
-- B — compile precondition for Step D's CREATE FUNCTION body (references
-- e.trace_id). Already confirmed live by Nethaji, 2026-09-12 — re-run as a
-- safety net against dev/prod drift, since this file is applied to both
-- environments separately.
-- ═══════════════════════════════════════════════════════════════════

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'mt_ai_usage_events'
  AND column_name IN ('id', 'trace_id', 'company_id', 'app_id')
ORDER BY column_name;
-- Expect all four columns present (id/company_id/app_id NOT NULL, trace_id
-- nullable). If any are missing on the environment you're running this
-- against, STOP — do not proceed to Step D.

-- ═══════════════════════════════════════════════════════════════════
-- C — capture current state before touching anything
-- ═══════════════════════════════════════════════════════════════════

-- Current owner and full definition — save this output. If this migration
-- ever needs to be rolled back, this is the exact statement that restores
-- the pre-migration function.
SELECT p.oid::regprocedure AS signature,
       p.proowner::regrole AS current_owner,
       pg_get_functiondef(p.oid) AS full_current_definition
FROM pg_proc p
WHERE p.oid = 'public.mt_ai_cost_events_list(uuid,text,timestamptz,timestamptz)'::regprocedure;

-- Dependency check — catalog-tracked (views, functions referencing this
-- one as an object, not just by name in a string):
SELECT classid::regclass, objid, deptype
FROM pg_depend
WHERE refobjid = 'public.mt_ai_cost_events_list(uuid,text,timestamptz,timestamptz)'::regprocedure;

-- Dependency check — text-level references pg_depend does not track.
-- BUG FOUND LIVE (2026-09-14, running this migration against pgt-dev):
-- `pg_get_functiondef(p.oid)` errors with "<name> is an aggregate
-- function" (42809/wrong_object_type) the moment it's evaluated against
-- an aggregate's pg_proc row (array_agg, count, sum, ...) — it only
-- accepts ordinary functions/procedures. The original query scanned every
-- row in pg_proc with no prokind/schema filter, so it was guaranteed to
-- hit a built-in aggregate and fail before ever reaching a real result.
-- Restricting to p.prokind = 'f' (ordinary functions only) in the
-- public schema — the only place a real dependent could live for this
-- app — both fixes the error and is the query this comment always meant
-- to run.
SELECT n.nspname, p.proname, pg_get_function_arguments(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind = 'f'
  AND n.nspname = 'public'
  AND pg_get_functiondef(p.oid) ILIKE '%mt_ai_cost_events_list%'
  AND p.proname != 'mt_ai_cost_events_list';

SELECT schemaname, viewname FROM pg_views WHERE definition ILIKE '%mt_ai_cost_events_list%';
-- If any of the three queries above returns a row, stop and evaluate that
-- specific dependency before proceeding to Step D.

-- ═══════════════════════════════════════════════════════════════════
-- D — DROP + CREATE mt_ai_cost_events_list, CREATE mt_ai_trace_payload_get,
-- one transaction, one NOTIFY. Run this entire block as ONE paste.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- Bare DROP FUNCTION, not IF EXISTS — if this signature doesn't match
-- what's actually live, this must fail loudly (transaction rolls back
-- cleanly) rather than silently no-op while everything downstream checks
-- the wrong thing.
DROP FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz);

-- Full body, no ellipsis. Every existing column and the calculated_cost
-- formula are copied character-for-character from the live pre-migration
-- body (the known cache_read_price_per_mtok discrepancy this codebase has
-- separately tracked as out-of-scope is untouched). Adds ONLY
-- usage_event_id/trace_id, both NULL-masked for non-governance roles.
CREATE FUNCTION public.mt_ai_cost_events_list(
  p_company_id uuid, p_app_id text,
  p_period_start timestamp with time zone, p_period_end timestamp with time zone
)
 RETURNS TABLE(
   request_started_at timestamp with time zone, product_id uuid, user_id uuid,
   user_role_at_call text, caller text, prompt_version text, provider text,
   requested_model text, response_model text, selection_rule text,
   input_tokens integer, output_tokens integer, cache_creation_5m_tokens integer,
   cache_creation_1h_tokens integer, cache_read_tokens integer, status text,
   error_type text, failure_phase text, duration_ms integer, request_bytes integer,
   response_bytes integer, tier text, input_price_per_mtok numeric,
   output_price_per_mtok numeric, calculated_cost numeric, outcome_id uuid,
   units_generated integer,
   usage_event_id uuid,   -- NEW, NULL-masked for non-governance roles
   trace_id uuid          -- NEW, NULL-masked for non-governance roles
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_can_view_payloads boolean;
BEGIN
  IF NOT _cost_tower_can_access(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read cost events for company %', p_company_id;
  END IF;

  -- Computed once per call, not once per row.
  v_can_view_payloads := _cost_tower_can_manage_governance(p_company_id, p_app_id);

  RETURN QUERY
  SELECT
    e.request_started_at, e.product_id, e.user_id, e.user_role_at_call,
    e.caller, e.prompt_version, e.provider, e.requested_model, e.response_model,
    e.selection_rule, e.input_tokens, e.output_tokens,
    e.cache_creation_5m_tokens, e.cache_creation_1h_tokens, e.cache_read_tokens,
    e.status, e.error_type, e.failure_phase, e.duration_ms, e.request_bytes, e.response_bytes,
    p.tier, p.input_price_per_mtok, p.output_price_per_mtok,
    CASE WHEN p.id IS NULL THEN NULL ELSE
        (e.input_tokens::numeric / 1000000) * p.input_price_per_mtok
      + (e.output_tokens::numeric / 1000000) * p.output_price_per_mtok
      + (COALESCE(e.cache_creation_5m_tokens,0)::numeric / 1000000) * p.cache_write_5m_price_per_mtok
      + (COALESCE(e.cache_creation_1h_tokens,0)::numeric / 1000000) * p.cache_write_1h_price_per_mtok
      + (COALESCE(e.cache_read_tokens,0)::numeric / 1000000) * p.cache_read_price_per_mtok
    END AS calculated_cost,
    e.outcome_id, e.units_generated,
    CASE WHEN v_can_view_payloads THEN e.id ELSE NULL END AS usage_event_id,
    CASE WHEN v_can_view_payloads THEN e.trace_id ELSE NULL END AS trace_id
  FROM mt_ai_usage_events e
  LEFT JOIN mt_model_pricing p
    ON p.provider = e.provider
   AND p.model_name = COALESCE(e.response_model, e.requested_model)
   AND e.request_started_at >= p.effective_from
   AND (p.effective_to IS NULL OR e.request_started_at < p.effective_to)
  WHERE e.company_id = p_company_id
    AND e.app_id = p_app_id
    AND e.request_started_at >= p_period_start
    AND e.request_started_at < p_period_end;
END;
$function$;

-- DROP removes the function object and every grant on it — restore
-- explicitly rather than rely on Postgres's default privilege behavior.
REVOKE EXECUTE ON FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz)
  TO authenticated;

-- Optional, only if Step C's captured owner differs from the role running
-- this migration:
-- ALTER FUNCTION public.mt_ai_cost_events_list(uuid, text, timestamptz, timestamptz)
--   OWNER TO <original_owner_from_step_C>;

-- New RPC for the browser read path — the existing /v1/trace-payloads
-- route is API-key-only and unreachable from a Supabase Auth session.
-- CREATE OR REPLACE is safe here (entirely new function, no return-shape
-- change from any pre-existing version) but still needs its own
-- REVOKE/GRANT in this same transaction, not left implicit.
CREATE OR REPLACE FUNCTION public.mt_ai_trace_payload_get(
  p_company_id     uuid,
  p_app_id         text,
  p_usage_event_id uuid
)
 RETURNS TABLE(
   payload_id       uuid,
   request_payload  jsonb,
   response_payload jsonb,
   created_at       timestamptz,
   expires_at       timestamptz,
   is_expired       boolean
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT _cost_tower_can_manage_governance(p_company_id, p_app_id) THEN
    RAISE EXCEPTION 'Not authorized to read trace payloads for company %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT tp.payload_id, tp.request_payload, tp.response_payload, tp.created_at, tp.expires_at,
    (tp.expires_at < now()) AS is_expired
  FROM mt_ai_trace_payloads tp
  JOIN mt_ai_usage_events e ON e.id = tp.usage_event_id
  WHERE tp.usage_event_id = p_usage_event_id
    AND tp.company_id = p_company_id
    AND tp.app_id = p_app_id
    AND e.company_id = p_company_id
    AND e.app_id = p_app_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.mt_ai_trace_payload_get(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_ai_trace_payload_get(uuid, text, uuid)
  TO authenticated;

-- Force PostgREST to pick up BOTH new/changed signatures at once, after
-- both function bodies above have been created.
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════
-- E — post-commit verification (run after COMMIT succeeds, not inside the
-- transaction — these check functions that only exist once D has committed)
-- ═══════════════════════════════════════════════════════════════════

-- Owner check, mt_ai_cost_events_list — compare against Step C's captured
-- owner. SECURITY DEFINER means the function runs with its own owner's
-- privileges; if the role that ran this migration differs from the
-- original owner, the recreated function's runtime privilege profile has
-- changed, silently, even though the SQL body is identical.
SELECT p.oid::regprocedure AS signature, p.proowner::regrole AS owner_after_recreate
FROM pg_proc p
WHERE p.oid = 'public.mt_ai_cost_events_list(uuid,text,timestamptz,timestamptz)'::regprocedure;

-- Owner-can-actually-read-the-tables-it-queries check, for BOTH functions
-- and every table each one reads. Passing each function's own internal
-- role check does not guarantee its owner has table-level SELECT access —
-- a false here means a permission-denied error at runtime, a different
-- failure mode than an authorization rejection.
WITH fn AS (
  SELECT
    p.oid::regprocedure::text AS function_signature,
    p.proowner::regrole::text AS owner_name
  FROM pg_proc p
  WHERE p.oid IN (
    'public.mt_ai_cost_events_list(uuid,text,timestamptz,timestamptz)'::regprocedure,
    'public.mt_ai_trace_payload_get(uuid,text,uuid)'::regprocedure
  )
)
SELECT
  function_signature,
  owner_name,
  has_table_privilege(owner_name, 'public.mt_ai_usage_events', 'SELECT') AS owner_can_select_usage_events,
  has_table_privilege(owner_name, 'public.mt_model_pricing', 'SELECT') AS owner_can_select_model_pricing,
  has_table_privilege(owner_name, 'public.mt_ai_trace_payloads', 'SELECT') AS owner_can_select_trace_payloads
FROM fn;
-- Expected: for mt_ai_cost_events_list, usage_events=true and
-- model_pricing=true (trace_payloads irrelevant to this function). For
-- mt_ai_trace_payload_get, usage_events=true and trace_payloads=true
-- (model_pricing irrelevant).

-- supabase.rpc(...) from actual client code (not only pg_proc/SQL-editor
-- checks) must be used to confirm the NOTIFY above actually took effect
-- for both functions — PostgREST's cache and Postgres's own catalog can
-- disagree until that NOTIFY is processed.

-- ═══════════════════════════════════════════════════════════════════
-- F — remaining §5.2 verification queries
-- ═══════════════════════════════════════════════════════════════════

-- 1. Confirm new columns exist on mt_ai_cost_events_list's return shape
SELECT p.proname, pg_get_function_result(p.oid) AS returns
FROM pg_proc p WHERE p.proname = 'mt_ai_cost_events_list';
-- expect: return type string includes "usage_event_id uuid" and "trace_id uuid"

-- 2. Confirm grants — authenticated can execute, anon cannot.
SELECT
  has_function_privilege('authenticated',
    'public.mt_ai_cost_events_list(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('anon',
    'public.mt_ai_cost_events_list(uuid,text,timestamptz,timestamptz)', 'EXECUTE') AS anon_can_execute;
-- expect: authenticated_can_execute = true, anon_can_execute = false

-- 3. Confirm mt_ai_trace_payload_get exists with the correct signature and grants
SELECT p.proname, pg_get_function_arguments(p.oid) AS arguments
FROM pg_proc p WHERE p.proname = 'mt_ai_trace_payload_get';

SELECT
  has_function_privilege('authenticated',
    'public.mt_ai_trace_payload_get(uuid,text,uuid)', 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('anon',
    'public.mt_ai_trace_payload_get(uuid,text,uuid)', 'EXECUTE') AS anon_can_execute;

-- 4. As an admin OR member (role) test user: confirm a known usage_event_id
--    with a real payload row returns exactly one row, with real content.
--    Requires a real member-role test user (spec §8.2 item 5) — run once
--    one exists; not a design blocker.
-- SELECT * FROM mt_ai_trace_payload_get('<company>', '<app_id>', '<known usage_event_id with a payload>');

-- 5. Same call, usage_event_id known to have NO payload row: confirm zero
--    rows returned, not an exception — confirm from the ACTUAL BROWSER
--    CLIENT via supabase.rpc(...), not only via SQL editor.

-- 6. As a readonly-role test user: confirm the SAME call as #4 raises the
--    authorization exception rather than returning data.

-- 7. Confirm mt_ai_cost_events_list still returns the same row count and
--    same calculated_cost values as before this migration, for a known
--    period — purely additive, never changes existing rows or columns.

-- 8. Confirm the constraint added in Step A now exists:
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'mt_ai_trace_payloads'::regclass AND contype = 'c';

-- 9. Confirm the FK delete-cascade behavior on mt_ai_trace_payloads:
SELECT conname, contype, confdeltype, convalidated
FROM pg_constraint
WHERE conrelid = 'mt_ai_trace_payloads'::regclass
  AND contype = 'f'
  AND pg_get_constraintdef(oid) ILIKE '%usage_event_id%';
-- expect confdeltype = 'c' (CASCADE) and convalidated = true

-- Query #10 (trace_id-population correlation, from earlier spec drafts) is
-- deliberately omitted — retired per the spec's v0.10/v0.13 correction: the
-- shipped v9.34 Universal Payload Capture migration gates payload capture
-- independently of trace/span creation, so trace_id IS NULL does not
-- reliably mean "no payload" and no correlation query over existing rows
-- could have validated that assumption either way.
