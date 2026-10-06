// HOME TAB (v7.57)
// Tab Zero — session launcher. Reads productProfiles[] and companyProfile from state.
// Writes sessionContext{} and sessionActive on launch.
// All prompt builders will read from sessionContext in Step 7 (prompt injection).

// ── Local state ──
let _homeApproach='outcome-based';
let _homeMode='ai-generated';
let _homePPCollapsed=false;
let _homeManualList=[]; // [{name, description}] — populated by homeHandleFileUpload
let _homeUploadedFileName='';
let _homePanelOpen=true;
let _isDemoSession=false; // true when current session is demo — never saved to store
let _homeSessFilter='all'; // product filter dropdown value
let _homeSessSort='lastSaved'; // 'lastSaved' | 'createdAt' | 'productName' | 'sessionName'
let _homeSessSearch=''; // search query string
let _homeSessionDocs=[]; // [{id,name,docType,wordCount,extractedText,aiSummary,keyDecisions,constraints,openQuestions,summaryStatus,uploadedAt,sessionScoped:true}]
let _homeCtxExpanded=false; // additional context textarea collapsed state

// ── Init ──
function homeInit(){
  _homeApproach='outcome-based';
  _homeMode='ai-generated';
  _homePPCollapsed=false;
  _homeManualList=[];
  _homeUploadedFileName='';
  _homeSessionDocs=[];
  _homeCtxExpanded=false;
  _homeRenderProductSelector();
  homeRenderPreviewCard();
  homeSetApproach('outcome-based');
  _homeUpdateLaunchBtn();
  homeRenderSessionLibrary();
  _homeApplyReadOnlyState();
  if(typeof _lsHomePollStart==='function') _lsHomePollStart();
}

function homeOnTabEnter(){
  _homeRenderProductSelector();
  homeRenderPreviewCard();
  const lock=document.getElementById('home-tab-lock');
  if(lock) lock.style.display=sessionActive?'none':'flex';
  _homeSetError('');
  homeRenderSessionLibrary();
  _homeApplyReadOnlyState();
  // Retry failed doc summaries on tab re-entry
  _homeRetrySdocSummaries();
  homeRenderSdocsSection();
  // Phase 3a (v8.126): idempotent — internally no-ops if already running
  // for the current company (re-entering Home repeatedly shouldn't stack
  // duplicate intervals/channels).
  if(typeof _lsHomePollStart==='function') _lsHomePollStart();
}

// v9.09 — Read Only role state for the Home tab. Left panel: every control
// stays visible and structurally unchanged, but gets `disabled` individually
// (per the project's existing "hidden vs disabled" standing rule — toggles/
// dropdowns/inputs get disabled, not hidden). Right panel: ONLY the top
// launch-specific block (icon/title/desc/steps) swaps for a Read Only
// message — the "or explore first" divider and Demo Data card below it are
// DELIBERATELY left fully untouched and interactive. Demo sessions never
// call sessionStoreCreate() and are blocked from sessionStoreSave() by
// canEditSession() as a second, independent guard — confirmed via code
// reading, not assumed — so a Read Only user gets full sandboxed
// generate/edit/delete capability within a demo session with zero lasting
// effect. This is an intentional, explicitly confirmed exception to the
// launch-block, not an oversight.
function _homeApplyReadOnlyState(){
  const isReadOnly=(typeof currentUserRole!=='undefined')&&currentUserRole==='readonly';

  const note=document.getElementById('home-ph-readonly-note');
  if(note) note.classList.toggle('home-hidden',!isReadOnly);

  const launchTop=document.getElementById('home-empty-top-launch');
  const readonlyTop=document.getElementById('home-empty-top-readonly');
  if(launchTop) launchTop.classList.toggle('home-hidden',isReadOnly);
  if(readonlyTop) readonlyTop.classList.toggle('home-hidden',!isReadOnly);

  // Disable every left-panel setup control individually — Demo Data card
  // controls are NOT in this list, by design (see comment above).
  const _fieldIds=['home-product-sel','home-approach-outcome','home-approach-capability',
    'home-mode-ai','home-mode-manual','home-custom-vc','home-mi-toggle','home-launch-btn'];
  _fieldIds.forEach(function(id){
    const el=document.getElementById(id);
    if(el) el.disabled=isReadOnly;
  });
  // v9.09.01 — the upload trigger is a div+onclick, not a <button>, and
  // #home-sdocs-box is fully rebuilt by homeRenderSdocsSection() at ~7
  // call sites — a one-time querySelector disable here (the v9.09 bug)
  // gets silently wiped the next time that function runs. Fixed at the
  // actual source: homeRenderSdocsSection() itself now checks role when
  // building the upload row's onclick, and both upload handlers
  // (homeHandleFileUpload, homeHandleSdocsUpload) have their own
  // independent guard as defense-in-depth. Re-render now so the box
  // reflects the current role immediately, not just on its next natural
  // re-render.
  if(typeof homeRenderSdocsSection==='function') homeRenderSdocsSection();

  // Message/button-disable state itself is owned by _homeUpdateLaunchBtn()
  // (called separately, at ~15 existing call sites) — it checks readonly
  // FIRST and wins regardless of call order, so no duplicate logic needed
  // here. This function only handles the parts _homeUpdateLaunchBtn()
  // doesn't: the header note, the right-panel top swap, and per-field
  // disabled state on controls _homeUpdateLaunchBtn() doesn't touch.
  _homeUpdateLaunchBtn();
}

function homeTogglePanel(){
  _homePanelOpen=!_homePanelOpen;
  const panel=document.querySelector('#home-tab .home-left');
  const expIcon=document.getElementById('icon-home-exp');
  const colIcon=document.getElementById('icon-home-col');
  if(panel) panel.classList.toggle('home-collapsed',!_homePanelOpen);
  if(expIcon) expIcon.style.display=_homePanelOpen?'block':'none';
  if(colIcon) colIcon.style.display=_homePanelOpen?'none':'block';
}

// ── Product selector ──
function _homeRenderProductSelector(){
  // v8.113: zero-company (membership count 0) is distinct from zero-products
  // (a real company with no product profiles set up yet) — the empty
  // dropdown option alone doesn't tell these apart, and only one of them
  // has an actionable fix from this screen (create a company; a missing
  // product profile is fixed in Settings, a section that itself won't even
  // be reachable for a zero-company user per this same build).
  var zeroCompanyEl=document.getElementById('home-zero-company-state');
  var formFieldsEl=document.getElementById('home-form-fields');
  var isZeroCompany=(typeof _pgtMembershipCount!=='undefined' && _pgtMembershipCount===0);
  if(zeroCompanyEl) zeroCompanyEl.classList.toggle('home-hidden', !isZeroCompany);
  if(formFieldsEl) formFieldsEl.classList.toggle('home-hidden', isZeroCompany);
  _homeUpdateLaunchBtn();
  if(isZeroCompany){
    activeProfileId=null;
    return;
  }

  const sel=document.getElementById('home-product-sel');
  if(!sel) return;
  const prev=sel.value;
  sel.innerHTML='';
  if(!productProfiles||!productProfiles.length){
    sel.innerHTML='<option value="">No products set up yet</option>';
    activeProfileId=null;
    return;
  }
  const placeholder=document.createElement('option');
  placeholder.value='';
  placeholder.textContent='Select a product...';
  placeholder.disabled=true;
  sel.appendChild(placeholder);
  // Sort alphabetically by product name before rendering
  const sortedProfiles=productProfiles.slice().sort(function(a,b){
    return (a.productName||'').localeCompare(b.productName||'');
  });
  sortedProfiles.forEach(function(p){
    const opt=document.createElement('option');
    opt.value=p.id;
    opt.textContent=p.productName;
    sel.appendChild(opt);
  });
  // Restore previous selection or use activeProfileId
  const target=prev||activeProfileId||'';
  if(target&&productProfiles.find(function(p){return p.id===target;})){
    sel.value=target;
    activeProfileId=target;
  } else if(productProfiles.length===1){
    sel.value=productProfiles[0].id;
    activeProfileId=productProfiles[0].id;
  } else {
    sel.value='';
    activeProfileId=null;
  }
  _homeUpdateLaunchBtn();
}

function homeOnProductChange(){
  const sel=document.getElementById('home-product-sel');
  if(!sel) return;
  const nextProfileId=sel.value||null;
  if(sessionActive){
    homeClearSession();
    if(typeof _homeResetSetupForm==='function') _homeResetSetupForm();
  }
  activeProfileId=nextProfileId;
  homeRenderPreviewCard();
  homeRenderSdocsSection();
  _homeUpdateLaunchBtn();
}

// Enable/disable launch button
// Blocks if no product selected OR if any session doc is still processing
function _homeUpdateLaunchBtn(){
  const btn=document.getElementById('home-launch-btn');
  const errEl=document.getElementById('home-launch-error');
  if(!btn)return;
  // v9.09 — Read Only hard-blocks launch regardless of product/doc state.
  // Checked FIRST so no other branch below can override this message —
  // _homeUpdateLaunchBtn() has ~15 call sites throughout this file, and this
  // guard needs to win at all of them, not just the ones this build touched.
  const isReadOnly=(typeof currentUserRole!=='undefined')&&currentUserRole==='readonly';
  if(isReadOnly){
    btn.disabled=true;
    if(errEl){
      errEl.style.display='flex';
      errEl.innerHTML='<i class="ti ti-alert-triangle" style="font-size:11px;color:#BA7517;" aria-hidden="true"></i> <span style="color:#BA7517;font-weight:400;">Setup is disabled for view only access</span>';
    }
    return;
  }
  const hasProduct=!!(activeProfileId&&productProfiles&&productProfiles.find(function(p){return p.id===activeProfileId;}));
  const pendingDocs=_homeSessionDocs.filter(function(d){return d.summaryStatus==='pending';});
  const isCapManual=(_homeApproach==='capability-based'&&_homeMode==='manual');
  const missingCapList=isCapManual&&_homeManualList.length===0;
  const isBlocked=!hasProduct||pendingDocs.length>0||missingCapList;
  btn.disabled=isBlocked;
  if(errEl){
    if(pendingDocs.length>0){
      errEl.style.display='flex';
      errEl.innerHTML='<span class="cc-spin-sm"></span> <span>Analysing '+pendingDocs.length+' document'+(pendingDocs.length!==1?'s':'')+'. Please wait...</span>';
    } else if(!hasProduct){
      // Pending message has cleared — now surface the real blocker
      errEl.style.display='flex';
      errEl.innerHTML='Select a product to continue.';
    } else if(missingCapList){
      errEl.style.display='flex';
      errEl.innerHTML='Upload your capability list to continue.';
    } else {
      // Clear any processing or cap list note
      if(errEl.style.display!=='none'){errEl.style.display='none';errEl.innerHTML='';}
    }
  }
}

// ── Product preview card ──
function homeRenderPreviewCard(){
  const wrap=document.getElementById('home-pp-wrap');
  if(!wrap) return;

  if(!productProfiles||!productProfiles.length){
    wrap.innerHTML=_homeNudgeCard();
    return;
  }
  const profile=activeProfileId?productProfiles.find(function(p){return p.id===activeProfileId;}):null;
  if(!profile){
    wrap.innerHTML='';
    return;
  }

  // Determine sparse vs rich
  const missing=[];
  if(!profile.productDesc) missing.push('Description');
  if(!profile.productType) missing.push('Product type');
  if(!profile.industry&&!(companyProfile&&companyProfile.companyIndustry)) missing.push('Industry');
  const isSparse=missing.length>0;

  const industry=profile.industry||(companyProfile&&companyProfile.companyIndustry?companyProfile.companyIndustry:null);
  const docCount=profile.docs&&profile.docs.length?profile.docs.length:0;
  const noCompany=!companyProfile||!companyProfile.companyName;

  let html='<div class="home-pp-card">';
  html+='<div class="home-pp-hdr">';
  html+='<span class="home-pp-eyebrow">Product Profile</span>';
  html+='<div class="home-pp-actions">';
  html+='<button class="home-pp-icon-btn" onclick="openSettingsToSection(2);" title="'+((typeof _spIsAdmin==='function'&&_spIsAdmin())?'Edit profile':'View profile')+'"><i class="ti '+((typeof _spIsAdmin==='function'&&_spIsAdmin())?'ti-pencil':'ti-eye')+'" style="font-size:9px;" aria-hidden="true"></i></button>';
  html+='<button class="home-pp-icon-btn" onclick="homePPCardToggle()" title="Toggle details" id="home-pp-chevron"><i class="ti ti-chevron-'+ (_homePPCollapsed?'down':'up') +'" style="font-size:9px;" aria-hidden="true"></i></button>';
  html+='</div>';
  html+='</div>';

  if(isSparse){
    html+='<div class="home-pp-amber"><i class="ti ti-alert-triangle" style="font-size:9px;" aria-hidden="true"></i> Some profile fields are missing - AI will work with what is set</div>';
  }
  if(noCompany){
    html+='<div class="home-pp-amber home-pp-amber-blue"><i class="ti ti-info-circle" style="font-size:9px;" aria-hidden="true"></i> Company profile not set - AI will use product context only</div>';
  }

  html+='<div class="home-pp-body" id="home-pp-body" style="display:'+(_homePPCollapsed?'none':'block')+'">';
  html+='<div class="home-pp-row"><span class="home-pp-key">Type</span>';
  if(profile.productType) html+='<span class="home-pp-badge">'+e(profile.productType)+'</span>';
  else html+='<span class="home-pp-muted">Not set</span>';
  html+='</div>';

  html+='<div class="home-pp-row"><span class="home-pp-key">Industry</span>';
  if(industry) html+='<span class="home-pp-val">'+e(industry)+'</span>';
  else html+='<span class="home-pp-muted">Not set</span>';
  html+='</div>';

  if(profile.icp){
    html+='<div class="home-pp-row"><span class="home-pp-key">ICP</span><span class="home-pp-val">'+e(profile.icp)+'</span></div>';
  }

  if(docCount>0){
    html+='<div class="home-pp-row"><span class="home-pp-key">Context</span><span class="home-pp-badge home-pp-badge-blue">'+docCount+' doc'+(docCount>1?'s':'')+' loaded</span></div>';
  }

  if(profile.productDesc){
    html+='<div class="home-pp-desc">'+e(profile.productDesc)+'</div>';
  }

  html+='</div>'; // home-pp-body
  html+='</div>'; // home-pp-card
  wrap.innerHTML=html;
}

function _homeNudgeCard(){
  const isAdmin = (typeof _spIsAdmin==='function') && _spIsAdmin();
  return '<div class="home-nudge-card">'
    +'<div class="home-nudge-icon"><i class="ti ti-box-multiple" style="font-size:16px;color:var(--purple);" aria-hidden="true"></i></div>'
    +'<div class="home-nudge-title">No products set up yet</div>'
    +'<div class="home-nudge-desc">'+(isAdmin?'Create a product profile to get started. Your profile feeds AI context for every generation.':'Ask an admin to add a product profile to get started.')+'</div>'
    +(isAdmin
      ? '<button class="home-nudge-cta" onclick="openSettingsToSection(2);">'
        +'<i class="ti ti-plus" style="font-size:10px;" aria-hidden="true"></i> Add Product Profile'
        +'</button>'
      : '')
    +'</div>';
}

function homePPCardToggle(){
  _homePPCollapsed=!_homePPCollapsed;
  const body=document.getElementById('home-pp-body');
  const chevron=document.getElementById('home-pp-chevron');
  if(body) body.style.display=_homePPCollapsed?'none':'block';
  if(chevron){
    const icon=chevron.querySelector('i');
    if(icon) icon.className='ti ti-chevron-'+(_homePPCollapsed?'down':'up');
  }
}

// ── Approach + Mode selectors ──
function homeSetApproach(val){
  _homeApproach=val;
  _homeSetApproachPills(val);
  if(val==='outcome-based'){
    // Disable manual mode - not available for outcome-based
    _homeMode='ai-generated';
    _homeSetModePills('ai-generated');
    const manualBtn=document.getElementById('home-mode-manual');
    if(manualBtn){
      manualBtn.disabled=true;
      manualBtn.title='Available for Process Area only';
    }
  } else {
    const manualBtn=document.getElementById('home-mode-manual');
    if(manualBtn){
      manualBtn.disabled=false;
      manualBtn.title='';
    }
  }
  homeRenderSdocsSection();
}

function homeSetMode(val){
  if(_homeApproach==='outcome-based'&&val==='manual') return; // guard
  _homeMode=val;
  _homeSetModePills(val);
  homeRenderSdocsSection();
}

function _homeSetApproachPills(val){
  const outBtn=document.getElementById('home-approach-outcome');
  const capBtn=document.getElementById('home-approach-capability');
  if(outBtn) outBtn.classList.toggle('home-seg-btn-active', val==='outcome-based');
  if(capBtn) capBtn.classList.toggle('home-seg-btn-active', val==='capability-based');
}

function _homeSetModePills(val){
  const aiBtn=document.getElementById('home-mode-ai');
  const manBtn=document.getElementById('home-mode-manual');
  if(aiBtn) aiBtn.classList.toggle('home-seg-btn-active', val==='ai-generated');
  if(manBtn) manBtn.classList.toggle('home-seg-btn-active', val==='manual');
}

// _homeUpdateCondBox retired v8.58 — replaced by homeRenderSdocsSection()

// ── Manual input (cond-box) — file upload only ──
function homeHandleFileUpload(input){
  // v9.09.01 — defense-in-depth guard, independent of the trigger div being
  // visually disabled. Read Only must not process an upload even if the
  // hidden file input is reached some other way (e.g. drag-and-drop).
  if(typeof currentUserRole!=='undefined'&&currentUserRole==='readonly')return;
  const file=input.files&&input.files[0];
  if(!file) return;
  const ext=file.name.split('.').pop().toLowerCase();
  const resultEl=document.getElementById('home-cap-parse-result');
  if(resultEl)resultEl.innerHTML='<div class="cc-parse-loading"><div class="cc-spin-sm"></div> Reading file…</div>';
  if(ext==='csv'){
    const reader=new FileReader();
    reader.onload=ev=>_homeParseCSV(ev.target.result, file.name);
    reader.readAsText(file);
  } else if(ext==='xlsx'){
    const reader=new FileReader();
    reader.onload=ev=>{
      if(typeof XLSX==='undefined'){
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
        s.onload=()=>_homeParseXLSX(ev.target.result, file.name);
        s.onerror=()=>_homeShowParseError('Could not load XLSX library. Check internet connection.');
        document.head.appendChild(s);
      } else {
        _homeParseXLSX(ev.target.result, file.name);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    _homeShowParseError('Unsupported file type. Use .xlsx or .csv.');
  }
  input.value='';
}

function _homeParseXLSX(arrayBuffer, fileName){
  try{
    const wb=XLSX.read(arrayBuffer,{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const data=XLSX.utils.sheet_to_json(ws,{defval:''});
    if(!data||data.length===0){_homeShowParseError('File appears empty.');return;}
    const firstRow=data[0];
    const keys=Object.keys(firstRow).map(k=>k.toLowerCase().trim());
    const capKey=Object.keys(firstRow)[keys.indexOf('capability')]||Object.keys(firstRow)[keys.indexOf('capabilities')];
    const descKey=Object.keys(firstRow)[keys.indexOf('description')];
    if(!capKey){_homeShowParseError('Could not find a "Capability" column.');return;}
    const caps=[];
    const seen=new Set();
    data.forEach(row=>{
      const name=String(row[capKey]||'').trim();
      if(!name)return;
      const lower=name.toLowerCase();
      if(seen.has(lower))return;
      seen.add(lower);
      caps.push({name, description: descKey?String(row[descKey]||'').trim():''});
    });
    _homeFinalizeCapList(caps, fileName);
  }catch(err){
    _homeShowParseError('Could not read file: '+err.message);
  }
}

function _homeParseCSV(text, fileName){
  try{
    const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
    if(lines.length===0){_homeShowParseError('File appears empty.');return;}
    const header=lines[0].split(',').map(h=>h.trim().toLowerCase());
    const capIdx=header.indexOf('capability')>=0?header.indexOf('capability'):header.indexOf('capabilities');
    const descIdx=header.indexOf('description');
    if(capIdx<0){_homeShowParseError('Could not find a "Capability" column.');return;}
    const caps=[];
    const seen=new Set();
    for(let i=1;i<lines.length;i++){
      const cols=lines[i].split(',').map(c=>c.trim());
      const name=cols[capIdx]||'';
      if(!name)continue;
      const lower=name.toLowerCase();
      if(seen.has(lower))continue;
      seen.add(lower);
      caps.push({name, description: descIdx>=0?(cols[descIdx]||''):''});
    }
    _homeFinalizeCapList(caps, fileName);
  }catch(err){
    _homeShowParseError('Could not read file: '+err.message);
  }
}

const HOME_MAX_CAPS=1000;
const HOME_SESSION_DOCS_MAX=5;

function _homeFinalizeCapList(caps, fileName){
  if(!caps||caps.length===0){_homeShowParseError('No capabilities found. Check the format.');return;}
  if(caps.length>HOME_MAX_CAPS){caps=caps.slice(0,HOME_MAX_CAPS);}
  _homeManualList=caps;
  _homeUploadedFileName=fileName||'';
  _homeRenderParseResult();
  _homeSetCondError(''); // v7.80: clear any prior "upload required" error on successful parse
  _homeUpdateLaunchBtn();
}

function _homeRenderParseResult(){
  const resultEl=document.getElementById('home-cap-parse-result');
  const uploadRow=document.getElementById('home-upload-row');
  if(!resultEl)return;
  const total=_homeManualList.length;
  const withDesc=_homeManualList.filter(c=>c.description).length;
  let html=`<div class="cc-parse-ok"><i class="ti ti-check" style="font-size:12px;" aria-hidden="true"></i> <span>${total} capabilit${total===1?'y':'ies'} loaded`;
  if(withDesc>0) html+=` (${withDesc} with description${withDesc===1?'':'s'})`;
  html+=`</span></div>`;
  html+=`<div class="home-cap-file-row"><span class="home-cap-file-name"><i class="ti ti-file" style="font-size:10px;" aria-hidden="true"></i> ${e(_homeUploadedFileName)}</span>`;
  html+=`<a onclick="document.getElementById('home-file-input').click()">Replace</a>`;
  html+=`<a onclick="_homeRemoveCapList()" class="home-cap-file-remove">Remove</a></div>`;
  resultEl.innerHTML=html;
  if(uploadRow) uploadRow.style.display='none';
}

function _homeRemoveCapList(){
  _homeManualList=[];
  _homeUploadedFileName='';
  const resultEl=document.getElementById('home-cap-parse-result');
  const uploadRow=document.getElementById('home-upload-row');
  if(resultEl) resultEl.innerHTML='';
  if(uploadRow) uploadRow.style.display='flex';
  _homeUpdateLaunchBtn();
}

function _homeShowParseError(msg){
  const resultEl=document.getElementById('home-cap-parse-result');
  if(resultEl)resultEl.innerHTML=`<div class="cc-parse-error"><i class="ti ti-alert-circle" style="font-size:11px;" aria-hidden="true"></i> ${e(msg)}</div>`;
}

// ── Character counter wiring ──
function _homeWireCounters(){
  const ctx=document.getElementById('home-additional-context');
  const ctxCount=document.getElementById('home-ctx-counter');
  if(ctx&&ctxCount){
    ctx.addEventListener('input',function(){
      const len=this.value.length;
      const MAX=2000;
      ctxCount.textContent=len+'/'+MAX;
      ctxCount.className='home-ctx-counter'+(len>=MAX?' home-ctx-red':len>=(MAX*0.8)?' home-ctx-amber':'');
    });
  }
}

// v9.17.01 — single CTA, replaces the old Quick Launch / Guided Launch
// button pair. The v9.16 Guided Launch toggle that used to route this to
// homeGuidedLaunch() has been removed per product decision (Guided Launch
// is no longer a Home entry point — it collided naming-wise with the real,
// global Requirement Agent tab and is being retired as a Home CTA). This
// always calls homeLaunch(); homeGuidedLaunch() itself is left intact in
// case Guided Launch needs a future entry point, but nothing on Home calls
// it anymore.
function homeLaunchUnified(){
  homeLaunch();
}

// ── Launch Session ──
function homeLaunch(){
  // v9.09 — Read Only hard block, independent of the button's disabled
  // state (defense-in-depth against direct console/script invocation).
  // The real security boundary is the RLS policy on mt_sessions' INSERT —
  // this is a UX-layer guard on top of that, not a substitute for it.
  if(typeof currentUserRole!=='undefined'&&currentUserRole==='readonly'){
    _homeSetError('<i class="ti ti-alert-triangle" style="font-size:11px;color:#BA7517;" aria-hidden="true"></i> <span style="color:#BA7517;font-weight:400;">Setup is disabled for view only access</span>');
    return;
  }
  // Clear any previous inline errors
  _homeSetError('');
  _homeSetCondError('');

  // 1. Capability-Based + Manual: capability list required
  if(_homeApproach==='capability-based'&&_homeMode==='manual'&&_homeManualList.length===0){
    _homeSetCondError('Upload your capability list to continue.');
    const box=document.getElementById('home-sdocs-box');
    if(box) box.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  // If a session is active, save it before launching new one
  if(sessionActive){
    homeClearSession();
  }

  _homeDoLaunch();
}

// v9.15 — extracted from _homeDoLaunch() so homeGuidedLaunch() can build the
// exact same sessionContext shape without a second hand-maintained copy (a
// hard requirement per the Guided Launch spec: both entry paths must read
// from an identical context set). Pure snapshot — does not touch
// sessionActive/sessionContext globals or launch anything; callers do that.
function _homeBuildSessionContext(){
  const profile=productProfiles.find(function(p){return p.id===activeProfileId;});
  const ctxEl=document.getElementById('home-additional-context');
  const vcEl=document.getElementById('home-custom-vc');
  const miEl=document.getElementById('home-mi-toggle');
  const aiSuggestEl=document.getElementById('home-ai-suggest-toggle');

  return {
    companyProfile: companyProfile ? JSON.parse(JSON.stringify(companyProfile)) : {},
    productProfile: profile ? JSON.parse(JSON.stringify(profile)) : {},
    approach: _homeApproach,
    generationMode: _homeMode,
    manualList: _homeManualList.map(c=>({name:c.name,description:c.description||''})),
    allowAISuggestions: !!(aiSuggestEl&&aiSuggestEl.checked),
    customValueChain: vcEl ? vcEl.value.trim() : '',
    additionalContext: ctxEl ? ctxEl.value.trim() : '',
    marketIntelligence: !!(miEl&&miEl.checked&&appSettings.featMI),
    // Session docs — strip extractedText (too large for localStorage); summaries preserved
    sessionDocs: _homeSessionDocs.map(function(d){
      var d2=Object.assign({},d);
      delete d2.extractedText;
      return d2;
    }),
    launchedAt: Date.now()
  };
}

// ── Guided Launch (v9.15) — second entry path from the same Home setup ──
// Reuses homeLaunch()'s exact preconditions (button is disabled by
// _homeUpdateLaunchBtn() otherwise, but this guard covers direct invocation)
// and the same sessionContext snapshot _homeDoLaunch() builds — hands off to
// guided-launch.js rather than switching to the Discovery Map tab/generate().
function homeGuidedLaunch(){
  if(typeof currentUserRole!=='undefined'&&currentUserRole==='readonly'){
    _homeSetError('<i class="ti ti-alert-triangle" style="font-size:11px;color:#BA7517;" aria-hidden="true"></i> <span style="color:#BA7517;font-weight:400;">Setup is disabled for view only access</span>');
    return;
  }
  _homeSetError('');
  _homeSetCondError('');

  if(_homeApproach==='capability-based'&&_homeMode==='manual'&&_homeManualList.length===0){
    _homeSetCondError('Upload your capability list to continue.');
    const box=document.getElementById('home-sdocs-box');
    if(box) box.scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }

  if(sessionActive){
    homeClearSession();
  }

  if(document.getElementById('demo-badge')){
    if(typeof clearDemoMode==='function') clearDemoMode();
  }
  _isDemoSession=false;

  const glCtx=_homeBuildSessionContext();
  if(typeof glCreateAndOpen==='function'){
    glCreateAndOpen(glCtx);
  }
}

function _homeDoLaunch(){
  // Clear demo if active
  if(document.getElementById('demo-badge')){
    if(typeof clearDemoMode==='function') clearDemoMode();
  }

  _isDemoSession=false;

  sessionContext=_homeBuildSessionContext();

  sessionActive=true;
  _activeSessionOwnerId=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:null;
  homeRenderSdocsSection(); // immediately clear stale chips from DOM

  // Create session in store immediately on launch
  if(typeof sessionStoreCreate==='function'){
    var _lsNewSessId=sessionStoreCreate(sessionContext);
    // Phase 3c (v8.126): started here, after the row actually exists — not
    // at the sessionActive=true line above. Effectively a no-op today (a
    // brand-new session is never shared at creation, so _lsSessionWatchStart
    // itself will just decline to do anything), but the ordering is correct
    // regardless of that guard, not dependent solely on it.
    if(_lsNewSessId && typeof _lsSessionWatchStart==='function' && typeof _activeSessionIsShared!=='undefined' && _activeSessionIsShared){
      _lsSessionWatchStart(_lsNewSessId, null);
    }
  }
  // Silent retry: attempt summarisation for any failed session docs after 2s
  setTimeout(function(){_homeRetrySdocSummaries();},2000);

  // Hide lock message
  const lock=document.getElementById('home-tab-lock');
  if(lock) lock.style.display='none';

  // Reveal Discovery Map tab
  const tabMm=document.getElementById('tab-mm');
  if(tabMm) tabMm.style.display='';

  // Navigate to Discovery Map
  switchTab('mm');
  // Trigger generation
  if(typeof generate==='function') generate();
}

// ── Clear session ──
// p_releaseSessionId (optional, v14 code-review fix) — the session id to
// release occupancy for, passed explicitly by a caller that nulls
// _activeSessionId BEFORE calling this function (e.g. homeSessionDeleteConfirm(),
// which does so deliberately so the exit-save below is correctly skipped for
// an already-deleted session) — without it, this function's own capture a
// few lines down would read a global the caller already cleared. Every
// other caller, which never nulls the global first, is unaffected — the
// fallback below still reads it live exactly as before.
function homeClearSession(p_releaseSessionId){
  // Save current session before wiping — must happen before any state is cleared.
  // v8.150 fix (Issue 2, corrected — explicit sign-off obtained for this
  // edit per this function's own standing rule): the v8.149 attempt at
  // this fix used an explicit skipSave parameter, computed and passed by
  // exactly one caller (sessionStoreRestore, only for "re-resuming the
  // same already-active session"). Confirmed via live testing that this
  // missed the actual failure mode entirely — in the real user journey,
  // navigating away to Home (a DIFFERENT call site, in api.js) already
  // triggers this same save, and already clears the active-session
  // pointer, before the user ever gets to explicitly re-resuming
  // anything. The v8.149 check was already false by the time it mattered.
  // Corrected: the detection is now automatic and internal, protecting
  // EVERY caller of this function uniformly, not just one that
  // remembers to opt in — closing the exact class of gap that caused
  // the first attempt to fail. Skips only this one save line; every
  // other cleanup step below (stopping the watch, clearing pointers,
  // etc.) runs exactly as before, unconditionally.
  var _unsafeToOverwrite = (typeof _activeSessionIsShared !== 'undefined' && _activeSessionIsShared
    && typeof _activeSessionId !== 'undefined' && _activeSessionId
    && typeof _lsSessionMightBeUnsafeToOverwrite === 'function'
    && _lsSessionMightBeUnsafeToOverwrite(_activeSessionId));
  if(!_unsafeToOverwrite && !_isDemoSession && typeof sessionStoreSave==='function' && typeof _activeSessionId!=='undefined' && _activeSessionId){
    // v9.12.05: expectedBlock=true — this save is EXPECTED to be blocked
    // when the exiting session was view-only (including one demoted by the
    // Session Occupancy Lock); a quieter console.log is correct here, not
    // console.error's default alarm. See sessionStoreSave()'s own comment
    // for why this isn't a blanket change affecting other callers.
    sessionStoreSave(_activeSessionId, true);
  }
  // Phase 3c (v8.126) — explicit sign-off obtained separately before this
  // edit, per this project's own rule that this function requires that.
  // Stops the in-session watch for whichever session was active. Safe to
  // call even if no watch is running (no-op), and safe to call twice in a
  // row (e.g. kickout already stopped it before calling this) — idempotent.
  if(typeof _lsSessionWatchStop==='function') _lsSessionWatchStop();
  // v9.12 — explicit sign-off obtained separately before this edit, per
  // this function's own standing rule. Session id captured into a local
  // BEFORE _activeSessionId is nulled below — releasing after the null
  // would release nothing. Heartbeat stopped FIRST, release called SECOND
  // (matches the adversarial-review-confirmed ordering: a late-arriving
  // heartbeat tick landing after release has already run must not be able
  // to silently re-write occupant_at for a session this tab just left —
  // stopAndWait() inside _lsOccupancyHeartbeatStop() guarantees any
  // in-flight tick has fully settled before this function proceeds to
  // release). Fire-and-forget on the release call itself — this function
  // doesn't await network calls elsewhere either, and a failed release
  // still self-heals via the 60-second staleness window in
  // claim_session_occupancy.
  var _occSessionIdToRelease = p_releaseSessionId || ((typeof _activeSessionId!=='undefined') ? _activeSessionId : null);
  if(typeof _lsOccupancyHeartbeatStop==='function'){
    var _occStopPromise = _lsOccupancyHeartbeatStop();
    if(_occStopPromise && typeof _occStopPromise.then==='function'){
      _occStopPromise.then(function(){
        if(_occSessionIdToRelease && typeof _lsReleaseSessionOccupancy==='function') _lsReleaseSessionOccupancy(_occSessionIdToRelease);
      });
    } else if(_occSessionIdToRelease && typeof _lsReleaseSessionOccupancy==='function') {
      _lsReleaseSessionOccupancy(_occSessionIdToRelease);
    }
  }
  _activeSessionId=null;
  // Phase 5: clear alongside _activeSessionId — no session active means
  // nothing is "shared" either. Prevents a stale true carrying over into
  // whatever gets loaded/created next, ahead of that load explicitly
  // setting its own value.
  _activeSessionIsShared=false;
  _activeSessionOwnerId=null;
  // v9.08: reset alongside its siblings — no active session means share
  // mode is irrelevant until the next load/create explicitly sets it.
  if(typeof _activeSessionShareMode!=='undefined') _activeSessionShareMode='view';
  _homeSessionDocs=[];
  _homeCtxExpanded=false;

  // State resets
  gData=null;
  productContext=null;
  sessionContext=null;
  sessionActive=false;
  capStore={};
  capStoreInvalidated=false;
  capActiveMetricKey=null;
  capActiveCapIdx=null;
  capActiveSubCapIdx=null;
  ccSelectedCapIds=new Set();
  ccPanelCapKey=null;
  diagnosticSessions=[];
  activeDiagnosticId=null;
  productLeakAnalysis=null;
  diagEvidenceDrawerMetricId=null;
  leakDetailExperimentIdx=null;
  leakSelectedIds=new Set();
  leakFilters={priority:'',linkedMetric:'',experimentType:'',selectedOnly:false};
  miData=null;
  miGenerated=false;
  miProductMode='market';
  miCapabilities=[];
  miSelectedCapNames=new Set();
  if(typeof miLeftCollapsed!=='undefined') miLeftCollapsed=false;
  piMode=false;
  piFirstBuilt=false;
  piPlan=null;
  // piPlans/piBacklogStoryIds/_piActivePlanId (Release Canvas) and
  // piReadinessPlans (Adoption Readiness) were missing from this reset —
  // _sessionStoreBuildSnapshot() reads these live globals unconditionally
  // when a new session is created, so a previous session's release/readiness
  // data got baked into the brand-new session's own snapshot before the user
  // had ever touched those tabs.
  piPlans=[];
  piBacklogStoryIds=[];
  _piActivePlanId=null;
  piReadinessPlans=[];
  piSquads=[{name:(appSettings.defaultSquadName||'Squad')+' 1',capacity:appSettings.defaultSquadCapacity||80}];
  piScVersion=null;
  piInputs={type:'caps-only',piGoal:'',constraints:'',parsedCaps:[],parsedFeatures:[],carryForwardItems:[],overlapResolutions:{}};
  mmBannerCollapsed=false;
  ddGenerated=false;
  if(typeof window!=='undefined') window._ddRows=[];
  // feature-canvas.js globals
  scCanvas=[];
  if(typeof protoStore!=='undefined') protoStore={};
  if(typeof newScProtoView!=='undefined') newScProtoView=false;
  if(typeof newScNavCollapsed!=='undefined') newScNavCollapsed=false;
  if(typeof scSelectedIds!=='undefined') scSelectedIds=new Set();
  if(typeof scPanelFeatureId!=='undefined') scPanelFeatureId=null;
  if(typeof scCapNavFilter!=='undefined') scCapNavFilter=null;
  if(typeof scPiSelectedIds!=='undefined') scPiSelectedIds=new Set();
  if(typeof scStoryIdCounter!=='undefined') scStoryIdCounter=0;

  // Close SC right panel DOM explicitly — scPanelFeatureId=null clears state but
  // panel-open/open classes remain on #sc-main/#sc-panel, leaving session 1 story
  // content visible when session 2 opens Feature Canvas
  if(typeof scClosePanel==='function') scClosePanel();

  // Update FC tab badge — sees scCanvas=[] and hides tab-fc; prevents session 1
  // FC tab from persisting visible into session 2 which has no features yet
  if(typeof fcUpdateTabBadge==='function') fcUpdateTabBadge();

  // DOM resets
  const mmOut=document.getElementById('mm-out');
  if(mmOut){mmOut.innerHTML='';mmOut.classList.remove('on');}
  const ddOut=document.getElementById('dd-out');
  if(ddOut){ddOut.innerHTML='';ddOut.classList.remove('on');}
  const esEl=document.getElementById('es');
  if(esEl) esEl.style.display='';
  const erEl=document.getElementById('er');
  if(erEl) erEl.classList.remove('on');

  // Hide all non-home tabs and clear any data-home-hidden flags
  // data-home-hidden is set by switchTab('home') to track which tabs were visible.
  // If not cleared here, switchTab('mm') on the new session will re-show session 1's tabs.
  ['tab-mm','tab-cc','tab-mi','tab-la','tab-fc','tab-gl'].forEach(function(id){
    const el=document.getElementById(id);
    if(el){ el.style.display='none'; el.removeAttribute('data-home-hidden'); }
  });
  ['tab-sc','tab-pi','tab-arp'].forEach(function(id){
    const el=document.getElementById(id);
    if(el){ el.classList.remove('revealed'); el.removeAttribute('data-home-hidden'); }
  });
  if(typeof opUnlocked!=='undefined')opUnlocked=false;
  const tabOpResetEl=document.getElementById('tab-op');
  if(tabOpResetEl)tabOpResetEl.style.display='none';
  const tabRaResetEl=document.getElementById('tab-ra');
  if(tabRaResetEl)tabRaResetEl.classList.remove('revealed');

  // Reset tab badges
  if(typeof fcUpdateTabBadge==='function') fcUpdateTabBadge();
  if(typeof newScUpdateTabBadge==='function') newScUpdateTabBadge();

  // Clear diag bar
  const diagBar=document.getElementById('diag-action-bar');
  if(diagBar) diagBar.remove();

  // Clear LA tab content
  const laTab=document.getElementById('la-tab');
  if(laTab) laTab.innerHTML='';

  // Clear MI tab content
  const miTabContent=document.getElementById('mi-tab');
  if(miTabContent){miTabContent.innerHTML='';miTabContent.classList.remove('on');}

  // Clear Guided Launch tab content + its module state (v9.15.01, Item 20).
  // homeClearSession() is the one shared cleanup every session-transition
  // path already funnels through (Home nav, resume, new launch) — but it
  // predates guided-launch.js and had no gl*-awareness at all. Without this,
  // an abandoned (never-finalized) Guided Launch session's in-memory state
  // and rendered DOM survive indefinitely, since an unfinalized session
  // never sets sessionActive=true and so never triggers this function via
  // switchTab('home')'s own guard — confirmed via live repro, not just code
  // reading (see item20-repro-results.md).
  const glTabContent=document.getElementById('gl-tab');
  if(glTabContent){glTabContent.innerHTML='';glTabContent.classList.remove('on');}
  if(typeof glResetState==='function') glResetState();

  // v9.16 — Requirement Agent, same reasoning as glResetState() above:
  // per-session in-memory state (raConversations, active/open conversation
  // pointers) must not survive into whichever session is opened next.
  const raTabContent=document.getElementById('ra-tab');
  if(raTabContent){raTabContent.innerHTML='';raTabContent.classList.remove('on');}

  // v14 product decision (post-v9.27 review) — this function is an ordinary
  // session PAUSE/switch, never a permanent delete: the outgoing session's
  // raConversations and their documents must survive untouched in the
  // database for later resume. Calls the NON-destructive
  // raClearInMemoryState() (view-only reset, no RPCs, no database writes) —
  // NOT raResetState(), which now does destructive document cleanup and is
  // reachable only from kpi-tree.js's generateConfirmed() (Regenerate
  // Discovery Map), the one flow where every one of this session's RA
  // conversations is genuinely, permanently gone. An earlier build of this
  // feature called raResetState() here too, on the mistaken premise that
  // every raConversations wipe is equally permanent — it isn't: this
  // function's own sessionStoreSave() call, above, already persisted the
  // outgoing session's real conversations+documents before this point, so
  // calling the destructive path here would tombstone documents that are
  // still fully reachable the next time this same session is resumed.
  //
  // Round-2 code-review fix: MUST run BEFORE the leak-detection guard a few
  // lines down, not after — an earlier version of this fix placed it last
  // in the function (a leftover from when this call site was still the
  // async, network-calling raResetState(), where trailing placement
  // actually mattered). raClearInMemoryState() is synchronous and clears
  // raConversations directly; _ssAssertCleanSlate() reads that same global
  // via _sessionStoreBuildSnapshot(). Placed after it, the guard always
  // found raConversations non-empty for any session that had used
  // Requirement Agent — a permanent false positive on every single New
  // Session/product-change/resume transition, not the rare real-bug signal
  // this guard exists to catch.
  if(typeof raClearInMemoryState==='function') raClearInMemoryState();

  // Re-show lock message
  const lock=document.getElementById('home-tab-lock');
  if(lock) lock.style.display='flex';

  // Leak-detection regression guard (session-store.js) — verifies every
  // session-content field the resets above are supposed to have zeroed is
  // actually empty; console.errors by name if not, catching the exact class
  // of bug that shipped piPlans/piReadinessPlans/window._ddRows with no reset.
  if(typeof _ssAssertCleanSlate==='function') _ssAssertCleanSlate();

  console.log('Session cleared — ready for new launch');
}

// ── Load Demo ──
function homeLoadDemo(){
  if(sessionActive) homeClearSession();
  _homeDoLoadDemo();
}

function _homeDoLoadDemo(){
  _isDemoSession=true; // demo sessions are never saved to the store
  let _picked='focusly';
  const _checked=document.querySelector('input[name="home-demo-pick"]:checked');
  if(_checked)_picked=_checked.value;
  if(typeof loadDemoData==='function') loadDemoData(_picked);
  sessionActive=true;
  // sessionContext is set inside loadDemoData() for demo
  const lock=document.getElementById('home-tab-lock');
  if(lock) lock.style.display='none';
}

// ── Inline error ──
function _homeSetError(msg){
  const el=document.getElementById('home-launch-error');
  if(!el) return;
  el.style.display=msg?'block':'none';
  el.innerHTML=msg;
}

// ── Inline error for the capability list (cond-box) ──
function _homeSetCondError(msg){
  const el=document.getElementById('home-cond-error');
  if(!el) return;
  el.style.display=msg?'block':'none';
  el.innerHTML=msg;
}

// ── Shared session-summary content builder (v9.15.02) ──
// Extracted from mmRenderSessionPanel() so Guided Launch's own left panel
// (#gl-left, guided-launch.js) can show the SAME real Company/Product/Type/
// Industry/Approach/Mode/Docs content, rather than a separate hand-built
// lookalike — this was only possible because Guided Launch sessions are now
// real sessionContext-bearing sessions from creation (v9.15.02 unification),
// not a second, empty-shell record. Returns the inner HTML only (the
// .form-scroll/.gl-left-body content) — each caller supplies its own header/
// collapse chrome, since those differ (DM's shared panelOpen/icon-exp/
// icon-col vs Guided Launch's own glPanelOpen/icon-gl-exp/icon-gl-col).
function _mmBuildSessionSummaryHtml(sc){
  if(!sc) return '';
  const p=sc.productProfile||{};
  const cp=sc.companyProfile||{};
  const approachLabel=sc.approach==='outcome-based'?'Outcome Metrics':'Process Area';
  const modeLabel=sc.generationMode==='ai-generated'?'AI Generated':'Manual';
  const companyName=cp.companyName||'';

  var _docsHtml='';
  if(sc.sessionDocs&&sc.sessionDocs.length>0){
    var _dtL={prd:'PRD',rfp:'RFP',research:'Research',feedback:'VoC',roadmap:'Roadmap',strategy:'Strategy',backlog:'Backlog',other:'Other'};
    var _dtC={prd:'background:var(--purple-pale);color:var(--purple);',rfp:'background:var(--blue-pale);color:var(--blue);',research:'background:var(--blue-pale);color:var(--blue);',feedback:'background:var(--amber-pale);color:var(--amber);',roadmap:'background:#E6F5EF;color:var(--green);',strategy:'background:var(--card);color:var(--t3);',backlog:'background:var(--card);color:var(--t2);',other:'background:var(--card);color:var(--t3);'};
    var _chips=sc.sessionDocs.map(function(d){var dt=d.docType||'other';return '<span style="font-size:9px;font-weight:700;border-radius:20px;padding:1px 7px;'+(_dtC[dt]||_dtC.other)+'">'+e(_dtL[dt]||'Other')+'</span>';}).join(' ');
    _docsHtml='<div class="mm-sp-row"><span class="mm-sp-key">Docs</span><span class="mm-sp-val" style="white-space:normal;display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;">'+_chips+'</span></div>';
  }

  var _cvcHtml='';
  if(sc.customValueChain){
    _cvcHtml='<div class="mm-sp-fl-block">'
      +'<span class="mm-sp-fl-label">Custom Value Chain</span>'
      +'<div class="mm-sp-fl-box">'+e(sc.customValueChain)+'</div>'
      +'</div>';
  }

  var _ctxHtml='';
  if(sc.additionalContext){
    _ctxHtml='<div class="mm-sp-fl-block">'
      +'<div class="mm-sp-fl-label-row" onclick="mmSpCtxToggle()">'
      +'<span class="mm-sp-fl-label">Additional Context</span>'
      +'<i class="ti ti-chevron-down mm-sp-fl-chevron" id="mm-sp-ctx-chev" aria-hidden="true"></i>'
      +'</div>'
      +'<div class="mm-sp-ctx-box mm-sp-ctx-hidden" id="mm-sp-ctx-body">'+e(sc.additionalContext)+'</div>'
      +'</div>';
  }

  var _launchInputsHtml=(_cvcHtml||_ctxHtml)
    ?('<div class="mm-sp-divider"></div>'+_cvcHtml+_ctxHtml)
    :'';

  return `
      ${companyName?'<div class="mm-sp-row"><span class="mm-sp-key">Company</span><span class="mm-sp-val">'+e(companyName)+'</span></div>':''}
      <div class="mm-sp-row"><span class="mm-sp-key">Product</span><span class="mm-sp-val">${e(p.productName||'-')}</span></div>
      <div class="mm-sp-row"><span class="mm-sp-key">Type</span><span class="mm-sp-val">${e(p.productType||'-')}</span></div>
      <div class="mm-sp-row"><span class="mm-sp-key">Industry</span><span class="mm-sp-val">${e(p.industry||cp.companyIndustry||'-')}</span></div>
      <div class="mm-sp-divider"></div>
      <div class="mm-sp-row"><span class="mm-sp-key">Approach</span><span class="mm-sp-badge">${approachLabel}</span></div>
      <div class="mm-sp-row"><span class="mm-sp-key">Mode</span><span class="mm-sp-val">${modeLabel}</span></div>
      ${sc.marketIntelligence?'<div class="mm-sp-row"><span class="mm-sp-key">Market Intel</span><span class="mm-sp-badge mm-sp-badge-green">On</span></div>':''}
      ${_docsHtml}
      ${p.icp?'<div class="mm-sp-divider"></div><div class="mm-sp-row mm-sp-row-wrap"><span class="mm-sp-key">ICP</span><span class="mm-sp-val">'+e(p.icp)+'</span></div>':''}
      ${_launchInputsHtml}`;
}

// ── Session summary panel for mm tab ──
// Renders a read-only session card into #left-panel when sessionActive
function mmRenderSessionPanel(){
  const lp=document.getElementById('left-panel');
  if(!lp) return;
  const sc=typeof sessionContext!=='undefined'?sessionContext:null;
  if(!sc){lp.classList.add('sc-hidden');return;}

  const p=sc.productProfile||{};

  // Restore panel collapsed state (may have been collapsed before navigating away)
  const isCollapsed=lp.classList.contains('collapsed');
  if(typeof panelOpen!=='undefined') panelOpen=!isCollapsed;
  lp.classList.remove('sc-hidden');

  lp.innerHTML=`
    <div class="ph">
      <div class="ph-text">
        <div class="ph-title">Active Session</div>
        <div class="ph-sub" id="mm-ph-sub">${e(
          (typeof _activeSessionName!=='undefined'&&_activeSessionName)||
          p.productName||'Unnamed product'
        )}</div>
      </div>
      <button class="collapse-btn" onclick="togglePanel()" title="Toggle panel">
        <svg id="icon-exp" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="${isCollapsed?'display:none':''}"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>
        <svg id="icon-col" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="${isCollapsed?'':'display:none'}"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>
      </button>
    </div>
    <div class="form-scroll" style="padding:12px 14px;overflow:hidden;">
      ${_mmBuildSessionSummaryHtml(sc)}
    </div>`;
}

// ── Toggle Additional Context expand/collapse in DM session panel ──
function mmSpCtxToggle(){
  var body=document.getElementById('mm-sp-ctx-body');
  var chev=document.getElementById('mm-sp-ctx-chev');
  if(!body||!chev) return;
  var isHidden=body.classList.contains('mm-sp-ctx-hidden');
  body.classList.toggle('mm-sp-ctx-hidden',!isHidden);
  chev.style.transform=isHidden?'rotate(180deg)':'';
}

// ── SESSION LIBRARY (v7.86) ──
// Renders the session card grid into the home-main panel.
// Called on homeOnTabEnter() and after any session operation.

function homeRenderSessionLibrary(){
  const main=document.getElementById('home-main-body');
  if(!main) return;

  const sessions=typeof sessionStoreList==='function'?sessionStoreList():[];

  if(sessions.length===0){
    // Zero sessions — restore empty state, remove library if present
    const lib=main.querySelector('.home-sess-library');
    if(lib) lib.remove();
    const emptyWrap=main.querySelector('.home-empty-wrap');
    if(emptyWrap) emptyWrap.style.display='';
    return;
  }

  // Hide empty state
  const emptyWrap=main.querySelector('.home-empty-wrap');
  if(emptyWrap) emptyWrap.style.display='none';

  // Get or create library container
  let lib=main.querySelector('.home-sess-library');
  if(!lib){
    lib=document.createElement('div');
    lib.className='home-sess-library';
    main.appendChild(lib);
  }

  // ── Dashboard header — built ONCE, never rebuilt on re-entry ──
  // Preserves AI recs DOM across Home tab navigations.
  // Only the sessions-header row (filter/sort/search) is rebuilt on re-entry.
  let toolbar=lib.querySelector('.home-sess-toolbar');
  if(!toolbar){
    toolbar=document.createElement('div');
    toolbar.className='home-sess-toolbar';
    lib.appendChild(toolbar);
  }

  // Aggregate counts for hero bar
  let _heroCaps=0,_heroFeatures=0,_heroStories=0,_heroProtos=0;
  sessions.forEach(function(s){
    const c=s.counts||{};
    _heroCaps+=(c.caps||0);
    _heroFeatures+=(c.features||0);
    _heroStories+=(c.stories||0);
    _heroProtos+=(c.protos||0);
  });
  // Distinct product count — how many configured products the sessions span
  const _heroProductCount=new Set(sessions.map(function(s){return s.productName||'';}).filter(Boolean)).size;

  // Sub-labels
  const _capSub=(function(){const n=sessions.filter(function(s){return s.counts&&s.counts.caps>0;}).length;return n===1?'1 session in CC':n+' sessions in CC';})();
  const _ftSub=(function(){const n=sessions.filter(function(s){return s.counts&&s.counts.features>0;}).length;return n===1?'1 session in FC':n+' sessions in FC';})();
  const _scSub=(function(){const n=sessions.filter(function(s){return s.counts&&s.counts.stories>0;}).length;return n===1?'1 session in SC':n+' sessions in SC';})();
  const _protoSessionCount=sessions.filter(function(s){return s.counts&&s.counts.protos&&s.counts.protos>0;}).length;
  const _protoSub='from '+_protoSessionCount+' session'+(_protoSessionCount!==1?'s':'');

  // Build dashboard row only if it doesn't already exist
  let dashRow=toolbar.querySelector('.home-dashboard-row');
  if(!dashRow){
    dashRow=document.createElement('div');
    dashRow.innerHTML=
      '<div class="home-dashboard-row">'+
        '<div class="home-hero-bar">'+
          '<div class="home-hero-eyebrow"><i class="ti ti-chart-bar" aria-hidden="true"></i> Product Discovery Snapshot</div>'+
          '<div class="home-hero-stats" id="home-hero-stats-inner"></div>'+
        '</div>'+
        '<div class="home-ai-panel" id="home-ai-section">'+
          '<div class="home-ai-hdr">'+
            '<div class="home-ai-title"><div class="home-ai-icon"><i class="ti ti-sparkles" aria-hidden="true"></i></div> AI Recommendations</div>'+
            '<button class="home-ai-refresh" onclick="homeAIRecsRefresh()"><i class="ti ti-refresh" aria-hidden="true"></i> Refresh</button>'+
          '</div>'+
          '<div class="home-ai-recs" id="home-ai-recs"><div class="home-ai-loading"><span class="home-ai-dot"></span><span class="home-ai-dot"></span><span class="home-ai-dot"></span> Analysing your sessions…</div></div>'+
        '</div>'+
      '</div>';
    toolbar.appendChild(dashRow);
    // Fire AI recommendations only on first build
    _homeLoadAIRecs(sessions);
  }

  // Always update hero stats (counts may have changed)
  const statsInner=toolbar.querySelector('#home-hero-stats-inner');
  if(statsInner){
    statsInner.innerHTML=
      '<div class="home-hero-stat">'+
        '<div class="home-hero-val">'+sessions.length+'</div>'+
        '<div class="home-hero-label">Sessions</div>'+
        '<div class="home-hero-sub">'+_heroProductCount+' product'+(_heroProductCount!==1?'s':'')+'</div>'+
      '</div>'+
      '<div class="home-hero-stat">'+
        '<div class="home-hero-val">'+_heroCaps+'</div>'+
        '<div class="home-hero-label">Capabilities</div>'+
        '<div class="home-hero-sub">'+_capSub+'</div>'+
      '</div>'+
      '<div class="home-hero-stat">'+
        '<div class="home-hero-val">'+_heroFeatures+'</div>'+
        '<div class="home-hero-label">Features</div>'+
        '<div class="home-hero-sub">'+_ftSub+'</div>'+
      '</div>'+
      '<div class="home-hero-stat">'+
        '<div class="home-hero-val">'+_heroStories+'</div>'+
        '<div class="home-hero-label">Stories</div>'+
        '<div class="home-hero-sub">'+_scSub+'</div>'+
      '</div>'+
      '<div class="home-hero-stat">'+
        '<div class="home-hero-val">'+_heroProtos+'</div>'+
        '<div class="home-hero-label">Prototypes</div>'+
        '<div class="home-hero-sub">'+_protoSub+'</div>'+
      '</div>';
  }

  // Unique product names for session filter dropdown — sorted alphabetically
  const products=[...new Set(sessions.map(function(s){return s.productName||'';}).filter(Boolean))].sort(function(a,b){return a.localeCompare(b);});

  // Sessions header row — rebuilt on every call (filter/sort state may change)
  let sessHeaderRow=toolbar.querySelector('.home-sess-toolbar-row');
  if(!sessHeaderRow){
    sessHeaderRow=document.createElement('div');
    sessHeaderRow.className='home-sess-toolbar-row';
    toolbar.appendChild(sessHeaderRow);
  }
  sessHeaderRow.innerHTML=
    '<div class="home-sess-toolbar-left">'+
      '<span class="home-sess-toolbar-title"><i class="ti ti-layout-cards" aria-hidden="true"></i> All Sessions</span>'+
      '<span class="home-sess-count-badge">'+sessions.length+'</span>'+
    '</div>'+
    '<div class="home-sess-toolbar-right">'+
      '<div class="home-sess-ctrl">'+
        '<i class="ti ti-filter" aria-hidden="true"></i>'+
        '<select class="home-sess-ctrl-select" onchange="homeSessionFilterProduct(this.value)">'+
          '<option value="all"'+((_homeSessFilter==='all')?' selected':'')+'>All Products</option>'+
          products.map(function(p){return '<option value="'+e(p)+'"'+((_homeSessFilter===p)?' selected':'')+'>'+e(p)+'</option>';}).join('')+
        '</select>'+
      '</div>'+
      '<div class="home-sess-ctrl">'+
        '<i class="ti ti-arrows-sort" aria-hidden="true"></i>'+
        '<select class="home-sess-ctrl-select" onchange="homeSessionSort(this.value)">'+
          '<option value="lastSaved"'+((_homeSessSort==='lastSaved')?' selected':'')+'>Last Modified</option>'+
          '<option value="createdAt"'+((_homeSessSort==='createdAt')?' selected':'')+'>Newest First</option>'+
          '<option value="productName"'+((_homeSessSort==='productName')?' selected':'')+'>Product A-Z</option>'+
          '<option value="sessionName"'+((_homeSessSort==='sessionName')?' selected':'')+'>Session Name</option>'+
        '</select>'+
      '</div>'+
      '<div class="home-sess-search-wrap">'+
        '<i class="ti ti-search" aria-hidden="true"></i>'+
        '<input class="home-sess-search-input" id="home-sess-search-inp" type="text" placeholder="Search sessions..." value="'+e(_homeSessSearch)+'" oninput="_homeSessionSearchLive(this.value)" autocomplete="off">'+
      '</div>'+
    '</div>';

  // ── Cards area — re-rendered on filter/sort/search ──
  _homeRenderCards(lib, sessions);
}

// Renders only the cards area — toolbar is preserved
function _homeRenderCards(lib, sessions){
  if(!lib) return;
  if(!sessions) sessions=typeof sessionStoreList==='function'?sessionStoreList():[];

  const filtered=_homeGetFilteredSessions(sessions);

  // v8.150 fix (Issue 3): the badge (which session shows "Last Active")
  // and the actual first-position card in the grid were computed
  // completely independently — a prior fix corrected which session gets
  // the badge, but never touched this ordering, so the two could point
  // at different sessions. Restoring the original intended pairing:
  // pin the badged session to the front — but only under the default
  // "Last Modified" sort. Overriding an explicit, different sort choice
  // (alphabetical, by name, etc.) the person deliberately selected would
  // look like broken sorting, not a helpful highlight. Never resurrect
  // the pin if the current filter/search has already excluded that
  // session — a filtered-out session should stay filtered out.
  //
  // v8.149 fix (Issue 2): this pointer itself comes from this person's
  // own tracked "last active" value (populated at boot from
  // mt_users_companies via _pgtResolveCompany, updated on every
  // create/resume) — not from sorting every cached session by
  // whoever-saved-it-most-recently, which let any collaborator's edit
  // silently override what showed as THIS person's own last active
  // session. savedAt itself is untouched and still correctly drives the
  // "Updated X ago" line and the explicit "sort by last modified" option,
  // both legitimately about anyone's activity, not just this person's own.
  const lastActiveId=(typeof _pgtMyLastActiveSessionId!=='undefined'&&_pgtMyLastActiveSessionId&&sessions.some(function(s){return s.id===_pgtMyLastActiveSessionId;}))
    ? _pgtMyLastActiveSessionId
    : null;
  if (_homeSessSort==='lastSaved' && lastActiveId){
    var _pinIdx=filtered.findIndex(function(s){return s.id===lastActiveId;});
    if (_pinIdx>0){
      var _pinned=filtered.splice(_pinIdx,1)[0];
      filtered.unshift(_pinned);
    }
  }

  // Remove old cards area
  const old=lib.querySelector('.home-sess-cards-area');
  if(old) old.remove();

  const area=document.createElement('div');
  area.className='home-sess-cards-area';

  if(filtered.length>0){
    const grid=document.createElement('div');
    grid.className='home-sess-grid';
    filtered.forEach(function(sess){
      grid.innerHTML+=_homeRenderSessionCard(sess, sess.id===lastActiveId);
    });
    area.appendChild(grid);
  } else if(_homeSessSearch||_homeSessFilter!=='all'){
    area.innerHTML+='<div class="home-sess-empty-filter">No sessions match your filter.</div>';
  }

  lib.appendChild(area);
}

function _homeGetFilteredSessions(sessions){
  let list=sessions.slice();
  // Product filter
  if(_homeSessFilter&&_homeSessFilter!=='all'){
    list=list.filter(function(s){return s.productName===_homeSessFilter;});
  }
  // Search
  if(_homeSessSearch){
    const q=_homeSessSearch.toLowerCase();
    list=list.filter(function(s){
      return (s.name||'').toLowerCase().indexOf(q)>-1||(s.productName||'').toLowerCase().indexOf(q)>-1;
    });
  }
  // Sort
  if(_homeSessSort==='createdAt'){
    list.sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);});
  } else if(_homeSessSort==='productName'){
    list.sort(function(a,b){return (a.productName||'').localeCompare(b.productName||'');});
  } else if(_homeSessSort==='sessionName'){
    list.sort(function(a,b){return (a.name||'').localeCompare(b.name||'');});
  } else {
    list.sort(function(a,b){return (b.savedAt||0)-(a.savedAt||0);});
  }
  return list;
}

// ── Phase 5: session card 3-dot menu ──
// Reuses _uiRowMenuToggle()/_uiRowMenuClose() (utils.js, built generic in
// Phase 4 specifically for this reuse) — only the menu CONTENT below is new.
// Styled via .tm-menu-item/.tm-dots (styles/20-team-management.css) —
// confirmed safe to reuse: all CSS loads unconditionally via <link> in
// index.html's <head>, not conditionally scoped to the Settings-page DOM.
function _homeSessMenuHtml(sess){
  const _shareLabel = sess.isShared ? 'Unshare' : 'Share';
  const _shareIcon  = sess.isShared ? 'ti-users-minus' : 'ti-users';
  // Phase 5, fixed after adversarial review: the original version spliced
  // e(sess.name) — HTML-escaped, but NOT JS-string-escaped — directly into
  // a single-quoted argument inside onclick="...". e() doesn't escape ' or
  // \, so a session name like "Bob's plan" broke the handler outright, and
  // a deliberately crafted name could inject arbitrary JS. This was also a
  // PRE-EXISTING bug at two other call sites (homeSessionRenameInline in
  // both card-render functions) that predates this phase — fixed there too,
  // see below. Fixed here by moving off inline onclick with string
  // arguments entirely: session id/name/isShared travel as data-*
  // attributes (through e(), the CORRECT tool for an HTML attribute value)
  // and _homeSessMenuAction() below reads them back off the clicked
  // element — no JS string literal ever contains untrusted data.
  const _safeId = e(sess.id);
  const _safeName = e(sess.name||'');
  return ''
    +'<div role="menuitem" tabindex="0" class="tm-menu-item" data-sess-action="rename" data-sess-id="'+_safeId+'" onclick="_uiRowMenuClose();_homeSessMenuAction(this)">'
      +'<i class="ti ti-pencil" aria-hidden="true"></i>Rename</div>'
    +'<div role="menuitem" tabindex="0" class="tm-menu-item" data-sess-action="toggle-share" data-sess-id="'+_safeId+'" onclick="_uiRowMenuClose();_homeSessMenuAction(this)">'
      +'<i class="ti '+_shareIcon+'" aria-hidden="true"></i>'+_shareLabel+'</div>'
    +'<div style="height:0.5px;background:var(--divider);"></div>'
    +'<div role="menuitem" tabindex="0" class="tm-menu-item tm-menu-item-danger" data-sess-action="delete" data-sess-id="'+_safeId+'" data-sess-name="'+_safeName+'" data-sess-shared="'+(sess.isShared?'1':'0')+'" onclick="_uiRowMenuClose();_homeSessMenuAction(this)">'
      +'<i class="ti ti-trash" aria-hidden="true"></i>Delete</div>';
}

// Phase 5: single delegated handler for the session-card 3-dot menu. Reads
// action/id/name/shared straight off the clicked element's data-*
// attributes (already HTML-decoded correctly by the browser — no manual
// JS-string parsing of anything) and dispatches to the real function. This
// is what makes the menu immune to the escaping bug described above: no
// value from sess ever passes through a JS string literal at all.
function _homeSessMenuAction(el){
  if(!el) return;
  const action=el.getAttribute('data-sess-action');
  const id=el.getAttribute('data-sess-id');
  if(!id) return;
  if(action==='rename') homeStartRenameFromMenu(id);
  else if(action==='toggle-share') homeSessionToggleShare(id);
  else if(action==='delete'){
    const name=el.getAttribute('data-sess-name')||'';
    const isShared=el.getAttribute('data-sess-shared')==='1';
    homeSessionDeleteConfirm(id,name,isShared);
  }
}

function homeToggleSessMenu(triggerEl, sessionId){
  const sess=(typeof sessionStoreList==='function'?sessionStoreList():[]).find(function(s){return s.id===sessionId;});
  if(!sess) return;
  const menuHtml='<div style="width:150px;background:#fff;border:1px solid var(--divider);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.12);overflow:hidden;">'+_homeSessMenuHtml(sess)+'</div>';
  _uiRowMenuToggle(triggerEl, menuHtml);
}

// Rename entry point from the 3-dot menu — locates the live name element on
// the card (now line 1, .home-sess-name — see B3) and hands off to the
// existing homeSessionRenameInline() mechanism unchanged. Menu closes first
// (see call site above) so the DOM query below finds the settled card, not
// a stale one mid-close.
function homeStartRenameFromMenu(sessionId){
  const nameEl=document.querySelector('[data-sess-name-id="'+sessionId+'"]');
  if(!nameEl) return;
  const sess=(typeof sessionStoreList==='function'?sessionStoreList():[]).find(function(s){return s.id===sessionId;});
  homeSessionRenameInline(sessionId, nameEl, (sess&&sess.name)||'');
}


// ── Phase 5: meta line, three states ──
// Private: unchanged relative-time only.
// Shared, idle: "Updated x ago by [Name]" — lastEditedByName is a
// denormalized snapshot (see session-store.js _ssUpsertToDB), not a live
// lookup, by deliberate design (Gap 1 resolution).
// Shared, someone actively generating: "[Name] is generating now" —
// informational only. Staleness mirrors acquire_generation_lock()'s own
// 60s window so this label doesn't claim someone's generating long after
// their lock would actually be reclaimable.
function _homeSessMetaLine(sess){
  const _timeStr=_homeRelTime(sess.savedAt);
  if(!sess.isShared) return '<span class="home-sess-time">Updated '+_timeStr+'</span>';
  // Phase 5, fixed after B3 testing: the original check
  // (Date.now()-sess.activeAt < 60000) is true for ANY activeAt in the
  // future, since a negative age is always < 60000 — a clock-skewed
  // client or a corrupted localStorage record with a future timestamp
  // would show "generating now" indefinitely, never going stale. Bounded
  // on both ends now: age must be non-negative (allowing a small grace
  // window for minor clock skew between client and whatever set the
  // timestamp) AND under the 60s staleness window.
  const _ageMs = Date.now() - Number(sess.activeAt);
  const _isGenerating = sess.activeUserId && sess.activeAt
    && Number.isFinite(_ageMs) && _ageMs >= -5000 && _ageMs < 60000;
  if(_isGenerating){
    const _genName = sess.activeUserName || 'Someone';
    return '<span class="home-sess-time home-sess-time-generating"><i class="ti ti-loader-2" aria-hidden="true"></i> '+e(_genName)+' is generating now</span>';
  }
  const _byName = sess.lastEditedByName ? ' by '+e(sess.lastEditedByName) : '';
  return '<span class="home-sess-time">Updated '+_timeStr+_byName+'</span>';
}

function _homeRenderPinnedBanner(sess){
  const stagePill=_homeGetStagePill(sess.lastStage);
  const counts=sess.counts||{};
  const approachPill=sess.approach==='capability-based'
    ?'<span class="home-sess-pill home-sess-pill-cap"><i class="ti ti-sitemap" aria-hidden="true"></i> Process Area</span>'
    :'<span class="home-sess-pill home-sess-pill-outcome"><i class="ti ti-chart-line" aria-hidden="true"></i> Outcome Metrics</span>';
  const modePill=sess.generationMode==='manual'
    ?'<span class="home-sess-pill home-sess-pill-mode">Manual</span>'
    :'<span class="home-sess-pill home-sess-pill-mode">AI Generated</span>';
  const _sharedIcon=sess.isShared?'<i class="ti ti-users" aria-hidden="true" title="Shared with your team" style="font-size:11px;color:var(--t3);margin-left:5px;"></i>':'';
  // Phase 5 (v8.117 fix): only the session's owner sees the 3-dot menu at
  // all. Root cause of the original gap: the DB's own RLS already blocks
  // a non-owner's actual Rename/Unshare/Delete (both are UPDATE/DELETE,
  // restricted to user_id = current_app_user()), but the client had no
  // way to know that — it optimistically mutated LOCAL state regardless,
  // so a non-owner clicking Delete on someone else's shared session would
  // see it vanish from their own screen, then silently reappear on next
  // sync, since nothing had actually changed server-side. !sess.userId
  // covers legacy pre-Phase-5 records with no owner field recorded at
  // all — without this fallback, a real owner's own old session would
  // incorrectly hide the menu from THEM. Confirmed direction from
  // stakeholder: non-owner sees NO trigger at all, not an empty menu.
  // Read Only role blocks the same actions the DB's RLS already blocks
  // (Rename/Delete are UPDATE/DELETE) - without this, a read-only user
  // viewing their OWN pre-downgrade sessions still passes the raw
  // ownership check below and sees a live-looking 3-dot menu/rename
  // target that silently no-ops (or ghost-deletes then reappears on
  // next sync) server-side. See _homeApplyReadOnlyState()'s identical
  // currentUserRole check for the Setup panel's equivalent gate.
  const _isReadOnlyUser=(typeof _ssIsReadOnlyRole==='function')&&_ssIsReadOnlyRole();
  const _isOwner=!_isReadOnlyUser&&(!sess.userId||sess.userId===(typeof currentUser!=='undefined'&&currentUser?currentUser.id:null));
  const _dotsBtn=_isOwner?'<button class="tm-dots" aria-label="Session actions" aria-expanded="false" style="position:absolute;top:6px;right:6px;" onclick="event.stopPropagation();homeToggleSessMenu(this,\''+sess.id+'\')"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>':'';

  let html='<div class="home-pin-banner" onclick="homeSessionResume(\''+sess.id+'\')">';
  html+='<div class="home-pin-label"><i class="ti ti-bolt" aria-hidden="true"></i> Last active</div>';
  html+=_dotsBtn;
  html+='<div class="home-sess-top" style="padding-top:20px;">';
  html+='<div class="home-sess-icon"><i class="ti ti-device-laptop" aria-hidden="true"></i></div>';
  html+='<div class="home-sess-meta">';
  html+=(_isOwner
    ?'<div class="home-sess-name" data-sess-name-id="'+sess.id+'" onclick="event.stopPropagation();homeSessionRenameInline(\''+sess.id+'\',this)" title="Click to rename">'+e(sess.name||'')+_sharedIcon+'</div>'
    // Phase 5 (v8.117 fix): non-owner gets plain, non-interactive text —
    // no onclick, no "Click to rename" title, no rename affordance at
    // all. This closes the SAME gap the 3-dot hiding closes, for a
    // second, separate click target (the name text itself) that was
    // missed on the first pass — confirmed via grep that this onclick
    // existed independently of the 3-dot menu's homeStartRenameFromMenu()
    // path, and was NOT gated by the ownership check when that check was
    // first added.
    :'<div class="home-sess-name" data-sess-name-id="'+sess.id+'">'+e(sess.name||'')+_sharedIcon+'</div>'
  );
  html+='<div class="home-sess-sub">'+e(sess.productName||'Unnamed')+'<span class="home-sess-type-badge">'+e(sess.productType||'')+'</span></div>';
  html+='</div>';
  html+='</div>'; // sess-top
  html+='<div class="home-sess-pills">'+approachPill+modePill+stagePill+'</div>';
  html+='<div class="home-sess-divider"></div>';
  html+='<div class="home-pin-bottom">';
  html+='<div class="home-sess-counts">';
  html+='<div class="home-sess-ct"><i class="ti ti-file-description" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.briefs||0)+'</span> briefs</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-layers-subtract" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.caps||0)+'</span> caps</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-writing" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.features||0)+'</span> features</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-list-details" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.stories||0)+'</span> stories</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-rocket" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.releases||0)+'</span> releases</div>';
  html+='</div>';
  html+='<button class="home-sess-resume-link" onclick="event.stopPropagation();homeSessionResume(\''+sess.id+'\')"><i class="ti ti-player-play" aria-hidden="true"></i> Resume &#8594;</button>';
  html+='</div>'; // pin-bottom
  html+='</div>'; // pin-banner
  return html;
}

function _homeRenderSessionCard(sess, isLastActive){
  const stagePill=_homeGetStagePill(sess.lastStage);
  const counts=sess.counts||{};
  const isActive=(typeof _activeSessionId!=='undefined'&&_activeSessionId===sess.id);
  const approachPill=sess.approach==='capability-based'
    ?'<span class="home-sess-pill home-sess-pill-cap">Process Area</span>'
    :'<span class="home-sess-pill home-sess-pill-outcome">Outcome Metrics</span>';
  const modePill=sess.generationMode==='manual'
    ?'<span class="home-sess-pill home-sess-pill-mode">Manual</span>'
    :'<span class="home-sess-pill home-sess-pill-mode">AI</span>';
  const _sharedIcon=sess.isShared?'<i class="ti ti-users" aria-hidden="true" title="Shared with your team" style="font-size:11px;color:var(--t3);margin-left:5px;"></i>':'';
  // Phase 5 (v8.117 fix): identical ownership check to
  // _homeRenderPinnedBanner above — see that function's comment for the
  // full rationale. Both render functions must apply this consistently,
  // since they render the same underlying session data in two different
  // card layouts (pinned banner vs. regular grid card).
  // Read Only role blocks the same actions the DB's RLS already blocks
  // (Rename/Delete are UPDATE/DELETE) - without this, a read-only user
  // viewing their OWN pre-downgrade sessions still passes the raw
  // ownership check below and sees a live-looking 3-dot menu/rename
  // target that silently no-ops (or ghost-deletes then reappears on
  // next sync) server-side. See _homeApplyReadOnlyState()'s identical
  // currentUserRole check for the Setup panel's equivalent gate.
  const _isReadOnlyUser=(typeof _ssIsReadOnlyRole==='function')&&_ssIsReadOnlyRole();
  const _isOwner=!_isReadOnlyUser&&(!sess.userId||sess.userId===(typeof currentUser!=='undefined'&&currentUser?currentUser.id:null));
  const _dotsBtn=_isOwner?'<button class="tm-dots" aria-label="Session actions" aria-expanded="false" style="position:absolute;top:6px;right:6px;" onclick="event.stopPropagation();homeToggleSessMenu(this,\''+sess.id+'\')"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button>':'';

  let html='<div class="home-sess-card'+(isLastActive?' home-sess-card-last-active':'')+(isActive?' home-sess-card-active':'')+'" onclick="homeSessionResume(\''+sess.id+'\')">';
  if(isLastActive) html+='<div class="home-sess-last-active-badge"><i class="ti ti-bolt" aria-hidden="true"></i> Last Active</div>';
  html+=_dotsBtn;
  html+='<div class="home-sess-top">';
  html+='<div class="home-sess-icon"><i class="ti ti-device-laptop" aria-hidden="true"></i></div>';
  html+='<div class="home-sess-meta">';
  html+=(_isOwner
    ?'<div class="home-sess-name" data-sess-name-id="'+sess.id+'" onclick="event.stopPropagation();homeSessionRenameInline(\''+sess.id+'\',this)" title="Click to rename">'+e(sess.name||'')+_sharedIcon+'</div>'
    // Phase 5 (v8.117 fix): non-owner gets plain, non-interactive text —
    // no onclick, no "Click to rename" title, no rename affordance at
    // all. This closes the SAME gap the 3-dot hiding closes, for a
    // second, separate click target (the name text itself) that was
    // missed on the first pass — confirmed via grep that this onclick
    // existed independently of the 3-dot menu's homeStartRenameFromMenu()
    // path, and was NOT gated by the ownership check when that check was
    // first added.
    :'<div class="home-sess-name" data-sess-name-id="'+sess.id+'">'+e(sess.name||'')+_sharedIcon+'</div>'
  );
  html+='<div class="home-sess-sub">'+e(sess.productName||'Unnamed')+'<span class="home-sess-type-badge">'+e(sess.productType||'')+'</span></div>';
  html+='</div>';
  html+='</div>'; // sess-top
  html+='<div class="home-sess-pills">'+approachPill+modePill+stagePill+'</div>';
  html+='<div class="home-sess-divider"></div>';
  html+='<div class="home-sess-bottom">';
  html+='<div class="home-sess-counts-grid">';
  html+='<div class="home-sess-ct"><i class="ti ti-file-description" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.briefs||0)+'</span> briefs</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-layers-subtract" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.caps||0)+'</span> caps</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-writing" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.features||0)+'</span> features</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-list-details" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.stories||0)+'</span> stories</div>';
  html+='<div class="home-sess-ct"><i class="ti ti-rocket" aria-hidden="true"></i><span class="home-sess-ct-val">'+(counts.releases||0)+'</span> releases</div>';
  html+='</div>';
  html+='<div class="home-sess-footer-row">';
  html+=_homeSessMetaLine(sess);
  html+='<button class="home-sess-resume-link" onclick="event.stopPropagation();homeSessionResume(\''+sess.id+'\')"><i class="ti ti-player-play" aria-hidden="true"></i> Resume &#8594;</button>';
  html+='</div>';
  html+='</div>'; // sess-bottom
  html+='</div>'; // sess-card
  return html;
}

function _homeGetStagePill(stage){
  const map={
    'Outcome Pulse':     ['home-sess-pill-stage-op','ti-activity'],
    'Adoption Readiness':['home-sess-pill-stage-arp','ti-checklist'],
    'Release Canvas':    ['home-sess-pill-stage-pi','ti-calendar-event'],
    'Story Canvas': ['home-sess-pill-stage-sc','ti-list-details'],
    'Feature Canvas':['home-sess-pill-stage-fc','ti-writing'],
    'Capability Canvas':['home-sess-pill-stage-cc','ti-layers-subtract'],
    'Requirement Agent':['home-sess-pill-stage-ra','ti-clipboard-text'],
    'Discovery Map':['home-sess-pill-stage-dm','ti-hierarchy-2'],
    'Market Intelligence':['home-sess-pill-stage-mi','ti-world-search'],
    'Guided Launch':['home-sess-pill-stage-gl','ti-message-2']
  };
  const s=stage||'Discovery Map';
  const cfg=map[s]||map['Discovery Map'];
  return '<span class="home-sess-pill '+cfg[0]+'"><i class="ti '+cfg[1]+'" aria-hidden="true"></i> \u21b3 '+e(s)+'</span>';
}

function _homeRelTime(ts){
  if(!ts) return '';
  const diff=Date.now()-ts;
  const mins=Math.floor(diff/60000);
  if(mins<2) return 'just now';
  if(mins<60) return mins+' min ago';
  const hrs=Math.floor(mins/60);
  if(hrs<24) return hrs+' hr'+(hrs>1?'s':'')+' ago';
  const days=Math.floor(hrs/24);
  if(days===1) return 'Yesterday';
  if(days<7) return days+' days ago';
  const wks=Math.floor(days/7);
  return wks+' wk'+(wks>1?'s':'')+' ago';
}

// ── Session actions ──

// v9.15.02 — every session, Guided-Launch-originated or not, is a real
// mt_sessions row from creation now, so every resume goes through the same
// sessionStoreRestore() path. That function checks meta.intakeStatus itself
// and applies Guided Launch's chat/draft rendering when relevant — this
// function no longer needs to know or care where a session came from.
function homeSessionResume(sessionId){
  if(typeof sessionStoreRestore==='function') sessionStoreRestore(sessionId);
}

function homeSessionDeleteConfirm(sessionId, sessionName, isShared){
  // B4: copy branches on whether the session being deleted is shared.
  // Private copy trimmed (no itemized list) to match the shared variant's
  // tone — both now differ only in the sentence naming who's affected.
  const _msg = isShared
    ? 'This session is shared with your team. Deleting it removes all generated product data for everyone. This cannot be undone.'
    : 'This will permanently delete all generated product data for this session. This cannot be undone.';
  showConfirm(
    _msg,
    'Delete "'+sessionName+'"?',
    function(){
      const isActive=(typeof _activeSessionId!=='undefined'&&_activeSessionId===sessionId);
      if(typeof sessionStoreDelete==='function') sessionStoreDelete(sessionId);
      if(isActive){
        // Deleted the active session — clear live state without saving.
        // v14 code-review fix — sessionId passed into homeClearSession()
        // explicitly, since this caller deliberately nulls _activeSessionId
        // BEFORE calling it (so homeClearSession()'s own exit-save is
        // correctly skipped for an already-deleted session) — that ordering
        // otherwise starved homeClearSession()'s own occupancy-release
        // capture of the real session id. Confirmed non-exploitable in this
        // specific path (the row is already deleted, so occupancy fields
        // are gone via cascade too), but the pattern shouldn't depend on
        // every caller getting this ordering right by accident.
        _activeSessionId=null;
        _activeSessionIsShared=false;
        if(typeof homeClearSession==='function') homeClearSession(sessionId);
      }
      // Full re-render handles empty state restoration
      homeRenderSessionLibrary();
    },
    'Delete Session',
    'danger'
  );
}

function homeSessionRenameInline(sessionId,chipEl,currentName){
  if(!chipEl)return;
  // Idempotency guard
  var existingInput=chipEl.querySelector('input.home-sess-name-input');
  if(existingInput){existingInput.focus();existingInput.select();return;}
  var oldName=(currentName||chipEl.textContent||'').trim();
  chipEl.innerHTML='';
  var inp=document.createElement('input');
  inp.type='text';
  inp.className='home-sess-name-input';
  inp.value=oldName;
  inp.setAttribute('aria-label','Rename session');
  chipEl.appendChild(inp);
  chipEl.classList.add('is-editing');
  var committed=false;
  function _renderName(name){
    chipEl.classList.remove('is-editing');
    chipEl.innerHTML='<i class="ti ti-pencil" aria-hidden="true"></i> '+(name||oldName||'Untitled session');
  }
  function _save(){
    if(committed)return;
    var nextName=(inp.value||'').trim();
    if(!nextName){committed=true;_renderName(oldName);return;}
    // Duplicate check — case-insensitive, exclude self
    var _otherNames=(typeof sessionStoreList==='function'?sessionStoreList():[])
      .filter(function(s){return s.id!==sessionId;})
      .map(function(s){return(s.name||'').trim().toLowerCase();});
    if(_otherNames.indexOf(nextName.toLowerCase())!==-1){
      inp.style.borderColor='var(--red,#E24B4A)';
      inp.style.background='#FCEBEB';
      showToast('Name already in use. Try another.','error');
      return; // do not commit — keep input open for correction
    }
    committed=true;
    _renderName(nextName);
    if(typeof sessionStoreRename==='function')sessionStoreRename(sessionId,nextName);
    if(typeof _activeSessionId!=='undefined'&&sessionId===_activeSessionId&&typeof hdrSetSessionName==='function'){
      hdrSetSessionName(nextName);
    }
  }
  function _cancel(){
    if(committed)return;
    committed=true;
    _renderName(oldName);
  }
  inp.addEventListener('mousedown',function(ev){ev.stopPropagation();});
  inp.addEventListener('click',function(ev){ev.stopPropagation();});
  inp.addEventListener('keydown',function(ev){
    if(ev.key==='Enter'){ev.preventDefault();ev.stopPropagation();_save();}
    else if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();_cancel();}
  });
  inp.addEventListener('blur',function(){if(!committed)_cancel();});
  inp.focus();
  inp.select();
}


function homeSessionFilterProduct(val){
  _homeSessFilter=val||'all';
  const lib=document.querySelector('#home-main-body .home-sess-library');
  if(lib) _homeRenderCards(lib);
  else homeRenderSessionLibrary();
}

function homeSessionSort(val){
  _homeSessSort=val||'lastSaved';
  const lib=document.querySelector('#home-main-body .home-sess-library');
  if(lib) _homeRenderCards(lib);
  else homeRenderSessionLibrary();
}

function homeSessionSearch(query){
  _homeSessSearch=query||'';
  const lib=document.querySelector('#home-main-body .home-sess-library');
  if(lib) _homeRenderCards(lib);
  else homeRenderSessionLibrary();
}

// Called by oninput on search field — updates state and re-renders cards only
function _homeSessionSearchLive(query){
  _homeSessSearch=query||'';
  const lib=document.querySelector('#home-main-body .home-sess-library');
  if(lib){
    _homeRenderCards(lib);
    // Restore focus to search input after cards re-render
    const inp=lib.querySelector('#home-sess-search-inp');
    if(inp){
      inp.value=_homeSessSearch;
      inp.focus();
      // Place cursor at end
      inp.select();
    }
  }
}

// ── AI RECOMMENDATIONS (v7.97) ──
// Calls Claude on first Home tab entry per page load.
// Caches result in sessionStorage under 'pgt_ai_recs'.
// Invalidated when sessions change (count or savedAt changes).

var _homeAIRecsCacheKey = 'pgt_ai_recs';
var _homeAIRecsRequested = false; // true after first load call this page session — prevents re-firing on every Home tab entry

function _homeGetSessionsCacheToken(sessions) {
  // Simple token: count + sum of savedAt timestamps
  return sessions.length + ':' + sessions.reduce(function(s, x) { return s + (x.savedAt || 0); }, 0);
}

function _homeLoadAIRecs(sessions) {
  if (!sessions || sessions.length === 0) {
    const el = document.getElementById('home-ai-recs');
    if (el) el.innerHTML = '<div class="home-ai-empty">No sessions yet — launch a session to get recommendations.</div>';
    return;
  }

  const token = _homeGetSessionsCacheToken(sessions);

  // Check sessionStorage cache first
  try {
    const cached = sessionStorage.getItem(_homeAIRecsCacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.token === token && parsed.recs) {
        _homeRenderAIRecs(parsed.recs, sessions);
        _homeAIRecsRequested = true;
        return;
      }
    }
  } catch(e) {}

  // If already requested this page load (in-flight or just rendered), skip re-firing
  if (_homeAIRecsRequested) {
    // Recs are already loading or rendered — don't wipe and restart
    return;
  }

  // First request this page load — call Claude
  _homeAIRecsRequested = true;
  _homeCallAIRecs(sessions, token);
}

function homeAIRecsRefresh() {
  _homeAIRecsRequested = false; // allow one new call
  try { sessionStorage.removeItem(_homeAIRecsCacheKey); } catch(e) {}
  const el = document.getElementById('home-ai-recs');
  if (el) el.innerHTML = '<div class="home-ai-loading"><span class="home-ai-dot"></span><span class="home-ai-dot"></span><span class="home-ai-dot"></span> Analysing your sessions…</div>';
  const sessions = typeof sessionStoreList === 'function' ? sessionStoreList() : [];
  const token = _homeGetSessionsCacheToken(sessions);
  _homeCallAIRecs(sessions, token);
}

async function _homeCallAIRecs(sessions, token) {
  const key = typeof getKey === 'function' ? getKey() : '';

  // Build rich context per session
  const sessionSummaries = sessions.map(function(s) {
    // Find product profile for rich context
    const profile = (typeof productProfiles !== 'undefined' && productProfiles)
      ? productProfiles.find(function(p) { return p.productName === s.productName; })
      : null;
    const counts = s.counts || {};
    return {
      sessionId: s.id,
      productName: s.productName || 'Unknown',
      sessionName: s.name || '',
      companyName: s.companyName || '',
      productType: s.productType || '',
      industry: (profile && profile.industry) || '',
      productDesc: (profile && profile.productDesc) || '',
      icp: (profile && profile.icp) || '',
      approach: s.approach || '',
      currentStage: s.lastStage || 'Not started',
      caps: counts.caps || 0,
      features: counts.features || 0,
      stories: counts.stories || 0,
      sprintActive: counts.sprintActive || null,
      lastSaved: s.savedAt ? new Date(s.savedAt).toLocaleDateString() : ''
    };
  });

  // Check if multiple sessions share the same product name
  const productNameCounts = {};
  sessions.forEach(function(s) {
    productNameCounts[s.productName] = (productNameCounts[s.productName] || 0) + 1;
  });

  const _aiRecPrompt=(typeof buildAIRecommendationsPrompt==='function')?buildAIRecommendationsPrompt(sessionSummaries):{sys:'',usr:''};
  const sys=_aiRecPrompt.sys;
  const usr=_aiRecPrompt.usr;

  // v9.01: rerouted to the Render proxy — same backend and same PROXY_URL
  // convention already used by callAPI() in api.js, replacing the Netlify
  // Function path (/api/anthropic -> netlify/functions/anthropic-proxy.js)
  // this previously used. Root cause for the reroute: the Netlify Function
  // path was being blocked by HCL's corporate web security gateway
  // ("Suspicious" category, likely path/keyword-based on "anthropic" in the
  // URL) even though the exact same requests succeed via the Render path,
  // which has been allowlisted there for a long time. Confirmed via direct
  // testing: real AI generation (PI/CC/FC/SC/MI, all via callAPI()) already
  // works through this Render path on this same network.
  // Body shape is unchanged and already compatible — server.js's own
  // /api/anthropic route expects the same company_id-in-body,
  // X-Auth-Token, and Authorization: Bearer BYOK convention this function
  // already sends (confirmed by reading server.js's requireActiveCompanyMember
  // and main handler before making this change, not assumed).
  const LOCAL_PROXY = 'http://localhost:3001/api/anthropic';
  const host = window.location.hostname;
  const isLocal = host === '' || host === 'localhost' || host === '127.0.0.1';
  const hostedProxyUrl = (typeof PROXY_URL !== 'undefined' && PROXY_URL) ? PROXY_URL : 'https://product-diagnostics-proxy.onrender.com/api/anthropic';
  const proxyUrl = isLocal ? LOCAL_PROXY : hostedProxyUrl;

  // v9.13: use the decision-carrying resolver so this call site's usage
  // event gets the same real provenance (settingsMode/selectionRule) as
  // every callAPI()-routed call, instead of just a bare model string.
  const _aiRecsDecision=(typeof resolveModelDecision==='function')?resolveModelDecision(null,'ai-recommendations',null):{model:'claude-sonnet-4-6',settingsMode:'optimized',settingsModel:null,selectionRule:'optimized_caller_default'};
  const model = _aiRecsDecision.model;
  const _aiRecsClientCallId=(typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(36).slice(2));

  // Retrieve JWT token — proxy requires X-Auth-Token on hosted requests.
  // authGetFreshToken() guarantees a non-expired token (v8.33 fix).
  let _aiRecsToken = '';
  try {
    if (typeof authGetFreshToken === 'function') {
      _aiRecsToken = await authGetFreshToken();
    }
  } catch(e) {}

  const _rawByokKey = (typeof key === 'string') ? key.trim() : '';
  const _hasByokKey = _rawByokKey && _rawByokKey !== 'undefined' && _rawByokKey !== 'null';
  const _aiRecsHeaders = { 'Content-Type': 'application/json' };
  if (_hasByokKey) _aiRecsHeaders['Authorization'] = 'Bearer ' + _rawByokKey;
  if (_aiRecsToken) _aiRecsHeaders['X-Auth-Token'] = _aiRecsToken;

  fetch(proxyUrl, {
    method: 'POST',
    headers: _aiRecsHeaders,
    body: JSON.stringify({
      model: model, max_tokens: 600, system: sys, messages: [{ role: 'user', content: usr }],
      _caller: 'ai-recommendations',
      company_id: (function(){ try { return localStorage.getItem(_PGT_ACTIVE_COMPANY_KEY) || ''; } catch(e) { return ''; } })(),
      // v9.13: AI usage-tracking fields — this call site is a separate fetch
      // path from callAPI() (see the routing note above), so these fields
      // are added here explicitly rather than inherited from that function.
      product_id:(typeof activeProfileId!=='undefined')?activeProfileId:null,
      session_id:(typeof _activeSessionId!=='undefined')?_activeSessionId:null,
      client_call_id:_aiRecsClientCallId,
      settings_mode:_aiRecsDecision.settingsMode,
      settings_model:_aiRecsDecision.settingsModel,
      selection_rule:_aiRecsDecision.selectionRule,
      prompt_version:(typeof PROMPT_VERSIONS!=='undefined'&&PROMPT_VERSIONS['ai-recommendations'])?PROMPT_VERSIONS['ai-recommendations']:null
    })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) throw new Error((typeof _pgtAnthropicErrorMessage==='function')?_pgtAnthropicErrorMessage(data.error):(data.error.message||'Unknown error'));
    const raw = data.text || '[]';
    const clean = raw.replace(/```json|```/g, '').trim();
    const recs = JSON.parse(clean);
    // Cache result
    try {
      sessionStorage.setItem(_homeAIRecsCacheKey, JSON.stringify({ token: token, recs: recs }));
    } catch(e) {}
    _homeRenderAIRecs(recs, sessions);
  })
  .catch(function(err) {
    // Reset flag so the Refresh button can trigger a new attempt after any error
    _homeAIRecsRequested = false;
    const el = document.getElementById('home-ai-recs');
    if (el) el.innerHTML = '<div class="home-ai-empty">' + (err.message || 'Could not load recommendations. Try refreshing.') + '</div>';
    console.warn('AI recs error:', err.message);
  });
}

function _homeRenderAIRecs(recs, sessions) {
  const el = document.getElementById('home-ai-recs');
  if (!el) return;
  if (!recs || !recs.length) {
    el.innerHTML = '<div class="home-ai-empty">No recommendations available.</div>';
    return;
  }

  // Check for duplicate product names to decide tag format
  const productNameCounts = {};
  sessions.forEach(function(s) {
    productNameCounts[s.productName] = (productNameCounts[s.productName] || 0) + 1;
  });

  let html = '';
  recs.slice(0, 3).forEach(function(rec) {
    const dotClass = rec.priority === 'high' ? 'home-ai-dot-purple' : 'home-ai-dot-amber';
    const sessionId = rec.sessionId || '';
    const targetTab = rec.targetTab || 'mm';
    html +=
      '<div class="home-ai-rec" onclick="homeAIRecClick(\'' + sessionId + '\',\'' + targetTab + '\')" role="button" tabindex="0">'+
        '<div class="home-ai-rec-dot ' + dotClass + '"></div>'+
        '<div class="home-ai-rec-body">'+
          '<div class="home-ai-rec-text">' + e(rec.text) + '</div>'+
          '<div class="home-ai-rec-tag">' + e(rec.tag || '') + '</div>'+
        '</div>'+
        '<span class="home-ai-rec-arrow">→</span>'+
      '</div>';
  });
  el.innerHTML = html;
}

async function homeAIRecClick(sessionId, targetTab) {
  if (!sessionId) return;
  // v9.12.02 fix: previously a bare sessionStoreRestore(sessionId) call
  // followed by a fixed setTimeout(50ms) before switchTab — found via
  // adversarial review to be unreliable now that sessionStoreRestore() can
  // include a real network round-trip for the occupancy claim (v9.12), on
  // top of the pre-existing pre-fetch round-trip — both can easily exceed
  // 50ms, and if the timer fires before restore finishes, switchTab would
  // run against a session that hasn't finished loading, or against a
  // DIFFERENT session if the user clicked elsewhere in the interim.
  // Awaiting the restore directly removes the guesswork; the extra
  // _activeSessionId check guards against exactly that "user switched to a
  // different session while this one was still restoring" case — if a
  // newer restore has already taken over, this stale continuation must not
  // force a tab switch on someone else's now-active session.
  if (typeof sessionStoreRestore === 'function') {
    await sessionStoreRestore(sessionId);
    if (_activeSessionId === sessionId && typeof switchTab === 'function') {
      switchTab(targetTab);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION DOCUMENTS — Home panel (v8.58)
// ═══════════════════════════════════════════════════════════════════════════

// ── Render the conditional box (session docs OR cap list) ──
function homeRenderSdocsSection(){
  var box=document.getElementById('home-sdocs-box');
  if(!box)return;
  // v9.09.01 — Read Only guard, checked HERE because this function rebuilds
  // #home-sdocs-box's entire innerHTML from scratch at ~7 call sites
  // throughout this file — a disabled attribute set anywhere else gets
  // wiped out the next time this runs. This is the actual source of truth
  // for what's in the DOM, so the guard belongs here, not in a one-time
  // querySelector patch applied elsewhere (the bug that shipped in v9.09).
  var _isReadOnly=(typeof currentUserRole!=='undefined')&&currentUserRole==='readonly';
  var isCapManual=(_homeApproach==='capability-based'&&_homeMode==='manual');
  if(isCapManual){
    // Cap+manual mode — render capability list upload + compact session docs row if any
    var capManualHtml='<div class="home-cond-label-row">'
      +'<div class="home-cond-label"><i class="ti ti-list" style="font-size:10px;" aria-hidden="true"></i> Your Capability List <span class="home-req">*</span></div>'
      +'<a href="assets/templates/capability-list-template.xlsx" class="home-template-link" onclick="event.stopPropagation()"><i class="ti ti-download" style="font-size:10px;" aria-hidden="true"></i> Template</a>'
      +'</div>'
      +'<div class="home-upload-row" id="home-upload-row" '+(_isReadOnly?'style="opacity:0.5;pointer-events:none;"':'onclick="document.getElementById(\'home-file-input\').click()"')+'>'
      +'<i class="ti ti-upload" style="font-size:12px;color:var(--purple);flex-shrink:0;" aria-hidden="true"></i>'
      +'<span class="home-upload-row-label">Click to upload</span>'
      +'<span class="home-upload-row-types">.xlsx &middot; .csv</span>'
      +'</div>'
      +'<input type="file" id="home-file-input" accept=".xlsx,.csv" style="display:none;" onchange="homeHandleFileUpload(this)">'
      +'<div id="home-cap-parse-result"></div>'
      +'<div class="home-cond-error" id="home-cond-error"></div>'
      +'<div class="home-tog-row" id="home-ai-suggest-row" style="padding-bottom:0;">'
      +'<div class="home-tog-lhs"><div class="home-tog-label"><i class="ti ti-sparkles" style="font-size:10px;" aria-hidden="true"></i> Let AI add missing capabilities</div></div>'
      +'<label class="sp-toggle" style="flex-shrink:0;"><input type="checkbox" id="home-ai-suggest-toggle"><div class="sp-track"></div><div class="sp-thumb"></div></label>'
      +'</div>';
    // Session docs section — always shown in cap+manual (Optional)
    capManualHtml+='<div style="margin-top:6px;border-top:1px solid var(--purple-light);padding-top:8px;">'
      +'<div class="home-cond-label-row" style="margin-bottom:6px;">'
      +'<div class="home-cond-label"><i class="ti ti-files" style="font-size:10px;" aria-hidden="true"></i> Session Documents</div>'
      +'<div style="display:flex;align-items:center;gap:4px;">'
      +'<span style="font-size:9px;'+(_homeSessionDocs.length>=HOME_SESSION_DOCS_MAX?'color:var(--amber);background:var(--amber-light);border:0.5px solid var(--amber);border-radius:3px;padding:1px 5px;':'color:var(--purple-light);')+'">Max 5 files</span>'
      +'<span style="width:1px;height:10px;background:var(--divider);margin:0 2px;display:inline-block;"></span>'
      +'<span style="font-size:9px;color:var(--purple-light);">Optional</span>'
      +'</div>'
      +'</div>'
      +'<div class="home-upload-row" '+(_isReadOnly?'style="opacity:0.5;pointer-events:none;"':'onclick="document.getElementById(\'home-sdocs-file-input\').click()"')+'>'
      +'<i class="ti ti-upload" style="font-size:12px;color:var(--purple);flex-shrink:0;" aria-hidden="true"></i>'
      +'<span class="home-upload-row-label">Click to upload</span>'
      +'<span class="home-upload-row-types">docx, pdf, txt, xlsx, csv</span>'
      +'</div>'
      +'<input type="file" id="home-sdocs-file-input" accept=".docx,.pdf,.txt,.xlsx,.csv" multiple style="display:none;" onchange="homeHandleSdocsUpload(this)">'
      +'<div id="home-sdocs-chips"></div>'
      +'</div>';
    box.innerHTML=capManualHtml;
    // Restore parse result if cap list was already loaded
    if(_homeManualList.length>0)_homeRenderParseResult();
    homeRenderSdocsChips();
    _homeUpdateLaunchBtn();
  } else {
    // All other modes — Session Documents section
    var docsHtml='<div class="home-cond-label-row">'
      +'<div class="home-cond-label"><i class="ti ti-files" style="font-size:10px;" aria-hidden="true"></i> Session Documents</div>'
      +'<div style="display:flex;align-items:center;gap:4px;">'
      +'<span style="font-size:9px;'+(_homeSessionDocs.length>=HOME_SESSION_DOCS_MAX?'color:var(--amber);background:var(--amber-light);border:0.5px solid var(--amber);border-radius:3px;padding:1px 5px;':'color:var(--purple-light);')+'">Max 5 files</span>'
      +'<span style="width:1px;height:10px;background:var(--divider);margin:0 2px;display:inline-block;"></span>'
      +'<span style="font-size:9px;color:var(--purple-light);">Optional</span>'
      +'</div>'
      +'</div>'
      +'<div class="home-upload-row" '+(_isReadOnly?'style="opacity:0.5;pointer-events:none;"':'onclick="document.getElementById(\'home-sdocs-file-input\').click()"')+'>'
      +'<i class="ti ti-upload" style="font-size:12px;color:var(--purple);flex-shrink:0;" aria-hidden="true"></i>'
      +'<span class="home-upload-row-label">Click to upload</span>'
      +'<span class="home-upload-row-types">docx, pdf, txt, xlsx, csv</span>'
      +'</div>'
      +'<input type="file" id="home-sdocs-file-input" accept=".docx,.pdf,.txt,.xlsx,.csv" multiple style="display:none;" onchange="homeHandleSdocsUpload(this)">'
      +'<div id="home-sdocs-chips"></div>';
    box.innerHTML=docsHtml;
    homeRenderSdocsChips();
    _homeUpdateLaunchBtn();
  }
}

// ── Handle session doc uploads ──
function homeHandleSdocsUpload(inputEl){
  // v9.09.01 — same defense-in-depth guard as homeHandleFileUpload().
  if(typeof currentUserRole!=='undefined'&&currentUserRole==='readonly')return;
  var files=Array.from(inputEl.files||[]);
  if(!files.length)return;
  var remaining=Math.max(0,HOME_SESSION_DOCS_MAX-_homeSessionDocs.length);
  if(files.length>remaining){
    if(typeof showToast==='function')showToast(
      remaining===0?'Maximum '+HOME_SESSION_DOCS_MAX+' session documents reached.':'Only '+remaining+' slot'+(remaining!==1?'s':'')+' remaining.',
      'warn'
    );
  }
  files.slice(0,remaining).forEach(function(file){
    var docId=(typeof _makeDocId==='function')?_makeDocId():('doc_'+Date.now()+'_'+Math.random().toString(36).slice(2,6));
    var pendingDoc={
      id:docId,name:file.name,scope:'product',sessionScoped:true,
      docType:'other',wordCount:0,extractedText:'',aiSummary:'',
      keyDecisions:[],constraints:[],openQuestions:[],metrics:[],
      summaryStatus:'pending',uploadedAt:Date.now()
    };
    _homeSessionDocs.push(pendingDoc);
    homeRenderSdocsChips();
    _homeUpdateLaunchBtn();

    // Safety timeout — if doc still pending after 45s, flip to failed and unblock launch.
    // Guards sessionActive: do not mutate post-launch state.
    // Calls _homeFinalizeSdocAsync(null) — timer already consumed, no clear needed.
    var safetyTimer=setTimeout(function(){
      if(sessionActive)return;
      var stuck=_homeSessionDocs.find(function(d){return d.id===docId;});
      if(!stuck||stuck.summaryStatus!=='pending')return;
      stuck.summaryStatus='failed';
      stuck.extractedText=stuck.extractedText||'';
      _homeFinalizeSdocAsync(null);
    },45000);

    // Async extraction + summarisation — all callbacks resolve by ID
    var extractFn=typeof extractTextFromFile==='function'?extractTextFromFile:function(){return Promise.reject(new Error('extractTextFromFile not available'));};
    extractFn(file)
      .then(function(text){
        var live=_homeSessionDocs.find(function(d){return d.id===docId;});
        if(!live){_homeUpdateLaunchBtn();return;}
        live.extractedText=text||'';
        live.wordCount=(text||'').trim().split(/\s+/).filter(Boolean).length;
        var summariseFn=typeof summariseDocument==='function'?summariseDocument:function(){return Promise.reject(new Error('summariseDocument not available'));};
        return summariseFn(text,file.name).then(function(result){
          var live2=_homeSessionDocs.find(function(d){return d.id===docId;});
          if(!live2){_homeUpdateLaunchBtn();return;}
          live2.aiSummary=result.aiSummary||'';
          live2.docType=result.docType||'other';
          live2.keyDecisions=Array.isArray(result.keyDecisions)?result.keyDecisions:[];
          live2.constraints=Array.isArray(result.constraints)?result.constraints:[];
          live2.openQuestions=Array.isArray(result.openQuestions)?result.openQuestions:[];
          live2.metrics=Array.isArray(result.metrics)?result.metrics:[];
          live2.summaryStatus='ready';
          _homeFinalizeSdocAsync(safetyTimer);
        }).catch(function(){
          var live3=_homeSessionDocs.find(function(d){return d.id===docId;});
          if(!live3){_homeUpdateLaunchBtn();return;}
          // Summarisation failed — use raw text at generation
          live3.summaryStatus='failed';
          live3.docType='other';
          _homeFinalizeSdocAsync(safetyTimer);
        });
      })
      .catch(function(err){
        var live=_homeSessionDocs.find(function(d){return d.id===docId;});
        if(!live){_homeUpdateLaunchBtn();return;}
        live.summaryStatus='failed';
        live.extractedText='';
        var msg=(err&&err.message==='PASSWORD_PROTECTED')
          ?file.name+' is password-protected \u2014 remove the password and re-upload.'
          :file.name+': Could not read file.';
        if(typeof showToast==='function')showToast(msg,'error');
        _homeFinalizeSdocAsync(safetyTimer);
      });
  });
  inputEl.value='';
}

// ── Render session doc chips ──
// data-doc-id pattern — no index interpolation into JS onclick strings
function homeRenderSdocsChips(){
  var host=document.getElementById('home-sdocs-chips');
  if(!host){_homeUpdateLaunchBtn();return;}
  if(!_homeSessionDocs.length){host.innerHTML='';_homeUpdateLaunchBtn();return;}
  var html='';
  var dtLabels={prd:'PRD',rfp:'RFP',research:'Research',feedback:'VoC',roadmap:'Roadmap',strategy:'Strategy',backlog:'Backlog',other:'Other'};
  _homeSessionDocs.forEach(function(doc){
    var safeName=typeof e==='function'?e(doc.name):doc.name;
    var safeId=typeof e==='function'?e(doc.id||''):doc.id||'';

    // Invalid ID — show read-only chip, no controls
    if(!(typeof _isSafeDocId==='function'?_isSafeDocId(doc.id):true)){
      html+='<div class="home-sdoc-chip">'
        +'<span class="home-sdoc-name pgt-tooltip" data-tooltip="'+safeName+'"><span class="home-sdoc-name-inner">'+safeName+'</span></span>'
        +'</div>';
      return;
    }

    if(doc.summaryStatus==='pending'){
      // Processing chip
      html+='<div class="home-sdoc-chip home-sdoc-chip-pending">'
        +'<span class="cc-spin-sm" style="flex-shrink:0;"></span>'
        +'<span class="home-sdoc-name pgt-tooltip" data-tooltip="'+safeName+'"><span class="home-sdoc-name-inner">'+safeName+'</span></span>'
        +'<span class="home-sdoc-status-txt">Analysing…</span>'
        +((!sessionActive)?'<button class="home-sdoc-rm" data-doc-id="'+safeId+'" onclick="_homeRemoveSdoc(this.dataset.docId)" aria-label="Remove document"><i class="ti ti-x" aria-hidden="true"></i></button>':'')
        +'</div>';

    } else if(doc.summaryStatus==='failed'&&!doc.extractedText){
      // Hard failure chip
      html+='<div class="home-sdoc-chip home-sdoc-chip-error">'
        +'<span class="home-sdoc-name pgt-tooltip" data-tooltip="'+safeName+'"><span class="home-sdoc-name-inner">'+safeName+'</span></span>'
        +'<span class="home-sdoc-status-txt home-sdoc-err-txt"><i class="ti ti-alert-circle" style="font-size:9px;" aria-hidden="true"></i> Unreadable</span>'
        +((!sessionActive)?'<button class="home-sdoc-rm" data-doc-id="'+safeId+'" onclick="_homeRemoveSdoc(this.dataset.docId)" aria-label="Remove document"><i class="ti ti-x" aria-hidden="true"></i></button>':'')
        +'</div>';

    } else {
      // Ready (or failed-with-raw-text) chip
      var dt=doc.docType||'other';
      var dtLabel=dtLabels[dt]||'Other';
      if(!sessionActive){
        // Pre-launch: filename primary, single-click select for docType, remove button
        html+='<div class="home-sdoc-chip">'
          +'<span class="home-sdoc-name pgt-tooltip" data-tooltip="'+safeName+'"><span class="home-sdoc-name-inner">'+safeName+'</span></span>'
          +'<select class="home-sdoc-type-sel home-sdoc-type-sel-'+dt+'" data-doc-id="'+safeId+'" onchange="_homeSdocTypeChange(this,this.dataset.docId)" title="Change document type">'
          +'<option value="backlog"'+(dt==='backlog'?' selected':'')+'>Backlog</option>'
          +'<option value="feedback"'+(dt==='feedback'?' selected':'')+'>VoC</option>'
          +'<option value="prd"'+(dt==='prd'?' selected':'')+'>PRD</option>'
          +'<option value="rfp"'+(dt==='rfp'?' selected':'')+'>RFP</option>'
          +'<option value="research"'+(dt==='research'?' selected':'')+'>Research</option>'
          +'<option value="roadmap"'+(dt==='roadmap'?' selected':'')+'>Roadmap</option>'
          +'<option value="strategy"'+(dt==='strategy'?' selected':'')+'>Strategy</option>'
          +'<option value="other"'+(dt==='other'?' selected':'')+'>Other</option>'
          +'</select>'
          +'<button class="home-sdoc-rm" data-doc-id="'+safeId+'" onclick="_homeRemoveSdoc(this.dataset.docId)" aria-label="Remove document"><i class="ti ti-x" aria-hidden="true"></i></button>'
          +'</div>';
      } else {
        // Post-launch: read-only — filename + static docType label, no controls
        html+='<div class="home-sdoc-chip">'
          +'<span class="home-sdoc-name pgt-tooltip" data-tooltip="'+safeName+'"><span class="home-sdoc-name-inner">'+safeName+'</span></span>'
          +'<span class="home-sdoc-type-static home-sdoc-type-static-'+dt+'">'+dtLabel+'</span>'
          +'</div>';
      }
    }
  });
  host.innerHTML=html;
}

// ── _homeToggleSdocType — retired v8.59 (select always visible, no toggle needed) ──
function _homeToggleSdocType(){}

// ── Handle docType change ──
function _homeSdocTypeChange(selectEl,docId){
  var doc=_homeSessionDocs.find(function(d){return d.id===docId;});
  if(doc)doc.docType=selectEl.value;
  homeRenderSdocsChips();
}

// ── Remove session doc by ID — with undo toast ──
function _homeRemoveSdoc(docId){
  // Snapshot the removed doc for undo
  var removedDoc=_homeSessionDocs.find(function(d){return d.id===docId;});
  var removedIdx=_homeSessionDocs.findIndex(function(d){return d.id===docId;});
  if(!removedDoc)return;

  _homeSessionDocs=_homeSessionDocs.filter(function(d){return d.id!==docId;});
  homeRenderSdocsSection();
  _homeUpdateLaunchBtn();

  // Undo toast — shows for 4s; clicking Undo re-inserts at original position
  if(typeof showToast==='function'){
    var shortName=removedDoc.name.length>28?removedDoc.name.slice(0,25)+'…':removedDoc.name;
    var _undoAction="_homeUndoRemoveSdoc('"+docId+"')";
    showToast(e(shortName)+' removed.','info','Undo',_undoAction);
  }
  // Store undo snapshot on a short-lived window property
  window._homeLastRemovedDoc={doc:removedDoc,idx:removedIdx};
  // Clear undo after 4s (matches toast auto-dismiss)
  clearTimeout(window._homeUndoTimer);
  window._homeUndoTimer=setTimeout(function(){window._homeLastRemovedDoc=null;},4500);
}

// ── Undo last session doc removal ──
function _homeUndoRemoveSdoc(docId){
  var snapshot=window._homeLastRemovedDoc;
  if(!snapshot||snapshot.doc.id!==docId)return;
  // Re-insert at original position if still valid, else append
  var idx=Math.min(snapshot.idx,_homeSessionDocs.length);
  _homeSessionDocs.splice(idx,0,snapshot.doc);
  window._homeLastRemovedDoc=null;
  clearTimeout(window._homeUndoTimer);
  homeRenderSdocsSection();
  _homeUpdateLaunchBtn();
}

// ── Silent retry for failed summaries ──
function _homeRetrySdocSummaries(){
  _homeSessionDocs.forEach(function(doc){
    if(doc.summaryStatus!=='failed'||!doc.extractedText)return;
    var docId=doc.id;
    var fileName=doc.name;
    var text=doc.extractedText;
    var summariseFn=typeof summariseDocument==='function'?summariseDocument:null;
    if(!summariseFn)return;
    summariseFn(text,fileName).then(function(result){
      // Update in-memory
      var live=_homeSessionDocs.find(function(d){return d.id===docId;});
      if(!live){_homeUpdateLaunchBtn();return;}
      live.aiSummary=result.aiSummary||'';
      live.docType=result.docType||'other';
      live.keyDecisions=Array.isArray(result.keyDecisions)?result.keyDecisions:[];
      live.constraints=Array.isArray(result.constraints)?result.constraints:[];
      live.openQuestions=Array.isArray(result.openQuestions)?result.openQuestions:[];
      live.metrics=Array.isArray(result.metrics)?result.metrics:[];
      live.summaryStatus='ready';
      // Also update frozen sessionContext snapshot if session active
      if(typeof sessionContext!=='undefined'&&sessionContext&&sessionContext.sessionDocs){
        var scDoc=sessionContext.sessionDocs.find(function(d){return d.id===docId;});
        if(scDoc){
          scDoc.aiSummary=live.aiSummary;scDoc.docType=live.docType;
          scDoc.keyDecisions=live.keyDecisions;scDoc.constraints=live.constraints;
          scDoc.openQuestions=live.openQuestions;scDoc.metrics=live.metrics||[];
          scDoc.summaryStatus='ready';
        }
      }
      // Persist updated session
      if(typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
        sessionStoreSave(_activeSessionId);
      }
      _homeSyncSdocUi();
    }).catch(function(){/* silent — will retry next entry */
      _homeUpdateLaunchBtn();
    });
  });
}

// ── Session doc UI sync helpers ──
// _homeSyncSdocUi: re-renders chips and recalculates launch gate.
// Use for any path that mutates summaryStatus or visible doc fields.
function _homeSyncSdocUi(){
  homeRenderSdocsChips();
  _homeUpdateLaunchBtn();
}
// _homeFinalizeSdocAsync: clears the per-doc safety timer then syncs UI.
// Use in all terminal async paths inside homeHandleSdocsUpload.
// Pass null when called from the safety timer itself (timer already consumed).
function _homeFinalizeSdocAsync(timer){
  if(timer)clearTimeout(timer);
  _homeSyncSdocUi();
}

// ── Toggle additional context textarea ──
function _homeToggleCtx(){
  _homeCtxExpanded=!_homeCtxExpanded;
  var ctxWrap=document.getElementById('home-ctx-wrap');
  var ctxToggle=document.getElementById('home-ctx-toggle');
  if(ctxWrap){ctxWrap.style.display=_homeCtxExpanded?'':'none';}
  if(ctxToggle){ctxToggle.textContent=_homeCtxExpanded?'\u2212 Hide':'+ Add notes';}
  // Wire counter now that textarea exists
  if(_homeCtxExpanded){_homeWireCounters();}
}

// ── Reset session setup form fields ──
// Called when navigating back to Home from a workflow tab (sessionActive→false path)
// and when switching product while a session is active.
// Resets all form fields to their default state so stale session config
// does not persist into a new session setup.
// IMPORTANT: homeClearSession() must NOT be modified — it is called immediately
// before _homeDoLaunch() reads these same DOM fields to populate sessionContext.
function _homeResetSetupForm(){
  // 1. Clear Custom Value Chain
  var vcEl=document.getElementById('home-custom-vc');
  if(vcEl) vcEl.value='';

  // 2. Clear Additional Context textarea
  var ctxEl=document.getElementById('home-additional-context');
  if(ctxEl) ctxEl.value='';

  // 3. Collapse Additional Context wrap and reset toggle label + counter
  //    (homeClearSession sets _homeCtxExpanded=false in memory but does not sync DOM)
  var ctxWrap=document.getElementById('home-ctx-wrap');
  var ctxToggle=document.getElementById('home-ctx-toggle');
  var ctxCount=document.getElementById('home-ctx-counter');
  if(ctxWrap) ctxWrap.style.display='none';
  if(ctxToggle) ctxToggle.textContent='+ Add notes';
  if(ctxCount){ ctxCount.textContent='0/2000'; ctxCount.className='home-ctx-counter'; }
  _homeCtxExpanded=false;

  // 4. Uncheck Market Intelligence toggle
  var miEl=document.getElementById('home-mi-toggle');
  if(miEl) miEl.checked=false;

  // 5. Uncheck AI Suggestions toggle — must happen BEFORE homeSetApproach() because
  //    homeSetApproach calls homeRenderSdocsSection() which removes this element from DOM
  var aiSuggestEl=document.getElementById('home-ai-suggest-toggle');
  if(aiSuggestEl) aiSuggestEl.checked=false;

  // 6. Clear manual capability list state — must happen BEFORE homeSetApproach() so
  //    homeRenderSdocsSection() sees an empty list and renders clean upload state
  _homeManualList=[];
  _homeUploadedFileName='';

  // 7. Reset Approach and Mode pills to defaults
  //    homeSetApproach also calls homeRenderSdocsSection() to rebuild the cond-box
  homeSetApproach('outcome-based');
}

