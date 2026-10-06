// ══════════════════════════════════════════════════════════════════════
// ADOPTION READINESS — readiness-canvas.js (v9.22)
//
// In-app flow letting a PM prepare a completed Release Plan for launch.
// A real top-nav tab (id 'arp', immediately after Release Canvas) — its
// content container is #rc-canvas / .arp-tab, toggled via the exact same
// .on-class convention every other tab uses (see switchTab() in api.js).
// It is still only ever CREATED from Release Canvas's kebab menu
// (pi-planning.js's piPlanMenuHtml() -> piOpenReadinessPlan()) — only
// VIEWING moved from a full-frame drawer overlay into this tab.
//
// All functions in this file are prefixed `rc` ('ra' is taken by
// Requirement Agent). State lives in two flat globals declared in
// state.js: piReadinessPlans[] (persisted) and rcActivePlanId/
// rcActiveSection (transient, not persisted).
// ══════════════════════════════════════════════════════════════════════

const OUTCOME_HYP_UNITS_RC=['percent','count','currency','ratio','days','custom'];

// ── Object model / lookups ──────────────────────────────────────────────

function rcFindPlan(releasePlanId){
  return (piReadinessPlans||[]).find(p=>p.releasePlanId===releasePlanId)||null;
}

function rcGetActivePlan(){
  return (piReadinessPlans||[]).find(p=>p.id===rcActivePlanId)||null;
}

function rcMakeId(){
  return 'rp-'+((typeof crypto!=='undefined'&&crypto.randomUUID)?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(36).slice(2)));
}

// Sprint-planning completeness check — reused by both the kebab menu's
// enable/disable state and the §2.3 completion-modal trigger. A plan is
// "complete" when every story it claimed has a live sprint assignment
// (nothing sitting in this plan's own backlogNotes/uncovered set).
function piPlanSprintComplete(plan){
  if(!plan||!Array.isArray(plan.submittedStoryIds)||plan.submittedStoryIds.length===0)return false;
  return plan.submittedStoryIds.every(id=>!!(plan.storyAssignments&&plan.storyAssignments[id]));
}

// ── Lineage construction (§1.6) — built once at creation time, not a live
// query. Resolves each story in the release plan's scope back through its
// owning feature to stage/capability/hypothesis, grouped by Requirement
// Brief (intakeBriefId). Features with no brief are grouped under a
// synthetic per-capability entry so lineage is never dropped just because
// a feature didn't originate through Requirement Agent (spec §1.5). ──
function rcComputeLineage(releasePlan){
  const storyIds=Object.keys(releasePlan.storyAssignments||{});
  const byKey={};
  (typeof scCanvas!=='undefined'?scCanvas:[]).forEach(f=>{
    if(!f.stories)return;
    const ownedIds=f.stories.filter(s=>storyIds.indexOf(s.id)!==-1).map(s=>s.id);
    if(ownedIds.length===0)return;
    const key=f.intakeBriefId?('brief:'+f.intakeBriefId):('feat:'+f.id);
    if(!byKey[key]){
      let requirementName=f.name;
      if(f.intakeBriefId&&typeof raConversations!=='undefined'){
        const conv=raConversations.find(c=>c.id===f.intakeBriefId);
        if(conv)requirementName=(f.rqNumber?f.rqNumber+' - ':'')+conv.title;
      }
      byKey[key]={
        requirementId:f.intakeBriefId||f.id,
        requirementName:requirementName,
        stage:f.stage||'',
        capability:f.cap||'',
        feature:f.name||'',
        hypothesis:f.outcomeHypothesis&&f.outcomeHypothesis.primary?{
          metric:f.outcomeHypothesis.primary.metric||'',
          baseline:f.outcomeHypothesis.primary.baseline,
          target:f.outcomeHypothesis.primary.target,
          unit:f.outcomeHypothesis.primary.unit||''
        }:{metric:'',baseline:null,target:null,unit:''},
        storyIds:[]
      };
    }
    ownedIds.forEach(id=>{if(byKey[key].storyIds.indexOf(id)===-1)byKey[key].storyIds.push(id);});
  });
  return Object.values(byKey);
}

// ── "What's Shipping" sentence — factored out of rcComputeReleaseScope so
// it can also be used to self-heal plans created before this generation
// logic existed (their stored releaseScope.whatsShipping is a stale empty
// string baked in at creation time; see rcEnsureWhatsShipping below). ──
function rcComputeWhatsShipping(piPlan){
  const storyIds=Object.keys((piPlan&&piPlan.storyAssignments)||{});
  const featureNames=[];
  (typeof scCanvas!=='undefined'?scCanvas:[]).forEach(f=>{
    if(!f.stories)return;
    if(f.stories.some(st=>storyIds.indexOf(st.id)!==-1))featureNames.push(f.name);
  });
  const uniqueFeatureNames=Array.from(new Set(featureNames));
  return uniqueFeatureNames.length
    ?('This release ships '+(uniqueFeatureNames.length===1?uniqueFeatureNames[0]:uniqueFeatureNames.slice(0,-1).join(', ')+' and '+uniqueFeatureNames[uniqueFeatureNames.length-1])+'.')
    :'This release has no features in scope yet.';
}
// Regenerates releaseScope.whatsShipping on the fly if it's falsy/empty
// (stale data from a plan created before rcComputeWhatsShipping existed),
// persisting the self-heal so it doesn't need to be recomputed every
// render. Called from every render/export path that reads whatsShipping.
function rcEnsureWhatsShipping(plan){
  if(!plan||!plan.releaseScope||plan.releaseScope.whatsShipping)return;
  const piPlan=(typeof piPlans!=='undefined'?piPlans:[]).find(p=>p.id===plan.releasePlanId);
  if(!piPlan)return;
  plan.releaseScope.whatsShipping=rcComputeWhatsShipping(piPlan);
  rcPersist();
}

// ── Release Scope (§1.1 section 2) — read-only fields pulled straight
// from the Release Plan. ──
function rcComputeReleaseScope(piPlan,existingRolloutType,existingOther){
  const storyIds=Object.keys(piPlan.storyAssignments||{});
  const featureIds=new Set();
  let storyPoints=0;
  (typeof scCanvas!=='undefined'?scCanvas:[]).forEach(f=>{
    if(!f.stories)return;
    f.stories.forEach(st=>{
      if(storyIds.indexOf(st.id)===-1)return;
      featureIds.add(f.id);
      const asgn=piPlan.storyAssignments[st.id];
      storyPoints+=(asgn&&asgn.points)?asgn.points:(st.points||3);
    });
  });
  const sprintDates=(piPlan.sprints&&piPlan.sprints.length)
    ?(piPlan.sprints[0].dateRange.split(' - ')[0].split(' – ')[0]+' to '+piPlan.sprints[piPlan.sprints.length-1].dateRange.split(' – ').pop())
    :'';
  return{
    whatsShipping:rcComputeWhatsShipping(piPlan),
    squad:(piPlan.squads||[]).map(s=>s.name).join(', '),
    sprintDates,
    storyCount:storyIds.length,
    featureCount:featureIds.size,
    storyPoints,
    rolloutType:existingRolloutType||'Phased',
    rolloutTypeOther:existingOther||''
  };
}

// ── Change Overview (§1.5) — synthesized from each touched feature's
// Outcome Hypothesis + capability rationale. Note: this build implements
// the synthesis deterministically (string composition across touched
// features/capabilities) rather than a live AI call — a judgment call
// made to keep this build's scope to the data model + screen flow + the
// explicitly-named integration points, without introducing a whole new
// prompt/loader subsystem. Every field remains hover-to-edit exactly as
// the AI-generated version would be, so a PM can freely rewrite it. ──
const RC_METRIC_STOPWORDS=new Set(['the','a','on','at','to','rate','of']);
function rcNormalizeMetricWords(name){
  const cleaned=(name||'').toLowerCase().replace(/[^\w\s]/g,' ').replace(/\s+/g,' ').trim();
  return new Set(cleaned.split(' ').filter(w=>w&&!RC_METRIC_STOPWORDS.has(w)));
}
function rcMetricsAreDuplicate(wordsA,wordsB){
  if(wordsA.size===0||wordsB.size===0)return false;
  let overlap=0;
  wordsA.forEach(w=>{if(wordsB.has(w))overlap++;});
  const jaccard=overlap/new Set([...wordsA,...wordsB]).size;
  const isSubset=overlap===wordsA.size||overlap===wordsB.size;
  return jaccard>=0.7||isSubset;
}
function rcDraftChangeOverview(piPlan,lineage){
  const featureNames=[];
  const whys=[];
  const metricsByName={};
  const seenMetricWordSets=[];
  (typeof scCanvas!=='undefined'?scCanvas:[]).forEach(f=>{
    const storyIds=Object.keys(piPlan.storyAssignments||{});
    if(!f.stories||!f.stories.some(s=>storyIds.indexOf(s.id)!==-1))return;
    featureNames.push(f.name);
    if(f.why)whys.push(f.why);
    if(f.outcomeHypothesis&&f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.metric){
      const p=f.outcomeHypothesis.primary;
      const words=rcNormalizeMetricWords(p.metric);
      const isDup=metricsByName[p.metric]||seenMetricWordSets.some(w=>rcMetricsAreDuplicate(w,words));
      if(!isDup){
        seenMetricWordSets.push(words);
        metricsByName[p.metric]={metricName:p.metric,baseline:(p.baseline!==null&&p.baseline!==undefined)?String(p.baseline):'',target:(p.target!==null&&p.target!==undefined)?String(p.target):''};
      }
    }
  });
  const uniqueFeatures=Array.from(new Set(featureNames));
  const whatsChanging=uniqueFeatures.length
    ?('This release ships '+(uniqueFeatures.length===1?uniqueFeatures[0]:uniqueFeatures.slice(0,-1).join(', ')+' and '+uniqueFeatures[uniqueFeatures.length-1])+', delivered across '+(piPlan.sprintCount||0)+' sprint'+(piPlan.sprintCount===1?'':'s')+'.')
    :'This release has no features in scope yet.';
  const whyNeeded=whys.length
    ?('This work matters because '+whys.slice(0,3).join(' ').replace(/\s+/g,' ').trim()+(whys.length>3?' It also supports additional related improvements in scope for this release.':''))
    :'The rationale for this release will be added once feature rationale is available.';
  const metrics=Object.values(metricsByName).map(m=>Object.assign({id:'m-'+Math.random().toString(36).slice(2)},m));
  return{whatsChanging,whyNeeded,metrics};
}

function rcTitleCase(s){
  // Preserve words that are already all-uppercase (acronyms like QA, PM) —
  // only title-case words that aren't.
  return String(s||'').split(' ').map(w=>(w&&!(w.length>1&&w===w.toUpperCase()))?w.charAt(0).toUpperCase()+w.slice(1).toLowerCase():w).join(' ');
}
// ── Impact Groups (§1.4) — deterministic actor-language extraction from
// story acceptance criteria. Confidence rule enforced in code, not just
// UI copy: a candidate group is only drafted when at least 2 distinct
// stories reference the same actor phrase, so a single isolated mention
// never becomes a "hallucinated common pattern" group per spec §1.4. ──
function rcDraftImpactGroups(piPlan,releaseScope){
  const storyIds=Object.keys(piPlan.storyAssignments||{});
  const actorHits={}; // actorLabel -> {count, stories:[{given[],then[]}]}
  const ACTOR_RE=/\bAs an?\s+([A-Za-z][A-Za-z /-]{2,30}?)\s*[,\.]/gi;
  (typeof scCanvas!=='undefined'?scCanvas:[]).forEach(f=>{
    if(!f.stories)return;
    f.stories.forEach(st=>{
      if(storyIds.indexOf(st.id)===-1)return;
      const text=st.statement||'';
      let m;
      ACTOR_RE.lastIndex=0;
      while((m=ACTOR_RE.exec(text))){
        const label=m[1].trim().replace(/\s+/g,' ');
        const norm=label.toLowerCase();
        if(!actorHits[norm])actorHits[norm]={label:rcTitleCase(label),count:0,givens:[],thens:[]};
        actorHits[norm].count++;
        (Array.isArray(st.scenarios)?st.scenarios:[]).forEach(sc=>{
          if(sc.given)actorHits[norm].givens.push(sc.given);
          if(sc.then)actorHits[norm].thens.push(sc.then);
        });
      }
    });
  });
  const candidates=Object.values(actorHits).filter(a=>a.count>=2).sort((a,b)=>b.count-a.count).slice(0,4);
  return candidates.map(a=>{
    const hasAC=a.givens.length>0||a.thens.length>0;
    const currentState=a.givens.length
      ?('Today, when '+a.label.toLowerCase()+' '+a.givens.slice(0,2).join('; and ')+'.')
      :('Today, the '+a.label.toLowerCase()+' experience does not yet reflect this release\'s changes (no acceptance criteria found for this actor - generic template).');
    const futureState=a.thens.length
      ?('After launch, '+a.label.toLowerCase()+' will see that '+a.thens.slice(0,2).join('; and ')+'.')
      :('After launch, the '+a.label.toLowerCase()+' will interact with the updated flow described in this release\'s stories (no acceptance criteria found for this actor - generic template).');
    const rolloutType=(releaseScope&&releaseScope.rolloutType)||'Phased';
    const requiredBehavior=hasAC
      ?('Before relying on the new flow, '+a.label.toLowerCase()+' should confirm the change against the above and adjust their usual steps to match, given this is a '+rolloutType.toLowerCase()+' rollout.')
      :('Before launch, '+a.label.toLowerCase()+' should be briefed on what is changing and confirm they understand the new expected flow, given this is a '+rolloutType.toLowerCase()+' rollout.');
    return{
      id:'ig-'+Math.random().toString(36).slice(2),
      name:a.label,
      currentState,
      futureState,
      requiredBehavior,
      status:'draft',
      origin:'ai'
    };
  });
}

// ── Launch Recommendation — deterministic gate (§1.8). Pure function,
// structurally the same "engine decides, AI narrates on top" split already
// used by PI Canvas's piEscalate/piDetectCycles — never the reverse. ──
const RC_FULL_ROLLOUT_GROUP_THRESHOLD=3;
function rcComputeRecommendation(plan){
  const groups=plan.impactGroups||[];
  const actions=plan.readinessActions||[];
  if(groups.length===0||groups.some(g=>g.status==='draft')){
    return{value:'Hold',reason:groups.length===0?'No impact groups have been reviewed yet.':'At least one impact group is still unreviewed.'};
  }
  const unreviewedActions=actions.filter(a=>!a.reviewed);
  const activeGroups=groups.filter(g=>g.status==='confirmed').length;
  const fullRolloutRisk=(plan.releaseScope&&plan.releaseScope.rolloutType==='Full')&&activeGroups>RC_FULL_ROLLOUT_GROUP_THRESHOLD;
  if(unreviewedActions.length>0||fullRolloutRisk){
    return{value:'Conditional',reason:unreviewedActions.length>0?(unreviewedActions.length+' readiness action'+(unreviewedActions.length===1?'':'s')+' still '+(unreviewedActions.length===1?'needs':'need')+' review.'):('This is a Full rollout touching '+activeGroups+' impact groups, above the review threshold.')};
  }
  return{value:'Ready',reason:'All impact groups have been reviewed and every readiness action is complete.'};
}

// ── Readiness Actions (§1.3) — generated only from confirmed groups, one
// action tied to that group's specific Required Behavior, never a generic
// ungrounded action. Deterministic templating, same judgment call as the
// Change Overview synthesis above (no live AI call in this build). ──
function rcGenerateActionsForGroup(group){
  // requiredBehavior is a complete sentence in its own right (subject +
  // verb), not a verb-phrase fragment — concatenating it into a template
  // expecting a continuation like "...so they [verb phrase]" produced a
  // grammatically fused run-on. Two sentences instead: state the action,
  // then reference the required behavior as its own sentence.
  const gap=group.requiredBehavior||('Adapt to the new '+group.name.toLowerCase()+' flow.');
  return [
    {id:'ra-'+Math.random().toString(36).slice(2),groupId:group.id,groupName:group.name,actionType:'Communication',description:'Notify '+group.name+' ahead of launch about this change. Required behavior: '+gap,reviewed:false},
    {id:'ra-'+Math.random().toString(36).slice(2),groupId:group.id,groupName:group.name,actionType:'Support-readiness',description:'Brief support/frontline staff on this change for '+group.name+' so questions are answerable on day one. Required behavior: '+gap,reviewed:false}
  ];
}
function rcRegenerateActionsFromConfirmedGroups(plan){
  const confirmedIds=(plan.impactGroups||[]).filter(g=>g.status==='confirmed').map(g=>g.id);
  // Keep actions belonging to still-confirmed groups untouched (preserves
  // reviewed edits); drop actions for groups no longer
  // confirmed; add actions for newly-confirmed groups that don't have any yet.
  plan.readinessActions=(plan.readinessActions||[]).filter(a=>confirmedIds.indexOf(a.groupId)!==-1);
  confirmedIds.forEach(gid=>{
    if(!plan.readinessActions.some(a=>a.groupId===gid)){
      const group=plan.impactGroups.find(g=>g.id===gid);
      if(group)plan.readinessActions=plan.readinessActions.concat(rcGenerateActionsForGroup(group));
    }
  });
}

// ── AI Enhancements (v9.23) ──────────────────────────────────────────────
// Every section above has a free, instant, deterministic draft (see
// comments on rcDraftChangeOverview/rcDraftImpactGroups/
// rcGenerateActionsForGroup/rcComputeRecommendation). These functions
// silently upgrade that draft with LLM reasoning at the natural moment
// each section's content is first produced — plan creation for Change
// Overview + Impact Groups, group confirmation for Readiness Actions, and
// first stable view for the Launch Recommendation narrative — rather than
// via a manual "regenerate" button. There is deliberately no button: the
// deterministic draft is never wrong, only less rich, so an AI call that
// fails or is offline just leaves it in place with no user-visible error.
// Free-form section navigation (jumping 1 -> 6) is unaffected — none of
// these calls depend on visit ORDER, only on data actually being present
// (a group must be confirmed before its actions enhance; the narrative
// reflects whatever is true right now, correct even if partially reviewed).
function rcGetSourcePiPlan(plan){
  if(!plan)return null;
  return (typeof piPlans!=='undefined'?piPlans:[]).find(p=>p.id===plan.releasePlanId)||null;
}
function rcBuildStoryContext(plan){
  const piPlan=rcGetSourcePiPlan(plan);
  if(!piPlan)return{features:[],sprintCount:0,rolloutType:'Phased'};
  const storyIds=Object.keys(piPlan.storyAssignments||{});
  const features=[];
  (typeof scCanvas!=='undefined'?scCanvas:[]).forEach(f=>{
    if(!f.stories)return;
    const inScope=f.stories.filter(s=>storyIds.indexOf(s.id)!==-1);
    if(!inScope.length)return;
    features.push({
      name:f.name,
      why:f.why||'',
      metric:(f.outcomeHypothesis&&f.outcomeHypothesis.primary&&f.outcomeHypothesis.primary.metric)?{
        metric:f.outcomeHypothesis.primary.metric,
        baseline:f.outcomeHypothesis.primary.baseline,
        target:f.outcomeHypothesis.primary.target
      }:null,
      stories:inScope.map(s=>({
        statement:s.statement||'',
        scenarios:(Array.isArray(s.scenarios)?s.scenarios:[]).map(sc=>({given:sc.given||'',when:sc.when||'',then:sc.then||''}))
      }))
    });
  });
  return{features,sprintCount:piPlan.sprintCount||0,rolloutType:(plan.releaseScope&&plan.releaseScope.rolloutType)||'Phased'};
}
function rcParseAiJson(txt){
  return JSON.parse((txt||'').replace(/```json|```/g,'').trim());
}
// Loader-then-reveal (live PM feedback fix) — full-section replacement
// shown WHILE an _aiEnhance*Pending flag is true, instead of the previous
// pattern of showing the deterministic draft immediately and silently
// swapping it for the AI result a few seconds later. Purple-pale
// background, purple-deep text, static ti-sparkles icon per live PM
// feedback (this used to be a plain spinner, and there used to also be a
// separate canvas-level banner using this same look - removed as
// redundant once every section using this loader shows the message right
// where its own content will appear).
function rcAiLoadingBlock(title){
  return `<div class="rc-ai-loading"><i class="ti ti-sparkles" aria-hidden="true"></i><div class="rc-ai-loading-title">${e(title)}</div></div>`;
}
// Shown instead of (never alongside) the pending loader once an AI call has
// failed — the deterministic content stays visible underneath this note,
// it is never hidden, matching the explicit "show the template, just
// indicate AI couldn't generate it" requirement. Same shape as the
// existing .rc-ai-pending-note (icon + italic text) but red, not purple.
function rcAiFailedNote(message){
  return `<div class="rc-ai-failed-note"><i class="ti ti-alert-circle" aria-hidden="true"></i> ${e(message)}</div>`;
}
const RC_SYS_CHANGE_OVERVIEW='You are a senior product manager writing a release readiness brief for other PMs and stakeholders. Respond ONLY with valid JSON: {"whatsChanging":"...","whyNeeded":"..."}. whatsChanging is 1-2 factual sentences naming what ships. whyNeeded is a coherent 2-4 sentence narrative explaining why this work matters, referencing the outcome metrics by name where relevant. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.';
const RC_SYS_IMPACT_GROUPS='You are a senior product manager identifying every real user or stakeholder group affected by this release, including groups never explicitly named in the stories (e.g. support, ops, other internal teams) when the change realistically affects them. Respond ONLY with valid JSON: an array of up to 6 objects, each {"name":"...","currentState":"...","futureState":"...","requiredBehavior":"..."}. name is a short role/title. currentState and futureState are each 1-2 plain-language sentences (not raw Given/Then fragments). requiredBehavior is a complete sentence stating specifically what this group needs to do differently, tailored to the rollout type given. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.';
const RC_SYS_READINESS_ACTIONS='You are a senior product manager planning launch readiness actions for one specific affected group. Given the group\'s current state, future state, and required behavior, propose 2-4 specific, concrete readiness actions (not generic communication/support boilerplate) - e.g. training, documentation updates, monitoring setup, a rollback rehearsal, whatever genuinely fits this change. Respond ONLY with valid JSON: an array of objects, each {"actionType":"...","description":"..."}. actionType is a short 1-3 word label. description is 1-2 complete sentences. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.';
const RC_SYS_LAUNCH_NARRATIVE='You are a senior product manager writing a short launch risk narrative for stakeholders. The launch decision (Ready/Conditional/Hold) is already fixed by the system - do not change or contradict it. Respond ONLY with valid JSON: {"narrative":"..."}. narrative is 2-4 sentences explaining, in plain business language, specifically which groups/actions (by name) still need attention and why this matters for this release, or if nothing is outstanding, why the release is genuinely ready. No markdown, no backticks, no preamble. Never use em dashes (—) in your output; use a hyphen (-) or rewrite the phrase.';

// Fires once, right after plan creation, for Change Overview + Impact
// Groups (both need the same story/feature context, built once as ctx
// below, but the two AI calls themselves run fully independently - see the
// round-2 fix inside). While plan._aiEnhancePending.changeOverview /
// .impactGroups is true, Sections 1 and 3 (rcRenderSection1()/
// rcRenderSection3()) each show a full loading block instead of the
// deterministic draft (live PM feedback fix: the draft used to render
// immediately and get silently swapped for the AI result a few seconds
// later, which read as random content appearing out of nowhere) - and each
// section reveals as soon as ITS OWN call resolves, not both at once. On
// success the deterministic draft is replaced with the AI result before
// it's ever shown; on failure (tracked per-field in plan._aiEnhanceFailed)
// the deterministic draft is what gets revealed, with an inline note that
// AI enhancement failed for that field.
function rcAiEnhanceNewPlan(planId){
  const plan=(piReadinessPlans||[]).find(p=>p.id===planId);
  if(!plan)return;
  const ctx=rcBuildStoryContext(plan);
  if(!ctx.features.length)return; // nothing to reason over yet — keep the deterministic empty-state copy
  // Loader-then-reveal fix, round 2 (live PM feedback): these two calls
  // used to be joined via Promise.allSettled, so NEITHER section could
  // reveal until BOTH resolved - Section 1 (the smaller, usually-faster
  // Change Overview call, 800 max_tokens) sat waiting on Section 3's
  // slower Impact Groups call (1500 max_tokens) for no real reason, once
  // both sections started showing a real loader instead of instant
  // (fake) content. Fired as two fully independent chains now, each
  // clearing only its own plan._aiEnhancePending.* flag the moment it
  // personally resolves - whichever section's call finishes first reveals
  // first, same as it would if they were two unrelated features.
  plan._aiEnhancePending={changeOverview:true,impactGroups:true};
  callAPI(RC_SYS_CHANGE_OVERVIEW,JSON.stringify(ctx),800,undefined,undefined,'arp-change-overview').then(txt=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(!p2)return;
    if(!p2._aiEnhanceFailed)p2._aiEnhanceFailed={};
    let ok=false;
    try{
      const parsed=rcParseAiJson(txt);
      if(parsed&&parsed.whatsChanging&&parsed.whyNeeded){
        p2.changeOverview.whatsChanging=String(parsed.whatsChanging).trim();
        p2.changeOverview.whyNeeded=String(parsed.whyNeeded).trim();
        p2.changeOverview.aiEnhanced=true;
        ok=true;
      }
    }catch(err){/* keep deterministic draft */}
    p2._aiEnhanceFailed.changeOverview=!ok;
    if(p2._aiEnhancePending)p2._aiEnhancePending.changeOverview=false;
    rcPersist();
    if(rcGetActivePlan()===p2)rcRenderCanvas();
  }).catch(()=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(p2){
      if(!p2._aiEnhanceFailed)p2._aiEnhanceFailed={};
      p2._aiEnhanceFailed.changeOverview=true;
      if(p2._aiEnhancePending)p2._aiEnhancePending.changeOverview=false;
    }
    if(p2&&rcGetActivePlan()===p2)rcRenderCanvas();
  });
  callAPI(RC_SYS_IMPACT_GROUPS,JSON.stringify(ctx),1500,undefined,undefined,'arp-impact-groups').then(txt=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(!p2)return;
    if(!p2._aiEnhanceFailed)p2._aiEnhanceFailed={};
    let ok=false;
    try{
      const parsed=rcParseAiJson(txt);
      if(Array.isArray(parsed)&&parsed.length){
        p2.impactGroups=parsed.filter(g=>g&&g.name).map(g=>({
          id:'ig-'+Math.random().toString(36).slice(2),
          name:String(g.name).trim(),
          currentState:String(g.currentState||'').trim(),
          futureState:String(g.futureState||'').trim(),
          requiredBehavior:String(g.requiredBehavior||'').trim(),
          status:'draft',
          origin:'ai'
        }));
        ok=true;
      }
    }catch(err){/* keep deterministic draft */}
    p2._aiEnhanceFailed.impactGroups=!ok;
    if(p2._aiEnhancePending)p2._aiEnhancePending.impactGroups=false;
    rcPersist();
    if(rcGetActivePlan()===p2)rcRenderCanvas();
  }).catch(()=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(p2){
      if(!p2._aiEnhanceFailed)p2._aiEnhanceFailed={};
      p2._aiEnhanceFailed.impactGroups=true;
      if(p2._aiEnhancePending)p2._aiEnhancePending.impactGroups=false;
    }
    if(p2&&rcGetActivePlan()===p2)rcRenderCanvas();
  });
}
// Fires when a group is confirmed (rcConfirmGroup), replacing that group's
// just-created deterministic actions with tailored ones. While
// plan._aiActionsPending[gid] is true, rcRenderSection4() shows a loading
// row for just this group instead of its deterministic rows (other groups
// render normally). Skipped if the PM already reviewed one of the
// deterministic actions before this resolves (a few-second window at most)
// — their review shouldn't be silently discarded by a background upgrade;
// that skip is deliberate, not a failure, so it does not set
// plan._aiActionsFailed[gid]. A genuine failure (rejection or malformed
// response) does set it, and rcRenderSection4() shows the deterministic
// rows plus an inline "AI could not tailor this" note instead.
function rcAiEnhanceActionsForGroup(planId,gid){
  const plan=(piReadinessPlans||[]).find(p=>p.id===planId);
  if(!plan)return;
  const g=(plan.impactGroups||[]).find(x=>x.id===gid);
  if(!g)return;
  if(!plan._aiActionsPending)plan._aiActionsPending={};
  plan._aiActionsPending[gid]=true;
  const usr=JSON.stringify({group:{name:g.name,currentState:g.currentState,futureState:g.futureState,requiredBehavior:g.requiredBehavior},rolloutType:(plan.releaseScope&&plan.releaseScope.rolloutType)||'Phased'});
  callAPI(RC_SYS_READINESS_ACTIONS,usr,700,undefined,undefined,'arp-readiness-actions').then(txt=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(!p2)return;
    const g2=(p2.impactGroups||[]).find(x=>x.id===gid);
    const existing=(p2.readinessActions||[]).filter(a=>a.groupId===gid);
    if(g2&&g2.status==='confirmed'&&!existing.some(a=>a.reviewed)){
      // Loader-then-reveal fix: wrap the parse (previously unwrapped — a
      // malformed-but-resolved response would throw here uncaught by
      // anything except the chained .catch() below, clearing pending with
      // no failure recorded) so a parse failure is tracked exactly like a
      // network rejection.
      try{
        const parsed=rcParseAiJson(txt);
        if(Array.isArray(parsed)&&parsed.length){
          const fresh=parsed.filter(a=>a&&a.description).map(a=>({
            id:'ra-'+Math.random().toString(36).slice(2),
            groupId:gid,
            groupName:g2.name,
            actionType:String(a.actionType||'Action').trim(),
            description:String(a.description).trim(),
            reviewed:false
          }));
          p2.readinessActions=(p2.readinessActions||[]).filter(a=>a.groupId!==gid).concat(fresh);
          const rec=rcComputeRecommendation(p2);
          p2.recommendation.systemValue=rec.value;
          p2.recommendation.reasoning=rec.reason;
          if(p2._aiActionsFailed)delete p2._aiActionsFailed[gid];
        }else{
          if(!p2._aiActionsFailed)p2._aiActionsFailed={};
          p2._aiActionsFailed[gid]=true;
        }
      }catch(err){
        if(!p2._aiActionsFailed)p2._aiActionsFailed={};
        p2._aiActionsFailed[gid]=true;
      }
    }
    // else: the group was un-confirmed or the PM already reviewed one of
    // the deterministic actions before this resolved - a deliberate skip,
    // not a failure, so _aiActionsFailed is untouched (no note needed).
    if(p2._aiActionsPending)delete p2._aiActionsPending[gid];
    rcPersist();
    if(rcGetActivePlan()===p2)rcRenderCanvas();
  }).catch(()=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(p2){
      if(p2._aiActionsPending)delete p2._aiActionsPending[gid];
      if(!p2._aiActionsFailed)p2._aiActionsFailed={};
      p2._aiActionsFailed[gid]=true;
    }
    if(p2&&rcGetActivePlan()===p2)rcRenderCanvas();
  });
}
// Signature of everything the launch narrative could reference — recompute
// whenever it changes (a group gets confirmed, an action gets reviewed,
// etc.), not on every render. Cheap plain-string comparison, no AI call
// involved in computing it.
function rcRecommendationSignature(plan){
  const rec=rcComputeRecommendation(plan);
  const groups=(plan.impactGroups||[]).filter(g=>g.status!=='removed').map(g=>g.id+':'+g.status).sort().join(',');
  const actions=(plan.readinessActions||[]).map(a=>a.id+':'+(a.reviewed?1:0)).sort().join(',');
  return rec.value+'|'+groups+'|'+actions;
}
// Called from rcRenderCanvas (never from inside rcRenderSection5 itself —
// see that function for why) whenever Section 5 is the active section.
// Lazily generates the narrative the first time it's viewed for a given
// signature, and again any time the signature changes thereafter. A failed
// call records that signature as failed so it doesn't retry every render
// until something actually changes.
function rcMaybeTriggerLaunchNarrative(plan){
  if(!plan||plan.status==='finalized'||plan._aiNarrativePending)return;
  const sig=rcRecommendationSignature(plan);
  if(plan.recommendation.aiNarrativeSig===sig||plan._aiNarrativeFailedSig===sig)return;
  plan._aiNarrativePending=true;
  const planId=plan.id;
  const rec=rcComputeRecommendation(plan);
  const ctx={
    recommendation:rec.value,
    systemReason:rec.reason,
    rolloutType:(plan.releaseScope&&plan.releaseScope.rolloutType)||'Phased',
    groups:(plan.impactGroups||[]).filter(g=>g.status!=='removed').map(g=>({name:g.name,status:g.status})),
    actions:(plan.readinessActions||[]).map(a=>({actionType:a.actionType,group:((plan.impactGroups||[]).find(g=>g.id===a.groupId)||{}).name,reviewed:a.reviewed}))
  };
  callAPI(RC_SYS_LAUNCH_NARRATIVE,JSON.stringify(ctx),600,undefined,undefined,'arp-launch-narrative').then(txt=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(!p2)return;
    try{
      const parsed=rcParseAiJson(txt);
      if(parsed&&parsed.narrative){
        p2.recommendation.aiNarrative=String(parsed.narrative).trim();
        p2.recommendation.aiNarrativeSig=sig;
      }else{
        p2._aiNarrativeFailedSig=sig;
      }
    }catch(err){
      p2._aiNarrativeFailedSig=sig;
    }
    p2._aiNarrativePending=false;
    rcPersist();
    if(rcGetActivePlan()===p2)rcRenderCanvas();
  }).catch(()=>{
    const p2=(piReadinessPlans||[]).find(p=>p.id===planId);
    if(p2){p2._aiNarrativePending=false;p2._aiNarrativeFailedSig=sig;}
    if(p2&&rcGetActivePlan()===p2)rcRenderCanvas();
  });
}

// ── Creation (§1.2) ──────────────────────────────────────────────────────
function rcCreatePlan(releasePlanId){
  const piPlan=(typeof piPlans!=='undefined'?piPlans:[]).find(p=>p.id===releasePlanId);
  if(!piPlan)return null;
  const releaseScope=rcComputeReleaseScope(piPlan);
  const lineage=rcComputeLineage(piPlan);
  const changeOverview=rcDraftChangeOverview(piPlan,lineage);
  const impactGroups=rcDraftImpactGroups(piPlan,releaseScope);
  const plan={
    id:rcMakeId(),
    releasePlanId:piPlan.id,
    releasePlanName:piPlan.name||'Release Plan',
    status:'draft',
    changeOverview,
    releaseScope,
    impactGroups,
    readinessActions:[],
    recommendation:{systemValue:'Hold',reasoning:'',conditionsToClear:'',override:null,overrideRationale:''},
    lineageSources:lineage,
    createdAt:Date.now(),
    finalizedAt:null,
    staleFlag:false,
    lastSection:1
  };
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  plan.recommendation.conditionsToClear=rec.value==='Ready'?'No further conditions - this release is ready to launch.':'Resolve the items above, then revisit this section.';
  if(!Array.isArray(piReadinessPlans))piReadinessPlans=[];
  piReadinessPlans.push(plan);
  rcRevealTab();
  rcAiEnhanceNewPlan(plan.id);
  return plan;
}

// ── Regeneration effect (§1.10) — called from pi-planning.js's piGenerate()
// right after a regenerate-in-place completes, for a plan whose Release
// Plan already had a readinessPlan attached. No data is deleted; only the
// Release-Plan-derived fields are recomputed. ──
function rcApplyRegenerationEffect(plan,newPiPlan){
  if(!plan)return;
  plan.status='draft';
  plan.staleFlag=true;
  plan.finalizedAt=null;
  const rolloutType=plan.releaseScope?plan.releaseScope.rolloutType:'Phased';
  const rolloutOther=plan.releaseScope?plan.releaseScope.rolloutTypeOther:'';
  plan.releaseScope=rcComputeReleaseScope(newPiPlan,rolloutType,rolloutOther);
  plan.lineageSources=rcComputeLineage(newPiPlan);
  // changeOverview text is deliberately NOT regenerated — retains the PM's
  // prior edits (spec §1.10). staleFlag is the signal to review it.
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
}

// ── Persist + toast helper — every mutation in this file funnels through
// here so the session save always fires and Adoption Readiness UI updates
// stay consistent with the rest of the app's save pattern. ──
function rcPersist(){
  if(typeof _isDemoSession!=='undefined'&&_isDemoSession)return;
  if(typeof sessionStoreSave==='function'&&typeof _activeSessionId!=='undefined'&&_activeSessionId){
    sessionStoreSave(_activeSessionId);
  }
}

// ── Reveal ── shows the tab-arp button once at least one readinessPlan
// exists in the session (mirrors tab-sc/tab-pi's own reveal-on-content
// pattern; see applyFeats() in left-panel.js, _ssRevealTabs() in
// session-store.js, and homeClearSession()'s reset list in home.js for
// the other three places this same reveal/un-reveal is mirrored). ──
function rcRevealTab(){
  const el=document.getElementById('tab-arp');
  if(el)el.classList.add('revealed');
}

// ── Navigate to a specific Release Plan's Readiness Plan — creates it if
// none exists yet for that Release Plan, then switches into the tab.
// This is the ONLY place a readinessPlan is ever created (Release Canvas's
// kebab menu, via piOpenReadinessPlan() below, and the completion/
// regeneration modals' CTAs, all funnel through here) — per spec §1.2,
// Adoption Readiness is still only ever CREATED from Release Canvas. ──
function rcNavigateToPlan(releasePlanId){
  let plan=rcFindPlan(releasePlanId);
  if(!plan){
    plan=rcCreatePlan(releasePlanId);
    if(!plan){showToast('Could not create a Readiness Plan for this release.','error');return;}
    rcPersist();
  }
  rcActivePlanId=plan.id;
  rcActiveSection=plan.lastSection||1;
  rcRevealTab();
  if(typeof switchTab==='function')switchTab('arp');
}

// ── Tab entry point — called by switchTab('arp') (api.js). If a plan is
// already active (set by rcNavigateToPlan() just before the tab switch)
// render it; otherwise fall back to whatever readinessPlan belongs to the
// currently active Release Plan; otherwise render the empty state (the
// tab was entered directly from the top nav, not via the kebab menu, and
// no Readiness Plan exists yet for the active Release Plan). ──
function rcOnTabEnter(){
  if(!rcGetActivePlan()){
    const activeReleasePlan=(typeof piGetActivePlan==='function')?piGetActivePlan():null;
    const existing=activeReleasePlan?rcFindPlan(activeReleasePlan.id):null;
    if(existing)rcActivePlanId=existing.id;
  }
  const plan=rcGetActivePlan();
  if(!plan){rcRenderEmpty();return;}
  rcActiveSection=plan.lastSection||rcActiveSection||1;
  rcRenderCanvas();
}

// ── Empty state — shown when the tab is entered directly and there is no
// active Release Plan / no Readiness Plan for it yet (mirrors
// piRenderEmpty()'s pattern in pi-planning.js). Adoption Readiness is
// still only ever created from Release Canvas's kebab menu once sprint
// planning is complete. ──
function rcRenderEmpty(){
  const container=document.getElementById('rc-canvas');
  if(!container)return;
  container.innerHTML=`
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;text-align:center;padding:40px;">
      <div style="width:44px;height:44px;border-radius:11px;background:var(--purple-pale);display:flex;align-items:center;justify-content:center;margin-bottom:16px;">
        <i class="ti ti-checklist" style="font-size:20px;color:var(--purple);" aria-hidden="true"></i>
      </div>
      <div style="font-size:14px;font-weight:700;color:var(--t1);margin-bottom:6px;">No Readiness Plan yet</div>
      <div style="font-size:11.5px;color:var(--t3);max-width:340px;line-height:1.6;">A Readiness Plan is created from Release Canvas's &#8942; menu once sprint planning for that release is complete.</div>
    </div>
  `;
}

// ── Generic path get/set against the active plan (powers the hover-to-edit
// pattern uniformly across all sections, per spec §1.7). ──
function rcGetByPath(path){
  const plan=rcGetActivePlan();
  if(!plan)return '';
  return path.split('.').reduce((o,k)=>(o&&o[k]!==undefined)?o[k]:'',plan);
}
function rcSetByPath(path,value){
  const plan=rcGetActivePlan();
  if(!plan)return;
  const parts=path.split('.');
  let o=plan;
  for(let i=0;i<parts.length-1;i++){
    if(o[parts[i]]===undefined)o[parts[i]]={};
    o=o[parts[i]];
  }
  o[parts[parts.length-1]]=value;
}

// ── Hover-to-edit field — standardized on sc-card-pencil's pure-CSS
// approach (.ra-field-pencil shown on .ra-field-wrap:hover), NOT the
// mouseenter/mouseleave op-nsm-pencil approach, per build correction §3. ──
function rcFieldHtml(id,path,multiline,placeholder){
  const value=rcGetByPath(path);
  const canEdit=(typeof canEditSession!=='function')||canEditSession();
  const plan=rcGetActivePlan();
  const locked=plan&&plan.status==='finalized';
  const pencil=(canEdit&&!locked)?`<button class="ra-field-pencil" onclick="event.stopPropagation();rcEditField('${id}','${e(path)}',${multiline?'true':'false'})" title="Edit" aria-label="Edit"><i class="ti ti-pencil" aria-hidden="true"></i></button>`:'';
  return `<div class="ra-field-wrap"><div class="ra-field-text" id="rc-ft-${id}">${e(value)||`<span class="ra-field-empty">${e(placeholder||'')}</span>`}</div>${pencil}</div>`;
}
function rcEditField(id,path,multiline){
  const textEl=document.getElementById('rc-ft-'+id);
  if(!textEl)return;
  const wrap=textEl.parentElement;
  const cur=rcGetByPath(path);
  if(multiline){
    wrap.innerHTML=`<textarea class="ra-field-input" id="rc-fi-${id}" onblur="rcSaveField('${id}','${e(path)}',this.value)">${e(cur)}</textarea>`;
  } else {
    wrap.innerHTML=`<input type="text" class="ra-field-input" id="rc-fi-${id}" onblur="rcSaveField('${id}','${e(path)}',this.value)" value="${e(cur)}">`;
  }
  const inp=document.getElementById('rc-fi-'+id);
  inp.focus();
  if(inp.setSelectionRange&&typeof cur==='string')inp.setSelectionRange(cur.length,cur.length);
}
function rcSaveField(id,path,value){
  rcSetByPath(path,value);
  rcPersist();
  rcRenderCanvas();
}

// ── Section navigation ──────────────────────────────────────────────────
const RC_SECTIONS=[
  {n:1,label:'Change Overview'},
  {n:2,label:'Release Scope'},
  {n:3,label:'Impact & Affected Groups'},
  {n:4,label:'Readiness Actions'},
  {n:5,label:'Launch Recommendation'},
  {n:6,label:'Readiness Summary'}
];
// Sections whose content has real checklist-style sub-items (impact group
// confirmation, readiness action review) aren't "done" just because the
// user scrolled past them — they're only done once those sub-items are
// actually resolved. Sections without sub-items are done once visited.
function rcSectionOutstanding(plan,n){
  if(n===3)return (plan.impactGroups||[]).some(g=>g.status==='draft');
  if(n===4)return (plan.readinessActions||[]).some(a=>!a.reviewed);
  if(n===5){
    const rec=plan.recommendation||{};
    const isOverridden=!!(rec.override&&rec.override!==rec.systemValue);
    return isOverridden&&!(rec.overrideRationale&&rec.overrideRationale.trim());
  }
  return false;
}
function rcGoTo(n){
  rcActiveSection=n;
  const plan=rcGetActivePlan();
  if(plan){plan.lastSection=n;rcPersist();}
  rcRenderCanvas();
}

// ── Left panel (F2/F3) — mirrors the app's collapsible left-panel pattern
// (left-panel.js's togglePanel()): eyebrow + release plan card, sources
// card (with a working lineage-drawer link), and a numbered step nav. ──
let rcPanelOpen=true;
function rcLeftPanelHtml(plan){
  const s=plan.releaseScope||{};
  const sources=(plan.lineageSources||[]);
  const sourcesHtml=sources.length
    ?sources.map(src=>`<div class="rc-lp-source-row">${e(src.requirementName)}</div>`).join('')
    :'<div class="rc-lp-source-row rc-empty" style="padding:4px 0;">No sources.</div>';
  const visited=plan.visitedSections||[];
  const stepsHtml=RC_SECTIONS.map(sec=>{
    let state;
    if(sec.n===rcActiveSection)state='active';
    else if(!visited.includes(sec.n))state='pending';
    else state=rcSectionOutstanding(plan,sec.n)?'warn':'done';
    const marker=state==='done'?'<i class="ti ti-check" aria-hidden="true"></i>':(state==='warn'?'<i class="ti ti-alert-triangle" aria-hidden="true"></i>':sec.n);
    return `<div class="rc-step-item rc-step-${state}" onclick="rcGoTo(${sec.n})"><span class="rc-step-circle">${marker}</span><span class="rc-step-label">${e(sec.label)}</span></div>`;
  }).join('');
  return `
    <div class="rc-lp-hdr">
      <div class="rc-lp-hdr-text">
        <div class="rc-lp-eyebrow">ADOPTION READINESS</div>
        <div class="rc-lp-plan-name">${e(plan.releasePlanName)}</div>
      </div>
      <button class="rc-lp-collapse-btn" onclick="rcTogglePanel()" title="Toggle panel">
        <svg id="rc-icon-exp" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/><polyline points="21 18 15 12 21 6"/></svg>
        <svg id="rc-icon-col" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polyline points="9 18 15 12 9 6"/><polyline points="3 18 9 12 3 6"/></svg>
      </button>
    </div>
    <div class="rc-lp-scroll">
      <div class="rc-lp-card">
        <div class="rc-lp-card-title">Release Plan</div>
        <div class="rc-lp-card-name">${e(plan.releasePlanName)}</div>
        <div class="rc-lp-card-meta">${e(s.squad)||'&mdash;'}</div>
        <div class="rc-lp-card-meta">${e(s.sprintDates)||'&mdash;'}</div>
        <div class="rc-lp-card-meta">${s.storyCount||0} stories &middot; ${s.featureCount||0} features &middot; ${s.storyPoints||0} pts</div>
      </div>
      <div class="rc-lp-card">
        <div class="rc-lp-card-title">Sources</div>
        ${sourcesHtml}
        <div class="rc-lp-lineage-link" onclick="rcOpenLineageDrawer()">View full lineage &rarr;</div>
      </div>
      <div class="rc-lp-card">
        <div class="rc-lp-card-title">Progress</div>
        <div class="rc-step-nav">${stepsHtml}</div>
      </div>
    </div>
  `;
}
function rcTogglePanel(){
  rcPanelOpen=!rcPanelOpen;
  const el=document.getElementById('rc-left-panel');
  if(el)el.classList.toggle('collapsed',!rcPanelOpen);
  const iconExp=document.getElementById('rc-icon-exp');
  const iconCol=document.getElementById('rc-icon-col');
  if(iconExp)iconExp.style.display=rcPanelOpen?'block':'none';
  if(iconCol)iconCol.style.display=rcPanelOpen?'none':'block';
}

// ── Top action row — status pill, "Reopen for edits" link, and Export
// button, right-aligned in the same header row as each section's own
// title. Appears on every section (1-6), since the finalized/read-only
// state applies across the whole plan while it's finalized. Consolidates
// what used to be a separate breadcrumb-style canvas header (now
// redundant with the left panel's Release Plan card). ──
function rcStatusPillHtml(plan){
  const isFinalized=plan.status==='finalized';
  return `<span class="rc-status-pill${isFinalized?' rc-status-pill-finalized':''}">${isFinalized?'<i class="ti ti-lock" aria-hidden="true"></i> Finalized':'Draft'}</span>`;
}
function rcTopActionsHtml(plan){
  const isFinalized=plan.status==='finalized';
  const reopenLink=isFinalized?`<button class="rc-reopen-link" onclick="rcReopenForEdit()">Reopen for edits</button>`:'';
  // Item 6 fix — Export only shown on the Readiness Summary section.
  // rcActiveSection is the existing module-level tracker, already
  // accessible here without a signature change. Derived from RC_SECTIONS'
  // actual last entry (code-review fix) rather than a hardcoded `6`, so
  // this stays correct if RC_SECTIONS is ever reordered or a section is
  // added/removed.
  const isSummarySection=rcActiveSection===RC_SECTIONS[RC_SECTIONS.length-1].n;
  const exportBtn=isSummarySection?`<button class="rc-export-btn" onclick="rcExportDocx()"><i class="ti ti-download" aria-hidden="true"></i> Export</button>`:'';
  return `<div class="rc-top-actions">${reopenLink}${exportBtn}</div>`;
}

// ── Master render ────────────────────────────────────────────────────────
// A step only counts as reviewed once the user has actually landed on it —
// jumping straight from section 1 to section 6 (allowed, per free-form nav)
// must not retroactively mark 2-5 as reviewed just because their number is
// lower than the current section.
function rcMarkSectionVisited(plan,n){
  if(!plan)return;
  if(!Array.isArray(plan.visitedSections))plan.visitedSections=[];
  if(!plan.visitedSections.includes(n)){
    plan.visitedSections.push(n);
    rcPersist();
  }
}
function rcRenderCanvas(){
  const container=document.getElementById('rc-canvas');
  const plan=rcGetActivePlan();
  if(!container||!plan)return;
  // .rc-content is destroyed and rebuilt on every render (innerHTML swap
  // below), so its scrollTop resets to 0 by default — every add/edit/
  // delete action in this file re-renders the whole canvas, which was
  // silently scrolling the PM back to the top of a long section (e.g.
  // Impact & Affected Groups with 6+ cards) after every single edit.
  // Capture both the internal .rc-content scroll AND the page/window
  // scroll before replacing it, reapply after — whichever one is actually
  // the scrolling context in a given layout gets restored either way.
  const _prevScroll=container.querySelector('.rc-content');
  const _scrollTop=_prevScroll?_prevScroll.scrollTop:0;
  const _winScrollY=window.scrollY||document.documentElement.scrollTop||0;
  rcMarkSectionVisited(plan,rcActiveSection);
  // Side-effecting trigger, not a pure read — must run BEFORE rcRenderSection5
  // builds its HTML (below) so that render sees the pending flag it sets, and
  // must NOT itself call rcRenderCanvas() (that happens later, async, from
  // the fetch's own .then/.catch) to avoid re-entrant rendering.
  if(rcActiveSection===5)rcMaybeTriggerLaunchNarrative(plan);
  const staleBanner=plan.staleFlag?`<div class="rc-stale-banner"><i class="ti ti-alert-triangle" aria-hidden="true"></i> This release plan was regenerated. Review this Readiness Plan against its new scope before finalizing again.</div>`:'';
  // Loader-then-reveal fix, round 2 (live PM feedback): removed the
  // canvas-level "Enhancing..." banner entirely - now redundant and
  // confusing alongside Section 1/3's own full loading blocks, which show
  // the exact same message where the content itself will appear.
  const sec=RC_SECTIONS.find(s=>s.n===rcActiveSection)||RC_SECTIONS[0];
  let sectionHtml='';
  switch(rcActiveSection){
    case 1: sectionHtml=rcRenderSection1(plan); break;
    case 2: sectionHtml=rcRenderSection2(plan); break;
    case 3: sectionHtml=rcRenderSection3(plan); break;
    case 4: sectionHtml=rcRenderSection4(plan); break;
    case 5: sectionHtml=rcRenderSection5(plan); break;
    case 6: sectionHtml=rcRenderSection6(plan); break;
  }
  container.innerHTML=`
    ${staleBanner}
    <div class="rc-body">
      <div class="rc-left-panel${rcPanelOpen?'':' collapsed'}" id="rc-left-panel">${rcLeftPanelHtml(plan)}</div>
      <div class="rc-main">
        <div class="rc-content">
          <div class="rc-section-title-row">
            <div class="rc-section-title">${sec.n}. ${e(sec.label)} ${rcStatusPillHtml(plan)}</div>
            ${rcTopActionsHtml(plan)}
          </div>
          ${sectionHtml}
        </div>
        <div class="rc-main-footer">${rcFooterNav(rcActiveSection)}</div>
      </div>
    </div>
  `;
  if(_scrollTop){
    const _newScroll=container.querySelector('.rc-content');
    if(_newScroll)_newScroll.scrollTop=_scrollTop;
  }
  if(_winScrollY)window.scrollTo(0,_winScrollY);
}

// ── Section 1 — Change Overview ─────────────────────────────────────────
function rcRenderSection1(plan){
  // Loader-then-reveal fix, round 3 (live PM feedback): field-level gating,
  // matching Section 5's own AI Risk Narrative pattern (rcRenderSection5())
  // instead of a full-section loading block - the card labels ("What's
  // Changing"/"Why It's Needed") and the metrics table (never AI-touched
  // at all - RC_SYS_CHANGE_OVERVIEW only ever returns whatsChanging/
  // whyNeeded) render immediately; only the two AI-enhanced field VALUES
  // themselves show the inline "...with AI" note while pending, or the
  // deterministic value plus a failure note if AI enhancement failed.
  const pending=(plan._aiEnhancePending&&plan._aiEnhancePending.changeOverview);
  const failed=(plan._aiEnhanceFailed&&plan._aiEnhanceFailed.changeOverview);
  const whatsChangingField=pending
    ?`<div class="rc-ai-pending-note"><i class="ti ti-sparkles" aria-hidden="true"></i> Writing this with AI...</div>`
    :(failed?rcAiFailedNote('AI could not enhance this - showing the baseline summary.'):'')+rcFieldHtml('whatsChanging','changeOverview.whatsChanging',true);
  const whyNeededField=pending
    ?`<div class="rc-ai-pending-note"><i class="ti ti-sparkles" aria-hidden="true"></i> Writing this with AI...</div>`
    :(failed?rcAiFailedNote('AI could not enhance this - showing the baseline summary.'):'')+rcFieldHtml('whyNeeded','changeOverview.whyNeeded',true);
  const rows=(plan.changeOverview.metrics||[]).map((m,i)=>`
    <tr>
      <td>${rcFieldHtml('m-name-'+i,'changeOverview.metrics.'+i+'.metricName',false,'Metric name')}</td>
      <td>${rcFieldHtml('m-base-'+i,'changeOverview.metrics.'+i+'.baseline',false,'Baseline')}</td>
      <td>${rcFieldHtml('m-target-'+i,'changeOverview.metrics.'+i+'.target',false,'Target')}</td>
      <td><button class="rc-row-del" onclick="rcDeleteMetricRow(${i})" title="Remove row"><i class="ti ti-x" aria-hidden="true"></i></button></td>
    </tr>`).join('');
  return `
    <div class="rc-card">
      <div class="rc-field-label">What's Changing</div>
      ${whatsChangingField}
    </div>
    <div class="rc-card">
      <div class="rc-field-label">Why It's Needed</div>
      ${whyNeededField}
    </div>
    <div class="rc-card">
      <div class="rc-field-label">What It Improves</div>
      <table class="rc-metrics-table"><thead><tr><th>Metric</th><th>Baseline</th><th>Target</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="4" class="rc-empty">No metrics yet.</td></tr>'}</tbody></table>
      <div class="rc-add-link" onclick="rcAddMetricRow()"><i class="ti ti-plus" aria-hidden="true"></i> Add metric</div>
    </div>

  `;
}
function rcAddMetricRow(){
  const plan=rcGetActivePlan();if(!plan)return;
  plan.changeOverview.metrics.push({id:'m-'+Math.random().toString(36).slice(2),metricName:'',baseline:'',target:''});
  rcPersist();rcRenderCanvas();
}
function rcDeleteMetricRow(i){
  const plan=rcGetActivePlan();if(!plan)return;
  plan.changeOverview.metrics.splice(i,1);
  rcPersist();rcRenderCanvas();
}

// ── Section 2 — Release Scope ───────────────────────────────────────────
function rcRenderSection2(plan){
  rcEnsureWhatsShipping(plan);
  const s=plan.releaseScope;
  const otherField=s.rolloutType==='Other'?`<div class="rc-field-label" style="margin-top:10px;">Other, please specify</div>${rcFieldHtml('rolloutOther','releaseScope.rolloutTypeOther',false)}`:'';
  const opts=['Phased','Full','Pilot','Beta','Other'];
  return `
    <div class="rc-card">
      <div class="rc-field-label">What's Shipping</div>
      ${rcFieldHtml('whatsShipping','releaseScope.whatsShipping',true)}
    </div>
    <div class="rc-card rc-scope-grid">
      <div><div class="rc-field-label">Squad</div><div class="rc-readonly">${e(s.squad)||'&mdash;'}</div></div>
      <div><div class="rc-field-label">Sprint Dates</div><div class="rc-readonly">${e(s.sprintDates)||'&mdash;'}</div></div>
      <div><div class="rc-field-label">Stories</div><div class="rc-readonly">${s.storyCount}</div></div>
      <div><div class="rc-field-label">Features</div><div class="rc-readonly">${s.featureCount}</div></div>
      <div><div class="rc-field-label">Story Points</div><div class="rc-readonly">${s.storyPoints}</div></div>
      <div>
        <div class="rc-field-label">Rollout Type <span class="rc-required">*</span></div>
        <select class="rc-select" onchange="rcSetRolloutType(this.value)">${opts.map(o=>`<option value="${o}" ${s.rolloutType===o?'selected':''}>${o}</option>`).join('')}</select>
      </div>
    </div>
    ${otherField?`<div class="rc-card">${otherField}</div>`:''}

  `;
}
function rcSetRolloutType(v){
  rcSetByPath('releaseScope.rolloutType',v);
  rcPersist();rcRenderCanvas();
}

// ── Section 3 — Impact & Affected Groups ────────────────────────────────
function rcRenderSection3(plan){
  // Loader-then-reveal fix: same idea as rcRenderSection1() (both come
  // from rcAiEnhanceNewPlan(), which now fires Change Overview and Impact
  // Groups as two independent calls) - show a full loading block instead
  // of the deterministic candidate groups while THIS section's own AI call
  // is in flight, regardless of whether Change Overview's call has
  // finished yet.
  if(plan._aiEnhancePending&&plan._aiEnhancePending.impactGroups)return rcAiLoadingBlock('Identifying affected groups with AI...');
  const canEdit=(typeof canEditSession!=='function')||canEditSession();
  const locked=plan.status==='finalized';
  const cards=(plan.impactGroups||[]).filter(g=>g.status!=='removed').map(g=>{
    const isDraft=g.status==='draft';
    const badge=(g.origin==='ai'&&g.status==='draft')?`<span class="rc-ai-badge">AI DRAFT &middot; NEEDS REVIEW</span>`:(g.status==='confirmed'?`<span class="rc-chip rc-chip-ok">CONFIRMED</span>`:'');
    const behaviorField=isDraft
      ?`<textarea class="ra-field-input rc-behavior-draft" onblur="rcSaveGroupField('${g.id}','requiredBehavior',this.value)" placeholder="Describe specifically what this group needs to do differently.">${e(g.requiredBehavior)}</textarea>`
      :rcFieldHtml('behavior-'+g.id,'', false); // confirmed groups use the standard hover pencil below
    const behaviorHtml=isDraft?behaviorField:rcConfirmedBehaviorField(g);
    const actions=isDraft?`
      <div class="rc-group-actions">
        <button class="modal-cancel-btn" onclick="rcRemoveGroup('${g.id}')">Remove</button>
        <button class="modal-confirm-btn" onclick="rcConfirmGroup('${g.id}')">Confirm</button>
      </div>`:'';
    // Pencil (full edit modal) + delete only on confirmed cards — draft
    // cards already have their own Remove/Confirm affordances below, and
    // their Required Behavior is already inline-editable.
    const cardIcons=(!isDraft&&canEdit&&!locked)?`
      <div class="rc-group-card-icons">
        <button class="rc-group-icon-btn" onclick="rcOpenEditGroupModal('${g.id}')" title="Edit"><i class="ti ti-pencil" aria-hidden="true"></i></button>
        <button class="rc-group-icon-btn" onclick="rcConfirmRemoveGroup('${g.id}')" title="Delete"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>`:'';
    return `
      <div class="rc-group-card">
        <div class="rc-group-hdr"><div class="rc-group-name">${e(g.name)}</div><div class="rc-group-hdr-right">${badge}${cardIcons}</div></div>
        <div class="rc-field-label">Current State</div><div class="rc-readonly-block">${e(g.currentState)}</div>
        <div class="rc-field-label">Future State</div><div class="rc-readonly-block">${e(g.futureState)}</div>
        <div class="rc-field-label">Required Behavior</div>${behaviorHtml}
        ${actions}
      </div>`;
  }).join('');
  const failedNote=(plan._aiEnhanceFailed&&plan._aiEnhanceFailed.impactGroups)?rcAiFailedNote('AI could not identify additional affected groups - showing the baseline candidates below.'):'';
  const addTile=(canEdit&&!locked)?`
    <div class="rc-add-group-tile" onclick="rcOpenAddGroupModal()">
      <i class="ti ti-plus" aria-hidden="true"></i>
      <span>Add group</span>
    </div>`:'';
  return `
    ${failedNote}
    ${cards?'':'<div class="rc-empty">No candidate groups were drafted - add one below.</div>'}
    <div class="rc-groups-grid">${cards}${addTile}</div>
  `;
}
function rcConfirmedBehaviorField(g){
  const canEdit=(typeof canEditSession!=='function')||canEditSession();
  const plan=rcGetActivePlan();
  const locked=plan&&plan.status==='finalized';
  const pencil=(canEdit&&!locked)?`<button class="ra-field-pencil" onclick="event.stopPropagation();rcEditGroupBehavior('${g.id}')" title="Edit"><i class="ti ti-pencil" aria-hidden="true"></i></button>`:'';
  return `<div class="ra-field-wrap"><div class="ra-field-text" id="rc-behavior-text-${g.id}">${e(g.requiredBehavior)}</div>${pencil}</div>`;
}
function rcEditGroupBehavior(gid){
  const el=document.getElementById('rc-behavior-text-'+gid);
  if(!el)return;
  const plan=rcGetActivePlan();
  const g=plan.impactGroups.find(x=>x.id===gid);
  el.parentElement.innerHTML=`<textarea class="ra-field-input" onblur="rcSaveGroupField('${gid}','requiredBehavior',this.value)">${e(g.requiredBehavior)}</textarea>`;
  el.parentElement.querySelector('textarea').focus();
}
function rcSaveGroupField(gid,field,value){
  const plan=rcGetActivePlan();if(!plan)return;
  const g=plan.impactGroups.find(x=>x.id===gid);
  if(!g)return;
  g[field]=value;
  if(field==='requiredBehavior'&&g.status==='confirmed'){
    rcRegenerateActionsFromConfirmedGroups(plan);
  }
  rcPersist();rcRenderCanvas();
}
function rcConfirmGroup(gid){
  const plan=rcGetActivePlan();if(!plan)return;
  const g=plan.impactGroups.find(x=>x.id===gid);
  if(!g)return;
  if(!g.requiredBehavior||!g.requiredBehavior.trim()){
    showToast('Review and edit Required Behavior before confirming this group.','warn');
    return;
  }
  g.status='confirmed';
  rcRegenerateActionsFromConfirmedGroups(plan);
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  rcPersist();rcRenderCanvas();
  rcAiEnhanceActionsForGroup(plan.id,gid);
}
function rcRemoveGroup(gid){
  const plan=rcGetActivePlan();if(!plan)return;
  const g=plan.impactGroups.find(x=>x.id===gid);
  if(g)g.status='removed';
  rcRegenerateActionsFromConfirmedGroups(plan);
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  rcPersist();rcRenderCanvas();
}
function rcConfirmRemoveGroup(gid){
  const plan=rcGetActivePlan();if(!plan)return;
  const g=plan.impactGroups.find(x=>x.id===gid);
  if(!g)return;
  showConfirm(
    'This removes "'+e(g.name)+'" and any readiness actions tied to it. This cannot be undone.',
    'Delete this group?',
    ()=>rcRemoveGroup(gid),
    'Delete',
    'danger'
  );
}
// ── Shared modal shell for Edit/Add Group — both open functions below
// build only their own header/body/footer HTML and hand it to this helper,
// so the overlay/close/Escape/focus-trap wiring lives in exactly one place. ──
function rcOpenGroupModal(overlayId,headerHtml,bodyHtml,footerHtml){
  const existing=document.getElementById(overlayId);
  if(existing)existing.remove();
  const overlay=document.createElement('div');
  overlay.className='modal-overlay';
  overlay.id=overlayId;
  overlay.innerHTML=`<div class="modal" style="max-width:440px;overflow-y:auto;max-height:80vh;position:relative;">
    <button onclick="document.getElementById('${overlayId}').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:16px 44px 14px 16px;border-bottom:0.5px solid var(--divider);">
      <div style="font-size:13px;font-weight:500;color:var(--t1);">${headerHtml}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;padding:14px 20px 4px;">${bodyHtml}</div>
    <div class="modal-footer">${footerHtml}</div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  if(typeof trapFocus==='function')trapFocus(overlay);
  return overlay;
}
function rcGroupModalFieldHtml(label,id,value,required){
  return `<div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">${e(label)}${required?'<span style="color:var(--red);margin-left:1px;">*</span>':''}</label>
        <textarea id="${id}" style="width:100%;height:70px;border:1px solid var(--divider);border-radius:5px;padding:6px 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);resize:none;">${e(value)}</textarea>
      </div>`;
}
// ── Edit Group modal — mirrors Feature Canvas's Edit Feature modal shell
// (header + close X, stacked fields, Cancel/Save Changes footer) so the
// two "edit a card's details" experiences feel consistent app-wide. ──
function rcOpenEditGroupModal(gid){
  const plan=rcGetActivePlan();if(!plan)return;
  const g=plan.impactGroups.find(x=>x.id===gid);
  if(!g)return;
  rcOpenGroupModal(
    'rc-edit-group-overlay',
    `Edit Group &middot; ${e(g.name)}`,
    rcGroupModalFieldHtml('Current State','rc-eg-current',g.currentState)
      +rcGroupModalFieldHtml('Future State','rc-eg-future',g.futureState)
      +rcGroupModalFieldHtml('Required Behavior','rc-eg-behavior',g.requiredBehavior),
    `<button class="modal-cancel-btn" onclick="document.getElementById('rc-edit-group-overlay').remove()">Cancel</button>
     <button class="modal-confirm-btn" onclick="rcSaveEditGroupModal('${gid}')">Save Changes</button>`
  );
}
function rcSaveEditGroupModal(gid){
  const plan=rcGetActivePlan();if(!plan)return;
  const g=plan.impactGroups.find(x=>x.id===gid);
  if(!g)return;
  g.currentState=(document.getElementById('rc-eg-current').value||'').trim();
  g.futureState=(document.getElementById('rc-eg-future').value||'').trim();
  g.requiredBehavior=(document.getElementById('rc-eg-behavior').value||'').trim();
  if(g.status==='confirmed'){
    // rcRegenerateActionsFromConfirmedGroups only creates actions for groups
    // that have none yet — drop this group's existing ones first so an edit
    // to Required Behavior actually regenerates fresh action text instead of
    // leaving the old behavior baked into their descriptions.
    plan.readinessActions=(plan.readinessActions||[]).filter(a=>a.groupId!==gid);
    rcRegenerateActionsFromConfirmedGroups(plan);
  }
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  rcPersist();
  const overlay=document.getElementById('rc-edit-group-overlay');
  if(overlay)overlay.remove();
  rcRenderCanvas();
}
// ── Add Group modal — same shell as Edit Group, plus a Name field, so
// creating a group is a full-width editing surface instead of four
// unstyled inputs stacked in a narrow inline strip. ──
function rcOpenAddGroupModal(){
  rcOpenGroupModal(
    'rc-add-group-overlay',
    'Add Group',
    `<div>
        <label style="font-size:10px;font-weight:500;color:var(--t2);display:block;margin-bottom:3px;">Group Name<span style="color:var(--red);margin-left:1px;">*</span></label>
        <input id="rc-ag-name" type="text" placeholder="e.g. Support Team" style="width:100%;height:30px;border:1px solid var(--divider);border-radius:5px;padding:0 8px;font-size:11px;font-family:var(--font);color:var(--t1);background:var(--bg);">
      </div>`
      +rcGroupModalFieldHtml('Current State','rc-ag-current','')
      +rcGroupModalFieldHtml('Future State','rc-ag-future','')
      +rcGroupModalFieldHtml('Required Behavior','rc-ag-behavior',''),
    `<button class="modal-cancel-btn" onclick="document.getElementById('rc-add-group-overlay').remove()">Cancel</button>
     <button class="modal-confirm-btn" onclick="rcSubmitAddGroup()">Add Group</button>`
  );
  document.getElementById('rc-ag-name').focus();
}
function rcSubmitAddGroup(){
  const plan=rcGetActivePlan();if(!plan)return;
  const name=(document.getElementById('rc-ag-name').value||'').trim();
  if(!name){showToast('Group name is required.','warn');return;}
  const g={
    id:'ig-'+Math.random().toString(36).slice(2),
    name,
    currentState:(document.getElementById('rc-ag-current').value||'').trim(),
    futureState:(document.getElementById('rc-ag-future').value||'').trim(),
    requiredBehavior:(document.getElementById('rc-ag-behavior').value||'').trim(),
    status:'confirmed',
    origin:'manual'
  };
  plan.impactGroups.push(g);
  rcRegenerateActionsFromConfirmedGroups(plan);
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  rcPersist();
  const overlay=document.getElementById('rc-add-group-overlay');
  if(overlay)overlay.remove();
  rcRenderCanvas();
}

// Single source of truth for "is this action row filled in enough to
// review" — used both to disable the checkbox at render time and to guard
// the toggle handler itself, so the two can never disagree.
function rcActionCanReview(a,groupLabel){
  return !!(groupLabel&&groupLabel.trim()&&a.actionType&&a.actionType.trim()&&a.description&&a.description.trim());
}
// ── Section 4 — Readiness Actions ───────────────────────────────────────
// Table layout: # | User Group | Action | Details | Reviewed. Reviewed is
// the last column deliberately — the PM reads who/what/details left to
// right and only then confirms, rather than a leading checkbox inviting a
// tick before the row's been read (see build discussion for rationale).
function rcRenderSection4(plan){
  const confirmedGroups=(plan.impactGroups||[]).filter(g=>g.status==='confirmed');
  if(!confirmedGroups.length){
    return '<div class="rc-empty">Confirm at least one impact group in Section 3 to generate readiness actions.</div>';
  }
  const groupsById={};(plan.impactGroups||[]).forEach(g=>{groupsById[g.id]=g;});
  const actions=plan.readinessActions||[];
  const pending=plan._aiActionsPending||{};
  const failed=plan._aiActionsFailed||{};
  const pendingShown=new Set();
  const failedShown=new Set();
  let sn=0;
  const rows=actions.map(a=>{
    const g=groupsById[a.groupId];
    const gid=g?g.id:null;
    // Loader-then-reveal fix: while a group's actions are being tailored,
    // suppress its real (deterministic) rows entirely and show one loading
    // row in their place instead of rendering both together - previously
    // the deterministic rows stayed fully visible/editable right alongside
    // the "Tailoring..." note, then got silently replaced a moment later.
    if(gid&&pending[gid]){
      if(pendingShown.has(gid))return '';
      pendingShown.add(gid);
      return `<tr><td colspan="6" class="rc-ai-pending-note-cell"><div class="rc-ai-pending-note"><i class="ti ti-sparkles" aria-hidden="true"></i> Tailoring ${e(g.name)}'s readiness actions with AI...</div></td></tr>`;
    }
    let failedRow='';
    if(gid&&failed[gid]&&!failedShown.has(gid)){
      failedShown.add(gid);
      failedRow=`<tr><td colspan="6" class="rc-ai-failed-note-cell"><div class="rc-ai-failed-note"><i class="ti ti-alert-circle" aria-hidden="true"></i> AI could not tailor ${e(g.name)}'s readiness actions - showing the baseline actions below.</div></td></tr>`;
    }
    sn++;
    const groupLabel=(a.groupName!=null?a.groupName:(g?g.name:''));
    // Can't meaningfully "review" a row that isn't even filled in yet —
    // require user group, action title, and details before the checkbox
    // is usable, rather than letting an empty placeholder row get ticked.
    const canReview=rcActionCanReview(a,groupLabel);
    const reviewedDisabled=(!canReview&&!a.reviewed);
    return `${failedRow}
      <tr>
        <td class="rc-action-sn">${sn}</td>
        <td><div class="ra-field-wrap"><div class="ra-field-text" id="rc-ft-action-group-${a.id}">${e(groupLabel)||'<span class="ra-field-empty">User group</span>'}</div><button class="ra-field-pencil" onclick="rcEditActionGroup('${a.id}')" title="Edit"><i class="ti ti-pencil" aria-hidden="true"></i></button></div></td>
        <td class="rc-action-type-cell"><div class="ra-field-wrap"><div class="ra-field-text" id="rc-ft-action-type-${a.id}">${e(a.actionType)||'<span class="ra-field-empty">Action title</span>'}</div><button class="ra-field-pencil" onclick="rcEditActionType('${a.id}')" title="Edit"><i class="ti ti-pencil" aria-hidden="true"></i></button></div></td>
        <td><div class="ra-field-wrap"><div class="ra-field-text" id="rc-ft-action-${a.id}">${e(a.description)||'<span class="ra-field-empty">Details</span>'}</div><button class="ra-field-pencil" onclick="rcEditActionField('${a.id}')" title="Edit"><i class="ti ti-pencil" aria-hidden="true"></i></button></div></td>
        <td class="rc-action-reviewed-cell"><input type="checkbox" ${a.reviewed?'checked':''} ${reviewedDisabled?'disabled':''} onchange="rcToggleActionReviewed('${a.id}',this.checked)" aria-label="Mark ${e(a.actionType)} reviewed" title="${reviewedDisabled?'Fill in user group, action, and details before marking reviewed':''}"></td>
        <td class="rc-action-del-cell"><button class="rc-row-del" onclick="rcDeleteActionRow('${a.id}')" title="Remove"><i class="ti ti-x" aria-hidden="true"></i></button></td>
      </tr>`;
  }).join('');
  return `
    <table class="rc-actions-table">
      <thead><tr><th>#</th><th>User Group</th><th>Action</th><th>Details</th><th>Reviewed</th><th></th></tr></thead>
      <tbody>${rows||'<tr><td colspan="6" class="rc-empty">No readiness actions yet.</td></tr>'}</tbody>
    </table>
    <div class="rc-add-link" onclick="rcAddActionRow()"><i class="ti ti-plus" aria-hidden="true"></i> Add action</div>
  `;
}
function rcAddActionRow(){
  const plan=rcGetActivePlan();if(!plan)return;
  const confirmedGroups=(plan.impactGroups||[]).filter(g=>g.status==='confirmed');
  if(!confirmedGroups.length)return;
  // groupId is kept only for internal bookkeeping (AI-enhancement targeting,
  // cleanup when a group is un-confirmed) — groupName is the actual
  // free-text label shown and edited in the table, independent of it.
  plan.readinessActions=(plan.readinessActions||[]).concat([{id:'ra-'+Math.random().toString(36).slice(2),groupId:confirmedGroups[0].id,groupName:confirmedGroups[0].name,actionType:'',description:'',reviewed:false}]);
  rcPersist();rcRenderCanvas();
}
function rcEditActionGroup(aid){
  const el=document.getElementById('rc-ft-action-group-'+aid);
  if(!el)return;
  const plan=rcGetActivePlan();
  const a=plan.readinessActions.find(x=>x.id===aid);
  const groupsById={};(plan.impactGroups||[]).forEach(g=>{groupsById[g.id]=g;});
  const current=(a.groupName!=null?a.groupName:((groupsById[a.groupId]||{}).name||''));
  el.parentElement.innerHTML=`<input type="text" class="ra-field-input" onblur="rcSaveActionGroupName('${aid}',this.value)" value="${e(current)}">`;
  el.parentElement.querySelector('input').focus();
}
function rcSaveActionGroupName(aid,value){
  const plan=rcGetActivePlan();if(!plan)return;
  const a=(plan.readinessActions||[]).find(x=>x.id===aid);
  if(a)a.groupName=value;
  rcPersist();rcRenderCanvas();
}
function rcEditActionType(aid){
  const el=document.getElementById('rc-ft-action-type-'+aid);
  if(!el)return;
  const plan=rcGetActivePlan();
  const a=plan.readinessActions.find(x=>x.id===aid);
  el.parentElement.innerHTML=`<input type="text" class="ra-field-input" onblur="rcSaveActionType('${aid}',this.value)" value="${e(a.actionType)}">`;
  el.parentElement.querySelector('input').focus();
}
function rcSaveActionType(aid,value){
  const plan=rcGetActivePlan();if(!plan)return;
  const a=plan.readinessActions.find(x=>x.id===aid);
  if(a)a.actionType=value;
  rcPersist();rcRenderCanvas();
}
function rcDeleteActionRow(aid){
  const plan=rcGetActivePlan();if(!plan)return;
  plan.readinessActions=(plan.readinessActions||[]).filter(a=>a.id!==aid);
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  rcPersist();rcRenderCanvas();
}
function rcEditActionField(aid){
  const el=document.getElementById('rc-ft-action-'+aid);
  if(!el)return;
  const plan=rcGetActivePlan();
  const a=plan.readinessActions.find(x=>x.id===aid);
  el.parentElement.innerHTML=`<textarea class="ra-field-input" onblur="rcSaveActionField('${aid}',this.value)">${e(a.description)}</textarea>`;
  el.parentElement.querySelector('textarea').focus();
}
function rcSaveActionField(aid,value){
  const plan=rcGetActivePlan();if(!plan)return;
  const a=plan.readinessActions.find(x=>x.id===aid);
  if(a)a.description=value;
  rcPersist();rcRenderCanvas();
}
function rcToggleActionReviewed(aid,checked){
  const plan=rcGetActivePlan();if(!plan)return;
  const a=plan.readinessActions.find(x=>x.id===aid);
  if(!a)return;
  const groupsById={};(plan.impactGroups||[]).forEach(g=>{groupsById[g.id]=g;});
  const groupLabel=(a.groupName!=null?a.groupName:((groupsById[a.groupId]||{}).name||''));
  const canReview=rcActionCanReview(a,groupLabel);
  if(checked&&!canReview){
    showToast('Fill in user group, action, and details before marking this reviewed.','warn');
    rcRenderCanvas();
    return;
  }
  a.reviewed=checked;
  const rec=rcComputeRecommendation(plan);
  plan.recommendation.systemValue=rec.value;
  plan.recommendation.reasoning=rec.reason;
  rcPersist();rcRenderCanvas();
}

// ── Section 5 — Launch Recommendation ───────────────────────────────────
function rcRenderSection5(plan){
  const rec=plan.recommendation;
  const rec2=rcComputeRecommendation(plan);
  rec.systemValue=rec2.value; // always re-derive, never trust a stale stored value
  rec.reasoning=rec2.reason;
  const isOverridden=!!(rec.override&&rec.override!==rec.systemValue);
  const displayValue=isOverridden?rec.override:rec.systemValue;
  const valueClass='rc-rec-'+displayValue.toLowerCase();
  const opts=['Ready','Conditional','Hold'];
  const showRationale=isOverridden;
  const rationaleField=showRationale
    ?`<div class="rc-field-label">Rationale <span class="rc-required">*</span></div><textarea class="ra-field-input" id="rc-override-rationale" onblur="rcSaveField('overrideRationale','recommendation.overrideRationale',this.value)" placeholder="Explain why this recommendation was overridden.">${e(rec.overrideRationale)}</textarea>`
    :'';
  const overrideNote=isOverridden?`<div class="rc-rec-override-note"><i class="ti ti-user-edit" aria-hidden="true"></i> Overridden by PM &middot; system value is ${e(rec.systemValue)}</div>`:'';
  // Loader-then-reveal fix: this block was already correctly gated
  // (loader OR result, never both at once) since the narrative has no
  // deterministic draft to prematurely show - it just had no failure
  // indicator. plan._aiNarrativeFailedSig already existed (set by
  // rcMaybeTriggerLaunchNarrative()) but was never read here.
  const currentSig=rcRecommendationSignature(plan);
  const narrativeCurrent=rec.aiNarrativeSig===currentSig;
  const narrativeFailed=!narrativeCurrent&&plan._aiNarrativeFailedSig===currentSig;
  const narrativeBlock=plan._aiNarrativePending
    ?`<div class="rc-field-label">AI Risk Narrative</div><div class="rc-ai-pending-note"><i class="ti ti-sparkles" aria-hidden="true"></i> Writing risk narrative with AI...</div>`
    :narrativeFailed
      ?`<div class="rc-field-label">AI Risk Narrative</div>${rcAiFailedNote('AI could not generate a risk narrative for this release.')}${rec.aiNarrative?`<div class="rc-readonly-block">${e(rec.aiNarrative)}</div><div class="rc-ai-pending-note" style="font-style:normal;">This is the last narrative generated - it may be out of date.</div>`:''}`
      :(rec.aiNarrative?`<div class="rc-field-label">AI Risk Narrative</div><div class="rc-readonly-block">${e(rec.aiNarrative)}</div>`:'');
  return `
    <div class="rc-card">
      <div class="rc-rec-value ${valueClass}${isOverridden?' rc-rec-overridden':''}">${e(displayValue)}</div>
      ${overrideNote}
      <div class="rc-field-label">Reasoning</div>
      ${rcFieldHtml('reasoning','recommendation.reasoning',true)}
      ${narrativeBlock}
      <div class="rc-field-label">Conditions to Clear</div>
      ${rcFieldHtml('conditionsToClear','recommendation.conditionsToClear',true)}
    </div>
    <div class="rc-card">
      <div class="rc-field-label">Override</div>
      <select class="rc-select" onchange="rcSetOverride(this.value)">
        <option value="" ${!rec.override?'selected':''}>No override - use system value</option>
        ${opts.map(o=>`<option value="${o}" ${rec.override===o?'selected':''}>${o}</option>`).join('')}
      </select>
      ${rationaleField}
    </div>

  `;
}
function rcSetOverride(v){
  const plan=rcGetActivePlan();if(!plan)return;
  plan.recommendation.override=v||null;
  rcPersist();rcRenderCanvas();
}

// ── Section 6 — Readiness Summary ───────────────────────────────────────
function rcRenderSection6(plan){
  rcEnsureWhatsShipping(plan);
  const s2=plan.releaseScope||{};
  const groupsById={};(plan.impactGroups||[]).forEach(g=>{groupsById[g.id]=g;});
  const actionsTable=(plan.readinessActions||[]).length
    ?`<table class="rc-actions-table"><thead><tr><th>#</th><th>User Group</th><th>Action</th><th>Details</th><th>Reviewed</th></tr></thead><tbody>${
        (plan.readinessActions||[]).map((a,i)=>{
          const g=groupsById[a.groupId];
          const groupLabel=(a.groupName!=null?a.groupName:(g?g.name:''));
          return `<tr>
            <td class="rc-action-sn">${i+1}</td>
            <td>${e(groupLabel)||'&mdash;'}</td>
            <td class="rc-action-type-cell">${e(a.actionType)}</td>
            <td>${e(a.description)}</td>
            <td class="rc-action-reviewed-cell"><input type="checkbox" ${a.reviewed?'checked':''} disabled aria-label="${e(a.actionType)} reviewed"></td>
          </tr>`;
        }).join('')
      }</tbody></table>`
    :'<p>No actions yet.</p>';
  const secDefs=[
    {n:1,title:'Change Overview',hasOutstanding:rcSectionOutstanding(plan,1),body:`<p>${e(plan.changeOverview.whatsChanging)}</p><p>${e(plan.changeOverview.whyNeeded)}</p>`},
    {n:2,title:'Release Scope',hasOutstanding:rcSectionOutstanding(plan,2),body:`<p><b>What's Shipping:</b> ${e(s2.whatsShipping)||'&mdash;'}</p><p><b>Squad:</b> ${e(s2.squad)||'&mdash;'}</p><p><b>Sprint Dates:</b> ${e(s2.sprintDates)||'&mdash;'}</p><p><b>Stories / Features / Points:</b> ${s2.storyCount||0} / ${s2.featureCount||0} / ${s2.storyPoints||0}</p><p><b>Rollout Type:</b> ${e(s2.rolloutType)}${s2.rolloutType==='Other'&&s2.rolloutTypeOther?' - '+e(s2.rolloutTypeOther):''}</p>`},
    {n:3,title:'Impact & Affected Groups',hasOutstanding:rcSectionOutstanding(plan,3),body:(plan.impactGroups||[]).filter(g=>g.status!=='removed').map(g=>`<div style="margin-bottom:10px;"><b>${e(g.name)}</b> - ${e(g.status)}<p><b>Current State:</b> ${e(g.currentState)||'&mdash;'}</p><p><b>Future State:</b> ${e(g.futureState)||'&mdash;'}</p><p><b>Required Behavior:</b> ${e(g.requiredBehavior)||'&mdash;'}</p></div>`).join('')||'<p>No groups.</p>'},
    {n:4,title:'Readiness Actions',hasOutstanding:rcSectionOutstanding(plan,4),body:actionsTable},
    {n:5,title:'Launch Recommendation',hasOutstanding:rcSectionOutstanding(plan,5),body:`<p><b>${e(plan.recommendation.override||plan.recommendation.systemValue)}</b></p><p>${e(plan.recommendation.reasoning)}</p>`}
  ];
  const visited=plan.visitedSections||[];
  const cards=secDefs.map(s=>{
    const notVisited=!visited.includes(s.n);
    const chipClass=notVisited?'rc-chip-neutral':(s.hasOutstanding?'rc-chip-warn':'rc-chip-ok');
    const chipLabel=notVisited?'Not reviewed':(s.hasOutstanding?'Needs review':'Reviewed');
    // Only Change Overview (§1) opens expanded by default — the rest stay
    // collapsed so the PM has to deliberately open and check each one
    // before reaching Finalize, rather than everything looking "already
    // reviewed" just because it's visibly expanded on landing.
    const expanded=s.n===1;
    return `
    <div class="rc-accordion-card">
      <div class="rc-accordion-hdr" onclick="rcToggleAccordion(this)">
        <span>${s.n}. ${e(s.title)}</span>
        <span class="rc-chip ${chipClass}">${chipLabel}</span>
      </div>
      <div class="rc-accordion-body" style="display:${expanded?'block':'none'};">${s.body}</div>
    </div>`;
  }).join('');
  const unreviewedCount=secDefs.filter(s=>!visited.includes(s.n)||s.hasOutstanding).length;
  const finalizeBtn=plan.status==='finalized'
    ?'<span class="rc-finalized-label"><i class="ti ti-check" aria-hidden="true"></i> Finalized</span>'
    :(unreviewedCount>0
      ?`<button class="modal-confirm-btn" disabled title="Review all sections before finalizing (${unreviewedCount} not reviewed)">Finalize</button>`
      :`<button class="modal-confirm-btn" onclick="rcFinalize()">Finalize</button>`);
  return `
    ${cards}
    <div class="rc-summary-footer">${finalizeBtn}</div>
  `;
}
function rcToggleAccordion(hdrEl){
  const body=hdrEl.parentElement.querySelector('.rc-accordion-body');
  if(!body)return;
  body.style.display=(body.style.display==='none')?'block':'none';
}

function rcFooterNav(n){
  const prevBtn=n>1?`<button class="modal-cancel-btn" onclick="rcGoTo(${n-1})">Back</button>`:'';
  const nextBtn=n<6?`<button class="modal-confirm-btn" onclick="rcGoTo(${n+1})">Continue</button>`:'';
  return `<div class="rc-footer-nav">${prevBtn}${nextBtn}</div>`;
}

// ── Finalize (§1.9) ──────────────────────────────────────────────────────
function rcFinalize(){
  const plan=rcGetActivePlan();
  if(!plan)return;
  plan.status='finalized';
  plan.finalizedAt=Date.now();
  plan.staleFlag=false;
  // One-way, session-level: Outcome Pulse becomes visible permanently once
  // ANY Readiness Plan in this session finalizes for the first time.
  if(typeof opUnlocked!=='undefined'&&!opUnlocked){
    opUnlocked=true;
    const tabOpEl=document.getElementById('tab-op');
    if(tabOpEl)tabOpEl.style.display='';
    if(typeof applyFeats==='function')applyFeats();
  }
  rcPersist();
  showToast('Readiness Plan finalized.','success');
  rcRenderCanvas();
}
function rcReopenForEdit(){
  const plan=rcGetActivePlan();
  if(!plan)return;
  plan.status='draft';
  plan.finalizedAt=null;
  rcPersist();
  rcRenderCanvas();
}

// ── Lineage drawer (§1.6) — nests INSIDE the readiness canvas, reusing the
// app's existing 440px right-drawer pattern (distinct from the full-frame
// readiness canvas itself). ──
function rcOpenLineageDrawer(){
  const plan=rcGetActivePlan();
  if(!plan)return;
  let drawer=document.getElementById('rc-lineage-drawer');
  if(!drawer){
    drawer=document.createElement('div');
    drawer.id='rc-lineage-drawer';
    drawer.className='rc-lineage-drawer';
    document.getElementById('rc-canvas').appendChild(drawer);
  }
  const rows=(plan.lineageSources||[]).map(src=>`
    <div class="rc-lineage-entry">
      <div class="rc-lineage-req">${e(src.requirementName)}</div>
      <div class="rc-lineage-chain">${e(src.stage)} &rsaquo; ${e(src.capability)} &rsaquo; ${e(src.feature)}</div>
      ${src.hypothesis&&src.hypothesis.metric?`<div class="rc-lineage-hyp">${e(src.hypothesis.metric)}: ${e(String(src.hypothesis.baseline!==null&&src.hypothesis.baseline!==undefined?src.hypothesis.baseline:'N/A'))} &rarr; ${e(String(src.hypothesis.target!==null&&src.hypothesis.target!==undefined?src.hypothesis.target:'N/A'))}</div>`:''}
      <div class="rc-lineage-stories">${src.storyIds.length} stor${src.storyIds.length===1?'y':'ies'}</div>
    </div>`).join('');
  drawer.innerHTML=`
    <div class="rc-lineage-hdr">
      <div>
        <div class="rc-lineage-tag">Lineage</div>
        <div class="rc-lineage-title">Lineage &amp; Sources</div>
      </div>
      <button onclick="rcCloseLineageDrawer()" title="Close" aria-label="Close"><i class="ti ti-x" aria-hidden="true"></i></button>
    </div>
    <div class="rc-lineage-body">${rows||'<div class="rc-empty">No lineage sources.</div>'}</div>
    <div class="rc-lineage-footer">Read-only lineage view</div>
  `;
  drawer.classList.add('open');
  trapFocus(drawer);
}
function rcCloseLineageDrawer(){
  const drawer=document.getElementById('rc-lineage-drawer');
  if(drawer)drawer.classList.remove('open');
}

// ── Kebab-menu-triggered modals (§2.3 / §2.5) — DESIGN_SYSTEM.md §8 full
// modal anatomy (trapFocus, capture-phase Escape, x at top:12/right:12,
// header padding-right:52px, Confirm-type purple CTA). ──
function rcShowReleaseCompleteModal(piPlan){
  const overlay=document.createElement('div');
  overlay.id='rc-complete-overlay';
  overlay.className='modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('rc-complete-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">
      <div style="width:30px;height:30px;border-radius:7px;background:var(--purple-pale);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
        <i class="ti ti-circle-check" style="font-size:15px;color:var(--purple);" aria-hidden="true"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;color:var(--t1);line-height:1.35;margin-bottom:6px;">Release Plan Complete</div>
        <div style="font-size:11px;color:var(--t3);line-height:1.6;">All sprints in <b>${e(piPlan.name)}</b> are planned and ready. You can now create an Adoption Readiness Plan to prepare this release for launch.<br><br>You can also do this anytime from the &#8942; menu &rarr; Readiness Plan.</div>
      </div>
    </div>
    <div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">
      <button class="modal-cancel-btn" onclick="document.getElementById('rc-complete-overlay').remove()">Later</button>
      <button style="background:var(--purple);color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="document.getElementById('rc-complete-overlay').remove();rcNavigateToPlan('${e(piPlan.id)}')">Create Readiness Plan &rarr;</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
}
function rcShowPostRegenModal(piPlan,readinessPlan){
  const overlay=document.createElement('div');
  overlay.id='rc-postregen-overlay';
  overlay.className='modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('rc-postregen-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">
      <div style="width:30px;height:30px;border-radius:7px;background:var(--purple-pale);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
        <i class="ti ti-refresh" style="font-size:15px;color:var(--purple);" aria-hidden="true"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;color:var(--t1);line-height:1.35;margin-bottom:6px;">Release Plan Updated</div>
        <div style="font-size:11px;color:var(--t3);line-height:1.6;"><b>${e(piPlan.name)}</b> has been regenerated. Its Adoption Readiness Plan has been unlocked and flagged for review. It still reflects the previous release scope.<br><br>Review it now, or come back anytime via &#8942; menu &rarr; Readiness Plan.</div>
      </div>
    </div>
    <div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">
      <button class="modal-cancel-btn" onclick="document.getElementById('rc-postregen-overlay').remove()">Later</button>
      <button style="background:var(--purple);color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="document.getElementById('rc-postregen-overlay').remove();rcNavigateToPlan('${e(piPlan.id)}')">Review Readiness Plan &rarr;</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
}
function rcShowRegenReadinessWarningModal(piPlan,readinessPlan){
  const overlay=document.createElement('div');
  overlay.id='rc-regenwarn-overlay';
  overlay.className='modal-overlay';
  overlay.innerHTML=`<div class="modal" style="max-width:420px;position:relative;">
    <button onclick="document.getElementById('rc-regenwarn-overlay').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;padding:3px;color:var(--t3);display:flex;align-items:center;border-radius:4px;z-index:1;" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    <div style="padding:20px 52px 20px 20px;display:flex;align-items:flex-start;gap:12px;">
      <div style="width:30px;height:30px;border-radius:7px;background:var(--purple-pale);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
        <i class="ti ti-refresh" style="font-size:15px;color:var(--purple);" aria-hidden="true"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:500;color:var(--t1);line-height:1.35;margin-bottom:6px;">Regenerate Release Plan?</div>
        <div style="font-size:11px;color:var(--t3);line-height:1.6;">This will reshuffle sprint assignments in <b>${e(piPlan.name)}</b> and unlock its Adoption Readiness Plan for review. Nothing is deleted, but you will need to reconfirm it before finalizing again.</div>
      </div>
    </div>
    <div style="padding:10px 20px 16px;display:flex;justify-content:flex-end;gap:6px;">
      <button class="modal-cancel-btn" onclick="document.getElementById('rc-regenwarn-overlay').remove()">Cancel</button>
      <button style="background:var(--purple);color:#fff;border:none;border-radius:5px;padding:5px 14px;font-size:11px;font-weight:700;font-family:var(--font);cursor:pointer;" onclick="document.getElementById('rc-regenwarn-overlay').remove();_pgRegenConfirmed=true;piGenerate();">Regenerate</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const _esc=function(ev){if(ev.key==='Escape'){overlay.remove();document.removeEventListener('keydown',_esc,true);}};
  document.addEventListener('keydown',_esc,true);
  trapFocus(overlay);
}

// ── §4 Feature Canvas hypothesis carry-forward — reusable helper called
// from BOTH normalizeAIHypothesis() call sites in capability-canvas.js.
// Searches Outcome Pulse's tracked feature history (scCanvas, keyed by
// feature name) for that feature's most recently logged actual. ──
function rcApplyHypothesisCarryForward(featureName,hyp){
  if(!hyp||!hyp.primary)return hyp;
  if(typeof scCanvas==='undefined'||!Array.isArray(scCanvas))return hyp;
  let bestActual=null,bestLoggedAt=-1;
  scCanvas.forEach(f=>{
    if(f.name!==featureName)return;
    if(!f.outcomeHypothesis||!f.outcomeHypothesis.primary)return;
    const p=f.outcomeHypothesis.primary;
    if(p.actual===null||p.actual===undefined)return;
    const t=p.loggedAt?new Date(p.loggedAt).getTime():0;
    if(t>=bestLoggedAt){bestLoggedAt=t;bestActual=p.actual;}
  });
  if(bestActual!==null){
    hyp.primary.baseline=bestActual;
    hyp.primary._rcNoPriorOutcomeWarning=false;
  } else {
    hyp.primary._rcNoPriorOutcomeWarning=true;
  }
  return hyp;
}

// ── Export DOCX (§H4) — reuses export-pi-docx.js's same mechanism: lazy-load
// the docx.js CDN library, build a Document with Paragraph/Table nodes, then
// Packer.toBlob + anchor-download. Kept local to this file (not a shared
// helper) since the section structure is entirely different from the PI
// export's. ──
var rcExportInFlight=false;
async function rcExportDocx(){
  const plan=rcGetActivePlan();
  if(!plan){showToast('No Readiness Plan to export.','info');return;}
  if(rcExportInFlight)return;
  rcExportInFlight=true;
  try{
    rcEnsureWhatsShipping(plan);
    if(typeof docx==='undefined'||!docx.Document){
      await new Promise((res,rej)=>{
        const s=document.createElement('script');
        s.src='https://cdn.jsdelivr.net/npm/docx@7.8.2/build/index.js';
        s.onload=res;s.onerror=()=>rej(new Error('Could not load docx library.'));
        document.head.appendChild(s);
      });
    }
    const {Document,Packer,Paragraph,TextRun,Table,TableRow,TableCell,
      HeadingLevel,AlignmentType,BorderStyle,WidthType,ShadingType,VerticalAlign,PageBreak}=docx;
    const _pc=(typeof getProductCtx==='function')?getProductCtx():{name:'Product',industry:''};
    const productName=_pc.name||'Product';
    const orgName=(typeof getOrgName==='function'&&getOrgName())?getOrgName():'';
    const NAVY='003087',PURPLE='5F1EBE',GREY='5C5B57',WHITE='FFFFFF';
    const bdr=c=>({style:BorderStyle.SINGLE,size:1,color:c||'CCCCCC'});
    const bdrs=c=>({top:bdr(c),bottom:bdr(c),left:bdr(c),right:bdr(c)});
    const gap=(n=80)=>new Paragraph({spacing:{before:n,after:0},children:[new TextRun('')]});
    const h2=(t)=>new Paragraph({heading:HeadingLevel.HEADING_2,spacing:{before:240,after:60},children:[new TextRun({text:t,font:'Arial',size:26,bold:true,color:NAVY})]});
    const h3=(t)=>new Paragraph({heading:HeadingLevel.HEADING_3,spacing:{before:180,after:40},children:[new TextRun({text:t,font:'Arial',size:22,bold:true,color:PURPLE})]});
    const body=(t)=>new Paragraph({spacing:{before:30,after:30},children:[new TextRun({text:String(t||''),font:'Arial',size:20,color:'2C2C2C'})]});
    const cell=(t,w,bg,bold,color)=>new TableCell({
      borders:bdrs('DDDDDD'),
      shading:bg?{fill:bg,type:ShadingType.CLEAR}:undefined,
      width:w?{size:w,type:WidthType.DXA}:undefined,
      margins:{top:80,bottom:80,left:120,right:120},
      verticalAlign:VerticalAlign.TOP,
      children:[new Paragraph({spacing:{before:0,after:0},children:[new TextRun({text:String(t||''),font:'Arial',size:18,bold:!!bold,color:color||'2C2C2C'})]})]
    });
    const hcell=(t,w)=>cell(t,w,NAVY,true,WHITE);

    await new Promise(r=>setTimeout(r,0));

    const piPlan=(typeof piPlans!=='undefined'?piPlans:[]).find(p=>p.id===plan.releasePlanId);
    const sprintCount=(piPlan&&piPlan.sprintCount)||(piPlan&&piPlan.sprints&&piPlan.sprints.length)||0;
    const statusLabel=plan.recommendation.override||plan.recommendation.systemValue;
    const s2=plan.releaseScope||{};

    const header=[
      new Paragraph({spacing:{before:0,after:20},children:[new TextRun({text:(orgName?orgName+' · ':'')+productName,font:'Arial',size:18,color:GREY})]}),
      new Paragraph({spacing:{before:0,after:10},children:[new TextRun({text:'Change Readiness Brief',font:'Arial',size:40,bold:true,color:NAVY})]}),
      new Paragraph({spacing:{before:0,after:10},children:[new TextRun({text:plan.releasePlanName||'Release Plan',font:'Arial',size:24,bold:true,color:PURPLE})]}),
      new Paragraph({spacing:{before:0,after:20},children:[new TextRun({text:'Generated from '+APP_NAME+' · Squad '+(s2.squad||'—')+' · Sprint plan of '+sprintCount+' · '+new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' · Status: '+statusLabel+' · Classification: Internal · Confidential',font:'Arial',size:18,color:GREY})]}),
      gap(20),new Paragraph({children:[new PageBreak()]})
    ];

    // 1. Change Overview
    const s1=[
      h2('1. Change Overview'),
      new Paragraph({spacing:{before:0,after:6},children:[new TextRun({text:"What's Changing",font:'Arial',size:20,bold:true,color:NAVY})]}),
      body(plan.changeOverview.whatsChanging),
      new Paragraph({spacing:{before:120,after:6},children:[new TextRun({text:"Why It's Needed",font:'Arial',size:20,bold:true,color:NAVY})]}),
      body(plan.changeOverview.whyNeeded),
      new Paragraph({spacing:{before:120,after:6},children:[new TextRun({text:"What It Improves",font:'Arial',size:20,bold:true,color:NAVY})]})
    ];
    const metricRows=[new TableRow({children:[hcell('Target Metric',4000),hcell('Baseline',3680),hcell('Target',3680)]})];
    (plan.changeOverview.metrics||[]).forEach(m=>{
      metricRows.push(new TableRow({children:[cell(m.metricName,4000),cell(m.baseline,3680),cell(m.target,3680)]}));
    });
    if((plan.changeOverview.metrics||[]).length===0)metricRows.push(new TableRow({children:[cell('No metrics yet.',11360)]}));
    s1.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[4000,3680,3680],rows:metricRows}));
    s1.push(gap(30));s1.push(new Paragraph({children:[new PageBreak()]}));

    // 2. Release Scope
    const s2Blocks=[
      h2('2. Release Scope'),
      new Paragraph({spacing:{before:0,after:6},children:[new TextRun({text:"What's Shipping",font:'Arial',size:20,bold:true,color:NAVY})]}),
      body(s2.whatsShipping||'—'),
      body('Rollout Type: '+(s2.rolloutType||'')+(s2.rolloutType==='Other'&&s2.rolloutTypeOther?' - '+s2.rolloutTypeOther:'')),
      body('Squad / Sprint: '+(s2.squad||'—')),
      body('Sprint Dates: '+(s2.sprintDates||'—')),
      gap(30),new Paragraph({children:[new PageBreak()]})
    ];

    // 3. Impact & Affected Groups
    const s3=[h2('3. Impact & Affected Groups'),body('The groups below are affected by this release and require the readiness actions in Section 4.')];
    const groupRows=[new TableRow({children:[hcell('Group',2200),hcell('Current State',3000),hcell('Future State',3000),hcell('Required Behavior',2360),hcell('Status',800)]})];
    (plan.impactGroups||[]).filter(g=>g.status!=='removed').forEach(g=>{
      groupRows.push(new TableRow({children:[cell(g.name,2200),cell(g.currentState,3000),cell(g.futureState,3000),cell(g.requiredBehavior,2360),cell(g.status,800)]}));
    });
    if((plan.impactGroups||[]).filter(g=>g.status!=='removed').length===0)groupRows.push(new TableRow({children:[cell('No groups.',11360)]}));
    s3.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[2200,3000,3000,2360,800],rows:groupRows}));
    s3.push(gap(30));s3.push(new Paragraph({children:[new PageBreak()]}));

    // 4. Readiness Actions
    const s4=[h2('4. Readiness Actions'),body('The following readiness actions must be completed to support the impact groups above.')];
    const actionRows=[new TableRow({children:[hcell('Group',2200),hcell('Action Type',2200),hcell('Suggested Action',6960)]})];
    const groupsById={};(plan.impactGroups||[]).forEach(g=>{groupsById[g.id]=g;});
    (plan.readinessActions||[]).forEach(a=>{
      const g=groupsById[a.groupId];
      actionRows.push(new TableRow({children:[cell(g?g.name:'',2200),cell(a.actionType,2200),cell(a.description,6960)]}));
    });
    if((plan.readinessActions||[]).length===0)actionRows.push(new TableRow({children:[cell('No actions yet.',11360)]}));
    s4.push(new Table({width:{size:11360,type:WidthType.DXA},columnWidths:[2200,2200,6960],rows:actionRows}));
    s4.push(gap(30));s4.push(new Paragraph({children:[new PageBreak()]}));

    // 5. Launch Recommendation
    const isOverridden=!!(plan.recommendation.override&&plan.recommendation.override!==plan.recommendation.systemValue);
    const s5=[
      h2('5. Launch Recommendation'),
      new Paragraph({spacing:{before:0,after:10},children:[new TextRun({text:statusLabel,font:'Arial',size:28,bold:true,color:NAVY})]}),
      body('This release is assessed as '+statusLabel+' for launch.'),
      new Paragraph({spacing:{before:120,after:6},children:[new TextRun({text:'Reasoning',font:'Arial',size:20,bold:true,color:NAVY})]}),
      body(plan.recommendation.reasoning),
      new Paragraph({spacing:{before:120,after:6},children:[new TextRun({text:'Condition to Clear',font:'Arial',size:20,bold:true,color:NAVY})]}),
      body(plan.recommendation.conditionsToClear),
      new Paragraph({spacing:{before:120,after:6},children:[new TextRun({text:'Override rationale (if applicable)',font:'Arial',size:20,bold:true,color:NAVY})]}),
      body(isOverridden?plan.recommendation.overrideRationale:'Not applicable - no override on this recommendation.')
    ];

    const closing=[
      gap(30),
      body('This brief was generated from the '+APP_NAME+'’s Adoption Readiness plan for '+(plan.releasePlanName||'this release')+', traceable back to its source requirement briefs and Discovery Map lineage.')
    ];

    const doc=new Document({
      styles:{default:{document:{run:{font:'Arial',size:20}}},
        paragraphStyles:[
          {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',run:{size:26,bold:true,font:'Arial',color:NAVY},paragraph:{spacing:{before:240,after:60},outlineLevel:1}},
          {id:'Heading3',name:'Heading 3',basedOn:'Normal',next:'Normal',run:{size:22,bold:true,font:'Arial',color:PURPLE},paragraph:{spacing:{before:180,after:40},outlineLevel:2}}
        ]},
      sections:[{
        properties:{page:{size:{width:16838,height:11906},margin:{top:1008,right:1008,bottom:1008,left:1008}}},
        children:[...header,...s1,...s2Blocks,...s3,...s4,...s5,...closing]
      }]
    });
    const fname=(plan.releasePlanName||'Change-Readiness-Brief').replace(/\s+/g,'-')+'-Readiness-Brief.docx';
    const blob=await Packer.toBlob(doc);
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=fname;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Readiness Brief exported.','success');
  }catch(err){
    showToast('Export failed: '+err.message,'error');
    console.error('Readiness DOCX export error:',err);
  }finally{
    rcExportInFlight=false;
  }
}
