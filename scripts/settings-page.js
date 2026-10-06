// ── Settings Page (v6.75) ──
// Renders admin settings as a full-page view replacing the app-shell.
// Entry: openSettingsPage() — called from cfg-btn in header.
// Exit:  closeSettingsPage() — called from Back button, Cancel, Save.
// Save:  settingsPageSave() — writes UI state into appSettings{}, calls applyFeats().
// Note:  v6.75 wires Section 1 (API/model) and Section 2 (modules) into live app state.
//        Section 3 (Output Depth) and Section 4 (PI Defaults) store values in appSettings
//        but prompt/PI wiring is deferred to v6.76.

// ── Phase 3: central permission helper ──
// Single source of truth for "can this person edit admin-only things" —
// used everywhere instead of scattering currentUserRole === 'admin'
// comparisons throughout this file, per external adversarial review.
// Defaults to false on anything but an exact 'admin' match, so an
// unexpected/undefined currentUserRole (shouldn't happen given the boot
// gate, but checked independently anyway) falls through to the restrictive
// UI, never the permissive one.
function _spIsAdmin(){
  return (typeof currentUserRole !== 'undefined') && currentUserRole === 'admin';
}

// v9.09 — mirrors _spIsAdmin() exactly. Read Only gets identical Settings
// access to Power User by design (confirmed decision) — this helper exists
// for use OUTSIDE Settings (Home launch-block, canEditSession()), not for
// any new Settings-section branching. Defaults to false on anything but an
// exact 'readonly' match — fails toward showing more restrictive UI, never less.
function _spIsReadOnly(){
  return (typeof currentUserRole !== 'undefined') && currentUserRole === 'readonly';
}

// ── Current section tracker ──
let _spSection = 0;
// ── Dirty state tracker ──
let _spDirty = false;
// ── Old-format doc migration flag ──
let _spOldDocMigrationDirty = false;

// ── Profile persistence helpers ──
// companyProfile and productProfiles are in-memory vars (state.js).
// These helpers sync them to localStorage (fast cache) and Supabase (authoritative).
// Phase 2 (v8.104): cache keys and DB reads/writes are now scoped by the
// active company id, not the user — company/product data belongs to a
// company, not to whoever happens to be looking at it. Falls back to an
// unscoped suffix if no active company is set yet (should only happen in
// the brief window before company resolution completes).
function _spGetActiveCompanyId() {
  try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; }
}
function _spCoKey(companyId)  { return 'pgt_company_profile_'  + (companyId || 'none'); }
function _spPpKey(companyId)  { return 'pgt_product_profiles_' + (companyId || 'none'); }
function _spSettingsKey(companyId) { return 'pgt_company_settings_' + (companyId || 'none'); }

// ── Translation layer — DB row shape <-> in-app profile shape ──
// One place each field gets renamed, per adversarial review: scattering
// manual Object.assign renames across restore/save/sync is exactly how this
// class of bug recurs the next time a field is added to either table.
function _spMapCompanyFromDB(row) {
  if (!row) return {};
  return {
    companyName:     row.name || '',
    companyIndustry: row.industry || '',
    companyUrl:      row.url || '',
    companyRefLink:  row.ref_link || '',
    companyStrategy: row.strategy || '',
    companyContext:  row.context || '',
    companyDocs:     row.docs || []
  };
}
function _spMapCompanyToDB(profile) {
  const stripped = _spStripCoDocs(profile);
  return {
    name:     stripped.companyName || '',
    industry: stripped.companyIndustry || '',
    url:      stripped.companyUrl || '',
    ref_link: stripped.companyRefLink || '',
    strategy: stripped.companyStrategy || '',
    context:  stripped.companyContext || '',
    docs:     stripped.companyDocs || []
  };
}
// mt_products has no columns for icp/kpis/problem/additionalContext/refLink
// — a gap found only while writing this mapping, not present in the
// original Phase 0 schema. Rather than adding five more individual text
// columns (the exact mistake already made and fixed once for mt_companies),
// these are bundled into one JSONB catch-all column, `extra` — see
// phase2-1-add-mt-products-extra-column.sql, required before this code runs.
function _spMapProductFromDB(row) {
  if (!row) return {};
  const extra = row.extra || {};
  return {
    id:                row.id,
    productName:       row.name || '',
    productDesc:       row.description || '',
    productType:       row.type || '',
    industry:          row.industry || '',
    docs:              row.docs || [],
    kpis:              extra.kpis || '',
    problem:           extra.problem || '',
    icp:               extra.icp || '',
    additionalContext: extra.additionalContext || '',
    refLink:           extra.refLink || ''
  };
}
function _spMapProductToDB(profile, companyId) {
  const stripped = _spStripDocs(profile);
  return {
    company_id:  companyId,
    name:        stripped.productName || '',
    description: stripped.productDesc || '',
    type:        stripped.productType || '',
    industry:    stripped.industry || '',
    docs:        stripped.docs || [],
    extra: {
      kpis:              stripped.kpis || '',
      problem:           stripped.problem || '',
      icp:               stripped.icp || '',
      additionalContext: stripped.additionalContext || '',
      refLink:           stripped.refLink || ''
    }
  };
}

// (old unscoped _SP_CO_KEY/_SP_PP_KEY constants removed in v8.104 — replaced
// by the company-scoped _spCoKey()/_spPpKey() functions above)

// ── Strip helpers (hoisted — used by both persist and sync functions) ──
// Remove extractedText before any persistence: too large for localStorage (5MB limit)
// and unnecessary in the DB — only needed at AI call time.
function _spStripDocs(profile) {
  if (!profile) return profile;
  const p = Object.assign({}, profile);
  if (p.docs && p.docs.length) {
    p.docs = p.docs.map(function(d) {
      const d2 = Object.assign({}, d);
      delete d2.extractedText;
      return d2;
    });
  }
  return p;
}
function _spStripCoDocs(co) {
  if (!co) return co;
  const c = Object.assign({}, co);
  if (c.companyDocs && c.companyDocs.length) {
    c.companyDocs = c.companyDocs.map(function(d) {
      const d2 = Object.assign({}, d);
      delete d2.extractedText;
      return d2;
    });
  }
  return c;
}

// _spPersistProfiles() removed in v8.104 — it did one blanket upsert of the
// entire company object and entire products array together, the semantics
// of a JSONB blob, not a relational table. Its three call sites now do
// their own targeted per-row saves directly: spSaveCompanyProfile() below,
// and spP5SaveProfile()/spP5ConfirmDelete() further down this file.

// ── Old-format doc migration ──
// Removes docs missing summaryStatus (old schema pre-v8.58) from all profiles.
// Runs locally only — Supabase cleanup happens on next explicit settings save.
// Idempotent: after first run no old-format docs remain, changed=false, no writes.
function _spMigrateOldDocs(){
  var changed=false;
  if(companyProfile.companyDocs&&companyProfile.companyDocs.length){
    var filtered=companyProfile.companyDocs.filter(function(d){return d.summaryStatus!==undefined;});
    if(filtered.length!==companyProfile.companyDocs.length){
      companyProfile.companyDocs=filtered;
      changed=true;
    }
  }
  productProfiles.forEach(function(p){
    if(p.docs&&p.docs.length){
      // Normalize IDs for any docs that survive migration
      var filtered=p.docs.filter(function(d){return d.summaryStatus!==undefined;});
      filtered.forEach(function(d){if(typeof _ensureSafeDocId==='function')_ensureSafeDocId(d);});
      if(filtered.length!==p.docs.length){p.docs=filtered;changed=true;}
    }
  });
  // v8.87: migrate appSettings.model from the pre-release hardcoded Sonnet
  // value to the new 'optimized' sentinel. Before this release, every user's
  // appSettings.model was 'claude-sonnet-4-6' — it was the only possible
  // value, never a deliberate choice between alternatives. Migrating it
  // silently to 'optimized' lets existing sessions benefit from the new
  // per-caller smart defaults without anyone needing to manually re-open
  // Settings. If a user explicitly picks Sonnet again later, that's a
  // genuine deliberate choice and will correctly override everything from
  // that point forward.
  if(typeof appSettings!=='undefined'&&appSettings.model==='claude-sonnet-4-6'){
    appSettings.model='optimized';
    changed=true;
    console.info('_spMigrateOldDocs: migrated appSettings.model from claude-sonnet-4-6 to optimized.');
  }
  if(changed){
    _spOldDocMigrationDirty=true;
    try{
      var _companyId=_spGetActiveCompanyId();
      localStorage.setItem(_spCoKey(_companyId),JSON.stringify(_spStripCoDocs(companyProfile)));
      localStorage.setItem(_spPpKey(_companyId),JSON.stringify(productProfiles.map(_spStripDocs)));
    }catch(ex){console.warn('_spMigrateOldDocs local persist failed:',ex);}
    console.info('_spMigrateOldDocs: removed old-format docs locally; Supabase cleanup will occur on next explicit settings save.');
  }
  return changed;
}

function _spRestoreProfiles() {
  // Fast-path: reads from localStorage only — called synchronously at script
  // load, before company resolution completes. Per Phase 2 adversarial
  // review, this means the active company id may not be trustworthy yet —
  // _spGetActiveCompanyId() may return '' (the "none" cache slot) or a
  // stale value left over from a previous session. This is an accepted,
  // brief window: main.js's boot gate (restored in v8.104, see main.js)
  // now physically blocks interaction until spSyncProfilesFromDB() below
  // has corrected this with authoritative data, so a stale read here can
  // only ever be *displayed* briefly, never *saved* — nothing capable of
  // triggering a save exists yet at this point in boot.
  try {
    var _companyId = _spGetActiveCompanyId();
    const co = localStorage.getItem(_spCoKey(_companyId));
    const pp = localStorage.getItem(_spPpKey(_companyId));
    if (co) {
      const parsed = JSON.parse(co);
      Object.assign(companyProfile, parsed);
    }
    if (pp) {
      const parsed = JSON.parse(pp);
      if (Array.isArray(parsed)) productProfiles = parsed;
    }
  } catch(e) {
    console.warn('Profile restore failed:', e);
  }
  // Remove old-format docs on restore — local only
  _spMigrateOldDocs();
}

// ── Sync company profile, product profiles, and company settings from
// Supabase (Phase 2, v8.104) ──
// Called once on login from main.js (in Promise.all with sessionStoreSyncFromDB).
// Runs after auth resolves and company is known — updates in-memory state
// and the company-scoped localStorage cache. Three independent queries,
// replacing the single profiles-table query — company/product/settings data
// now lives in mt_companies/mt_products/mt_company_settings, scoped by the
// active company, not the user. On error: logs a warning and leaves current
// state unchanged for that one piece — a failure on one query doesn't block
// the other two from completing.
async function spSyncProfilesFromDB() {
  const client = (typeof authInit === 'function') ? authInit() : null;
  if (!client) return;
  const companyId = _spGetActiveCompanyId();
  if (!companyId) return; // no active company (zero-company state) — nothing to sync

  // Company profile
  try {
    const { data, error } = await client
      .from('mt_companies')
      .select('name, industry, url, ref_link, strategy, context, docs')
      .eq('id', companyId)
      .maybeSingle();
    if (error) {
      console.warn('spSyncProfilesFromDB: mt_companies query failed:', error.message);
    } else if (data) {
      Object.assign(companyProfile, _spMapCompanyFromDB(data));
      try { localStorage.setItem(_spCoKey(companyId), JSON.stringify(_spStripCoDocs(companyProfile))); } catch(e) {}
    }
  } catch(e) {
    console.warn('spSyncProfilesFromDB: mt_companies exception:', e);
  }

  // Product profiles
  try {
    const { data, error } = await client
      .from('mt_products')
      .select('id, name, type, description, industry, docs, extra')
      .eq('company_id', companyId);
    if (error) {
      console.warn('spSyncProfilesFromDB: mt_products query failed:', error.message);
    } else if (data) {
      productProfiles = data.map(_spMapProductFromDB);
      try { localStorage.setItem(_spPpKey(companyId), JSON.stringify(productProfiles.map(_spStripDocs))); } catch(e) {}
    }
  } catch(e) {
    console.warn('spSyncProfilesFromDB: mt_products exception:', e);
  }

  // Company settings (appSettings)
  try {
    const { data, error } = await client
      .from('mt_company_settings')
      .select('settings')
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      console.warn('spSyncProfilesFromDB: mt_company_settings query failed:', error.message);
    } else if (data && data.settings && typeof data.settings === 'object' && Object.keys(data.settings).length > 0) {
      Object.assign(appSettings, data.settings);
      if (typeof featMI !== 'undefined') featMI = appSettings.featMI;
      try { localStorage.setItem(_spSettingsKey(companyId), JSON.stringify(appSettings)); } catch(e) {}
    }
  } catch(e) {
    console.warn('spSyncProfilesFromDB: mt_company_settings exception:', e);
  }

  // Run migration after Supabase sync in case old-format docs came down from DB
  _spMigrateOldDocs();
}

// Restore profiles immediately on script load (before DOMContentLoaded)
// so Home tab product selector is populated when the page first renders.
_spRestoreProfiles();
function spMarkDirty(){_spDirty=true;}
function spResetDirty(){_spDirty=false;}
// ── API key snapshot, taken on open — checkKey() live-writes to
// sessionStorage on every keystroke, so Discard must revert to this
// snapshot rather than re-reading sessionStorage (already overwritten).
// v9.14: now a small map, not a single scalar — the provider dropdown
// live-mutates appSettings.provider/model on change (no-save-required
// preview, per the multi-provider spec's Section 4.1/10.3), so Discard
// needs to revert not just whichever provider's key was edited, but also
// which provider/model was active when Settings was opened.
// Shape: { provider, model, keys: { anthropic: '', openai: '' } }. ──
let _spKeySnapshot = { provider:'anthropic', model:'optimized', keys:{} };

// ── Defaults for restore ──
const _spDefaults3 = { kpiDepth:1, maxCaps:4, includeSubCaps:false, maxFeatures:5, maxStories:5, maxACs:3 };
const _spDefaults4 = { defaultSprints:6, defaultSprintDur:2, defaultSquadName:'Squad', defaultSquadCapacity:80, teamVelocity:'med' };

// ── Available providers/models (v9.14) ──
// _spProviders and _spModelsByProvider now live in scripts/config.js — see
// there for the Anthropic + OpenAI catalog (Gemini deferred to a later
// phase). No local _spModels array here anymore — the flat, single-provider
// list this used to be.

// ── Open settings page ──
function openSettingsPage() {
  settingsOpen = true;
  const shell = document.getElementById('app-shell');
  const page  = document.getElementById('settings-page');
  if(shell) shell.style.display = 'none';
  if(page)  { page.style.display = 'flex'; spRender(); }
  const btn = document.getElementById('cfg-btn');
  if(btn) btn.classList.add('active');
}

// ── Close settings page ──
function closeSettingsPage() {
  settingsOpen = false;
  const shell = document.getElementById('app-shell');
  const page  = document.getElementById('settings-page');
  if(page)  page.style.display = 'none';
  if(shell) shell.style.display = '';
  const btn = document.getElementById('cfg-btn');
  if(btn) btn.classList.remove('active');
  // Refresh Home tab selector/preview if PM was on Home — product profiles may have changed
  if(curTab==='home'&&typeof homeOnTabEnter==='function') homeOnTabEnter();
}

// ── Save company settings (Phase 2, v8.104) ──
// Replaces the direct profiles.settings upsert that used to live inline
// inside settingsPageSave() — a fourth write-site to the old table, found
// only by reading that function line by line rather than trusting its name.
// Single upsert on the one mt_company_settings row for the active company.
async function _spSaveCompanySettings(){
  const companyId = _spGetActiveCompanyId();
  if(!companyId) return { ok:false, message:'No active company. Cannot save.' };

  const client = (typeof authInit === 'function') ? authInit() : null;
  if(!client) return { ok:false, message:'Not connected. Check your network and try again.' };

  try {
    const { error } = await client.from('mt_company_settings').upsert({
      company_id: companyId,
      settings:   JSON.parse(JSON.stringify(appSettings))
    }, { onConflict: 'company_id' });
    if(error){
      return { ok:false, message:error.message };
    }
    try { localStorage.setItem(_spSettingsKey(companyId), JSON.stringify(appSettings)); } catch(e) {}
    return { ok:true };
  } catch(e) {
    return { ok:false, message:'Check your network and try again.' };
  }
}

// ── Save settings (Phase 2, v8.104) ──
// Now async. Company profile and company settings are two independent
// writes to two independent tables — sequential, not parallel: settings is
// only attempted if the company save succeeds, since both require the same
// admin role on the same company, so if the first fails for a permission
// reason the second failing identically right after it is a near-certainty,
// not new information. Neither failure closes the page or discards typed
// values — the person stays in Settings and can retry. This is a real
// behavior change from the old single-table model (which was closer to
// atomic by accident, not by design): partial success is now a reachable
// state, and it's surfaced honestly rather than silently treated as
// complete.
async function settingsPageSave() {
  // Section 1 — API & Access
  const modelEl = document.getElementById('sp-model-select');
  if(modelEl) appSettings.model = modelEl.value;
  const togAis = document.getElementById('sp-tog-ais');
  if(togAis) appSettings.aiStreamingEnabled = _spTogState('ais');
  const togRag = document.getElementById('sp-tog-rag');
  if(togRag) appSettings.raRagEnabled = _spTogState('rag');

  // Section 2 — Feature Modules (read toggle states)
  const togMd = document.getElementById('sp-tog-md');
  const togPd = document.getElementById('sp-tog-pd');
  const togMi = document.getElementById('sp-tog-mi');
  const togPi = document.getElementById('sp-tog-pi');
  const togOp = document.getElementById('sp-tog-op');
  const togRa = document.getElementById('sp-tog-ra');
  if(togMd) appSettings.featDD   = _spTogState('md');
  if(togPd) appSettings.featDiag = _spTogState('pd');
  if(togMi) appSettings.featMI   = _spTogState('mi');
  if(togPi) appSettings.featPI   = _spTogState('pi');
  if(togOp) appSettings.featOutcomePulse = _spTogState('op');
  if(togRa) appSettings.featRA = _spTogState('ra');

  // Section 3 — Output Depth
  const vkdEl = document.getElementById('sp-vkd');
  const vcEl = document.getElementById('sp-vc');
  const vfEl = document.getElementById('sp-vf');
  const vsEl = document.getElementById('sp-vs');
  const vaEl = document.getElementById('sp-va');
  if(vkdEl) appSettings.kpiDepth     = parseInt(vkdEl.textContent) || 1;
  if(vcEl) appSettings.maxCaps      = parseInt(vcEl.textContent) || 4;
  if(vfEl) appSettings.maxFeatures  = parseInt(vfEl.textContent) || 5;
  if(vsEl) appSettings.maxStories   = parseInt(vsEl.textContent) || 5;
  if(vaEl) appSettings.maxACs       = parseInt(vaEl.textContent) || 3;
  appSettings.includeSubCaps = _spTogState('sc');

  // Section 4 — Release Planning Defaults
  const vspEl = document.getElementById('sp-vsp');
  const vdEl  = document.getElementById('sp-vd');
  const vqEl  = document.getElementById('sp-vq');
  const pfxEl = document.getElementById('sp-squad-prefix');
  if(vspEl) appSettings.defaultSprints      = parseInt(vspEl.textContent) || 6;
  if(vdEl)  appSettings.defaultSprintDur    = parseInt(vdEl.textContent)  || 2;
  if(vqEl)  appSettings.defaultSquadCapacity= parseInt(vqEl.textContent)  || 80;
  if(pfxEl) appSettings.defaultSquadName    = pfxEl.value.trim() || 'Squad';
  // Team velocity — find active seg button
  ['low','med','high'].forEach(k => {
    const b = document.getElementById('sp-seg-'+k);
    if(b && b.dataset.active === 'true') appSettings.teamVelocity = k;
  });

  // Save API key to sessionStorage (or clear it if the field was emptied
  // or contains an invalid-format value — e.g. browser-autofilled garbage,
  // confirmed via screen recording to render into this field on page load
  // independent of any user action). Uses the same isValidApiKeyFormat()
  // helper checkKey() already uses, so the two can never independently
  // diverge again.
  const keyEl = document.getElementById('api-key');
  if(keyEl){
    const k = keyEl.value.trim();
    if(k && typeof isValidApiKeyFormat==='function' && isValidApiKeyFormat(k)){
      sessionStorage.setItem(typeof _byokKey==='function'?_byokKey():'hcl_ak', k);
    } else {
      sessionStorage.removeItem(typeof _byokKey==='function'?_byokKey():'hcl_ak');
      if(k) keyEl.value=''; // clear an invalid value from the field itself, don't leave it sitting there
    }
  }

  // Disable Save/Cancel for the duration of the awaited writes below — a
  // second click mid-save would otherwise fire a duplicate request now that
  // saves genuinely take a network round-trip instead of feeling instant.
  _spSetFooterBtns(false);

  // Phase 3 (v8.107): Regular Users have nothing for this button to save.
  // My Profile's own fields (display name, API key) already auto-save
  // independently the moment they change — they never depended on this
  // button. Without this check, clicking Save & Exit while innocently
  // editing My Profile would still attempt the company/settings writes
  // below in the background, correctly rejected by RLS but surfacing a
  // confusing error for something the person never touched or has any
  // rights to change.
  if(!_spIsAdmin()){
    _spSetFooterBtns(true);
    spResetDirty();
    closeSettingsPage();
    return;
  }

  // Step 1 — company profile. Stop here entirely on failure; don't attempt
  // settings at all (see function comment above for why).
  const coResult = await spSaveCompanyProfile();
  if(!coResult.ok){
    _spSetFooterBtns(true);
    if(typeof showToast==='function') showToast(coResult.message || 'Couldn\u2019t save company profile.', 'error');
    return;
  }

  // Apply feature flags to the live app
  if(typeof applyFeats === 'function') applyFeats();

  // Step 2 — company settings (mt_company_settings), only attempted after
  // company profile succeeded.
  const settingsResult = await _spSaveCompanySettings();
  _spSetFooterBtns(true);
  if(!settingsResult.ok){
    if(typeof showToast==='function') showToast('Company profile saved. ' + (settingsResult.message || 'Couldn\u2019t save settings.'), 'error');
    return; // stay in Settings — company profile succeeded, but don't claim full success
  }

  // Refresh header org name in case company name was changed
  if(typeof updateHeaderOrg==='function') updateHeaderOrg();

  // Both writes succeeded — close settings and navigate back
  spResetDirty();
  closeSettingsPage();
  if(typeof showToast === 'function') showToast('Settings saved.', 'success');
}

// ── Cancel — confirm only if dirty, then close ──
function spCancelChanges() {
  if(!_spDirty){closeSettingsPage();return;}
  // Show confirm dialog
  const _ov=document.createElement('div');
  _ov.className='modal-overlay';
  _ov.id='sp-cancel-confirm-overlay';
  _ov.innerHTML=`<div class="modal" style="max-width:360px;position:relative;">
    <div style="padding:16px 16px 12px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:600;color:var(--t1);">Discard changes?</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t2);line-height:1.5;">Your changes won't be saved.</div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sp-cancel-confirm-overlay').remove()">Keep editing</button>
      <button class="modal-confirm-btn" style="background:var(--red);" onclick="spConfirmDiscard()">Discard</button>
    </div>
  </div>`;
  document.body.appendChild(_ov);
}
// Mirrors _byokKey()'s (auth.js) company+provider-scoped key naming, but for
// an explicit provider rather than the live appSettings.provider — needed
// here since the snapshot/restore logic must address a provider that may
// not be the currently-selected one in the dropdown.
function _spByokKeyForProvider(provider){
  const companyId = (function(){ try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; } })();
  return 'hcl_ak_' + (companyId || 'none') + '_' + (provider || 'anthropic');
}

function spConfirmDiscard(){
  const _ov=document.getElementById('sp-cancel-confirm-overlay');
  if(_ov)_ov.remove();
  // Revert any unsaved API key edits back to the values present when
  // Settings was opened, for EVERY provider touched this session (not just
  // whichever provider is currently selected) — checkKey() live-writes to
  // sessionStorage on every keystroke, so sessionStorage may already hold
  // discarded values for more than one provider if the user previewed
  // multiple providers before cancelling.
  (typeof _spProviders!=='undefined'?_spProviders:[{value:'anthropic'}]).forEach(function(p){
    const snapVal = _spKeySnapshot.keys ? _spKeySnapshot.keys[p.value] : undefined;
    const slot = _spByokKeyForProvider(p.value);
    if(snapVal) sessionStorage.setItem(slot, snapVal);
    else sessionStorage.removeItem(slot);
  });
  // Revert the live-mutated provider/model globals too — the dropdown
  // previews these immediately (no-save-required, per spec Section 4.1/10.3),
  // so Cancel must undo that preview, not just the key values.
  if(typeof appSettings!=='undefined'){
    appSettings.provider = _spKeySnapshot.provider || 'anthropic';
    appSettings.model = _spKeySnapshot.model || 'optimized';
  }
  const keyEl=document.getElementById('api-key');
  if(keyEl){
    const revertedVal = (_spKeySnapshot.keys && _spKeySnapshot.keys[appSettings.provider]) || '';
    keyEl.value = revertedVal;
    if(typeof checkKey==='function') checkKey();
  }
  spResetDirty();
  closeSettingsPage();
}

// ── Refresh key status pill (called from checkKey when settings open) ──
function spRefreshKeyStatus() {
  const keyEl = document.getElementById('api-key');
  if(!keyEl) return;
  const pill = document.getElementById('sp-key-status');
  if(!pill) return;
  const k = keyEl.value.trim();
  const isValid  = (typeof isValidApiKeyFormat==='function')?isValidApiKeyFormat(k):(k.startsWith('sk-ant')||k.startsWith('sk-'));
  const isEmpty  = k.length === 0;
  const isInvalid = !isValid && !isEmpty;
  // Three states: valid BYOK (green), empty/org key (green-neutral), invalid format (red)
  if(isValid){
    pill.style.background = '#e6f4f1'; pill.style.color = '#007873';
    pill.innerHTML = '<i class="ti ti-circle-check" style="font-size:9px;"></i> Personal key active';
  } else if(isEmpty){
    pill.style.background = '#e6f4f1'; pill.style.color = '#007873';
    pill.innerHTML = '<i class="ti ti-building" style="font-size:9px;"></i> Organisation key active';
  } else {
    pill.style.background = '#FCE8E8'; pill.style.color = '#A32D2D';
    pill.innerHTML = '<i class="ti ti-alert-circle" style="font-size:9px;"></i> Invalid key format';
  }
  const dot = document.getElementById('api-dot');
  if(dot) dot.classList.toggle('on', isInvalid);
  const wrap = document.getElementById('api-key-wrap');
  if(wrap){
    if(isInvalid){ wrap.style.boxShadow='0 0 0 3px rgba(124,58,237,0.25)'; wrap.style.borderColor='#7C3AED'; }
    else { wrap.style.boxShadow=''; wrap.style.borderColor='#D0D5E8'; }
  }
}

// ── Render full settings page ──
function spRender() {
  const page = document.getElementById('settings-page');
  if(!page) return;
  // v8.113: guards every render, not just explicit spNav() clicks — company
  // membership can change in the background (another tab, a session ending)
  // between when Settings was opened and when it re-renders, and _spSection
  // could be pointing at a section that's no longer visible. Never leave
  // state/focus pointed at a hidden panel.
  if (!_spVisibleSections().includes(_spSection)) {
    _spSection = 0;
  }
  spResetDirty();
  // Snapshot the persisted key(s) before any edits - checkKey() live-writes
  // to sessionStorage on every keystroke, and the provider dropdown
  // live-mutates appSettings.provider/model before Save too (Section 4.1's
  // no-save-required preview) - this is the only point we can capture the
  // "before" state for Discard to revert to, for every provider, not just
  // whichever one happens to be active right now.
  _spKeySnapshot = {
    provider: (typeof appSettings!=='undefined' && appSettings.provider) || 'anthropic',
    model: (typeof appSettings!=='undefined' && appSettings.model) || 'optimized',
    keys: {}
  };
  (typeof _spProviders!=='undefined'?_spProviders:[{value:'anthropic'}]).forEach(function(p){
    _spKeySnapshot.keys[p.value] = sessionStorage.getItem(_spByokKeyForProvider(p.value)) || '';
  });
  page.innerHTML = spBuildHTML();
  // Restore stepper values and toggle states from appSettings
  spPopulate();
  // Track dirty state — any input/change/click inside settings marks it dirty
  page.addEventListener('input', spMarkDirty, {capture:true});
  page.addEventListener('change', spMarkDirty, {capture:true});
  page.addEventListener('click', function _spClickDirty(e){
    // Only mark dirty on interactive elements (not nav, not back button)
    const t=e.target;
    if(t.closest('#sp-restore-btn')||t.closest('[onclick*="spNav"]')||t.closest('[onclick*="closeSettingsPage"]')||t.closest('[onclick*="spCancelChanges"]')||t.closest('[onclick*="settingsPageSave"]'))return;
    if(t.tagName==='BUTTON'||t.tagName==='INPUT'||t.tagName==='SELECT')spMarkDirty();
  },{capture:true});
  // If on Section 1 and the API key is unset, scroll the field into view —
  // the persistent purple ring (rendered inline above) already marks it.
  if(_spSection===0 && !_spKeySnapshot.keys[appSettings.provider]){
    const wrap=document.getElementById('api-key-wrap');
    if(wrap) wrap.scrollIntoView({block:'center'});
  }
  // Team Management (Section 6) fetches and renders itself — not baked into
  // spBuildHTML()'s server-rendered string like other sections, since it
  // needs a live proxy call every time it becomes visible.
  if(_spSection===6 && typeof tmLoad==='function') tmLoad();
}

// ── Phase 3: which sections exist for the current role ──
// Single source of truth, used by spBuildHTML() and spNav() — per external
// adversarial review, confirmed via grep these are the only two places a
// hardcoded section list existed, so this fully replaces both rather than
// leaving one on the old literal.
function _spVisibleSections(){
  // v8.113: zero-company users (membership count 0, distinct from "Regular
  // User of a real company") lose Company Profile and Product Profiles too,
  // not just the admin-only sections — there's nothing coherent to show for
  // a company that doesn't exist. Checked before the admin/non-admin branch
  // since it's a stricter condition that applies regardless of role.
  if (typeof _pgtMembershipCount !== 'undefined' && _pgtMembershipCount === 0) {
    return [0];
  }
  return _spIsAdmin() ? [0,1,2,3,4,5,6] : [0,1,2];
}

function spBuildHTML() {
  return `
  <div style="font-family:'DM Sans',sans-serif;font-size:12px;color:#1a1a1a;background:#EAEEF4;display:flex;flex-direction:column;height:100%;overflow:hidden;">

    <div style="padding:10px 16px 0;flex-shrink:0;">
      <span style="font-size:9px;font-weight:700;color:#6b6b68;font-family:'DM Sans',sans-serif;text-transform:uppercase;letter-spacing:0.7px;">Settings</span>
    </div>

    <div style="display:flex;flex:1;min-height:0;padding:6px 8px 8px;gap:8px;overflow:hidden;">

      <!-- Left nav card -->
      <div style="width:240px;min-width:240px;background:#fff;border:1px solid #D0D5E8;border-radius:7px;display:flex;flex-direction:column;flex-shrink:0;overflow:hidden;">
        <div style="flex:1;display:flex;flex-direction:column;padding-top:4px;">
          ${_spVisibleSections().map(n => spNavItem(n)).join('')}
        </div>
        <div style="height:44px;display:flex;align-items:center;padding:0 14px;border-top:1px solid #D0D5E8;flex-shrink:0;">
          <span style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">Settings</span>
        </div>
      </div>

      <!-- Right content card -->
      <div style="flex:1;background:#fff;border:1px solid #D0D5E8;border-radius:7px;display:flex;flex-direction:column;min-height:0;overflow:hidden;">

        <!-- Section title bar -->
        <div style="padding:12px 20px 11px;border-bottom:1px solid #D0D5E8;flex-shrink:0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div>
            <div id="sp-panel-title" style="font-size:13px;font-weight:700;color:#000;font-family:'DM Sans',sans-serif;">${_spTitle(_spSection)}</div>
            <div id="sp-panel-desc" style="font-size:10px;color:#6b6b68;margin-top:1px;font-family:'DM Sans',sans-serif;min-height:14px;">${_spDesc(_spSection)}</div>
          </div>
          <button id="sp-restore-btn" onclick="spRestoreDefaults()" style="display:${(_spSection===4||_spSection===5)?'flex':'none'};align-items:center;gap:4px;font-size:10px;color:#A5AFBE;background:none;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;white-space:nowrap;padding:2px 0;margin-top:2px;flex-shrink:0;">
            <i class="ti ti-refresh" style="font-size:10px;" aria-hidden="true"></i> Restore defaults
          </button>
        </div>

        <!-- Scrollable content -->
        <div style="flex:1;overflow-y:auto;min-height:0;scrollbar-gutter:stable;" id="sp-scroll-wrap">
          <div id="sp-p0" style="display:${_spSection===0?'block':'none'};padding:2px 20px 16px;">${spP0()}</div>
          <div id="sp-p1" style="display:${_spSection===1?'block':'none'};padding:2px 20px 16px;">${spP1()}</div>
          <div id="sp-p2" style="display:${_spSection===2?'flex':'none'};height:100%;min-height:0;">${spP5()}</div>
          <div id="sp-p3" style="display:${_spSection===3?'block':'none'};padding:2px 20px 16px;">${spP2()}</div>
          <div id="sp-p4" style="display:${_spSection===4?'block':'none'};padding:2px 20px 16px;">${spP3()}</div>
          <div id="sp-p5" style="display:${_spSection===5?'block':'none'};padding:2px 20px 16px;">${spP4()}</div>
          <div id="sp-p6" style="display:${_spSection===6?'block':'none'};padding:10px 20px 16px;"></div>
        </div>

        <!-- Save bar -->
        <div style="height:44px;display:flex;align-items:center;padding:0 20px;gap:8px;border-top:1px solid #D0D5E8;flex-shrink:0;background:#fff;border-radius:0 0 7px 7px;">
          <button onclick="closeSettingsPage()" style="display:flex;align-items:center;gap:4px;font-size:10px;color:#411482;border:1px solid #8C69F0;border-radius:6px;padding:5px 10px;background:#EEEDFE;cursor:pointer;font-family:'DM Sans',sans-serif;margin-right:auto;">
            <i class="ti ti-arrow-left" style="font-size:10px;" aria-hidden="true"></i> Back to ${_spTabLabel()}
          </button>
          <button onclick="spCancelChanges()" style="background:none;border:1px solid #D0D5E8;border-radius:6px;padding:5px 12px;font-size:10px;color:#6b6b68;cursor:pointer;font-family:'DM Sans',sans-serif;">Cancel</button>
          <button onclick="settingsPageSave()" style="background:#5F1EBE;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer;font-family:'DM Sans',sans-serif;display:flex;align-items:center;gap:4px;">
            <i class="ti ti-check" style="font-size:11px;" aria-hidden="true"></i> Save &amp; Exit
          </button>
        </div>

      </div>
    </div>
  </div>`;
}

// ── Nav item HTML ──
function spNavItem(n) {
  const icons  = {0:'ti-user-circle',1:'ti-building',2:'ti-box-multiple',3:'ti-layout-grid',4:'ti-adjustments-horizontal',5:'ti-calendar-event',6:'ti-users'};
  const labels = {0:'My Profile',1:'Company Profile &amp; Access',2:'Product Profiles',3:'Feature Modules',4:'Output Depth',5:'Release Planning Defaults',6:'Team Management'};
  const active = _spSection === n;
  return `<div onclick="spNav(${n})" style="display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:11px;font-weight:${active?600:500};color:${active?'#5F1EBE':'#6b6b68'};cursor:pointer;border-left:2px solid ${active?'#5F1EBE':'transparent'};background:${active?'#EEEDFE':'transparent'};font-family:'DM Sans',sans-serif;user-select:none;" id="sp-nav-${n}">
    <i class="ti ${icons[n]}" style="font-size:12px;flex-shrink:0;" aria-hidden="true"></i> ${labels[n]}
  </div>`;
}

// ── Section display mode helper (v8.55) ──
// Sections with flex layout need 'flex', all others 'block'.
// Centralised here to prevent display-mode regression on spNav() changes.
function spSectionDisplay(i){ return i===2?'flex':'block'; }

// ── Switch section ──
function spNav(n) {
  _spSection = n;
  _spVisibleSections().forEach(i => {
    const p  = document.getElementById('sp-p'+i);
    const ni = document.getElementById('sp-nav-'+i);
    if(p) p.style.display = i===n ? spSectionDisplay(i) : 'none';
    if(ni) {
      ni.style.color       = i===n ? '#5F1EBE' : '#6b6b68';
      ni.style.fontWeight  = i===n ? '600'     : '500';
      ni.style.borderLeft  = i===n ? '2px solid #5F1EBE' : '2px solid transparent';
      ni.style.background  = i===n ? '#EEEDFE' : 'transparent';
    }
  });
  const titleEl = document.getElementById('sp-panel-title');
  const descEl  = document.getElementById('sp-panel-desc');
  const restBtn = document.getElementById('sp-restore-btn');
  if(titleEl) titleEl.innerHTML  = _spTitle(n);
  if(descEl)  descEl.textContent = _spDesc(n);
  // FIXED in v8.107 (Phase 3), tracked as a separate fix from the
  // permission work in this same change, per external adversarial review —
  // this previously checked n===3||n===4, disagreeing with spBuildHTML's
  // initial-render check of _spSection===4||5. Sections 4 and 5 (Output
  // Depth, Release Planning Defaults) are the only two with numeric defaults to
  // restore; Feature Modules (3) never should have shown this button.
  if(restBtn) restBtn.style.display = (n===4||n===5) ? 'flex' : 'none';
  // Section 5 manages its own internal scroll — prevent outer wrapper from competing
  const scrollWrap=document.getElementById('sp-scroll-wrap');
  if(scrollWrap) scrollWrap.style.overflowY = n===5 ? 'hidden' : 'auto';
  if(n===6 && typeof tmLoad==='function') tmLoad();
}

// Navigate to a specific settings section — set _spSection BEFORE spRender()
// so spBuildHTML() bakes the correct section into the HTML directly.
// Defensive redirect (Phase 3, v8.107) — the one authoritative place this
// check happens, not duplicated into spNav() separately, per external
// review. Confirmed via grep that no current caller can actually trigger
// this (all three existing callers use hardcoded safe values); this is
// forward-looking robustness for a future caller, not closing a presently
// reachable gap. Checked and redirected BEFORE any gated content is ever
// built, not as an after-the-fact correction once rendered.
function openSettingsToSection(n){
  _spSection = _spVisibleSections().includes(n) ? n : 0;
  openSettingsPage();
}

// Open Settings to Section 0 (My Profile) and focus the API key field
// directly — updated in Phase 3 (v8.107) since the key moved there from
// Company Profile. Currently unreferenced by any caller in the codebase
// (checked directly) — out of scope for this phase to investigate why,
// just corrected for consistency while already touching this exact area.
function openSettingsToAPIKey(){
  openSettingsToSection(0);
  const keyEl=document.getElementById('api-key');
  if(keyEl) keyEl.focus();
}

// ── Restore defaults ──
function spRestoreDefaults() {
  if(_spSection === 4) {
    const d = _spDefaults3;
    _spSetSpan('sp-vkd', d.kpiDepth);
    _spSetSpan('sp-vc', d.maxCaps);
    _spSetSpan('sp-vf', d.maxFeatures);
    _spSetSpan('sp-vs', d.maxStories);
    _spSetSpan('sp-va', d.maxACs);
    _spSetTog('sc', d.includeSubCaps);
  } else if(_spSection === 5) {
    const d = _spDefaults4;
    _spSetSpan('sp-vsp', d.defaultSprints);
    _spSetSpan('sp-vd',  d.defaultSprintDur);
    _spSetSpan('sp-vq',  d.defaultSquadCapacity);
    const pfx = document.getElementById('sp-squad-prefix');
    if(pfx) pfx.value = d.defaultSquadName;
    spSeg(d.teamVelocity);
  }
  const btn = document.getElementById('sp-restore-btn');
  if(btn) {
    btn.style.color = '#007873';
    btn.innerHTML   = '<i class="ti ti-check" style="font-size:10px;"></i> Restored';
    setTimeout(() => {
      if(btn) { btn.style.color='#A5AFBE'; btn.innerHTML='<i class="ti ti-refresh" style="font-size:10px;"></i> Restore defaults'; }
    }, 1800);
  }
}

// ── Populate UI from appSettings after render ──
function spPopulate() {
  // Section 1 — company profile fields
  if(typeof spPopulateCompanyProfile==='function') spPopulateCompanyProfile();
  const modelEl = document.getElementById('sp-model-select');
  if(modelEl) modelEl.value = appSettings.model || 'claude-sonnet-4-6';
  const keyEl = document.getElementById('api-key');
  if(keyEl) { spRefreshKeyStatus(); }

  // Section 2 — toggles initialised from appSettings
  _spSetTog('md', appSettings.featDD);
  _spSetTog('pd', appSettings.featDiag);
  _spSetTog('mi', appSettings.featMI);
  _spSetTog('pi', appSettings.featPI);
  _spSetTog('ra', appSettings.featRA);

  // Section 3
  _spSetSpan('sp-vkd', appSettings.kpiDepth||1);
  _spSetSpan('sp-vc', appSettings.maxCaps);
  _spSetSpan('sp-vf', appSettings.maxFeatures);
  _spSetSpan('sp-vs', appSettings.maxStories);
  _spSetSpan('sp-va', appSettings.maxACs);
  _spSetTog('sc', appSettings.includeSubCaps);

  // Section 4
  _spSetSpan('sp-vsp', appSettings.defaultSprints);
  _spSetSpan('sp-vd',  appSettings.defaultSprintDur);
  _spSetSpan('sp-vq',  appSettings.defaultSquadCapacity);
  const pfx = document.getElementById('sp-squad-prefix');
  if(pfx) pfx.value = appSettings.defaultSquadName;
  spSeg(appSettings.teamVelocity || 'med');
}

// ── Stepper adjust ──
function spStep(id, d, mn, mx) {
  const el = document.getElementById(id);
  if(!el) return;
  const v = Math.max(mn, Math.min(mx, parseInt(el.textContent) + d));
  el.textContent = v;
}

// ── Segmented velocity control ──
function spSeg(k) {
  ['low','med','high'].forEach(x => {
    const b = document.getElementById('sp-seg-'+x);
    if(!b) return;
    const on = x === k;
    b.style.background  = on ? '#EEEDFE' : '#fff';
    b.style.color       = on ? '#5F1EBE' : '#6b6b68';
    b.style.fontWeight  = on ? '600'     : '500';
    b.dataset.active    = on ? 'true'    : 'false';
  });
}

// ── Toggle row ──
const _spTogStates = {};
function spTogRow(k) {
  if(_spTogStates[k] === undefined) _spTogStates[k] = _spReadTogInit(k);
  _spTogStates[k] = !_spTogStates[k];
  _spRenderTog(k, _spTogStates[k]);
}
function _spReadTogInit(k) {
  // Read from appSettings for known keys
  const map = { md:'featDD', pd:'featDiag', mi:'featMI', pi:'featPI', sc:'includeSubCaps', ais:'aiStreamingEnabled', rag:'raRagEnabled' };
  const key = map[k];
  return key ? appSettings[key] : true;
}
function _spTogState(k) {
  if(_spTogStates[k] === undefined) return _spReadTogInit(k);
  return _spTogStates[k];
}
function _spSetTog(k, val) {
  _spTogStates[k] = val;
  _spRenderTog(k, val);
}
function _spRenderTog(k, on) {
  const trk = document.getElementById('sp-trk-'+k);
  const tth = document.getElementById('sp-tth-'+k);
  if(trk) trk.style.background = on ? '#5F1EBE' : '#D0D5E8';
  if(tth) tth.style.left       = on ? '16px' : '2px';
}

// ── Helpers ──
function _spSetSpan(id, val) {
  const el = document.getElementById(id);
  if(el) el.textContent = val;
}
function _spTitle(n) {
  return {
    0:'My Profile',
    1:'Company Profile &amp; Access',
    2:'Product Profiles',
    3:'Feature Modules',
    4:'Output Depth',
    5:'Release Planning Defaults',
    6:'Team Management'
  }[n]||'';
}
function _spDesc(n) {
  return {
    0:'Your account details. Email is tied to your login and cannot be changed.',
    1:'Org-level context shared across all products. Set once.',
    2:'Manage your product workspaces. Each profile feeds the Home tab selector.',
    3:'Control which tabs are available to users. Changes take effect immediately.',
    4:'Locked minimums ensure quality floors. You control the ceiling.',
    5:'Default values pre-loaded when Release Canvas opens. Users can override in the Release Canvas panel.',
    6:'Invite, manage roles, and remove people from this company.'
  }[n]||'';
}
function _spTabLabel() {
  const labels = {home:'Home',mm:'Discovery Map',cc:'Capability Canvas',sc:'Story Canvas',pi:'Release Canvas',mi:'Market Intelligence',la:'Experiment Canvas'};
  return labels[curTab] || 'App';
}

// ── Toggle HTML builder ──
// v9.27.01 code-review fix — optional 3rd param `disabled` (default false,
// every pre-existing call site is unaffected) drops the onclick entirely
// for a non-admin instead of leaving every toggle on this page clickable
// regardless of role. spTogRow('rag') never runs for that click, so
// _spTogStates.rag never gets set and settingsPageSave() falls back to
// _spReadTogInit('rag') — appSettings.raRagEnabled's current, unchanged
// value — rather than a non-admin's locally-flipped one.
function _spTog(k, initOn, disabled) {
  return `<div id="sp-tog-${k}" onclick="${disabled?'':`spTogRow('${k}')`}" style="position:relative;width:34px;height:18px;cursor:${disabled?'not-allowed':'pointer'};flex-shrink:0;opacity:${disabled?'0.5':'1'};">
    <div id="sp-trk-${k}" style="position:absolute;inset:0;background:${initOn?'#5F1EBE':'#D0D5E8'};border-radius:18px;"></div>
    <div id="sp-tth-${k}" style="position:absolute;top:2px;left:${initOn?'16px':'2px'};width:14px;height:14px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
  </div>`;
}

// ── Stepper HTML builder ──
function _spStepper(id, val, dec, inc) {
  return `<div style="display:inline-flex;align-items:stretch;border:1px solid #D0D5E8;border-radius:5px;overflow:hidden;height:26px;background:#fff;">
    <button onclick="${dec}" style="width:26px;background:#F4F6FA;border:none;border-right:1px solid #D0D5E8;cursor:pointer;font-size:14px;color:#3d3d3a;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;font-family:'DM Sans',sans-serif;">−</button>
    <span id="${id}" style="width:32px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;font-family:'DM Sans',sans-serif;color:#1a1a1a;background:#fff;">${val}</span>
    <button onclick="${inc}" style="width:26px;background:#F4F6FA;border:none;border-left:1px solid #D0D5E8;cursor:pointer;font-size:14px;color:#3d3d3a;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;font-family:'DM Sans',sans-serif;">+</button>
  </div>`;
}

// ── Setting row HTML builder ──
function _spRow(label, sub, control, note, noBorder) {
  return `<div style="display:flex;align-items:${note?'flex-start':'center'};justify-content:space-between;padding:${note?'11px':'10px'} 0;${noBorder?'':'border-bottom:0.5px solid #D0D5E8;'}gap:16px;">
    <div style="flex:1;min-width:0;">
      <div style="font-size:11px;font-weight:600;color:#000;margin-bottom:2px;font-family:'DM Sans',sans-serif;">${label}</div>
      <div style="font-size:10px;color:#6b6b68;line-height:1.4;font-family:'DM Sans',sans-serif;">${sub}</div>
      ${note?`<div style="font-size:9px;color:#A5AFBE;margin-top:2px;font-family:'DM Sans',sans-serif;">${note}</div>`:''}
    </div>
    <div style="flex-shrink:0;display:flex;align-items:center;gap:6px;">${control}</div>
  </div>`;
}

// ── Module row HTML builder ──
function _spModRow(k, iconClass, iconBg, iconColor, label, desc, initOn, noBorder) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;${noBorder?'':'border-bottom:0.5px solid #D0D5E8;'}gap:12px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:28px;height:28px;border-radius:6px;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <i class="ti ${iconClass}" style="font-size:13px;color:${iconColor};" aria-hidden="true"></i>
      </div>
      <div>
        <div style="font-size:11px;font-weight:600;color:#000;font-family:'DM Sans',sans-serif;">${label}</div>
        <div style="font-size:10px;color:#6b6b68;margin-top:1px;font-family:'DM Sans',sans-serif;">${desc}</div>
      </div>
    </div>
    ${_spTog(k, initOn)}
  </div>`;
}

// ── Sub-group label ──
function _spSubLbl(text) {
  return `<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#A5AFBE;padding:10px 0 4px;font-family:'DM Sans',sans-serif;">${text}</div>`;
}

// ── Panel 0: My Profile ──
function spP0() {
  const email       = (typeof currentUser !== 'undefined' && currentUser) ? (currentUser.email || '') : '';
  const displayName = (typeof currentUser !== 'undefined' && currentUser) ? (currentUser.displayName || '') : '';
  const initials    = (typeof _avatarInitials === 'function') ? _avatarInitials(displayName) : (displayName[0]||'?').toUpperCase();
  return `
    <div style="padding:14px 0 4px;display:flex;flex-direction:column;gap:14px;">

      <!-- Identity card -->
      <div style="border:1px solid #D0D5E8;border-radius:8px;padding:16px;display:flex;align-items:center;gap:16px;background:#F4F6FA;">
        <!-- Avatar circle — updates live as name changes -->
        <div id="sp-p0-avatar" style="width:52px;height:52px;border-radius:50%;background:#5F1EBE;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;flex-shrink:0;letter-spacing:0.5px;font-family:'DM Sans',sans-serif;">${initials}</div>
        <!-- Identity fields -->
        <div style="flex:1;min-width:0;">
          <!-- Display name + auto-save status -->
          <!-- Display name + inline auto-save status -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;">
            <input id="sp-p0-name" type="text" value="${displayName.replace(/"/g,'&quot;')}"
              placeholder="Your display name"
              style="flex:1;min-width:0;border:1px solid #D0D5E8;border-radius:5px;padding:7px 10px;font-size:13px;font-weight:600;color:#000;background:#fff;font-family:'DM Sans',sans-serif;outline:none;"
              oninput="spP0OnNameInput(this.value)"
              onfocus="this.style.borderColor='#5F1EBE'"
              onblur="this.style.borderColor='#D0D5E8'"/>
            <div id="sp-p0-name-status" style="font-size:10px;color:#A5AFBE;white-space:nowrap;flex-shrink:0;font-family:'DM Sans',sans-serif;min-width:0;"></div>
          </div>
          <!-- Email row -->
          <div style="display:flex;align-items:center;gap:5px;margin-top:6px;">
            <i class="ti ti-mail" style="font-size:11px;color:#A5AFBE;" aria-hidden="true"></i>
            <span style="font-size:11px;color:#6b6b68;font-family:'DM Sans',sans-serif;">${email}</span>
            <span style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">· Cannot be changed</span>
          </div>
        </div>
      </div>

      <!-- Password section -->
      <div style="border:1px solid #D0D5E8;border-radius:8px;padding:14px 16px;">
        <div style="font-size:11px;font-weight:700;color:#000;margin-bottom:2px;font-family:'DM Sans',sans-serif;">Password</div>
        <div style="font-size:10px;color:#6b6b68;margin-bottom:10px;font-family:'DM Sans',sans-serif;">Send a password reset link to your registered email address.</div>
        <button onclick="spP0ResetPassword()" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#5F1EBE;border:1px solid #8C69F0;border-radius:5px;padding:7px 14px;background:#EEEDFE;cursor:pointer;font-family:'DM Sans',sans-serif;">
          <i class="ti ti-mail" style="font-size:12px;" aria-hidden="true"></i> Send Reset Link
        </button>
        <div style="font-size:9px;color:#A5AFBE;margin-top:6px;font-family:'DM Sans',sans-serif;">A reset link will be sent to ${email}</div>
        <div id="sp-p0-pw-toast" style="display:none;margin-top:7px;border-radius:5px;padding:6px 10px;font-size:10px;font-family:'DM Sans',sans-serif;"></div>
      </div>

      <!-- API key section — moved here from Company Profile (Phase 3, v8.107).
           Personal, sessionStorage-scoped, role-independent — never belonged
           behind admin-only editing in the first place.
           v8.108: side-by-side layout restored to match how this looked in
           Company Profile before relocation — the initial move used a
           stacked custom layout instead of carrying the existing pattern
           over, an oversight caught in review, not a deliberate change. -->
      <div style="border:1px solid #D0D5E8;border-radius:8px;padding:14px 16px;">
        ${(function(){
          const keyVal  = (function(){ const k=sessionStorage.getItem(typeof _byokKey==='function'?_byokKey():'hcl_ak'); return k?k:''; })();
          const keyReady   = (typeof isValidApiKeyFormat==='function')?isValidApiKeyFormat(keyVal):(keyVal.startsWith('sk-ant')||keyVal.startsWith('sk-'));
          const keyEmpty   = keyVal.length === 0;
          const keyInvalid = !keyReady && !keyEmpty;
          const _pillBg    = keyInvalid ? '#FCE8E8' : '#e6f4f1';
          const _pillColor = keyInvalid ? '#A32D2D' : '#007873';
          const _pillIcon  = keyInvalid ? 'ti-alert-circle' : (keyReady ? 'ti-circle-check' : 'ti-building');
          const _pillText  = keyInvalid ? 'Invalid key format' : (keyReady ? 'Personal key active' : 'Organisation key active');
          // v9.14: label + placeholder are provider-conditional now — see
          // scripts/config.js's _spKeyMetaForProvider(). The literal
          // "Anthropic API Key" title this replaced was hardcoded for a
          // single-provider app; this card is shared across whichever
          // provider is active.
          const _keyMeta = (typeof _spKeyMetaForProvider==='function') ? _spKeyMetaForProvider(appSettings.provider) : { label:'Anthropic API Key', placeholder:'sk-ant-api03-...' };
          return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;">
            <div style="flex:1;min-width:0;">
              <div id="sp-key-label" style="font-size:11px;font-weight:700;color:#000;font-family:'DM Sans',sans-serif;">${_keyMeta.label}</div>
              <div style="font-size:10px;color:#6b6b68;margin-top:1px;font-family:'DM Sans',sans-serif;">Personal, per-company — never shared with other companies you belong to</div>
            </div>
            <div style="flex-shrink:0;display:flex;align-items:center;gap:6px;">
              <span id="sp-key-status" style="display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:600;padding:2px 6px;border-radius:20px;background:${_pillBg};color:${_pillColor};white-space:nowrap;font-family:'DM Sans',sans-serif;">
                <i class="ti ${_pillIcon}" style="font-size:9px;"></i> ${_pillText}
              </span>
              <div id="api-key-wrap" style="display:flex;align-items:center;border:1px solid #D0D5E8;border-radius:5px;background:#fff;height:28px;width:200px;overflow:hidden;${keyInvalid?'box-shadow:0 0 0 3px rgba(124,58,237,0.25);border-color:#7C3AED;':''}">
                <input type="password" id="api-key" value="${keyVal}" oninput="checkKey()" placeholder="${_keyMeta.placeholder}" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" style="flex:1;border:none;outline:none;padding:0 8px;font-size:11px;font-family:'DM Sans',sans-serif;color:#1a1a1a;background:transparent;height:100%;min-width:0;">
                <button onclick="toggleKeyVis()" style="background:none;border:none;border-left:1px solid #D0D5E8;padding:0 7px;height:100%;cursor:pointer;color:#6b6b68;display:flex;align-items:center;flex-shrink:0;">
                  <i class="ti ti-eye" id="eye-icon" style="font-size:12px;"></i>
                </button>
              </div>
            </div>
          </div>`;
        })()}
      </div>

    </div>`;
}

// ── Name input handler — updates avatar live + triggers debounced auto-save ──
var _spP0NameTimer = null;
function spP0OnNameInput(val) {
  spMarkDirty();
  // Update avatar circle live
  const avatarEl = document.getElementById('sp-p0-avatar');
  if(avatarEl) {
    const initials = (typeof _avatarInitials==='function') ? _avatarInitials(val) : (val.trim()[0]||'?').toUpperCase();
    avatarEl.textContent = initials;
  }
  // Debounce auto-save — 800ms after last keystroke
  if(_spP0NameTimer) clearTimeout(_spP0NameTimer);
  const statusEl = document.getElementById('sp-p0-name-status');
  if(statusEl) statusEl.textContent = '';
  _spP0NameTimer = setTimeout(function(){ spP0SaveName(); }, 800);
}

// ── Auto-save display name ──
async function spP0SaveName() {
  const nameEl   = document.getElementById('sp-p0-name');
  const statusEl = document.getElementById('sp-p0-name-status');
  if(!nameEl || !statusEl) return;
  const name = nameEl.value.trim();
  if(!name) {
    statusEl.style.color = '#A32D2D';
    statusEl.textContent = 'Display name cannot be empty.';
    return;
  }
  // Saving state
  statusEl.style.color = '#A5AFBE';
  statusEl.textContent = 'Saving…';
  try {
    const client = (typeof authInit==='function') ? authInit() : null;
    if(!client) throw 'Auth client not available.';
    const { error } = await client.auth.updateUser({ data: { display_name: name } });
    if(error) throw error.message || 'Could not save name.';
    // Update currentUser in memory
    if(typeof currentUser !== 'undefined' && currentUser) currentUser.displayName = name;
    // Refresh header avatar badge
    if(typeof updateHeaderAvatar==='function') updateHeaderAvatar();
    // Saved state
    statusEl.style.color = '#007873';
    statusEl.textContent = 'Saved · Avatar updated';
    setTimeout(function(){ if(statusEl) { statusEl.textContent=''; } }, 3000);
  } catch(err) {
    const msg = (typeof err==='string') ? err : (err.message || 'Could not save. Please try again.');
    statusEl.style.color = '#A32D2D';
    statusEl.textContent = msg;
  }
}

// ── Send password reset (Section 0) ──
async function spP0ResetPassword() {
  const toast = document.getElementById('sp-p0-pw-toast');
  if(!toast) return;
  const email = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.email : '';
  if(!email) { _spP0Toast(toast, 'error', 'No email found. Please sign out and sign back in.'); return; }
  _spP0Toast(toast, 'loading', 'Sending reset link…');
  try {
    if(typeof authResetPassword==='function') await authResetPassword(email);
    _spP0Toast(toast, 'success', 'Reset link sent to ' + email + '. Check your inbox.');
  } catch(err) {
    const msg = (typeof err==='string') ? err : (err.message || 'Could not send reset link.');
    _spP0Toast(toast, 'error', msg);
  }
}

// ── Inline toast helper for Section 0 (password reset only) ──
function _spP0Toast(el, type, msg) {
  const styles = {
    loading: 'background:#EEEDFE;border:1px solid #AFA9EC;color:#3C3489;',
    success: 'background:#EAF3DE;border:1px solid #97C459;color:#3B6D11;',
    error:   'background:#FCEBEB;border:1px solid #F09595;color:#791F1F;'
  };
  el.style.cssText = 'display:block;margin-top:7px;border-radius:5px;padding:6px 10px;font-size:10px;font-family:\'DM Sans\',sans-serif;' + (styles[type]||'');
  el.textContent = msg;
  if(type === 'success') {
    setTimeout(function(){ if(el) el.style.display='none'; }, 4000);
  }
}

// ── Panel 1: Company Profile & Access ──
function spP1() {
  // v9.14: model catalog is now provider-keyed — see scripts/config.js.
  const _activeProvider = (typeof appSettings!=='undefined' && appSettings.provider) || 'anthropic';
  const providerOpts = (typeof _spProviders!=='undefined'?_spProviders:[{value:'anthropic',label:'Anthropic'}]).map(p =>
    `<option value="${p.value}"${p.value===_activeProvider?' selected':''}>${p.label}</option>`
  ).join('');
  const _modelsForProvider = (typeof _spModelsByProvider!=='undefined' && _spModelsByProvider[_activeProvider]) || [];
  const modelOpts = _modelsForProvider.map(m =>
    `<option value="${m.value}"${m.value===appSettings.model?' selected':''}>${m.label}</option>`
  ).join('');

  // Industry vertical options — blank prompt as first item, no forced default
  const industries = ['Banking & Finance','Cross-Industry','Education / EdTech','Energy & Utilities',
    'Government / Public Sector','Health & Life Sciences','Insurance','Manufacturing',
    'Media & Entertainment','Real Estate / PropTech','Retail & Consumer Goods',
    'Supply Chain & Logistics','Technology & Software','Telecommunications','Travel & Hospitality'];
  const coInd = companyProfile.companyIndustry||'';
  const industryOpts = `<option value="" ${!coInd?'selected':''}>Select industry...</option>`
    + industries.map(v=>`<option value="${v}"${v===coInd?' selected':''}>${v}</option>`).join('');

  // Doc chips + meter — moved after readOnly is known below, since the
  // remove button needs to be suppressed entirely in read-only mode, not
  // just disabled (there's no reason to show a remove affordance at all to
  // someone who could never use it).
  const totalWords = (companyProfile.companyDocs||[]).reduce((s,d)=>s+d.wordCount,0);
  const meterPct   = Math.min(100,Math.round(totalWords/20000*100));
  const meterColor = meterPct>80?'#C8870A':'#5F1EBE';
  const docsCount  = (companyProfile.companyDocs||[]).length;

  // Shared input style
  const inp = 'width:100%;height:28px;border:1px solid #D0D5E8;border-radius:5px;padding:0 8px;font-size:11px;font-family:\'DM Sans\',sans-serif;color:#1a1a1a;background:#fff;outline:none;box-sizing:border-box;';
  const sel = 'width:100%;height:28px;border:1px solid #D0D5E8;border-radius:5px;padding:0 8px;font-size:11px;font-family:\'DM Sans\',sans-serif;color:#1a1a1a;background:#fff;outline:none;cursor:pointer;box-sizing:border-box;';
  const lbl = 'font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:\'DM Sans\',sans-serif;';
  const sub = 'font-size:9px;color:#A5AFBE;margin-top:3px;display:block;font-family:\'DM Sans\',sans-serif;';
  const col = 'display:flex;flex-direction:column;min-width:0;';

  // Phase 3 (v8.107): view-only for Regular Users — inputs disabled, Save
  // hidden (enforced at the page-level footer via settingsPageSave()'s own
  // admin check above, not duplicated here), upload/remove-doc controls
  // disabled too, not just the plain text fields (confirmed via grep this
  // section has the same three-click-target upload pattern as Section 2).
  const readOnly = !_spIsAdmin();
  const dis = readOnly ? 'disabled' : '';
  const disInp = readOnly ? inp+'background:#F4F6FA;color:#9a9a96;cursor:not-allowed;' : inp;
  const disSel = readOnly ? sel+'background:#F4F6FA;color:#9a9a96;cursor:not-allowed;' : sel;
  const banner = readOnly ? `<div style="background:#FAEEDA;border:1px solid #EF9F27;border-radius:6px;padding:8px 10px;font-size:10px;color:#633806;margin:14px 0;display:flex;align-items:center;gap:6px;font-family:'DM Sans',sans-serif;"><i class="ti ti-lock" aria-hidden="true"></i> Only admins can edit the company profile</div>` : '';
  const docChips = (companyProfile.companyDocs||[]).map((d,i)=>
    `<span class="sp-file-chip"><i class="ti ti-file" style="font-size:9px;" aria-hidden="true"></i> ${_spEsc(d.name)} &middot; ${d.wordCount.toLocaleString()}w${d.truncated?' (truncated)':''}${readOnly?'':`<button class="sp-file-chip-remove" onclick="spRemoveDoc('co',${i})" aria-label="Remove file"><i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i></button>`}</span>`
  ).join('');

  return `
  ${banner}
  ${_spSubLbl('Company Profile')}

  <!-- Row 1: Company Name + Industry Vertical -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:10px 0;border-bottom:0.5px solid #D0D5E8;">
    <div style="${col}">
      <label style="${lbl}">Company Name <span style="color:#A32D2D;">*</span></label>
      <input type="text" id="sp-co-name" ${dis} value="${_spEsc(companyProfile.companyName||'')}" placeholder="e.g. Contoso, Acme Corp" style="${disInp}">
      <span style="${sub}">Used across all product diagnostics</span>
    </div>
    <div style="${col}">
      <label style="${lbl}">Industry Vertical</label>
      <select id="sp-co-industry" ${dis} style="${disSel}">${industryOpts}</select>
      <span style="${sub}">Default for all products - overridable per product</span>
    </div>
  </div>

  <!-- Row 2: Company URL + Reference Link -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:10px 0;border-bottom:0.5px solid #D0D5E8;">
    <div style="${col}">
      <label style="${lbl}">Company URL</label>
      <input type="text" id="sp-co-url" ${dis} value="${_spEsc(companyProfile.companyUrl||'')}" placeholder="https://company.com" style="${disInp}">
      <span style="${sub}">Company website or investor relations page</span>
    </div>
    <div style="${col}">
      <label style="${lbl}">Reference Link</label>
      <input type="text" id="sp-co-reflink" ${dis} value="${_spEsc(companyProfile.companyRefLink||'')}" placeholder="Confluence, Google Doc, Notion URL..." style="${disInp}">
      <span style="${sub}">Stored as context - not fetched</span>
    </div>
  </div>

  <!-- Row 3: Strategy & Vision + Additional Context side by side -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:10px 0;border-bottom:0.5px solid #D0D5E8;">
    <div style="${col}">
      <div style="font-size:11px;font-weight:600;color:#000;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Strategy &amp; Vision</div>
      <div style="font-size:10px;color:#6b6b68;margin-bottom:6px;font-family:'DM Sans',sans-serif;">Align KPI recommendations with your org's north star</div>
      <textarea id="sp-co-strategy" ${dis} oninput="spCharCount(this,'sp-co-strategy-ct',2000)" maxlength="2000" rows="4" placeholder="e.g. Become the leading AI-native enterprise platform for mid-market logistics by 2027..." style="width:100%;border:1px solid #D0D5E8;border-radius:5px;padding:6px 8px;font-size:11px;font-family:'DM Sans',sans-serif;resize:vertical;min-height:72px;box-sizing:border-box;${readOnly?'background:#F4F6FA;color:#9a9a96;cursor:not-allowed;':'color:#1a1a1a;background:#fff;'}">${_spEsc(companyProfile.companyStrategy||'')}</textarea>
      <div style="display:flex;justify-content:flex-end;"><span id="sp-co-strategy-ct" style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${(companyProfile.companyStrategy||'').length}/2000</span></div>
    </div>
    <div style="${col}">
      <div style="font-size:11px;font-weight:600;color:#000;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Additional Context</div>
      <div style="font-size:10px;color:#6b6b68;margin-bottom:6px;font-family:'DM Sans',sans-serif;">Client background, constraints, landscape - lowest prompt priority</div>
      <textarea id="sp-co-context" ${dis} oninput="spCharCount(this,'sp-co-context-ct',2000)" maxlength="2000" rows="4" placeholder="Insider intelligence, constraints, org culture notes..." style="width:100%;border:1px solid #D0D5E8;border-radius:5px;padding:6px 8px;font-size:11px;font-family:'DM Sans',sans-serif;resize:vertical;min-height:72px;box-sizing:border-box;${readOnly?'background:#F4F6FA;color:#9a9a96;cursor:not-allowed;':'color:#1a1a1a;background:#fff;'}">${_spEsc(companyProfile.companyContext||'')}</textarea>
      <div style="display:flex;justify-content:flex-end;"><span id="sp-co-context-ct" style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${(companyProfile.companyContext||'').length}/2000</span></div>
    </div>
  </div>

  <!-- Supporting Documents — full width -->
  <div style="padding:10px 0;border-bottom:0.5px solid #D0D5E8;">
    <div style="font-size:11px;font-weight:600;color:#000;margin-bottom:2px;font-family:'DM Sans',sans-serif;">Supporting Documents</div>
    <div style="font-size:10px;color:#6b6b68;margin-bottom:6px;font-family:'DM Sans',sans-serif;">Strategy decks, annual reports, org briefs</div>
    ${readOnly?'':`<div class="sp-upload-zone" onclick="document.getElementById('sp-co-file-input').click()">
      <div class="sp-upload-icon"><i class="ti ti-upload" aria-hidden="true"></i></div>
      <div class="sp-upload-text">
        <div class="sp-upload-title">${docsCount>=5?'Maximum files reached':'Upload files'}</div>
        <div class="sp-upload-sub">docx, pdf, txt, xlsx, csv &middot; Max 5MB per file &middot; Up to 5 files</div>
      </div>
      ${docsCount<5?'<button class="sp-upload-btn" onclick="event.stopPropagation();document.getElementById(\'sp-co-file-input\').click()">Browse</button>':''}
    </div>
    <input type="file" id="sp-co-file-input" class="sp-upload-input" multiple accept=".pdf,.docx,.txt,.csv,.xlsx" onchange="spHandleFileUpload('co',this)" />`}
    <div id="sp-co-chips">${docChips}</div>
    ${docsCount>0?`<div class="sp-word-meter-wrap" id="sp-co-meter-wrap"><div class="sp-word-meter-bar" style="width:${meterPct}%;background:${meterColor};"></div></div><div class="sp-word-meter-label" id="sp-co-meter-lbl">${totalWords.toLocaleString()} / 20,000 words used &middot; ${docsCount} file${docsCount!==1?'s':''}</div>`:''}
  </div>

  ${_spSubLbl('API &amp; Access')}

  ${_spRow(
    'AI Provider',
    'Which AI service this company\'s calls are routed through.',
    `<select id="sp-provider-select" onchange="spOnProviderChange(this.value)" style="height:28px;border:1px solid #D0D5E8;border-radius:5px;padding:0 8px;font-size:11px;font-family:'DM Sans',sans-serif;color:#1a1a1a;background:#fff;outline:none;cursor:pointer;width:280px;">${providerOpts}</select>`,
    'Switching provider repopulates the model list below and resets it to Optimized (Default).',
    true
  )}

  ${_spRow(
    'AI Model',
    '"Optimized" auto-selects the right tier per task. Or pin a specific model.',
    `<select id="sp-model-select" style="height:28px;border:1px solid #D0D5E8;border-radius:5px;padding:0 8px;font-size:11px;font-family:'DM Sans',sans-serif;color:#1a1a1a;background:#fff;outline:none;cursor:pointer;width:280px;">${modelOpts}</select>`,
    'If the selected model is unavailable for your key, generation fails with a clear error rather than silently switching models.',
    true
  )}

  ${_spRow(
    'Live AI Streaming',
    'Requirement Agent replies reveal token-by-token as they generate, instead of appearing all at once when the full response is ready.',
    _spTog('ais', appSettings.aiStreamingEnabled),
    'Experimental — off by default.',
    true
  )}

  ${_spRow(
    'Requirement Agent Document RAG',
    'Documents uploaded in Requirement Agent are embedded and stay searchable for the rest of that conversation.',
    _spTog('rag', appSettings.raRagEnabled, readOnly),
    readOnly?'Only admins can change this.':'Off by default until your organization\'s embedding service is approved.',
    true
  )}`;
}

// ── Provider dropdown change handler (v9.14) ──
// Client-side preview, no Save required (per spec Section 4.1/10.3): live-
// mutates appSettings.provider/model immediately (not deferred to Save,
// unlike most other Settings fields) so checkKey()/_byokKey() write to the
// right provider-scoped sessionStorage slot the instant the user starts
// typing a key for the newly-selected provider. spConfirmDiscard() reverts
// this via _spKeySnapshot if the user cancels instead of saving.
function spOnProviderChange(newProvider){
  if(typeof appSettings==='undefined') return;
  appSettings.provider = newProvider;
  appSettings.model = 'optimized'; // no cross-provider "equivalent model" carry-over — model IDs are provider-specific
  spMarkDirty();

  // Repopulate the Model dropdown from the new provider's catalog
  const modelSel = document.getElementById('sp-model-select');
  if(modelSel && typeof _spModelsByProvider!=='undefined'){
    const models = _spModelsByProvider[newProvider] || [];
    modelSel.innerHTML = models.map(m => `<option value="${m.value}"${m.value==='optimized'?' selected':''}>${m.label}</option>`).join('');
  }

  // Swap the API key card's label/placeholder, and reload whichever key
  // (if any) is already saved for this provider in this company.
  const keyMeta = (typeof _spKeyMetaForProvider==='function') ? _spKeyMetaForProvider(newProvider) : { label:'Anthropic API Key', placeholder:'sk-ant-api03-...' };
  const labelEl = document.getElementById('sp-key-label');
  if(labelEl) labelEl.textContent = keyMeta.label;
  const keyEl = document.getElementById('api-key');
  if(keyEl){
    keyEl.placeholder = keyMeta.placeholder;
    keyEl.value = sessionStorage.getItem(typeof _byokKey==='function'?_byokKey():'hcl_ak') || '';
    if(typeof checkKey==='function') checkKey(); // refreshes the dot + sp-key-status pill for the reloaded value
  }
}

// ── Panel 2: Feature Modules ──
function spP2() {
  return `
  ${_spModRow('ra','ti-clipboard-text','#EEEDFE','#5F1EBE','Requirement Agent','Adds the "Define Requirements" workflow to Capability Canvas, routing feature generation through a finalized release brief',appSettings.featRA)}
  ${_spModRow('mi','ti-world-search','#EAF3DE','#3B6D11','Market Intelligence','Market sizing, competitor mapping, and SWOT. Runs before Discovery Map generation.',appSettings.featMI)}
  ${_spModRow('op','ti-activity','#EEEDFE','#5F1EBE','Outcome Pulse','Track feature outcome hypotheses against actual results, with a leadership-facing rollup',appSettings.featOutcomePulse)}
  ${_spModRow('md','ti-table','#DCE6F0','#0F5FDC','Metrics Dictionary','Dictionary of all KPI tree metrics with benchmarks and red flags',appSettings.featDD)}
  ${_spModRow('pd','ti-microscope','#e6f4f1','#007873','Experiment Canvas','Evidence collection and product leak analysis on your Discovery Map',appSettings.featDiag)}
  ${_spModRow('pi','ti-calendar-event','#EEEDFE','#5F1EBE','Release Canvas','Sprint sequencing and release board for story backlog planning',appSettings.featPI,true)}`;
}

// ── Panel 3: Output Depth ──
function spP3() {
  return `
  ${_spSubLbl('Discovery Map')}
  ${_spRow('Outcome Metrics Depth','Controls metric levels in Outcome Metrics mode — L1 = top-level KPIs only, L2 = with sub-metrics, L3 = full diagnostic tree',
    _spStepper('sp-vkd',appSettings.kpiDepth||1,"spStep('sp-vkd',-1,1,3)","spStep('sp-vkd',1,1,3)"),'Max 3')}
  ${_spSubLbl('Capabilities')}
  <div class="sp-group-tight">
  ${_spRow('Capabilities per Metric','AI generates 2 to [n] capabilities per metric',
    _spStepper('sp-vc',appSettings.maxCaps,"spStep('sp-vc',-1,2,5)","spStep('sp-vc',1,2,5)"),'Min 2 locked',true)}
  ${_spRow('Include Sub-Capabilities','Generated only when a capability is complex enough to sub-divide',_spTog('sc',appSettings.includeSubCaps),null)}
  </div>
  ${_spSubLbl('Features')}
  ${_spRow('Features per Capability','AI generates 3 to [n] features per capability across all paths',
    _spStepper('sp-vf',appSettings.maxFeatures,"spStep('sp-vf',-1,3,6)","spStep('sp-vf',1,3,6)"),'Min 3 locked')}
  ${_spSubLbl('Stories &amp; Acceptance Criteria')}
  <div class="sp-group-tight">
  ${_spRow('Stories per Feature','AI generates 2 to [n] stories per feature across Story Canvas and Release Canvas',
    _spStepper('sp-vs',appSettings.maxStories,"spStep('sp-vs',-1,2,10)","spStep('sp-vs',1,2,10)"),'Min 2 locked',true)}
  ${_spRow('Acceptance Criteria per Story','One happy path and one edge case are always included',
    _spStepper('sp-va',appSettings.maxACs,"spStep('sp-va',-1,2,5)","spStep('sp-va',1,2,5)"),'Min 2 locked',true)}
  </div>
  <div style="border-top:0.5px solid #D0D5E8;margin-top:4px;"></div>
  ${_spSubLbl('Session Sharing')}
  <div style="margin-bottom:4px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${appSettings.defaultShareMode==='edit'?'12px':'0'};">
      <div>
        <div style="font-size:11px;font-weight:600;color:#000;margin-bottom:2px;font-family:'DM Sans',sans-serif;">Collaborative Editing</div>
        <div style="font-size:10px;color:#6b6b68;line-height:1.4;font-family:'DM Sans',sans-serif;">Lets shared team members edit sessions, either one at a time or together.</div>
      </div>
      <div id="sp-tog-collab" onclick="spSetCollabToggle(${appSettings.defaultShareMode!=='edit'})" style="position:relative;width:34px;height:18px;cursor:pointer;flex-shrink:0;">
        <div id="sp-trk-collab" style="position:absolute;inset:0;background:${appSettings.defaultShareMode==='edit'?'#5F1EBE':'#D0D5E8'};border-radius:18px;"></div>
        <div id="sp-tth-collab" style="position:absolute;top:2px;left:${appSettings.defaultShareMode==='edit'?'16px':'2px'};width:14px;height:14px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
      </div>
    </div>
    <div id="sp-collab-submodes" style="display:${appSettings.defaultShareMode==='edit'?'block':'none'};">
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <label style="flex:1;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid ${(appSettings.collabEditMode||'single')==='single'?'#5F1EBE':'#D0D5E8'};background:${(appSettings.collabEditMode||'single')==='single'?'#F7F6FE':'#fff'};border-radius:7px;cursor:pointer;" id="sp-collabmode-single-wrap">
          <input type="radio" name="sp-collabmode" id="sp-collabmode-single" ${(appSettings.collabEditMode||'single')==='single'?'checked':''} onchange="spSetCollabEditMode('single')" style="margin-top:2px;accent-color:#5F1EBE;">
          <div>
            <div style="font-size:11px;font-weight:600;color:#1a1a1a;font-family:'DM Sans',sans-serif;">Single User Editing <span style="font-weight:400;color:#5F1EBE;">Default</span></div>
            <div style="font-size:10px;color:#6b6b68;margin-top:2px;line-height:1.5;font-family:'DM Sans',sans-serif;">Only one team member can edit at a time. Others view until the session is available.</div>
          </div>
        </label>
        <label style="flex:1;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid ${appSettings.collabEditMode==='multi'?'#5F1EBE':'#D0D5E8'};background:${appSettings.collabEditMode==='multi'?'#F7F6FE':'#fff'};border-radius:7px;cursor:pointer;" id="sp-collabmode-multi-wrap">
          <input type="radio" name="sp-collabmode" id="sp-collabmode-multi" ${appSettings.collabEditMode==='multi'?'checked':''} onchange="spSetCollabEditMode('multi')" style="margin-top:2px;accent-color:#5F1EBE;">
          <div>
            <div style="font-size:11px;font-weight:600;color:#1a1a1a;font-family:'DM Sans',sans-serif;">Multi User Editing</div>
            <div style="font-size:10px;color:#6b6b68;margin-top:2px;line-height:1.5;font-family:'DM Sans',sans-serif;">Everyone can generate, edit, and delete content at the same time.</div>
          </div>
        </label>
      </div>
      <div id="sp-sharemode-warn" style="display:${appSettings.collabEditMode==='multi'?'flex':'none'};gap:8px;align-items:flex-start;background:#FAEEDA;border:0.5px solid #EF9F27;border-radius:6px;padding:8px 10px;">
        <i class="ti ti-alert-triangle" style="font-size:12px;color:#633806;flex-shrink:0;margin-top:1px;" aria-hidden="true"></i>
        <div style="font-size:10px;color:#633806;line-height:1.5;font-family:'DM Sans',sans-serif;">Turning on collaborative editing means multiple people can update the same session at once. Updates can silently overwrite each other, so this mode needs active coordination among your team.</div>
      </div>
    </div>
  </div>`;
}

// ── v9.12: Collaborative Editing toggle handler ──
// Labeled clearly as a security/access-control setting in this comment
// despite living in the Output Depth section for now — this is a
// temporary placement, not a signal that this is a minor UX preference.
// Replaces the old v9.08 two-radio (View only / Collaborative editing)
// design — defaultShareMode is still the underlying persisted field (kept
// for backward compat with canEditSession()/session-share logic elsewhere),
// but the UI now presents it as a single on/off toggle, with a second,
// new field (collabEditMode) distinguishing Single vs Multi once On.
function spSetCollabToggle(on){
  appSettings.defaultShareMode = on ? 'edit' : 'view';
  const wrap=document.getElementById('sp-tog-collab');
  const trk=document.getElementById('sp-trk-collab');
  const tth=document.getElementById('sp-tth-collab');
  if(trk) trk.style.background = on ? '#5F1EBE' : '#D0D5E8';
  if(tth) tth.style.left       = on ? '16px' : '2px';
  // Re-wire the next click to flip back — the onclick was rendered with the
  // toggle's state baked in as a literal at render time, so it must be
  // refreshed here or a second click would send the same 'on' value again.
  if(wrap) wrap.setAttribute('onclick', 'spSetCollabToggle(' + !on + ')');
  const submodes=document.getElementById('sp-collab-submodes');
  if(submodes) submodes.style.display = on ? 'block' : 'none';
  const warn=document.getElementById('sp-sharemode-warn');
  if(warn) warn.style.display=(on && appSettings.collabEditMode==='multi')?'flex':'none';
  if(typeof spMarkDirty==='function') spMarkDirty();
}

// ── v9.12: Single/Multi sub-choice handler ──
function spSetCollabEditMode(mode){
  appSettings.collabEditMode = (mode==='multi') ? 'multi' : 'single';
  const singleWrap=document.getElementById('sp-collabmode-single-wrap');
  const multiWrap=document.getElementById('sp-collabmode-multi-wrap');
  const warn=document.getElementById('sp-sharemode-warn');
  if(singleWrap){
    singleWrap.style.border=appSettings.collabEditMode==='single'?'1px solid #5F1EBE':'1px solid #D0D5E8';
    singleWrap.style.background=appSettings.collabEditMode==='single'?'#F7F6FE':'#fff';
  }
  if(multiWrap){
    multiWrap.style.border=appSettings.collabEditMode==='multi'?'1px solid #5F1EBE':'1px solid #D0D5E8';
    multiWrap.style.background=appSettings.collabEditMode==='multi'?'#F7F6FE':'#fff';
  }
  // Warning strip toggles live with selection, matching the v9.08 pattern
  // this replaces — gated on collabEditMode directly, so reopening Settings
  // when Multi is already the saved choice shows the warning immediately.
  if(warn) warn.style.display=(appSettings.collabEditMode==='multi')?'flex':'none';
  if(typeof spMarkDirty==='function') spMarkDirty();
}

// ── Panel 4: Release Planning Defaults (internal ids stay pi-prefixed) ──
function spP4() {
  const vel = appSettings.teamVelocity || 'med';
  const segBtn = (k,lbl) => {
    const on = k===vel;
    return `<button id="sp-seg-${k}" onclick="spSeg('${k}')" data-active="${on}" style="width:44px;font-size:10px;font-weight:${on?600:500};background:${on?'#EEEDFE':'#fff'};border:none;border-right:1px solid #D0D5E8;cursor:pointer;color:${on?'#5F1EBE':'#6b6b68'};font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;">${lbl}</button>`;
  };
  const segLast = (k,lbl) => {
    const on = k===vel;
    return `<button id="sp-seg-${k}" onclick="spSeg('${k}')" data-active="${on}" style="width:44px;font-size:10px;font-weight:${on?600:500};background:${on?'#EEEDFE':'#fff'};border:none;cursor:pointer;color:${on?'#5F1EBE':'#6b6b68'};font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;">${lbl}</button>`;
  };
  return `
  ${_spRow('Sprints per Release','How many sprints in a typical planning interval',
    _spStepper('sp-vsp',appSettings.defaultSprints,"spStep('sp-vsp',-1,1,20)","spStep('sp-vsp',1,1,20)"),null)}
  ${_spRow('Sprint Duration','Duration of each sprint in weeks',
    _spStepper('sp-vd',appSettings.defaultSprintDur,"spStep('sp-vd',-1,1,6)","spStep('sp-vd',1,1,6)")+'<span style="font-size:10px;color:#6b6b68;font-family:\'DM Sans\',sans-serif;">wks</span>',null)}
  ${_spRow('Squad Name Prefix','Used when a new squad is added. e.g. Pod, Team, Squad',
    `<input id="sp-squad-prefix" type="text" value="${appSettings.defaultSquadName||'Squad'}" style="height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 8px;font-size:11px;font-family:'DM Sans',sans-serif;color:#1a1a1a;background:#fff;outline:none;width:110px;">`,null)}
  ${_spRow('Squad Capacity (points)','Default story points per squad per Release',
    _spStepper('sp-vq',appSettings.defaultSquadCapacity,"spStep('sp-vq',-1,10,500)","spStep('sp-vq',1,10,500)",true)+'<span style="font-size:10px;color:#6b6b68;font-family:\'DM Sans\',sans-serif;">pts</span>',null)}
  ${_spRow('Team Velocity','Calibrates AI story sizing. Low (~3), Med (~6), High (~8) pts/dev/sprint',
    `<div style="display:inline-flex;border:1px solid #D0D5E8;border-radius:5px;overflow:hidden;height:26px;">
      ${segBtn('low','Low')}${segBtn('med','Med').replace('border-right:1px solid #D0D5E8;','border-right:1px solid #D0D5E8;')}${segLast('high','High')}
    </div>`,null,true)}`;
}

// ── Helper: escape HTML for display in inputs ──
function _spEsc(str){
  return String(str||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Helper: char counter for textareas ──
function spCharCount(el,counterId,max){
  const len=el.value.length;
  const ct=document.getElementById(counterId);
  if(ct) ct.textContent=len+'/'+max;
}

// ── Panel 5: Product Profiles ──
function spP5(){
  return `<div class="sp-p5-shell" id="sp-p5-shell">
    <div class="sp-p5-list" id="sp-p5-list">${spP5ListHTML()}</div>
    <div class="sp-p5-divider" id="sp-p5-divider"></div>
    <div class="sp-p5-edit" id="sp-p5-edit" style="display:none;">${spP5EditHTML(null)}</div>
  </div>`;
}

// ── Product Profiles list HTML ──
function spP5ListHTML(){
  const isAdmin = _spIsAdmin();
  const addBtnTop = (productProfiles.length>0 && isAdmin)
    ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <span style="font-size:9px;font-weight:700;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${productProfiles.length} Profile${productProfiles.length!==1?'s':''}</span>
        <button onclick="spP5ShowEdit(null)" class="pgt-btn-outline" style="padding:5px 10px;font-size:10px;">
          <i class="ti ti-plus" style="font-size:11px;" aria-hidden="true"></i> Add Profile
        </button>
      </div>`
    : (productProfiles.length>0
      ? `<div style="margin-bottom:12px;"><span style="font-size:9px;font-weight:700;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${productProfiles.length} Profile${productProfiles.length!==1?'s':''}</span></div>`
      : '');

  if(!productProfiles.length){
    return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;color:#A5AFBE;height:100%;">
      <div style="width:40px;height:40px;border-radius:10px;background:#F4F6FA;display:flex;align-items:center;justify-content:center;margin-bottom:12px;">
        <i class="ti ti-box-multiple" style="font-size:18px;color:#A5AFBE;" aria-hidden="true"></i>
      </div>
      <div style="font-size:12px;font-weight:600;color:#6b6b68;margin-bottom:6px;font-family:'DM Sans',sans-serif;">No product profiles yet</div>
      <div style="font-size:10px;color:#A5AFBE;line-height:1.6;margin-bottom:16px;max-width:220px;font-family:'DM Sans',sans-serif;">${isAdmin?'Add your first profile to get started. Each profile feeds the Home tab selector and powers all AI diagnostics.':'Ask an admin to add a product profile to get started.'}</div>
      ${isAdmin?`<button onclick="spP5ShowEdit(null)" class="pgt-btn-outline" style="padding:7px 14px;font-size:11px;">
        <i class="ti ti-plus" style="font-size:12px;" aria-hidden="true"></i> Add Your First Profile
      </button>`:''}
    </div>`;
  }

  const cards=productProfiles.map(p=>{
    const docs=p.docs||[];
    const totalW=docs.reduce((s,d)=>s+d.wordCount,0);
    const typeBadge={'B2C Product':'B2C','B2B SaaS':'B2B SaaS','Internal Tool':'Internal','System/API':'System'}[p.productType]||p.productType||'';
    const indStr=p.industry?p.industry:'No industry';
    return `<div class="sp-profile-chip">
      <div class="sp-profile-chip-top">
        <span class="sp-profile-chip-name">${_spEsc(p.productName)}</span>
        <span class="sp-profile-type-badge">${_spEsc(typeBadge)}</span>
        <div class="sp-profile-chip-actions">
          <button class="sp-profile-action-btn" onclick="spP5ShowEdit('${p.id}')" aria-label="${isAdmin?'Edit profile':'View profile'}"><i class="ti ${isAdmin?'ti-pencil':'ti-eye'}" aria-hidden="true"></i></button>
          ${isAdmin?`<button class="sp-profile-action-btn sp-profile-action-del" onclick="spP5DeleteProfile('${p.id}')" aria-label="Delete profile"><i class="ti ti-trash" aria-hidden="true"></i></button>`:''}
        </div>
      </div>
      ${p.productDesc?`<div class="sp-profile-chip-desc">${_spEsc(p.productDesc)}</div>`:''}
      <div class="sp-profile-chip-meta">
        ${indStr!=='No industry'?`<span><i class="ti ti-world" style="font-size:9px;" aria-hidden="true"></i> ${_spEsc(indStr)}</span>`:''}
      </div>
    </div>`;
  }).join('');
  return addBtnTop+`<div class="sp-profile-chip-grid">${cards}</div>`;
}

// ── Product profile edit form HTML ──
// Phase 3 (v8.107): genuine dual-mode rendering, not `disabled` attributes
// sprinkled across a dozen different control types. Per external
// adversarial review — this function has four custom type-selector buttons
// (not a native <select>, `disabled` does nothing to them) and an upload
// zone with three separate click targets, none of which a naive "add
// disabled to inputs" pass would touch. Read-only mode renders flat,
// non-interactive display versions of each control instead. The
// new-profile path (id === null) is only ever reachable for admins — the
// "Add Profile" buttons that call it are already hidden for Regular Users
// in spP5ListHTML() — so readOnly+isNew is a deliberately unreachable
// combination here, not an oversight.
function spP5EditHTML(id, readOnly){
  readOnly = !!readOnly;
  const p=id?productProfiles.find(x=>x.id===id):null;
  const isNew=!p;
  const industries=['Banking & Finance','Cross-Industry','Education / EdTech','Energy & Utilities',
    'Government / Public Sector','Health & Life Sciences','Insurance','Manufacturing',
    'Media & Entertainment','Real Estate / PropTech','Retail & Consumer Goods',
    'Supply Chain & Logistics','Technology & Software','Telecommunications','Travel & Hospitality'];
  const pInd=p&&p.industry?p.industry:'';
  const industryOpts=`<option value="" ${!pInd?'selected':''}>Select industry...</option>`
    +industries.map(v=>`<option value="${v}"${v===pInd?' selected':''}>${v}</option>`).join('');
  const types=['B2C Product','B2B SaaS','Internal Tool','System/API'];
  const activeType=(p&&p.productType?p.productType:'B2C Product');
  const typeLabels={'B2C Product':'B2C','B2B SaaS':'B2B SaaS','Internal Tool':'Internal','System/API':'System'};
  const typeSegs=readOnly
    ? `<div style="display:flex;align-items:center;height:26px;padding:0 8px;font-size:10px;color:#1a1a1a;font-family:'DM Sans',sans-serif;">${typeLabels[activeType]||activeType}</div>`
    : types.map(t=>{
        const active=activeType===t;
        return `<button class="sp-p5-type-btn${active?' active':''}" data-v="${t}" onclick="spP5TypeSeg(this)">${typeLabels[t]}</button>`;
      }).join('');
  const docs=p&&p.docs?p.docs:[];
  const totalWords=docs.reduce((s,d)=>s+d.wordCount,0);
  const meterPct=Math.min(100,Math.round(totalWords/20000*100));
  const meterColor=meterPct>80?'#C8870A':'#5F1EBE';
  const docChips=docs.map((d,i)=>
    `<span class="sp-file-chip${d.tooLittle?' sp-file-chip-warn':''}"><i class="ti ti-file" style="font-size:9px;" aria-hidden="true"></i> ${_spEsc(d.name)} &middot; ${d.tooLittle?'too little text':d.wordCount.toLocaleString()+'w'+(d.truncated?' (truncated)':'')}${readOnly?'':`<button class="sp-file-chip-remove" onclick="spRemoveDoc('p5',${i})" aria-label="Remove file"><i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i></button>`}</span>`
  ).join('');
  const dis = readOnly ? 'disabled' : '';
  const disSuffix = readOnly ? 'background:#F4F6FA;color:#9a9a96;cursor:not-allowed;' : 'color:#1a1a1a;background:#fff;';

  return `<div class="sp-p5-edit-hdr" style="position:relative;">
    <div style="padding-right:32px;">
      <div class="sp-p5-edit-title">${isNew?'New Profile':(readOnly?'Viewing: '+_spEsc(p.productName):'Editing: '+_spEsc(p.productName))}</div>
      <div class="sp-p5-edit-sub">${isNew?'Set up this product\'s AI context - used across every diagnostic session.':(readOnly?'View this product\'s AI context. Ask an admin to make changes.':'Update this product\'s AI context - changes apply from the next session.')}</div>
    </div>
    <button class="sp-p5-edit-close" onclick="${readOnly?'spP5ShowList()':'spP5TryClose()'}" aria-label="Close panel" title="Close"><i class="ti ti-x" style="font-size:11px;" aria-hidden="true"></i></button>
  </div>
  <input type="hidden" id="sp-p5-editing-id" value="${id||''}" />
  <div class="sp-p5-edit-scroll">

    <div style="padding:8px 0 6px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Product Name <span style="color:#A32D2D;">*</span></label>
          <input type="text" id="sp-p5-name" ${dis} value="${_spEsc(p&&p.productName?p.productName:'')}" placeholder="e.g. Focusly, Order Management Suite" style="width:100%;height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 7px;font-size:10px;font-family:'DM Sans',sans-serif;box-sizing:border-box;${disSuffix}">
        </div>
        <div>
          <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Product Type <span style="color:#A32D2D;">*</span></label>
          <div style="display:flex;border:1px solid #D0D5E8;border-radius:5px;overflow:hidden;height:26px;${readOnly?'background:#F4F6FA;':''}" id="sp-p5-type-seg">${typeSegs}</div>
          <input type="hidden" id="sp-p5-type" value="${_spEsc(activeType)}" />
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">What does this product do? <span style="color:#A32D2D;">*</span></label>
        <textarea id="sp-p5-desc" ${dis} oninput="spCharCount(this,'sp-p5-desc-ct',2000)" maxlength="2000" rows="2" placeholder="e.g. Orchestrates omnichannel orders across warehouse, carrier and store channels" style="width:100%;border:1px solid #D0D5E8;border-radius:5px;padding:5px 7px;font-size:10px;font-family:'DM Sans',sans-serif;resize:vertical;min-height:44px;box-sizing:border-box;${disSuffix}">${_spEsc(p&&p.productDesc?p.productDesc:'')}</textarea>
        <div style="display:flex;justify-content:space-between;margin-top:2px;">
          <span style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">One sentence - primary AI context signal</span>
          <span id="sp-p5-desc-ct" style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${(p&&p.productDesc?p.productDesc:'').length}/2000</span>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Industry Vertical</label>
          <select id="sp-p5-industry" ${dis} style="width:100%;height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 7px;font-size:10px;font-family:'DM Sans',sans-serif;${disSuffix}">${industryOpts}</select>
          <div style="font-size:9px;color:#A5AFBE;margin-top:3px;font-family:'DM Sans',sans-serif;">Overrides company-level</div>
        </div>
        <div>
          <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Primary User / ICP</label>
          <input type="text" id="sp-p5-icp" ${dis} value="${_spEsc(p&&p.icp?p.icp:'')}" placeholder="e.g. Knowledge workers, Warehouse ops" style="width:100%;height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 7px;font-size:10px;font-family:'DM Sans',sans-serif;box-sizing:border-box;${disSuffix}">
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Current KPIs Being Tracked</label>
        <input type="text" id="sp-p5-kpis" ${dis} value="${_spEsc(p&&p.kpis?p.kpis:'')}" placeholder="e.g. DAU, session length, 7-day retention" style="width:100%;height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 7px;font-size:10px;font-family:'DM Sans',sans-serif;box-sizing:border-box;${disSuffix}">
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Biggest Known Problem</label>
        <input type="text" id="sp-p5-problem" ${dis} value="${_spEsc(p&&p.problem?p.problem:'')}" placeholder="e.g. High drop-off after first week" style="width:100%;height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 7px;font-size:10px;font-family:'DM Sans',sans-serif;box-sizing:border-box;${disSuffix}">
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Additional Context</label>
        <textarea id="sp-p5-context" ${dis} oninput="spCharCount(this,'sp-p5-context-ct',2000)" maxlength="2000" rows="2" placeholder="Product-specific constraints, tech stack, org context..." style="width:100%;border:1px solid #D0D5E8;border-radius:5px;padding:5px 7px;font-size:10px;font-family:'DM Sans',sans-serif;resize:vertical;min-height:44px;box-sizing:border-box;${disSuffix}">${_spEsc(p&&p.additionalContext?p.additionalContext:'')}</textarea>
        <div style="display:flex;justify-content:flex-end;"><span id="sp-p5-context-ct" style="font-size:9px;color:#A5AFBE;font-family:'DM Sans',sans-serif;">${(p&&p.additionalContext?p.additionalContext:'').length}/2000</span></div>
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Reference Link</label>
        <input type="url" id="sp-p5-reflink" ${dis} value="${_spEsc(p&&p.refLink?p.refLink:'')}" placeholder="Confluence, Google Doc, app store listing..." style="width:100%;height:26px;border:1px solid #D0D5E8;border-radius:5px;padding:0 7px;font-size:10px;font-family:'DM Sans',sans-serif;box-sizing:border-box;${disSuffix}">
      </div>

      <div style="margin-bottom:10px;">
        <label style="font-size:10px;font-weight:600;color:#000;display:block;margin-bottom:4px;font-family:'DM Sans',sans-serif;">Supporting Documents</label>
        ${readOnly?'':`<div class="sp-upload-zone" onclick="document.getElementById('sp-p5-file-input').click()" style="padding:7px 10px;">
          <div class="sp-upload-icon" style="width:22px;height:22px;border-radius:4px;font-size:11px;"><i class="ti ti-upload" aria-hidden="true"></i></div>
          <div class="sp-upload-text">
            <div class="sp-upload-title" style="font-size:9px;">${docs.length>=5?'Maximum files reached':'Upload files'}</div>
            <div class="sp-upload-sub">docx, pdf, txt, xlsx, csv &middot; Max 5MB &middot; Up to 5 files</div>
          </div>
          ${docs.length<5?'<button class="sp-upload-btn" onclick="event.stopPropagation();document.getElementById(\'sp-p5-file-input\').click()">Browse</button>':''}
        </div>
        <input type="file" id="sp-p5-file-input" class="sp-upload-input" multiple accept=".pdf,.docx,.txt,.csv,.xlsx" onchange="spHandleFileUpload('p5',this)" />`}
        <div id="sp-p5-chips">${docChips}</div>
        ${docs.length>0?`<div class="sp-word-meter-wrap"><div class="sp-word-meter-bar" style="width:${meterPct}%;background:${meterColor};"></div></div><div class="sp-word-meter-label">${totalWords.toLocaleString()} / 20,000 words used &middot; ${docs.length} file${docs.length!==1?'s':''}</div>`:''}
      </div>
    </div>

  </div>
  <div class="sp-p5-edit-footer">
    ${readOnly
      ? `<button onclick="spP5ShowList()" class="sp-p5-discard-btn" style="margin-left:auto;">Close</button>`
      : `<button onclick="spP5TryClose()" class="sp-p5-discard-btn">Discard</button>
         <button onclick="spP5SaveProfile()" class="sp-p5-apply-btn">Apply</button>`
    }
  </div>`;
}

// ── Section 5 CRUD functions ──

// ── Helper: enable/disable page footer buttons when profile edit panel is open ──
function _spSetFooterBtns(enabled){
  const tip='Apply or Discard your profile changes first.';
  ['settingsPageSave()','spCancelChanges()'].forEach(fn=>{
    const btn=document.querySelector(`#settings-page button[onclick="${fn}"]`);
    if(!btn)return;
    btn.disabled=!enabled;
    btn.title=enabled?'':tip;
    btn.style.opacity=enabled?'':'0.4';
    btn.style.cursor=enabled?'':'not-allowed';
    btn.style.pointerEvents=enabled?'':'none';
  });
}

// ── Profile edit dirty tracking (v8.53) ──
let _spP5Snapshot=null; // field values captured when edit panel opens
let _spP5DocsDirty=false; // set true on any doc upload/remove during edit

function _spP5CaptureSnapshot(){
  const fields=['sp-p5-name','sp-p5-desc','sp-p5-type','sp-p5-icp','sp-p5-industry','sp-p5-kpis','sp-p5-problem','sp-p5-context','sp-p5-reflink'];
  const snap={};
  fields.forEach(id=>{const el=document.getElementById(id);if(el)snap[id]=el.value||'';});
  _spP5Snapshot=snap;
  _spP5DocsDirty=false;
}

function _spP5IsDirty(){
  if(_spP5DocsDirty)return true;
  if(!_spP5Snapshot)return false;
  const fields=['sp-p5-name','sp-p5-desc','sp-p5-type','sp-p5-icp','sp-p5-industry','sp-p5-kpis','sp-p5-problem','sp-p5-context','sp-p5-reflink'];
  return fields.some(id=>{
    const el=document.getElementById(id);
    return el&&(el.value||'')!==(_spP5Snapshot[id]||'');
  });
}

// Called by Discard button and ✕ — warns if dirty, silent if clean
function spP5TryClose(){
  if(!_spP5IsDirty()){spP5ShowList();return;}
  // Determine profile name for modal copy
  const nameEl=document.getElementById('sp-p5-name');
  const profileName=(nameEl&&nameEl.value.trim())||'this profile';
  const _ov=document.createElement('div');
  _ov.className='modal-overlay';
  _ov.id='sp-p5-discard-overlay';
  _ov.innerHTML=`<div class="modal" style="max-width:360px;position:relative;">
    <div style="padding:16px 16px 12px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:600;color:var(--t1);">Discard profile changes?</div>
    </div>
    <div class="modal-body" style="font-size:11px;color:var(--t2);line-height:1.5;">Your edits to <strong>${_spEsc(profileName)}</strong> haven't been saved. This cannot be undone.</div>
    <div class="modal-footer">
      <button class="modal-cancel-btn" onclick="document.getElementById('sp-p5-discard-overlay').remove()">Keep Editing</button>
      <button class="modal-confirm-btn" style="background:var(--red);" onclick="spP5ConfirmDiscard()">Discard</button>
    </div>
  </div>`;
  document.body.appendChild(_ov);
  if(typeof trapFocus==='function')trapFocus(_ov);
  const _esc=function(ev){if(ev.key==='Escape'){_ov.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
}

function spP5ConfirmDiscard(){
  const _ov=document.getElementById('sp-p5-discard-overlay');
  if(_ov)_ov.remove();
  spP5ShowList();
}

function spP5ShowList(){
  // Clear in-place to preserve captured references in async upload callbacks
  if(Array.isArray(window._spP5NewDocs)){window._spP5NewDocs.length=0;}else{window._spP5NewDocs=[];}
  _spP5Snapshot=null;
  _spP5DocsDirty=false;
  const listEl=document.getElementById('sp-p5-list');
  const editEl=document.getElementById('sp-p5-edit');
  const divEl =document.getElementById('sp-p5-divider');
  if(listEl){listEl.innerHTML=spP5ListHTML();listEl.style.flex='1';listEl.style.minWidth='';listEl.style.overflow='';}
  if(editEl){editEl.style.display='none';}
  if(divEl) {divEl.classList.remove('visible');}
  // Re-enable page-level Save & Exit and Cancel
  _spSetFooterBtns(true);
}

function spP5ShowEdit(id){
  const readOnly = !_spIsAdmin();
  const listEl=document.getElementById('sp-p5-list');
  const editEl=document.getElementById('sp-p5-edit');
  const divEl =document.getElementById('sp-p5-divider');
  if(editEl){editEl.innerHTML=spP5EditHTML(id, readOnly);editEl.style.display='flex';}
  if(divEl) {divEl.classList.add('visible');}
  // Narrow the list to 40% so edit panel takes remaining space - true split not overlay
  if(listEl){listEl.style.flex='0 0 40%';listEl.style.minWidth='0';listEl.style.overflow='hidden auto';}
  // v8.53: drop card grid to 2-col when edit panel is open
  const gridEl=listEl?listEl.querySelector('.sp-profile-chip-grid'):null;
  if(gridEl)gridEl.classList.add('sp-profile-chip-grid-narrow');
  // Phase 3 (v8.107): read-only mode skips snapshot capture and the footer
  // disable entirely — there is nothing to become dirty when nothing can be
  // edited, and leaving dirty-tracking machinery running unconditionally
  // was flagged in adversarial review as wasted work at best, a real bug at
  // worst if that state ever leaked into a later edit session.
  if(!readOnly){
    _spP5CaptureSnapshot();
    // Disable page-level Save & Exit and Cancel while profile form is open
    _spSetFooterBtns(false);
  }
}

function spP5TypeSeg(btn){
  const seg=document.getElementById('sp-p5-type-seg');
  if(!seg)return;
  seg.querySelectorAll('.sp-p5-type-btn').forEach(b=>{
    b.classList.remove('active');
    b.style.background='#fff';b.style.color='#6b6b68';b.style.fontWeight='500';
  });
  btn.classList.add('active');
  btn.style.background='#EEEDFE';btn.style.color='#5F1EBE';btn.style.fontWeight='700';
  const hiddenEl=document.getElementById('sp-p5-type');
  if(hiddenEl)hiddenEl.value=btn.dataset.v;
}

// ── Save a product profile (Phase 2, v8.104) ──
// Now async — a genuine per-row INSERT or UPDATE against mt_products, not a
// push into an array followed by a blanket-overwrite of the whole thing.
// New products get a real UUID (_ssUUID(), already used for session IDs)
// instead of the old 'pp_'+Date.now() string, which isn't valid for
// mt_products.id's real uuid column. The in-memory array and cache are only
// updated AFTER a confirmed successful write — a failed save (e.g. the
// unique(company_id, name) constraint firing on a duplicate name) should
// never leave a phantom entry the database doesn't actually have.
async function spP5SaveProfile(){
  const nameEl=document.getElementById('sp-p5-name');
  const descEl=document.getElementById('sp-p5-desc');
  const typeEl=document.getElementById('sp-p5-type');
  const name=(nameEl&&nameEl.value.trim())||'';
  const desc=(descEl&&descEl.value.trim())||'';
  const type=(typeEl&&typeEl.value)||'B2C Product';
  if(!name){
    if(nameEl){nameEl.style.borderColor='#A32D2D';nameEl.focus();}
    if(typeof showToast==='function')showToast('Product name is required.','error');
    return;
  }
  if(!desc){
    if(descEl){descEl.style.borderColor='#A32D2D';descEl.focus();}
    if(typeof showToast==='function')showToast('Product description is required.','error');
    return;
  }
  const editingId=(document.getElementById('sp-p5-editing-id')||{}).value||'';
  const existing=editingId?productProfiles.find(p=>p.id===editingId):null;
  const refLinkVal=((document.getElementById('sp-p5-reflink')||{}).value||'').trim();
  // Soft URL validation — warn but don't block
  if(refLinkVal&&!(refLinkVal.startsWith('http://')||refLinkVal.startsWith('https://'))){
    const refEl=document.getElementById('sp-p5-reflink');
    if(refEl)refEl.style.borderColor='#C8870A';
    if(typeof showToast==='function')showToast('Reference link should start with https://','error');
    return;
  }

  const companyId=_spGetActiveCompanyId();
  if(!companyId){ if(typeof showToast==='function')showToast('No active company. Cannot save.','error'); return; }
  const client=(typeof authInit==='function')?authInit():null;
  if(!client){ if(typeof showToast==='function')showToast('Not connected. Check your network and try again.','error'); return; }

  // Docs: use existing docs for edits, _spP5NewDocs for new profiles
  const docsToSave=existing?existing.docs:(window._spP5NewDocs||[]);
  const newId=editingId||(typeof _ssUUID==='function'?_ssUUID():('pp_'+Date.now()));
  const profile={
    id:newId,
    productName:name,
    productDesc:desc,
    productType:type,
    industry:(document.getElementById('sp-p5-industry')||{}).value||'',
    kpis:((document.getElementById('sp-p5-kpis')||{}).value||'').trim(),
    problem:((document.getElementById('sp-p5-problem')||{}).value||'').trim(),
    icp:((document.getElementById('sp-p5-icp')||{}).value||'').trim(),
    additionalContext:((document.getElementById('sp-p5-context')||{}).value||'').trim(),
    refLink:refLinkVal,
    docs:docsToSave.slice() // copy array
  };

  const applyBtn=document.querySelector('.sp-p5-apply-btn');
  if(applyBtn)applyBtn.disabled=true;

  try {
    const dbRow=_spMapProductToDB(profile, companyId);
    let dbError;
    if(editingId){
      const { error } = await client.from('mt_products').update(dbRow).eq('id', editingId);
      dbError=error;
    } else {
      // created_by is NOT NULL on mt_products — an UPDATE leaves an
      // existing row's value untouched, but a fresh INSERT needs one
      // explicitly. Confirmed against the actual RLS policy that this
      // isn't enforced by a WITH CHECK clause (only company_id + admin role
      // are), so any non-null value satisfies the database constraint —
      // but currentUser.id is still the correct value regardless, for
      // accurate attribution of who actually created the product.
      const { error } = await client.from('mt_products').insert(Object.assign({ id:newId, created_by:currentUser.id }, dbRow));
      dbError=error;
    }
    if(dbError){
      // Postgres unique_violation — checked via the structured error code,
      // not by matching message text, since message wording isn't a stable
      // API contract across Postgres/Supabase versions.
      if(dbError.code==='23505'){
        if(typeof showToast==='function')showToast('A product with this name already exists.','error');
      } else {
        if(typeof showToast==='function')showToast('Couldn\u2019t save profile: '+dbError.message,'error');
      }
      return;
    }

    if(editingId){
      const idx=productProfiles.findIndex(p=>p.id===editingId);
      if(idx>=0)productProfiles[idx]=profile;
      else productProfiles.push(profile);
    } else {
      productProfiles.push(profile);
      window._spP5NewDocs=[]; // clear temp store after save
    }
    try { localStorage.setItem(_spPpKey(companyId), JSON.stringify(productProfiles.map(_spStripDocs))); } catch(e) {}
    spMarkDirty();
    spP5ShowList();
    if(typeof showToast==='function')showToast('Profile saved.','success');
  } catch(e) {
    if(typeof showToast==='function')showToast('Couldn\u2019t save profile. Check your network and try again.','error');
  } finally {
    if(applyBtn)applyBtn.disabled=false;
  }
}

function spP5DeleteProfile(id){
  const p=productProfiles.find(x=>x.id===id);
  if(!p)return;
  const _ov=document.createElement('div');
  _ov.className='modal-overlay';
  _ov.id='sp-p5-del-overlay';
  _ov.innerHTML=`<div class="modal" style="max-width:360px;position:relative;">
    <button onclick="document.getElementById('sp-p5-del-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:#6b6b68;display:flex;align-items:center;border-radius:4px;">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">
      <div style="width:30px;height:30px;border-radius:7px;background:#FCE8E8;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
        <i class="ti ti-trash" style="font-size:15px;color:#A32D2D;" aria-hidden="true"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;color:#000;line-height:1.35;margin-bottom:6px;">Delete "${_spEsc(p.productName)}"?</div>
        <div style="font-size:11px;color:#6b6b68;line-height:1.6;">This profile will be permanently removed. Any active session using this profile will not be affected.</div>
      </div>
    </div>
    <div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">
      <button class="modal-cancel-btn" id="sp-p5-del-cancel-btn" onclick="document.getElementById('sp-p5-del-overlay').remove()">Cancel</button>
      <button id="sp-p5-del-confirm-btn" style="background:#A32D2D;color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:'DM Sans',sans-serif;cursor:pointer;" onclick="spP5ConfirmDelete('${id}')">Delete Profile</button>
    </div>
  </div>`;
  document.body.appendChild(_ov);
  if(typeof trapFocus==='function')trapFocus(_ov);
  const _esc=function(ev){if(ev.key==='Escape'){_ov.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
}

// ── Confirm product delete (Phase 2, v8.104) ──
// Now async — a genuine DELETE against mt_products, not an array filter
// followed by a blanket-overwrite. Zero-rows-matched (someone else already
// deleted this product) is detected explicitly via the delete's exact row
// count, rather than assumed to have succeeded.
async function spP5ConfirmDelete(id){
  const _ov=document.getElementById('sp-p5-del-overlay');
  const delBtn=document.getElementById('sp-p5-del-confirm-btn');
  const cancelBtn=document.getElementById('sp-p5-del-cancel-btn');
  if(delBtn)delBtn.disabled=true;
  if(cancelBtn)cancelBtn.disabled=true;

  const companyId=_spGetActiveCompanyId();
  const client=(typeof authInit==='function')?authInit():null;
  if(!client||!companyId){
    if(_ov)_ov.remove();
    if(typeof showToast==='function')showToast('Not connected. Check your network and try again.','error');
    return;
  }

  try {
    const { error, count } = await client.from('mt_products').delete({ count:'exact' }).eq('id', id);
    if(_ov)_ov.remove();
    if(error){
      if(typeof showToast==='function')showToast('Couldn\u2019t delete profile: '+error.message,'error');
      return;
    }
    // Sync local state to reality regardless of whether this delete matched
    // a row — if count is 0, someone else already removed it, and the local
    // list should stop showing it either way.
    productProfiles=productProfiles.filter(p=>p.id!==id);
    if(activeProfileId===id)activeProfileId=null;
    try { localStorage.setItem(_spPpKey(companyId), JSON.stringify(productProfiles.map(_spStripDocs))); } catch(e) {}
    spP5ShowList();
    if(count===0){
      if(typeof showToast==='function')showToast('This product was already removed.','error');
    } else {
      spMarkDirty();
      if(typeof showToast==='function')showToast('Profile deleted.','success');
    }
  } catch(e) {
    if(_ov)_ov.remove();
    if(typeof showToast==='function')showToast('Couldn\u2019t delete profile. Check your network and try again.','error');
  }
}

// ── File upload handler (shared for company 'co' and product 'p5' scopes) ──
function spHandleFileUpload(scope,inputEl){
  const files=Array.from(inputEl.files||[]);
  if(!files.length)return;

  let targetDocs;
  if(scope==='co'){
    targetDocs=companyProfile.companyDocs;
  } else {
    const editingId=(document.getElementById('sp-p5-editing-id')||{}).value||'';
    if(editingId){
      const p=productProfiles.find(x=>x.id===editingId);
      targetDocs=p?p.docs:[];
    } else {
      if(!window._spP5NewDocs)window._spP5NewDocs=[];
      targetDocs=window._spP5NewDocs;
    }
  }
  const MAX_FILES=5;const MAX_WORDS=4000;const MAX_SIZE=5*1024*1024;
  const remainingSlots=Math.max(0,MAX_FILES-targetDocs.length);
  if(files.length>remainingSlots){
    if(typeof showToast==='function')showToast(
      remainingSlots===0
        ? 'Maximum 5 files reached. Remove a file to add another.'
        : `Only ${remainingSlots} slot${remainingSlots!==1?'s':''} remaining. First ${remainingSlots} file${remainingSlots!==1?'s':''} added.`,
      'error'
    );
  }
  const filesToProcess=files.slice(0,remainingSlots);
  filesToProcess.forEach(function(file){
    if(file.size>MAX_SIZE){
      if(typeof showToast==='function')showToast(file.name+' exceeds 5MB limit.','error');return;
    }
    const docScope=scope==='co'?'company':'product';
    const docId=(typeof _makeDocId==='function')?_makeDocId():('doc_'+Date.now()+'_'+Math.random().toString(36).slice(2,6));
    const pendingDoc={
      id:docId,name:file.name,scope:docScope,sessionScoped:false,
      docType:'other',wordCount:0,extractedText:'',aiSummary:'',
      keyDecisions:[],constraints:[],openQuestions:[],metrics:[],
      summaryStatus:'pending',uploadedAt:Date.now()
    };
    targetDocs.push(pendingDoc);
    spMarkDirty();
    if(scope==='p5')_spP5DocsDirty=true;
    spRefreshDocUI(scope,targetDocs);

    // Async extraction + summarisation — closed over targetDocs and docId
    (typeof extractTextFromFile==='function'?extractTextFromFile(file):Promise.reject(new Error('extractTextFromFile not available')))
      .then(function(text){
        // Find doc by ID in captured targetDocs array (in-place splice contract maintained)
        const live=targetDocs.find(function(d){return d.id===docId;});
        if(!live)return; // removed while processing
        live.extractedText=text||'';
        live.wordCount=Math.min((text||'').trim().split(/\s+/).filter(Boolean).length,MAX_WORDS);
        if(typeof summariseDocument==='function'){
          return summariseDocument(text,file.name).then(function(result){
            const live2=targetDocs.find(function(d){return d.id===docId;});
            if(!live2)return;
            live2.aiSummary=result.aiSummary||'';
            live2.docType=result.docType||'other';
            live2.keyDecisions=Array.isArray(result.keyDecisions)?result.keyDecisions:[];
            live2.constraints=Array.isArray(result.constraints)?result.constraints:[];
            live2.openQuestions=Array.isArray(result.openQuestions)?result.openQuestions:[];
            live2.metrics=Array.isArray(result.metrics)?result.metrics:[];
            live2.summaryStatus='ready';
            spMarkDirty();
            if(scope==='p5')_spP5DocsDirty=true;
            spRefreshDocUI(scope,targetDocs);
          }).catch(function(){
            // Summarisation failed — keep raw text, mark as failed (chip shows as ready with Other badge)
            const live3=targetDocs.find(function(d){return d.id===docId;});
            if(!live3)return;
            live3.summaryStatus='failed';
            live3.docType='other';
            spRefreshDocUI(scope,targetDocs);
          });
        } else {
          live.summaryStatus='failed';
          spRefreshDocUI(scope,targetDocs);
        }
      })
      .catch(function(err){
        const live=targetDocs.find(function(d){return d.id===docId;});
        if(!live)return; // removed while processing — no toast
        live.summaryStatus='failed';
        live.extractedText='';
        const msg=(err&&err.message==='PASSWORD_PROTECTED')
          ?file.name+' is password-protected — remove the password and re-upload.'
          :file.name+': Could not read file.';
        if(typeof showToast==='function')showToast(msg,'error');
        spRefreshDocUI(scope,targetDocs);
      });
  });
  inputEl.value='';
}

function spRemoveDoc(scope,docId){
  // docId is now a doc ID string (not an index) — uses in-place splice to preserve captured references
  let targetDocs;
  if(scope==='co'){
    targetDocs=companyProfile.companyDocs;
  } else {
    const editingId=(document.getElementById('sp-p5-editing-id')||{}).value||'';
    if(editingId){
      const p=productProfiles.find(x=>x.id===editingId);
      targetDocs=p?p.docs:[];
    } else {
      targetDocs=window._spP5NewDocs||[];
    }
  }
  const idx=targetDocs.findIndex(function(d){return d.id===docId;});
  if(idx!==-1)targetDocs.splice(idx,1);
  spMarkDirty();
  if(scope==='p5')_spP5DocsDirty=true;
  spRefreshDocUI(scope,targetDocs);
}

function spRefreshDocUI(scope,docs){
  const prefix=scope==='co'?'sp-co':'sp-p5';
  const chipsEl=document.getElementById(prefix+'-chips');
  const totalWords=docs.reduce(function(s,d){return s+(d.wordCount||0);},0);
  const meterPct=Math.min(100,Math.round(totalWords/20000*100));
  const meterColor=meterPct>80?'#C8870A':'#5F1EBE';
  if(chipsEl){
    var _rmOnclick="spRemoveDoc('"+scope+"',this.dataset.docId)";
    chipsEl.innerHTML=docs.map(function(d){
      var safeName=typeof _spEsc==='function'?_spEsc(d.name||''):String(d.name||'');
      var safeId=typeof _spEsc==='function'?_spEsc(d.id||''):String(d.id||'');
      var rmBtn='<button class="sp-file-chip-remove" data-doc-id="'+safeId+'" onclick="'+_rmOnclick+'" aria-label="Remove file"><i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i></button>';
      if(d.summaryStatus==='pending'){
        return '<span class="sp-file-chip cc-parse-loading"><span class="cc-spin-sm"></span> '+safeName+' <span style="font-size:9px;color:var(--t4);">Analysing...</span>'+rmBtn+'</span>';
      }else if(d.summaryStatus==='failed'||d.summaryStatus==='ready'){
        var wLabel=d.wordCount?(d.wordCount.toLocaleString()+'w'):'';
        return '<span class="sp-file-chip"><i class="ti ti-file" style="font-size:9px;" aria-hidden="true"></i> '+safeName+(wLabel?' &middot; '+wLabel:'')+rmBtn+'</span>';
      }else{
        var wLabel2=d.wordCount?(d.wordCount.toLocaleString()+'w'):'';
        var warn=d.tooLittle?' sp-file-chip-warn':'';
        return '<span class="sp-file-chip'+warn+'"><i class="ti ti-file" style="font-size:9px;" aria-hidden="true"></i> '+safeName+' &middot; '+(d.tooLittle?'too little text':wLabel2+(d.truncated?' (truncated)':''))+(safeId?rmBtn:'')+'</span>';
      }
    }).join('');
  }
  const existingWrap=document.getElementById(prefix+'-meter-wrap');
  const existingLbl=document.getElementById(prefix+'-meter-lbl');
  if(existingLbl)existingLbl.remove();
  if(existingWrap)existingWrap.remove();
  if(docs.length>0&&chipsEl){
    const meterHTML='<div class="sp-word-meter-wrap" id="'+prefix+'-meter-wrap"><div class="sp-word-meter-bar" style="width:'+meterPct+'%;background:'+meterColor+';"></div></div>'
      +'<div class="sp-word-meter-label" id="'+prefix+'-meter-lbl">'+totalWords.toLocaleString()+' / 20,000 words used &middot; '+docs.length+' file'+(docs.length!==1?'s':'')+'</div>';
    chipsEl.insertAdjacentHTML('afterend',meterHTML);
  }
  const zones=document.querySelectorAll('.sp-upload-zone .sp-upload-title');
  zones.forEach(function(el){el.textContent=docs.length>=5?'Maximum files reached':'Upload files';});
}

// ── Populate company profile fields from state on settings open ──
// Called from spPopulate() after existing section population
function spPopulateCompanyProfile(){
  const setVal=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val||'';};
  setVal('sp-co-name',    companyProfile.companyName);
  setVal('sp-co-url',     companyProfile.companyUrl);
  setVal('sp-co-strategy',companyProfile.companyStrategy);
  setVal('sp-co-context', companyProfile.companyContext);
  setVal('sp-co-reflink', companyProfile.companyRefLink);
  const indEl=document.getElementById('sp-co-industry');
  if(indEl)indEl.value=companyProfile.companyIndustry||'';
  // Char counters
  const stEl=document.getElementById('sp-co-strategy');
  const stCt=document.getElementById('sp-co-strategy-ct');
  if(stEl&&stCt)stCt.textContent=(stEl.value.length)+'/2000';
  const ctEl=document.getElementById('sp-co-context');
  const ctCt=document.getElementById('sp-co-context-ct');
  if(ctEl&&ctCt)ctCt.textContent=(ctEl.value.length)+'/2000';
  // Re-render chips + meter
  spRefreshDocUI('co',companyProfile.companyDocs||[]);
}

// ── Save company profile fields on settingsPageSave() ──
// ── Save company profile fields (Phase 2, v8.104) ──
// Now async — a targeted UPDATE on the one mt_companies row for the active
// company, not a call into the retired blanket-overwrite _spPersistProfiles().
// Returns { ok, message } rather than a bare boolean, so settingsPageSave()
// can distinguish "validation failed, don't proceed" from "the write itself
// failed" and show the right message for each — including the permission
// case (RLS requires role='admin' on mt_companies; a Regular User's write
// is correctly rejected by the database, not silently accepted).
async function spSaveCompanyProfile(){
  const getVal=(id)=>{const el=document.getElementById(id);return el?el.value.trim():'';};
  const nameVal=getVal('sp-co-name');
  // Only block save if user has started filling company profile but left name empty.
  // If all company fields are blank, skip validation — company profile is optional.
  const anyFilled=getVal('sp-co-url')||getVal('sp-co-strategy')||getVal('sp-co-context')||getVal('sp-co-reflink');
  if(!nameVal&&anyFilled){
    const nameEl=document.getElementById('sp-co-name');
    if(nameEl){nameEl.style.borderColor='#A32D2D';nameEl.focus();}
    return { ok:false, message:'Company name is required.' };
  }

  companyProfile.companyName     = nameVal;
  companyProfile.companyIndustry = getVal('sp-co-industry')||'';
  companyProfile.companyUrl      = getVal('sp-co-url');
  companyProfile.companyStrategy = getVal('sp-co-strategy');
  companyProfile.companyContext  = getVal('sp-co-context');
  companyProfile.companyRefLink  = getVal('sp-co-reflink');

  const companyId = _spGetActiveCompanyId();
  if(!companyId) return { ok:false, message:'No active company. Cannot save.' };

  const client = (typeof authInit === 'function') ? authInit() : null;
  if(!client) return { ok:false, message:'Not connected. Check your network and try again.' };

  try {
    const { error } = await client
      .from('mt_companies')
      .update(_spMapCompanyToDB(companyProfile))
      .eq('id', companyId);
    if(error){
      // RLS silently returns 0 rows affected for an unauthorized write rather
      // than a distinct "permission denied" error in most PostgREST setups —
      // treat any error here as worth surfacing plainly rather than assuming
      // it's always a network issue.
      return { ok:false, message:'Couldn\u2019t save company profile: ' + error.message };
    }
    try { localStorage.setItem(_spCoKey(companyId), JSON.stringify(_spStripCoDocs(companyProfile))); } catch(e) {}
    return { ok:true };
  } catch(e) {
    return { ok:false, message:'Couldn\u2019t save company profile. Check your network and try again.' };
  }
}
