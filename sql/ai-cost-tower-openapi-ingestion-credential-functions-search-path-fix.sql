-- AI Cost Control Tower: OpenAPI Ingestion Layer — search_path fix
--
-- SUPERSEDED — kept only as the historical record of the exact statements
-- run against pgt-dev/pgt-prod on 2026-09-07. The fix below has since been
-- folded directly into sql/ai-cost-tower-openapi-ingestion-credential-functions.sql
-- itself (that file's CREATE OR REPLACE is idempotent, so a fresh
-- environment now gets the corrected definition straight from the
-- original file with no separate patch step required). Also corrected
-- there, not repeated here: search_path lists 'extensions' before
-- 'public' (this file had it the other way around, the less-safe
-- direction for a SECURITY DEFINER function), both pgcrypto calls are
-- fully schema-qualified, and 'pg_temp' is included to match this
-- project's convention for every other SECURITY DEFINER function.
-- Do not re-run this file — run the original file instead if you need to
-- (re-)apply these functions.
--
-- Bug found when actually calling admin_issue_company_app_credential for
-- the first time (Section 3, credential issuance): both credential
-- functions failed at runtime with
--   ERROR: 42883: function gen_random_bytes(integer) does not exist
-- Section 9 only confirmed pgcrypto was INSTALLED, never which SCHEMA —
-- Supabase installs extensions into a separate `extensions` schema by
-- default, not `public`. Both functions' `SET search_path TO 'public'`
-- silently excludes it, so gen_random_bytes/digest were never reachable,
-- in either environment, since Phase 2 first created these functions.
--
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify with a real
-- SELECT admin_issue_company_app_credential(...) call, THEN prod.
-- Per this project's convention: not run by Claude Code, executed manually.
--
-- Confirm before running: expect 'extensions' (or wherever your prior
-- diagnostic query showed pgcrypto actually living) —
--   SELECT extname, extnamespace::regnamespace AS schema FROM pg_extension WHERE extname = 'pgcrypto';
-- If it shows a different schema, replace 'extensions' below with that
-- schema name before running.

CREATE OR REPLACE FUNCTION admin_issue_company_app_credential(p_company_id uuid, p_app_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_plaintext text;
  v_hash text;
  v_confirmed uuid;
BEGIN
  v_plaintext := 'ct_' || encode(gen_random_bytes(32), 'hex');
  v_hash := encode(digest(v_plaintext, 'sha256'), 'hex');

  INSERT INTO mt_company_apps (company_id, app_id, is_active, granted_at, credential_hash, credential_created_at)
  VALUES (p_company_id, p_app_id, true, now(), v_hash, now())
  ON CONFLICT (company_id, app_id) DO UPDATE
    SET credential_hash = v_hash,
        credential_created_at = now(),
        is_active = true
    WHERE mt_company_apps.credential_hash IS NULL
  RETURNING company_id INTO v_confirmed;

  IF v_confirmed IS NULL THEN
    RAISE EXCEPTION 'A credential already exists for this company/app (or was just issued by a concurrent call). Use admin_rotate_company_app_credential to reissue.';
  END IF;

  RETURN v_plaintext;
END;
$function$;

CREATE OR REPLACE FUNCTION admin_rotate_company_app_credential(p_company_id uuid, p_app_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_plaintext text;
BEGIN
  v_plaintext := 'ct_' || encode(gen_random_bytes(32), 'hex');

  UPDATE mt_company_apps
  SET credential_hash = encode(digest(v_plaintext, 'sha256'), 'hex'),
      credential_created_at = now()
  WHERE company_id = p_company_id AND app_id = p_app_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existing grant for this company/app. Use admin_issue_company_app_credential first.';
  END IF;

  RETURN v_plaintext;
END;
$function$;

-- REVOKE is not re-granted by CREATE OR REPLACE dropping/losing prior
-- grants -- REPLACE keeps the function's existing privileges intact, but
-- re-running this costs nothing and confirms it explicitly rather than
-- trusting that behavior.
REVOKE EXECUTE ON FUNCTION admin_issue_company_app_credential(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_rotate_company_app_credential(uuid, text) FROM PUBLIC, anon, authenticated;

-- Verify the revoke is still correct after CREATE OR REPLACE — expect only
-- postgres/service_role rows, same as Phase 2's original verification.
SELECT grantee, privilege_type FROM information_schema.role_routine_grants
WHERE routine_name IN ('admin_issue_company_app_credential', 'admin_rotate_company_app_credential');
