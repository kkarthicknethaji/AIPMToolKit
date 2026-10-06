// SESSION STORE — v8.24
// localStorage abstraction layer for session persistence.
// All reads/writes to localStorage go through this file only.
// Other files call: sessionStoreCreate, sessionStoreSave, sessionStoreRestore,
//                   sessionStoreDelete, sessionStoreList, sessionStoreRename,
//                   sessionStoreSyncFromDB
//
// Step 6 (v8.24): write-through cache pattern.
//   - localStorage: fast local cache (all reads)
//   - Supabase:     authoritative store (all writes + sync on login)
//   - Failure mode: Supabase errors are logged and silently skipped;
//                   localStorage always written first so the app never blocks.

// ── Constants ──
const _SS_PREFIX = 'pgt_session_';
const _SS_INDEX  = 'pgt_session_index'; // ordered list of session IDs
// v9.31: always-complete, uncapped meta cache — { [sessionId]: meta }.
// Introduced so sessionStoreList() (Home's session library) never depends
// on the full { meta, snapshot } blob under _SS_PREFIX, which is what the
// v9.31 snapshot-only eviction cap (see sessionStoreSyncFromDB) actually
// prunes. Every id in _SS_INDEX always has a corresponding entry here —
// this key is never subject to the cap.
const _SS_META_INDEX = 'pgt_session_meta';
// v9.31: total local-cache budget for full { meta, snapshot } blobs, in
// stringified JS-string-length bytes (same unit sessionStoreSave's existing
// 3500000-byte single-entry guard uses, for consistency). 4MB comfortably
// holds one entry at that existing per-entry ceiling with ~500KB left over
// for others, while staying well under the ~5.5MB that caused the original
// QuotaExceededError incident. See sessionStoreSyncFromDB for how it's
// enforced — never against _SS_INDEX or _SS_META_INDEX, only the bulky
// full blobs.
const _SS_SNAPSHOT_BUDGET_BYTES = 4 * 1024 * 1024;
// mt_ prefix is permanent — Phase 6 (rename cutover) was evaluated and
// deliberately decided against: mt_ reads as "multi-tenant," a genuinely
// self-documenting convention, and the rename carried real cutover risk
// (coordinated Render/Netlify/DB deploy, stale open-tab handling, forced
// client reload) for zero user-facing benefit. See multi-user-rbac-spec.md
// for the full decision record.
const _SS_TABLE = 'mt_sessions';

// Active session ID — set by sessionStoreCreate, cleared by homeClearSession
var _activeSessionId = null;
// Phase 5: tracks whether the CURRENTLY ACTIVE session is shared (is_shared).
// Set alongside _activeSessionId in sessionStoreCreate()/sessionStoreRestore(),
// cleared in homeClearSession(). Read by withGenerationLock() (api.js) to
// decide whether to acquire/heartbeat/release the generation lock at all —
// private sessions skip locking entirely, zero added latency.
var _activeSessionIsShared = false;
// v8.128: tracks the owner (user_id) of the CURRENTLY ACTIVE session — set
// alongside _activeSessionIsShared at the same points, cleared in
// homeClearSession(). Unlike is_shared, ownership never changes for an
// existing session, so there's no equivalent staleness concern here. Read
// by hdrApplySessionNameVisibility()/hdrRenameSession() to gate the header
// rename control for non-owners of a shared session — a real, live gap
// found in testing: that control had no ownership check of any kind.
var _activeSessionOwnerId = null;
// v9.08: tracks the share mode ('view'|'edit') of the CURRENTLY ACTIVE
// session. Defaults to 'view' (fail-closed), not 'edit' — an earlier draft
// of this design defaulted to 'edit', which would silently render a
// session as fully editable if some restore path ever failed to set this
// explicitly. Set alongside _activeSessionIsShared/_activeSessionOwnerId
// at both existing capture points (sessionStoreCreate, sessionStoreRestore),
// cleared in homeClearSession(). Read only by canEditSession() below.
var _activeSessionShareMode = 'view';

// v9.08: single source of truth for "can the current user mutate the
// active session." Owner can always edit their own session regardless of
// its share mode (matches the server-side RPC logic exactly). A private,
// non-shared session is always editable by its owner. A shared session is
// editable only if share_mode is explicitly 'edit'. Any unrecognized/
// missing state falls through to false — fails closed, not open.
// Shared, fail-closed role check — hoisted out of canEditSession() so every
// readonly-role gate in this codebase (canEditSession() below, the session
// card render/mutation guards, the header rename control) shares ONE
// fail-closed definition instead of each hand-copying the comparison with
// its own undefined/null handling.
function _ssIsReadOnlyRole(){
  return typeof currentUserRole === 'undefined' || currentUserRole === null || currentUserRole === 'readonly';
}
function canEditSession(){
  var uid = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
  if (!uid) return false;
  // v9.09 — role check runs FIRST, before ownership. Closes two real gaps
  // found in adversarial review: (1) a user demoted to 'readonly' who still
  // owns older sessions previously retained full edit rights via the
  // ownership branch below, since that branch never checked role at all;
  // (2) fails CLOSED on any unrecognized/null/undefined role, not just an
  // exact 'readonly' match — a stale or failed role load now denies edit
  // rather than falling through to the permissive ownership/share-mode
  // checks. This also means company-level readonly now correctly overrides
  // even an 'edit'-mode session share (confirmed decision — role wins).
  // NOTE — load order: session-store.js loads before main.js in index.html,
  // but currentUserRole is only READ here at call time (this function body
  // doesn't execute at script-parse time), and `var` is script-globally
  // scoped — so main.js has always run and set currentUserRole by the time
  // any caller actually invokes canEditSession(). Safe, but fragile if this
  // function is ever called synchronously during initial script evaluation
  // rather than in response to a later event/render.
  if (_ssIsReadOnlyRole()) return false;
  if (_activeSessionOwnerId && _activeSessionOwnerId === uid) return true;
  if (_activeSessionIsShared === true) return _activeSessionShareMode === 'edit';
  if (_activeSessionIsShared === false) return true;
  return false;
}

// v14 code-review fix (reuse) — the core "is the current user this
// session's owner" check was independently hand-copied three times
// (hdrApplySessionNameVisibility() and hdrRenameSession() below,
// requirement-agent.js's _raCanEditOwner()), with hdrApplySessionNameVisibility()
// deliberately failing OPEN when _activeSessionOwnerId is missing (a
// legacy-record compatibility carve-out, same precedent as the session
// card's own 3-dot menu) while _raCanEditOwner() deliberately fails
// CLOSED (RA has no legacy-record gap to accommodate). Centralizing the
// primitive here lets each caller keep its own, already-correct fail
// direction explicit at the call site instead of re-deriving the
// three-variable comparison by hand: true/false when ownership is known,
// null when unknown — callers choose `!== false` to fail open or
// `=== true` to fail closed.
function _ssIsSessionOwner(){
  var uid=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:null;
  if(!uid)return false;
  if(typeof _activeSessionOwnerId==='undefined'||!_activeSessionOwnerId)return null;
  return _activeSessionOwnerId===uid;
}

// ── Supabase client helper ──
// Returns the initialised Supabase client, or null if unavailable.
// All DB functions call this first and skip silently if null.
function _ssGetClient() {
  return (typeof authInit === 'function') ? authInit() : null;
}

// v8.149 fix (Issue 2): "Last Active" needs to be a real, per-user,
// per-account property — following the person to any device — not
// derived from a session's own global last-saved timestamp (which any
// collaborator's edit can bump, silently hijacking what shows as this
// specific person's own last active session). This calls a dedicated RPC
// (mt_users_companies has no direct UPDATE policy — confirmed — so a
// security-definer RPC does its own access check before writing) and
// updates a local in-memory cache immediately, optimistically, rather
// than waiting on a round trip before Home can reflect it.
var _pgtMyLastActiveSessionId = null;
async function _ssUpdateMyLastActiveSession(sessionId) {
  _pgtMyLastActiveSessionId = sessionId; // optimistic, immediate
  var client = _ssGetClient();
  if (!client || !sessionId) return;
  try {
    await client.rpc('update_my_last_active_session', { p_session_id: sessionId });
  } catch(e) {
    console.warn('[session-store] update_my_last_active_session failed:', e);
  }
}

// ── Private DB upsert helper ──
// Maps a session entry { meta, snapshot } to the Supabase sessions table schema.
// Used by both sessionStoreCreate and sessionStoreSave to avoid duplication.
// Requires currentUser global (set in main.js after auth gate).
// Skips silently if client unavailable or currentUser not set.
// Phase 2 (v8.123, live sync): now returns true/false to reflect whether the
// write genuinely succeeded, instead of always resolving with no result.
// Both existing callers (sessionStoreCreate, sessionStoreSave) already
// ignore the return value entirely — confirmed via grep — so this is not a
// behavior change for either. Added specifically so sessionStoreSave() can
// tell ITS new awaiting callers (the content-event emission call sites)
// whether the DB write actually committed, not just whether the function
// call didn't throw.
async function _ssUpsertToDB(sessionId, entry) {
  const client = _ssGetClient();
  if (!client) return false;
  const uid = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
  if (!uid) {
    console.warn('sessionStore: no currentUser, skipping DB write');
    return false;
  }
  // Phase 1: every session write is stamped with the active company id and
  // last-editor id. company_id is required by mt_sessions' RLS insert policy
  // (must match an active membership) — without it, inserts fail outright.
  const activeCompanyId = (function(){
    try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
  })();
  const meta = entry.meta;

  // v8.129: a non-owner's save was ALWAYS silently failing — RLS only
  // permits a direct UPDATE by the session's owner, confirmed live (a
  // real, pre-existing gap unrelated to this feature, only surfaced now
  // that a non-owner's own save was actually exercised and checked). Fails
  // open toward "owner" for legacy records missing userId, same fallback
  // already used elsewhere in this codebase for the identical reason.
  const _isOwner = !meta.userId || meta.userId === uid;
  if (!_isOwner) {
    try {
      const { data, error } = await client.rpc('save_shared_session_content', {
        p_session_id: sessionId,
        p_last_tab: meta.lastTab || 'mm',
        p_last_stage: meta.lastStage || '',
        p_counts: meta.counts || {},
        p_snapshot: entry.snapshot || {},
        p_saved_at: new Date(meta.savedAt || Date.now()).toISOString()
      });
      if (error) { console.warn('sessionStore RPC save failed:', error.message); return false; }
      // v9.08: the RPC returning a clean `false` (not an error) means the
      // save was rejected by server-side authorization — most likely
      // because access changed (mode flipped to view, or unshared)
      // between this client's last check and this save attempt. Distinct
      // from a network/thrown error, and worth telling the user about
      // specifically, since their work may not have persisted.
      if (data !== true && typeof showToast === 'function') {
        showToast('Your access to this session may have changed. Refresh to confirm your latest changes were saved.', 'warn');
      }
      return data === true;
    } catch(e) {
      console.warn('sessionStore RPC save exception:', e);
      return false;
    }
  }

  try {
    // Phase 5: resolve the saving user's own display name once per upsert —
    // available client-side with zero extra query (authGetUser() reads the
    // already-active Supabase session, no network round-trip beyond what's
    // already cached). Denormalized onto every save, not just shared ones —
    // matches last_edited_by's own existing "cheap to always populate"
    // rationale, and means the name isn't blank if a private session gets
    // shared later. Only ever DISPLAYED on shared cards (home.js) — see B3.
    let _editorName = '';
    try {
      if(typeof authGetUser === 'function'){
        const _u = await authGetUser();
        _editorName = (_u && _u.displayName) || '';
      }
    } catch(e) { console.warn('sessionStore: could not resolve editor display name', e); }
    const { error } = await client.from(_SS_TABLE).upsert({
      id:              sessionId,
      user_id:         uid,
      company_id:      activeCompanyId,
      // v9.13.01: real product FK — NOT NULL on mt_sessions as of this
      // migration. meta.productId is always populated at creation time
      // (see sessionStoreCreate); falling back to null here only matters
      // for any pre-migration in-memory entry that somehow never picked up
      // the backfilled value, which should not occur in practice but is
      // safer than assuming.
      product_id:      meta.productId    || null,
      last_edited_by:  uid,
      last_edited_by_name: _editorName,
      is_shared:       !!meta.isShared,
      // v9.08: written on every owner save so a session created before
      // this feature (share_mode defaulting to 'view' at the DB level)
      // gets an explicit value the first time its owner saves, rather
      // than silently inheriting the column default forever.
      share_mode:      meta.shareMode === 'edit' ? 'edit' : 'view',
      name:            meta.name         || 'Session',
      product_name:    meta.productName  || '',
      company_name:    meta.companyName  || '',
      product_type:    meta.productType  || '',
      approach:        meta.approach     || '',
      last_tab:        meta.lastTab      || 'mm',
      last_stage:      meta.lastStage    || '',
      // v9.15.02 — null for every non-Guided-Launch session (column allows
      // null; see mt_sessions.intake_status CHECK constraint).
      intake_status:   meta.intakeStatus || null,
      counts:          meta.counts       || {},
      snapshot:        entry.snapshot    || {},
      saved_at:        new Date(meta.savedAt || Date.now()).toISOString()
    }, { onConflict: 'id' });
    if (error) { console.warn('sessionStore DB upsert failed:', error.message); return false; }
    return true;
  } catch(e) {
    console.warn('sessionStore DB upsert exception:', e);
    return false;
  }
}

// v9.31 code-review fix: single shared row→meta mapping. Replaces what had
// grown to three independent copies of this same ~20-field mapping
// (sessionStoreSyncFromDB below, _ssFetchSessionRow, and live-sync.js's
// _lsResumePreFetch) — per AI_EDITING_RULES.md item 3 ("check for an
// existing pattern before inventing a new one... silently omitting it is a
// regression risk, not a simplification"). Pure: takes one raw mt_sessions
// row, returns the meta object every one of those call sites needs,
// verbatim, with no side effects.
function _ssRowToMeta(row) {
  return {
    id:          row.id,
    name:        row.name        || 'Session',
    productName: row.product_name || '',
    productId:   row.product_id   || null,
    companyName: row.company_name || '',
    productType: row.product_type || '',
    approach:    row.approach     || '',
    lastTab:     row.last_tab     || 'mm',
    lastStage:   row.last_stage   || '',
    intakeStatus: row.intake_status || null,
    counts:      row.counts       || { caps: 0, features: 0, stories: 0, sprintActive: null },
    createdAt:   row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    savedAt:     row.saved_at   ? new Date(row.saved_at).getTime()   : Date.now(),
    isShared:        !!row.is_shared,
    shareMode:       row.share_mode === 'edit' ? 'edit' : 'view',
    lastEditedByName: row.last_edited_by_name || '',
    activeUserId:    row.active_user_id || null,
    activeAt:        row.active_at ? new Date(row.active_at).getTime() : null,
    activeUserName:  row.active_user_name || '',
    userId:          row.user_id || null
  };
}

// ── Public API ──

// Sync all sessions from Supabase into localStorage.
// Called once on login (main.js DOMContentLoaded), before homeInit().
// Replaces any stale local data with the authoritative DB state.
// On Supabase error: logs warning and leaves localStorage unchanged.
async function sessionStoreSyncFromDB() {
  const client = _ssGetClient();
  if (!client) return;
  // Phase 1, most serious adversarial finding: this query originally had zero
  // company filtering — for anyone in 2+ companies it would have merged every
  // company's sessions into one local index simultaneously, breaking the
  // "switching companies is a separate context" principle this entire feature
  // depends on. The active company id is read from the same key main.js's
  // boot sequence writes before this function is ever allowed to run.
  const activeCompanyId = (function(){
    try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
  })();
  if (!activeCompanyId) {
    // v8.113: previously just returned here, silently skipping the cleanup
    // step below entirely — meaning a zero-company user's previously-cached
    // sessions stayed in localStorage indefinitely, surviving even hard
    // refreshes, since this was the only guard standing between them and the
    // pruning logic that runs later in this function. Now explicitly runs
    // the same cleanup here: delete each individual cached session entry
    // (not just the index array) — stricter than the zero-DB-rows branch
    // below strictly needs, but avoids relying on "nothing ever reads an
    // orphaned entry directly" staying true forever.
    console.warn('sessionStoreSyncFromDB: no active company id — clearing local session cache rather than fetching unscoped data');
    try {
      var staleIds = JSON.parse(localStorage.getItem(_SS_INDEX) || '[]');
      staleIds.forEach(function(id){ try { localStorage.removeItem(_SS_PREFIX + id); } catch(e) {} });
    } catch(e) {}
    try { localStorage.setItem(_SS_INDEX, JSON.stringify([])); } catch(e) {}
    // v9.31 code-review fix: the meta-index mirrors _SS_INDEX's lifecycle
    // exactly (see the zero-DB-rows branch below, which already does this)
    // — without this, a fully-removed company membership left every stale
    // session name in pgt_session_meta forever.
    try { localStorage.setItem(_SS_META_INDEX, JSON.stringify({})); } catch(e) {}
    return;
  }
  try {
    // v9.31: { count: 'exact' } returns the true total matching row count
    // server-side, independent of how many rows actually came back in
    // `data` (subject to Supabase's implicit default page cap — this query
    // has no .range()/.limit()). Used below purely as a safety valve: if
    // the fetch was truncated, this sync must not evict anything, since it
    // can't tell which locally-cached ids are genuinely gone vs. simply
    // off-page.
    const { data, error, count } = await client
      .from(_SS_TABLE)
      .select('*', { count: 'exact' })
      .eq('company_id', activeCompanyId)
      .order('saved_at', { ascending: false });

    if (error) {
      console.warn('sessionStoreSyncFromDB: Supabase query failed:', error.message);
      return;
    }
    if (!data || data.length === 0) {
      // No sessions in DB — clear local index so stale entries don't show.
      // v8.113: also deletes individual entries, not just the index array,
      // matching the stricter cleanup now used in the zero-company branch above.
      try {
        var staleIds2 = JSON.parse(localStorage.getItem(_SS_INDEX) || '[]');
        staleIds2.forEach(function(id){ try { localStorage.removeItem(_SS_PREFIX + id); } catch(e) {} });
      } catch(e) {}
      try { localStorage.setItem(_SS_INDEX, JSON.stringify([])); } catch(e) {}
      // v9.31: the meta-index mirrors _SS_INDEX's lifecycle exactly — clear
      // it here too so it doesn't drift from an empty session list.
      try { localStorage.setItem(_SS_META_INDEX, JSON.stringify({})); } catch(e) {}
      return;
    }

    // v9.31: truncation guard — if the fetch didn't return every matching
    // row, disable eviction for this entire sync pass (every row still
    // gets written normally, as if there were no cap at all this cycle).
    var _syncTruncated = (typeof count === 'number' && count > data.length);
    if (_syncTruncated) {
      console.warn('sessionStoreSyncFromDB: result set truncated (count', count, '> fetched', data.length, ') — skipping snapshot eviction this sync');
    }
    // v9.31: running total of full-blob bytes written so far this sync,
    // used to decide which rows fall outside _SS_SNAPSHOT_BUDGET_BYTES.
    // Rows arrive already sorted saved_at descending (the query's own
    // .order() above), so this naturally keeps the most-recently-touched
    // sessions and evicts the oldest first — no separate sort needed.
    var _runningBudgetBytes = 0;
    // v9.31 code-review fix: previous index, captured before this sync
    // mutates anything — used below to (a) prune orphaned meta/blob entries
    // for ids no longer returned (deleted elsewhere), and (b) union with
    // the fetched ids on a truncated fetch instead of replacing outright.
    var _prevIndexIds = _ssGetIndex();
    // v9.31 code-review fix: batch the meta-index into one read-mutate-
    // write instead of one full read+stringify PER ROW (was O(n²) across a
    // sync of n sessions — exactly the scale this release targets).
    var _metaIdxBatch = _ssGetMetaIndex();

    // Write each row into localStorage in { meta, snapshot } shape
    const ids = [];
    data.forEach(function(row) {
      const meta = _ssRowToMeta(row); // v9.31 code-review fix — was inlined here, see _ssRowToMeta's own comment
      try {
        // Fix 3 (v8.38): protect against stale Supabase snapshot overwriting
        // a locally-cleared downstream state after DM regeneration.
        // If local snapshot has a newer dmRegenAt, preserve its downstream keys.
        var remoteSnapshot = row.snapshot || {};
        // v9.31: hoisted out of the inner try below so the eviction decision
        // further down can consult the same signal the merge already uses —
        // a session carrying an unsynced edit (local ahead of what the DB
        // just returned) must never be actively evicted, only exempted from
        // this pass's budget, or its only surviving copy would be destroyed
        // with no way back (the DB never got it; the local cache no longer
        // would either).
        var _localAheadOfRemote = false;
        var localRaw = null;
        try {
          localRaw = localStorage.getItem(_SS_PREFIX + row.id);
          if (localRaw) {
            var localEntry = JSON.parse(localRaw);
            var localSnap = (localEntry && localEntry.snapshot) || {};
            var localRegenAt = localSnap.dmRegenAt || 0;
            var remoteRegenAt = remoteSnapshot.dmRegenAt || 0;
            if (localRegenAt > remoteRegenAt) {
              _localAheadOfRemote = true;
              // Local cleared more recently — preserve local downstream keys.
              // v9.27 code-review fix: piReadinessPlans/raConversations were
              // missing from this merge — same class of gap as the
              // localStorage pre-clear in kpi-tree.js's _mmRegenProceed(),
              // and _SS_CONTENT_FIELDS below already lists both correctly.
              remoteSnapshot = Object.assign({}, remoteSnapshot, {
                capStore:   localSnap.capStore,
                scCanvas:   localSnap.scCanvas,
                piPlans:    localSnap.piPlans,
                piReadinessPlans: localSnap.piReadinessPlans,
                raConversations:  localSnap.raConversations,
                dmRegenAt:  localSnap.dmRegenAt
              });
            }
          }
        } catch(e) {}

        // v9.31: _SS_INDEX and the meta-index are always-complete — every
        // row this fetch returned gets both, unconditionally, regardless of
        // the snapshot-eviction decision below. This is what keeps every
        // session visible on Home even once its snapshot has been evicted.
        ids.push(row.id);
        _metaIdxBatch[row.id] = meta; // batched — see _metaIdxBatch above

        // v9.31: snapshot-only cap. The active session and any session
        // carrying an unsynced edit are always kept regardless of budget; a
        // truncated fetch (_syncTruncated) disables eviction entirely this
        // pass. Everything else within the running budget is kept; anything
        // past it gets its existing full blob actively REMOVED, not merely
        // un-written — an already-bloated account must shrink on its next
        // login, not just stop growing further.
        var _blobJson = JSON.stringify({ meta, snapshot: remoteSnapshot });
        var _blobLen = _blobJson.length;
        var _isActiveSession = (typeof _activeSessionId !== 'undefined' && _activeSessionId === row.id);
        var _withinBudget = _syncTruncated || ((_runningBudgetBytes + _blobLen) <= _SS_SNAPSHOT_BUDGET_BYTES);
        if (_isActiveSession || _withinBudget || _localAheadOfRemote) {
          localStorage.setItem(_SS_PREFIX + row.id, _blobJson);
          _runningBudgetBytes += _blobLen;
        } else if (localRaw) {
          localStorage.removeItem(_SS_PREFIX + row.id);
        }
      } catch(e) {
        console.warn('sessionStoreSyncFromDB: localStorage write failed for', row.id, e);
      }
    });

    // v9.31 code-review fix: prune meta-index (and any surviving full blob)
    // for ids that were in the previous index but are absent from this
    // fetch — i.e. genuinely deleted elsewhere. Only when NOT truncated:
    // on a truncated fetch we can't tell "genuinely gone" from "off-page",
    // so nothing gets pruned that pass, matching the same reasoning already
    // used to gate snapshot eviction above. Without this, the meta-index
    // (and any full blob not yet evicted) would accumulate forever for any
    // session ever deleted on another device — reintroducing, for the
    // meta-index, exactly the unbounded-orphan-growth class of bug this
    // whole feature exists to close for snapshots.
    if (!_syncTruncated) {
      var _idsSet = {};
      ids.forEach(function(id){ _idsSet[id] = true; });
      _prevIndexIds.forEach(function(staleId){
        if (_idsSet[staleId]) return;
        try { localStorage.removeItem(_SS_PREFIX + staleId); } catch(e) {}
        delete _metaIdxBatch[staleId];
      });
    }

    // v9.31 code-review fix: on a truncated fetch, union with the previous
    // index instead of replacing it outright — the old unconditional
    // overwrite dropped every session outside this fetch's page from the
    // index (and therefore from Home) whenever a company's session count
    // exceeded Supabase's implicit page cap, regardless of the truncation
    // guard above (which only ever protected snapshot eviction, not this
    // rebuild). A real session must never disappear from Home just because
    // this one sync couldn't see all of it.
    var _finalIds = _syncTruncated
      ? _prevIndexIds.concat(ids.filter(function(id){ return _prevIndexIds.indexOf(id) === -1; }))
      : ids;

    // Rebuild index from DB order (saved_at desc) — always every id, per
    // the always-complete guarantee above.
    try { localStorage.setItem(_SS_INDEX, JSON.stringify(_finalIds)); } catch(e) {}
    // v9.31 code-review fix: single batched write for the whole meta-index,
    // replacing the previous per-row write inside the loop above.
    try { localStorage.setItem(_SS_META_INDEX, JSON.stringify(_metaIdxBatch)); } catch(e) {}

  } catch(e) {
    console.warn('sessionStoreSyncFromDB exception:', e);
  }
}

// Create a new session entry. Called at Launch Session.
// Returns the new sessionId.
// opts (v9.15.02, optional): {lastTab, lastStage, intakeStatus}. Guided
// Launch passes all three so its session is a real mt_sessions row from
// creation, not a second, unrelated table. Every existing call site passes
// no second argument, so defaults below reproduce exactly today's behavior.
function sessionStoreCreate(sc, opts) {
  opts = opts || {};
  const id = _ssUUID();
  const productName = (sc && sc.productProfile && sc.productProfile.productName) || 'Session';
  const now = Date.now();
  let name = _ssAutoName(productName, now);
  // Ensure name is unique across existing sessions
  // v9.31: reads the always-complete meta-index instead of iterating full
  // { meta, snapshot } blobs — stays correct even for a session whose
  // snapshot has been evicted by the size cap (see sessionStoreSyncFromDB),
  // since the meta-index entry survives eviction unconditionally.
  const _existingNames=new Set();
  var _createMetaIdx=_ssGetMetaIndex();
  Object.keys(_createMetaIdx).forEach(function(eid){
    var m=_createMetaIdx[eid];
    if(m&&m.name)_existingNames.add(m.name.trim().toLowerCase());
  });
  if(_existingNames.has(name.trim().toLowerCase())){
    var _n=2;
    while(_existingNames.has((name+' ('+_n+')').trim().toLowerCase()))_n++;
    name=name+' ('+_n+')';
  }

  const meta = {
    id,
    name,
    createdAt: now,
    savedAt: now,
    lastTab: opts.lastTab || 'mm',
    lastStage: opts.lastStage || 'Discovery Map',
    // v9.15.02: null for every session type except Guided Launch —
    // 'active' while chatting, 'completed' once Finalize & Generate has
    // run (see guided-launch.js's glFinalize() / sessionStoreSetIntakeStatus()).
    intakeStatus: opts.intakeStatus || null,
    productName,
    // v9.13.01: real product FK, captured alongside the existing denormalized
    // productName. A session is always launched against a selected product
    // profile (enforced by the launch button's own gating in home.js), so
    // this should always be present — mt_sessions.product_id is NOT NULL as
    // of this migration. Exists specifically so server-side AI usage-tracking
    // (mt_ai_usage_events) can derive product_id from session_id reliably,
    // instead of trusting the client's Home-tab-scoped activeProfileId at
    // generation time, which is not guaranteed to still be accurate deep
    // inside an already-running session.
    productId: (sc && sc.productProfile && sc.productProfile.id) || null,
    companyName: (sc && sc.companyProfile && sc.companyProfile.companyName) || '',
    productType: (sc && sc.productProfile && sc.productProfile.productType) || '',
    approach: (sc && sc.approach) || 'outcome-based',
    generationMode: (sc && sc.generationMode) || 'ai-generated',
    counts: { caps: 0, features: 0, stories: 0, sprintActive: null },
    // Phase 5: sharing fields. New sessions always start private — sharing
    // is an explicit opt-in action from the session card, never a default.
    isShared: false,
    lastEditedByName: '',
    // Phase 5 (v8.117 fix): the session's owner id — written to
    // mt_sessions.user_id on every DB save (see _ssUpsertToDB below) but,
    // confirmed as a real gap via grep, was never read back into the
    // local meta object at all until this fix. Without it, no card-render
    // function anywhere in the app had any way to know who actually owns
    // a given session, which is what let the 3-dot menu render
    // Rename/Unshare/Delete unconditionally for ANY viewer of a shared
    // session — including a non-owner, for whom those actions would
    // silently fail server-side (RLS already blocks a non-owner's
    // UPDATE/DELETE) while still optimistically mutating LOCAL state,
    // creating a "looked like it worked, then silently reverted" bug.
    userId: (typeof currentUser!=='undefined'&&currentUser)?currentUser.id:null
  };

  const snapshot = _sessionStoreBuildSnapshot();

  // Write to localStorage first — synchronous, instant
  try {
    localStorage.setItem(_SS_PREFIX + id, JSON.stringify({ meta, snapshot }));
    _ssAddToIndex(id);
    _ssSetMetaEntry(id, meta); // v9.31 — meta-index mirror, see constants block
  } catch(e) {
    console.warn('sessionStoreCreate localStorage failed:', e);
    return null;
  }

  _activeSessionId = id;
  // Phase 5: tracks whether the CURRENTLY ACTIVE session is shared, for the
  // generation-lock wrapper (withGenerationLock in api.js) to read without
  // needing a session object threaded through every call site. Captured
  // once per session load/create, cleared in homeClearSession(). Consumers
  // (withGenerationLock) re-capture this into a local at call time — this
  // global is only ever the SOURCE of that capture, never read live
  // mid-generation, per the "_activeSessionIsShared staleness" risk logged
  // during adversarial review.
  _activeSessionIsShared = false;
  // v9.08: new sessions always start private, so share mode is irrelevant
  // until first shared — set to the safe default regardless.
  _activeSessionShareMode = 'view';

  // Fix 1 (v8.40): show session name in header immediately on launch
  if(typeof hdrSetSessionName==='function') hdrSetSessionName(name);

  // Async DB write — fire and forget, does not block return
  (async function() {
    try {
      await _ssUpsertToDB(id, { meta, snapshot });
      // v8.149 fix (Issue 2): only after the session genuinely exists in
      // the DB — the RPC's own lookup would otherwise find nothing.
      _ssUpdateMyLastActiveSession(id);
    } catch(e) {
      console.warn('sessionStoreCreate DB write failed:', e);
    }
  })();

  return id;
}

// v9.15.02 — flips a session's meta.intakeStatus in the local cache only
// (synchronous, no DB call itself). sessionStoreSave()'s normal read-
// modify-write reuses the existing cached entry.meta unchanged except for
// savedAt/lastTab/lastStage/counts/snapshot — it never touches intakeStatus
// on its own, so this exists specifically for glFinalize() to call right
// before its own explicit sessionStoreSave(), which then persists both the
// flipped status and the finalized snapshot (glFinalMd etc.) together, in
// one immediate write — matching the "don't wait on a later autosave"
// guarantee every other session-creating/finalizing action in this app
// already has.
function sessionStoreSetIntakeStatus(sessionId, status){
  try{
    var raw=localStorage.getItem(_SS_PREFIX+sessionId);
    if(!raw)return;
    var entry=JSON.parse(raw);
    entry.meta=entry.meta||{};
    entry.meta.intakeStatus=status;
    localStorage.setItem(_SS_PREFIX+sessionId, JSON.stringify(entry));
    _ssSetMetaEntry(sessionId, entry.meta); // v9.31 — keep meta-index in sync
  }catch(e){ console.warn('sessionStoreSetIntakeStatus failed:', e); }
}

// Save current state to the active session.
// Called after every meaningful state mutation.
// Phase 2 (v8.123, live sync): now an async function that AWAITS its own DB
// write before returning, instead of firing it and returning early. Returns
// true/false reflecting whether the DB write actually succeeded. This is a
// deliberate, minimal change made specifically for the new content-event
// emission call sites (capability-canvas.js) — they need to know the save
// genuinely committed before emitting an event, closing a real sequencing
// gap found while building that feature (an event could otherwise become
// visible to a teammate before its own content was actually fetchable).
// Confirmed via grep, NOT a behavior change for any of the ~50 existing
// call sites app-wide: every one of them calls this as a bare, unawaited
// statement and never reads a return value, so an async function that
// still catches and logs every error internally (never throwing past this
// function) behaves identically from their point of view. Only the new
// call sites in capability-canvas.js explicitly await this.
async function sessionStoreSave(sessionId, expectedBlock) {
  if (!sessionId) return false;
  // v9.08: central defense-in-depth guard. Private (non-shared) sessions
  // are unaffected — canEditSession() returns true for those via the
  // _activeSessionIsShared===false branch. This exists to catch any
  // per-screen gate that might be missed, not to replace them.
  // v9.12.05 fix: added optional expectedBlock param, defaulting to falsy
  // for every one of this function's ~93 other call sites — those are
  // UNCHANGED, still console.error, since a blocked save from any of THOSE
  // callers genuinely means a per-screen permission gate was missed
  // somewhere (the exact class of bug this guard exists to catch, per the
  // comment above — and per real, prior fixes of exactly that kind, see
  // AI_EDITING_RULES.md's "View-only / permission-gated UI" section).
  // Only homeClearSession()'s own save-on-exit attempt passes true here —
  // that call is EXPECTED to be blocked whenever the exiting session was
  // view-only (including a session correctly demoted by the Session
  // Occupancy Lock), so logging it as a red console.error was misleading:
  // nothing was actually wrong, just a normal, correct exit. Downgrading
  // the log unconditionally for ALL callers was considered and rejected
  // via adversarial review — that would have silenced the genuine-bug
  // signal for every other caller too, not just the one benign case.
  if (!canEditSession()) {
    if (expectedBlock) {
      console.log('[sessionStoreSave blocked] view-only session, save skipped as expected on exit', sessionId);
    } else {
      console.error('[sessionStoreSave blocked] view-only session attempted save', sessionId);
    }
    return false;
  }
  let _dbWriteOk = false;
  try {
    const raw = localStorage.getItem(_SS_PREFIX + sessionId);
    // v9.31: on a full-blob cache miss, hydrate meta from the always-
    // complete meta-index instead of blank {} — defense-in-depth for the
    // active session (never itself subject to eviction, per the cap's own
    // design) in case that invariant is ever broken by a future change.
    const entry = raw ? JSON.parse(raw) : { meta: (_ssGetMetaIndex()[sessionId] || {}), snapshot: {} };

    // Build snapshot with wireframe compression
    let snapshot = _sessionStoreBuildSnapshot({ persistWireframe: true });
    const lastStage = _ssComputeLastStage();
    const counts = _ssComputeCounts();
    const now = Date.now();

    entry.meta.savedAt = now;
    // Only update lastTab on user-initiated saves — not during session restore (v8.38)
    if (!_ssRestoring) {
      entry.meta.lastTab = (typeof curTab !== 'undefined' && curTab !== 'home') ? curTab : (entry.meta.lastTab || 'mm');
    }
    entry.meta.lastStage = lastStage;
    entry.meta.counts = counts;
    entry.snapshot = snapshot;

    // ── Size guard — check BEFORE writing to localStorage ──
    // Build → stringify → check → if oversized rebuild without wireframe → write
    let json = JSON.stringify(entry);
    if (json.length > 3500000) {
      // Rebuild snapshot without wireframe compression
      snapshot = _sessionStoreBuildSnapshot({ persistWireframe: false });
      entry.snapshot = snapshot;
      json = JSON.stringify(entry);
      console.warn('[SS] Session too large to store wireframe — stripping. Size:', json.length);
      if (typeof showToast === 'function') {
        showToast('Session too large to store wireframe. Wireframe will need regeneration on next restore.', 'warn');
      }
    }

    // Write to localStorage first — synchronous, instant
    localStorage.setItem(_SS_PREFIX + sessionId, json);
    _ssSetMetaEntry(sessionId, entry.meta); // v9.31 — meta-index mirror
    _ssShowSaved();

    // DB write — now awaited inline (was fire-and-forget pre-v8.123).
    // Re-reads from localStorage to get exact entry written (including stripped version if applicable)
    try {
      const saved = localStorage.getItem(_SS_PREFIX + sessionId);
      if (saved) _dbWriteOk = await _ssUpsertToDB(sessionId, JSON.parse(saved));
    } catch(e) {
      console.warn('sessionStoreSave DB write failed:', e);
    }

  } catch(e) {
    console.warn('sessionStoreSave failed:', e);
  }
  return _dbWriteOk;
}

// Load a session by ID — returns { meta, snapshot } or null
function sessionStoreLoad(sessionId) {
  try {
    const raw = localStorage.getItem(_SS_PREFIX + sessionId);
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    console.warn('sessionStoreLoad failed:', e);
    return null;
  }
}

// ── _ssRestoring guard ──
// Prevents switchTab() from overwriting lastTab during session restore.
// Set true at start of restore, false after completion.
var _ssRestoring = false;
// v9.12.02 — tracks WHICH session is currently restoring, alongside
// _ssRestoring's boolean. Enables sessionStoreRestore()'s re-entrancy guard
// to distinguish "a duplicate call for the SAME session" (suppressed) from
// "a legitimate switch to a DIFFERENT session" (still allowed to supersede,
// unchanged from prior behavior) — see sessionStoreRestore() for the actual
// guard logic. Cleared alongside _ssRestoring, only by whichever call still
// owns the current _ssRestoreSeq.
var _ssRestoringSessionId = null;
var _ssLastTabTimer = null;
// ── _activeSessionName ──
// In-memory source of truth for current session name.
// Always maintained via hdrSetSessionName() — never set directly.
// Used by mmRenderSessionPanel() to avoid stale localStorage reads.
var _activeSessionName = '';

// ── Header session name display (v8.39) ──
// ── mmUpdateSessionName — direct DOM update for left panel session name ──
function mmUpdateSessionName(name){
  var el=document.getElementById('mm-ph-sub');
  if(el)el.textContent=(name||'').trim();
}

// ── hdrApplySessionNameVisibility ──
// Separation of concerns: this function ONLY controls show/hide of the header name.
// It reads el.textContent (never clears it) and curTab to decide visibility.
// Called from hdrSetSessionName, switchTab, and hdrRenameSession close/save.
function hdrApplySessionNameVisibility(){
  var el=document.getElementById('hdr-product-name');
  var btn=document.getElementById('hdr-session-rename-btn');
  if(!el)return;
  var hasName=!!(el.textContent||'').trim();
  var onHome=(typeof curTab!=='undefined'&&curTab==='home');
  // v8.128: a non-owner of a shared session sees no rename control at all —
  // same stated principle already used for the session-card's own 3-dot
  // menu ("non-owner sees NO trigger at all, not an empty menu"). Missing
  // owner id (legacy records) fails OPEN toward showing it, matching that
  // same existing precedent exactly, not a stricter new rule.
  var _canRename=true;
  if(typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared){
    _canRename=(_ssIsSessionOwner()!==false); // fails open on unknown ownership — see _ssIsSessionOwner()'s own comment
  }
  // A readonly-role owner sees no rename control either — this control was
  // missing the same gate the session card's 3-dot menu already has,
  // letting the header rename silently diverge from sessionStoreRename()'s
  // no-op-for-readonly behavior (UI shows a rename that never persisted).
  if(_ssIsReadOnlyRole())_canRename=false;
  el.classList.toggle('has-name',hasName);
  if(onHome||!hasName){
    el.style.display='none';
    if(btn)btn.style.display='none';
  } else {
    el.style.display='';
    if(btn)btn.style.display=_canRename?'':'none';
  }
}

// ── hdrSetSessionName ──
// Value-oriented: sets the session name text, then delegates visibility to hdrApplySessionNameVisibility.
// On Home tab: preserves the name in el.textContent (non-destructive), hides the element.
// Never clears el.textContent when on Home — that would break tab-return restore.
function hdrSetSessionName(name){
  var el=document.getElementById('hdr-product-name');
  if(!el)return;
  var cleanName=(name||'').trim();
  // Maintain in-memory source of truth (v8.45)
  if(cleanName){
    _activeSessionName=cleanName;
    el.textContent=cleanName;
  } else if(typeof curTab==='undefined'||curTab!=='home'){
    // Non-home with empty name: genuine clear (logout/session end)
    _activeSessionName='';
    el.textContent='';
  }
  // Visibility delegated entirely to hdrApplySessionNameVisibility
  hdrApplySessionNameVisibility();
  // Sync left panel — only when we have a real name
  if(typeof mmUpdateSessionName==='function'&&cleanName){
    mmUpdateSessionName(cleanName);
  }
}


function hdrRenameSession(event){
  if(event){event.preventDefault();event.stopPropagation();}
  // v8.128: defense in depth — mirrors hdrApplySessionNameVisibility()'s
  // gate, in case this is ever reachable by something other than the
  // (correctly hidden) button.
  if(typeof _activeSessionIsShared!=='undefined'&&_activeSessionIsShared){
    if(_ssIsSessionOwner()===false)return; // fails open on unknown ownership, same as hdrApplySessionNameVisibility()'s gate above
  }
  var wrap=document.getElementById('hdr-session-wrap');
  var el=document.getElementById('hdr-product-name');
  if(!wrap||!el)return;
  // Idempotency guard
  var existingInput=wrap.querySelector('input.hdr-session-name-input');
  if(existingInput){existingInput.focus();existingInput.select();return;}
  var oldValue=(el.textContent||'').trim();
  var inp=document.createElement('input');
  inp.type='text';
  inp.className='hdr-session-input hdr-session-name-input';  // hdr-session-input carries white colour from CSS
  inp.value=oldValue;
  // No text-transform:uppercase — session names display in natural case
  inp.style.cssText='height:24px;max-width:260px;min-width:120px;font-size:11px;letter-spacing:1px;font-weight:600;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;-webkit-text-fill-color:#fff;padding:2px 6px;outline:none;';
  var closed=false;
  function _restoreVisibility(){
    if(typeof hdrApplySessionNameVisibility==='function'){
      hdrApplySessionNameVisibility();
    } else {
      el.style.display=(typeof curTab!=='undefined'&&curTab==='home')?'none':((el.textContent||'').trim()?'':'none');
    }
  }
  function _closeWithoutSaving(){
    if(closed)return;
    closed=true;
    if(inp.parentNode)inp.parentNode.removeChild(inp);
    _restoreVisibility();
  }
  function _save(){
    if(closed)return;
    var trimmed=(inp.value||'').trim();
    if(!trimmed){_closeWithoutSaving();return;}
    closed=true;
    if(inp.parentNode)inp.parentNode.removeChild(inp);
    el.textContent=trimmed;
    if(typeof sessionStoreRename==='function'&&_activeSessionId)sessionStoreRename(_activeSessionId,trimmed);
    // Let hdrSetSessionName decide visibility — do not set display directly
    if(typeof hdrSetSessionName==='function')hdrSetSessionName(trimmed);
    else _restoreVisibility();
  }
  // Hide original element — preserves all classes and ID intact
  el.style.display='none';
  wrap.insertBefore(inp,el.nextSibling);
  inp.addEventListener('mousedown',function(e){e.stopPropagation();});
  inp.addEventListener('click',function(e){e.stopPropagation();});
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();e.stopPropagation();_save();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();_closeWithoutSaving();}
  });
  inp.addEventListener('blur',function(){if(!closed)_closeWithoutSaving();});
  inp.focus();
  inp.select();
}


// ── sessionStoreSyncRestoredSessionName ──
// Final authoritative UI sync after session restore.
// Must be called AFTER curTab is final and all DOM rebuilds are complete.
// Both header and left panel are updated from a single authoritative source.
function sessionStoreSyncRestoredSessionName(name){
  var cleanName=(name||'').trim();
  if(typeof hdrSetSessionName==='function'){
    hdrSetSessionName(cleanName);
  }
  if(typeof mmUpdateSessionName==='function'){
    mmUpdateSessionName(cleanName);
  }
}

// ── sessionStoreUpdateLastTab ──
// Lightweight synchronous localStorage-only lastTab write.
// Called from switchTab() via 300ms debounce — does not trigger Supabase write.
// Full sessionStoreSave() will pick up the new lastTab on next data action.
function sessionStoreUpdateLastTab(tab){
  if(!_activeSessionId||_ssRestoring)return;
  try{
    var raw=localStorage.getItem(_SS_PREFIX+_activeSessionId);
    if(!raw)return;
    var entry=JSON.parse(raw);
    if(entry&&entry.meta){
      entry.meta.lastTab=tab;
      localStorage.setItem(_SS_PREFIX+_activeSessionId,JSON.stringify(entry));
      _ssSetMetaEntry(_activeSessionId, entry.meta); // v9.31 — keep meta-index in sync
    }
  }catch(e){
    console.warn('sessionStoreUpdateLastTab failed:',e);
  }
}

// Restore a session — writes all state vars, reveals tabs, navigates to lastTab
// Phase 3b (v8.126, live sync): restore-sequence token. Bumped at the very
// start of every call — if a second resume starts before the first's async
// pre-fetch (below) resolves, the first call's continuation detects it's
// stale (seq mismatch) and abandons entirely rather than applying anything
// or racing the second call's own restore. Confirmed via grep this function
// has exactly 2 callers, both bare/unawaited — converting it to async is
// not an observable behavior change for either.
var _ssRestoreSeq = 0;

// v8.136 (item 10 redesign): the single, authoritative "apply a snapshot's
// fields to the app's globals" logic — extracted verbatim from what used
// to be inlined directly in sessionStoreRestore() below. Deliberately
// pure: takes only the snapshot object, touches only in-memory globals,
// never the DOM, never sessionStoreSave, never emits anything, never
// fetches. This is what makes it safe to call from a second place
// (live-sync.js's cross-user wholesale apply) without risking the
// save-before-clear landmine documented there — this function never
// saves anything, so calling it twice, from two different callers, has
// no side effects beyond the assignments themselves.
// v9.20: multi-release-plan migration — converts a legacy single-plan
// snapshot (s.piPlan / s.piSquads) into the new s.piPlans array plus the
// promoted, plan-agnostic s.piBacklogStoryIds. Mirrors the productLeakAnalysis
// legacy-wrap precedent above: detect the legacy non-array shape, wrap it
// with generated metadata, normalize. No-op if already migrated.
function migrateToMultiReleasePlans(snapshot){
  if (Array.isArray(snapshot.piPlans)) return; // already migrated, no-op
  if (snapshot.piPlan) {
    var legacyPlan = Object.assign({}, snapshot.piPlan, {
      id: 'rp-legacy-1',
      squads: snapshot.piSquads || [],
      createdAt: Date.now()
    });
    delete legacyPlan.backlogStoryIds; // promoted to snapshot.piBacklogStoryIds below
    snapshot.piPlans = [legacyPlan];
    snapshot.piBacklogStoryIds = snapshot.piPlan.backlogStoryIds || [];
  } else {
    snapshot.piPlans = [];
    snapshot.piBacklogStoryIds = snapshot.piBacklogStoryIds || [];
  }
  delete snapshot.piPlan;
  delete snapshot.piSquads;
}

function _ssApplySnapshotFields(s) {
  if (s.sessionContext !== undefined) sessionContext = s.sessionContext;
  if (s.gData !== undefined) gData = s.gData;
  if (s.productContext !== undefined) productContext = s.productContext;
  if (s.capStore !== undefined) capStore = s.capStore;
  // v9.05: heal/derive Discovery Map's "Custom Value Stage" from whatever
  // custom-bucket capabilities already exist in capStore — covers legacy
  // sessions (capStore['pi||'+X] entries created before this feature
  // shipped, missing bucketId) AND normal resume (in case gData.stages'
  // pi entry ever drifted out of sync with capStore, e.g. from a stale
  // save). Both gData and capStore must be set before this call.
  if (typeof gData !== 'undefined' && gData && typeof capStore !== 'undefined' && capStore && typeof syncPiStageFromCapStore === 'function') {
    syncPiStageFromCapStore(gData, capStore);
  }
  if (s.scCanvas !== undefined) scCanvas = s.scCanvas;
  // Restore story ID counter — use max(saved, highest ST-NNN found in canvas)
  // to prevent collisions on session resume regardless of how stories were created
  if(typeof scStoryIdCounter!=='undefined'){
    var _savedCtr=s.scStoryIdCounter||0;
    var _maxFromCanvas=_savedCtr;
    if(s.scCanvas){
      s.scCanvas.forEach(function(f){
        (f.stories||[]).forEach(function(st){
          if(st.id&&st.id.startsWith('ST-')){
            var _n=parseInt(st.id.replace('ST-',''),10);
            if(!isNaN(_n)&&_n>_maxFromCanvas)_maxFromCanvas=_n;
          }
        });
      });
    }
    scStoryIdCounter=_maxFromCanvas;
  }
  migrateToMultiReleasePlans(s);
  if (s.piPlans !== undefined) piPlans = s.piPlans;
  if (s.piBacklogStoryIds !== undefined) piBacklogStoryIds = s.piBacklogStoryIds;
  if (!_piActivePlanId && piPlans && piPlans.length) _piActivePlanId = piPlans[0].id;
  if (s.piInputs !== undefined) piInputs = s.piInputs;
  // FIX 2.1 (v9.03): Migrate old sessions with removed prev-pi type
  if (typeof ccMigrateLegacyPIInputs === 'function' && piInputs) {
    ccMigrateLegacyPIInputs(piInputs);
  }
  if (s.diagnosticSessions !== undefined) diagnosticSessions = s.diagnosticSessions;
  if (s.activeDiagnosticId !== undefined) activeDiagnosticId = s.activeDiagnosticId;
  // Safety net: if diagnosticSessions restored but activeDiagnosticId is null, auto-set to first session
  if (diagnosticSessions && diagnosticSessions.length > 0 && !activeDiagnosticId) {
    activeDiagnosticId = diagnosticSessions[0].id;
  }
  if (s.productLeakAnalysis !== undefined) {
    // Handle legacy format: single object → wrap in array with generated metadata
    if (s.productLeakAnalysis && !Array.isArray(s.productLeakAnalysis)) {
      var _legacyRun = s.productLeakAnalysis;
      _legacyRun.runId = _legacyRun.runId || 'run-legacy-01';
      _legacyRun.runLabel = _legacyRun.runLabel || ((_legacyRun.primaryBottleneckMetric||'Diagnostic')+' · Restored');
      _legacyRun.runTimestamp = _legacyRun.runTimestamp || Date.now();
      _legacyRun.runCustomName = false;
      productLeakAnalysis = [_legacyRun];
    } else {
      productLeakAnalysis = s.productLeakAnalysis || [];
    }
  }
  // Rebuild laSentIds cache from scCanvas (source of truth) — confirmed
  // pure, no save/DOM side effects, verified before this extraction.
  if (typeof laRebuildSentIdsFromCanvas === 'function') laRebuildSentIdsFromCanvas();
  // v9.06.01: narrowly migrate the Custom Value Stage's legacy literal
  // label ('PI Plan') to the new default ('Custom Value Stage'), and patch
  // every downstream field that would otherwise go stale — mirrors what a
  // manual rename via stageRenameDownstream() does, but automatic and
  // narrowly scoped (only fires if the label is EXACTLY the old literal;
  // never touches a label a user has already customized). Placed here,
  // after gData/capStore/scCanvas/productLeakAnalysis are all restored,
  // since migratePiStageLegacyLabel() reads all four.
  if (typeof migratePiStageLegacyLabel === 'function') {
    migratePiStageLegacyLabel(gData, capStore, scCanvas, productLeakAnalysis);
  }
  if (s.miData !== undefined) miData = s.miData;
  if (s.miGenerated !== undefined) miGenerated = s.miGenerated;
  if (s.miProductMode !== undefined) miProductMode = s.miProductMode;
  if (s.miCapabilities !== undefined) miCapabilities = s.miCapabilities;
  if (s.ddGenerated !== undefined) ddGenerated = s.ddGenerated;
  // v9.08.04 fix: restore the actual dictionary content alongside the flag
  // that claims it exists — window._ddRows is read directly by
  // ccRenderDDPanel()'s per-metric lookup (capability-canvas.js), which
  // expects this exact flat-array shape ({name, sl, lvl, def, bm, rf}) with
  // no transformation, confirmed against both places that populate it.
  if (s.ddRows !== undefined && typeof window !== 'undefined') window._ddRows = s.ddRows;
  if (s.mmBannerCollapsed !== undefined) mmBannerCollapsed = s.mmBannerCollapsed;
  // v9.16 — Requirement Agent. Confirmed bug (surfaced by the Discovery-
  // First redesign, where DM is now RA's primary trigger point): raEnabled
  // reflects the GLOBAL, company-wide Settings > Feature Modules toggle
  // (appSettings.featRA), not genuine per-session state — but this restore
  // used to trust the session's own PERSISTED snapshot value unconditionally,
  // which could be stale (e.g. saved back when the company had RA off,
  // then the toggle was switched on — resuming that old session would
  // still show RA off, contradicting the current, authoritative setting).
  // The live appSettings.featRA value now always wins when available;
  // the persisted snapshot value is only a fallback for the (rare) case
  // appSettings hasn't loaded yet at restore time.
  if (typeof appSettings !== 'undefined' && appSettings && typeof appSettings.featRA !== 'undefined') {
    raEnabled = !!appSettings.featRA;
  } else if (s.raEnabled !== undefined) {
    raEnabled = s.raEnabled;
  }
  if (s.raConversations !== undefined) raConversations = s.raConversations;
  // Adoption Readiness (v9.21) — flat globals restore, same pattern as raEnabled above.
  if (s.piReadinessPlans !== undefined) piReadinessPlans = s.piReadinessPlans;
  if (s.opUnlocked !== undefined) opUnlocked = s.opUnlocked;
  if (s.raLastOpenConversationId !== undefined) raLastOpenConversationId = s.raLastOpenConversationId;
  // Restore protoStore — unconditional, old sessions without it get empty {}
  protoStore = s.protoStore || {};
  // v8.147: decompression extracted to a shared, pure function — used here
  // AND by live-sync's Prototype Canvas apply (which mutates protoStore
  // via a completely separate code path and would otherwise silently skip
  // this step, exactly the "two copies of the same logic drift apart"
  // class of bug the tab-visibility fix (v8.136) was built to prevent).
  _ssDecompressProtoStoreWireframes(protoStore);
}

// Pure: decompresses every variant's wireframeHTMLCompressed field into a
// live wireframeHTML string, in place, on the given protoStore object.
// Always resets transient fields (generating/generatingPhase/wireframeBlobUrl)
// — never restores in-flight generation state, regardless of caller.
function _ssDecompressProtoStoreWireframes(protoStoreObj) {
  var lzAvail = typeof LZString !== 'undefined' && typeof LZString.decompressFromUTF16 === 'function';
  Object.keys(protoStoreObj).forEach(function(featId) {
    var entry = protoStoreObj[featId];
    if (!entry || !entry.variants) return;
    Object.keys(entry.variants).forEach(function(vid) {
      var v = entry.variants[vid];
      if (!v) return;
      v.generating = false;
      v.generatingPhase = null;
      v.wireframeBlobUrl = null;
      if (lzAvail && v.wireframeHTMLCompressed) {
        try {
          var html = LZString.decompressFromUTF16(v.wireframeHTMLCompressed);
          v.wireframeHTML = html || null;
        } catch(_) {
          v.wireframeHTML = null;
        }
      } else {
        v.wireframeHTML = null;
      }
    });
  });
}

// ── Single-session resync (v9.31) ──
// Fetches one session row fresh from Supabase, mapped into { meta, snapshot }
// via the shared _ssRowToMeta() helper (see its own comment — this used to
// be a fourth independent copy of that mapping; code-review fixed). Used by
// sessionStoreRestore() to recover a session whose full blob was evicted
// by the snapshot-size cap but is still present in the meta-index (i.e.
// still a real, current session for this company). Deliberately does NOT
// fetch mt_session_content_events' cursor the way live-sync.js's sibling
// _lsResumePreFetch does — that's specific to live-sync's "new content"
// banner, not needed for a plain cache-miss resync; the strict is_shared/
// user_id allowlist below IS shared with that sibling, though, since both
// are single-row live fetches of the same table and deserve the same
// hard-fail discipline.
async function _ssFetchSessionRow(sessionId) {
  try {
    const client = _ssGetClient();
    if (!client) return { ok: false, reason: 'error' };
    const activeCompanyId = (function(){
      try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
    })();
    if (!activeCompanyId) return { ok: false, reason: 'error' };

    const { data, error } = await client
      .from(_SS_TABLE)
      .select('*')
      .eq('id', sessionId)
      .eq('company_id', activeCompanyId)
      .limit(1);
    if (error) return { ok: false, reason: 'error' };
    if (!data || data.length === 0) return { ok: false, reason: 'no-access' };
    const row = data[0];

    // v9.31 code-review fix: strict allowlist, matching _lsResumePreFetch's
    // identical checks on the identical table — hard-fail rather than
    // default a legacy/malformed row's ownership fields to blank, which
    // could otherwise expose the owner-only 3-dot menu (home.js's owner
    // check treats userId:null as "no owner recorded") to any viewer.
    if (row.is_shared === undefined || row.is_shared === null) return { ok: false, reason: 'error' };
    if (!row.user_id) return { ok: false, reason: 'error' };

    return { ok: true, meta: _ssRowToMeta(row), snapshot: row.snapshot || {} };
  } catch(e) {
    return { ok: false, reason: 'error' };
  }
}

async function sessionStoreRestore(sessionId) {
  // v9.12.02 fix: re-entrancy guard for the SAME session only. Root cause
  // of the "occupancy toast never shown" bug — a duplicate invocation for
  // the same sessionId (confirmed via diagnostic logging to originate from
  // a rapid double-trigger on the session card) started a second restore
  // while the first was still awaiting its occupancy claim; the second
  // call's ++_ssRestoreSeq silently invalidated the first's in-flight
  // continuation before its toast/demotion logic ever ran. Deliberately
  // scoped to the SAME session only — a different session must still be
  // allowed to supersede an in-flight restore, matching the existing
  // seq-token design's explicit intent (see the _restoreSeq checks below,
  // unchanged). A blanket "any restore in progress, bail" guard was
  // considered and rejected via adversarial review: it would silently
  // break a legitimate rapid X→Y session switch, which today correctly
  // lets Y win.
  if (_ssRestoring && _ssRestoringSessionId === sessionId) {
    console.warn('[sessionStoreRestore] duplicate call ignored for session already restoring:', sessionId);
    return;
  }
  const _restoreSeq = ++_ssRestoreSeq;
  let localEntry = sessionStoreLoad(sessionId);

  // v9.31: two-way cache-miss branch. A missing local entry no longer
  // automatically means "corrupted" — it's the expected, recoverable state
  // for a session whose snapshot was evicted by the size cap (see
  // sessionStoreSyncFromDB), and the always-complete meta-index is what
  // distinguishes that from a session genuinely unknown to this company.
  if (!localEntry || !localEntry.snapshot) {
    const _knownMeta = _ssGetMetaIndex()[sessionId];
    if (!_knownMeta) {
      // Absent from the meta-index too — never synced, or genuinely gone.
      // No live fetch attempted; nothing locally suggests this id is real.
      showToast('Could not load session. Data may be corrupted.', 'warn');
      return;
    }
    const _resynced = await _ssFetchSessionRow(sessionId);
    // Re-check after this await — a second restore started while this one
    // was in flight wins; this one must not clobber it, same reasoning as
    // every other await point in this function.
    if (_restoreSeq !== _ssRestoreSeq) { return; }
    if (_resynced && _resynced.ok) {
      localEntry = { meta: _resynced.meta, snapshot: _resynced.snapshot };
      try { localStorage.setItem(_SS_PREFIX + sessionId, JSON.stringify(localEntry)); } catch(e) {}
      _ssSetMetaEntry(sessionId, _resynced.meta);
    } else if (_resynced && _resynced.reason === 'no-access') {
      // Clean, error-free empty result — genuinely gone (deleted/RLS-
      // excluded) despite the meta-index still holding a stale copy from
      // before. Distinct message from a network failure, per the review.
      showToast('This session no longer exists.', 'warn');
      return;
    } else {
      // Network/thrown failure — distinct from genuinely-gone, since the
      // right user action differs (retry vs. give up).
      showToast('Could not reach the server to load this session. Check your connection and try again.', 'warn');
      return;
    }
  }

  _ssRestoring = true;  // prevent switchTab from overwriting lastTab during restore
  _ssRestoringSessionId = sessionId;

  // v9.12.02 fix: wrapping the whole body in try/finally so _ssRestoring/
  // _ssRestoringSessionId are ALWAYS cleared on exit — but only by whichever
  // call actually still owns the current seq (checked in the finally block
  // below), never unconditionally. Found via adversarial review: the
  // previous code cleared _ssRestoring=false in every individual early-
  // return branch unconditionally, which is wrong the moment a stale call
  // wakes up AFTER a newer call has already taken over — the stale call's
  // cleanup would incorrectly clear the flag out from under the newer,
  // still-active restore. A single ownership-checked cleanup point closes
  // this for every exit path (early return, exception, or normal
  // completion) at once, rather than requiring every branch to get it
  // right individually.
  try {
    // v8.150 fix (Issue 2, corrected): the v8.149 attempt computed this
    // condition here and passed it as an explicit skipSave flag — confirmed
    // via live testing that this missed the actual failure mode (navigating
    // to Home first, a different call site, already did the damage before
    // this ever ran). The detection now lives inside homeClearSession()
    // itself, automatically, so this call site is back to a plain call.
    if (typeof homeClearSession === 'function') homeClearSession();

    // Phase 3b (v8.126): for a cached-shared session, fetch that row fresh
    // from the DB before applying anything — today's local-cache-only resume
    // (the code below this point, unchanged) doesn't reflect a teammate's
    // content generated while this browser wasn't watching. Private sessions
    // take the exact pre-v8.126 path unchanged (no await ever happens, zero
    // added latency or risk).
    let entry = localEntry;
    let _lsCursorSeed = null;
    let _lsPreFetchFailed = false;
    // v9.12.04 fix: showToast() has a single shared DOM slot with no queue
    // (confirmed by reading utils.js's implementation) — a later call
    // unconditionally overwrites an earlier one's content, even within the
    // same synchronous tick. The unconditional 'Session restored.' toast
    // near the end of this function was silently overwriting the occupancy
    // lock's own toast (read-only demotion notice), which fires earlier in
    // this same function and never gets a chance to actually be seen —
    // root-caused via live testing: the occupancy gate's own logging
    // proved the demotion toast call WAS being reached, but the user never
    // saw it. This flag lets the occupancy toast claim the single slot as
    // the more specific, more important message for THIS restore, and
    // suppresses the generic one that would otherwise clobber it.
    let _occupancyToastShown = false;
    if (localEntry.meta && localEntry.meta.isShared && typeof _lsResumePreFetch === 'function') {
      try {
        const _fresh = await _lsResumePreFetch(sessionId);
        // Re-check after this await — a second resume started while this
        // one was in flight wins; this one bows out. Cleanup of
        // _ssRestoring now happens once, in the finally block, not here.
        if (_restoreSeq !== _ssRestoreSeq) { return; }
        if (_fresh && _fresh.ok) {
          entry = { meta: _fresh.meta, snapshot: _fresh.snapshot };
          _lsCursorSeed = _fresh.cursorEventId;
          // Write the fresh entry into localStorage immediately — this
          // function's own tail logic (savedAt/lastTab stamping) re-reads
          // localStorage directly rather than reusing this local variable;
          // without this write, that later re-read would silently see stale
          // cached data instead of what was just fetched.
          try { localStorage.setItem(_SS_PREFIX + sessionId, JSON.stringify(entry)); } catch(e) {}
          // v9.31 code-review fix: mirror the freshly-fetched meta into the
          // meta-index too — without this, Home's list (which now reads
          // only the meta-index) would keep showing the pre-resume stale
          // name/shareMode even immediately after a successful refresh.
          _ssSetMetaEntry(sessionId, _fresh.meta);
        } else if (_fresh && _fresh.reason === 'no-access') {
          // Fix (v8.127): confirmed no access (a clean, error-free query that
          // simply returned nothing — RLS has excluded this row) must NOT
          // fall back to serving stale local content, unlike a genuine
          // network failure. Found in testing: a session card could still be
          // "resumed" into a stale cached copy after being unshared, in the
          // window before the next Home poll cycle noticed it was gone.
          if (typeof _lsRemoveLocalSessionEntry === 'function') _lsRemoveLocalSessionEntry(sessionId);
          if (typeof showToast === 'function') showToast('This session is no longer shared with you.', 'warn');
          if (typeof homeRenderSessionLibrary === 'function') homeRenderSessionLibrary();
          return;
        } else {
          // Genuine error (network, malformed response) — fall back to
          // cached content, but say so explicitly rather than failing silent.
          _lsPreFetchFailed = true;
        }
      } catch(e) {
        _lsPreFetchFailed = true;
      }
    }
    if (_restoreSeq !== _ssRestoreSeq) { return; }

    const s = entry.snapshot;
    const meta = entry.meta;

    _ssApplySnapshotFields(s);

    _activeSessionId = sessionId;
    // Phase 5: capture the restored session's sharing state once, here — the
    // single point where "which session is active" changes. Never re-derived
    // mid-generation; withGenerationLock() (api.js) captures ITS OWN local
    // copy from this global at call time, so a later stale read of this
    // global can't retroactively affect an already-running generation.
    _activeSessionIsShared = !!meta.isShared;
    _activeSessionOwnerId = meta.userId || null;
    // v9.08: read the restored session's share mode. Falls back to 'view'
    // (fail-closed) if the field is missing on an old cached entry rather
    // than defaulting to 'edit'.
    _activeSessionShareMode = meta.shareMode === 'edit' ? 'edit' : 'view';
    sessionActive = true;

    // v9.12 — Session Occupancy Lock ("Single User Editing"). Only
    // relevant for a shared session whose persisted share_mode is 'edit' AND
    // the company-wide setting is 'single' (Multi mode is completely
    // untouched by this block — no occupancy check, no claim, no heartbeat,
    // identical to pre-v9.12 behavior). Placed here — after share_mode is
    // captured, before the watch starts and before any rendering — so a
    // failed claim can demote _activeSessionShareMode to 'view' in-memory
    // BEFORE canEditSession() is consulted by anything below this point.
    // This override is never written back to meta.shareMode or the session's
    // DB row — it's a per-restore-instance in-memory fact only, exactly like
    // the existing shareMode fallback-to-'view' pattern above it.
    if (_activeSessionIsShared && _activeSessionShareMode === 'edit'
        && (typeof appSettings !== 'undefined' && (appSettings.collabEditMode||'single') === 'single')
        && typeof _lsClaimSessionOccupancy === 'function') {
      // v9.12.02 fix: fail closed on a thrown/rejected claim call, not just
      // a clean {claimed:false} response. Found via adversarial review — the
      // original code had no try/catch here; a genuine RPC failure (network,
      // auth) would throw past this point with _activeSessionShareMode
      // already 'edit' and never demoted, silently leaving the session
      // editable with no occupancy actually held, since callers never
      // await/catch this function.
      let _occRes = null;
      try {
        _occRes = await _lsClaimSessionOccupancy(sessionId);
      } catch(e) {
        console.warn('[live-sync] occupancy claim threw, failing closed:', e);
        if (_restoreSeq === _ssRestoreSeq) {
          _activeSessionShareMode = 'view';
          if (typeof showToast === 'function') {
            showToast('Could not verify edit access. The session was opened read-only.', 'warn');
            _occupancyToastShown = true;
          }
        }
        _occRes = null;
      }
      // Re-check after this await — same reasoning as the pre-fetch's own
      // check above: a second restore started while this claim was in
      // flight wins, this one must not clobber it. Per adversarial review:
      // if THIS continuation's claim actually succeeded before losing the
      // race, it must release what it just claimed, not merely abandon it —
      // an abandoned successful claim would leave the session occupied by a
      // tab that's no longer even looking at it.
      if (_restoreSeq !== _ssRestoreSeq) {
        if (_occRes && _occRes.claimed && typeof _lsReleaseSessionOccupancy === 'function') {
          _lsReleaseSessionOccupancy(sessionId); // fire-and-forget, best-effort cleanup of the orphaned claim
        }
        return;
      }
      if (_occRes && !_occRes.claimed) {
        _activeSessionShareMode = 'view';
        if (typeof showToast === 'function') {
          showToast("This session is currently being edited by " + (_occRes.occupantUserName || 'someone on your team') + ". You're viewing it in read-only mode for now.", 'warn');
          _occupancyToastShown = true;
        }
      } else if (_occRes && _occRes.claimed && typeof _lsOccupancyHeartbeatStartTracked === 'function') {
        _lsOccupancyHeartbeatStartTracked(sessionId, function(){
          // Heartbeat reports the lease genuinely expired/lost server-side —
          // demote in-memory and inform the user. Does not attempt to
          // re-claim automatically; per product decision, a demoted viewer
          // retries by leaving and reopening the session (same as any other
          // "session became available" case), not via a live promotion path.
          _activeSessionShareMode = 'view';
          if (typeof showToast === 'function') {
            showToast("You've lost edit access to this session. You're now viewing it in read-only mode.", 'warn');
          }
        });
      }
    }

    // Phase 3b/3c (v8.126): watch starts here, not earlier — this is the
    // single point where the active session's identity and sharing state are
    // both already final for this restore. Seeded with the cursor captured
    // BEFORE the snapshot fetch above (deliberate ordering — see
    // _lsResumePreFetch), so anything generated in the gap between those two
    // fetches surfaces as a redundant-but-safe banner rather than being
    // silently acknowledged as already-seen.
    if (_activeSessionIsShared && typeof _lsSessionWatchStart === 'function' && canEditSession()) {
      _lsSessionWatchStart(sessionId, _lsCursorSeed);
    }
    if (_lsPreFetchFailed && typeof showToast === 'function') {
      showToast('Could not confirm the latest version of this session. Showing the last saved copy.', 'warn');
    }

    // v8.45: seed el.textContent early so it's available if switchTab reads it
    // Do NOT call hdrSetSessionName here — curTab is still 'home', visibility would hide it
    var _hdrEl=document.getElementById('hdr-product-name');
    if(_hdrEl&&meta.name){_hdrEl.textContent=meta.name.trim();}

    // Fix #7c — hide tab lock message
    const lockMsg = document.getElementById('home-tab-lock');
    if (lockMsg) lockMsg.style.display = 'none';
    const tabHint = document.querySelector('.tab-hint');
    if (tabHint) tabHint.style.display = 'none';

    // Hide-then-reveal tab visibility, matching this session's actual data —
    // now a single shared function (see _ssSyncTabVisibility below), also
    // used by the cross-user wholesale apply path.
    _ssSyncTabVisibility(s, meta);

    // Navigate to last active tab — switchTab handles all left panel / content visibility
    const targetTab = meta.lastTab || 'mm';
    if (typeof switchTab === 'function') switchTab(targetTab);

    // Fix #2 — re-render DM only if navigating to mm tab
    if (targetTab === 'mm' && s.gData) {
      if (typeof renderMM === 'function') renderMM(s.gData);
      // Restore evidence dots and values on DM after session reload (v8.37)
      if (typeof kpiRenderEvidenceStates === 'function') kpiRenderEvidenceStates();
      const mmOut = document.getElementById('mm-out');
      if (mmOut) mmOut.classList.add('on');
      if (typeof mmRenderSessionPanel === 'function'){
        mmRenderSessionPanel();
        // v8.45: sync left panel immediately after rebuild — mmRenderSessionPanel uses productName fallback
        if(typeof mmUpdateSessionName==='function')mmUpdateSessionName(meta.name||'');
      }
    }

    // If session was interrupted before gData was set, show a clear interrupted state
    if (targetTab === 'mm' && !s.gData && sessionActive) {
      _ssShowInterruptedGenerationState(s);
    }

    // Fix #3 — for non-mm targets, ensure DM left panel is hidden
    if (targetTab !== 'mm') {
      const lp = document.getElementById('left-panel');
      if (lp) lp.classList.add('sc-hidden');
    }

    // v9.15.02 — Guided Launch content restore. Independent of targetTab:
    // a COMPLETED Guided Launch session's meta.lastTab is 'mm' (set at
    // finalize, see guided-launch.js's glFinalize()), so the user lands on
    // Discovery Map as expected, but #gl-tab must still be populated so
    // manually clicking the (now-visible, per _ssRevealTabs above) Guided
    // Launch tab shows the real chat/brief rather than empty or stale DOM.
    // Only an ACTIVE (unfinalized) session has meta.lastTab==='gl' and so
    // actually lands here via the switchTab(targetTab) call above.
    if (meta.intakeStatus && typeof glApplyRestoredSnapshot === 'function') {
      glApplyRestoredSnapshot(meta, s);
    }

    // v9.16 — Requirement Agent content restore. Same independent-of-
    // targetTab reasoning as Guided Launch above: #ra-tab must be populated
    // whenever raConversations exist, regardless of which tab the session
    // actually lands on, so manually clicking the (now-revealed, per
    // _ssRevealTabs above) Requirement Agent tab shows real content.
    // raLastOpenConversationId is this feature's equivalent of a
    // "glLastOpenConversationId" resume pointer — mirrors the one concrete
    // precedent in this codebase for "which specific item was open last"
    // (piDdPanelMetricKey, restored the same unconditional way in this same
    // function) rather than always defaulting to the most-recent card.
    if (s.raConversations && s.raConversations.length > 0 && typeof raApplyRestoredSnapshot === 'function') {
      raApplyRestoredSnapshot(s);
    }

    // MI: re-render only if navigating to mi tab
    if (targetTab === 'mi' && s.miGenerated) {
      if (typeof miRenderScreen === 'function') miRenderScreen();
    }

    // Update home left panel to show active session
    if (typeof homeRenderSessionPanel === 'function') homeRenderSessionPanel();

    // v8.45: final authoritative UI sync — runs AFTER curTab is final and all DOM rebuilt
    // This is the definitive fix for session name not showing after restore
    sessionStoreSyncRestoredSessionName(meta.name||'');

    // Save session immediately after restore — updates savedAt and forces lastTab to targetTab.
    try {
      const _raw = localStorage.getItem(_SS_PREFIX + sessionId);
      if (_raw) {
        const _entry = JSON.parse(_raw);
        _entry.meta.savedAt = Date.now();
        _entry.meta.lastTab = targetTab;
        localStorage.setItem(_SS_PREFIX + sessionId, JSON.stringify(_entry));
      }
    } catch(e) {
      console.warn('sessionStoreRestore save failed:', e);
    }

    // v9.12.04 fix: only show the generic "Session restored." toast if the
    // occupancy lock didn't already claim the single toast slot with a more
    // specific, more important message — showToast() has no queue, so an
    // unconditional call here would always overwrite (and hide) the
    // occupancy warning, exactly the bug that motivated this flag.
    if (!_occupancyToastShown) {
      showToast('Session restored.', 'info');
    }
    // v8.149 fix (Issue 2): mark this as this person's own last active
    // session, once the resume has genuinely completed — not earlier, and
    // not on a failed/aborted resume path above.
    if (typeof _ssUpdateMyLastActiveSession === 'function') _ssUpdateMyLastActiveSession(sessionId);
  } finally {
    // v9.12.02 fix: single, ownership-checked cleanup point — only the
    // call that still owns the current seq clears the flags. A stale call
    // waking up after being superseded must NOT clear state that now
    // belongs to whichever newer restore took over.
    if (_restoreSeq === _ssRestoreSeq) {
      _ssRestoring = false;
      _ssRestoringSessionId = null;
    }
  }
}

// Delete a session by ID
function sessionStoreDelete(sessionId) {
  // Fail fast for a readonly-role caller — before touching localStorage at
  // all, so there is no optimistic "card vanishes, then reappears a few
  // seconds later" flicker. This is a UX improvement on top of the real
  // fix: mt_session_delete (see below) re-checks role+ownership server-side
  // via SECURITY DEFINER, so a devtools call bypassing this early return
  // would still be rejected at the DB layer, not just here.
  if (_ssIsReadOnlyRole()) {
    console.warn('sessionStoreDelete blocked: readonly role');
    return;
  }

  // Remove from localStorage first
  try {
    localStorage.removeItem(_SS_PREFIX + sessionId);
    _ssRemoveFromIndex(sessionId);
    _ssRemoveMetaEntry(sessionId); // v9.31
    if (_activeSessionId === sessionId) _activeSessionId = null;
  } catch(e) {
    console.warn('sessionStoreDelete localStorage failed:', e);
  }

  // Async DB delete via mt_session_delete — a SECURITY DEFINER RPC that
  // re-derives the caller server-side and re-checks ownership + active,
  // non-readonly company membership inline (see
  // sql/mt-sessions-readonly-mutation-guard.sql) — mt_sessions' own RLS is
  // ownership-only, with no role condition, so a raw .delete() here would
  // let a demoted-to-readonly owner still delete their own session via a
  // direct API call, bypassing every client-side check above. p_company_id
  // is re-derived from the active company (same as the pre-RPC .eq() guard
  // this replaced) so a stale cross-company session id can't succeed
  // purely on ownership+role in a DIFFERENT company than the one active
  // right now. Fire and forget, matching this function's existing pattern.
  (async function() {
    try {
      const client = _ssGetClient();
      if (client) {
        const activeCompanyId = (function(){
          try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
        })();
        const { error } = await client.rpc('mt_session_delete', { p_session_id: sessionId, p_company_id: activeCompanyId });
        if (error) console.warn('sessionStoreDelete DB delete failed:', error.message);
      }
    } catch(e) {
      console.warn('sessionStoreDelete DB delete exception:', e);
    }
  })();
}

// Rename a session
function sessionStoreRename(sessionId, newName) {
  // Fail fast for a readonly-role caller — see sessionStoreDelete's matching
  // comment. The real enforcement is mt_session_rename's server-side
  // re-check; this just avoids a pointless localStorage write + round trip.
  if (_ssIsReadOnlyRole()) {
    console.warn('sessionStoreRename blocked: readonly role');
    return;
  }

  const trimmed = (newName || '').trim();

  // Update local caches first. v9.31 fix: the full { meta, snapshot } blob
  // may have been evicted by the size cap (sessionStoreSyncFromDB) even
  // though the session is still real and listed on Home — this block used
  // to be `if (!raw) return`, which exited the WHOLE function in that case
  // and silently skipped the mt_session_rename RPC below too, not just the
  // local cache write. The meta-index (always complete, never evicted) is
  // now the write target guaranteed to exist; the full blob is mirrored
  // only when it happens to still be present.
  try {
    var _metaIdx = _ssGetMetaIndex();
    var _existingMeta = _metaIdx[sessionId];
    // v9.31 code-review fix: matches homeSessionToggleShare's identical
    // guard — without this, a sessionId absent from the meta-index (a
    // stale Home card, or a race with a concurrent delete) fell back to a
    // bare {}, writing a phantom, malformed meta-index entry and still
    // firing mt_session_rename against a possibly nonexistent session.
    if (!_existingMeta) return;
    var _resolvedName = trimmed || _existingMeta.name;
    _ssSetMetaEntry(sessionId, Object.assign({}, _existingMeta, { name: _resolvedName }));

    const raw = localStorage.getItem(_SS_PREFIX + sessionId);
    if (raw) {
      const entry = JSON.parse(raw);
      entry.meta.name = trimmed || entry.meta.name;
      localStorage.setItem(_SS_PREFIX + sessionId, JSON.stringify(entry));
    }
  } catch(e) {
    console.warn('sessionStoreRename localStorage failed:', e);
  }

  // Async DB update via mt_session_rename — a SECURITY DEFINER RPC that
  // re-derives the caller server-side and re-checks ownership + active,
  // non-readonly company membership inline (see
  // sql/mt-sessions-readonly-mutation-guard.sql) — mt_sessions' own RLS is
  // ownership-only, with no role condition, so a raw .update() here would
  // let a demoted-to-readonly owner still rename their own session via a
  // direct API call, bypassing every client-side check above. p_company_id
  // restores the same cross-company guard sessionStoreDelete's matching
  // comment describes. Fire and forget, matching this function's existing
  // pattern.
  (async function() {
    try {
      const client = _ssGetClient();
      if (client) {
        const activeCompanyId = (function(){
          try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
        })();
        const { error } = await client.rpc('mt_session_rename', { p_session_id: sessionId, p_new_name: trimmed, p_company_id: activeCompanyId });
        if (error) console.warn('sessionStoreRename DB update failed:', error.message);
      }
    } catch(e) {
      console.warn('sessionStoreRename DB update exception:', e);
    }
  })();
}

// Phase 5: toggle a session's is_shared flag. Mirrors sessionStoreRename's
// pattern exactly — local write first (instant), async DB update (fire and
// forget, company_id-guarded). Deliberately does NOT call sessionStoreSave()
// or rebuild the full snapshot — this is a single boolean flip, not a
// content change, and the existing size-guard/wireframe-compression logic
// in sessionStoreSave() would be wasted work for what's happening here.
function homeSessionToggleShare(sessionId){
  // Fail fast for a readonly-role caller — see sessionStoreDelete's matching
  // comment. The real enforcement is mt_session_set_shared's server-side
  // re-check; this just avoids a pointless localStorage write + round trip.
  if (_ssIsReadOnlyRole()) {
    console.warn('homeSessionToggleShare blocked: readonly role');
    return;
  }

  let _nextShared = null;
  // v9.08.01 fix: hoisted alongside _nextShared. The DB-write block below
  // is a separate async IIFE, outside this function's try block — `entry`
  // is const-declared INSIDE the try block and goes out of scope before
  // that IIFE runs. Referencing entry.meta.shareMode there threw
  // "ReferenceError: entry is not defined" on every single toggle, share
  // AND unshare alike (confirmed: the reference isn't behind an
  // if(_nextShared) check), meaning the async DB write crashed before ever
  // reaching client.from(...).update() — is_shared and share_mode were
  // never actually persisted to Supabase in either direction, even though
  // localStorage updated correctly and the toast fired.
  let _nextShareMode = null;
  try {
    // v9.31 fix: source of truth is now the always-complete meta-index, not
    // the full { meta, snapshot } blob — that blob may have been evicted by
    // the size cap even though the session is still real and listed. This
    // used to be `if (!raw) return`, which exited the WHOLE function on a
    // missing blob and silently skipped the mt_session_set_shared RPC below
    // too, not just the local write — identical bug shape to
    // sessionStoreRename, fixed the same way.
    var _metaIdx = _ssGetMetaIndex();
    var _existingMeta = _metaIdx[sessionId];
    if (!_existingMeta) return; // genuinely unknown to this company's cache — nothing to toggle

    _nextShared = !_existingMeta.isShared;
    var _newMeta = Object.assign({}, _existingMeta, { isShared: _nextShared });
    // v9.08: re-derive share_mode from the company default every time a
    // session transitions private→shared — not just the first time it's
    // ever shared. Without this, unsharing then re-sharing a session
    // would silently keep whatever share_mode it had from a previous
    // share cycle instead of reflecting the current company policy.
    if (_nextShared) {
      _newMeta.shareMode = (typeof appSettings !== 'undefined' && appSettings.defaultShareMode === 'edit') ? 'edit' : 'view';
    }
    _nextShareMode = _newMeta.shareMode || 'view';
    _ssSetMetaEntry(sessionId, _newMeta);

    // Mirror into the full blob too, if it happens to still exist locally.
    const raw = localStorage.getItem(_SS_PREFIX + sessionId);
    if (raw) {
      const entry = JSON.parse(raw);
      entry.meta.isShared = _nextShared;
      if (_nextShared) entry.meta.shareMode = _newMeta.shareMode;
      localStorage.setItem(_SS_PREFIX + sessionId, JSON.stringify(entry));
    }

    // Keep the live "is the ACTIVE session shared" flag in sync if this
    // toggle is happening on the session currently open — otherwise
    // withGenerationLock() would read a stale value until next restore.
    if (typeof _activeSessionId !== 'undefined' && _activeSessionId === sessionId) {
      _activeSessionIsShared = _nextShared;
      if (_nextShared) _activeSessionShareMode = _newMeta.shareMode;
    }
  } catch(e) {
    // v9.31 code-review fix: no `return` here anymore — matches
    // sessionStoreRename's equivalent catch. A corrupted-but-present full
    // blob throwing during the "mirror into full blob" step used to skip
    // the mt_session_set_shared RPC below entirely, even though the
    // meta-index write above it had already succeeded — the same class of
    // "silently does nothing server-side" bug this release fixes for the
    // missing-blob case, just triggered by corruption instead.
    console.warn('homeSessionToggleShare localStorage failed:', e);
  }

  if (typeof showToast === 'function') {
    if (_nextShared) {
      const _companyName = (function(){
        try { return (typeof companyProfile !== 'undefined' && companyProfile && companyProfile.companyName) || 'your company'; } catch(e) { return 'your company'; }
      })();
      showToast('Shared with your team. Anyone at '+e(_companyName)+' can now open this session.', 'success');
    } else {
      showToast('Made private. Only you can see this session now.', 'info');
    }
  }

  // Async DB update via mt_session_set_shared — a SECURITY DEFINER RPC that
  // re-derives the caller server-side and re-checks ownership + active,
  // non-readonly company membership inline (see
  // sql/mt-sessions-readonly-mutation-guard.sql) — mt_sessions' own RLS is
  // ownership-only, with no role condition, so a raw .update() here would
  // let a demoted-to-readonly owner still toggle sharing on their own
  // session via a direct API call, bypassing every client-side check
  // above. p_company_id restores the same cross-company guard
  // sessionStoreDelete's matching comment describes. Fire and forget,
  // matching this function's existing pattern.
  (async function() {
    try {
      const client = _ssGetClient();
      if (client) {
        const activeCompanyId = (function(){
          try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
        })();
        const { error } = await client.rpc('mt_session_set_shared', {
          p_session_id: sessionId,
          p_is_shared: _nextShared,
          p_share_mode: _nextShareMode || 'view',
          p_company_id: activeCompanyId
        });
        if (error) console.warn('homeSessionToggleShare DB update failed:', error.message);
      }
    } catch(e) {
      console.warn('homeSessionToggleShare DB update exception:', e);
    }
  })();

  // Re-render the card so the shared icon / menu label / meta line update
  if (typeof homeRenderSessionLibrary === 'function') homeRenderSessionLibrary();
}

// Return array of session metadata sorted by savedAt desc (default)
function sessionStoreList() {
  // v9.31: reads the always-complete meta-index instead of N full
  // { meta, snapshot } blobs — one localStorage read instead of up to N.
  // Home's session library must show every session the last sync knew
  // about, regardless of whether that session's snapshot survived the
  // size cap (see sessionStoreSyncFromDB) — the meta-index is never
  // subject to that cap, so this list is unaffected by it.
  const index = _ssGetIndex();
  const metaIdx = _ssGetMetaIndex();
  const list = [];
  index.forEach(function(id) {
    var m = metaIdx[id];
    if (m) list.push(m);
  });
  // Sort by savedAt descending
  list.sort(function(a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
  return list;
}

// ── Private helpers ──

// ── JSON-safe deep clone helper ──
// Used for coverageData (JSON-safe primitives only — do not use for File/Blob/Date).
function _ssCloneJsonSafe(value, fallback) {
  try {
    if (value == null) return fallback;
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return fallback;
  }
}

// ── Strip/compress transient proto fields before snapshot ──
// opts.persistWireframe: true → compress wireframeHTML with LZString; false → strip (null)
// Variant-aware whitelist approach. Deep-clones coverageData.
// Returns a new object — never mutates protoStore in place.
function _ssStripProtoTransient(store, opts) {
  if (!store || typeof store !== 'object') return {};
  var persistWireframe = !!(opts && opts.persistWireframe);
  var lzAvail = typeof LZString !== 'undefined' && typeof LZString.compressToUTF16 === 'function';
  var result = {};
  Object.keys(store).forEach(function(featId) {
    var entry = store[featId];
    if (!entry) return;
    // Build stripped/compressed variants
    var strippedVariants = {};
    var variants = entry.variants || {};
    Object.keys(variants).forEach(function(vid) {
      var v = variants[vid];
      if (!v) return;
      var compressed = null;
      if (persistWireframe && lzAvail && v.wireframeHTML) {
        try { compressed = LZString.compressToUTF16(v.wireframeHTML); } catch(_) {}
      }
      if (persistWireframe && !lzAvail && v.wireframeHTML) {
        console.warn('[SS] LZString not available — wireframe will not persist for', featId);
      }
      strippedVariants[vid] = {
        generated:              !!v.generated,
        stale:                  !!v.stale,
        generating:             false,
        generatingPhase:        null,
        generatedAt:            v.generatedAt || null,
        inputSignature:         v.inputSignature || null,
        wireframeBlobUrl:       null,
        wireframeHTML:          null,
        wireframeHTMLCompressed:compressed || null,
        designBrief:            v.designBrief || null,
        coverageData:           Array.isArray(v.coverageData)
          ? _ssCloneJsonSafe(v.coverageData, [])
          : [],
        externalPrompt:         v.externalPrompt || null,
        partial:                !!v.partial,
        partialReason:          v.partialReason || null,
        nonUI:                  !!v.nonUI
      };
    });
    result[featId] = {
      featureId:           entry.featureId || featId,
      activeVariantId:     entry.activeVariantId || 'v1',
      additionalContext:   entry.additionalContext || '',
      screenshotFile:      null,
      screenshotDataUrl:   null,
      screenshotInherited: false,
      inheritedFromFeatId: null,
      variants:            strippedVariants
    };
  });
  return result;
}

// ── Strip extractedText from session docs before snapshot ──
// Always returns a new object to prevent shared-reference mutation of live sessionContext.
function _ssStripSessionDocs(ctx){
  if(!ctx)return null;
  var stripped=Object.assign({},ctx);
  stripped.sessionDocs=(ctx.sessionDocs||[]).map(function(d){
    var d2=Object.assign({},d);
    delete d2.extractedText;
    return d2;
  });
  return stripped;
}

function _sessionStoreBuildSnapshot(opts) {
  return {
    sessionContext: _ssStripSessionDocs(
      typeof sessionContext !== 'undefined' ? sessionContext : null
    ),
    gData: (typeof gData !== 'undefined') ? gData : null,
    productContext: (typeof productContext !== 'undefined') ? productContext : null,
    capStore: (typeof capStore !== 'undefined') ? capStore : {},
    scCanvas: (typeof scCanvas !== 'undefined') ? scCanvas : [],
    scStoryIdCounter: (typeof scStoryIdCounter !== 'undefined') ? scStoryIdCounter : 0,
    piPlans: (typeof piPlans !== 'undefined') ? piPlans : [],
    piBacklogStoryIds: (typeof piBacklogStoryIds !== 'undefined') ? piBacklogStoryIds : [],
    piInputs: (typeof piInputs !== 'undefined') ? piInputs : null,
    diagnosticSessions: (typeof diagnosticSessions !== 'undefined') ? diagnosticSessions : [],
    activeDiagnosticId: (typeof activeDiagnosticId !== 'undefined') ? activeDiagnosticId : null,
    productLeakAnalysis: (typeof productLeakAnalysis !== 'undefined') ? productLeakAnalysis : [],
    miData: (typeof miData !== 'undefined') ? miData : null,
    miGenerated: (typeof miGenerated !== 'undefined') ? miGenerated : false,
    miProductMode: (typeof miProductMode !== 'undefined') ? miProductMode : 'market',
    miCapabilities: (typeof miCapabilities !== 'undefined') ? miCapabilities : [],
    ddGenerated: (typeof ddGenerated !== 'undefined') ? ddGenerated : false,
    // v9.08.04 fix: ddGenerated (the flag) was already being saved, but the
    // actual dictionary content it claims to represent never was — every
    // collaborator opening the session in their own browser started with
    // an empty window._ddRows regardless of what a teammate had already
    // generated, causing silent, redundant regeneration on every open.
    ddRows: (typeof window !== 'undefined' && window._ddRows) ? window._ddRows : [],
    mmBannerCollapsed: (typeof mmBannerCollapsed !== 'undefined') ? mmBannerCollapsed : false,
    protoStore: _ssStripProtoTransient(typeof protoStore !== 'undefined' ? protoStore : {}, opts || {}),
    // v9.15.02 — Guided Launch chat/draft, replacing the old separate
    // mt_intake_sessions/mt_intake_messages tables entirely. Same
    // typeof-guarded pattern as every other field above: harmless empty
    // defaults for every session that never touched Guided Launch.
    // glResetState() (guided-launch.js), called from homeClearSession() on
    // every session transition, is what keeps these from a DIFFERENT,
    // abandoned Guided Launch session bleeding into an unrelated session's
    // snapshot here.
    glMessages: (typeof glMessages !== 'undefined') ? glMessages : [],
    glDraftMd: (typeof glDraftMd !== 'undefined') ? glDraftMd : '',
    glFinalMd: (typeof glFinalMd !== 'undefined') ? glFinalMd : null,
    glContextHash: (typeof glContextHash !== 'undefined') ? glContextHash : null,
    // v9.15.04, Item 5 — plain integer edit count, formatted for display
    // only (see guided-launch.js's _glFormatVersion()). Default 1, matching
    // glVersionCount's own initial value for a session that never touched
    // Guided Launch.
    glVersionCount: (typeof glVersionCount !== 'undefined') ? glVersionCount : 1,
    // Requirement Agent. raConversations lives entirely inside the ACTIVE
    // session's own snapshot (unlike Guided Launch's dedicated mt_sessions
    // row per conversation) — one conversation = one release scope, but many
    // conversations share the one Capability Canvas/session they're both
    // scoped to. raEnabled is the per-session toggle that gates Discovery
    // Map's "Define Requirements" CTA relabel/reroute (kpi-tree.js).
    raEnabled: (typeof raEnabled !== 'undefined') ? raEnabled : false,
    raConversations: (typeof raConversations !== 'undefined') ? raConversations : [],
    raLastOpenConversationId: (typeof raLastOpenConversationId !== 'undefined') ? raLastOpenConversationId : null,
    // Adoption Readiness (v9.21) — flat globals, matching raEnabled's own
    // convention (not a nested session.* object, per build spec correction).
    piReadinessPlans: (typeof piReadinessPlans !== 'undefined') ? piReadinessPlans : [],
    opUnlocked: (typeof opUnlocked !== 'undefined') ? opUnlocked : false
  };
}

// Regression guard for the exact bug class that shipped piReadinessPlans/
// piPlans/window._ddRows into _sessionStoreBuildSnapshot() above without a
// matching reset in homeClearSession() (home.js): every field listed here
// holds PER-SESSION CONTENT (never cross-session config/flags), so it must
// be back to empty the instant homeClearSession() finishes. Whenever a new
// canvas/feature adds a container field to _sessionStoreBuildSnapshot()
// above, add its name here too — this list is intentionally separate from
// (not derived from) that function, so a mismatch between "what gets saved"
// and "what gets reset" surfaces immediately as a console.error during
// normal use/testing, instead of silently baking one session's data into
// the next the way this bug did. Called from the end of homeClearSession().
var _SS_CONTENT_FIELDS = ['capStore','scCanvas','piPlans','piBacklogStoryIds','diagnosticSessions','miCapabilities','ddRows','protoStore','glMessages','raConversations','piReadinessPlans'];
function _ssAssertCleanSlate() {
  if (typeof _sessionStoreBuildSnapshot !== 'function') return;
  var snap = _sessionStoreBuildSnapshot();
  var leaked = _SS_CONTENT_FIELDS.filter(function(k) {
    var v = snap[k];
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v).length > 0;
    return false;
  });
  if (leaked.length) {
    console.error('[homeClearSession] leak guard: session-content field(s) still non-empty right after clear: ' + leaked.join(', ') + ' — a new snapshot field was likely added to _sessionStoreBuildSnapshot() without a matching reset in homeClearSession().');
  }
}

function _ssComputeLastStage() {
  // v9.15.02 — checked first, before any downstream-content check: while a
  // Guided Launch chat is active, nothing else below exists yet (no gData,
  // no capStore), so without this every save during the chat would
  // incorrectly recompute 'Not started'. Reads the live glStatus global
  // (guided-launch.js), not meta.intakeStatus — this function has always
  // read live globals directly, on the same one-session-live-at-a-time
  // invariant glResetState() (called from homeClearSession()) enforces for
  // every other field it checks below.
  // v9.17.03 — glStatus defaults to 'active' at module load (guided-launch.js
  // line 27) regardless of whether the (now-hidden, tab-gl) Guided Launch
  // flow was ever actually engaged, and it is never flipped away from
  // 'active' unless that legacy flow is manually completed. Since tab-gl is
  // display:none in current builds (see index.html's "NAMING RESOLVED"
  // comment) this made EVERY session report "Guided Launch" as its stage,
  // permanently — confirmed live (glStatus==='active' on a fresh demo
  // session that never touched Guided Launch). Gate on real message content
  // as well, so this branch only fires for legacy sessions that actually
  // used the old chat.
  if (typeof glStatus !== 'undefined' && glStatus === 'active' && typeof glMessages !== 'undefined' && glMessages && glMessages.length > 0) return 'Guided Launch';
  // v9.22 — Adoption Readiness and Outcome Pulse extend the value chain past
  // Release Canvas. Both must be checked before the piPlans check below:
  // piPlans stays populated once a release exists, so without these a
  // session that has since finalized a readiness plan (or unlocked Outcome
  // Pulse) would still match the Release Canvas branch first and never
  // report having moved further.
  if (typeof opUnlocked !== 'undefined' && opUnlocked) return 'Outcome Pulse';
  if (typeof piReadinessPlans !== 'undefined' && Array.isArray(piReadinessPlans) && piReadinessPlans.length > 0) return 'Adoption Readiness';
  // Matches _ssRevealTabs()'s own hasPiContent convention for tab-pi (below,
  // ~line 1897): staging stories from Story Canvas pushes their ids into
  // piBacklogStoryIds and reveals the Release Canvas tab immediately (see
  // story-canvas-new.js's newScSendToPI()) — well before "Generate Release
  // Plan" ever creates a piPlans entry. Checking piPlans.length alone here
  // left the stage label stuck on 'Story Canvas' for the entire time a user
  // was actually already working in Release Canvas with staged-but-unplanned
  // stories.
  if ((typeof piBacklogStoryIds !== 'undefined' && Array.isArray(piBacklogStoryIds) && piBacklogStoryIds.length > 0) ||
      (typeof piPlans !== 'undefined' && Array.isArray(piPlans) && piPlans.length > 0)) return 'Release Canvas';
  if (typeof scCanvas !== 'undefined' && scCanvas.length > 0) {
    const hasStories = scCanvas.some(function(f) { return f.stories && f.stories.length > 0; });
    if (hasStories) return 'Story Canvas';
  }
  if (typeof capStore !== 'undefined') {
    const keys = Object.keys(capStore);
    if (keys.length > 0) {
      const hasFeatures = keys.some(function(k) {
        const e = capStore[k];
        return e && e.capabilities && e.capabilities.some(function(c) {
          return c.featStore && c.featStore.top && c.featStore.top.length > 0;
        });
      });
      if (hasFeatures) return 'Feature Canvas';
      return 'Capability Canvas';
    }
  }
  // Requirement Agent sits between Discovery Map/Capability Canvas and
  // Feature Canvas in the value chain (see requirement-agent.js's header
  // comment). Checked here — after the Feature-Canvas-via-capStore check
  // above (so a finalized RA conversation whose features already landed in
  // capStore correctly reports 'Feature Canvas', the more advanced stage)
  // but before the Discovery Map fallback below (so an in-progress RA
  // conversation, which has no capStore entries yet if every touched
  // capability is still "will be created", correctly reports 'Requirement
  // Agent' instead of falling all the way back to 'Discovery Map').
  if (typeof raConversations !== 'undefined' && raConversations && raConversations.length > 0) return 'Requirement Agent';
  if (typeof gData !== 'undefined' && gData) return 'Discovery Map';
  return 'Not started';
}

function _ssComputeCounts() {
  let caps = 0, features = 0, stories = 0, sprintActive = null;

  var briefs = 0;
  if (typeof raConversations !== 'undefined' && Array.isArray(raConversations)) {
    briefs = raConversations.filter(function(c) { return c && c.status === 'finalized'; }).length;
  }

  var releases = (typeof piPlans !== 'undefined' && Array.isArray(piPlans)) ? piPlans.length : 0;

  if (typeof capStore !== 'undefined') {
    Object.keys(capStore).forEach(function(k) {
      const e = capStore[k];
      if (!e || !e.capabilities) return;
      caps += e.capabilities.length;
      e.capabilities.forEach(function(c) {
        if (c.featStore && c.featStore.top) features += c.featStore.top.length;
      });
    });
  }

  if (typeof scCanvas !== 'undefined') {
    scCanvas.forEach(function(f) {
      if (f.stories) stories += f.stories.length;
    });
  }

  if (typeof piPlans !== 'undefined' && Array.isArray(piPlans) && piPlans.length > 0) {
    const _activePlan = (typeof _piActivePlanId !== 'undefined' && _piActivePlanId)
      ? piPlans.find(function(p) { return p.id === _piActivePlanId; }) || piPlans[0]
      : piPlans[0];
    const sprintNums = Object.values(_activePlan.storyAssignments || {})
      .map(function(a) { return a && a.sprint; })
      .filter(function(n) { return typeof n === 'number' && n > 0; });
    if (sprintNums.length > 0) sprintActive = 'Sprint ' + Math.max.apply(null, sprintNums);
  }

  var _docs=(typeof sessionContext!=='undefined'&&sessionContext&&sessionContext.sessionDocs)
    ?sessionContext.sessionDocs.length:0;

  // Count prototypes — only for live features, variant-aware
  var protos = 0;
  if (typeof protoStore !== 'undefined' && protoStore) {
    var _liveIds = new Set((typeof scCanvas !== 'undefined' ? scCanvas : []).map(function(f){ return f.id; }));
    protos = Object.keys(protoStore).filter(function(k) {
      if (!_liveIds.has(k)) return false;
      var entry = protoStore[k];
      if (!entry || !entry.variants || !entry.activeVariantId) return false;
      var v = entry.variants[entry.activeVariantId];
      return !!(v && v.generated);
    }).length;
  }

  return { caps, features, stories, sprintActive, docs:_docs, protos, briefs, releases };
}

// Phase 5 fix (v8.118): single source of truth for "should the MI tab be
// visible for this session," used by BOTH reveal code paths (this resume
// path, and generateConfirmed()'s own post-generation reveal in
// kpi-tree.js) so they can't silently drift apart on the logic again.
// Strict === true checks throughout (not loose truthy) per adversarial
// review — a corrupted/old serialization that somehow stored the string
// "false" would be loosely truthy but must not be treated as enabled.
// undefined (the correct case for every session saved before this fix
// shipped) correctly fails both strict checks and falls through to
// whichever of the two conditions is actually true, unchanged from
// today's behavior for old sessions.
// v9.15.03, Item 6 — extracted from sessionStoreRestore()'s own targetTab
//==='mm' branch so guided-launch.js's "Continue to Discovery Map" link (a
// completed Guided Launch session whose generation never finished before
// the user left) can show the exact same "interrupted" state, rather than
// landing on a silently blank Discovery Map. Shows only when gData is
// actually absent — this function does not itself check that condition,
// callers do (matches the extracted call site's own existing guard).
function _ssShowInterruptedGenerationState(s) {
  if (typeof hideLoad === 'function') hideLoad();
  if (typeof endAiGen === 'function') endAiGen();
  // v9.15.04, Item 2 — _ssRevealTabs()'s normal tab-mm condition (if s.gData)
  // is correctly false here (no map exists yet), but the user is looking
  // straight at the mm content area and needs the button to navigate back
  // to it later. glContinueToDiscoveryMap() (guided-launch.js) already did
  // this at its own call site; moved here so every caller of this shared
  // state gets it, not just that one.
  const tabMm = document.getElementById('tab-mm');
  if (tabMm) tabMm.style.display = '';
  const esEl = document.getElementById('es');
  if (esEl) {
    const productName = (s.sessionContext && s.sessionContext.productProfile && s.sessionContext.productProfile.productName) || 'this product';
    esEl.innerHTML = `
      <div class="empty-icon"><i class="ti ti-player-pause" style="color:var(--purple);"></i></div>
      <div class="empty-title">Generation was interrupted</div>
      <div class="empty-desc">Your session for <strong>${e(productName)}</strong> was started but the Discovery Map didn't complete. Your product details are ready — click Generate to continue.</div>
      <div class="empty-steps">
        <button class="gen-btn" onclick="generate()" style="margin-top:8px;"><i class="ti ti-sparkles" style="font-size:13px;" aria-hidden="true"></i> Generate Discovery Map</button>
      </div>`;
    esEl.style.display = '';
  }
}

function _ssShouldShowMiTab(s) {
  if (!s) return false;
  if (s.miGenerated === true) return true;
  if (s.gData && s.gData.marketIntelligenceEnabled === true) return true;
  return false;
}

// v8.136 (item 10 redesign): hide-then-reveal, matching a snapshot's
// actual data — generalizing what used to be inline-only in
// sessionStoreRestore() (the hide-first step) plus the existing
// reveal-only _ssRevealTabs() into one function usable from both the
// normal resume path and the cross-user wholesale apply path. Order
// matters: hide unconditionally first, so a stale "revealed" state (from
// this session's own prior data, or — for cross-user apply — the
// receiving viewer's own current tabs) never survives into what's shown
// next; only then reveal what THIS snapshot's data actually supports.
function _ssSyncTabVisibility(s, meta) {
  ['tab-mm','tab-cc','tab-mi','tab-la','tab-fc','tab-op','tab-gl'].forEach(function(id){
    var el=document.getElementById(id);
    if(el){ el.style.display='none'; el.removeAttribute('data-home-hidden'); }
  });
  ['tab-sc','tab-pi','tab-ra','tab-arp'].forEach(function(id){
    var el=document.getElementById(id);
    if(el) el.classList.remove('revealed');
  });
  _ssRevealTabs(s, meta);
}

function _ssRevealTabs(s, meta) {
  // v9.15.02 — Guided Launch, meta-driven (not snapshot-driven like every
  // other tab below): visible for ANY session that ever went through
  // Guided Launch, active or completed, so a finalized session can still be
  // navigated back into to see the chat that produced it. meta is optional
  // — the two live-sync.js wholesale-apply call sites don't have it and
  // don't need to; intake_status never changes via that path.
  if (meta && meta.intakeStatus) {
    const tabGl = document.getElementById('tab-gl');
    if (tabGl) tabGl.style.display = '';
  }
  if (s.gData) {
    const tabMm = document.getElementById('tab-mm');
    if (tabMm) tabMm.style.display = '';
  }
  if (s.capStore && Object.keys(s.capStore).length > 0) {
    const tabCc = document.getElementById('tab-cc');
    if (tabCc) tabCc.style.display = '';
  }
  if (_ssShouldShowMiTab(s)) {
    const tabMi = document.getElementById('tab-mi');
    if (tabMi) tabMi.style.display = '';
  }
  if (s.scCanvas && s.scCanvas.length > 0) {
    const tabFc = document.getElementById('tab-fc');
    if (tabFc) tabFc.style.display = '';
  }
  const hasStories = s.scCanvas && s.scCanvas.some(function(f) {
    return f.stories && f.stories.length > 0;
  });
  if (hasStories) {
    const tabSc = document.getElementById('tab-sc');
    if (tabSc) tabSc.classList.add('revealed');
  }
  // v9.16 — Requirement Agent. Content-truthiness gated via '.revealed',
  // same family as tab-sc/tab-pi above (NOT the simpler style.display
  // presence-only mechanism most other tabs use) — chosen over the spec's
  // alternative option ("or once the tab has been opened at least once")
  // because tab-sc's own precedent is exactly this: hasStories checks real
  // content (scCanvas stories), not a "has this tab ever been opened"
  // flag, and there is no existing "opened at least once" flag anywhere in
  // this codebase for any tab to mirror instead. A conversation only ever
  // exists in raConversations[] once the user has actually started one
  // (raConversations.length>0), so pure content-truthiness already covers
  // "the tab has real content to show" without needing a second signal.
  if (s.raConversations && s.raConversations.length > 0) {
    const tabRa = document.getElementById('tab-ra');
    if (tabRa) tabRa.classList.add('revealed');
  }
  // Outcome Verification Loop (v9.10.00 feedback item 8, confirmed real
  // gap via code read): applyFeats() is never called during session
  // resume — _ssSyncTabVisibility()/_ssRevealTabs() is the actual
  // resume-time tab-visibility mechanism, and it had no knowledge of
  // tab-op at all. Without this, tab-op would silently retain whatever
  // display state it happened to have BEFORE resume started, rather than
  // being correctly recalculated for the session actually being opened —
  // exactly the class of bug this feedback item was warning about, not
  // yet actually broken by coincidence, but a real latent gap. Matches
  // the same combined condition now enforced in applyFeats(): feature
  // flag on AND a Discovery Map (s.gData) present in the resumed
  // snapshot.
  // Revised: also require at least one Feature Canvas feature (s.scCanvas)
  // to exist before revealing — matches the same combined condition now
  // enforced in applyFeats() (left-panel.js).
  {
    const tabOp = document.getElementById('tab-op');
    if (tabOp) tabOp.style.display = s.opUnlocked ? '' : 'none';
  }
  // v9.01-diag fix: was `if (s.piPlan)` -- a bare truthiness check that's
  // true for ANY non-null piPlan object, including the default empty one
  // created at session start before anything is ever staged for PI. That
  // meant this check couldn't actually distinguish "nothing staged" from
  // "stories staged" -- now requires genuine staged content (a non-empty
  // backlog or at least one sprint assignment) before revealing the tab.
  // v9.20: s.piPlan (singular) no longer exists on any snapshot saved after
  // this update - migrateToMultiReleasePlans() converts it to s.piPlans[]
  // (and the plan-agnostic s.piBacklogStoryIds) before this ever runs, and
  // a brand-new session created after v9.20 never had s.piPlan to begin
  // with. Reveal whenever any plan has real content, or the shared backlog
  // tray itself has stories waiting.
  const hasPiContent = (Array.isArray(s.piBacklogStoryIds) && s.piBacklogStoryIds.length > 0) ||
    (Array.isArray(s.piPlans) && s.piPlans.some(function(p){
      return p && p.storyAssignments && Object.keys(p.storyAssignments).length > 0;
    }));
  // TEMP DIAGNOSTIC (v9.01-diag) — remove once the PI-tab-resume issue is
  // confirmed fixed across a few real reproductions. Logs the actual
  // restored piPlan content and the reveal decision, so if the tab still
  // doesn't appear after this fix, we have real evidence of what the
  // restored snapshot actually contained instead of guessing again.
  if (hasPiContent) {
    const tabPi = document.getElementById('tab-pi');
    if (tabPi) tabPi.classList.add('revealed');
  }
  // Adoption Readiness (v9.22, real top-nav tab) — reveal whenever this
  // snapshot has at least one readinessPlan, same content-truthiness
  // convention as tab-sc/tab-pi/tab-ra above.
  if (Array.isArray(s.piReadinessPlans) && s.piReadinessPlans.length > 0) {
    const tabArp = document.getElementById('tab-arp');
    if (tabArp) tabArp.classList.add('revealed');
  }
  if (s.productLeakAnalysis && (Array.isArray(s.productLeakAnalysis) ? s.productLeakAnalysis.length > 0 : true)) {
    const tabLa = document.getElementById('tab-la');
    if (tabLa) tabLa.style.display = '';
  }
}

// Transient "✓ Saved" indicator in header
var _ssSaveTimer = null;
function _ssShowSaved() {
  const el = document.getElementById('hdr-saved');
  if (!el) return;
  el.classList.add('on');
  if (_ssSaveTimer) clearTimeout(_ssSaveTimer);
  _ssSaveTimer = setTimeout(function() {
    el.classList.remove('on');
    _ssSaveTimer = null;
  }, 3000);
}

// localStorage index helpers
function _ssGetIndex() {
  try {
    const raw = localStorage.getItem(_SS_INDEX);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function _ssAddToIndex(id) {
  const index = _ssGetIndex();
  if (index.indexOf(id) === -1) index.unshift(id);
  try { localStorage.setItem(_SS_INDEX, JSON.stringify(index)); } catch(e) {}
}

function _ssRemoveFromIndex(id) {
  const index = _ssGetIndex().filter(function(i) { return i !== id; });
  try { localStorage.setItem(_SS_INDEX, JSON.stringify(index)); } catch(e) {}
}

// v9.31: meta-index helpers — same shape/naming as the id-index helpers
// above, applied to the always-complete { [id]: meta } dict. This is what
// sessionStoreList() reads from directly, and what every meta-mutating
// function (rename, share-toggle, intake-status, last-tab) must write
// through too, independent of whether that session's full { meta, snapshot }
// blob under _SS_PREFIX still exists locally.
function _ssGetMetaIndex() {
  try {
    const raw = localStorage.getItem(_SS_META_INDEX);
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}
function _ssSetMetaEntry(id, meta) {
  const idx = _ssGetMetaIndex();
  idx[id] = meta;
  try { localStorage.setItem(_SS_META_INDEX, JSON.stringify(idx)); } catch(e) {}
}
function _ssRemoveMetaEntry(id) {
  const idx = _ssGetMetaIndex();
  delete idx[id];
  try { localStorage.setItem(_SS_META_INDEX, JSON.stringify(idx)); } catch(e) {}
}

// Auto-name: "ProductName · DD Mon"
function _ssAutoName(productName, ts) {
  const d = new Date(ts);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return productName + ' \u00b7 ' + d.getDate() + ' ' + months[d.getMonth()];
}

// Simple UUID v4
function _ssUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
