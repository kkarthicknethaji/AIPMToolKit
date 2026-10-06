-- mt_sessions readonly-role mutation guard (v9.29.01 security fix).
-- Per AI_EDITING_RULES.md: NOT run by Claude. Write to disk only — run this
-- against Supabase (dev, then prod) manually.
--
-- Gap this closes: mt_sessions' existing RLS UPDATE/DELETE policies are
-- ownership-only (user_id = current_app_user()), with no role condition —
-- confirmed via ra-requirement-agent.sql's own comment ("RLS on mt_sessions
-- is current_app_user()-based (NOT auth.uid())") and ra_next_seq()'s inline
-- re-check pattern below, which exists specifically because base RLS does
-- NOT already enforce role. A company member demoted to 'readonly' who
-- still OWNS older sessions can therefore still rename/delete/share those
-- sessions via a direct Supabase REST/RPC call — e.g. from browser devtools
-- — even with every client-side UI control (the 3-dot menu, canEditSession())
-- hidden/blocked, since client-side JS is never a real security boundary.
--
-- Fix: three SECURITY DEFINER RPCs, mirroring ra_next_seq()'s exact
-- pattern (mt-sessions ownership + active non-readonly company membership,
-- re-derived server-side via current_app_user(), never trusting the
-- client-sent session id alone). The client (scripts/session-store.js) is
-- updated to call these instead of raw .update()/.delete() against
-- mt_sessions directly, so the role check is actually exercised on every
-- rename/delete/share-toggle, not just at the UI layer.
--
-- p_company_id (all three RPCs) restores the cross-company scoping the
-- prior client-side-only `.eq('company_id', activeCompanyId)` guard gave —
-- without it, a caller who owns a session in Company A and remains a
-- non-readonly member of Company A could mutate it via direct RPC call
-- regardless of which company is presently active in their browser. NULL
-- (the default) skips this specific check, matching the old guard's own
-- behavior when activeCompanyId wasn't available client-side — ownership +
-- non-readonly role are still always required either way.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, safe to re-run.

-- ─── Shared authorization check, reused by all three RPCs below ───
-- One definition instead of three copies of the same ownership+role+
-- (optional) company-scope subquery, so a future change to the rule (e.g.
-- a grace period, or an additional role) only needs to be made once.
CREATE OR REPLACE FUNCTION _mt_session_can_mutate(p_owner_user_id uuid, p_session_company_id uuid, p_caller uuid, p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_owner_user_id = p_caller
     AND (p_company_id IS NULL OR p_session_company_id = p_company_id)
     AND EXISTS (
       SELECT 1 FROM mt_users_companies uc
       WHERE uc.company_id = p_session_company_id
         AND uc.user_id = p_caller
         AND uc.is_active
         AND uc.role <> 'readonly'
     );
$$;

CREATE OR REPLACE FUNCTION mt_session_rename(p_session_id uuid, p_new_name text, p_company_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller uuid := current_app_user();
  v_id uuid;
BEGIN
  UPDATE mt_sessions
  SET name = p_new_name
  WHERE id = p_session_id
    AND _mt_session_can_mutate(user_id, company_id, v_caller, p_company_id)
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Unable to rename session %: not found or insufficient permission', p_session_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_session_rename(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION mt_session_delete(p_session_id uuid, p_company_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller uuid := current_app_user();
  v_id uuid;
BEGIN
  DELETE FROM mt_sessions
  WHERE id = p_session_id
    AND _mt_session_can_mutate(user_id, company_id, v_caller, p_company_id)
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Unable to delete session %: not found or insufficient permission', p_session_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_session_delete(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION mt_session_set_shared(p_session_id uuid, p_is_shared boolean, p_share_mode text, p_company_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_caller uuid := current_app_user();
  v_id uuid;
BEGIN
  UPDATE mt_sessions
  SET is_shared = p_is_shared, share_mode = p_share_mode
  WHERE id = p_session_id
    AND _mt_session_can_mutate(user_id, company_id, v_caller, p_company_id)
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Unable to update sharing for session %: not found or insufficient permission', p_session_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION mt_session_set_shared(uuid, boolean, text, uuid) TO authenticated;

-- ─── Post-flight validation (run manually after applying, not by app code) ───

-- 1. Functions exist with SECURITY DEFINER:
-- SELECT proname, prosecdef FROM pg_proc
-- WHERE proname IN ('mt_session_rename','mt_session_delete','mt_session_set_shared');

-- 2. As a 'readonly'-role user who OWNS a session, confirm each RPC now
--    raises (was previously a silent client-side-only block, but the raw
--    table UPDATE/DELETE beneath it would have succeeded):
-- SELECT mt_session_rename('<owned-session-id>', 'test'); -- expect exception
-- SELECT mt_session_delete('<owned-session-id>');          -- expect exception
-- SELECT mt_session_set_shared('<owned-session-id>', true, 'view'); -- expect exception

-- 3. As a non-readonly owner, confirm the RPCs still succeed normally
--    (same session, role reverted to a non-readonly membership).

-- 4. Cross-company scoping: as a non-readonly member of Company A who owns
--    a session there, call mt_session_delete('<company-A-session-id>',
--    '<company-B-id>') — expect exception (company mismatch), then the
--    same call with '<company-A-id>' or NULL — expect success.
