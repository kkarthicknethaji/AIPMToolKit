function getKey(){const el=document.getElementById('api-key');if(el&&el.value.trim())return el.value.trim();return sessionStorage.getItem(typeof _byokKey==='function'?_byokKey():'hcl_ak')||'';}  
function gv(id){return document.getElementById(id).value.trim();}

// ── Phase 5: generation lock ──
// Wraps a caller's FULL generate→parse→validate→apply→save workflow, not
// just the network call. Confirmed via adversarial review that scoping the
// lock to callAPI() alone is unsafe for this codebase: every real caller
// (~21 sites across 10 files) does substantial post-processing and calls
// sessionStoreSave() AFTER callAPI() returns — a lock that releases when
// callAPI() resolves would let a second person start generating before the
// first person's result is actually persisted.
//
// Explicitly deferred, not built this phase (logged, not an oversight):
//   - Server-side lock enforcement (Render proxy) — this remains a
//     cooperative client-side convention, not a true distributed guarantee.
//   - Live re-fetch of is_shared immediately pre-acquire — _activeSessionIsShared
//     is a cached client flag; a session shared mid-session by someone else
//     won't be reflected here until next load.
//   - Operation-token-based locking (active_operation_id) — the real fix for
//     same-user multi-tab and heartbeat/release ordering at the schema
//     level. Requires a DB migration outside this phase's reach.
//   - The has_access/UPDATE non-atomicity inside acquire_generation_lock()
//     itself (a membership revocation landing mid-call) — a DB-function
//     limitation, not fixable from app code.

// Same-tab/same-browser duplicate-generation guard. Does NOT solve true
// cross-device same-user concurrency (the DB lock is reentrant for the same
// current_app_user() by design) — this only stops the easy accidental
// double-click/two-tab-in-one-browser case.
const _localGenerationLocks = new Set();

// Branded lock handle marker — vanilla JS has no enforced module privacy,
// so an inner "unlocked, requires a real lock handle" function (see the
// ccGenerateFeaturesForCap pattern) can't rely on a leading underscore
// alone to stop a future caller from passing a bogus {throwIfLost(){}}
// object and silently bypassing the lock. Confirmed via adversarial
// review (nested-lock design question) that this branding is necessary,
// not decorative — an inner function that requires a lock handle should
// assert the brand and throw loudly if it's missing or fake, turning an
// accidental unlocked call into an immediate error instead of a silent
// same-tab race.
const _GENERATION_LOCK_HANDLE_BRAND = Symbol('generationLockHandle');

// Call at the top of any inner "requires a real lock handle" function
// (naming convention: suffixed _REQUIRES_LOCK_HANDLE) to fail loudly if
// called without one. callerName is just for a more useful error message.
function _assertGenerationLockHandle(lockHandle, callerName){
  if (!lockHandle || lockHandle[_GENERATION_LOCK_HANDLE_BRAND] !== true || typeof lockHandle.throwIfLost !== 'function') {
    throw new Error((callerName||'unknown caller')+': called without a valid generation lock handle — this function must only be called from inside withGenerationLock(), never directly.');
  }
}

async function _pgtRpc(fnName, params){
  const client = (typeof authInit === 'function') ? authInit() : null;
  if (!client) return { data: null, error: new Error('Auth client not initialised') };
  return await client.rpc(fnName, params);
}

async function _acquireGenerationLock(sessionId){
  const { data, error } = await _pgtRpc('acquire_generation_lock', { p_session_id: sessionId });
  if (error) throw error; // caller distinguishes thrown (unknown) from a clean false
  // Phase 5 fix (v8.118): the RPC's return shape changed from a bare
  // boolean to a structured object ({acquired, active_user_name, reason})
  // so the frontend can show WHO currently holds the lock, not just that
  // it's held. Per adversarial review, this is a genuine breaking change
  // to the RPC's contract, not an additive one — a careless `if(data)`
  // truthy check on the new object shape would incorrectly treat
  // {acquired:false} as truthy and let generation proceed when it
  // shouldn't. Defends against that here: validates the shape strictly
  // and THROWS (fails closed, no generation) rather than guessing, if the
  // RPC ever returns something unexpected — e.g. if this code somehow runs
  // against the OLD boolean-returning RPC before the SQL migration lands,
  // or after some future accidental revert.
  if (!data || typeof data !== 'object' || typeof data.acquired !== 'boolean') {
    console.error('[LOCK] unexpected acquire_generation_lock response shape:', data);
    throw new Error('generation_lock_unknown');
  }
  const name = (data.active_user_name == null ? '' : String(data.active_user_name)).trim();
  return {
    acquired: data.acquired === true,
    activeUserName: name || null,
    reason: data.reason || null
  };
}

async function _releaseGenerationLock(sessionId){
  const { error } = await _pgtRpc('release_generation_lock', { p_session_id: sessionId });
  if (error) throw error;
}

// Single-flight heartbeat — never overlaps itself, and release() always
// waits for any in-flight tick to settle before running. Closes the ghost-
// lock race found in adversarial review: a blind setInterval's already-
// in-flight request can land AFTER clearInterval()+release(), silently
// reacquiring the lock for a generation that has already finished.
function _startLockHeartbeat(sessionId, onLockLost){
  let stopped = false, timer = null, inFlight = null;
  async function beat(){
    if (stopped) return;
    inFlight = (async () => {
      try {
        const ok = await _acquireGenerationLock(sessionId);
        if (ok === false) { stopped = true; onLockLost(); return; }
        // ok === true: refreshed successfully, nothing else to do.
      } catch(e) {
        // Thrown/network failure — log and continue. A single failed
        // heartbeat tick does NOT mean the lock is lost; only a clean
        // false return means that. Killing a 2-4 minute PI generation
        // because one heartbeat ping timed out would be worse than the
        // staleness bug this heartbeat exists to fix.
        console.warn('[LOCK] heartbeat failed, lock state unknown, continuing:', e);
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

// The wrapper every generation call site (B6) uses. fn is an async function
// containing the ENTIRE workflow: the callAPI() call, response parsing,
// validation, applying results to state, and sessionStoreSave(). Session
// context is captured ONCE here, at call start — never re-read from a live
// global mid-flight, closing the "user switches sessions during generation"
// race found in adversarial review.
//
// fn receives a `lock` handle: { throwIfLost() }. Per the SECOND adversarial
// review round, checking `lockLost` only AFTER fn() returns is too late if
// fn() already called sessionStoreSave() before returning — the throw at
// that point is "performative," the bad save already happened. Callers that
// do meaningful work in stages (parse → apply → save) should call
// lock.throwIfLost() between stages, especially immediately before any
// save, so a lock lost mid-generation is caught BEFORE persisting, not
// after. Not every caller needs multiple checkpoints — a caller that
// applies+saves in one synchronous block right after callAPI() returns
// only needs one checkpoint, right before that block.
async function withGenerationLock(fn){
  const lockSessionId = (typeof _activeSessionId !== 'undefined') ? _activeSessionId : null;
  const lockIsShared = (typeof _activeSessionIsShared !== 'undefined') && !!_activeSessionIsShared;

  if (!lockIsShared || !lockSessionId) return await fn({ [_GENERATION_LOCK_HANDLE_BRAND]: true, sessionId: lockSessionId||null, throwIfLost(){} }); // private session — no lock, zero overhead, no-op checkpoint, still branded so inner _REQUIRES_LOCK_HANDLE functions accept it

  if (_localGenerationLocks.has(lockSessionId)) {
    // Phase 5 fix (v8.118): this message is about the user's OWN prior
    // click still being in flight in THIS SAME browser tab — not a
    // different user, and the original wording ("A generation is already
    // running on this session in this tab") was confirmed via live
    // testing to read as a completely separate, cross-user situation,
    // when it's really the same "you clicked while your own request was
    // still running" case every other generation entry point in the app
    // already handles with this exact copy. Adopting that existing,
    // already-proven wording here for consistency, not inventing new text.
    if (typeof showToast === 'function') showToast("Still working on your last request. Hang tight, this won't take long.", 'info');
    throw new Error('generation_already_running_locally');
  }
  // Claim the local slot SYNCHRONOUSLY, before the async DB acquire call
  // even starts — not after it resolves. A real bug was found here in
  // testing: adding to the Set only after `await _acquireGenerationLock()`
  // resolved left a genuine window, between the acquire call starting and
  // it resolving, where a second same-tab call could pass the check above
  // and race its own concurrent acquire. Every exit path below now removes
  // this claim — the try/finally covers it even if the acquire call itself
  // throws or returns false.
  _localGenerationLocks.add(lockSessionId);

  // Phase 5 fix (v8.118): _acquireGenerationLock() now returns
  // {acquired, activeUserName, reason} instead of a bare boolean, so the
  // cross-user rejection toast below can name the actual person holding
  // the lock. lockResult starts as a fail-closed default (acquired:false)
  // so any code path that somehow skips the assignment below still
  // behaves safely, the same fail-closed intent the old `let acquired =
  // false` default had.
  let lockResult = { acquired: false, activeUserName: null, reason: null };
  try {
    try {
      lockResult = await _acquireGenerationLock(lockSessionId);
    } catch(e) {
      // Thrown/network failure on the INITIAL acquire is treated as unknown,
      // not as safe-to-proceed — distinct from a clean false, per adversarial
      // review. We genuinely don't know if the lock was granted server-side.
      console.warn('[LOCK] initial acquire failed, lock state unknown:', e);
      if (typeof showToast === 'function') showToast('Could not confirm generation lock. Please try again.', 'warn');
      throw new Error('generation_lock_unknown');
    }
    if (lockResult.acquired === false) {
      // v9.08: distinguish view-only rejection from a genuinely held lock.
      // Before this feature, is_shared alone always granted access, so
      // 'no_access' as a reason was impossible — the RPC can now return it
      // for an authenticated, active company member who simply has
      // view-only access to this session. Falling through to the generic
      // "someone is already generating" copy would be actively misleading
      // for this case.
      if (lockResult.reason === 'no_access') {
        if (typeof showToast === 'function') showToast("You have view-only access to this session and can't generate content.", 'warn');
        throw new Error('generation_lock_no_access');
      }
      // Phase 5 fix (v8.118): name the actual holder when the RPC provides
      // one; fall back to the existing generic wording otherwise (a
      // legitimately possible case — e.g. active_user_name was never
      // denormalized for some old lock, or the holder released between the
      // RPC's failed acquire and its own name lookup, a benign, accepted
      // display-only race per adversarial review). Matches the same
      // "|| 'Someone'" fallback pattern already used for the session
      // card's "is generating now" meta line, for consistency.
      const _holder = lockResult.activeUserName || 'Someone on your team';
      if (typeof showToast === 'function') showToast(_holder + ' is already generating on this session. Try again in a moment.', 'warn');
      throw new Error('generation_lock_not_acquired');
    }

    let lockLost = false;
    const heartbeat = _startLockHeartbeat(lockSessionId, function(){ lockLost = true; });
    const lockHandle = {
      [_GENERATION_LOCK_HANDLE_BRAND]: true,
      sessionId: lockSessionId,
      throwIfLost(){
        if (lockLost) {
          if (typeof showToast === 'function') showToast('Your session lock was lost during generation. Your result was not saved. Please try again.', 'warn');
          throw new Error('generation_lock_lost');
        }
      }
    };
    try {
      const result = await fn(lockHandle);
      // Final check after fn() returns too — covers callers whose last
      // statement inside fn() IS the save, with no room for one more
      // explicit checkpoint call after it.
      lockHandle.throwIfLost();
      return result;
    } finally {
      await heartbeat.stopAndWait();
      try { await _releaseGenerationLock(lockSessionId); }
      catch(e) { console.warn('[LOCK] release failed, will expire by staleness window:', e); }
    }
  } finally {
    // Release the local slot on EVERY exit — success, lock-not-acquired,
    // lock-unknown, fn() throwing, or lock-lost mid-generation.
    _localGenerationLocks.delete(lockSessionId);
  }
}


// ── Per-caller tiering table (v9.14 — multi-provider) ──
// Used only when appSettings.model === 'optimized' (see scripts/config.js's
// _spModelsByProvider). Any other appSettings.model value is a deliberate
// user override and wins outright over everything below, via
// resolveModelDecision()'s precedence chain.
//
// Two-layer, replacing the old flat CALLER_MODEL_DEFAULTS map: a provider-
// independent tier classification per caller (unchanged from the implicit
// Haiku/Sonnet split this table encoded before — just made explicit and
// named), plus a tier-to-model map per provider. Sourced from the v8.87 AI
// Model Defaults spreadsheet — keep in sync if either changes.
const CALLER_TIERS = {
  'dm-generate': 'general',
  'mi-suggest': 'lightweight',
  'mi-generate': 'lightweight',
  'mi-docx-gen': 'lightweight',
  'cc-gen-one': 'general',
  'cc-gen-all': 'lightweight',
  'cc-gen-features': 'general',
  'cc-regen-metric': 'general',
  'cc-refine-metric': 'general',
  'cc-gen-features-pi': 'general',
  'cc-dd-batch': 'lightweight',
  'cc-dd-single': 'lightweight',
  'cc-gen-features-cap': 'general',
  'drawer-gen-features': 'general',
  'diagnostic-leak': 'general',
  'fc-gen-stories': 'general',
  'md-dd-batch': 'lightweight',
  'pi-generate': 'general',
  'prototype-wireframe': 'lightweight',
  'prototype-brief': 'general',
  'doc-summary': 'lightweight',
  'ai-recommendations': 'lightweight',
  // v9.10.03: was silently falling through to the fallback tier by
  // omission, not deliberate choice — this call (Add Feature's on-demand
  // single-hypothesis generation) is a lighter, single-item task closer in
  // profile to cc-dd-single/mi-suggest than to the bulk multi-feature
  // generation callers, so registered here at the lightweight tier.
  'sc-add-feat-hyp-gen': 'lightweight',
  // v9.12.05 fix: was hardcoded to a specific Haiku model string directly
  // at the call site (outcome-pulse.js), completely bypassing this table
  // and the Optimized/user-choice precedence chain in resolveModel() below
  // — confirmed a real gap, not a deliberate choice. Optimized now
  // correctly resolves to the general tier for this caller; an explicit
  // user model choice in Settings is also now correctly respected here,
  // same as every other caller in this table.
  'outcome-pulse-suggest': 'general',
  // v9.15: Guided Launch chat turns (opening summary, revisions, upload
  // summarisation) and its final MD synthesis — general tier so Optimized
  // resolves to each provider's Sonnet-equivalent, matching the product
  // decision to use the standard resolution chain rather than a hardcoded
  // model string (see guided-launch.js).
  'guided-launch': 'general',
  // v9.16: Requirement Agent (the real, global, multi-conversation
  // post-Capability-Canvas agent — see requirement-agent.js) — same general
  // tier/resolution-chain reasoning as guided-launch above. Distinct caller
  // key from 'guided-launch' on purpose: these are two separate features.
  'requirement-agent': 'general',
  // v9.23: Adoption Readiness's optional "Regenerate with AI" enhancements
  // (readiness-canvas.js) — general tier, same reasoning-over-structured-
  // JSON profile as fc-gen-stories. The deterministic/templated drafts
  // remain the default and the fallback on any AI-call failure; these
  // callers only fire when the user explicitly requests enrichment.
  'arp-change-overview': 'general',
  'arp-impact-groups': 'general',
  'arp-readiness-actions': 'general',
  'arp-launch-narrative': 'general'
};

// Tier -> model, per provider. This is the ONLY place a literal model ID
// for "optimized" mode lives. No caller currently maps to 'premium' — that
// tier exists for manual user pinning only (e.g. user explicitly selects
// Opus in Settings). Preserved as-is; not a behavior change.
//
// OpenAI model IDs confirmed 2026-07-25 via direct human screenshot of
// developers.openai.com/api/docs/models — see scripts/config.js's
// _spModelsByProvider for the full residual-uncertainty note (GPT-5.6 family
// reportedly limited-preview per press, not yet confirmed callable by this
// org's account due to a $0 billing balance blocker).
const TIER_MODEL_BY_PROVIDER = {
  anthropic: {
    lightweight: 'claude-haiku-4-5',
    general:     'claude-sonnet-4-6',
    premium:     'claude-opus-4-8'
  },
  openai: {
    lightweight: 'gpt-5.6-luna',
    general:     'gpt-5.6-terra',
    premium:     'gpt-5.6-sol'
  },
  // Gemini model IDs confirmed via direct raw-documentation paste (not
  // search-tool output) — see scripts/config.js's _spModelsByProvider
  // comment for the source and the confirmed-no-premium-tier finding.
  // premium: null is intentional, not a placeholder — resolveModelDecision()
  // already handles a null tier-lookup result by falling through to
  // _MODEL_FALLBACK_BY_PROVIDER.gemini below, never silently sending
  // null/undefined upstream (verified correct in the shipped v9.14.02 code).
  gemini: {
    lightweight: 'gemini-3.5-flash-lite',
    general:     'gemini-3.6-flash',
    premium:     null
  }
};

const _MODEL_FALLBACK_BY_PROVIDER = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-5.6-terra', // general tier, mirroring anthropic's fallback being its own general-tier model
  gemini:    'gemini-3.6-flash' // general tier, same pattern
};

// ── Shared model resolver ──
// Single source of truth for "which model should this call actually use."
// Precedence: explicit modelOverride argument (used by the CC/FC multi-select
// threshold logic to force Haiku for 4+ items) > deliberate user override in
// Settings (anything other than 'optimized') > per-caller smart default >
// final hardcoded fallback. Called by callAPI() AND by the two call sites
// that build their own request body independently (home.js AI Recommendations,
// which uses a separate Netlify-function fetch path by design) rather than
// going through callAPI() — both must call this, not re-implement it, so a
// future change to precedence only needs to happen in one place.
// ── Multi-select model threshold ──
// Used by CC's ccGenerateFeaturesForSelected and FC's scGenerateStories
// batch path. Forces the active provider's lightweight tier for 4+ items
// ONLY when the user is still on the 'optimized' default — if they've
// explicitly chosen a model in Settings, that choice always wins, with no
// exception for batch size. v9.14: no longer hardcodes claude-haiku-4-5 —
// forces whichever provider is active's lightweight tier instead.
function resolveThresholdModel(itemCount){
  const settingsVal=(typeof appSettings!=='undefined')?appSettings.model:undefined;
  if(settingsVal && settingsVal!=='optimized') return null; // user has an explicit choice — don't touch it
  if(itemCount<4) return null;
  const provider=(typeof appSettings!=='undefined'&&appSettings.provider)?appSettings.provider:'anthropic';
  const tierMap=TIER_MODEL_BY_PROVIDER[provider]||TIER_MODEL_BY_PROVIDER.anthropic;
  return tierMap.lightweight || _MODEL_FALLBACK_BY_PROVIDER[provider] || _MODEL_FALLBACK_BY_PROVIDER.anthropic;
}

// ── v9.13: AI usage-tracking model-selection provenance ──
// Same precedence as resolveModel() below, but also returns WHY a model was
// chosen, not just which one — needed so mt_ai_usage_events can distinguish
// "Optimized picked this" from "user explicitly chose this" from "batch-size
// logic forced this," which a bare model string can't do on its own.
// resolveModel() becomes a thin wrapper so none of its ~15+ existing call
// sites need to change.
//
// overrideSource: passed by the CALLER when modelOverride is non-null, so
// this function doesn't have to guess why an override was supplied. If a
// caller passes a modelOverride without a source, this correctly falls back
// to 'explicit_override_unclassified' — an honest "don't know," not a
// silent mislabel as 'batch_threshold_override'. Only feature-canvas.js's
// confirmed resolveThresholdModel() call site currently supplies a source;
// any other modelOverride-passing call site not yet audited will show up
// as 'explicit_override_unclassified' in the data, a visible gap rather
// than a wrong answer.
// v9.14: provider-aware. Precedence chain is unchanged in shape:
// 1. modelOverride wins outright (as before).
// 2. User's explicit Settings pin (appSettings.model !== 'optimized') wins (as before).
// 3. CALLER_TIERS[caller] -> TIER_MODEL_BY_PROVIDER[provider][tier] — new
//    two-step lookup replacing the old single-step CALLER_MODEL_DEFAULTS[caller].
// 4. _MODEL_FALLBACK_BY_PROVIDER[provider] — provider-aware fallback,
//    replacing the old single hardcoded _MODEL_FALLBACK.
// Return shape gains `provider` so downstream usage-tracking can log which
// provider was actually used without re-deriving it.
function resolveModelDecision(modelOverride, caller, overrideSource){
  const settingsVal=(typeof appSettings!=='undefined')?appSettings.model:undefined;
  const settingsMode=(settingsVal && settingsVal!=='optimized')?'fixed_model':'optimized';
  const provider=(typeof appSettings!=='undefined'&&appSettings.provider)?appSettings.provider:'anthropic';

  if(modelOverride){
    return {
      model: modelOverride,
      provider,
      settingsMode,
      settingsModel: settingsMode==='fixed_model'?settingsVal:null,
      selectionRule: overrideSource || 'explicit_override_unclassified'
    };
  }
  if(settingsMode==='fixed_model'){
    return { model: settingsVal, provider, settingsMode, settingsModel: settingsVal, selectionRule: 'user_selected_model' };
  }
  const tier=CALLER_TIERS[caller];
  const tierMap=TIER_MODEL_BY_PROVIDER[provider]||TIER_MODEL_BY_PROVIDER.anthropic;
  const tierModel=tier?tierMap[tier]:null;
  if(tierModel){
    return { model: tierModel, provider, settingsMode, settingsModel: null, selectionRule: 'optimized_caller_default' };
  }
  // Covers both "caller has no tier assignment" and "tier resolved to null"
  // (e.g. a provider with no premium tier — see TIER_MODEL_BY_PROVIDER)
  // — never silently return null/undefined as a model string to send upstream.
  const fallback=_MODEL_FALLBACK_BY_PROVIDER[provider]||_MODEL_FALLBACK_BY_PROVIDER.anthropic;
  return { model: fallback, provider, settingsMode, settingsModel: null, selectionRule: 'optimized_fallback_default' };
}

function resolveModel(modelOverride, caller){
  return resolveModelDecision(modelOverride, caller, null).model;
}

// ── Shared tab-pending indicator ──
// Marks a tab with a purple dot to signal "new content sent here, not yet
// viewed". Cleared automatically the first time the user visits that tab
// (see switchTab below). Used for the DM->CC, CC->FC, FC->SC, SC->PI handoffs.
function markTabPending(tabId){
  const dot=document.getElementById('tab-'+tabId+'-dot');
  if(dot)dot.classList.add('on');
}
function clearTabPending(tabId){
  const dot=document.getElementById('tab-'+tabId+'-dot');
  if(dot)dot.classList.remove('on');
}

function switchTab(t){
  if(blockIfGenerating(()=>switchTab(t)))return;
  // v9.15.03, Item 1 — checked BEFORE curTab is reassigned below, since the
  // guard itself needs to compare curTab (the tab being left) against t
  // (the tab being entered).
  if(typeof blockIfLeavingGuidedLaunch==='function'&&blockIfLeavingGuidedLaunch(t))return;
  const prev=curTab;
  curTab=t;
  // Phase 3a (v8.126): Home poll only runs while Home is actually visible —
  // started in homeInit()/homeOnTabEnter(), stopped here on the way out.
  if(prev==='home'&&t!=='home'&&typeof _lsHomePollStop==='function'){
    _lsHomePollStop();
  }
  // Item 8: no reason to make a collaborator wait up to 5 minutes if the
  // user's clearly done editing and has moved on to another tab.
  if(prev==='pi'&&t!=='pi'&&typeof _lsFlushManualEditOnTabLeave==='function'){
    _lsFlushManualEditOnTabLeave('pi');
  }
  // Item 2: same principle, extended to Capability Canvas.
  if(prev==='cc'&&t!=='cc'&&typeof _lsFlushManualEditOnTabLeave==='function'){
    _lsFlushManualEditOnTabLeave('cc');
  }
  // Build B: same principle, extended to Story Canvas and Prototype Canvas.
  if(prev==='sc'&&t!=='sc'&&typeof _lsFlushManualEditOnTabLeave==='function'){
    _lsFlushManualEditOnTabLeave('sc');
    _lsFlushManualEditOnTabLeave('pc');
  }
  // v9.24 — voice dictation must not keep listening once the PM navigates
  // away from the tab that's actually dictating. Originally scoped to
  // prev==='ra' only, back when Requirement Agent was the sole surface with
  // voice input. v9.25 (confirmed via live testing) — generalized to ANY
  // tab switch: Discovery Map, Capability Canvas, Feature Canvas, Outcome
  // Pulse, and Prototype Canvas all attached afterward, and NONE of their
  // own cleanup points (rebuild guards, close handlers, stop-on-send) fire
  // on a plain tab switch with no other action taken first — dictation kept
  // running untouched. voiceStopActive() is a safe no-op regardless of
  // which surface (if any) is actually active, so one unconditional call
  // here covers every current surface and every future one, with no
  // per-surface prev==='xx' condition to remember to add each time.
  if(prev!==t){
    voiceStopActive('abort');
  }
  // Fix 1 (v8.39): update lastTab on user-initiated tab switches, debounced 300ms
  if(typeof _ssRestoring!=='undefined'&&!_ssRestoring&&t!=='home'){
    if(typeof _ssLastTabTimer!=='undefined')clearTimeout(_ssLastTabTimer);
    _ssLastTabTimer=setTimeout(function(){
      if(typeof sessionStoreUpdateLastTab==='function')sessionStoreUpdateLastTab(t);
    },300);
  }
  // v8.43: restore session name visibility on any non-home tab
  if(t!=='home'&&typeof hdrApplySessionNameVisibility==='function'&&(typeof _ssRestoring==='undefined'||!_ssRestoring)){
    hdrApplySessionNameVisibility();
  }
  // Clear any pending-content indicator for the tab being entered
  clearTabPending(t);
  // Close evidence drawer whenever navigating away from KPI tree
  if(t!=='mm'&&typeof dvCloseEvidenceDrawer==='function')dvCloseEvidenceDrawer();
  // Close DD panel on every tab switch
  if(typeof ccCloseDDPanel==='function')ccCloseDDPanel();
  // Update all tab buttons — includes home, fc (Feature Canvas) and sc (Story Canvas)
  ['mm','cc','pi','arp','mi','la','fc','sc','op','gl','ra','home'].forEach(id=>{
    const el=document.getElementById('tab-'+id);
    if(el)el.classList.toggle('active',t===id);
  });
  const ob=document.getElementById('out-body');
  const fcTab=document.getElementById('fc-tab');
  const scTab=document.getElementById('sc-tab');
  const laTab=document.getElementById('la-tab');
  const miTab=document.getElementById('mi-tab');
  const ccTab=document.getElementById('cc-tab');
  const piTab=document.getElementById('pi-tab');
  const arpTab=document.getElementById('rc-canvas');
  const opTab=document.getElementById('op-tab');
  const glTab=document.getElementById('gl-tab');
  const raTab=document.getElementById('ra-tab');
  const homeTab=document.getElementById('home-tab');
  const lp=document.getElementById('left-panel');

  // Show/hide main content areas
  if(homeTab)homeTab.style.display=(t==='home')?'flex':'none';
  ob.style.display=(t==='mm')?'':'none';
  if(fcTab)fcTab.classList.toggle('on',t==='fc');
  if(scTab)scTab.classList.toggle('on',t==='sc');
  if(laTab)laTab.classList.toggle('on',t==='la');
  if(miTab)miTab.classList.toggle('on',t==='mi');
  if(ccTab)ccTab.classList.toggle('on',t==='cc');
  if(piTab)piTab.classList.toggle('on',t==='pi');
  if(arpTab)arpTab.classList.toggle('on',t==='arp');
  if(opTab)opTab.classList.toggle('on',t==='op');
  if(glTab)glTab.classList.toggle('on',t==='gl');
  if(raTab)raTab.classList.toggle('on',t==='ra');

  // Left panel: hidden on all tabs except mm post-launch (handled in mm case above)
  // For all non-mm tabs, always hide old left panel — Home has its own, others don't use it
  if(t!=='mm'){
    if(lp) lp.classList.add('sc-hidden');
  }

  if(t==='home'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    // v8.43: hide session name on Home without destroying its value
    if(typeof hdrApplySessionNameVisibility==='function'&&(typeof _ssRestoring==='undefined'||!_ssRestoring)){
      hdrApplySessionNameVisibility();
    }
    // Clear active session when navigating back to Home from a workflow tab.
    // Saves session to library before wiping — no data loss, fully resumable.
    // Scoped to prev!=='home' to avoid firing when Settings closes while on Home.
    if(sessionActive&&prev!=='home'&&typeof homeClearSession==='function'){
      homeClearSession();
      // Reset product dropdown — only on Home navigation, not on launch/resume/delete
      if(typeof activeProfileId!=='undefined') activeProfileId=null;
      var _prodSel=document.getElementById('home-product-sel');
      if(_prodSel) _prodSel.value='';
      // Reset session setup form fields — clears stale CVC, Additional Context,
      // MI toggle, AI Suggestions toggle, Approach/Mode pills, and manual cap list
      if(typeof _homeResetSetupForm==='function') _homeResetSetupForm();
    }
    // Hide all workflow tabs when on Home — visible only during active non-home tab
    ['tab-mm','tab-cc','tab-mi','tab-la','tab-fc','tab-op'].forEach(function(id){
      const el=document.getElementById(id);
      if(el&&el.style.display!=='none') el.setAttribute('data-home-hidden','1');
      if(el) el.style.display='none';
    });
    // SC and PI use .revealed class — hide them too when on Home
    ['tab-sc','tab-pi','tab-ra','tab-arp'].forEach(function(id){
      const el=document.getElementById(id);
      if(el&&el.classList.contains('revealed')){
        el.setAttribute('data-home-hidden','1');
        el.classList.remove('revealed');
      }
    });
    if(typeof homeOnTabEnter==='function')homeOnTabEnter();
  } else if(t==='mm'){
    // Restore tabs that were hidden when entering Home — only if they were visible before
    ['tab-mm','tab-cc','tab-mi','tab-la','tab-fc','tab-op'].forEach(function(id){
      const el=document.getElementById(id);
      if(el&&el.getAttribute('data-home-hidden')==='1'){
        el.style.display='';
        el.removeAttribute('data-home-hidden');
      }
    });
    // Restore SC and PI revealed state if they were hidden on Home entry
    ['tab-sc','tab-pi','tab-ra','tab-arp'].forEach(function(id){
      const el=document.getElementById(id);
      if(el&&el.getAttribute('data-home-hidden')==='1'){
        el.classList.add('revealed');
        el.removeAttribute('data-home-hidden');
      }
    });
    // Show session summary in left panel if session is active; hide otherwise
    const lp=document.getElementById('left-panel');
    if(sessionActive&&typeof mmRenderSessionPanel==='function'){
      mmRenderSessionPanel();
      // v8.44: sync left panel session name after mmRenderSessionPanel rebuilds #mm-ph-sub
      if(typeof mmUpdateSessionName==='function'){
        var _hdrEl=document.getElementById('hdr-product-name');
        var _hdrName=_hdrEl?(_hdrEl.textContent||'').trim():'';
        if(_hdrName)mmUpdateSessionName(_hdrName);
      }
    } else if(lp){
      lp.classList.add('sc-hidden');
    }
    if(gData){
      document.getElementById('mm-out').classList.add('on');
      // Hide empty state whenever gData exists — covers restore path where es was not hidden
      const esEl=document.getElementById('es');
      if(esEl) esEl.style.display='none';
      // Render DM tree if not yet rendered — covers resume from CC/FC where renderMM was never called
      const mmOut=document.getElementById('mm-out');
      if(mmOut&&!mmOut.querySelector('.mm-north-star')&&typeof renderMM==='function'){
        renderMM(gData);
        if(typeof mmRenderSessionPanel==='function'){
          mmRenderSessionPanel();
      // v8.44: sync left panel session name after mmRenderSessionPanel rebuilds #mm-ph-sub
      if(typeof mmUpdateSessionName==='function'){
        var _hdrEl=document.getElementById('hdr-product-name');
        var _hdrName=_hdrEl?(_hdrEl.textContent||'').trim():'';
        if(_hdrName)mmUpdateSessionName(_hdrName);
      }
        }
      }
      // Always re-paint evidence dots on mm tab entry — dots are DOM-only and lost on tab switch
      if(typeof kpiRenderEvidenceStates==='function') kpiRenderEvidenceStates();
    }
    const bar=document.getElementById('diag-action-bar');
    if(bar){
      bar.style.display='';
    } else if(gData&&typeof renderDiagnosticActionBar==='function'){
      // Bar was removed by homeClearSession on session change — re-render it
      renderDiagnosticActionBar();
    }
  }else if(t==='cc'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof ccOnTabEnter==='function')ccOnTabEnter();
  }else if(t==='pi'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof piOnTabEnter==='function')piOnTabEnter();
  }else if(t==='arp'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof rcOnTabEnter==='function')rcOnTabEnter();
  }else if(t==='mi'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof miGenerating!=='undefined'&&miGenerating) return;
    const miTabEl2=document.getElementById('mi-tab');
    if(!miGenerated){
      miRenderEmpty();
    } else {
      if(!miTabEl2||!miTabEl2.querySelector('.mi-layout')){
        miRenderScreen();
      } else {
        miRenderLeftPanel();
      }
    }
  }else if(t==='la'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(productLeakAnalysis)laRenderAnalysis();
  }
  // Feature Canvas tab entry
  if(t==='fc'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof fcRenderCapNav==='function')fcRenderCapNav();
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    // Always reveal SC/PI tabs when entering FC if their data exists
    const scTabReveal=document.getElementById('tab-sc');
    if(scTabReveal&&typeof scCanvas!=='undefined'&&scCanvas.some(f=>f.stories&&f.stories.length>0))scTabReveal.classList.add('revealed');
    const piTabReveal=document.getElementById('tab-pi');
    if(piTabReveal&&typeof featPI!=='undefined'&&featPI&&typeof piPlans!=='undefined'&&Array.isArray(piPlans)&&piPlans.length>0)piTabReveal.classList.add('revealed');
    const arpTabReveal=document.getElementById('tab-arp');
    if(arpTabReveal&&typeof piReadinessPlans!=='undefined'&&Array.isArray(piReadinessPlans)&&piReadinessPlans.length>0)arpTabReveal.classList.add('revealed');
  }
  // Story Canvas tab entry
  if(t==='sc'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof newScRender==='function')newScRender();
  }
  // Outcome Pulse tab entry
  if(t==='op'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof opRender==='function')opRender();
  }
  // Guided Launch tab entry (Item 19) — matches the same per-branch hide
  // already applied for every other non-mm tab above; gl's own render
  // (glRenderShell/glRenderChatHistory/glRenderMdBody) is triggered
  // directly by guided-launch.js's glCreateAndOpen() or, on resume, by
  // session-store.js's sessionStoreRestore() -> glApplyRestoredSnapshot(),
  // not from here.
  if(t==='gl'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
  }
  // Requirement Agent tab entry (v9.16) — ra's own render (raRenderShell/
  // raRenderConversationList/raRenderChatHistory/raRenderLiveDraft) is
  // triggered directly by requirement-agent.js's raOnTabEnter(), same
  // per-branch hide-diag-bar convention every other non-mm tab above uses.
  if(t==='ra'){
    const bar=document.getElementById('diag-action-bar');
    if(bar)bar.style.display='none';
    if(typeof raOnTabEnter==='function')raOnTabEnter();
  }
  // Close export dropdowns when switching tabs
  const expDrop=document.getElementById('sc-export-drop');
  if(expDrop)expDrop.classList.remove('open');
  const fcExpDrop=document.getElementById('fc-export-drop');
  if(fcExpDrop)fcExpDrop.classList.remove('open');
  const nscFilterDrop=document.getElementById('nsc-filter-drop');
  if(nscFilterDrop)nscFilterDrop.classList.remove('open');
}

// Reveal a new tab (show it in the tab row) and navigate to it
function revealAndSwitchTab(tabId){
  const el=document.getElementById('tab-'+tabId);
  if(el){
    // Use class pattern for tab-gated tabs (sc, pi); style.display for others (dv, la, mi)
    if(el.classList.contains('tab-gated')){
      el.classList.add('revealed');
    } else {
      el.style.display='';
    }
    switchTab(tabId);
  }
}

// ── Direction A loader — vertical timeline ──
function showLoad(stagesConfig){
  document.getElementById('es').style.display='none';
  document.getElementById('er').classList.remove('on');
  document.getElementById('mm-out').classList.remove('on');
  document.getElementById('dd-out').classList.remove('on');
  document.getElementById('dd-ls').classList.remove('on');
  document.getElementById('ls').classList.add('on');

  const stages=stagesConfig||LOADER_STAGES_KPI;

  function buildTimelineHTML(activeIdx){
    const timelineHtml=stages.map((st,i)=>{
      const nodeState=i<activeIdx?'done':i===activeIdx?'active':'pending';
      const isLast=i===stages.length-1;
      return`<div class="mi-loader-stage">
        <div class="mi-loader-stage-left">
          <div class="mi-loader-node ${nodeState}"></div>
          ${!isLast?`<div class="mi-loader-connector ${i<activeIdx?'done':i===activeIdx?'active':''}"></div>`:''}
        </div>
        <div class="mi-loader-stage-right">
          <div class="mi-loader-stage-name ${nodeState}">${st.label}</div>
          ${i===activeIdx?`<div class="mi-loader-submsg" id="ls-submsg">${st.messages[0]}</div>`:''}
        </div>
      </div>`;
    }).join('');
    return`<div id="load-headline" style="font-size:15px;font-weight:600;color:var(--t1);margin-bottom:14px;text-align:center;">${stages[activeIdx].label}…</div>
      <div class="mi-loader-timeline">${timelineHtml}</div>`;
  }

  const stepsEl=document.getElementById('load-steps');
  const subEl=document.getElementById('load-sub');
  if(subEl)subEl.style.display='none';
  if(stepsEl)stepsEl.innerHTML=buildTimelineHTML(0);

  let stageIdx=0,msgIdx=0,msgTimer=null;

  function activateStage(idx){
    stageIdx=idx;msgIdx=0;
    if(stepsEl)stepsEl.innerHTML=buildTimelineHTML(idx);
    const msgs=stages[idx].messages;
    if(msgTimer)clearInterval(msgTimer);
    msgTimer=setInterval(()=>{
      msgIdx=(msgIdx+1)%msgs.length;
      const el=document.getElementById('ls-submsg');
      if(el)el.textContent=msgs[msgIdx];
    },3200);
  }

  activateStage(0);

  window._loaderAdvanceStage=function(){
    if(stageIdx<stages.length-1)activateStage(stageIdx+1);
  };

  ltimer={h:null,s:msgTimer,_clearMsg:()=>{if(msgTimer)clearInterval(msgTimer);}};
}
function hideLoad(){
  if(ltimer){if(ltimer.s)clearInterval(ltimer.s);if(ltimer._clearMsg)ltimer._clearMsg();ltimer=null;}
  window._loaderAdvanceStage=null;
  document.getElementById('ls').classList.remove('on');
  const subEl=document.getElementById('load-sub');
  if(subEl)subEl.style.display='';
}
function showDDLoad(){
  document.getElementById('dd-out').classList.remove('on');
  document.getElementById('dd-ls').classList.add('on');
  let hi=0;
  document.getElementById('dd-load-headline').textContent=DD_HEADS[0];
  document.getElementById('dd-load-sub').textContent=DD_SUBS[0];
  const hT=setInterval(()=>{hi=(hi+1)%DD_HEADS.length;document.getElementById('dd-load-headline').textContent=DD_HEADS[hi];document.getElementById('dd-load-sub').textContent=DD_SUBS[hi%DD_SUBS.length];},3500);
  const sc=document.getElementById('dd-load-steps');
  sc.innerHTML=DD_STEPS.map((s,i)=>`<div class="ls" id="ddlst${i}"><div class="ls-dot"></div>${s}</div>`).join('');
  document.getElementById('ddlst0').classList.add('act');
  let i=0;
  const sT=setInterval(()=>{if(i<DD_STEPS.length-1){document.getElementById('ddlst'+i).classList.remove('act');document.getElementById('ddlst'+i).classList.add('done');i++;document.getElementById('ddlst'+i).classList.add('act');}},3000);
  ddLtimer={h:hT,s:sT};
}
function hideDDLoad(){
  if(ddLtimer){clearInterval(ddLtimer.h);clearInterval(ddLtimer.s);ddLtimer=null;}
  document.getElementById('dd-ls').classList.remove('on');
}

// AI Trace Layer — shared fallback for both callAPI() and callAPIStream()
// below, used only when crypto.randomUUID is unavailable. Replaces the old
// Date.now()+Math.random() fallback (not a valid UUID) — mt_ai_usage_events.
// client_call_id is uuid, NOT NULL (confirmed live against both pgt-dev and
// pgt-prod), so a non-UUID value here would fail that column's type
// constraint on insert. Minimal RFC-4122-shaped UUID v4 generator, no
// external dependency.
function _generateFallbackUuid(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){
    var r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

// extraFields (v9.15, optional 8th param): {session_id, product_id, session_type}.
// Guided Launch passes session_type:'ChatCanvas' so mt_ai_usage_events can
// distinguish its chat-turn costs from Discovery Map generation costs, even
// though both now share the same real mt_sessions row (v9.15.02 unified
// Guided Launch onto mt_sessions — it no longer has a separate table, so
// session_id/product_id here are just its own already-correct values,
// passed explicitly rather than relying on the defaults below). Every other
// caller passes undefined, so those defaults are unchanged for them.
async function callAPI(sys,usr,maxTok,signal,modelOverride,caller,modelOverrideSource,extraFields){
  const key=getKey();

  // ── Proxy URL ─────────────────────────────────────────────────────────────────
  // Hosted: Render proxy via PROXY_URL from env.js.
  // Dev env.js  → pgt-proxy-dev.onrender.com
  // Prod env.js → product-diagnostics-proxy.onrender.com
  // Local dev falls back to localhost:3001 regardless of env.js value.
  // Note: onrender.com must be whitelisted on corporate networks for generation to work.
  // AI Recommendations (home.js) also routes here, not through the Netlify
  // function — rerouted in v9.01 after the Netlify Function URL was found
  // to be blocked by HCL's corporate gateway ("Suspicious" category, keyed
  // on "anthropic" in the path); see home.js's own call site for the full
  // history. This comment previously claimed the opposite and was stale.
  const host=window.location.hostname;
  const isLocal=host===''||host==='localhost'||host==='127.0.0.1';
  const LOCAL_PROXY_URL='http://localhost:3001/api/anthropic';
  const hostedProxyUrl=(typeof PROXY_URL!=='undefined'&&PROXY_URL)?PROXY_URL:'https://product-diagnostics-proxy.onrender.com/api/anthropic';

  // ── JWT token ─────────────────────────────────────────────────────────────────
  // authGetFreshToken() guarantees a non-expired token: getSession() first,
  // then forced refreshSession() if within the 90s expiry margin, then login
  // redirect if both fail. Fixes "Session expired or invalid" on Render proxy
  // after overnight use or sign-out + sign-in cycle. (v8.33)
  let authToken = '';
  try {
    if(typeof authGetFreshToken==='function'){
      authToken = await authGetFreshToken();
    }
  } catch(e) {
    console.warn('callAPI: could not retrieve session token', e);
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  // Only attach Authorization when a BYOK key is present.
  // When empty, the proxy uses the org key from its env var.
  // Avoids sending 'Bearer ' (empty) which can cause proxy/log ambiguity.
  if(key && key.trim()) headers['Authorization'] = 'Bearer ' + key.trim();
  if(authToken) headers['X-Auth-Token'] = authToken;

  // v9.13: single decision call — used for both the actual model string sent
  // to Anthropic AND the provenance fields recorded for usage tracking, so
  // the two can never drift apart (e.g. sending model X but recording a
  // different selectionRule than what actually produced X).
  const _decision = resolveModelDecision(modelOverride, caller, modelOverrideSource);

  // Stable per-call id, generated once client-side. Lets the future usage
  // dashboard correlate a single logical call even if retried, without
  // relying on server-generated ids alone. crypto.randomUUID() is available
  // in all evergreen browsers this app targets; the fallback only matters
  // for an environment lacking it entirely.
  // A caller that needs this id back afterward (to invoke the Yield
  // report-back endpoint, POST /api/usage-events/units-generated) may supply
  // its own via extraFields.client_call_id — this function has no return-shape
  // change to expose one otherwise (it returns a bare string). Every other
  // caller omits this field and gets the same auto-generated id as before.
  const _clientCallId=(extraFields&&extraFields.client_call_id)?extraFields.client_call_id:(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():_generateFallbackUuid();

  const body = JSON.stringify({
    model:_decision.model,
    max_tokens:maxTok,
    system:sys,
    messages:[{role:'user',content:usr}],
    _caller:caller||'',
    company_id:(function(){ try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; } })(),
    // v9.13: AI usage-tracking fields — read here, stripped by server.js
    // before forwarding to Anthropic (never part of anthropicBody there).
    product_id:(extraFields&&extraFields.product_id!=null)?extraFields.product_id:((typeof activeProfileId!=='undefined')?activeProfileId:null),
    session_id:(extraFields&&extraFields.session_id!=null)?extraFields.session_id:((typeof _activeSessionId!=='undefined')?_activeSessionId:null),
    session_type:(extraFields&&extraFields.session_type)?extraFields.session_type:null,
    client_call_id:_clientCallId,
    // AI Trace Layer — client_trace_id is the only trace-continuation key
    // (Invariant 2); agent_name is required server-side whenever it's
    // present. Every caller that doesn't supply these gets null for both,
    // same as every other optional extraFields entry.
    client_trace_id:(extraFields&&extraFields.client_trace_id!=null)?extraFields.client_trace_id:null,
    agent_name:(extraFields&&extraFields.agent_name!=null)?extraFields.agent_name:null,
    settings_mode:_decision.settingsMode,
    settings_model:_decision.settingsModel,
    selection_rule:_decision.selectionRule,
    prompt_version:(typeof PROMPT_VERSIONS!=='undefined'&&PROMPT_VERSIONS[caller])?PROMPT_VERSIONS[caller]:null,
    // v9.14: the client's believed provider — useful for diagnostics/logging
    // only. The proxy does NOT trust this for dispatch, billing, or
    // usage-attribution; it independently resolves the company's actual
    // configured provider server-side and that value always wins (see
    // proxy/server.js's requireActiveCompanyMember + provider resolution).
    provider:_decision.provider
  });

  let r;
  if(isLocal){
    r=await fetch(LOCAL_PROXY_URL,{method:'POST',headers,body,signal});
  }else{
    r=await fetch(hostedProxyUrl,{method:'POST',headers,body,signal});
  }

  const data=await r.json().catch(function(){
    // Proxy returned non-JSON (HTML timeout page or platform error)
    throw new Error('Generation timed out or proxy unavailable. Please try again.');
  });
  if(data.error){
    throw new Error(_pgtAnthropicErrorMessage(data.error));
  }
  // v9.14: provider-neutral response envelope — the proxy's adapter layer
  // (proxy/providerAdapters.js) normalizes every provider's response shape
  // to {text, ...} before it reaches the client, so this line is the same
  // regardless of which provider actually ran. Previously read
  // data.content[0].text (Anthropic Messages API's raw shape directly).
  return data.text||'';
}

// ── Streaming variant (v-next, Requirement Agent only, opt-in) ──
// Sibling to callAPI() above, NOT a replacement — every other caller keeps
// using callAPI() untouched. Same request-building (model resolution, auth
// headers, body fields) but adds `stream:true` to the body, which is what
// makes proxy/server.js route into _handleStreamingRequest() instead of its
// default buffered path (see that file's comment on the opt-in gate).
// Reads the proxy's own normalized SSE contract (`data: {"delta":"..."}`
// chunks, ending in `data: {"done":true}` or `data: {"error":true,...}`) —
// this is NOT the raw provider SSE format, that translation already happened
// server-side per-adapter, so this function needs zero per-provider logic.
// onDelta(text) fires once per chunk as it streams in, for live rendering;
// the function resolves to the full concatenated text once `done` arrives,
// matching callAPI()'s own return shape (a plain string) so callers can
// treat the result identically once streaming finishes.
async function callAPIStream(sys,usr,maxTok,signal,modelOverride,caller,modelOverrideSource,extraFields,onDelta){
  const key=getKey();
  const host=window.location.hostname;
  const isLocal=host===''||host==='localhost'||host==='127.0.0.1';
  const LOCAL_PROXY_URL='http://localhost:3001/api/anthropic';
  const hostedProxyUrl=(typeof PROXY_URL!=='undefined'&&PROXY_URL)?PROXY_URL:'https://product-diagnostics-proxy.onrender.com/api/anthropic';

  let authToken = '';
  try {
    if(typeof authGetFreshToken==='function'){
      authToken = await authGetFreshToken();
    }
  } catch(e) {
    console.warn('callAPIStream: could not retrieve session token', e);
  }

  const headers = { 'Content-Type': 'application/json' };
  if(key && key.trim()) headers['Authorization'] = 'Bearer ' + key.trim();
  if(authToken) headers['X-Auth-Token'] = authToken;

  const _decision = resolveModelDecision(modelOverride, caller, modelOverrideSource);
  // AI Trace Layer build-gate #5 — this previously always generated its own
  // id, ignoring any extraFields.client_call_id override the caller
  // supplied, unlike callAPI()'s own check just above. Now matches that
  // pattern exactly.
  const _clientCallId=(extraFields&&extraFields.client_call_id)?extraFields.client_call_id:(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():_generateFallbackUuid();

  const body = JSON.stringify({
    model:_decision.model,
    max_tokens:maxTok,
    system:sys,
    messages:[{role:'user',content:usr}],
    _caller:caller||'',
    company_id:(function(){ try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; } })(),
    product_id:(extraFields&&extraFields.product_id!=null)?extraFields.product_id:((typeof activeProfileId!=='undefined')?activeProfileId:null),
    session_id:(extraFields&&extraFields.session_id!=null)?extraFields.session_id:((typeof _activeSessionId!=='undefined')?_activeSessionId:null),
    session_type:(extraFields&&extraFields.session_type)?extraFields.session_type:null,
    client_call_id:_clientCallId,
    client_trace_id:(extraFields&&extraFields.client_trace_id!=null)?extraFields.client_trace_id:null,
    agent_name:(extraFields&&extraFields.agent_name!=null)?extraFields.agent_name:null,
    settings_mode:_decision.settingsMode,
    settings_model:_decision.settingsModel,
    selection_rule:_decision.selectionRule,
    prompt_version:(typeof PROMPT_VERSIONS!=='undefined'&&PROMPT_VERSIONS[caller])?PROMPT_VERSIONS[caller]:null,
    provider:_decision.provider,
    stream:true
  });

  const url=isLocal?LOCAL_PROXY_URL:hostedProxyUrl;
  const r=await fetch(url,{method:'POST',headers,body,signal});

  // Non-streaming error response (e.g. auth/validation failure before the
  // proxy ever switches to text/event-stream) — same shape callAPI() handles.
  const contentType=(r.headers.get('content-type')||'');
  if(contentType.indexOf('text/event-stream')===-1){
    const data=await r.json().catch(function(){
      throw new Error('Generation timed out or proxy unavailable. Please try again.');
    });
    if(data.error) throw new Error(_pgtAnthropicErrorMessage(data.error));
    return data.text||'';
  }

  const reader=r.body.getReader();
  const decoder=new TextDecoder();
  let buffer='',fullText='';
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    buffer+=decoder.decode(value,{stream:true});
    const events=buffer.split('\n\n');
    buffer=events.pop();
    for(const evt of events){
      const line=evt.split('\n').find(function(l){return l.indexOf('data:')===0;});
      if(!line)continue;
      let parsed;
      try{ parsed=JSON.parse(line.slice(5).trim()); }catch(e){ continue; }
      if(parsed.error){
        throw new Error(parsed.message||'Stream was interrupted. Please try again.');
      }
      if(parsed.delta){
        fullText+=parsed.delta;
        if(typeof onDelta==='function')onDelta(parsed.delta);
      }
      if(parsed.done){
        return fullText;
      }
    }
  }
  return fullText;
}

// Shared between callAPI() and any other direct caller of /api/anthropic
// (currently just home.js's AI Recommendations, which deliberately uses a
// separate same-origin Netlify-function call path rather than callAPI()'s
// cross-origin Render-proxy path — that routing difference exists on
// purpose, for corporate-network compatibility, and must never be merged.
// Only the error-interpretation logic is shared, to avoid the two call
// sites drifting apart on how they handle the same error types.
function _pgtAnthropicErrorMessage(error){
  const _etype=error.type||'';
  const _emsg=error.message||'Unknown error';
  // forbidden_error means the server-side company-membership check (v8.113)
  // rejected this call — most likely because the person was disabled/removed
  // from their active company mid-session. A generic "AI failed" message
  // would be actively misleading here; re-resolving company state is the
  // actually-useful next step, since it corrects local state to match
  // what's really true server-side (e.g. surfacing the zero-company empty
  // state) rather than leaving the person stuck retrying a call that will
  // keep failing for the same reason.
  if(_etype==='forbidden_error'){
    if(typeof _pgtResolveCompany==='function'){
      _pgtResolveCompany().then(function(){
        if(typeof homeInit==='function') homeInit();
      });
    }
    return 'Your access to this company has changed. Refreshing — please try again.';
  }
  const _elabels={'api_error':'Anthropic API error — ','overloaded_error':'Anthropic overloaded — ','invalid_request_error':'Invalid request — ','proxy_error':'Proxy error — ','permission_error':'API key permission error — ','auth_error':'','rate_limit_error':'','usage_stopped':''};
  const _eprefix=_elabels.hasOwnProperty(_etype)?_elabels[_etype]:(_etype?'['+_etype+'] ':'');
  return _eprefix+_emsg;
}

function isValidTree(p){
  // Hard check: must have nsm, stages array with at least 3 valid stages
  if(!p||!p.nsm||!p.stages||!Array.isArray(p.stages))return false;
  const validStages=p.stages.filter(s=>s&&s.id&&s.label&&Array.isArray(s.l1_metrics)&&s.l1_metrics.length>0);
  if(validStages.length<3)return false;
  // Soft check: measurementModel missing triggers amber warning, not a hard error
  if(!p.measurementModel||!p.measurementModel.modelName){
    console.warn('isValidTree: measurementModel missing — banner will show soft warning');
  }
  return true;
}

function parseJSON(txt){
  const clean=txt.replace(/```json|```/g,'').trim();
  try{const p=JSON.parse(clean);if(isValidTree(p))return p;return repairJSON(clean);}catch(e){return repairJSON(clean);}
}
function repairJSON(s){
  let last=s.lastIndexOf('}');
  while(last>0){
    const a=s.substring(0,last+1);let b=0,br=0;
    for(let i=0;i<a.length;i++){if(a[i]==='{')b++;else if(a[i]==='}')b--;if(a[i]==='[')br++;else if(a[i]===']')br--;}
    let c='';for(let i=0;i<br;i++)c+=']';for(let i=0;i<b;i++)c+='}';
    try{const p=JSON.parse(a+c);if(isValidTree(p))return p;}catch(e){}
    last=s.lastIndexOf('}',last-1);
  }
  return null;
}
