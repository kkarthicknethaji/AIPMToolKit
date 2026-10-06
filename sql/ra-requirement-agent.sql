-- Requirement Agent (v9.16) — RQ sequence counter + atomic RPC.
-- Per AI_EDITING_RULES.md / this build's task spec: NOT run by Claude. Write
-- to disk only — Nethaji runs this against Supabase (dev, then prod) on his
-- own timeline, per scratchpad/ra-preflight.sql's confirmed findings:
--   - mt_sessions.snapshot is JSONB, no fixed shape (raConversations[] lives
--     there — no new table needed for the conversation data itself).
--   - mt_sessions.last_tab has no CHECK constraint — 'ra' is a valid value
--     with zero migration required for that column.
--   - RLS on mt_sessions is current_app_user()-based (NOT auth.uid()) — the
--     RPC below matches that convention exactly.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION, safe to
-- re-run.

ALTER TABLE mt_sessions
  ADD COLUMN IF NOT EXISTS ra_seq_counter integer NOT NULL DEFAULT 0;

-- ra_next_seq(p_session_id): atomically increments and returns the next RQ
-- sequence number for a session. SECURITY DEFINER so it can bypass RLS for
-- the UPDATE itself, but re-derives the caller's identity via
-- current_app_user() and re-checks ownership + active, non-readonly company
-- membership inline (mirrors acquire_generation_lock()/save_shared_session_content()'s
-- own pattern in proxy/server.js's RPC family — never trust the client-sent
-- session id alone). Single UPDATE...RETURNING — no read-then-write race.
CREATE OR REPLACE FUNCTION ra_next_seq(p_session_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_next integer;
  v_caller uuid := current_app_user();
BEGIN
  UPDATE mt_sessions
  SET ra_seq_counter = ra_seq_counter + 1
  WHERE id = p_session_id
    AND user_id = v_caller
    AND EXISTS (
      SELECT 1 FROM mt_users_companies uc
      WHERE uc.company_id = mt_sessions.company_id
        AND uc.user_id = v_caller
        AND uc.is_active
        AND uc.role <> 'readonly'
    )
  RETURNING ra_seq_counter INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Unable to assign requirement sequence for session %: not found or insufficient permission', p_session_id;
  END IF;

  RETURN v_next;
END;
$$;

GRANT EXECUTE ON FUNCTION ra_next_seq(uuid) TO authenticated;

-- ─── Post-flight validation (run manually after applying, not by app code) ───

-- 1. Column exists, correct type/default:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'mt_sessions' AND column_name = 'ra_seq_counter';

-- 2. Function exists, SECURITY DEFINER, correct owner:
-- SELECT proname, prosecdef, pg_get_functiondef(oid)
-- FROM pg_proc WHERE proname = 'ra_next_seq';

-- 3. Sanity call as the owning user (via app, or psql with role impersonation) —
--    confirm it increments by exactly 1 per call and errors for a session
--    the caller doesn't own / isn't an active non-readonly member of:
-- SELECT ra_next_seq('00000000-0000-0000-0000-000000000000'::uuid);

-- 4. Confirm two rapid concurrent calls against the SAME session never
--    return the same integer twice (atomicity check) — e.g. run the same
--    SELECT ra_next_seq(...) from two separate psql sessions back-to-back
--    and confirm the two returned integers differ.

-- 5. Confirm a readonly company member's call raises the permission
--    exception (role <> 'readonly' predicate is doing its job).
