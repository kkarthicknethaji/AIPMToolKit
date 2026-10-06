// ── Shared API key format validator (v9.14: provider-aware) ──
// Single source of truth for "is this a valid-looking key for the active
// provider" — used by checkKey() (live, on every keystroke) and by the
// Settings Save & Exit handler (settings-page.js), so the two can never
// independently drift the way they had before this fix (Save previously had
// NO validation at all, blindly persisting whatever was in the field —
// including browser-autofilled garbage, confirmed via screen recording to
// render into this field immediately on page load, independent of any user
// interaction).
//
// Provider key formats are not a stable contract (OpenAI and Google both
// document evolving key schemes/types) — this is a soft, client-side hint
// only, never the authoritative check; actual key validity is only ever
// confirmed by the provider itself on first real call. A null pattern below
// means "not yet verified against live provider docs" (see the spec's
// Section 7) — any non-empty value is accepted as tentatively valid rather
// than wrongly flagged Invalid until a real pattern lands.
const _PROVIDER_KEY_PATTERNS = {
  anthropic: /^sk-ant|^sk-/,
  openai: null, // [VERIFY_OPENAI_KEY_PREFIX_PATTERN] — unresolved, see spec Section 7
  gemini: null  // [VERIFY_GEMINI_KEY_PREFIX_PATTERN] — unresolved, not covered by this pass's direct-doc-read either
};
function isValidApiKeyFormat(k, provider){
  k=(k||'').trim();
  if(!k) return false;
  provider = provider || (typeof appSettings!=='undefined' && appSettings.provider) || 'anthropic';
  const pattern = _PROVIDER_KEY_PATTERNS.hasOwnProperty(provider) ? _PROVIDER_KEY_PATTERNS[provider] : _PROVIDER_KEY_PATTERNS.anthropic;
  if(pattern === null) return true; // no verified pattern yet — accept, don't false-flag a real key as invalid
  return pattern.test(k);
}
function checkKey(){
  var keyEl=document.getElementById('api-key');if(!keyEl)return;
  var k=keyEl.value.trim();
  var s=document.getElementById('api-status');
  var dot=document.getElementById('api-dot');
  if(isValidApiKeyFormat(k)){
    // Valid BYOK key entered
    s.textContent='Ready';s.className='api-status ok';
    document.getElementById('api-status-hint').textContent='Personal key active — overrides org key';
    document.getElementById('api-key').classList.remove('unset');dot.classList.remove('on');
    sessionStorage.setItem((typeof _byokKey==='function'?_byokKey():'hcl_ak'),k);
    if(document.getElementById('demo-badge')&&typeof clearDemoMode==='function')clearDemoMode();
  } else if(k.length>0){
    // Something entered but not a valid key format
    s.textContent='Invalid key';s.className='api-status unset';
    document.getElementById('api-status-hint').textContent='Key format not recognised';
    document.getElementById('api-key').classList.add('unset');dot.classList.add('on');
    sessionStorage.removeItem(typeof _byokKey==='function'?_byokKey():'hcl_ak');
  } else {
    // Empty — org key may be active on the proxy
    s.textContent='Org key active';s.className='api-status ok';
    document.getElementById('api-status-hint').textContent='Using organisation key — or enter a personal key above';
    document.getElementById('api-key').classList.remove('unset');dot.classList.remove('on');
    sessionStorage.removeItem(typeof _byokKey==='function'?_byokKey():'hcl_ak');
  }
  if(settingsOpen){
    if(typeof spRefreshKeyStatus==='function') spRefreshKeyStatus();
  }
}
function toggleKeyVis(){
  const inp=document.getElementById('api-key'),icon=document.getElementById('eye-icon');
  if(inp.type==='password'){inp.type='text';icon.className='ti ti-eye-off';}
  else{inp.type='password';icon.className='ti ti-eye';}
}
document.addEventListener('DOMContentLoaded',function(){
  var saved=sessionStorage.getItem(typeof _byokKey==='function'?_byokKey():'hcl_ak');
  var dot=document.getElementById('api-dot');
  if(saved){
    var keyEl=document.getElementById('api-key');
    if(keyEl){keyEl.value=saved;checkKey();}
    if(dot)dot.classList.remove('on');
  } else {
    // No saved key — org key may be active; no orange dot
    if(dot)dot.classList.remove('on');
  }
});
