// LIVE SYNC — v8.123 (Phase 2: event emission only)
// New module for the live multi-user sync feature. Kept isolated from
// existing files per AI_EDITING_RULES' "new features get new files"
// convention — Phase 3 will add the Home-tab poll, in-session poll+Realtime
// watch, persistent content banner, and targeted-refresh apply logic here.
// This phase ONLY adds the emit-side helper, called from the three
// confirmed generation-completion call sites in capability-canvas.js
// (ccGenerateOne, ccGenerateAll, _ccGenerateFeaturesForCapInner_REQUIRES_LOCK_HANDLE).
//
// Design invariants carried over from the design/adversarial-review threads —
// restated here so they're visible at the point future edits to this file
// will actually happen, not just in conversation history:
//   - Never call this from a private (non-shared) session — zero added cost
//     for the overwhelming majority of usage, matching withGenerationLock's
//     own private-session skip.
//   - This function only ever INSERTs. It never reads mt_sessions.snapshot,
//     never calls sessionStoreSave(), never merges anything into local
//     session state. Reads and writes stay structurally separate — this is
//     the specific invariant the prior rolled-back attempt violated.
//   - Called AFTER the caller's own sessionStoreSave() has already resolved
//     without error — never in parallel, never before. This ordering alone
//     (no server-side transaction) is what prevents an event being visible
//     before its content is actually fetchable, and prevents an event
//     existing for content that failed to save.
//   - Failure here is logged and swallowed, never surfaced to the user and
//     never allowed to affect the generation flow that just completed —
//     a missed toast for a teammate is an accepted low-severity gap; failing
//     or alarming the person who just successfully generated content is not.

// ── Emit one content-change event for a shared session ──
// sessionId: the session just saved (must be shared — caller's responsibility
//   to check _activeSessionIsShared before calling; this function does not
//   re-check, since it has no independent way to know without another query,
//   and every current call site already only runs inside an active session).
// eventType: 'capabilities_generated' | 'features_generated'
// metricKey: required, the capStore key the generation targeted
// capName: the exact capability name for a features_generated event, or
//   null for capabilities_generated (which covers a whole metric, not a
//   single capability — there's no single cap name to attach)
async function _lsEmitContentEvent(sessionId, canvas, eventType, metricKey, capName){
  try{
    if(!sessionId) return;
    const client=(typeof authInit==='function')?authInit():null;
    if(!client) return;
    const uid=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:null;
    if(!uid) return;
    const activeCompanyId=(function(){
      try{ return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY)||null; }catch(e){ return null; }
    })();
    if(!activeCompanyId) return;
    // Resolve the acting user's display name the same way _ssUpsertToDB does
    // (session-store.js) — same "cheap, zero extra round-trip" rationale,
    // same existing precedent (last_edited_by_name is also client-supplied,
    // display-only text; RLS never depends on this field, only on
    // generated_by, which the DB independently checks against the lock).
    let _name='';
    try{
      if(typeof authGetUser==='function'){
        const _u=await authGetUser();
        _name=(_u&&_u.displayName)||'';
      }
    }catch(e){ /* non-fatal — event still inserts without a display name */ }

    const { error } = await client.from('mt_session_content_events').insert({
      session_id: sessionId,
      company_id: activeCompanyId,
      canvas: canvas,
      event_type: eventType,
      metric_key: metricKey,
      cap_name: capName||null,
      generated_by: uid,
      generated_by_name: _name
    });
    if(error) console.warn('[live-sync] content event insert failed:', error.message);
  }catch(e){
    console.warn('[live-sync] content event insert exception:', e);
  }
}

// ============================================================
// PHASE 3 (v8.126) — poll/watch/banner/kickout
// ============================================================
// Shared design invariants across everything below, restated here since
// this is where they actually get enforced, not just described:
//   - Every async continuation (poll tick, watch tick, banner refresh)
//     checks a sequence token AFTER every await, before acting. A stopped/
//     superseded cycle's late-arriving results are discarded, never applied.
//   - Nothing here ever calls sessionStoreSave() or writes session content
//     to the DB. Only mt_sessions (metadata select) and
//     mt_session_content_events (select) are ever read. The only DB writes
//     in this whole file remain _lsEmitContentEvent's inserts (Phase 2,
//     unchanged above) — reads and writes stay structurally separate.
//   - Realtime is never load-bearing anywhere below — every flow that uses
//     it also has a baseline poll that alone is sufficient for correctness.

// ── Shared helpers ──
function _lsGetClient(){
  return (typeof authInit === 'function') ? authInit() : null;
}
function _lsGetActiveCompanyId(){
  try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || null; } catch(e) { return null; }
}
function _lsRemoveLocalSessionEntry(sessionId){
  // Local-cache-only removal — never attempts a DB delete (we don't own
  // this session; we're just cleaning up our own local view of it after
  // losing access, not deleting anyone else's data). Reuses the existing
  // index-removal helper rather than duplicating its logic.
  try {
    localStorage.removeItem(_SS_PREFIX + sessionId);
    if (typeof _ssRemoveFromIndex === 'function') _ssRemoveFromIndex(sessionId);
    // v9.31: also drop the meta-index entry — this session is confirmed
    // gone (unshared/deleted by someone else), not merely snapshot-evicted,
    // so it must disappear from Home's list too, not just lose its cached
    // content. Without this it would become a new, narrower version of the
    // exact orphan problem the meta-index was introduced to avoid.
    if (typeof _ssRemoveMetaEntry === 'function') _ssRemoveMetaEntry(sessionId);
  } catch(e) {}
}

// v8.133 fix (item 3): a courtesy, non-authoritative pre-check for a
// generation-lock conflict, called before any "this will clear/replace
// your data" confirm dialog. Confirmed via real, live testing that every
// generation-trigger function currently shows its confirm BEFORE the real
// lock is ever checked — meaning a conflict is only discovered after the
// user has already gone through the confirm(s). This does not replace the
// real, authoritative acquire in withGenerationLock() (api.js) — it's
// purely advisory, so it can safely fail open on any error (network
// failure, RLS issue, missing data) without weakening real enforcement;
// the actual lock acquisition still runs exactly as before regardless of
// what this returns. The 60-second staleness window is deliberately wider
// than the confirmed 22-second heartbeat interval in _startLockHeartbeat()
// (api.js) — active_at is refreshed every 22s for the FULL duration of any
// real generation, including PI's 2-4 minute case, so 60s has ample
// margin without needing to match the heartbeat exactly.
async function _lsPeekIfLocked(sessionId){
  try {
    if (typeof _activeSessionIsShared === 'undefined' || !_activeSessionIsShared || !sessionId) return { locked: false };
    var client = _lsGetClient();
    if (!client) return { locked: false };
    var myId = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
    if (!myId) return { locked: false };
    var res = await client.from('mt_sessions').select('active_user_id, active_at, active_user_name').eq('id', sessionId).limit(1);
    if (res.error || !res.data || res.data.length === 0) return { locked: false };
    var row = res.data[0];
    if (!row.active_user_id || String(row.active_user_id) === String(myId)) return { locked: false };
    var activeMs = row.active_at ? Date.parse(row.active_at) : NaN;
    if (!Number.isFinite(activeMs)) return { locked: false };
    var ageMs = Date.now() - activeMs;
    // Small forward tolerance (-5000) absorbs minor client/server clock skew.
    var isRecent = ageMs >= -5000 && ageMs < 60000;
    if (isRecent) {
      return { locked: true, holderName: row.active_user_name || 'Someone on your team' };
    }
    return { locked: false };
  } catch(e) {
    return { locked: false }; // fail open — the real, authoritative check still runs downstream
  }
}

// ============================================================
// SESSION OCCUPANCY LOCK (v9.12) — "Single User Editing" mode
// ============================================================
// Distinct from the generation lock above (active_user_id/active_at/
// active_user_name, acquire_generation_lock/release_generation_lock) —
// that mechanism only protects the moment a generation call is running
// (refreshed by a 22s heartbeat for that call's duration), not the whole
// time a shared session is open for manual editing (adding a feature by
// hand, editing story text, etc. — none of which ever calls the
// generation lock at all). This section adds a second, fully independent
// lease (occupant_user_id/occupant_at/occupant_user_name, claimed via
// claim_session_occupancy/released via release_session_occupancy/kept
// alive via heartbeat_session_occupancy) that covers the ENTIRE time a
// session is open for edit under appSettings.collabEditMode==='single'.
// Deliberately separate columns/RPCs from the generation lock — confirmed
// via reading server.js that active_user_id/active_at are already treated
// elsewhere in this app as generation-lock-specific (the admin
// "delete team member" flow clears them explicitly as such); conflating
// "someone is generating right now" with "someone has this session open"
// would break that existing assumption.
//
// Design invariants:
//   - Only ever relevant when _activeSessionIsShared, _activeSessionShareMode
//     is 'edit', and appSettings.collabEditMode is 'single' — Multi mode and
//     private sessions never touch any of this, zero added cost.
//   - The claim RPC is atomic (claim-or-report-holder in one UPDATE), not a
//     separate peek-then-write — closes the check-then-act race a naive
//     two-step client-side approach would have.
//   - The heartbeat requires the existing lease to still be unexpired
//     before refreshing it — a heartbeat delayed by a sleeping laptop or a
//     frozen background tab must NOT be able to resurrect an already-
//     expired lease out from under a legitimate new claimant.
//   - Fully independent timer/in-flight/seq state from the generation
//     heartbeat (_startLockHeartbeat, api.js) — these two locks are
//     conceptually unrelated even though structurally similar, and must
//     never share a controller.
//   - A stale sessionStoreRestore() continuation (user navigated away
//     while a claim was still in flight) must release any claim it
//     successfully-but-too-late acquired, never just abandon it — an
//     abandoned successful claim would leave the session occupied by a
//     tab that's no longer even looking at it.
//   - Known, deliberately accepted limitation: the same authenticated user
//     in two different browser tabs can both hold occupancy simultaneously
//     (the claim RPC's own-user-reentrant branch permits this) — mirrors
//     an already-accepted equivalent gap in the generation lock itself
//     (documented in api.js as "does NOT solve true cross-device same-user
//     concurrency"). Not solved here by deliberate scope decision.

async function _lsClaimSessionOccupancy(sessionId){
  try {
    var client = _lsGetClient();
    if (!client) return { claimed: false, occupantUserName: null };
    var res = await client.rpc('claim_session_occupancy', { p_session_id: sessionId });
    if (res.error || !res.data) return { claimed: false, occupantUserName: null };
    return {
      claimed: res.data.claimed === true,
      occupantUserName: res.data.occupant_user_name || null,
      reason: res.data.reason || null
    };
  } catch(e) {
    console.warn('[live-sync] claim_session_occupancy failed:', e);
    return { claimed: false, occupantUserName: null };
  }
}

async function _lsReleaseSessionOccupancy(sessionId){
  try {
    var client = _lsGetClient();
    if (!client || !sessionId) return;
    var res = await client.rpc('release_session_occupancy', { p_session_id: sessionId });
    if (res.error) console.warn('[live-sync] release_session_occupancy failed:', res.error.message);
  } catch(e) {
    console.warn('[live-sync] release_session_occupancy exception:', e);
  }
}

// Single-flight heartbeat, structurally mirroring _startLockHeartbeat
// (api.js) but with entirely separate state — no shared timer, in-flight
// promise, or stopped flag between the two locks. onOccupancyLost is
// called on a clean `false` return from the RPC (the lease genuinely
// expired or was reassigned server-side, not a network error) — the
// caller uses this to demote the session to view-only and toast.
function _lsOccupancyHeartbeatStart(sessionId, onOccupancyLost){
  var stopped = false, timer = null, inFlight = null;
  async function beat(){
    if (stopped) return;
    inFlight = (async () => {
      try {
        var client = _lsGetClient();
        if (!client) { stopped = true; onOccupancyLost(); return; }
        var res = await client.rpc('heartbeat_session_occupancy', { p_session_id: sessionId });
        if (res.error) {
          // A single failed tick (network blip, transient RLS/auth hiccup) does
          // NOT mean occupancy is lost — only a clean `false` data value does.
          console.warn('[live-sync] occupancy heartbeat tick failed, state unknown, continuing:', res.error.message);
        } else if (res.data === false) {
          stopped = true;
          onOccupancyLost();
          return;
        }
      } catch(e) {
        console.warn('[live-sync] occupancy heartbeat exception, continuing:', e);
      } finally {
        inFlight = null;
      }
      if (!stopped) timer = setTimeout(beat, 22000);
    })();
  }
  timer = setTimeout(beat, 22000);
  return {
    async stopAndWait(){
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) { try { await inFlight; } catch(e) {} }
    }
  };
}

// Module-level handle for the currently-running occupancy heartbeat, if
// any — mirrors how the in-session watch (_lsSessionWatchStart/Stop below)
// tracks its own lifecycle at module scope, so homeClearSession() and a
// fresh sessionStoreRestore() call can both reliably stop whatever was
// previously running without needing that handle threaded through.
var _lsOccupancyHeartbeatHandle = null;
var _lsOccupancySessionId = null;

function _lsOccupancyHeartbeatStartTracked(sessionId, onOccupancyLost){
  _lsOccupancyHeartbeatStop(); // idempotent — tears down any previous one first
  _lsOccupancySessionId = sessionId;
  _lsOccupancyHeartbeatHandle = _lsOccupancyHeartbeatStart(sessionId, onOccupancyLost);
}

async function _lsOccupancyHeartbeatStop(){
  if (_lsOccupancyHeartbeatHandle) {
    try { await _lsOccupancyHeartbeatHandle.stopAndWait(); } catch(e) {}
    _lsOccupancyHeartbeatHandle = null;
  }
  _lsOccupancySessionId = null;
}

// ── 3a: Home poll ──
var _lsHomePollSeq = 0;
var _lsHomePollTimer = null;
var _lsHomePollInFlight = false;
var _lsHomePollAgain = false;
var _lsHomeRealtimeChannel = null;
var _lsHomePollCompanyId = null;
var _lsHomeLastGoodSessionIds = null; // null until the first fully-valid successful cycle

function _lsHomePollStart(){
  var companyId = _lsGetActiveCompanyId();
  if (!companyId) return;
  // Idempotent — re-entering Home repeatedly must not stack duplicate
  // intervals/channels.
  if (_lsHomePollTimer !== null && _lsHomePollCompanyId === companyId) return;
  _lsHomePollStop();
  _lsHomePollCompanyId = companyId;
  _lsHomeLastGoodSessionIds = null;
  _lsHomePollSeq++;
  var seq = _lsHomePollSeq;
  var client = _lsGetClient();
  if (client) {
    try {
      _lsHomeRealtimeChannel = client.channel('ls-home-'+companyId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'mt_sessions', filter: 'company_id=eq.'+companyId }, function(){
          // Never interprets the payload — any change is just a "go poll
          // now" nudge, debounced against duplicate messages (confirmed
          // live in an earlier round: a single save can produce several).
          _lsHomeScheduleTick(seq, 500);
        })
        .subscribe();
    } catch(e) { console.warn('[live-sync] home realtime subscribe failed:', e); }
  }
  _lsHomeScheduleTick(seq, 0);
}

function _lsHomePollStop(){
  _lsHomePollSeq++; // invalidates any in-flight cycle immediately
  if (_lsHomePollTimer) { clearTimeout(_lsHomePollTimer); _lsHomePollTimer = null; }
  if (_lsHomeRealtimeChannel) {
    try { _lsHomeRealtimeChannel.unsubscribe(); } catch(e) {}
    _lsHomeRealtimeChannel = null;
  }
  _lsHomePollCompanyId = null;
  _lsHomeLastGoodSessionIds = null;
  _lsHomePollInFlight = false;
  _lsHomePollAgain = false;
}

function _lsHomeScheduleTick(seq, ms){
  if (seq !== _lsHomePollSeq) return;
  if (_lsHomePollTimer) clearTimeout(_lsHomePollTimer);
  _lsHomePollTimer = setTimeout(function(){ _lsHomeRunPollTick(seq); }, ms);
}

async function _lsHomeRunPollTick(seq){
  if (seq !== _lsHomePollSeq) return;
  if (_lsHomePollInFlight) { _lsHomePollAgain = true; return; }
  _lsHomePollInFlight = true;
  try {
    await _lsHomeRunOnePollCycle(seq);
  } finally {
    _lsHomePollInFlight = false;
    if (seq === _lsHomePollSeq) {
      if (_lsHomePollAgain) { _lsHomePollAgain = false; _lsHomeScheduleTick(seq, 200); }
      else { _lsHomeScheduleTick(seq, 15000); }
    }
  }
}

function _lsValidateHomeRow(row){
  if (!row || !row.id) return false;
  if (row.is_shared === undefined || row.is_shared === null) return false;
  if (!row.user_id) return false;
  if (!row.company_id) return false;
  return true;
}

// Metadata-only merge — never touches an entry's snapshot at all (preserves
// whatever's cached, which this poll never had in the first place; a resume
// fetches content fresh per Phase 3b). Only overwrites cached meta if the
// incoming saved_at is genuinely newer — protects a resume's just-fetched
// fresh copy (or another in-flight write) from being immediately clobbered.
function _lsMergeHomeMetaEntry(row){
  try {
    var key = _SS_PREFIX + row.id;
    var raw = localStorage.getItem(key);
    var existing = raw ? JSON.parse(raw) : null;
    var existingMeta = (existing && existing.meta) ? existing.meta : null;
    var existingSnapshot = (existing && existing.snapshot) ? existing.snapshot : {};
    var incomingSavedAt = row.saved_at ? new Date(row.saved_at).getTime() : Date.now();
    if (existingMeta && existingMeta.savedAt && existingMeta.savedAt >= incomingSavedAt) return;

    var meta = {
      id: row.id,
      name: row.name || 'Session',
      productName: row.product_name || '',
      // v9.13.01: real product FK, requires product_id in the explicit
      // .select() column list above (this query does not use select('*')).
      productId: row.product_id || null,
      companyName: row.company_name || '',
      productType: row.product_type || '',
      approach: row.approach || '',
      lastTab: row.last_tab || 'mm',
      lastStage: row.last_stage || '',
      // v9.15.02 — same denormalized read as every other field here; three
      // independent DB-row-to-meta mapping sites in this codebase needed
      // this identical addition (this one, sessionStoreSyncFromDB() in
      // session-store.js, and _lsResumePreFetch() below in this file).
      intakeStatus: row.intake_status || null,
      counts: row.counts || { caps:0, features:0, stories:0, sprintActive:null },
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      savedAt: incomingSavedAt,
      isShared: !!row.is_shared,
      // v9.08.04 fix: this field was missing entirely, meaning every Home
      // poll cycle silently overwrote a session's correct locally-cached
      // share_mode with nothing at all — recurring, not one-time, so this
      // was the dominant cause of view-only sessions intermittently
      // behaving as editable for non-owner collaborators.
      shareMode: row.share_mode === 'edit' ? 'edit' : 'view',
      userId: row.user_id,
      lastEditedByName: row.last_edited_by_name || '',
      activeUserId: row.active_user_id || null,
      activeAt: row.active_at ? new Date(row.active_at).getTime() : null,
      activeUserName: row.active_user_name || ''
    };
    var entry = { meta: meta, snapshot: existingSnapshot };
    localStorage.setItem(key, JSON.stringify(entry));
    if (!existing && typeof _ssAddToIndex === 'function') _ssAddToIndex(row.id);
    // v9.31 code-review fix: sessionStoreList() now reads pgt_session_meta
    // exclusively — without this, a teammate's new/renamed/re-shared session
    // discovered by this poll would update the full blob and _SS_INDEX but
    // stay invisible (or stale) on Home until an unrelated full sync ran.
    if (typeof _ssSetMetaEntry === 'function') _ssSetMetaEntry(row.id, meta);
  } catch(e) {
    console.warn('[live-sync] home meta merge failed:', e);
  }
}

async function _lsHomeRunOnePollCycle(seq){
  var companyId = _lsHomePollCompanyId;
  if (!companyId) return;
  var client = _lsGetClient();
  if (!client) return;
  try {
    var res = await client.from('mt_sessions')
      .select('id,user_id,company_id,is_shared,share_mode,name,product_name,product_id,company_name,product_type,approach,last_tab,last_stage,intake_status,counts,created_at,saved_at,last_edited_by_name,active_user_id,active_at,active_user_name')
      .eq('company_id', companyId);
    if (seq !== _lsHomePollSeq) return; // superseded while this fetch was in flight
    if (res.error) { console.warn('[live-sync] home poll query failed:', res.error.message); return; }
    var data = res.data || [];

    var activeId = (typeof _activeSessionId !== 'undefined') ? _activeSessionId : null;
    var myId = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
    var allValid = true;
    var validIds = {};
    var toMerge = [];
    data.forEach(function(row){
      if (row.id === activeId) return; // never touch the currently-active session
      if (!_lsValidateHomeRow(row)) { allValid = false; return; }
      validIds[row.id] = true;
      toMerge.push(row);
    });

    // Apply merges for every row that validated regardless of overall
    // validity — a partial merge of genuinely-good rows is safe; only
    // REMOVAL depends on the whole cycle being fully valid.
    toMerge.forEach(function(row){ _lsMergeHomeMetaEntry(row); });

    if (allValid) {
      if (_lsHomeLastGoodSessionIds !== null) {
        var localList = (typeof sessionStoreList === 'function') ? sessionStoreList() : [];
        localList.forEach(function(sess){
          if (sess.id === activeId) return;
          if (myId && sess.userId === myId) return; // never remove your own sessions via this path
          if (!validIds[sess.id]) _lsRemoveLocalSessionEntry(sess.id);
        });
      }
      _lsHomeLastGoodSessionIds = validIds;
    }

    if (typeof homeRenderSessionLibrary === 'function' && typeof curTab !== 'undefined' && curTab === 'home') {
      homeRenderSessionLibrary();
    }
  } catch(e) {
    console.warn('[live-sync] home poll cycle exception:', e);
  }
}

// ── 3b: Resume pre-fetch ──
// Called from sessionStoreRestore() (session-store.js) for cached-shared
// sessions only. Cursor fetched FIRST, snapshot SECOND — deliberate
// ordering: if new content lands in the gap between these two calls, the
// cursor was captured before it existed, so at worst the viewer sees one
// redundant "new content" banner for something they just loaded — never a
// silently-swallowed one. Reversing this order would risk exactly that.
async function _lsResumePreFetch(sessionId){
  try {
    var client = _lsGetClient();
    if (!client) return { ok: false, reason: 'error' };
    var activeCompanyId = _lsGetActiveCompanyId();
    if (!activeCompanyId) return { ok: false, reason: 'error' };

    var cursorEventId = null;
    try {
      var evRes = await client.from('mt_session_content_events').select('id').eq('session_id', sessionId).order('id', { ascending: false }).limit(1);
      if (evRes && !evRes.error && evRes.data && evRes.data.length > 0) cursorEventId = evRes.data[0].id;
    } catch(e) { /* non-fatal — cursor stays null, watch shows any/all pending on its first cycle */ }

    var res = await client.from(_SS_TABLE).select('*').eq('id', sessionId).eq('company_id', activeCompanyId).limit(1);
    if (res.error) return { ok: false, reason: 'error' };
    if (!res.data || res.data.length === 0) return { ok: false, reason: 'no-access' };
    var row = res.data[0];

    // Strict allowlist — same discipline as the Home poll merge. Hard-fail
    // rather than default any of these to blank.
    if (row.is_shared === undefined || row.is_shared === null) return { ok: false, reason: 'error' };
    if (!row.user_id) return { ok: false, reason: 'error' };

    // v9.31 code-review fix: was its own independent copy of this mapping
    // (the "three independent DB-row-to-meta mapping sites" the old comment
    // here referenced) — now calls the shared _ssRowToMeta() helper
    // (session-store.js) instead. row.user_id is truthy here (the strict
    // allowlist above already returned early otherwise), so this is
    // behaviorally identical to the old inline `userId: row.user_id`.
    var meta = _ssRowToMeta(row);
    return { ok: true, meta: meta, snapshot: row.snapshot || {}, cursorEventId: cursorEventId };
  } catch(e) {
    console.warn('[live-sync] resume pre-fetch failed:', e);
    return { ok: false, reason: 'error' };
  }
}

// ── 3c: In-session watch ──
var _lsWatchSeq = 0;
var _lsWatchSessionId = null;
var _lsWatchTimer = null;
var _lsWatchInFlight = false;
var _lsWatchZeroCount = 0;

// Build A (v8.132): cursor storage keyed by (session, canvas) — not just
// session. Found necessary via the ChatGPT critique: with per-section
// confirm/decline now possible, a single shared cursor would let a later,
// unrelated canvas's applied event silently hide an earlier, DECLINED
// event on a different canvas from all future polls (since a poll only
// ever asks for id > cursor). Each canvas's own accept/decline history now
// stays fully independent.
function _lsCursorStorageKey(sessionId, canvas){ return 'ls_cursor_' + sessionId + '_' + canvas; }
function _lsGetSeenCursor(sessionId, canvas){
  try { var v = sessionStorage.getItem(_lsCursorStorageKey(sessionId, canvas)); return v ? parseInt(v, 10) : 0; }
  catch(e) { return 0; }
}
function _lsSetSeenCursor(sessionId, canvas, eventId){
  try {
    if (eventId == null) return;
    var cur = _lsGetSeenCursor(sessionId, canvas);
    if (eventId > cur) sessionStorage.setItem(_lsCursorStorageKey(sessionId, canvas), String(eventId));
  } catch(e) {}
}
// All canvases currently emitting content events — used to seed every
// canvas's cursor together on resume (a resume's fresh fetch genuinely
// catches the viewer up on everything, not just one canvas) and to iterate
// consistently everywhere else a canvas list is needed.
// v8.151 fix: 'sc'/'pc' added — omitted here since Build B first introduced
// them as live-sync canvases, causing this array (resume cursor-seeding
// only; confirmed sole use site) to never advance their cursors on resume,
// so every poll after a resume re-flagged already-caught-up sc/pc content
// as new, repeating indefinitely.
var _LS_ALL_CANVASES = ['cc','mm','pi','mi','la','sc','pc'];

function _lsSessionWatchStart(sessionId, seedCursorEventId){
  if (!sessionId) return;
  _lsSessionWatchStop(); // tears down any previous watch first (bumps seq)
  _lsWatchSessionId = sessionId;
  _lsWatchZeroCount = 0;
  if (seedCursorEventId != null) {
    _LS_ALL_CANVASES.forEach(function(c){ _lsSetSeenCursor(sessionId, c, seedCursorEventId); });
  }
  var seq = _lsWatchSeq;
  _lsWatchScheduleTick(seq, 0);
}

function _lsSessionWatchStop(){
  _lsWatchSeq++; // invalidates any in-flight tick or banner-refresh tied to the old seq
  if (_lsWatchTimer) { clearTimeout(_lsWatchTimer); _lsWatchTimer = null; }
  _lsWatchSessionId = null;
  _lsWatchZeroCount = 0;
  _lsWatchInFlight = false;
  if (typeof _lsHideContentBanner === 'function') _lsHideContentBanner();
}

function _lsWatchScheduleTick(seq, ms){
  if (seq !== _lsWatchSeq) return;
  if (_lsWatchTimer) clearTimeout(_lsWatchTimer);
  _lsWatchTimer = setTimeout(function(){ _lsWatchRunTick(seq); }, ms);
}

async function _lsWatchRunTick(seq){
  if (seq !== _lsWatchSeq || !_lsWatchSessionId) return;
  if (_lsWatchInFlight) return; // skip this tick; the next scheduled one will pick up
  _lsWatchInFlight = true;
  var sessionId = _lsWatchSessionId;
  try {
    await _lsWatchRunOneCycle(seq, sessionId);
  } finally {
    _lsWatchInFlight = false;
    if (seq === _lsWatchSeq && _lsWatchSessionId === sessionId) {
      _lsWatchScheduleTick(seq, 10000);
    }
  }
}

async function _lsWatchRunOneCycle(seq, sessionId){
  var client = _lsGetClient();
  if (!client) return;
  var companyId = _lsGetActiveCompanyId();
  var results = await Promise.allSettled([
    client.from('mt_sessions').select('id,name').eq('id', sessionId).eq('company_id', companyId),
    client.from('mt_session_content_events').select('id,canvas,event_type,metric_key,cap_name,generated_by,generated_by_name,created_at').eq('session_id', sessionId).eq('company_id', companyId).order('id', { ascending: false }).limit(20)
  ]);
  if (seq !== _lsWatchSeq || _lsWatchSessionId !== sessionId) return; // superseded during the fetch

  var visSettled = results[0];
  var evSettled = results[1];

  // Visibility/kickout check FIRST — wins over content if both fire in the
  // same cycle. Only a query that completed WITHOUT error counts toward the
  // threshold; an error leaves the counter untouched (never increments,
  // never resets) — a network blip must not eject an active user.
  var _stillVisible = false;
  if (visSettled.status === 'fulfilled' && !visSettled.value.error) {
    if (visSettled.value.data && visSettled.value.data.length > 0) {
      _lsWatchZeroCount = 0;
      _stillVisible = true;
    } else {
      _lsWatchZeroCount++;
      if (_lsWatchZeroCount >= 2) {
        _lsTriggerKickout(sessionId);
        return;
      }
    }
  }

  // Build A (v8.132): rename-sync. Rides the same poll as the kickout check
  // — deliberately no event row, no confirm, no per-canvas cursor. A
  // display name is not a viewer's own unsaved work the way generated
  // content is, so there's nothing to protect against overwriting. Runs
  // only if kickout did NOT fire this cycle (kickout dominates). Skips if
  // a rename input is currently open/focused (per the ChatGPT critique —
  // reuses the exact same "don't clobber an open edit" principle already
  // built for CC's capability editing, applied to the header's rename
  // input instead), and updates both the header DOM and the local cache
  // entry together so Home's own session card doesn't go stale.
  if (_stillVisible && visSettled.value.data[0].name) {
    var _freshName = visSettled.value.data[0].name;
    var _openInput = document.querySelector('input.hdr-session-name-input');
    if (!_openInput) {
      try {
        var _raw = localStorage.getItem(_SS_PREFIX + sessionId);
        var _cachedName = null;
        if (_raw) { var _cached = JSON.parse(_raw); _cachedName = _cached && _cached.meta && _cached.meta.name; }
        if (_cachedName !== _freshName) {
          if (typeof hdrSetSessionName === 'function' && typeof _activeSessionId !== 'undefined' && _activeSessionId === sessionId) {
            hdrSetSessionName(_freshName);
          }
          if (_raw) {
            var _entry = JSON.parse(_raw);
            _entry.meta.name = _freshName;
            localStorage.setItem(_SS_PREFIX + sessionId, JSON.stringify(_entry));
          }
        }
      } catch(e) { /* non-fatal — name sync just skips this cycle, retried next tick */ }
    }
  }

  if (evSettled.status !== 'fulfilled' || evSettled.value.error) {
    console.warn('[live-sync] watch event fetch failed:', evSettled.reason || (evSettled.value && evSettled.value.error));
    return;
  }
  var rows = evSettled.value.data || [];
  if (rows.length === 0) return;

  var myId = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : null;
  // Build A: per-canvas cursor — an event is pending only relative to ITS
  // OWN canvas's cursor, not one shared value (see cursor rewrite above).
  var pending = rows.filter(function(r){
    var _cursor = _lsGetSeenCursor(sessionId, r.canvas);
    return r.id > _cursor && r.generated_by !== myId;
  });
  if (pending.length === 0) return;
  // Fetched newest-first (so LIMIT keeps the most recent N); applying must
  // go oldest-first, since a features_generated event for a brand-new
  // capability must be applied AFTER the capabilities_generated event that
  // introduced it, if both are pending in the same refresh.
  pending.sort(function(a,b){ return a.id - b.id; });

  // v8.150 fix (Issue 2, corrected): confirmed via live testing that the
  // first attempt at this fix keyed off the banner's own visible state
  // (_lsBannerCurrentEvents), which is cleared both by a genuine apply
  // AND by the user simply dismissing the banner via its own close
  // button — meaning dismissal alone would have made this look like
  // "nothing pending," reintroducing the exact stale-overwrite bug this
  // exists to prevent. This is a separate, dedicated flag: set here,
  // whenever the poll discovers unapplied changes, and cleared only in
  // _lsBannerRefreshClick once a real apply genuinely succeeds — the
  // banner's own show/hide/dismiss lifecycle never touches this.
  _lsUnappliedRemoteChanges[sessionId] = true;

  if (typeof _lsShowContentBanner === 'function') _lsShowContentBanner(sessionId, pending);
}

// ── 3e: Unshare kickout ──
function _lsTriggerKickout(sessionId){
  // Best-effort attribution only — RLS has already hidden the row by this
  // point, so the DB can't be asked who unshared it. Falls back to whatever
  // was cached locally before access was lost; generic copy otherwise.
  var _lastKnownName = '';
  var _sessionName = '';
  try {
    var raw = localStorage.getItem(_SS_PREFIX + sessionId);
    if (raw) {
      var cached = JSON.parse(raw);
      _lastKnownName = (cached && cached.meta && cached.meta.lastEditedByName) || '';
      _sessionName = (cached && cached.meta && cached.meta.name) || '';
    }
  } catch(e) {}

  _lsSessionWatchStop(); // bumps seq FIRST — invalidates any in-flight banner refresh before anything else happens

  // Remove the now-inaccessible session from local cache immediately —
  // otherwise it lingers on Home until the next poll cycle happens to
  // notice it's gone, which is exactly the stale-card gap found in testing.
  _lsRemoveLocalSessionEntry(sessionId);

  // Fix (v8.127): homeClearSession()'s own save-before-clear step
  // unconditionally attempts to save whatever _activeSessionId currently
  // is — which, at this point, is still the session that just became
  // inaccessible. That save is doomed (RLS now rejects it, confirmed live
  // via a 403 in testing) and was firing every time. Clearing this here,
  // BEFORE calling homeClearSession(), makes its own guard condition skip
  // that attempt entirely — homeClearSession() itself is untouched again,
  // no further edit to the sacred function needed.
  //
  // v14 code-review fix: this null-out is exactly the pattern that starves
  // homeClearSession()'s own occupancy-release capture of the real session
  // id (the same bug already fixed once for home.js's homeSessionDeleteConfirm(),
  // which is why homeClearSession() now takes an optional p_releaseSessionId
  // parameter) — this call site was missed. sessionId (this function's own
  // parameter) is passed through explicitly below instead of relying on the
  // global, which by then is already null.
  _activeSessionId = null;
  _activeSessionIsShared = false;

  var _name = _lastKnownName || 'A teammate';
  var _safeName = (typeof e === 'function') ? e(_name) : _name;
  var _safeSessionName = (typeof e === 'function') ? e(_sessionName) : _sessionName;
  var _sessLabel = _safeSessionName ? ('"'+_safeSessionName+'"') : 'This session';
  if (typeof showToast === 'function') {
    showToast(_safeName + ' unshared ' + _sessLabel + '. You no longer have access. Any unsaved changes here could not be saved.', 'warn');
  }
  if (typeof homeClearSession === 'function') homeClearSession(sessionId);
  if (typeof switchTab === 'function') switchTab('home');
  if (typeof homeRenderSessionLibrary === 'function') homeRenderSessionLibrary();
}

// ── 3d: Content banner + targeted refresh ──
var _lsBannerRefreshInFlight = false;
// v8.150 (Issue 2, corrected): dedicated tracking for "does this session
// have remote changes this browser hasn't genuinely applied yet" —
// deliberately separate from _lsBannerCurrentSessionId/_lsBannerCurrentEvents
// below, which are cleared by mere dismissal and are NOT a safe signal for
// this purpose (confirmed via live testing of the first attempt at this fix).
var _lsUnappliedRemoteChanges = {}; // sessionId -> true

// Checked by homeClearSession() before its own content-save line — true if
// either this session has known unapplied remote changes, or this browser
// itself has its own genuinely unflushed local edits pending (the manual-
// edit batching mechanism's own dirty-target tracking, reused here rather
// than duplicated) — either case means the local in-memory snapshot isn't
// safe to trust as authoritative to save over the database.
function _lsSessionMightBeUnsafeToOverwrite(sessionId){
  if (!sessionId) return false;
  if (_lsUnappliedRemoteChanges[sessionId]) return true;
  if (typeof _lsManualEditState !== 'undefined') {
    var areas = ['pi', 'cc', 'sc', 'pc'];
    for (var i = 0; i < areas.length; i++) {
      var key = sessionId + '::' + areas[i];
      var state = _lsManualEditState[key];
      if (state && state.dirtyTargets && state.dirtyTargets.size > 0) return true;
    }
  }
  return false;
}

var _lsBannerCurrentSessionId = null;
var _lsBannerCurrentEvents = null;

function _lsHideContentBanner(){
  var el = document.getElementById('ls-content-banner');
  if (el) el.classList.remove('on');
  _lsBannerCurrentSessionId = null;
  _lsBannerCurrentEvents = null;
}

function _lsShowContentBanner(sessionId, pendingEvents){
  _lsBannerCurrentSessionId = sessionId;
  _lsBannerCurrentEvents = pendingEvents;
  var names = {};
  pendingEvents.forEach(function(ev){ if (ev.generated_by_name) names[ev.generated_by_name] = true; });
  var who = Object.keys(names)[0] || 'A teammate';
  var sessionName = '';
  try {
    var raw = localStorage.getItem(_SS_PREFIX + sessionId);
    if (raw) { var cached = JSON.parse(raw); sessionName = (cached && cached.meta && cached.meta.name) || ''; }
  } catch(e) {}
  var _safeWho = (typeof e === 'function') ? e(who) : who;
  var _safeSessionName = (typeof e === 'function') ? e(sessionName) : sessionName;
  var _label = _safeSessionName ? (' in "' + _safeSessionName + '"') : '';
  var msg = _safeWho + ' has generated new information' + _label + '. Click Refresh to see it.';

  var el = document.getElementById('ls-content-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ls-content-banner';
    el.className = 'ls-content-banner';
    document.body.appendChild(el);
  }
  el.innerHTML = '<span class="ls-content-banner-msg">' + msg + '</span>'
    + '<button class="ls-content-banner-refresh" onclick="_lsBannerRefreshClick()">Refresh</button>'
    + '<button class="ls-content-banner-close" onclick="_lsHideContentBanner()" aria-label="Dismiss">&#x2715;</button>';
  el.classList.add('on');
}

// Checks whether an edit field for the SPECIFIC capability an incoming
// event targets is currently open/uncommitted in the DOM. The feature
// name/why edit inputs share one class regardless of which field; this
// only needs to know if the panel currently open is showing the exact
// capability about to be overwritten, not which specific field within it.
function _lsHasOpenEditForCapability(metricKey, capName){
  try {
    var openInput = document.querySelector('.cc-feat-name-input');
    if (!openInput) return false;
    if (typeof capActiveMetricKey === 'undefined' || capActiveMetricKey !== metricKey) return false;
    if (typeof capStore === 'undefined' || !capStore[metricKey]) return false;
    var capIdx = (typeof capActiveCapIdx !== 'undefined') ? capActiveCapIdx : null;
    if (capIdx === null || capIdx === undefined) return false;
    var cap = capStore[metricKey].capabilities && capStore[metricKey].capabilities[capIdx];
    if (!cap || !cap.name) return false;
    return cap.name.toLowerCase().trim() === (capName || '').toLowerCase().trim();
  } catch(e) { return false; }
}

// v8.146 (Build B): conservative analog for Story Canvas — no single
// "open input" element to check the way CC has, so this checks whether
// the SC panel is currently open for the exact target (the feature, for
// a coarse event; the specific story, for a surgical one) rather than
// inspecting individual field values.
function _lsHasOpenEditForStory(featureId, storyId){
  try {
    if (typeof newScPanelFeatId === 'undefined' || typeof newScPanelStoryId === 'undefined') return false;
    if (!storyId) return newScPanelFeatId === featureId;
    return newScPanelFeatId === featureId && newScPanelStoryId === storyId;
  } catch(e) { return false; }
}

// Applies a batch of CC events against a freshly-fetched snapshot. Groups by
// (metric_key, cap_name) so multiple events pointing at the same target
// apply once. capabilities_generated replaces the whole metric's capability
// list (safe — that event type means the WHOLE list changed, no positional-
// index concern). features_generated requires EXACTLY ONE name match on
// BOTH the local and freshly-fetched side (capability names aren't
// enforced-unique in this app) before touching anything — aborts that one
// target otherwise, never guesses. Normalizes names the same way this app's
// OWN existing capability-dedup logic already does, for consistency.
function _lsApplyCCEvents(freshSnapshot, events){
  var appliedAny = false;
  var failedCount = 0;
  var descriptions = [];
  var panelShouldClose = false;
  if (!freshSnapshot || !freshSnapshot.capStore || typeof capStore === 'undefined') {
    return { appliedAny: false, failedCount: events.length, descriptions: [], panelShouldClose: false };
  }
  // v8.142 (item 2): 'capability_manually_updated' and 'feature_manually_updated'
  // route through the exact same matching logic already proven correct for
  // the AI-generated case — only the description wording differs. Where
  // both a real generation and a manual-edit event are pending for the SAME
  // target, the generation's wording wins (matching the same "regenerated
  // dominates manually updated" precedent already established for PI) —
  // determined here in a first pass, since whichever event happens to sort
  // first in the array shouldn't decide the wording.
  var targetHasGenerated = {};
  events.forEach(function(ev){
    if (ev.event_type === 'capabilities_generated' || ev.event_type === 'features_generated') {
      targetHasGenerated[ev.metric_key + _LS_CC_TARGET_SEP + (ev.cap_name || '')] = true;
    }
  });
  var seenTargets = {};
  events.forEach(function(ev){
    var targetKey = ev.metric_key + _LS_CC_TARGET_SEP + (ev.cap_name || '');
    if (seenTargets[targetKey]) return;
    seenTargets[targetKey] = true;
    var isManual = (ev.event_type === 'capability_manually_updated' || ev.event_type === 'feature_manually_updated');
    var preferGeneratedWording = targetHasGenerated[targetKey];

    var localEntry = capStore[ev.metric_key];
    var freshEntry = freshSnapshot.capStore[ev.metric_key];
    if (!freshEntry) { failedCount++; return; }
    var metricLabel = freshEntry.metricName || localEntry && localEntry.metricName || ev.metric_key;

    if (!localEntry) {
      capStore[ev.metric_key] = freshEntry;
      appliedAny = true;
      descriptions.push("Capabilities added for '" + metricLabel + "'");
      return;
    }

    var isWholeListEvent = (ev.event_type === 'capabilities_generated' || ev.event_type === 'capability_manually_updated');
    if (isWholeListEvent) {
      if (typeof capActiveMetricKey !== 'undefined' && capActiveMetricKey === ev.metric_key
          && typeof capActiveCapIdx !== 'undefined' && capActiveCapIdx !== null) {
        panelShouldClose = true;
      }
      capStore[ev.metric_key].capabilities = freshEntry.capabilities;
      appliedAny = true;
      descriptions.push(
        (isManual && !preferGeneratedWording)
          ? (ev.generated_by_name || 'A teammate') + " updated capabilities for '" + metricLabel + "'"
          : "Capabilities updated for '" + metricLabel + "'"
      );
      return;
    }

    var targetName = (ev.cap_name || '').toLowerCase().trim();
    var localMatches = (localEntry.capabilities || []).filter(function(c){ return c.name && c.name.toLowerCase().trim() === targetName; });
    var freshMatches = (freshEntry.capabilities || []).filter(function(c){ return c.name && c.name.toLowerCase().trim() === targetName; });
    if (localMatches.length > 1 || freshMatches.length !== 1) {
      failedCount++;
      // v8.143: kept permanently, lighter than the throwaway debug build
      // that found the delimiter bug — enough to diagnose a real future
      // failure from a normal build's console, without needing a special
      // debug variant each time this safety check aborts.
      console.warn('[live-sync] CC apply could not safely match this target', {
        event_type: ev.event_type, metric_key: ev.metric_key, cap_name: ev.cap_name,
        localMatchCount: localMatches.length, freshMatchCount: freshMatches.length
      });
      return;
    }
    var _featDesc = (isManual && !preferGeneratedWording)
      ? (ev.generated_by_name || 'A teammate') + " updated features for '" + (ev.cap_name || '') + "'"
      : "Features added to '" + (ev.cap_name || '') + "'";
    if (localMatches.length === 0) {
      localEntry.capabilities = localEntry.capabilities || [];
      localEntry.capabilities.push(freshMatches[0]);
      appliedAny = true;
      descriptions.push(_featDesc);
      return;
    }
    localMatches[0].featStore = freshMatches[0].featStore;
    appliedAny = true;
    descriptions.push(_featDesc);
  });
  return { appliedAny: appliedAny, failedCount: failedCount, descriptions: descriptions, panelShouldClose: panelShouldClose };
}

function _lsCanvasLabel(canvas){
  var labels = { cc: 'Capability Canvas', mm: 'Discovery Map', pi: 'Release Canvas', mi: 'Market Intelligence', la: 'Diagnostics', sc: 'Story Canvas', pc: 'Prototype Canvas' };
  return labels[canvas] || canvas;
}

// v8.146 (Build B): Story Canvas apply. scCanvas is a flat array of
// feature-entries, each owning its own .stories array — a coarse target
// (metric_key=featureId, cap_name=null/empty) means "this feature's whole
// canvas entry should be re-synced": insert if new locally, replace if
// present, remove locally if it no longer exists in the fresh snapshot.
// This single rule deliberately covers CC's send-to-SC/remove-from-SC
// actions, AI story generation, and story add/delete — all of them
// collapse to "this feature's entry changed or is gone," confirmed
// correct via external design critique before building. A surgical target
// (cap_name=storyId) patches one story in place by direct ID lookup — story
// IDs are globally unique by construction (an incrementing counter), so
// no exact-match-or-abort ambiguity check is needed the way CC's
// name-based capability matching required, though existence/membership is
// still validated before patching, not assumed.
function _lsApplySCEvents(freshSnapshot, events){
  var appliedAny = false;
  var failedCount = 0;
  var descriptions = [];
  var panelShouldClose = false;
  var _scAnyCoarseApplied = false;
  if (!freshSnapshot || !Array.isArray(freshSnapshot.scCanvas) || typeof scCanvas === 'undefined') {
    return { appliedAny: false, failedCount: events.length, descriptions: [], panelShouldClose: false };
  }
  // Canonicalization: a coarse target for a feature subsumes any surgical
  // targets for stories under that same feature — same principle as CC's.
  var coarseFeatureIds = {};
  events.forEach(function(ev){ if (!ev.cap_name) coarseFeatureIds[ev.metric_key] = true; });
  var targetHasGenerated = {};
  events.forEach(function(ev){
    if (ev.event_type === 'stories_generated') targetHasGenerated[ev.metric_key + '||' + (ev.cap_name || '')] = true;
  });
  var seenTargets = {};
  events.forEach(function(ev){
    var featureId = ev.metric_key;
    var storyId = ev.cap_name || null;
    if (storyId && coarseFeatureIds[featureId]) return; // subsumed, skip
    var targetKey = featureId + '||' + (storyId || '');
    if (seenTargets[targetKey]) return;
    seenTargets[targetKey] = true;
    var isManual = (ev.event_type === 'feature_stories_manually_updated' || ev.event_type === 'story_manually_updated');
    var preferGeneratedWording = targetHasGenerated[targetKey];
    // v8.148 fix: every description now names the actual person (falling
    // back to "A teammate" only if genuinely uncaptured) and the specific
    // feature/story affected — confirmed this was silently missing from
    // every Build B description, a regression of the same fix already
    // made once for CC/PI in v8.144, never carried over to this new code.
    var _who = ev.generated_by_name || 'A teammate';

    var freshEntry = null;
    for (var fi = 0; fi < freshSnapshot.scCanvas.length; fi++) { if (freshSnapshot.scCanvas[fi].id === featureId) { freshEntry = freshSnapshot.scCanvas[fi]; break; } }
    var localIdx = scCanvas.findIndex(function(f){ return f.id === featureId; });

    if (!storyId) {
      // Coarse: insert-or-replace-or-remove based on presence in the fresh snapshot.
      if (freshEntry) {
        var _wasNewLocally = (localIdx < 0);
        if (localIdx >= 0) { scCanvas[localIdx] = freshEntry; } else { scCanvas.push(freshEntry); }
        appliedAny = true;
        _scAnyCoarseApplied = true;
        if (typeof pcMarkStale === 'function') pcMarkStale(featureId);
        if (typeof newScPanelFeatId !== 'undefined' && newScPanelFeatId === featureId) panelShouldClose = true;
        var _featName = freshEntry.name || 'a feature';
        // v8.149 fix (D8 copy): a genuinely new feature reads "added",
        // not "updated" — confirmed via live testing that the previous
        // wording was misleading for a first-time addition (e.g. sending
        // a Diagnostics experiment to Feature Canvas for the first time).
        if (isManual && !preferGeneratedWording) {
          descriptions.push(_wasNewLocally ? (_who + " added '" + _featName + "' to Story Canvas") : (_who + " updated '" + _featName + "' on Story Canvas"));
        } else {
          descriptions.push(_wasNewLocally ? ("'" + _featName + "' added with generated stories") : ("Stories generated for '" + _featName + "'"));
        }
      } else {
        if (localIdx >= 0) {
          var _removedName = scCanvas[localIdx].name || 'A feature';
          scCanvas.splice(localIdx, 1);
          appliedAny = true;
          _scAnyCoarseApplied = true;
          if (typeof newScPanelFeatId !== 'undefined' && newScPanelFeatId === featureId) panelShouldClose = true;
          descriptions.push(_who + " removed '" + _removedName + "' from Story Canvas");
        }
        // else: nothing locally and nothing fresh — no-op, not a failure.
      }
      return;
    }

    // Surgical: validate existence/membership before patching — unique
    // IDs remove name-collision risk, not the need to check the target
    // is genuinely what it claims to be.
    if (!freshEntry) { failedCount++; return; }
    var localEntry = (localIdx >= 0) ? scCanvas[localIdx] : null;
    if (!localEntry) {
      // Local doesn't have this feature at all — the coarse "feature
      // added" event should logically precede this, but if it hasn't
      // landed yet, insert the whole fresh feature now rather than fail.
      scCanvas.push(freshEntry);
      appliedAny = true;
      _scAnyCoarseApplied = true;
      if (typeof pcMarkStale === 'function') pcMarkStale(featureId);
      descriptions.push(_who + " updated '" + (freshEntry.name || 'a feature') + "' on Story Canvas");
      return;
    }
    var freshStory = (freshEntry.stories || []).find(function(s){ return s.id === storyId; });
    var localStoryIdx = (localEntry.stories || []).findIndex(function(s){ return s.id === storyId; });
    if (freshStory) {
      if (!localEntry.stories) localEntry.stories = [];
      if (localStoryIdx >= 0) { localEntry.stories[localStoryIdx] = freshStory; } else { localEntry.stories.push(freshStory); }
    } else {
      if (localStoryIdx >= 0) localEntry.stories.splice(localStoryIdx, 1);
    }
    appliedAny = true;
    if (typeof pcMarkStale === 'function') pcMarkStale(featureId);
    if (typeof newScPanelStoryId !== 'undefined' && newScPanelStoryId === storyId && !freshStory) panelShouldClose = true;
    descriptions.push((isManual && !preferGeneratedWording)
      ? _who + " updated story " + storyId
      : "Story " + storyId + " updated");
  });
  // v8.148 fix (D8): a coarse apply can add or remove a feature whose
  // origin is a Diagnostics experiment (diagnosticContext travels with the
  // feature entry itself) — Diagnostics' own "sent" indicator is a
  // derived cache rebuilt from scCanvas, not synced independently, so it
  // needs an explicit rebuild here or it silently stays stale for a
  // receiving viewer even though scCanvas itself is now correct.
  if (_scAnyCoarseApplied && typeof laRebuildSentIdsFromCanvas === 'function') {
    laRebuildSentIdsFromCanvas();
    if (typeof curTab !== 'undefined' && curTab === 'la') {
      if (typeof laRefreshTable === 'function') laRefreshTable();
      if (typeof laUpdateSentCounter === 'function') laUpdateSentCounter();
      if (typeof laUpdateSendBtn === 'function') laUpdateSendBtn();
    }
  }
  return { appliedAny: appliedAny, failedCount: failedCount, descriptions: descriptions, panelShouldClose: panelShouldClose };
}

// v8.146 (Build B): Prototype Canvas apply. protoStore is flat — one
// record per feature, keyed directly by feature ID, no nesting — so no
// coarse/surgical split is needed, just insert-or-replace-or-remove based
// on presence in the fresh snapshot, same underlying rule as SC's coarse
// case, just without a parent/child distinction to worry about.
function _lsApplyPCEvents(freshSnapshot, events){
  var appliedAny = false;
  var failedCount = 0;
  var descriptions = [];
  if (!freshSnapshot || !freshSnapshot.protoStore || typeof protoStore === 'undefined') {
    return { appliedAny: false, failedCount: events.length, descriptions: [], panelShouldClose: false };
  }
  // v8.148 fix: protoStore has no human-readable name of its own — look
  // the feature's name up from scCanvas (fresh snapshot first, falling
  // back to local) so the description can name what was actually changed.
  function _lsFeatureNameFor(featureId){
    var src = (freshSnapshot && Array.isArray(freshSnapshot.scCanvas)) ? freshSnapshot.scCanvas : null;
    if (src) { for (var i = 0; i < src.length; i++) { if (src[i].id === featureId) return src[i].name || null; } }
    if (typeof scCanvas !== 'undefined') { var localMatch = scCanvas.find(function(f){ return f.id === featureId; }); if (localMatch) return localMatch.name || null; }
    return null;
  }
  var seenFeatureIds = {};
  events.forEach(function(ev){
    var featureId = ev.metric_key;
    if (seenFeatureIds[featureId]) return;
    seenFeatureIds[featureId] = true;
    var isManual = (ev.event_type === 'prototype_manually_updated');
    var _who = ev.generated_by_name || 'A teammate';
    var _featName = _lsFeatureNameFor(featureId) || 'a feature';
    var freshEntry = freshSnapshot.protoStore[featureId];
    if (freshEntry) {
      protoStore[featureId] = freshEntry;
      appliedAny = true;
      descriptions.push(isManual ? (_who + " updated the prototype for '" + _featName + "'") : ("Prototype generated for '" + _featName + "'"));
    } else if (protoStore[featureId]) {
      delete protoStore[featureId];
      appliedAny = true;
      descriptions.push(_who + " removed the prototype for '" + _featName + "'");
    }
  });
  // v8.147 fix: freshEntry comes straight from the raw snapshot, where
  // wireframe HTML is stored LZString-compressed — never decompressed
  // until now. Confirmed this was the exact cause of "Wireframe not
  // available" after a live apply. Reuses the same shared, pure function
  // sessionStoreRestore() itself now calls, so this can't drift out of
  // sync with that path a second time.
  if (appliedAny && typeof _ssDecompressProtoStoreWireframes === 'function') {
    _ssDecompressProtoStoreWireframes(protoStore);
  }
  return { appliedAny: appliedAny, failedCount: failedCount, descriptions: descriptions, panelShouldClose: false };
}

// ── Item 8 / Item 2: manual-edit batching/notification ──
// Generic across "areas". 'pi' uses a single sentinel target ('__whole__')
// since there's only one plan per session. 'cc' uses real per-target keys
// (metricKey + '||' + capName, capName empty for a whole-capability-list
// change) since CC has an unbounded number of independent capabilities —
// a single flag would force every edit to look like "the whole canvas
// changed," discarding the same narrow-blast-radius property CC's
// existing apply logic was specifically built to have.
//
// Every point below reflects a specific finding from one of two external
// critique rounds before this was built, not just the original sketch:
// - Snapshot-then-diff on flush, never a blind clear() of the live dirty
//   set — the snapshot is removed from the set synchronously, before any
//   async work starts, so anything added WHILE a flush is in flight stays
//   dirty and gets its own subsequent flush, never silently dropped.
// - Per-target success/failure tracking on flush — if one target's emit
//   fails while others succeed, only the failed ones are re-added to the
//   dirty set, not the whole batch.
// - Ceiling timer starts only once, when the dirty set first goes from
//   empty to non-empty, and is never reset by later edits — otherwise
//   continuous editing could postpone notification indefinitely. Idle
//   timer resets on every edit.
// - Canonicalization before emit (CC only): a whole-capability-list
//   target subsumes any feature-level targets under that same metric —
//   dropped as redundant, not re-emitted separately.
// - Dirty is only cleared after a successful emit, never before.
// v8.143 fix: confirmed via live debug output that '||' collides with
// composite key formats this app already uses internally in at least two
// places — ccPanelCapKey's own reconstruction fallback, and ccPIKey()'s
// own 'pi||'-prefixed format — meaning a metric key can legitimately
// already contain '||' before this code ever touches it, corrupting the
// target string's intended metricKey/capName boundary. \u001F (ASCII Unit
// Separator) is a non-printable control character specifically designed
// for this purpose — never typed, never AI-generated as part of ordinary
// text, confirmed unused anywhere else in this codebase before adopting
// it here. Never sent to the database — only used for this transient,
// in-memory target-string bookkeeping.
var _LS_CC_TARGET_SEP = '\u001F';
// v8.146 (Build B): reuses the same non-printable separator for Story
// Canvas targets (featureId + sep + storyId, empty storyId = coarse
// whole-feature-entry target) — same collision-safety reasoning as CC's.
var _LS_SC_TARGET_SEP = '\u001F';
var _LS_MANUAL_EDIT_AREAS = { pi: true, cc: true, sc: true, pc: true };
var _LS_MANUAL_EDIT_IDLE_MS = 25 * 1000;
var _LS_MANUAL_EDIT_CEILING_MS = 5 * 60 * 1000;
var _lsManualEditState = {}; // key: sessionId + '::' + area

function _lsManualEditKey(sessionId, area){ return sessionId + '::' + area; }

function _lsGetManualEditState(sessionId, area){
  var key = _lsManualEditKey(sessionId, area);
  if (!_lsManualEditState[key]) {
    _lsManualEditState[key] = { sessionId: sessionId, area: area, dirtyTargets: new Set(), flushing: false, paused: false, idleTimer: null, ceilingTimer: null };
  }
  return _lsManualEditState[key];
}

// Called by a manual-edit function's save callback, only once that save
// has actually resolved successfully — see the .then() wiring at each
// call site, not called directly from the edit function's own top level.
// target is optional — omitted (or '__whole__') for 'pi', required for
// 'cc' (a "metricKey||capName" string, capName '' for a whole-list change).
function _lsMarkManualEdit(area, target){
  // v8.148: lightweight, permanent diagnostic logging — kept on purpose,
  // not a throwaway debug addition. A manual edit producing zero live
  // notification with no visible error is exactly the failure mode that's
  // hardest to diagnose after the fact; this makes it visible directly
  // from a normal build's console.
  if (typeof _activeSessionIsShared === 'undefined' || !_activeSessionIsShared) { return; }
  if (typeof _isDemoSession !== 'undefined' && _isDemoSession) { return; }
  if (typeof _activeSessionId === 'undefined' || !_activeSessionId) { return; }
  if (!_LS_MANUAL_EDIT_AREAS[area]) { return; }
  var state = _lsGetManualEditState(_activeSessionId, area);
  if (state.paused) { return; }
  state.dirtyTargets.add(target || '__whole__');
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(function(){ _lsFlushManualEditNotification(state.sessionId, area); }, _LS_MANUAL_EDIT_IDLE_MS);
  if (!state.ceilingTimer) {
    state.ceilingTimer = setTimeout(function(){ _lsFlushManualEditNotification(state.sessionId, area); }, _LS_MANUAL_EDIT_CEILING_MS);
  }
}

function _lsClearManualEditTimers(state){
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  if (state.ceilingTimer) { clearTimeout(state.ceilingTimer); state.ceilingTimer = null; }
}

// CC-specific: a whole-capability-list target ("metricKey||") subsumes any
// feature-level targets under that same metric ("metricKey||capName") —
// the list-level event already re-syncs everything for that metric, so
// the narrower ones would be redundant, not additionally informative.
function _lsCanonicalizeCcTargets(targets){
  var wholeListMetrics = {};
  targets.forEach(function(t){
    var idx = t.indexOf(_LS_CC_TARGET_SEP);
    if (idx === -1) return;
    if (t.substring(idx + 1) === '') wholeListMetrics[t.substring(0, idx)] = true;
  });
  return targets.filter(function(t){
    var idx = t.indexOf(_LS_CC_TARGET_SEP);
    if (idx === -1) return true;
    var capName = t.substring(idx + 1);
    if (capName === '') return true; // always keep whole-list targets themselves
    return !wholeListMetrics[t.substring(0, idx)];
  });
}

// Emits one event per (canonicalized, for cc) target. Returns the list of
// targets that failed to emit, so the caller can requeue only those —
// never the whole batch — matching the per-target success/failure
// tracking the critique specifically called for.
// v8.147 fix: confirmed via live testing that this function was built
// with the mark/apply halves wired up for 'sc'/'pc' but never given the
// actual emit branches here — every manual edit for these two areas was
// silently producing nothing at all (no error, no event, no toast),
// while generation events kept working since those bypass this function
// entirely (emitted directly from their own generation functions).
// Story Canvas targets subsume the same way CC's do — a coarse
// (feature-level) target drops any surgical (story-level) targets for
// stories under that same feature.
function _lsCanonicalizeScTargets(targets){
  var wholeFeatureIds = {};
  targets.forEach(function(t){
    var idx = t.indexOf(_LS_SC_TARGET_SEP);
    if (idx === -1) return;
    if (t.substring(idx + 1) === '') wholeFeatureIds[t.substring(0, idx)] = true;
  });
  return targets.filter(function(t){
    var idx = t.indexOf(_LS_SC_TARGET_SEP);
    if (idx === -1) return true;
    var storyId = t.substring(idx + 1);
    if (storyId === '') return true;
    return !wholeFeatureIds[t.substring(0, idx)];
  });
}

async function _lsEmitManualEditEventsForTargets(sessionId, area, targets){
  var failed = [];
  if (area === 'pi') {
    try {
      await _lsEmitContentEvent(sessionId, 'pi', 'pi_plan_updated', null, null);
    } catch(e) {
      console.warn('[live-sync] pi manual-edit emit failed:', e);
      failed = targets.slice();
    }
    return failed;
  }
  if (area === 'cc') {
    var canonical = _lsCanonicalizeCcTargets(targets);
    for (var i = 0; i < canonical.length; i++) {
      var t = canonical[i];
      try {
        var idx = t.indexOf(_LS_CC_TARGET_SEP);
        var metricKey = idx === -1 ? t : t.substring(0, idx);
        var capName = idx === -1 ? '' : t.substring(idx + 1);
        var eventType = capName ? 'feature_manually_updated' : 'capability_manually_updated';
        await _lsEmitContentEvent(sessionId, 'cc', eventType, metricKey, capName || null);
      } catch(e) {
        console.warn('[live-sync] cc manual-edit emit failed for target:', t, e);
        failed.push(t);
      }
    }
    return failed;
  }
  if (area === 'sc') {
    var scCanonical = _lsCanonicalizeScTargets(targets);
    for (var si = 0; si < scCanonical.length; si++) {
      var st = scCanonical[si];
      try {
        var sidx = st.indexOf(_LS_SC_TARGET_SEP);
        var featureId = sidx === -1 ? st : st.substring(0, sidx);
        var storyId = sidx === -1 ? '' : st.substring(sidx + 1);
        var scEventType = storyId ? 'story_manually_updated' : 'feature_stories_manually_updated';
        await _lsEmitContentEvent(sessionId, 'sc', scEventType, featureId, storyId || null);
      } catch(e) {
        console.warn('[live-sync] sc manual-edit emit failed for target:', st, e);
        failed.push(st);
      }
    }
    return failed;
  }
  if (area === 'pc') {
    for (var pi2 = 0; pi2 < targets.length; pi2++) {
      var featId = targets[pi2];
      try {
        await _lsEmitContentEvent(sessionId, 'pc', 'prototype_manually_updated', featId, null);
      } catch(e) {
        console.warn('[live-sync] pc manual-edit emit failed for target:', featId, e);
        failed.push(featId);
      }
    }
    return failed;
  }
  return failed;
}

async function _lsFlushManualEditNotification(sessionId, area){
  var state = _lsGetManualEditState(sessionId, area);
  _lsClearManualEditTimers(state);
  if (state.dirtyTargets.size === 0 || state.flushing || state.paused) {
    return;
  }
  state.flushing = true;
  // Snapshot-then-diff: remove exactly these targets from the LIVE set
  // synchronously, before any async work starts — anything added to the
  // set while this flush is in flight stays dirty and gets its own
  // subsequent flush, never silently dropped.
  var snapshot = [];
  state.dirtyTargets.forEach(function(t){ snapshot.push(t); });
  snapshot.forEach(function(t){ state.dirtyTargets.delete(t); });
  console.log('[live-sync] flushing', {area:area, targets:snapshot});
  try {
    var failed = await _lsEmitManualEditEventsForTargets(sessionId, area, snapshot);
    console.log('[live-sync] flush emit result', {area:area, attempted:snapshot, failed:failed});
    failed.forEach(function(t){ state.dirtyTargets.add(t); });
  } catch(e) {
    console.warn('[live-sync] manual-edit flush failed entirely, requeueing this batch:', e);
    snapshot.forEach(function(t){ state.dirtyTargets.add(t); });
  } finally {
    state.flushing = false;
    // If anything is still dirty (re-added on failure, or added fresh
    // during the flush), make sure a timer is running to eventually
    // flush it — nothing else would naturally re-arm these otherwise.
    if (state.dirtyTargets.size > 0) {
      if (!state.idleTimer) state.idleTimer = setTimeout(function(){ _lsFlushManualEditNotification(sessionId, area); }, _LS_MANUAL_EDIT_IDLE_MS);
      if (!state.ceilingTimer) state.ceilingTimer = setTimeout(function(){ _lsFlushManualEditNotification(sessionId, area); }, _LS_MANUAL_EDIT_CEILING_MS);
    }
  }
}

// Called from switchTab() when leaving an area's tab for anywhere else —
// no reason to make a collaborator wait if the user's clearly done.
function _lsFlushManualEditOnTabLeave(area){
  if (typeof _activeSessionId === 'undefined' || !_activeSessionId) return;
  if (!_LS_MANUAL_EDIT_AREAS[area]) return;
  _lsFlushManualEditNotification(_activeSessionId, area);
}

// Called at the point a real regeneration for this area commits to
// wiping/replacing its data — pauses (not clears) any pending manual-edit
// state for the WHOLE area, so a stale timer can't fire mid-generation and
// emit a redundant "manually updated" notification for data about to be
// replaced wholesale anyway. Used by PI (which regenerates its one whole
// plan at once); CC's own generation is per-metric and non-destructive,
// so it uses the narrower per-target clear below instead of this.
function _lsPauseManualEditForRegeneration(area){
  if (typeof _activeSessionId === 'undefined' || !_activeSessionId) return;
  var state = _lsGetManualEditState(_activeSessionId, area);
  _lsClearManualEditTimers(state);
  state.paused = true;
}

// Called once the regeneration's OWN event has been durably emitted — the
// regeneration supersedes whatever manual edits were pending for it. If
// target is given, clears only that one target (CC's per-metric case,
// no pause step needed since CC generation isn't destructive the way a
// full plan regeneration is); if omitted, clears the whole area (PI's case,
// paired with _lsPauseManualEditForRegeneration above).
function _lsClearManualEditAfterRegeneration(area, target){
  if (typeof _activeSessionId === 'undefined' || !_activeSessionId) return;
  var state = _lsGetManualEditState(_activeSessionId, area);
  if (target) {
    state.dirtyTargets.delete(target);
    // If this is a whole-list target ("metricKey||"), also drop any
    // narrower feature-level targets under the SAME metric — the metric's
    // whole capability list was just replaced, so any pending feature-
    // level edit for a capability under it is moot regardless of whether
    // that exact capability still exists in the same form.
    var idx = target.indexOf(_LS_CC_TARGET_SEP);
    if (idx !== -1 && target.substring(idx + 1) === '') {
      var metricPrefix = target.substring(0, idx + 1);
      var toDrop = [];
      state.dirtyTargets.forEach(function(t){ if (t.indexOf(metricPrefix) === 0 && t !== target) toDrop.push(t); });
      toDrop.forEach(function(t){ state.dirtyTargets.delete(t); });
    }
  } else {
    state.paused = false;
    state.dirtyTargets.clear();
  }
}

// Called if a whole-area regeneration did NOT complete successfully —
// resumes the paused manual-edit state so its own notification can still
// eventually fire, rather than being lost because a regeneration attempt
// failed. Only relevant to areas that use the pause/resume pair (PI).
function _lsResumeManualEditAfterFailedRegeneration(area){
  if (typeof _activeSessionId === 'undefined' || !_activeSessionId) return;
  var state = _lsGetManualEditState(_activeSessionId, area);
  state.paused = false;
  if (state.dirtyTargets.size > 0) {
    state.ceilingTimer = setTimeout(function(){ _lsFlushManualEditNotification(state.sessionId, area); }, _LS_MANUAL_EDIT_CEILING_MS);
  }
}

// Build A (v8.132): wholesale-replace apply for the four "whole structure
// regenerated" canvases. Deliberately no per-item matching — that's the
// whole point of these being simpler than CC's per-capability case. The
// caller (below) is responsible for the always-confirm gate before this
// ever runs; this function trusts that's already been decided. Unknown
// canvas is ignored safely, not applied through a default path (per the
// ChatGPT critique).
// v8.138: reads whichever of the app's two actual visibility mechanisms
// applies to this tab (confirmed via index.html — five tabs use inline
// style display:none, two carry the existing 'tab-gated' class and are
// shown via a 'revealed' class instead). No tab names hardcoded here —
// this is what makes it safe from the "forgot one tab" class of bug that
// has recurred across every prior attempt at this feature. Fails toward
// switching (treats a missing element as hidden) rather than toward
// preserving stale content.
function _lsIsTabHidden(tab) {
  var el = document.getElementById('tab-' + tab);
  if (!el) return true;
  if (el.classList.contains('tab-gated')) return !el.classList.contains('revealed');
  return el.style.display === 'none';
}

function _lsApplyWholesaleCanvas(canvas, freshSnapshot, changeKind, changerName){
  if (!freshSnapshot) return { appliedAny: false, description: null };
  if (canvas === 'mm') {
    if (freshSnapshot.gData === undefined) return { appliedAny: false, description: null };
    // v8.136 (item 10 redesign): this branch previously hand-copied a
    // partial field list and a separate, hand-copied tab-hide list — both
    // incomplete, confirmed via live testing to cause real regressions
    // (stale/wiped-looking data in unrelated areas). Redesigned to call
    // the SAME two pure, side-effect-free functions the normal resume path
    // uses (session-store.js) — one authoritative source for "which
    // fields" and "which tabs," used by both paths, so they can no longer
    // drift apart. Strict order, never interleaved: apply every field
    // completely first, only then touch tab visibility, only then close
    // panels or switch tabs — matching the ordering that prevents a
    // render or DOM change from ever seeing partially-applied state.
    if (typeof _ssApplySnapshotFields !== 'function') {
      // Fail safe rather than silently apply half of what's needed.
      console.warn('[live-sync] _ssApplySnapshotFields unavailable, aborting mm apply');
      return { appliedAny: false, description: null };
    }
    _ssApplySnapshotFields(freshSnapshot);
    // Not part of the shared snapshot-fields function (this is CC's own
    // transient UI-selection state, not session-persisted data) — reset
    // explicitly here, same as generateConfirmed()'s own reset does for
    // the actor.
    capStoreInvalidated = true;
    capActiveMetricKey = null; capActiveCapIdx = null; capActiveSubCapIdx = null;
    try {
      if (typeof _ssSyncTabVisibility === 'function') {
        _ssSyncTabVisibility(freshSnapshot);
      }
      // Close any panel this receiving viewer might have open on a canvas
      // that just got wiped — same principle already used for PI/Diagnostics
      // in the wholesale-apply path, extended here to CC's own feature panel.
      if (typeof ccCloseFeatPanel === 'function') ccCloseFeatPanel();
      // v8.138 fix: the fourth iteration of this exact class of bug — a
      // hand-maintained list of "which tabs trigger switch-away" kept
      // missing one, discovered fresh each time a tester happened to be
      // on the specific tab that was missing. Root cause: generateConfirmed()'s
      // own list (dv|la|fc|sc) is itself incomplete — it's just never been
      // wrong for the ACTOR, since the regenerate button only exists on
      // the Discovery Map screen, so the actor can never actually be on
      // cc/mi/pi when they trigger this. A receiving viewer has no such
      // constraint. Fixed by deriving the decision from the actual DOM
      // state _ssSyncTabVisibility just set, moments earlier — no tab
      // names enumerated here at all, so this can't go stale again the
      // way a hand-list can. Reuses the 'tab-gated' class already present
      // in index.html's own markup for sc/pi, rather than inventing a
      // parallel marker.
      if (typeof curTab !== 'undefined' && curTab !== 'mm' && _lsIsTabHidden(curTab) && typeof switchTab==='function') {
        switchTab('mm');
      }
    } catch(e) { console.warn('[live-sync] mm tab-sync/panel-close failed:', e); }
    return { appliedAny: true, description: 'Discovery Map regenerated' };
  }
  if (canvas === 'pi') {
    if (freshSnapshot.piPlans === undefined) return { appliedAny: false, description: null };
    piPlans = freshSnapshot.piPlans;
    if (freshSnapshot.piBacklogStoryIds !== undefined) piBacklogStoryIds = freshSnapshot.piBacklogStoryIds;
    if (freshSnapshot.piInputs !== undefined) piInputs = freshSnapshot.piInputs;
    // _piActivePlanId is intentionally NOT touched here — local per-collaborator state.
    // If the currently-active plan id no longer exists in the fresh piPlans (e.g. deleted by
    // another collaborator), fall back to the first available plan so the viewer isn't left
    // pointing at nothing.
    if (_piActivePlanId && !piPlans.some(function(p){return p.id === _piActivePlanId;})) {
      _piActivePlanId = piPlans.length ? piPlans[0].id : null;
    }
    // v8.141 (item 8): same conflict protection either way (full wholesale
    // replace, same confirm-before-discard gate) - only the description
    // differs, so a receiving viewer has a rough sense of which kind of
    // change happened, per the critique's recommendation.
    var _piDesc = (changeKind === 'manual') ? (changerName || 'A teammate') + ' updated a release plan' : 'Release plan regenerated';
    return { appliedAny: true, description: _piDesc };
  }
  if (canvas === 'mi') {
    if (freshSnapshot.miData === undefined) return { appliedAny: false, description: null };
    miData = freshSnapshot.miData;
    if (freshSnapshot.miCapabilities !== undefined) miCapabilities = freshSnapshot.miCapabilities;
    if (freshSnapshot.miGenerated !== undefined) miGenerated = freshSnapshot.miGenerated;
    // v8.133 fix (item 2): miProductMode is written by miGenerate() itself
    // (parsed.productMode) — missing it left mode-dependent rendering
    // (miRenderScreen's category-vs-market branches) stale.
    if (freshSnapshot.miProductMode !== undefined) miProductMode = freshSnapshot.miProductMode;
    return { appliedAny: true, description: 'Market Intelligence regenerated' };
  }
  if (canvas === 'la') {
    if (freshSnapshot.productLeakAnalysis === undefined) return { appliedAny: false, description: null };
    productLeakAnalysis = freshSnapshot.productLeakAnalysis;
    if (freshSnapshot.diagnosticSessions !== undefined) diagnosticSessions = freshSnapshot.diagnosticSessions;
    if (freshSnapshot.activeDiagnosticId !== undefined) activeDiagnosticId = freshSnapshot.activeDiagnosticId;
    return { appliedAny: true, description: 'Diagnostic analysis regenerated' };
  }
  console.warn('[live-sync] unknown canvas in wholesale apply, skipping:', canvas);
  return { appliedAny: false, description: null };
}


// Per the ChatGPT critique: blanket-close each section's own known
// secondary panel unconditionally on a wholesale apply, rather than trying
// to trace and validate the exact staleness condition for each (PI's right
// panel keyed by story, Diagnostics' evidence drawer keyed by metric/node)
// before this ships. Safer default given neither mechanism has been traced
// precisely yet.
function _lsCloseKnownPanelForCanvas(canvas){
  if (canvas === 'pi' && typeof piCloseRightPanel === 'function') piCloseRightPanel();
  if (canvas === 'la' && typeof dvCloseEvidenceDrawer === 'function') dvCloseEvidenceDrawer();
}

function _lsRerenderCanvas(canvas){
  if (typeof curTab === 'undefined') return;
  // v8.137 fix: renderMM(data) requires its argument explicitly — every
  // other caller in the app passes gData; this was the one place that
  // didn't, confirmed via a full-codebase check before fixing. gData is
  // guaranteed set by this point (_lsApplyWholesaleCanvas's 'mm' branch
  // already ran and returned appliedAny:true before this is ever called).
  if (canvas === 'mm' && curTab === 'mm' && typeof renderMM === 'function') renderMM(gData);
  if (canvas === 'pi' && curTab === 'pi' && typeof piOnTabEnter === 'function') piOnTabEnter();
  if (canvas === 'mi' && curTab === 'mi' && typeof miRenderScreen === 'function') miRenderScreen();
  if (canvas === 'la' && curTab === 'la' && typeof laRenderAnalysis === 'function') laRenderAnalysis();
}

function _lsAskConfirm(message){
  return new Promise(function(resolve){
    if (typeof showConfirm === 'function') {
      showConfirm(message, 'Confirm update', function(){ resolve(true); }, 'Continue', 'warn', 'Cancel', function(){ resolve(false); });
    } else { resolve(true); }
  });
}

async function _lsBannerRefreshClick(){
  if (_lsBannerRefreshInFlight) return;
  var sessionId = _lsBannerCurrentSessionId;
  var events = _lsBannerCurrentEvents;
  if (!sessionId || !events || events.length === 0) return;
  var seq = _lsWatchSeq;
  // v8.145 fix: hide the banner immediately, before any confirm dialog can
  // ever show — previously this only happened at the very end of this
  // function, so the banner (z-index 9998) sat visibly overlapping any
  // confirm dialog (z-index 600) shown during this same flow the whole
  // time it was up. Safe to call here: sessionId/events are already
  // captured into local variables above, and this function only ever
  // references those locals from this point on, never the globals this
  // clears — confirmed by reading the rest of this function before making
  // this change, not assumed.
  if (typeof _lsHideContentBanner === 'function') _lsHideContentBanner();
  _lsBannerRefreshInFlight = true;
  try {
    var byCanvas = {};
    events.forEach(function(ev){ (byCanvas[ev.canvas] = byCanvas[ev.canvas] || []).push(ev); });

    // Per-section confirm, not one gate for the whole batch — declining one
    // section must never block applying an unrelated one (the original
    // single-confirm design would have done exactly that once cross-canvas
    // batches became possible).
    var proceed = {};
    var ccEvents = byCanvas['cc'] || [];
    if (ccEvents.length > 0) {
      var ccNeedsConfirm = false;
      for (var i = 0; i < ccEvents.length; i++) {
        if (ccEvents[i].cap_name && _lsHasOpenEditForCapability(ccEvents[i].metric_key, ccEvents[i].cap_name)) { ccNeedsConfirm = true; break; }
      }
      proceed['cc'] = ccNeedsConfirm
        ? await _lsAskConfirm('You have an unsaved edit open on a capability that was just updated. Refreshing will discard it. Continue?')
        : true;
    }
    // v8.146 (Build B): Story Canvas — same per-open-edit conservatism as CC.
    var scEvents = byCanvas['sc'] || [];
    if (scEvents.length > 0) {
      var scNeedsConfirm = false;
      for (var si = 0; si < scEvents.length; si++) {
        if (_lsHasOpenEditForStory(scEvents[si].metric_key, scEvents[si].cap_name)) { scNeedsConfirm = true; break; }
      }
      proceed['sc'] = scNeedsConfirm
        ? await _lsAskConfirm('You have an unsaved edit open on a story that was just updated. Refreshing will discard it. Continue?')
        : true;
    }
    // Prototype Canvas — no cheap per-field open-edit check exists (screenshot
    // upload/context edits aren't tracked the way CC/SC's open-panel state
    // is), so this always confirms, same reasoning as the wholesale canvases.
    var pcEvents = byCanvas['pc'] || [];
    if (pcEvents.length > 0) {
      proceed['pc'] = await _lsAskConfirm('Applying this update will replace the prototype for this feature and discard any local changes you have not saved there. Continue?');
    }
    var _wholesaleCanvases = ['mm','pi','mi','la'];
    for (var wi = 0; wi < _wholesaleCanvases.length; wi++) {
      var wc = _wholesaleCanvases[wi];
      if (!byCanvas[wc] || byCanvas[wc].length === 0) continue;
      // Always confirm for wholesale replace — no cheap, reliable way to
      // check "is there an unsaved edit anywhere in this whole structure"
      // the way a single open input field could be checked for CC.
      proceed[wc] = await _lsAskConfirm('Applying this update will replace all of "' + _lsCanvasLabel(wc) + '" and discard any local changes you have not saved there. Continue?');
    }

    if (seq !== _lsWatchSeq || _lsWatchSessionId !== sessionId) return; // superseded during confirms

    // ONE fresh snapshot fetch for everything applied this click — never
    // per-event, never per-canvas. Confirmed already true for CC alone;
    // preserved as the invariant now that multiple canvases can be involved.
    var client = _lsGetClient();
    if (!client) return;
    var companyId = _lsGetActiveCompanyId();
    var res = await client.from(_SS_TABLE).select('snapshot').eq('id', sessionId).eq('company_id', companyId).limit(1);
    if (seq !== _lsWatchSeq || _lsWatchSessionId !== sessionId) return;
    if (res.error || !res.data || res.data.length === 0 || !res.data[0].snapshot) {
      if (typeof showToast === 'function') showToast('Could not refresh this content. Please try again.', 'warn');
      return;
    }
    var freshSnapshot = res.data[0].snapshot;

    var allDescriptions = [];
    var totalFailed = 0;
    var appliedCanvasLabels = {};

    if (ccEvents.length > 0 && proceed['cc']) {
      var ccResult = _lsApplyCCEvents(freshSnapshot, ccEvents);
      allDescriptions = allDescriptions.concat(ccResult.descriptions);
      totalFailed += ccResult.failedCount;
      if (ccResult.appliedAny) {
        appliedCanvasLabels[_lsCanvasLabel('cc')] = true;
        var _ccMaxId = 0;
        ccEvents.forEach(function(ev){ if (ev.id > _ccMaxId) _ccMaxId = ev.id; });
        _lsSetSeenCursor(sessionId, 'cc', _ccMaxId);
        // v9.05: Discovery Map's "Custom Value Stage" is derived from
        // capStore's pi|| entries, not synced via its own separate live-sync
        // event — normalize it here, immediately after capStore has been
        // patched with the teammate's change, so the receiving collaborator's
        // Discovery Map reflects new/renamed/deleted custom process areas
        // without a second event type or ordering dependency. Structurally
        // safe: this only ever runs AFTER ccResult.appliedAny confirms
        // capStore is already up to date for this batch.
        var _mmChanged = false;
        if (typeof gData !== 'undefined' && gData && typeof syncPiStageFromCapStore === 'function') {
          var _piStageBefore = JSON.stringify((gData.stages || []).find(function(s){ return s && s.id === 'pi'; }) || null);
          syncPiStageFromCapStore(gData, capStore);
          var _piStageAfter = JSON.stringify((gData.stages || []).find(function(s){ return s && s.id === 'pi'; }) || null);
          _mmChanged = (_piStageBefore !== _piStageAfter);
          if (_mmChanged) appliedCanvasLabels[_lsCanvasLabel('mm')] = true;
          if (typeof curTab !== 'undefined' && curTab === 'mm' && typeof renderMM === 'function') renderMM(gData);
        }
        if (typeof curTab !== 'undefined' && curTab === 'cc') {
          var rp = document.getElementById('cc-feat-panel');
          if (ccResult.panelShouldClose) {
            if (typeof ccCloseFeatPanel === 'function') ccCloseFeatPanel();
          } else if (rp && typeof capActiveMetricKey !== 'undefined' && capActiveMetricKey !== null
                     && typeof capActiveCapIdx !== 'undefined' && capActiveCapIdx !== null
                     && capStore[capActiveMetricKey] && capStore[capActiveMetricKey].capabilities[capActiveCapIdx]) {
            var _panelEntry = capStore[capActiveMetricKey];
            var _panelCap = _panelEntry.capabilities[capActiveCapIdx];
            if (typeof ccBuildFeatPanel === 'function') rp.innerHTML = ccBuildFeatPanel(_panelEntry, _panelCap, capActiveCapIdx, capActiveMetricKey);
          }
          if (typeof capActiveMetricKey === 'undefined' || capActiveMetricKey === null) {
            if (typeof ccRenderAllCaps === 'function') ccRenderAllCaps();
          } else {
            if (typeof ccRenderMainContent === 'function') ccRenderMainContent();
          }
          if (typeof capStore !== 'undefined') {
            var _touchedMetricKeys = {};
            ccEvents.forEach(function(ev){ if (ev.metric_key) _touchedMetricKeys[ev.metric_key] = true; });
            var _navRows = document.querySelectorAll('.cc-nav-metric[data-metric-key]');
            _navRows.forEach(function(_row){
              var mk = _row.getAttribute('data-metric-key');
              if (!mk || !_touchedMetricKeys[mk]) return;
              var _badge = _row.querySelector('.cc-nav-count');
              if (!_badge) return;
              var _direct = capStore[mk] ? (capStore[mk].capabilities || []).length : 0;
              var _injectedKey = (typeof ccFindInjectedCapKey === 'function' && capStore[mk]) ? ccFindInjectedCapKey(capStore[mk].metricName) : null;
              var _injected = (_injectedKey && capStore[_injectedKey]) ? (capStore[_injectedKey].capabilities || []).length : 0;
              _badge.textContent = String(_direct + _injected);
            });
            var _allRow = document.querySelector('.cc-nav-all[data-metric-key="__all__"] .cc-nav-count');
            if (_allRow && typeof ccGetTotalCaps === 'function') _allRow.textContent = String(ccGetTotalCaps());
          }
        }
        if (typeof ccUpdateTabBadge === 'function') ccUpdateTabBadge();
      }
    }

    // v8.146 (Build B): Story Canvas apply.
    if (scEvents.length > 0 && proceed['sc']) {
      var scResult = _lsApplySCEvents(freshSnapshot, scEvents);
      allDescriptions = allDescriptions.concat(scResult.descriptions);
      totalFailed += scResult.failedCount;
      if (scResult.appliedAny) {
        appliedCanvasLabels[_lsCanvasLabel('sc')] = true;
        var _scMaxId = 0;
        scEvents.forEach(function(ev){ if (ev.id > _scMaxId) _scMaxId = ev.id; });
        _lsSetSeenCursor(sessionId, 'sc', _scMaxId);
        if (scResult.panelShouldClose && typeof newScClosePanel === 'function') newScClosePanel();
        if (typeof curTab !== 'undefined' && curTab === 'sc' && typeof newScRender === 'function') newScRender();
        if (typeof fcUpdateTabBadge === 'function') fcUpdateTabBadge();
        if (typeof newScUpdateTabBadge === 'function') newScUpdateTabBadge();
        if (typeof curTab !== 'undefined' && curTab === 'fc' && typeof fcRenderCanvas === 'function') fcRenderCanvas();
      }
    }

    // v8.146 (Build B): Prototype Canvas apply.
    if (pcEvents.length > 0 && proceed['pc']) {
      var pcResult = _lsApplyPCEvents(freshSnapshot, pcEvents);
      allDescriptions = allDescriptions.concat(pcResult.descriptions);
      totalFailed += pcResult.failedCount;
      if (pcResult.appliedAny) {
        appliedCanvasLabels[_lsCanvasLabel('pc')] = true;
        var _pcMaxId = 0;
        pcEvents.forEach(function(ev){ if (ev.id > _pcMaxId) _pcMaxId = ev.id; });
        _lsSetSeenCursor(sessionId, 'pc', _pcMaxId);
        if (typeof curTab !== 'undefined' && curTab === 'sc' && typeof newScProtoView !== 'undefined' && newScProtoView
            && typeof newScActiveNavFeat !== 'undefined' && typeof pcRenderView === 'function') {
          pcRenderView(newScActiveNavFeat);
        }
      }
    }

    _wholesaleCanvases.forEach(function(wc){
      var evs = byCanvas[wc] || [];
      if (evs.length === 0 || !proceed[wc]) return;
      _lsCloseKnownPanelForCanvas(wc);
      // If a real regeneration and a manual-update event are both pending
      // for the same canvas in this batch, describe it as the
      // regeneration — same underlying data either way (both re-fetch the
      // same latest snapshot), but the more significant description is
      // the more accurate one to show.
      var _hasGenEvent = evs.some(function(ev){ return ev.event_type && ev.event_type.indexOf('_generated') !== -1; });
      var _wcChangerName = null;
      for (var _ei = 0; _ei < evs.length; _ei++) { if (evs[_ei].generated_by_name) { _wcChangerName = evs[_ei].generated_by_name; break; } }
      var result = _lsApplyWholesaleCanvas(wc, freshSnapshot, _hasGenEvent ? 'generated' : 'manual', _wcChangerName);
      if (result.appliedAny) {
        appliedCanvasLabels[_lsCanvasLabel(wc)] = true;
        allDescriptions.push(result.description);
        var _maxId = 0;
        evs.forEach(function(ev){ if (ev.id > _maxId) _maxId = ev.id; });
        _lsSetSeenCursor(sessionId, wc, _maxId);
        _lsRerenderCanvas(wc);
      } else {
        totalFailed++;
      }
    });

    // v8.139 fix: a receiving viewer's CC apply correctly patched capStore
    // but never revealed the CC tab if it was previously hidden — a
    // narrower version of the same "apply path forgot the tab-visibility
    // side effect" gap already fixed once for mm. Rather than patch CC
    // specifically (and risk finding this same gap a third time in pi/mi/
    // la's own narrow-apply paths later), sync tab visibility exactly once
    // here, using the one complete, already-fetched snapshot for this
    // click — confirmed via critique to be safe specifically because this
    // is the real, full session snapshot, never a partial event payload.
    // Gated on at least one canvas having actually applied something this
    // click, so a click that only resulted in declines does nothing extra.
    if (Object.keys(appliedCanvasLabels).length > 0 && typeof _ssSyncTabVisibility === 'function') {
      try { _ssSyncTabVisibility(freshSnapshot); } catch(e) { console.warn('[live-sync] post-apply tab visibility sync failed:', e); }
    }

    var msgParts = [];
    if (allDescriptions.length > 0) {
      var uniqueDescriptions = allDescriptions.filter(function(d, idx){ return allDescriptions.indexOf(d) === idx; });
      var _labelsStr = Object.keys(appliedCanvasLabels).join(', ');
      msgParts.push("Refreshed '" + _labelsStr + "' - " + uniqueDescriptions.join(', ') + '.');
    }
    if (totalFailed > 0) {
      msgParts.push(totalFailed + ' update(s) could not be applied safely. Reopen the session to see the latest.');
    }
    if (msgParts.length > 0 && typeof showToast === 'function') {
      showToast(msgParts.join(' '), totalFailed > 0 ? 'warn' : 'success');
    }
    // v8.150 fix (Issue 2, corrected): only clear the dedicated
    // "unapplied remote changes" flag on a fully clean apply (zero
    // failures) — a partial failure means some content genuinely didn't
    // apply, so the local snapshot still isn't safe to trust as
    // authoritative, and homeClearSession() should keep protecting it.
    if (totalFailed === 0 && Object.keys(appliedCanvasLabels).length > 0) {
      delete _lsUnappliedRemoteChanges[sessionId];
    }
    // Declined sections' cursors are untouched, so their events remain
    // genuinely pending and the banner will legitimately reappear next
    // watch cycle — moving the hide to the top of this function (v8.145)
    // doesn't change that: it only affects when the banner disappears
    // during THIS click, never whether it can reappear on a later one.
  } catch(e) {
    console.warn('[live-sync] banner refresh failed:', e);
    if (typeof showToast === 'function') showToast('Could not refresh this content. Please try again.', 'warn');
  } finally {
    _lsBannerRefreshInFlight = false;
  }
}
