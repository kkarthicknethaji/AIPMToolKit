-- AI Cost Control Tower: OpenAPI Ingestion Layer — Phase 2 credential functions
-- Source: ai-cost-tower-openapi-ingestion-spec.md v0.11, Section 4.4.
-- Run in Supabase SQL editor. DEV FIRST (pgt-dev), verify, THEN prod (pgt-prod).
-- Per this project's convention: not run by Claude Code, executed manually.
--
-- Deliberately excludes: the HCLTech-Internal company seed and app
-- registration (onboarding-time steps, run once there's a real first
-- consuming app — not part of the platform build itself). Preconditions
-- (pgcrypto enabled, credential_hash typed text) already confirmed clean
-- in both environments per Section 9, not re-checked here.
--
-- Code-review fix, applied directly here rather than left in a separate
-- patch file: both functions originally shipped with SET search_path TO
-- 'public' alone. pgcrypto lives in Supabase's `extensions` schema, not
-- `public`, so gen_random_bytes/digest were never actually reachable —
-- confirmed by a real runtime failure the first time either function was
-- actually called ("function gen_random_bytes(integer) does not exist").
-- Fixed two ways, not just one: `extensions` is listed AHEAD of `public`
-- in search_path (a SECURITY DEFINER function resolving unqualified names
-- through a schema lower-privileged roles could write to, searched before
-- the trusted extension schema, is the classic search-path-shadowing risk
-- against SECURITY DEFINER functions — same class as CVE-2018-1058), and
-- the two pgcrypto calls are also fully schema-qualified
-- (extensions.gen_random_bytes/extensions.digest) so correctness never
-- actually depends on search_path order at all, only defense-in-depth
-- does. `pg_temp` added to match every other SECURITY DEFINER function's
-- search_path convention elsewhere in this project's sql/ files.
-- This file's CREATE OR REPLACE is idempotent — re-running it against an
-- environment that already has the old (buggy) definition safely converges
-- to this corrected one, exactly as if it had been correct from the start.

-- ═══════════════════════════════════════════════════════════════════
-- admin_issue_company_app_credential — only succeeds if no credential
-- exists yet for this (company_id, app_id) pair. Race-safe: the guard is
-- folded into the same atomic INSERT ... ON CONFLICT ... RETURNING
-- statement, not a separate check-then-act SELECT (finding #15).
-- ═══════════════════════════════════════════════════════════════════

-- STEP 1 — create admin_issue_company_app_credential.
CREATE OR REPLACE FUNCTION admin_issue_company_app_credential(p_company_id uuid, p_app_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
  v_plaintext text;
  v_hash text;
  v_confirmed uuid;
BEGIN
  v_plaintext := 'ct_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_plaintext, 'sha256'), 'hex');

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

-- ═══════════════════════════════════════════════════════════════════
-- admin_rotate_company_app_credential — explicit, separate call, the
-- only way to reissue an existing credential. Deliberately NOT given the
-- same atomic-guard treatment as issue: last-write-wins is correct for an
-- operation whose entire purpose is invalidate-and-replace (see spec's
-- honest justification, finding #23 — rare, single-operator, a
-- coordination question rather than something the function can detect).
-- ═══════════════════════════════════════════════════════════════════

-- STEP 2 — create admin_rotate_company_app_credential.
CREATE OR REPLACE FUNCTION admin_rotate_company_app_credential(p_company_id uuid, p_app_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'extensions', 'public', 'pg_temp'
AS $function$
DECLARE
  v_plaintext text;
BEGIN
  v_plaintext := 'ct_' || encode(extensions.gen_random_bytes(32), 'hex');

  UPDATE mt_company_apps
  SET credential_hash = encode(extensions.digest(v_plaintext, 'sha256'), 'hex'),
      credential_created_at = now()
  WHERE company_id = p_company_id AND app_id = p_app_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existing grant for this company/app. Use admin_issue_company_app_credential first.';
  END IF;

  RETURN v_plaintext;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════
-- Lock down execution — Postgres grants EXECUTE to PUBLIC by default on
-- function creation, and Supabase exposes public functions over PostgREST
-- automatically. Without this, both functions would be callable by any
-- anon/authenticated caller, a complete bypass of "operator-run only"
-- (finding #17, Blocking).
-- ═══════════════════════════════════════════════════════════════════

-- STEP 3 — revoke execution from PUBLIC/anon/authenticated on both functions.
REVOKE EXECUTE ON FUNCTION admin_issue_company_app_credential(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_rotate_company_app_credential(uuid, text) FROM PUBLIC, anon, authenticated;

-- STEP 4 — verify the revoke actually took. Expect ZERO rows in both
-- environments. Any row here means one of the two functions is still
-- callable by anon/authenticated over PostgREST — a credential-forgery
-- hole. Do not proceed to onboarding or Phase 3 if this returns anything.
SELECT grantee, privilege_type FROM information_schema.role_routine_grants
WHERE routine_name IN ('admin_issue_company_app_credential', 'admin_rotate_company_app_credential');
