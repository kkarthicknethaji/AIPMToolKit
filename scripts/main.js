// ── Header org name renderer ──
// Reads companyProfile.companyName via getOrgName() and updates the header logo slot.
// Shows the org name + separator when set; hides both when empty.
// Called on DOMContentLoaded and after settingsPageSave().
function updateHeaderOrg(){
  const logoEl=document.getElementById('logo-txt');
  const sepEl=document.getElementById('hdr-sep');
  const orgName=typeof getOrgName==='function'?getOrgName():'';
  if(logoEl){logoEl.textContent=orgName;}
  if(sepEl){sepEl.style.display=orgName?'':'none';}
  if(logoEl){logoEl.style.display=orgName?'':'none';}
}

// ── Avatar initials helper ──
// Returns up to two initials: first char of first name + first char of last name.
// Single word → one initial. Empty → '?'.
function _avatarInitials(displayName){
  const parts=(displayName||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length===0)return'?';
  if(parts.length===1)return parts[0][0].toUpperCase();
  return(parts[0][0]+parts[parts.length-1][0]).toUpperCase();
}

// ── Avatar badge — populate from currentUser ──
function updateHeaderAvatar(){
  if(!currentUser)return;
  const badge=document.getElementById('hdr-avatar');
  const nameEl=document.getElementById('hdr-avatar-name');
  const emailEl=document.getElementById('hdr-avatar-email');
  if(badge)badge.textContent=_avatarInitials(currentUser.displayName);
  if(nameEl)nameEl.textContent=currentUser.displayName||'';
  if(emailEl)emailEl.textContent=currentUser.email||'';
}

// ── Avatar dropdown toggle ──
function hdrAvatarToggle(){
  const drop=document.getElementById('hdr-avatar-drop');
  const overlay=document.getElementById('hdr-avatar-overlay');
  if(!drop)return;
  const isOpen=drop.classList.contains('open');
  if(isOpen){
    drop.classList.remove('open');
    overlay.classList.remove('open');
  } else {
    drop.classList.add('open');
    overlay.classList.add('open');
  }
}

// ── Close dropdown ──
function hdrAvatarClose(){
  const drop=document.getElementById('hdr-avatar-drop');
  const overlay=document.getElementById('hdr-avatar-overlay');
  if(drop)drop.classList.remove('open');
  if(overlay)overlay.classList.remove('open');
}

// ── Open My Profile in Settings ──
function hdrOpenProfile(){
  hdrAvatarClose();
  if(typeof openSettingsToSection==='function') openSettingsToSection(0);
}

// ── Sign out ──
function hdrSignOut(){
  hdrAvatarClose();
  if(typeof authSignOut==='function')authSignOut();
}

// ── Cross-tab company-switch sync (Phase 1) ──
// If another tab switches company, this tab's localStorage-cached company id
// goes stale with no other signal. The `storage` event fires in OTHER tabs
// when localStorage changes (never the tab that made the change) — the
// browser's own built-in mechanism for exactly this, not new infrastructure.
// Registered at script-load time, not gated behind DOMContentLoaded, since a
// switch could happen in another tab at any point after this page is open.
window.addEventListener('storage', function(ev){
  if (ev.key === _PGT_ACTIVE_COMPANY_KEY && ev.newValue !== ev.oldValue) {
    window.location.reload();
  }
});

// ── Phase 1: multi-company resolution ──
var _pgtMembershipCount = 0;

// Restored in v8.104 — the gate had been completely non-functional since
// v8.102 removed the company picker along with the only function that ever
// showed it. #pgt-boot-gate defaulted to display:none with nothing setting
// it otherwise; reordering _pgtHideBootGate() alone (a fix considered
// during Phase 2's adversarial review) would have done nothing, since it
// was only ever re-hiding an already-hidden div. This restores genuine
// blocking for the sync window — no picker content needed, just something
// that actually prevents interaction while data loads, closing the real
// gap: the Settings gear (static, always-clickable markup) was reachable
// the entire time company/product data could still hold a stale cache from
// a previous session.
//
// v8.105: the gate now stops short of the header instead of covering the
// full viewport, so the header renders normally (blank org/product name,
// generic avatar placeholder — a normal-looking empty state, not a broken
// one) rather than a completely blank page during loading. Header height is
// measured at call time rather than hardcoded, so this doesn't silently
// drift out of sync if the header's own CSS changes later. Making the
// overlay stop short of the header would otherwise leave the Settings gear
// and avatar dropdown clickable again during loading — the exact bug this
// gate exists to close — so .hdr-r (the wrapper containing both) gets
// pointer-events:none for the same duration, toggled by the same two
// functions rather than tracked separately.
function _pgtShowBootGate(){
  const gate=document.getElementById('pgt-boot-gate');
  if(!gate)return;
  const hdr=document.querySelector('.hdr');
  const hdrHeight=hdr?hdr.getBoundingClientRect().height:0;
  gate.style.top=hdrHeight+'px';
  gate.innerHTML='<div style="font-family:var(--font);font-size:11px;color:var(--t3);">Loading…</div>';
  gate.style.display='flex';
  gate.style.alignItems='center';
  gate.style.justifyContent='center';
  const hdrR=document.querySelector('.hdr-r');
  if(hdrR){ hdrR.style.pointerEvents='none'; hdrR.style.opacity='0.5'; }
}

function _pgtHideBootGate(){
  const gate=document.getElementById('pgt-boot-gate');
  if(gate){ gate.style.display='none'; gate.style.top=''; gate.innerHTML=''; }
  const hdrR=document.querySelector('.hdr-r');
  if(hdrR){ hdrR.style.pointerEvents=''; hdrR.style.opacity=''; }
}

// ── Phase 3: current user's role in the active company ──
// 'admin' | 'member' | 'readonly' | null (null only during the brief
// pre-resolution window the boot gate already blocks interaction during).
// Every gating check elsewhere should test this via _spIsAdmin() /
// _spIsReadOnly() (settings-page.js) or canEditSession() (session-store.js),
// which default to the restrictive UI on anything but an exact match — so
// an unexpected null/undefined here falls through to restrictive, not
// permissive, as a second independent line of defense beyond the boot gate
// already preventing Settings from being reachable this early.
var currentUserRole = null;
// Multi-app platform extension: per-membership access tier ('full_suite' |
// 'control_tower'). Set alongside currentUserRole by _pgtSetActiveCompany()
// below; _pgtResolveCompany() redirects away from this whole app before
// boot completes whenever it's 'control_tower' — see the redirect helper
// further down.
var currentUserAccess = null;

function _pgtSetActiveCompany(companyId, role, lastActiveSessionId, access){
  try{ localStorage.setItem(_PGT_ACTIVE_COMPANY_KEY, companyId); }catch(e){}
  currentUserRole = role || null;
  currentUserAccess = access || null;
  // v8.149 fix (Issue 2): populate the local cache Home reads for "Last
  // Active" from this same membership row — undefined/omitted (the two
  // zero/error branches) leaves it null, correctly meaning "nothing to
  // show," rather than pointing at a stale or wrong session.
  if (typeof _pgtMyLastActiveSessionId !== 'undefined') _pgtMyLastActiveSessionId = lastActiveSessionId || null;
}

// Multi-app platform extension (spec §6): a control_tower-only member must
// not land on this app's own UI, not just be redirected from a landing
// page as an afterthought — this runs from inside the same hard gate
// _pgtResolveCompany() already blocks all other boot code behind. Mirrors
// _pgtResolveCompany()'s own "return false = something else took over,
// stop booting" convention (see the zero-membership branch below) rather
// than inventing a new one.
//
// Escape hatch (fix, §6a.4 Option A): the redirect has one deliberate
// carve-out — a `?screen=team` query param skips it entirely, so an admin
// whose own access is control_tower (a valid, orthogonal combination) can
// still reach Team Management to fix their own access instead of being
// permanently redirected away from the only screen that could undo it.
// This is the link ai-cost-tower.html's avatar dropdown points at ("Team
// Settings"). Safe to leave unconditional on role: a non-admin who adds
// this param manually lands on exactly the same reduced Settings view any
// non-admin already sees (_spVisibleSections() excludes Team Management
// for them regardless) — nothing new is exposed by skipping the redirect
// alone. Real enforcement (blocking Product Studio's AI generation) still
// lives server-side in requireActiveCompanyMember regardless of which
// screen this client is looking at.
function _pgtRedirectIfControlTowerOnly(access){
  if (access !== 'control_tower') return false;
  var params;
  try { params = new URLSearchParams(window.location.search); } catch (e) { params = null; }
  if (params && params.get('screen') === 'team') return false;
  window.location.href = 'ai-cost-tower.html';
  return true;
}

// Resolves which company is active for this login. This is a hard gate —
// see the DOMContentLoaded handler below for why nothing else initializes
// until this returns. Returns true once a valid company id is set and it's
// safe to continue booting; returns false if the zero-company screen has
// taken over instead (boot stops there, by design).
async function _pgtResolveCompany(){
  const client=(typeof authInit==='function')?authInit():null;
  if(!client||!currentUser){ window.location.href='login.html'; return false; }

  const { data: rows, error } = await client
    .from('mt_users_companies')
    .select('company_id, role, access, is_active, joined_at, last_active_session_id, mt_companies(name)')
    .eq('user_id', currentUser.id);

  if(error){
    console.error('_pgtResolveCompany: membership query failed:', error.message);
    // Treated the same as zero memberships (below) rather than a separate
    // blocking screen — see the note there for why no gate exists anymore.
    // Logged to console since this specific case is a genuine query failure,
    // not the ordinary "no company yet" state, and worth being able to spot
    // in DevTools if something's actually wrong.
    _pgtSetActiveCompany('');
    return true;
  }

  const memberships=(rows||[]).filter(function(r){ return r.is_active; });
  _pgtMembershipCount=memberships.length;

  if(memberships.length===0){
    // Deliberately not blocked, per a design correction after initial testing:
    // a full-screen gate here was solving a problem the app already handles —
    // zero companies means zero products, which means the existing empty-state
    // ("nothing set up yet, here's how to start") takes over naturally, the
    // same experience that existed before this feature at all. "Create a New
    // Company" is already always visible in the avatar dropdown as the
    // on-ramp; no separate screen needed to point at it. Known tradeoff,
    // accepted deliberately: someone whose last membership was removed by an
    // admin now sees a plain empty state with no explicit explanation why,
    // rather than a dedicated message — acceptable for a small team where
    // that would likely be communicated directly.
    _pgtSetActiveCompany(''); // no valid company id; downstream code already
                              // no-ops safely on an empty/missing value
    return true;
  }

  if(memberships.length===1){
    _pgtSetActiveCompany(memberships[0].company_id, memberships[0].role, memberships[0].last_active_session_id, memberships[0].access);
    if (_pgtRedirectIfControlTowerOnly(memberships[0].access)) return false;
    return true;
  }

  // 2+ memberships — check localStorage first, per-user validation is
  // inherent here since `memberships` is already scoped to currentUser.id.
  var stored=null;
  try{ stored=localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY); }catch(e){}
  var storedMembership = stored && memberships.find(function(m){ return m.company_id===stored; });
  if(storedMembership){
    _pgtSetActiveCompany(storedMembership.company_id, storedMembership.role, storedMembership.last_active_session_id, storedMembership.access);
    if (_pgtRedirectIfControlTowerOnly(storedMembership.access)) return false;
    return true;
  }

  // No valid stored preference — resolve silently, never ask. Per product
  // decision (v8.102): the interactive picker at login was removed entirely;
  // "Switch Company" in the avatar dropdown is now the only place a company
  // decision ever happens. Two-tier deterministic fallback, in order:
  // 1. Whichever company has this user's most recently saved session — a
  //    real signal of where their current work actually is, not just which
  //    membership is older. Oldest-membership-only was considered and
  //    rejected during adversarial review: someone who barely touches their
  //    original company but does all real work in a later-invited one would
  //    be silently defaulted back to the wrong one every time their stored
  //    preference is lost — new device, cleared cache, incognito.
  // 2. If no session exists in any company yet (brand new memberships,
  //    nothing to compare), fall back to the oldest membership by
  //    joined_at — the only signal left at that point.
  var fallbackCompanyId = null;
  var fallbackRole = null;
  var fallbackAccess = null;
  try {
    const { data: recentSession } = await client
      .from('mt_sessions')
      .select('company_id')
      .eq('user_id', currentUser.id)
      .order('saved_at', { ascending: false })
      .limit(1);
    if (recentSession && recentSession.length &&
        memberships.some(function(m){ return m.company_id===recentSession[0].company_id; })) {
      fallbackCompanyId = recentSession[0].company_id;
    }
  } catch(e) {
    console.warn('_pgtResolveCompany: recent-session lookup failed, falling back to oldest membership:', e);
  }

  if (!fallbackCompanyId) {
    var oldestFirst = memberships.slice().sort(function(a,b){
      return new Date(a.joined_at||0) - new Date(b.joined_at||0);
    });
    fallbackCompanyId = oldestFirst[0].company_id;
    fallbackRole = oldestFirst[0].role;
    fallbackAccess = oldestFirst[0].access;
    var fallbackLastActive = oldestFirst[0].last_active_session_id;
  } else {
    var matched = memberships.find(function(m){ return m.company_id===fallbackCompanyId; });
    fallbackRole = matched ? matched.role : null;
    fallbackAccess = matched ? matched.access : null;
    var fallbackLastActive = matched ? matched.last_active_session_id : null;
  }

  _pgtSetActiveCompany(fallbackCompanyId, fallbackRole, fallbackLastActive, fallbackAccess);
  if (_pgtRedirectIfControlTowerOnly(fallbackAccess)) return false;
  return true;
}

// Shows/hides the Switch Company dropdown item based on membership count
// resolved during boot. Create a New Company is always visible (its markup
// in index.html has no default display:none), so it needs no toggling here.
function _pgtRenderCompanyMenuItems(){
  var switchBtn=document.getElementById('hdr-switch-company-btn');
  if(switchBtn) switchBtn.style.display=(_pgtMembershipCount>=2)?'':'none';
  // AI Cost Control Tower — open to every active member regardless of role
  // (multi-app platform extension; previously admin-only, per v9.28). No
  // conditional left to toggle: always visible, same as Sign Out — Cost
  // Tower's own boot sequence already handles the no-active-company case
  // (its "No Active Company" gate) gracefully on its own.
}

// ── Open AI Cost Control Tower (v9.28) ──
// First use of window.open() anywhere in this codebase (confirmed during
// build-review) — a deliberate new-tab, not a same-tab navigation, so
// in-flight state in this tab (an open generation, unsaved left-panel
// input) is never lost by opening the report. The new page re-derives its
// own auth/company/role context on load (same Supabase session via
// localStorage, same _PGT_ACTIVE_COMPANY_KEY) rather than receiving
// anything via the window.open() call itself.
function hdrOpenCostTower(){
  hdrAvatarClose();
  window.open('ai-cost-tower.html', '_blank');
}

// ── Switch Company (avatar dropdown, only visible at 2+ companies) ──
function hdrOpenSwitchCompany(){
  hdrAvatarClose();
  const client=(typeof authInit==='function')?authInit():null;
  if(!client||!currentUser)return;
  (async function(){
    const { data: rows, error } = await client
      .from('mt_users_companies')
      .select('company_id, role, is_active, mt_companies(name)')
      .eq('user_id', currentUser.id)
      .eq('is_active', true);
    if(error||!rows||rows.length<2)return;

    // Alphabetical, case-insensitive — otherwise rows render in whatever
    // order Postgres happens to return them (unspecified, effectively
    // insertion order). localeCompare's default sensitivity already treats
    // case differences as equal for ordering purposes ("acme" and "Acme"
    // sort together as intended, not split apart by case).
    rows.sort(function(a, b){
      var nameA = (a.mt_companies && a.mt_companies.name) || '';
      var nameB = (b.mt_companies && b.mt_companies.name) || '';
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    });

    var current=null;
    try{ current=localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY); }catch(e){}

    var existing=document.getElementById('pgt-switch-co-overlay');
    if(existing)existing.remove();
    var overlay=document.createElement('div');
    overlay.id='pgt-switch-co-overlay';
    overlay.className='modal-overlay';
    var rowsHtml=rows.map(function(m, idx){
      var isCurrent=(m.company_id===current);
      var name=(m.mt_companies&&m.mt_companies.name)?m.mt_companies.name:'Untitled Company';
      var roleLabel=(m.role==='admin')?'Admin':(m.role==='readonly')?'Read Only':'Power User';
      return '<div id="pgt-switch-choice-'+idx+'" style="border:1px solid '+(isCurrent?'var(--purple)':'var(--divider)')+';background:'+(isCurrent?'var(--purple-pale)':'#fff')+';border-radius:6px;padding:10px 12px;margin-bottom:8px;cursor:'+(isCurrent?'default':'pointer')+';display:flex;align-items:center;justify-content:space-between;">'
        +'<div><div style="font-size:11px;font-weight:700;color:var(--t1);">'+e(name)+'</div><div style="font-size:9px;color:var(--label);font-weight:600;text-transform:uppercase;">'+roleLabel+'</div></div>'
        +(isCurrent?'<i class="ti ti-circle-check" style="color:var(--purple);font-size:16px;" aria-hidden="true"></i>':'')
        +'</div>';
    }).join('');
    overlay.innerHTML='<div class="modal" style="max-width:340px;position:relative;">'
      +'<button onclick="document.getElementById(\'pgt-switch-co-overlay\').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
      +'<div style="padding:20px 20px 12px;"><div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:2px;">Choose a company</div></div>'
      +'<div style="padding:0 20px 20px;">'+rowsHtml+'</div>'
      +'</div>';
    document.body.appendChild(overlay);
    rows.forEach(function(m, idx){
      if(m.company_id===current)return;
      var btn=document.getElementById('pgt-switch-choice-'+idx);
      if(btn) btn.onclick=function(){
        // Reload-during-generation guard, per adversarial review (§3.5) —
        // aiGenInFlight is the existing flag from utils.js's startAiGen/endAiGen.
        if(typeof aiGenInFlight!=='undefined' && aiGenInFlight.active){
          if(!confirm('A generation is in progress \u2014 switching now may lose it. Switch anyway?'))return;
        }
        _pgtSetActiveCompany(m.company_id);
        overlay.remove();
        window.location.reload();
      };
    });
    if(typeof trapFocus==='function')trapFocus(overlay);
  })();
}

// "Create a New Company" (avatar dropdown + its modal) removed in v8.101 —
// the capability moved to login.html, gated behind re-entering a password,
// per an explicit product decision that an always-visible dropdown item was
// too casual for creating a whole separate company. See spec §3.7 and
// auth.js's authCreateCompany() — still the shared primitive, now called
// from the signup flow instead of this dropdown.

// v8.113: a second, narrower entry point — an already-authenticated
// zero-company user (last membership removed, or a fresh account that
// somehow reached the app before ever joining anything) has no company to
// re-authenticate INTO via the signup form's path, and asking someone to
// retype the password of an account they're currently signed into is
// redundant, not a real security boundary. This skips re-authentication
// entirely (they're already proven) and calls authCreateCompany() directly.
function homeOpenCreateCompanyModal(){
  var existing=document.getElementById('pgt-create-co-overlay');
  if(existing)existing.remove();
  var overlay=document.createElement('div');
  overlay.id='pgt-create-co-overlay';
  overlay.className='modal-overlay';
  overlay.innerHTML='<div class="modal" style="max-width:360px;position:relative;">'
    +'<button onclick="document.getElementById(\'pgt-create-co-overlay\').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);" aria-label="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
    +'<div style="padding:20px 44px 4px 20px;"><div style="font-size:13px;font-weight:700;color:var(--t1);margin-bottom:2px;">Create a New Company</div><div style="font-size:10px;color:var(--t3);">You\'ll be its first admin.</div></div>'
    +'<div style="padding:14px 20px 4px;">'
    +'<label style="display:block;font-size:10px;font-weight:700;color:var(--t2);margin-bottom:4px;">Company Name</label>'
    +'<input id="pgt-create-co-name" type="text" placeholder="Acme Retail Co." style="width:100%;box-sizing:border-box;height:32px;border:1px solid var(--divider);border-radius:6px;padding:0 10px;font-size:11px;"/>'
    +'<div id="pgt-create-co-err" style="font-size:9px;color:var(--red);margin-top:5px;display:none;"></div>'
    +'</div>'
    +'<div style="padding:16px 20px 18px;display:flex;justify-content:flex-end;gap:8px;">'
    +'<button onclick="document.getElementById(\'pgt-create-co-overlay\').remove()" class="modal-cancel-btn">Cancel</button>'
    +'<button id="pgt-create-co-submit" onclick="_homeSubmitCreateCompany()" style="background:var(--purple);color:#fff;border:none;border-radius:6px;padding:7px 16px;font-size:11px;font-weight:700;cursor:pointer;">Create</button>'
    +'</div></div>';
  document.body.appendChild(overlay);
  if(typeof trapFocus==='function')trapFocus(overlay);
  var nameInput=document.getElementById('pgt-create-co-name');
  if(nameInput)nameInput.focus();
}

async function _homeSubmitCreateCompany(){
  var nameInput=document.getElementById('pgt-create-co-name');
  var errEl=document.getElementById('pgt-create-co-err');
  var btn=document.getElementById('pgt-create-co-submit');
  var name=(nameInput&&nameInput.value||'').trim();
  errEl.style.display='none';
  if(!name){
    errEl.textContent='Company name is required.';
    errEl.style.display='block';
    return;
  }
  btn.disabled=true;
  btn.textContent='Creating...';
  try{
    var newCompanyId=await authCreateCompany(name);
    _pgtSetActiveCompany(newCompanyId, 'admin');
    var overlay=document.getElementById('pgt-create-co-overlay');
    if(overlay)overlay.remove();
    window.location.reload();
  }catch(err){
    btn.disabled=false;
    btn.textContent='Create';
    errEl.textContent=(typeof err==='string')?err:(err.message||'Could not create company. Please try again.');
    errEl.style.display='block';
  }
}

// ── Global current user ──
// Populated after auth gate passes. Available to all modules.
// { id, email, displayName }
var currentUser = null;

document.addEventListener('DOMContentLoaded', async function(){
  // ── Version string — set from APP_VERSION in config.js ──
  var _vEl=document.getElementById('hdr-version');
  if(_vEl&&typeof APP_VERSION!=='undefined')_vEl.textContent=APP_VERSION;

  // ── Auth gate (Step 2) ──
  // Check for a valid Supabase session before the app initialises.
  // No session → redirect to login.html immediately.
  // Valid session → populate currentUser and continue.
  var session = await authGetSession();
  if (!session) {
    window.location.href = 'login.html';
    return; // stop execution — page is redirecting
  }
  // Populate currentUser for all downstream modules
  currentUser = await authGetUser();

  // ── Phase 1 hard gate ──
  // Company resolution must fully complete — including an indefinite pause
  // if the picker shows — before ANYTHING else below runs. The boot-gate
  // overlay (full-viewport, z-index 9999, in index.html) physically covers
  // the rest of the app shell for the duration, so nothing underneath is
  // reachable while this resolves, regardless of what's already wired.
  // Closes a race identified in adversarial review where auth identity
  // existed but tenant/company context didn't while other boot code could
  // still run in parallel. See spec §3.4.
  var companyResolved = await _pgtResolveCompany();
  if (!companyResolved) return; // zero-company screen has taken over — stop here

  // One-time carry-forward of a pre-v8.105 unscoped BYOK key into whichever
  // company is active now — see auth.js for why this exists.
  if (typeof _migrateByokKeyIfNeeded === 'function') _migrateByokKeyIfNeeded();
  // v9.14: second migration step, run immediately after the one above and
  // in this order deliberately — this carries the (now company-scoped)
  // key forward again, into the new provider-suffixed slot, so a pre-v9.14
  // key survives BOTH migrations in sequence on a user's very first load
  // after this feature ships. See auth.js for why this exists.
  if (typeof _migrateByokKeyToProviderScopeIfNeeded === 'function') _migrateByokKeyToProviderScopeIfNeeded();

  // Genuinely block interaction for the duration of the data sync below —
  // restored in v8.104, see the note on _pgtShowBootGate() for why this
  // matters now in a way it silently stopped mattering after v8.102.
  _pgtShowBootGate();

  // ── Avatar badge (Step 3) ──
  updateHeaderAvatar();
  _pgtRenderCompanyMenuItems();

  // ── App initialisation (Steps 6 + 7) ──
  // Run both syncs in parallel — sessions and profiles are independent queries.
  // Both must complete before homeInit() so the product selector and session list
  // are populated from fresh DB data on first render.
  await Promise.all([
    (typeof sessionStoreSyncFromDB === 'function') ? sessionStoreSyncFromDB() : Promise.resolve(),
    (typeof spSyncProfilesFromDB   === 'function') ? spSyncProfilesFromDB()   : Promise.resolve()
  ]);

  // Boot gate hidden HERE, after data sync completes — moved in v8.104,
  // per external adversarial review during Phase 2 diagnosis. It previously
  // ran immediately after company resolution, before this Promise.all even
  // started, which left the Settings gear (static, always-clickable markup
  // in index.html, not gated by anything else) reachable while
  // companyProfile/productProfiles could still hold a previous session's
  // stale cached data. Before Phase 2, worst case was seeing your own stale
  // data; after Phase 2 (real per-company writes), that same window meant a
  // save during it could write to the wrong company. This was a latent bug
  // in the original hard-gate design, not something Phase 2 introduced —
  // Phase 2 is what made it dangerous rather than cosmetic.
  _pgtHideBootGate();

  // Render org name after profile sync — companyProfile now has fresh DB data
  updateHeaderOrg();

  // Initialise Home tab — replaces loading stub with session library or empty state
  if(typeof homeInit==='function')homeInit();
  // Initialise new seg controls (industry dropdown, user type, operating context)
  // and additional context character counter
  if(typeof initSegControls==='function')initSegControls();
  // Apply feature toggles on load so MI-gated elements respect default off state
  if(typeof applyFeats==='function')applyFeats();

  // ?screen=team — the control_tower escape-hatch's destination (see
  // _pgtRedirectIfControlTowerOnly() above). openSettingsToSection() already
  // falls back to section 0 for a non-admin, so this is safe unconditionally.
  try {
    if (new URLSearchParams(window.location.search).get('screen') === 'team' && typeof openSettingsToSection === 'function') {
      openSettingsToSection(6);
    }
  } catch (e) {}
});
