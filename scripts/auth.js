// ── auth.js — Supabase Auth client ──
// Initialises the Supabase client and exposes all auth functions.
// Loaded by both login.html and index.html.
// Depends on: config.js (AUTH_DOMAIN constant)
// Supabase JS SDK must be loaded via CDN before this file.

// ── Supabase credentials are loaded from scripts/env.js ──
// env.js is NOT included in Claude zips — create it once locally and keep it.
// SUPABASE_URL and SUPABASE_ANON_KEY must be defined before this file loads.

// ── Shared localStorage key for the active company id ──
// Defined here (loaded first, by both login.html and index.html) since it's
// referenced by authSignOut() below, main.js's boot sequence, and
// session-store.js's company-scoped queries.
const _PGT_ACTIVE_COMPANY_KEY = 'pgt_active_company_id';

// ── Shared BYOK sessionStorage key helper (v8.105, provider-scoped v9.14) ──
// The API key was previously stored under one fixed sessionStorage slot,
// shared identically across every company a user belongs to — entering a
// key while working in Company A silently applied it in Company B too, with
// nothing about the storage even aware companies existed. Scoped by the
// active company id since v8.105: each company gets its own independent
// slot. v9.14 adds a provider dimension on top of that existing, working
// scoping — company-scoping itself is NOT being redesigned here (see
// multi-llm-provider-spec-DRAFT.md Section 4.2/2.6 for the record of an
// earlier draft that wrongly assumed company-scoping was the missing piece).
// Defined once here (auth.js loads before api.js, settings.js, and
// settings-page.js — the three files that read/write this) rather than
// duplicated in each.
function _byokKey() {
  const companyId = (function(){ try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; } })();
  const provider = (typeof appSettings !== 'undefined' && appSettings.provider) ? appSettings.provider : 'anthropic';
  return 'hcl_ak_' + (companyId || 'none') + '_' + provider;
}

// One-time migration on first load after v8.105 shipped: if a key exists
// under the old unscoped slot ('hcl_ak') and the new company-scoped slot is
// still empty, carry it forward into whichever company is active right now.
// FIXED in v8.106 — the old key must be cleared after copying it forward,
// not left in place. Leaving it meant this ran again on every subsequent
// company switch, and since every newly-visited company's slot starts
// empty, the old key kept getting copied into every company that had never
// had its own key set — silently defeating the entire point of
// company-scoping, which is exactly what this looked like from the outside:
// "the key is still shared everywhere."
function _migrateByokKeyIfNeeded() {
  try {
    const oldKey = sessionStorage.getItem('hcl_ak');
    if (!oldKey) return;
    const newSlot = _byokKey();
    if (!sessionStorage.getItem(newSlot)) {
      sessionStorage.setItem(newSlot, oldKey);
    }
    sessionStorage.removeItem('hcl_ak');
  } catch(e) {}
}

// v9.14: second migration step, for the shape this feature itself
// introduces. Today's live key shape (v8.105-v9.13) is company-scoped but
// NOT provider-scoped: 'hcl_ak_<companyId>'. _byokKey() above now returns
// 'hcl_ak_<companyId>_<provider>' instead — without this step, every
// existing user's already-entered Anthropic key would be silently orphaned
// on first load after this ships (present under the old slot, but never
// read again since every consumer now goes through the new provider-suffixed
// _byokKey()). Carries the old company-scoped key forward into the new
// '..._anthropic' slot (provider defaults to 'anthropic' pre-migration,
// since that's the only provider that existed before this feature).
// Applies the same v8.106 lesson: the old slot MUST be cleared after
// copying, not left in place, or it will re-copy on every subsequent
// company switch exactly like the original bug this comment describes above.
function _migrateByokKeyToProviderScopeIfNeeded() {
  try {
    const companyId = (function(){ try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; } })();
    const oldSlot = 'hcl_ak_' + (companyId || 'none'); // pre-v9.14 shape, no provider suffix
    const oldKey = sessionStorage.getItem(oldSlot);
    if (!oldKey) return;
    const newSlot = _byokKey(); // provider defaults to 'anthropic' when appSettings.provider is unset
    if (!sessionStorage.getItem(newSlot)) {
      sessionStorage.setItem(newSlot, oldKey);
    }
    sessionStorage.removeItem(oldSlot);
  } catch(e) {}
}

// ── Client singleton ──
var _supabase = null;

// Initialise the Supabase client. Called once on page load.
function authInit() {
  if (_supabase) return _supabase;
  if (typeof window.supabase === 'undefined' || typeof window.supabase.createClient === 'undefined') {
    console.error('auth.js: Supabase SDK not loaded. Check CDN script tag.');
    return null;
  }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

// ── Sign In ──
// Returns { user, session } on success.
// Throws a user-readable error string on failure.
async function authSignIn(email, password) {
  const client = authInit();
  if (!client) throw 'Auth client not initialised. Check Supabase credentials.';

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    // Map Supabase error codes to user-readable messages
    if (error.message && error.message.toLowerCase().includes('invalid login')) {
      throw 'Wrong email or password. Please try again.';
    }
    if (error.message && error.message.toLowerCase().includes('email not confirmed')) {
      throw 'Email not confirmed. Check your inbox for a confirmation link.';
    }
    throw error.message || 'Sign in failed. Please try again.';
  }
  return data;
}

// ── Sign Up ──
// Validates domain against AUTH_DOMAIN before calling Supabase.
// Returns { user, session } on success.
// Throws a user-readable error string on failure.
async function authSignUp(email, displayName, password) {
  const client = authInit();
  if (!client) throw 'Auth client not initialised. Check Supabase credentials.';

  // Domain validation — client-side guard before any Supabase call
  const domain = (typeof AUTH_DOMAIN !== 'undefined') ? AUTH_DOMAIN : 'hcltech.com';
  if (!email.toLowerCase().endsWith('@' + domain)) {
    throw 'Only @' + domain + ' email addresses are permitted.';
  }

  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName.trim() }
    }
  });

  if (error) {
    if (error.message && error.message.toLowerCase().includes('already registered')) {
      throw 'An account with this email already exists. Sign in instead.';
    }
    if (error.message && error.message.toLowerCase().includes('password')) {
      throw 'Password must be at least 8 characters.';
    }
    throw error.message || 'Account creation failed. Please try again.';
  }

  // Auto sign-in: Supabase returns a session immediately when email confirmation is disabled
  if (!data.session) {
    // Email confirmation is enabled — should not happen in Phase 1 config
    throw 'Account created. Check your email to confirm before signing in.';
  }

  return data;
}

// ── Check Company Name ──
// Calls the proxy's unauthenticated /api/check-company-name endpoint before
// signup or in-app company creation. Never throws — a network failure here
// should not block anything; treated as "no match found," since the create
// call itself (RLS + the RPC) is the actual source of truth, not this check.
// Mirrors api.js's local/hosted routing pattern since PROXY_URL already
// includes the /api/anthropic path and needs stripping to get the base origin.
async function authCheckCompanyName(companyName) {
  const trimmed = (companyName || '').trim();
  if (!trimmed) return false;

  const isLocal = (window.location.hostname === '' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const LOCAL_URL = 'http://localhost:3001/api/check-company-name';
  const hostedBase = (typeof PROXY_URL !== 'undefined' && PROXY_URL)
    ? PROXY_URL.replace(/\/api\/anthropic\/?$/, '')
    : 'https://product-diagnostics-proxy.onrender.com';
  const url = isLocal ? LOCAL_URL : (hostedBase + '/api/check-company-name');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    const data = await res.json();
    return !!(data && data.exists);
  } catch(e) {
    console.warn('authCheckCompanyName: request failed, proceeding as no-match:', e);
    return false;
  }
}

// ── Create Company (atomic) ──
// Calls the create_company_with_admin() RPC — creates the company and makes
// the calling user its admin in a single transaction (fixes a partial-failure
// gap in an earlier two-insert design, per adversarial review). This is a
// shared DB PRIMITIVE only, not a shared workflow — each of its three callers
// (signup completion, the "Create a New Company" modal, zero-company
// recovery) handles its own distinct behavior after this resolves; this
// function does not redirect, close any modal, or touch any UI.
// Returns the new company's uuid. Throws a user-readable string on failure.
async function authCreateCompany(companyName) {
  const client = authInit();
  if (!client) throw 'Auth client not initialised. Check Supabase credentials.';
  const trimmed = (companyName || '').trim();
  if (!trimmed) throw 'Company name is required.';

  const { data, error } = await client.rpc('create_company_with_admin', { p_name: trimmed });
  if (error) throw error.message || 'Could not create company. Please try again.';
  return data; // uuid
}

// ── Sign Out ──
// Signs out, clears local state, redirects to login.html.
async function authSignOut() {
  const client = authInit();
  if (client) {
    await client.auth.signOut();
  }
  // Clear app state from localStorage (Supabase session key cleared by SDK automatically)
  // App session data (pgt_session_*) is preserved — will be re-associated on next login
  // in Step 6 when Supabase becomes the authoritative store.
  // Active-company key IS cleared, added per adversarial review: not because a stale
  // value could grant unauthorized access (the per-user membership check in main.js's
  // boot sequence already prevents that regardless), but so a different person signing
  // in on a shared machine doesn't inherit a hint pointing at someone else's company.
  try { localStorage.removeItem(_PGT_ACTIVE_COMPANY_KEY); } catch(e) {}
  window.location.href = 'login.html';
}

// ── Get current session ──
// Returns the active Supabase session object, or null if not authenticated.
// Used by the auth gate in main.js (index.html).
async function authGetSession() {
  const client = authInit();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) return null;
  return data.session;
}

// ── Get a guaranteed-fresh JWT access token ──
// Used by callAPI() and _homeCallAIRecs() before every proxy request.
// Strategy:
//   1. getSession() — Supabase v2 auto-refreshes if expired; returns cached token if fresh.
//   2. If token is within 90s of expiry (EXPIRY_MARGIN_MS match), force a hard refresh.
//   3. refreshSession() — forces a network round-trip; deduped via refreshInFlight promise
//      so concurrent AI calls don't fan out multiple refresh requests.
//   4. Both failed → session is dead → redirect to login (hosted only; local dev bypassed).
// Returns the access_token string, or '' if local dev / refresh failed before redirect.
var _authRefreshInFlight = null;
async function authGetFreshToken() {
  const client = authInit();
  if (!client) return '';

  const nowSec = Math.floor(Date.now() / 1000);
  const marginSec = 90; // matches Supabase EXPIRY_MARGIN_MS = 3 × 30,000ms

  // Step 1 — getSession() handles most cases including Supabase's own auto-refresh
  try {
    const { data, error } = await client.auth.getSession();
    if (!error && data && data.session && data.session.access_token) {
      const expiresAt = data.session.expires_at; // Unix seconds
      if (expiresAt && (expiresAt - nowSec) > marginSec) {
        return data.session.access_token; // fresh — use it
      }
    }
  } catch(e) {
    console.warn('authGetFreshToken: getSession threw:', e);
  }

  // Step 2 — Token absent, expired, or within margin. Force hard refresh.
  // Dedupe concurrent callers so only one refreshSession() network call fires.
  try {
    if (!_authRefreshInFlight) {
      _authRefreshInFlight = client.auth.refreshSession().finally(function() {
        _authRefreshInFlight = null;
      });
    }
    const { data: rd, error: re } = await _authRefreshInFlight;
    if (!re && rd && rd.session && rd.session.access_token) {
      return rd.session.access_token;
    }
    console.warn('authGetFreshToken: refreshSession failed:', re);
  } catch(e) {
    console.warn('authGetFreshToken: refreshSession threw:', e);
  }

  // Step 3 — Both failed. Session is dead. Redirect to login on hosted only.
  const host = window.location.hostname;
  const isLocal = host === '' || host === 'localhost' || host === '127.0.0.1';
  if (!isLocal) {
    window.location.replace('login.html');
  }
  return '';
}

// ── Get current user ──
// Returns { id, email, displayName } for the signed-in user, or null.
// Populated into the global currentUser in main.js after auth gate passes.
async function authGetUser() {
  const client = authInit();
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  const u = data.user;
  return {
    id:          u.id,
    email:       u.email,
    displayName: (u.user_metadata && u.user_metadata.display_name) || u.email.split('@')[0]
  };
}

// ── Password reset ──
// Sends a reset link to the given email via Supabase.
// Returns true on success, throws on failure.
async function authResetPassword(email) {
  const client = authInit();
  if (!client) throw 'Auth client not initialised.';
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/login.html'
  });
  if (error) throw error.message || 'Password reset failed. Please try again.';
  return true;
}
