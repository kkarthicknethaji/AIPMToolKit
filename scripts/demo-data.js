// DEMO MODE — synthetic data for UI testing without an API key
// Product: Focusly — a B2C productivity & focus app (Subscription, Scaling)
// Product: OrderHub — a B2B SaaS omnichannel order orchestration platform (Capability-Driven)
// Product: Unified Cart & Checkout — a B2C multi-business booking/commerce platform (Outcome-Based)

// Shared demo release-plan name generator — current year/quarter, e.g. 'REL-2026-Q3'.
function _genDemoReleasePlanName(){return'REL-'+new Date().getFullYear()+'-Q'+Math.ceil((new Date().getMonth()+1)/3);}

// ── Dispatcher — loads the selected demo product dataset ──
function loadDemoData(productKey){
  _snapshotPreDemoState();
  if(productKey==='orderhub'){_demoLoadOrderHub();return;}
  if(productKey==='unifiedcart'){_demoLoadUnifiedCart();return;}
  _demoLoadFocusly();
}

// ── Outcome Verification Loop: demo hypothesis population (Phase D) ──
// Attaches a realistic outcomeHypothesis to a small, named subset of each
// demo product's features, by exact name match against scCanvas (already
// populated by this point in each loader). Deliberately covers every
// signal state (aligned/opposed/no-change/awaiting/not-applicable) plus a
// deliberately empty (no hypothesis) feature, so the Outcome Pulse tab
// demos meaningfully on first load rather than showing an empty state.
// entries: array of {name, primary:{...}, signal, actual} — signal/actual
// are merged onto primary here rather than repeated in every call site.
function _demoAttachOutcomeHypotheses(entries){
  entries.forEach(function(entry){
    const feat=scCanvas.find(f=>f.name===entry.name);
    if(!feat)return;
    const p=entry.primary;
    feat.outcomeHypothesis={
      primary:{
        metric:p.metric,unit:p.unit,customLabel:p.customLabel||'',
        baseline:p.baseline,target:p.target,
        direction:(typeof computeDirection==='function')?computeDirection(p.baseline,p.target):null,
        directionSource:'computed',rationale:p.rationale,source:'ai',
        actual:entry.actual!==undefined?entry.actual:null,
        signal:entry.signal!==undefined?entry.signal:null,
        loggedAt:(entry.actual!==undefined&&entry.actual!==null)?new Date(Date.now()-1000*60*60*24*Math.floor(Math.random()*10+1)).toISOString():null
      },
      secondary:p.secondary||[]
    };
  });
}

// ── Set NSM baseline/target/actual/updatedAt on the just-generated gData.nsm ──
function _demoSetNsmTracking(baseline,target,actual){
  if(!gData||!gData.nsm)return;
  gData.nsm.baseline=baseline;
  gData.nsm.target=target;
  gData.nsm.actual=actual;
  gData.nsm.updatedAt=new Date(Date.now()-1000*60*60*24*2).toISOString();
}

// Capture the user's real profile state before the first demo load overwrites
// it. Only snapshots once - if already in demo mode (switching between demo
// products), the existing snapshot of the user's real data is preserved.
function _snapshotPreDemoState(){
  if(_preDemoState!==null)return; // already in demo mode - don't overwrite real snapshot
  _preDemoState={
    companyProfile: companyProfile ? JSON.parse(JSON.stringify(companyProfile)) : null,
    productProfiles: productProfiles ? JSON.parse(JSON.stringify(productProfiles)) : [],
    activeProfileId: activeProfileId
  };
}

// Create (if not already present) the clickable "DEMO ✕" badge in the header.
// Clicking it calls exitDemoMode() — confirms, then clears demo mode and
// restores the user's pre-demo profile state.
function _showDemoBadge(){
  let badge=document.getElementById('demo-badge');
  if(!badge){
    badge=document.createElement('span');
    badge.id='demo-badge';
    badge.style.cssText='font-size:9px;font-weight:600;letter-spacing:0.08em;background:#E1F5EE;color:#085041;border:1px solid #5DCAA5;border-radius:20px;padding:2px 6px 2px 8px;margin-left:8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;';
    badge.title='Exit demo mode';
    badge.onclick=function(){if(typeof exitDemoMode==='function')exitDemoMode();};
    badge.innerHTML='DEMO <i class="ti ti-x" style="font-size:9px;" aria-hidden="true"></i>';
    const hdrL=document.querySelector('.hdr-l');
    if(hdrL)hdrL.appendChild(badge);
  }
}

function _demoLoadFocusly(){
  // ── 1. Populate company profile and product profiles ──

  // Company profile — Focusly Inc.
  companyProfile={
    companyName:'Focusly Inc.',
    companyIndustry:'Technology & Software',
    companyUrl:'https://focusly.app',
    companyStrategy:'Build the leading focus and deep work platform for knowledge workers. Grow through habit formation, social accountability, and premium subscription conversion.',
    companyContext:'Early-stage B2C SaaS. Primary growth lever is organic word-of-mouth from power users. Subscription model with freemium entry point.',
    companyRefLink:'',
    companyDocs:[]
  };

  // Focusly product profile
  const focuslyProfile={
    id:'demo-focusly',
    productName:'Focusly',
    productDesc:'A B2C consumer productivity app that helps knowledge workers build deep focus habits through session tracking, distraction blocking, and habit loop reinforcement.',
    industry:'Technology & Software',
    productType:'B2C Product',
    kpis:'DAU, session length, 7-day retention',
    problem:'High drop-off after first week - users complete onboarding but never form a habit',
    icp:'Knowledge workers and students, 22-40, remote-first',
    additionalContext:'',
    refLink:'https://focusly.app',
    docs:[]
  };

  // OrderHub — B2B SaaS omnichannel order orchestration for large-format retailers
  const orderHubProfile={
    id:'demo-orderhub',
    productName:'OrderHub',
    productDesc:'A B2B SaaS order orchestration platform for large-format omnichannel retailers, coordinating order capture, real-time inventory promises, warehouse and store fulfilment, last-mile delivery, and returns across web, app, and in-store channels.',
    industry:'Retail',
    productType:'B2B SaaS',
    kpis:'Order fill rate, on-time-in-full (OTIF), return processing time',
    problem:'Customers see inaccurate stock promises at checkout, causing failed promises and order cancellations downstream',
    icp:'Omnichannel operations and fulfilment teams at large-format home, furniture, and big-box retailers',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  // MindBridge — extra demo profile for dropdown testing
  const mindBridgeProfile={
    id:'demo-mindbridge',
    productName:'MindBridge',
    productDesc:'A B2C mental wellness app offering guided CBT exercises, mood tracking, and therapist-matching for adults managing anxiety and stress.',
    industry:'Health & Life Sciences',
    productType:'B2C Product',
    kpis:'Daily active users, session completion rate, 30-day retention',
    problem:'Users complete intake assessment but disengage before completing first therapy module',
    icp:'Adults 25-45 experiencing work-related stress or mild anxiety, not in clinical care',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  const oneCartProfile={
    id:'demo-onecart',
    productName:'OneCart',
    productDesc:'A B2C unified cart and checkout platform for a multi-business consumer group (theme parks, resorts, dining, merchandise, and experiences), letting guests discover, assemble, and pay for items across business lines in a single transaction.',
    industry:'Travel & Hospitality',
    productType:'B2C Product',
    kpis:'Cross-business attach rate, unified checkout completion rate, average order value per booking',
    problem:'Guests booking a park ticket rarely add hotel, dining, or merchandise in the same transaction because each business line has its own checkout, causing fragmented bookings and lost attach revenue',
    icp:'Leisure travellers and families planning a multi-day visit across parks, hotels, dining, and experiences',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  productProfiles=[focuslyProfile, orderHubProfile, oneCartProfile, mindBridgeProfile];
  activeProfileId='demo-focusly';

  // Keep seg vars for backward compat with any downstream that still reads them
  seg.industry='Technology & Software';
  seg.productType='B2C Product';

  // ── 2. Inject gData (KPI tree) ──
  gData={
    approach:'outcome-based',
    nsm:{
      metric:'Weekly Active Focus Sessions per User',
      definition:'Number of focus sessions (>= 20 min) completed per active user per week'
    },
    measurementModel:{
      modelName:'Consumer Growth Model',
      frameworks:['APQC PCF','First principles'],
      rationale:'Focusly is a B2C consumer productivity app — the standard acquisition-to-retention growth funnel is the correct measurement lens for this product.'
    },
    stages:[
      {id:'acquisition',label:'Acquisition',l1_metrics:[
        {name:'Organic Install Rate',why:'Measures word-of-mouth and SEO effectiveness — lowest CAC channel',
          l2_metrics:[
            {name:'App Store Conversion Rate',why:'Installs per store page view — optimisation lever with zero media spend',
              l3_metrics:[{name:'Screenshot A/B Win Rate',why:'Winning creatives drive install conversion at zero media cost',l4_metrics:[]},{name:'Review Sentiment Score',why:'Negative reviews suppress store ranking and organic install rate',l4_metrics:[]},{name:'Keyword Rank for Focus Apps',why:'Higher rank captures high-intent organic installs at zero CAC',l4_metrics:[]}]},
            {name:'Referral Install Rate',why:'% of installs from in-app share links — compound growth signal',
              l3_metrics:[{name:'Share Link Click-Through Rate',why:'Low CTR signals weak referral mechanic or share incentive',l4_metrics:[]},{name:'Referred User Activation Rate',why:'Measures quality of referral traffic — not just volume',l4_metrics:[]}]}
          ]},
        {name:'Paid Trial Start Rate',why:'Conversion from ad impression to free trial — quality of paid acquisition',
          l2_metrics:[
            {name:'Ad-to-Install Conversion Rate',why:'Cost efficiency of paid channels',
              l3_metrics:[{name:'CPI by Channel',why:'Channel-level CPI identifies overspend and reallocation opportunities',l4_metrics:[]},{name:'Creative CTR',why:'Creative effectiveness determines ad cost and install volume',l4_metrics:[]}]},
            {name:'Trial Opt-in Rate',why:'% of installers who start a free trial within 24h',
              l3_metrics:[{name:'Onboarding Completion Rate',why:'Incomplete onboarding predicts first-session abandonment',l4_metrics:[]},{name:'Paywall Impression Rate',why:'Low impression rate means conversion funnel never starts',l4_metrics:[]}]}
          ]},
        {name:'ICP Fit Score at Install',why:'Measures quality of acquired users against ideal customer profile',
          l2_metrics:[
            {name:'Self-Reported Use Case Match',why:'% of users whose stated goal matches a supported Focusly mode',
              l3_metrics:[{name:'Onboarding Survey Completion',why:'Survey drives personalisation — incomplete data degrades it',l4_metrics:[]},{name:'Use Case Distribution',why:'Reveals which use cases activate users — informs positioning',l4_metrics:[]}]},
            {name:'Platform-Inferred Engagement Propensity',why:'Device and behaviour signals predicting likelihood to form focus habit',
              l3_metrics:[{name:'Session Depth on Day 1',why:'Deep first session predicts Day 2 return and habit formation',l4_metrics:[]},{name:'Notification Permission Grant Rate',why:'No permission means no re-engagement lever after Day 1',l4_metrics:[]}]}
          ]}
      ]},
      {id:'activation',label:'Activation',l1_metrics:[
        {name:'First Focus Session Completion Rate',why:'Core aha moment — users who complete one session are 3x more likely to return',
          l2_metrics:[
            {name:'Time to First Session',why:'Hours from install to first completed session — compression = higher activation',
              l3_metrics:[{name:'Setup Completion Rate',why:'Incomplete setup prevents first value — directly causes D1 churn',l4_metrics:[]},{name:'First Session Start Rate',why:'Users who never start first session never convert to habit',l4_metrics:[]},{name:'Session Abandonment Rate',why:'Mid-session exits reveal specific friction points in onboarding',l4_metrics:[]}]},
            {name:'Session Quality Score on Day 1',why:'Composite of session length, interruptions, and post-session rating',
              l3_metrics:[{name:'Average Day 1 Session Length',why:'Longer first sessions correlate with Day 7 retention',l4_metrics:[]},{name:'Distraction Block Activation Rate',why:'Core feature adoption — non-adoption signals onboarding failure',l4_metrics:[]}]}
          ]},
        {name:'Onboarding Completion Rate',why:'% of users completing all setup steps — direct predictor of week-1 engagement',
          l2_metrics:[
            {name:'Goal-Setting Completion Rate',why:'Users who set a focus goal are 2x more likely to return on Day 2',
              l3_metrics:[{name:'Goal Category Selection Rate',why:'Goal selection personalises experience — drives habit relevance',l4_metrics:[]},{name:'Daily Target Commitment Rate',why:'Commitment at setup anchors daily engagement loop',l4_metrics:[]}]},
            {name:'Integration Setup Rate',why:'Calendar/Slack integrations correlate with 40% higher 30-day retention',
              l3_metrics:[{name:'Calendar Connection Rate',why:'Calendar integration enables scheduling — drives session regularity',l4_metrics:[]},{name:'Do Not Disturb Setup Rate',why:'DND setup signals intent to use product in real work context',l4_metrics:[]}]}
          ]},
        {name:'Day 2 Return Rate',why:'Single strongest predictor of 30-day retention after first session',
          l2_metrics:[
            {name:'Day 2 Session Start Rate',why:'% of Day 1 activators who return and start a session on Day 2',
              l3_metrics:[{name:'Push Notification Open Rate D1',why:'D1 open rate determines whether re-engagement loop activates',l4_metrics:[]},{name:'Streak Initiation Rate',why:'First streak started within Day 2 predicts 7-day retention',l4_metrics:[]}]},
            {name:'Second Session Quality Score',why:'Quality of Day 2 session predicts habit formation trajectory',
              l3_metrics:[{name:'Session Length vs Day 1',why:'Declining length signals engagement drop before churn occurs',l4_metrics:[]},{name:'Feature Discovery Rate on Day 2',why:'Second-day discovery of secondary features drives stickiness',l4_metrics:[]}]}
          ]}
      ]},
      {id:'engagement',label:'Engagement',l1_metrics:[
        {name:'Weekly Active Focus Sessions',why:'North Star input metric — measures active habit strength',
          l2_metrics:[
            {name:'Sessions per Active User per Week',why:'Habit density — 3+ sessions = power user threshold',
              l3_metrics:[{name:'Mon-Fri Session Consistency Score',why:'Workday consistency is the core habit formation signal',l4_metrics:['Morning session rate','Afternoon session rate']},{name:'Weekend Session Rate',why:'Weekend usage distinguishes habit from task-driven behaviour',l4_metrics:[]}]},
            {name:'Average Session Length',why:'Longer sessions = deeper focus habit and higher perceived value',
              l3_metrics:[{name:'25-min Pomodoro Completion Rate',why:'Completion signals technique adoption — drives session quality',l4_metrics:[]},{name:'Deep Work Session Rate (>60 min)',why:'Long sessions indicate advanced engagement and premium intent',l4_metrics:[]}]}
          ]},
        {name:'Feature Adoption Depth',why:'Users who adopt 3+ features have 5x higher LTV',
          l2_metrics:[
            {name:'Distraction Blocker Adoption Rate',why:'Core differentiating feature — adoption predicts premium conversion',
              l3_metrics:[{name:'Blocker Active Sessions Rate',why:'Active blocking during sessions measures distraction control value',l4_metrics:[]},{name:'Custom Blocklist Setup Rate',why:'Customisation signals personalised commitment to focus behaviour',l4_metrics:[]}]},
            {name:'Focus Mode Variety Score',why:'Users who explore multiple modes have higher satisfaction scores',
              l3_metrics:[{name:'Deep Work Mode Usage',why:'Mode adoption indicates users found core differentiated value',l4_metrics:['Custom timer use','Ambient sound pairing']},{name:'Sprint Mode Usage',why:'Sprint usage signals power-user behaviour and upsell opportunity',l4_metrics:[]}]}
          ]},
        {name:'Social & Accountability Engagement',why:'Accountability features drive 60% higher 90-day retention',
          l2_metrics:[
            {name:'Accountability Partner Connection Rate',why:'% of users with at least one connected accountability partner',
              l3_metrics:[{name:'Partner Invite Sent Rate',why:'Social invites drive viral growth and accountability retention',l4_metrics:[]},{name:'Shared Goal Creation Rate',why:'Shared goals increase commitment and reduce churn via accountability',l4_metrics:[]}]},
            {name:'Community Challenge Participation Rate',why:'Weekly challenge participants show 2x session frequency',
              l3_metrics:[{name:'Challenge Join Rate',why:'Challenge participation drives community stickiness and retention',l4_metrics:[]},{name:'Challenge Completion Rate',why:'Completions reinforce habit loop and social proof',l4_metrics:[]}]}
          ]}
      ]},
      {id:'retention',label:'Retention',l1_metrics:[
        {name:'30-Day Retention Rate',why:'Primary retention health signal — industry benchmark is 25-35% for productivity apps',
          l2_metrics:[
            {name:'Week 2-4 Session Consistency',why:'Users with consistent week 2-4 sessions have 80% 90-day retention',
              l3_metrics:[{name:'7-Day Streak Completion Rate',why:'Week-long streaks are the primary retention signal for habit apps',l4_metrics:[]},{name:'Re-engagement Rate After Miss',why:'Recovery rate determines whether churn follows a missed day',l4_metrics:[]}]},
            {name:'Subscription Conversion Rate',why:'Free-to-paid conversion in first 30 days signals strong value realisation',
              l3_metrics:[{name:'Trial-to-Paid Conversion Rate',why:'Primary monetisation gate — low rate signals value prop failure',l4_metrics:[]},{name:'Paywall Engagement Rate',why:'Engagement before paywall predicts conversion intent',l4_metrics:[]}]}
          ]},
        {name:'90-Day Active Rate',why:'Defines long-term habit formation — the core product promise',
          l2_metrics:[
            {name:'Monthly Focus Goal Achievement Rate',why:'Users who hit their monthly goal renew at 3x the rate of those who miss',
              l3_metrics:[{name:'Goal Completion Rate',why:'Completed goals are the outcome users paid for — drives NPS',l4_metrics:[]},{name:'Goal Adjustment Rate',why:'Adjustments indicate active engagement with product over time',l4_metrics:[]}]},
            {name:'NPS and Satisfaction Score',why:'NPS >40 correlates with organic referral and lower churn',
              l3_metrics:[{name:'In-App NPS Score',why:'Leading indicator of renewal intent and word-of-mouth referral',l4_metrics:[]},{name:'App Store Rating Trend',why:'Rating trend affects organic ranking and install conversion',l4_metrics:[]}]}
          ]},
        {name:'Churn Rate',why:'Direct revenue impact — 1% churn reduction = significant LTV improvement at scale',
          l2_metrics:[
            {name:'Voluntary Cancellation Rate',why:'User-initiated cancellations indicate value gap or habit failure',
              l3_metrics:[{name:'Cancellation Reason Distribution',why:'Reason data targets retention interventions at root cause',l4_metrics:[]},{name:'Win-Back Campaign Conversion Rate',why:'Churned user recovery reduces net churn impact',l4_metrics:[]}]},
            {name:'Involuntary Churn Rate',why:'Payment failures indicate billing friction — recoverable with right tooling',
              l3_metrics:[{name:'Failed Payment Recovery Rate',why:'Involuntary churn is recoverable — low recovery wastes revenue',l4_metrics:[]},{name:'Dunning Email Open Rate',why:'Low open rate means involuntary churn intervention fails silently',l4_metrics:[]}]}
          ]}
      ]}
    ]
  };

  // ── 3. Inject capStore ──
  capStore={};
  capStoreInvalidated=false;

  const addCap=(stageId,metricName,stageLabel,capabilities)=>{
    const key=stageId+'||'+metricName;
    capStore[key]={metricName,stageLabel,stageId,capabilities};
  };

  addCap('acquisition','Organic Install Rate','Acquisition',[
    {name:'App Store Optimisation Engine',why:'Improves discoverability and conversion on the app store listing',
      subCaps:[{name:'Visual asset testing',why:'A/B screenshots and preview video optimisation'},{name:'Keyword & review management',why:'ASO ranking and social proof signals'}],
      featStore:{top:[
        {name:'Screenshot A/B testing dashboard',why:'Test up to 4 screenshot variants against install rate per keyword segment',selected:false,metric:'Organic Install Rate',stage:'Acquisition',cap:'App Store Optimisation Engine',subCap:null},
        {name:'Review response templates',why:'Pre-built responses to common 1-3 star reviews — improves average rating within 30 days',selected:false,metric:'Organic Install Rate',stage:'Acquisition',cap:'App Store Optimisation Engine',subCap:null},
        {name:'Keyword rank tracker with alerts',why:'Daily rank monitoring for top 20 target keywords with Slack alert on drops',selected:false,metric:'Organic Install Rate',stage:'Acquisition',cap:'App Store Optimisation Engine',subCap:null}
      ]}},
    {name:'Referral & Sharing Engine',why:'Converts satisfied users into acquisition channels through in-product sharing',
      subCaps:null,
      featStore:{top:[
        {name:'Post-session share prompt',why:'Triggered after a user completes a 3+ session streak — highest share intent moment',selected:true,metric:'Organic Install Rate',stage:'Acquisition',cap:'Referral & Sharing Engine',subCap:null},
        {name:'Personalised referral link with focus stats',why:'Share link includes sender\'s focus stats — social proof drives higher install conversion',selected:false,metric:'Organic Install Rate',stage:'Acquisition',cap:'Referral & Sharing Engine',subCap:null},
        {name:'Referral reward tracker',why:'Shows inviter their reward progress — sustains ongoing referral behaviour',selected:false,metric:'Organic Install Rate',stage:'Acquisition',cap:'Referral & Sharing Engine',subCap:null}
      ]}},
    {name:'SEO & Content Discovery',why:'Drives top-of-funnel organic traffic through search and content',
      subCaps:null,featStore:{}}
  ]);

  addCap('activation','First Focus Session Completion Rate','Activation',[
    {name:'Frictionless First Session Flow',why:'Reduces setup time to under 2 minutes so users reach value before drop-off',
      subCaps:[{name:'Smart defaults engine',why:'Pre-configures session settings based on onboarding answers'},{name:'Progressive disclosure UI',why:'Shows only essential controls on first session'}],
      featStore:{top:[
        {name:'One-tap session start from home screen',why:'Eliminates setup friction — users start their first session with a single tap',selected:true,metric:'First Focus Session Completion Rate',stage:'Activation',cap:'Frictionless First Session Flow',subCap:null},
        {name:'Smart default session duration',why:'Pre-selects 25 min Pomodoro based on ICP data — removes decision paralysis',selected:true,metric:'First Focus Session Completion Rate',stage:'Activation',cap:'Frictionless First Session Flow',subCap:null},
        {name:'First session completion celebration',why:'Micro-celebration on session end reinforces the behaviour loop immediately',selected:false,metric:'First Focus Session Completion Rate',stage:'Activation',cap:'Frictionless First Session Flow',subCap:null}
      ]}},
    {name:'Contextual Onboarding Nudges',why:'Surfaces the right tip at the right moment during the first session',
      subCaps:null,featStore:{}},
    {name:'Distraction Blocker Quick Setup',why:'Activating the blocker on session 1 is the highest predictor of week-1 retention',
      subCaps:null,featStore:{top:[
        {name:'One-tap distraction blocker activation',why:'Single toggle activates pre-configured app blocks — no list-building on Day 1',selected:false,metric:'First Focus Session Completion Rate',stage:'Activation',cap:'Distraction Blocker Quick Setup',subCap:null},
        {name:'Suggested block list by use case',why:'Pre-populated block lists for Study, Work, Creative — reduces setup time by 80%',selected:false,metric:'First Focus Session Completion Rate',stage:'Activation',cap:'Distraction Blocker Quick Setup',subCap:null},
        {name:'Block effectiveness summary post-session',why:'Shows which apps were blocked and time saved — reinforces value of the feature',selected:false,metric:'First Focus Session Completion Rate',stage:'Activation',cap:'Distraction Blocker Quick Setup',subCap:null}
      ]}}
  ]);

  addCap('engagement','Weekly Active Focus Sessions','Engagement',[
    {name:'Habit Loop Reinforcement',why:'Builds the cue-routine-reward loop that sustains 3+ sessions per week',
      subCaps:[{name:'Streak & milestone system',why:'Visual streak tracking with milestone rewards at 7, 14, 30 days'},{name:'Daily scheduling prompts',why:'Contextual nudges to plan next session at optimal times'}],
      featStore:{top:[
        {name:'Streak freeze for missed days',why:'One freeze per week prevents streak loss — reduces churn after a miss by 40%',selected:false,metric:'Weekly Active Focus Sessions',stage:'Engagement',cap:'Habit Loop Reinforcement',subCap:null},
        {name:'Optimal focus time predictor',why:'Learns user\'s peak performance window and suggests session times accordingly',selected:true,metric:'Weekly Active Focus Sessions',stage:'Engagement',cap:'Habit Loop Reinforcement',subCap:null},
        {name:'Weekly focus summary card',why:'Monday digest of last week\'s sessions drives re-engagement and goal resetting',selected:false,metric:'Weekly Active Focus Sessions',stage:'Engagement',cap:'Habit Loop Reinforcement',subCap:null}
      ]}},
    {name:'Session Variety & Progression',why:'Users who explore multiple session types have 5x higher 90-day retention',
      subCaps:null,featStore:{}},
    {name:'Accountability & Social Layer',why:'Shared goals and partner check-ins double weekly session frequency',
      subCaps:null,featStore:{}}
  ]);

  addCap('retention','30-Day Retention Rate','Retention',[
    {name:'Churn Prevention Signals',why:'Detects at-risk users before they cancel and triggers recovery flows',
      subCaps:null,
      featStore:{top:[
        {name:'Session gap early warning',why:'Detects 3+ day gap and triggers personalised re-engagement message within 4 hours',selected:false,metric:'30-Day Retention Rate',stage:'Retention',cap:'Churn Prevention Signals',subCap:null},
        {name:'Value realisation nudge at day 25',why:'Surfaces user\'s focus stats before the trial end — prevents passive churn',selected:false,metric:'30-Day Retention Rate',stage:'Retention',cap:'Churn Prevention Signals',subCap:null},
        {name:'Cancel intent interception flow',why:'Surfaces top user stats and an offer before confirming cancellation — saves 15-20% of at-risk users',selected:false,metric:'30-Day Retention Rate',stage:'Retention',cap:'Churn Prevention Signals',subCap:null}
      ]}},
    {name:'Subscription Value Communication',why:'Ensures users understand and experience the full value of premium features',
      subCaps:null,featStore:{}},
    {name:'Re-engagement Automation',why:'Win-back flows for lapsed users within 30 days of last session',
      subCaps:null,featStore:{}}
  ]);

  // ── PI-first capability — Compliance (for GDPR demo feature) ──
  capStore['pi||compliance']={
    metricName:'Compliance',
    stageLabel:'PI Plan',
    stageId:'pi',
    capabilities:[{
      name:'Compliance',
      why:'GDPR and regulatory requirements for EU market expansion',
      subCaps:null,
      featStore:{top:[
        {name:'GDPR Consent Settings',why:'Regulatory requirement — must ship before Q3 EU market expansion',
         selected:false,metric:'',stage:'PI Plan',cap:'Compliance',subCap:null}
      ]}
    }]
  };

  // ── 4. Pre-populate Story Canvas with 2 features ──
  scCanvas=[];
  // Pull selected features from capStore
  Object.values(capStore).forEach(entry=>{
    entry.capabilities.forEach(cap=>{
      if(cap.featStore){
        Object.entries(cap.featStore).forEach(([fkey,feats])=>{
          (feats||[]).forEach(f=>{
            if(f.selected){
              const fid=scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name);
              if(!scCanvas.find(x=>x.id===fid)){
                scCanvas.push({id:fid,metric:f.metric,metricPath:scGetMetricPath(f.metric)||f.metric,stage:f.stage,
                  cap:f.cap+(f.subCap?' › '+f.subCap:''),name:f.name,why:f.why,stories:null,origin:'kpi'});
              }
            }
          });
        });
      }
    });
  });

  // ── 4a. Add one Path D (PI-first, unlinked) demo feature for traceability demo ──
  scCanvas.push({
    id:scMakeFeatureId('','Compliance','GDPR Consent Settings'),
    metric:'',
    metricPath:'',
    stage:'PI Plan',
    cap:'Compliance',
    name:'GDPR Consent Settings',
    why:'Regulatory requirement — must ship before Q3 EU market expansion',
    stories:null,
    origin:'pi'
  });

  // ── 4b. Add pre-built stories to 2 demo features ──
  scStoryIdCounter=0;
  scCanvas.forEach(function(feat){
    if(feat.name==='Post-session share prompt'){
      feat.stories=[
        {id:'ST-001',title:'User can share focus streak so that friends are inspired to start their own',statement:'As a Focusly user, I want to share my focus streak after a session, so that I can inspire friends to build focus habits.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Successful share after 3-session streak',given:'User has completed 3 consecutive sessions',when:'User taps the post-session share prompt',then:'A personalised share card is generated with their streak count and focus time',and:'The share sheet opens with pre-populated text and a referral link'},{name:'Share dismissed',given:'User sees the share prompt',when:'User dismisses it',then:'Prompt is dismissed and does not reappear for 24 hours',and:''}]},
        {id:'ST-002',title:'User can see referral reward progress so that they are motivated to keep sharing',statement:'As a Focusly user, I want to see how many friends I have referred, so that I can track my referral reward progress.',points:2,priority:'Should Have',dor:'READY',dorReason:'',scenarios:[{name:'Referral count visible in profile',given:'User has shared at least one referral link',when:'User opens their profile page',then:'A referral tracker shows number of friends invited and number who installed',and:''},{name:'No referrals yet',given:'User has never shared a referral link',when:'User opens their profile page',then:'Referral tracker shows 0 with a prompt to share',and:''}]},
        {id:'ST-003',title:'User receives confirmation when referral installs so that the reward loop closes',statement:'As a Focusly user, I want to be notified when a friend installs via my link, so that I feel the reward of sharing.',points:2,priority:'Could Have',dor:'READY',dorReason:'',scenarios:[{name:'Push notification on friend install',given:'A friend has clicked the user referral link and installed Focusly',when:'The friend completes their first session',then:'The referring user receives a push notification: "Your friend [name] just started their first focus session!"',and:''},{name:'Notification permission not granted',given:'User has not granted push notification permission',when:'A friend installs via their link',then:'In-app notification badge is shown on next app open',and:''}]}
      ];
      scStoryIdCounter=3;
    }
    if(feat.name==='One-tap session start from home screen'){
      feat.stories=[
        {id:'ST-004',title:'New user can start their first session in one tap so that setup friction is eliminated',statement:'As a new Focusly user, I want to start a focus session from the home screen in one tap, so that I reach value before I drop off.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'First session starts immediately',given:'User has completed onboarding and is on the home screen',when:'User taps "Start Focus Session"',then:'A 25-minute Pomodoro session begins immediately with default settings',and:'The distraction blocker activates with the user pre-configured block list'},{name:'Session starts with smart defaults',given:'User has not configured any session settings',when:'User taps to start',then:'Session uses smart defaults: 25 min, work mode, standard block list',and:'User can adjust settings mid-session without interrupting the timer'}]},
        {id:'ST-005',title:'User can see session timer on home screen so that they stay focused without switching apps',statement:'As a Focusly user, I want to see my session timer on the home screen, so that I stay in the flow without context switching.',points:2,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Timer visible on home screen widget',given:'User has added the Focusly widget to their home screen',when:'A focus session is active',then:'The widget shows the remaining session time and a pause button',and:'Tapping the widget opens Focusly directly to the active session'}]}
      ];
      scStoryIdCounter=5;
    }
    if(feat.name==='GDPR Consent Settings'){
      feat.stories=[
        {id:'ST-006',title:'User can view and manage cookie consent preferences so that they have control over their data',statement:'As a Focusly user, I want to manage my cookie consent preferences, so that I have control over how my data is used.',points:2,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Consent banner shown on first visit',given:'User opens Focusly for the first time',when:'The app loads',then:'A GDPR-compliant consent banner is shown with Accept All and Manage options',and:''},{name:'User can accept all cookies',given:'The consent banner is visible',when:'User taps Accept All',then:'All cookie categories are accepted and the banner is dismissed',and:'Preference is persisted across sessions'}]},
        {id:'ST-007',title:'User can withdraw consent and clear stored preferences so that their privacy choices are respected',statement:'As a Focusly user, I want to withdraw my cookie consent at any time, so that I can update my privacy preferences.',points:2,priority:'Should Have',dor:'READY',dorReason:'',scenarios:[{name:'Consent settings accessible from profile',given:'User has previously accepted cookies',when:'User opens Settings > Privacy',then:'Cookie consent settings are shown with current preference state',and:'User can toggle individual categories or withdraw all consent'},{name:'Withdrawal clears non-essential data',given:'User withdraws consent',when:'Withdrawal is confirmed',then:'Non-essential cookies are cleared and preference is updated to rejected',and:''}]}
      ];
      scStoryIdCounter=7;
    }
  });

  // ── 4c. Pre-built product leak analysis ──
  productLeakAnalysis=[{
    runId:'run-demo-01',
    runLabel:'30-Day Retention Rate · Demo',
    runTimestamp:Date.now(),
    runCustomName:false,
    leakingStage:'Retention',
    primaryBottleneckMetric:'30-Day Retention Rate',
    secondaryConcern:'Weekly Active Focus Sessions per User',
    severity:'High',
    evidenceStrength:'Moderate',
    diagnosticCaveat:'Evidence covers Acquisition and Activation metrics only. Engagement and Retention signals are inferred from the known growth problem — direct evidence on retention cohorts is not yet available.',
    evidenceSummary:[
      'High drop-off after first week despite strong onboarding completion rates',
      'Users who complete 3+ sessions in week 1 have 4x higher 90-day retention — habit formation is the key lever',
      'Organic Install Rate is healthy — acquisition is not the bottleneck',
      'First Focus Session Completion Rate is above benchmark — activation is working'
    ],
    instrumentationGaps:[
      '30-Day Retention Rate not currently tracked as a discrete metric — inferred from DAU trends only',
      'Session frequency by cohort week not instrumented — cannot identify exact drop-off point',
      'Distraction blocker activation rate on session 1 not measured — high predictor of retention'
    ],
    problemStatement:'Focusly acquires and activates users effectively but fails to convert activated users into habitual weekly users. The core leak is at the Retention stage — specifically the transition from first-week engagement to second-week habit formation. Users complete onboarding and their first session but do not return to build a 3-session-per-week habit, which is the threshold for long-term retention.',
    experiments:[
      {experimentTitle:'Session streak freeze trial',lifecycleStage:'Retention',linkedMetricId:'ret-l1-0',linkedMetricName:'30-Day Retention Rate',hypothesis:'Offering one streak freeze per week reduces churn after a missed day by preventing the "I have already broken my streak" abandonment pattern.',priority:'P1',successMetric:{metricId:'ret-l1-0',metricName:'30-Day Retention Rate',currentValue:'Unknown',targetValue:'+8pp improvement in day-30 retention for users who use the freeze feature',measurementWindow:'30 days post-activation'},experimentType:'Feature test',instrumentationNeeded:'Streak freeze usage rate, day-30 retention by freeze usage cohort',assumptions:['Streak anxiety is a primary churn trigger','Users value streak continuity enough to return after using a freeze'],description:'Introduce a streak freeze mechanic — users get one "freeze" per week that protects their streak on a missed day. Measure whether retention at day 30 improves for users who use the freeze vs. those who miss a day without one.'},
      {experimentTitle:'Optimal focus time predictor nudge',lifecycleStage:'Engagement',linkedMetricId:'eng-l1-0',linkedMetricName:'Weekly Active Focus Sessions',hypothesis:'Nudging users to schedule their next session at their personal peak focus time (learned from first 3 sessions) increases weekly session frequency.',priority:'P1',successMetric:{metricId:'eng-l1-0',metricName:'Weekly Active Focus Sessions per User',currentValue:'Unknown',targetValue:'20% increase in week-2 session count vs control',measurementWindow:'14 days'},experimentType:'Personalisation test',instrumentationNeeded:'Session completion time by user, push notification CTR, weekly session count by cohort',assumptions:['Users have consistent peak focus windows','The app can infer peak time from 3+ sessions reliably'],description:'After a user completes 3 sessions, analyse their completion times to identify their peak focus window. Send a personalised nudge 30 minutes before that window each day for the following week. Measure week-2 session frequency vs. a control group.'},
      {experimentTitle:'Week-2 re-engagement card',lifecycleStage:'Retention',linkedMetricId:'ret-l1-0',linkedMetricName:'30-Day Retention Rate',hypothesis:'A personalised "your week 1 stats" card sent on day 8 reactivates users who have gone quiet after their first week.',priority:'P2',successMetric:{metricId:'ret-l1-0',metricName:'30-Day Retention Rate',currentValue:'Unknown',targetValue:'15% reactivation rate among day-7 to day-10 dormant users',measurementWindow:'7 days post-send'},experimentType:'Re-engagement campaign',instrumentationNeeded:'Day-7 dormancy detection, push/email send event, session within 48 hours of send',assumptions:['Users who go quiet in week 2 have not consciously churned','Surfacing week-1 achievement creates re-engagement motivation'],description:'On day 8, identify users who have not opened the app in 48+ hours. Send a personalised "Your week 1 focus report" card showing their total focus time, sessions completed, and a comparison to similar users. Measure sessions in the 7 days following the send.'}
    ]
  }];

  // ── 4d. Pre-built metrics definition data ──
  const demoMetrics=[
    {name:'Organic Install Rate',definition:'Percentage of new installs attributed to organic channels (App Store search, word-of-mouth, web SEO) rather than paid campaigns, measured weekly.',benchmark:'B2C productivity apps: 35-55% organic; top quartile >60%',red_flag:'Below 25% signals over-reliance on paid acquisition — unsustainable CAC at scale'},
    {name:'App Store Conversion Rate',definition:'Percentage of App Store or Play Store listing views that result in an install, reflecting the effectiveness of screenshots, ratings, and copy.',benchmark:'2-4% is typical; top B2C productivity apps achieve 5-8%',red_flag:'Below 1.5% indicates a listing quality problem — A/B test visuals immediately'},
    {name:'Referral Install Rate',definition:'Percentage of new installs driven by in-app referral links shared by existing users, measuring word-of-mouth amplification.',benchmark:'Strong consumer apps: 8-15% of installs from referral; viral coefficient >0.3',red_flag:'Below 3% suggests the referral mechanic lacks sufficient incentive or share trigger'},
    {name:'Paid Trial Start Rate',definition:'Percentage of users who begin a free trial after clicking a paid ad, combining ad creative quality and landing page conversion effectiveness.',benchmark:'Mobile subscription apps: 15-30% paid-to-trial conversion',red_flag:'Below 10% indicates a mismatch between ad creative and product promise'},
    {name:'Ad-to-Install Conversion Rate',definition:'Percentage of users who install Focusly after clicking a paid advertisement, measuring paid channel efficiency.',benchmark:'Mobile productivity category: 20-35% click-to-install',red_flag:'Below 15% signals poor ad-product fit or high friction in the install flow'},
    {name:'First Focus Session Completion Rate',definition:'Percentage of newly activated users who complete at least one focus session (minimum 20 minutes) within their first 48 hours after installing Focusly.',benchmark:'Best-in-class onboarding: 55-70%; productivity apps average 35-45%',red_flag:'Below 30% indicates onboarding friction preventing users from experiencing core value'},
    {name:'Time to First Session',definition:'Median time elapsed between app install and the user starting their first focus session, measuring onboarding speed.',benchmark:'Best-in-class: under 10 minutes; productivity apps median 20-40 minutes',red_flag:'Above 60 minutes strongly predicts day-1 churn — users lose activation intent quickly'},
    {name:'Distraction Blocker Activation Rate',definition:'Percentage of users who activate the distraction blocker during their first focus session, the single highest predictor of week-1 retention for Focusly.',benchmark:'Target: >45% on session 1; users who activate blocker have 3x week-2 retention',red_flag:'Below 20% signals the feature is not discoverable enough in onboarding'},
    {name:'Weekly Active Focus Sessions per User',definition:'Average number of completed focus sessions (minimum 20 minutes) per active user per week, directly measuring habit formation and the north star behaviour.',benchmark:'Habit-formed users: 4-6 sessions/week; casual users: 1-2; churn risk: <1',red_flag:'Average below 2 sessions/week across active users signals habit loop is not closing'},
    {name:'Day-7 Retention Rate',definition:'Percentage of users who open Focusly and complete at least one session in the 7 days following their install date.',benchmark:'Strong consumer apps: 35-50% day-7 retention; productivity apps average 25-35%',red_flag:'Below 20% day-7 retention indicates a fundamental habit formation failure'},
    {name:'30-Day Retention Rate',definition:'Percentage of users who remain active (at least 1 session per week) 30 days after their first install, the primary indicator of successful habit formation.',benchmark:'Top consumer subscription apps: 25-40% day-30 retention; B2C productivity median 18-25%',red_flag:'Below 15% day-30 retention makes subscription conversion economics unviable'},
    {name:'Streak Completion Rate',definition:'Percentage of users who maintain an unbroken daily focus streak for at least 7 consecutive days, a leading indicator of long-term retention.',benchmark:'Habit apps with streaks: 12-20% of active users achieve 7-day streak',red_flag:'Below 8% suggests streak mechanic is insufficiently motivating or too easy to break'}
  ];
  if(typeof renderDDTable==='function'){
    window._ddRows=[];
    const stageMap={'Organic Install Rate':'acquisition','App Store Conversion Rate':'acquisition','Referral Install Rate':'acquisition','Paid Trial Start Rate':'acquisition','Ad-to-Install Conversion Rate':'acquisition','First Focus Session Completion Rate':'activation','Time to First Session':'activation','Distraction Blocker Activation Rate':'activation','Weekly Active Focus Sessions per User':'engagement','Day-7 Retention Rate':'retention','30-Day Retention Rate':'retention','Streak Completion Rate':'retention'};
    const stageLabelMap={'acquisition':'Acquisition','activation':'Activation','engagement':'Engagement','retention':'Retention'};
    demoMetrics.forEach(function(m){
      const stId=stageMap[m.name]||'acquisition';
      window._ddRows.push({stage:stId,sl:stageLabelMap[stId]||stId,lvl:'L1',name:m.name,why:'',def:m.definition,bm:m.benchmark,rf:m.red_flag});
    });
    renderDDTable(demoMetrics);
    ddGenerated=true;
  }

  // ── 5. Render everything ──
  ddGenerated=false;
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;

  // Update header
  const pnEl=document.getElementById('hdr-product-name');
  if(pnEl){pnEl.textContent='Focusly';pnEl.classList.add('has-name');}

  // Show demo badge
  _showDemoBadge();

  // Render KPI tree
  // Clear any existing KPI tree content and hide empty state before rendering
  const esEl=document.getElementById('es');
  if(esEl)esEl.style.display='none';
  const lsEl=document.getElementById('ls');
  if(lsEl)lsEl.classList.remove('on');
  const erEl=document.getElementById('er');
  if(erEl)erEl.classList.remove('on');
  const mmOut=document.getElementById('mm-out');
  if(mmOut)mmOut.innerHTML='';
  // Reset banner state and populate productContext for demo
  mmBannerCollapsed=false;
  productContext={
    name:'Focusly',
    url:'https://focusly.app',
    description:'A B2C consumer productivity app that helps knowledge workers build deep focus habits through session tracking, distraction blocking, and habit loop reinforcement.',
    industry:'Technology & Software',
    productType:'B2C Product',
    kpis:'DAU, session length, 7-day retention',
    problem:'High drop-off after first week — users complete onboarding but never form a habit',
    icp:'Knowledge workers and students, 22–40, remote-first',
    additionalContext:'',
    measurementModelName:'Consumer Growth Model',
    frameworks:['APQC PCF','First principles'],
    nsmMetric:'Weekly Active Focus Sessions per User'
  };
  renderMM(gData);
  document.getElementById('mm-out').classList.add('on');
  if(typeof renderDiagnosticActionBar==='function')renderDiagnosticActionBar();

  // Render story canvas with pre-built features and stories
  fcRenderCanvas();
  fcRenderCapNav();
  fcUpdateTabBadge();
  if(typeof ccUpdateTabBadge==='function')ccUpdateTabBadge();

  // Reveal product leak analysis tab and render pre-built analysis
  if(productLeakAnalysis){
    const laTabElD=document.getElementById('tab-la');
    if(laTabElD)laTabElD.style.display='';
    if(typeof laRenderAnalysis==='function')laRenderAnalysis();
  }

  // Reveal metrics definition tab and mark as generated
  ddGenerated=true;

  // ── 5. Inject Market Intelligence demo data ──
  miGenerated=true;
  miProductMode='market';
  miData={
    productMode:'market',
    marketSnapshot:[
      {value:'$8.3B',label:'Habit app market 2025',source:'Grand View Research',year:'2025',trend:'↑ 17.8% CAGR'},
      {value:'17.8%',label:'CAGR to 2030',source:'Grand View Research',year:'2025',trend:''},
      {value:'$4.2B',label:'Mindfulness app TAM',source:'Statista',year:'2025',trend:'↑'},
      {value:'#1',label:'Top buyer criterion',source:'Market analysis',year:'2025',trend:'Personalised streaks'}
    ],
    buyerCriteria:[
      {rank:1,criterion:'Personalised progress streaks',evidence:'78% of habit app users cite personalised streaks as primary retention driver',source:'AppFollow Survey',year:'2025',productRelevance:'Core differentiator — streak engine is Focusly\'s NSM driver'},
      {rank:2,criterion:'Social accountability features',evidence:'64% of users are more likely to continue after 30 days if social features are active',source:'Noom research',year:'2024',productRelevance:'Focusly has group challenges — accountability pairs are the gap'},
      {rank:3,criterion:'Cross-device sync',evidence:'71% of habit app churners cite inconsistent cross-device experience as reason for leaving',source:'SensorTower',year:'2025',productRelevance:'Current gap — no cross-device sync confirmed'}
    ],
    trends:[
      {name:'AI-personalised habit coaching',confidence:'CONFIRMED HIGH',signal:'ACTIVE',evidence:'Duolingo Max and Noom Coach both launched AI coaching layers in 2024 with reported D30 retention uplift',source:'TechCrunch, Jan 2025',implication:'Users expect AI to adapt recommendations to their behaviour pattern',productGap:'Focusly uses fixed habit templates — no adaptive AI layer',roadmapAction:'Accelerate — add AI-driven habit suggestion engine'},
      {name:'Social accountability loops',confidence:'CONFIRMED MEDIUM',signal:'ACTIVE',evidence:'Apps with social features retain 2.1× longer than solo-only apps',source:'Sensor Tower 2025',implication:'Social graph is a retention multiplier at scale',productGap:'Group challenges exist but no accountability pairs between specific users',roadmapAction:'Accelerate — prioritise accountability pair feature'},
      {name:'Wearable integration',confidence:'CONFIRMED MEDIUM',signal:'PEAKING',evidence:'Fitbit and Apple Watch habit tracking growing but growth rate slowing from prior years',source:'IDC Wearables Report, 2025',implication:'Table stakes now — not a differentiator',productGap:'Partial Apple Health sync only',roadmapAction:'Protect — complete HealthKit sync, do not invest in differentiation here'},
      {name:'Gamification fatigue',confidence:'CONFIRMED HIGH',signal:'TAIL-END',evidence:'AppFollow analysis shows 1-star reviews citing excessive gamification up 34% in 2024–25',source:'AppFollow, 2025',implication:'Aggressive gamification is now a churn risk not a hook for power users',productGap:'Focusly\'s badge/XP system may trigger fatigue for D60+ users',roadmapAction:'Monitor — soften gamification for long-tenure users, do not build more'}
    ],
    competitors:[
      {name:'Habitica',capabilities:[{domain:'Streak engine',status:'present'},{domain:'AI coaching',status:'gap'},{domain:'Social features',status:'present'},{domain:'Wearable sync',status:'gap'}]},
      {name:'Streaks',capabilities:[{domain:'Streak engine',status:'present'},{domain:'AI coaching',status:'gap'},{domain:'Social features',status:'gap'},{domain:'Wearable sync',status:'present'}]},
      {name:'Noom',capabilities:[{domain:'Streak engine',status:'partial'},{domain:'AI coaching',status:'present'},{domain:'Social features',status:'present'},{domain:'Wearable sync',status:'partial'}]},
      {name:'Duolingo',capabilities:[{domain:'Streak engine',status:'present'},{domain:'AI coaching',status:'present'},{domain:'Social features',status:'present'},{domain:'Wearable sync',status:'gap'}]}
    ],
    competitorDeepDives:[
      {name:'Duolingo',narrative:'Duolingo\'s expansion into general habit formation beyond language learning poses a structural threat. Its AI coaching layer (Duolingo Max, 2024) has demonstrated retention uplift. Focusly\'s advantage remains UX simplicity and habit-specific streak depth.',leadAreas:'AI coaching, social features, brand recognition',productAdvantage:'Habit-specific streak visualisation, faster onboarding, pure focus on productivity habits',threat:'Expanding beyond language into general habit formation with AI coaching — raising the market baseline'},
      {name:'Noom',narrative:'Noom Coach proves willingness to pay for AI-driven behaviour change in the consumer market. Their accountability model (human coach + AI) is expensive but shows strong outcomes.',leadAreas:'AI coaching depth, accountability model, clinical credibility',productAdvantage:'Lower price point, broader habit categories, simpler UX',threat:'Premium positioning validates the AI coaching market Focusly could capture at a lower price point'}
    ],
    swot:{
      strengths:[
        {text:'Best-in-class streak visualisation with daily momentum graph',source:'App Store reviews analysis 2025'},
        {text:'Simple onboarding — first habit tracked in under 90 seconds',source:'User testing benchmark'}
      ],
      weaknesses:[
        {text:'No AI-driven adaptive coaching — fixed templates only',source:'User-confirmed',researchIdentified:false},
        {text:'Cross-device sync absent — confirmed churn risk by SensorTower data',source:'SensorTower 2025',researchIdentified:true}
      ],
      opportunities:[
        {text:'AI habit coaching layer — Duolingo and Noom prove willingness to pay',source:'TechCrunch 2025'},
        {text:'Accountability pairs — 2.1× retention multiplier per Sensor Tower data',source:'Sensor Tower 2025'}
      ],
      threats:[
        {text:'Duolingo expanding beyond language into general habit formation with AI coaching',source:'Duolingo blog, Feb 2025'},
        {text:'Apple Habits rumoured for iOS 19 — platform-native threat to third-party habit apps',source:'MacRumors, Apr 2025'}
      ],
      synthesis:'Focusly\'s streak engine and onboarding simplicity are genuine moats in the short term. The structural risk is that Duolingo and Noom are shifting the market expectation toward AI-adaptive coaching, and cross-device sync is already a confirmed churn driver.'
    },
    capabilities:[
      {name:'Streak engine & momentum visualisation',marketEvidence:'78% of users cite streaks as primary retention driver (AppFollow 2025)',kpiTreeMatch:'aligned',kpiTreeMetric:'Weekly Active Focus Sessions',kpiTreeStage:'Engagement',kpiTreePath:'Weekly Active Focus Sessions'},
      {name:'AI-driven habit coaching',marketEvidence:'Duolingo Max and Noom Coach both launched AI coaching with reported D30 uplift — market baseline shifting',kpiTreeMatch:'none',kpiTreeMetric:'',kpiTreeStage:'',kpiTreePath:''},
      {name:'Social accountability pairs',marketEvidence:'Apps with social features retain 2.1× longer than solo-only apps (Sensor Tower 2025)',kpiTreeMatch:'partial',kpiTreeMetric:'Social & Accountability Engagement',kpiTreeStage:'Engagement',kpiTreePath:'Social & Accountability Engagement'},
      {name:'Cross-device sync & HealthKit integration',marketEvidence:'71% of churners cite inconsistent cross-device experience as reason for leaving (SensorTower 2025)',kpiTreeMatch:'none',kpiTreeMetric:'',kpiTreeStage:'',kpiTreePath:''},
      {name:'Personalised habit recommendations',marketEvidence:'Adaptive recommendations are top-rated feature in competitor app reviews',kpiTreeMatch:'partial',kpiTreeMetric:'Day 2 Return Rate',kpiTreeStage:'Activation',kpiTreePath:'Day 2 Return Rate'}
    ],
    docxSections:{
      marketOverview:'The habit and productivity app market reached an estimated $8.3B in 2025, growing at 17.8% CAGR. North America accounts for approximately 38% of global spend. The adjacent mindfulness market contributes an additional $4.2B TAM.',
      buyerCriteriaNarrative:'Three buyer priorities dominate: personalised streak mechanics (78% cite as primary retention driver), social accountability features (2.1× retention multiplier), and cross-device consistency (71% of churners cite this as reason for leaving).',
      productMarketPosition:'Focusly is well-positioned on streak mechanics but has a confirmed gap on cross-device sync and an emerging gap on AI coaching as competitors raise the market baseline.',
      trendsNarrative:'AI-personalised coaching is the dominant active trend. Social accountability loops are actively differentiating retention. Wearable integration is now table stakes. Gamification fatigue is a tail-end trend.',
      competitiveSummary:'Habitica and Streaks own the streak segment. Noom and Duolingo are moving upmarket with AI coaching. Focusly\'s advantage is UX simplicity and habit specificity.',
      swotSynthesis:'Focusly\'s streak engine and onboarding simplicity are defensible short-term. The structural risk is Duolingo and Noom shifting market expectations toward AI-adaptive coaching.',
      gapMatrix:[
        {expectation:'AI-driven adaptive habit coaching',today:'Fixed templates only',severity:'H',gap:'No ML model adapting recommendations to user behaviour',opportunity:'Build adaptive suggestion engine targeting D30 retention uplift'},
        {expectation:'Cross-device sync & mobile/desktop parity',today:'Partial Apple Health sync only',severity:'H',gap:'71% of churners cite inconsistent cross-device experience',opportunity:'HealthKit full integration + desktop companion'},
        {expectation:'Social accountability pairs',today:'Group challenges only',severity:'M',gap:'2.1× retention multiplier unrealised without 1:1 accountability',opportunity:'Accountability pair feature with daily check-in notifications'}
      ],
      capabilityMap:[
        {l1:'Habit Tracking & Streaks',l2:'Streak visualisation',features:'Daily momentum graph, streak counter, streak repair',status:'Present',notes:'Best-in-class — genuine moat'},
        {l1:'AI & Personalisation',l2:'Adaptive coaching',features:'ML-driven habit suggestions, difficulty adjustment, personalised scheduling',status:'GAP',notes:'Duolingo Max and Noom Coach both live — critical gap'},
        {l1:'Social & Accountability',l2:'Accountability pairs',features:'1:1 partner matching, daily check-in, progress sharing',status:'GAP',notes:'Group challenges exist but 1:1 pairs absent'},
        {l1:'Cross-Platform',l2:'Device sync',features:'HealthKit sync, desktop companion, session continuity',status:'Partial',notes:'Partial Apple Health only — confirmed churn driver'}
      ],
      roadmap:[
        {capability:'AI-driven habit coaching',priority:'Accelerate',timeline:'Q3 2025',rationale:'Market baseline shifting. Window to differentiate is 2–3 quarters.'},
        {capability:'Cross-device sync & HealthKit',priority:'Accelerate',timeline:'Q3 2025',rationale:'71% of churners cite this. Confirmed churn driver.'},
        {capability:'Social accountability pairs',priority:'Protect',timeline:'Q4 2025',rationale:'2.1× retention multiplier. Extend existing social investment.'},
        {capability:'Wearable integration',priority:'Protect',timeline:'Ongoing',rationale:'Table stakes — complete HealthKit parity.'},
        {capability:'Gamification depth',priority:'Monitor',timeline:'H2 2026',rationale:'Gamification fatigue is tail-end. Soften for power users.'}
      ],
      valueAnchors:[
        {capability:'AI habit coaching',benchmark:'Apps with adaptive coaching report 18–22% D30 retention uplift',source:'TechCrunch 2025'},
        {capability:'Social accountability',benchmark:'Apps with social features retain 2.1× longer than solo-only apps',source:'Sensor Tower 2025'},
        {capability:'Cross-device sync',benchmark:'71% of churners cite inconsistent cross-device experience',source:'SensorTower 2025'}
      ],
      sources:[
        {source:'Grand View Research — Habit App Market',scope:'Market size, CAGR',year:'2025',confidence:'Medium-High'},
        {source:'Sensor Tower — Social Features Retention Study',scope:'Social feature retention multiplier',year:'2025',confidence:'High'},
        {source:'SensorTower — Churn Analysis',scope:'Cross-device sync churn correlation',year:'2025',confidence:'High'},
        {source:'AppFollow — Review Sentiment Analysis',scope:'Gamification fatigue signal',year:'2025',confidence:'Medium'}
      ],
      methodologyNote:'Research produced from AI training data. All stats should be verified independently. Web-sourced research will be added in v5.1.',
      limitations:'All statistics are AI-generated from training data. No live web search was performed in this generation (v5.0).'
    }
  };
  miCapabilities=miData.capabilities;
  // Pre-add AI-driven habit coaching cap to CC via new mi||capabilities pattern
  capStore['mi||capabilities']={
    metricName:'MI Capabilities',
    stageLabel:'Market Intelligence',
    stageId:'mi',
    _miCap:true,
    capabilities:[{
      name:'AI-driven habit coaching',
      why:'ML-driven personalisation is documented to improve habit formation. Duolingo Max and Noom Coach use adaptive targets and personalised scheduling to drive D7/D30 retention uplifts.',
      subCaps:null,
      featStore:{top:[
        {name:'Adaptive habit difficulty adjustment',why:'Automatically increase or decrease habit target based on 7-day completion rate.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'AI-driven habit coaching',_miSent:false},
        {name:'Personalised habit scheduling',why:'Suggest optimal time-of-day for each habit based on historical completion patterns.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'AI-driven habit coaching',_miSent:false},
        {name:'AI-generated habit rationale',why:'Show a one-line personalised "why this habit matters for you" from user goal context.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'AI-driven habit coaching',_miSent:false}
      ]}
    }]
  };
  // Reveal MI tab unconditionally in demo mode
  const miTabElD=document.getElementById('tab-mi');
  if(miTabElD) miTabElD.style.display='';

  // Reveal Capability Canvas tab (has capStore data)
  const ccTabElD=document.getElementById('tab-cc');
  if(ccTabElD)ccTabElD.style.display='';

  // Settings panel is closed by the caller before loadDemoData runs
  // (see index.html button onclick handler)

  // ── PI Planning demo data — realistic board (3 squads, 5 sprints, 27+3 stories) ──
  piMode=false;
  // Capacity = story points per sprint (not PI total)
  const _demoSquads1=[
    {name:'Core App', devs:4,sprints:5,availability:85,capacity:18},
    {name:'Growth',   devs:3,sprints:5,availability:80,capacity:14},
    {name:'Platform', devs:3,sprints:5,availability:75,capacity:12}
  ];
  piInputs={type:'caps-only',
    piGoal:'Drive habit formation and reduce week-2 churn by 15% before end of quarter.',
    constraints:'Platform freeze in Sprint 4. Growth squad offsite Sprint 3.',
    parsedCaps:[],parsedFeatures:[],
    carryForwardItems:['Notification permission flow (PI-2024-Q2)','App Store screenshot refresh (partially complete)'],
    overlapResolutions:{}};

  // ── Story pool (standalone — not attached to SC features) ──
  if(typeof piStoryPool==='undefined'){piStoryPool={};}
  var _ps=[
    // Core App stories
    {id:'ST-CA1',title:'Session timer visible on home screen widget',statement:'As a Focusly user, I want to see my active session timer on my home screen widget, so that I stay focused without switching apps.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CA2',title:'Distraction blocker activates on session start',statement:'As a Focusly user, I want my app block list to activate automatically when I start a session, so that distractions are removed without manual steps.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CA3',title:'User can manage their app block list',statement:'As a Focusly user, I want to customise which apps are blocked during sessions, so that I can tailor distraction control to my workflow.',points:2,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-CA4',title:'Session completion celebration shown on finish',statement:'As a Focusly user, I want a celebration animation when I complete a session without interruption, so that I feel rewarded for staying focused.',points:3,priority:'Could Have',dor:'READY',dorReason:''},
    {id:'ST-CA5',title:'Habit streak counter displayed on home screen',statement:'As a Focusly user, I want to see my current focus streak on the home screen, so that I am motivated to maintain my daily habit.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CA6',title:'Streak freeze protects habit on a missed day',statement:'As a Focusly user, I want to use a streak freeze token when I miss a day, so that one slip does not break my momentum.',points:3,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-CA7',title:'Smart nudge suggests session at peak focus time',statement:'As a Focusly user, I want a personalised push nudge at my best focus time, so that I build a consistent daily habit.',points:2,priority:'Should Have',dor:'IN REVIEW',dorReason:'Depends on analytics schema (Platform ST-PL3)'},
    {id:'ST-CA8',title:'Week-2 re-engagement card for dormant users',statement:'As a Focusly user who has gone quiet in week 2, I want a personalised re-engagement card on day 8, so that I am reminded of my progress and return.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CA9',title:'Win-back notification with streak recovery offer',statement:'As a lapsed Focusly user, I want a win-back offer after 14 days inactive, so that I feel it is worth returning despite my broken streak.',points:3,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-CA10',title:'Focus time predictor learns from session patterns',statement:'As a Focusly user, I want the app to analyse my session history and surface my best focus windows, so that I schedule sessions when I am most productive.',points:5,priority:'Must Have',dor:'BLOCKED',dorReason:'Requires cohort pipeline (Platform ST-PL4)'},
    {id:'ST-CA11',title:'Personal focus stats dashboard with weekly trends',statement:'As a Focusly user, I want a stats dashboard showing my daily sessions, streak history, and total focus time, so that I can track my habit progress.',points:3,priority:'Should Have',dor:'READY',dorReason:''},
    // Growth stories
    {id:'ST-GR1',title:'Post-session share prompt after focus streak',statement:'As a Focusly user, I want a share prompt after completing a 3-session streak, so that I can inspire friends to build focus habits.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-GR2',title:'Referral reward tracker visible in profile',statement:'As a Focusly user, I want to see how many friends I have referred and my reward progress, so that I am motivated to keep sharing.',points:2,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-GR3',title:'Friend install notification closes referral loop',statement:'As a Focusly user, I want to be notified when a friend installs via my link and completes their first session, so that the reward loop closes.',points:2,priority:'Could Have',dor:'READY',dorReason:''},
    {id:'ST-GR4',title:'App Store screenshot A/B test framework',statement:'As the Focusly growth team, I want to A/B test App Store screenshots against install conversion rate, so that I can optimise our listing performance.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-GR5',title:'Keyword rank tracker with Slack alerts on drops',statement:'As the Focusly growth team, I want daily rank tracking for our top 20 ASO keywords with Slack alerts on drops, so that we catch ranking issues before they impact installs.',points:2,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-GR6',title:'Review response templates improve rating handling',statement:'As the Focusly growth team, I want pre-built response templates for 1-3 star reviews, so that we respond consistently and improve our average rating.',points:2,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-GR7',title:'Rating trend dashboard shows weekly App Store movement',statement:'As the Focusly growth team, I want a weekly view of our App Store rating trend with release annotations, so that I can measure the impact of our review response efforts.',points:3,priority:'Could Have',dor:'READY',dorReason:''},
    // Platform stories
    {id:'ST-PL1',title:'Session data model refactored for analytics events',statement:'As a Platform engineer, I want a clean session data model so that all session lifecycle events are reliably captured with the correct schema for downstream analytics.',points:5,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-PL2',title:'Push notification infrastructure for trigger-based sends',statement:'As a Platform engineer, I want a notification infrastructure that supports user-level triggers, so that personalised nudges can be delivered reliably within 5 minutes of a trigger.',points:5,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-PL3',title:'Analytics event schema standardised and documented',statement:'As a Platform engineer, I want a standardised event schema published to shared docs, so that all teams instrument their features consistently.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-PL4',title:'Cohort data pipeline tracks per-user session frequency',statement:'As a Platform engineer, I want a nightly data pipeline that tracks session frequency by user cohort, so that personalisation features have fresh data with under 24hr lag.',points:3,priority:'Must Have',dor:'IN REVIEW',dorReason:'Requires ST-PL3 event schema first'},
    {id:'ST-PL5',title:'Performance optimisation reduces cold-start time by 40%',statement:'As a Platform engineer, I want to reduce app cold-start time to under 1.2 seconds on mid-range devices, so that users do not drop off before reaching the home screen.',points:5,priority:'Should Have',dor:'READY',dorReason:''}
  ];
  _ps.forEach(function(s){piStoryPool[s.id]=s;});

  // ── Sprint board assignments ──
  // Sprint 1: Core App 8pts | Growth 5pts | Platform 5pts = 18 cards total → 6 cards
  // Sprint 2: Core App 8pts | Growth 5pts | Platform 5pts = 6 cards
  // Sprint 3: Core App 8pts | Growth OFFSITE | Platform 6pts = 5 cards
  // Sprint 4: Core App 6pts | Growth 5pts | Platform FREEZE = 4 cards
  // Sprint 5: Core App 11pts | Growth 5pts | Platform 5pts = 6 cards  (CA slightly over → amber warning)
  // Backlog: 3 stories
  var _sa={
    'ST-004': {sprint:1,squad:'Core App', points:3,status:'planned'},
    'ST-005': {sprint:1,squad:'Core App', points:2,status:'planned'},
    'ST-CA1': {sprint:1,squad:'Core App', points:3,status:'planned'},
    'ST-GR1': {sprint:1,squad:'Growth',   points:3,status:'planned'},
    'ST-GR2': {sprint:1,squad:'Growth',   points:2,status:'planned'},
    'ST-PL1': {sprint:1,squad:'Platform', points:5,status:'planned'},

    'ST-CA2': {sprint:2,squad:'Core App', points:3,status:'planned'},
    'ST-CA3': {sprint:2,squad:'Core App', points:2,status:'planned'},
    'ST-CA4': {sprint:2,squad:'Core App', points:3,status:'planned'},
    'ST-001': {sprint:2,squad:'Growth',   points:3,status:'planned'},
    'ST-002': {sprint:2,squad:'Growth',   points:2,status:'planned'},
    'ST-PL2': {sprint:2,squad:'Platform', points:5,status:'planned'},

    // Sprint 3: Growth unavailable (offsite)
    'ST-CA5': {sprint:3,squad:'Core App', points:3,status:'planned'},
    'ST-CA6': {sprint:3,squad:'Core App', points:3,status:'planned'},
    'ST-CA7': {sprint:3,squad:'Core App', points:2,status:'planned'},
    'ST-PL3': {sprint:3,squad:'Platform', points:3,status:'planned'},
    'ST-PL4': {sprint:3,squad:'Platform', points:3,status:'planned'},

    // Sprint 4: Platform freeze
    'ST-CA8': {sprint:4,squad:'Core App', points:3,status:'planned'},
    'ST-CA9': {sprint:4,squad:'Core App', points:3,status:'planned'},
    'ST-GR3': {sprint:4,squad:'Growth',   points:2,status:'planned'},
    'ST-GR4': {sprint:4,squad:'Growth',   points:3,status:'planned'},

    // Sprint 5: Core App slightly over (11 > 10 target — amber warning trigger)
    'ST-CA10':{sprint:5,squad:'Core App', points:5,status:'planned'},
    'ST-CA11':{sprint:5,squad:'Core App', points:3,status:'planned'},
    'ST-003': {sprint:5,squad:'Core App', points:3,status:'planned'},
    'ST-GR5': {sprint:5,squad:'Growth',   points:2,status:'planned'},
    'ST-GR6': {sprint:5,squad:'Growth',   points:3,status:'planned'},
    'ST-PL5': {sprint:5,squad:'Platform', points:5,status:'planned'}
  };
  // Backlog: 3 stories (deprioritised or carry-forward)
  var _backlogIds=['ST-GR7','ST-PL3','ST-PL4'];
  // Note: PL3+PL4 listed in backlog for visibility but also assigned to sprint 3 above

  const demoStart2=new Date();
  demoStart2.setDate(demoStart2.getDate()+(7-demoStart2.getDay())+1);
  const fmt2=function(d){return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});};
  const demoSprints2=[];
  for(var i2=0;i2<5;i2++){
    const s2=new Date(demoStart2);s2.setDate(s2.getDate()+i2*14);
    const e3=new Date(s2);e3.setDate(e3.getDate()+13);
    demoSprints2.push({id:i2+1,label:'Sprint '+(i2+1),dateRange:fmt2(s2)+' – '+fmt2(e3)});
  }

  const _demoPlan1={
    id:'rp-demo-1',
    createdAt:Date.now(),
    name:_genDemoReleasePlanName(),
    startDate:demoStart2.toISOString().split('T')[0],
    sprintCount:5,sprintDuration:14,
    sprints:demoSprints2,
    storyAssignments:_sa,
    dependencies:[
      {fromStory:'ST-CA7', toStory:'ST-PL3',type:'blocks',description:'Nudge feature depends on analytics schema'},
      {fromStory:'ST-CA10',toStory:'ST-PL4',type:'blocks',description:'Focus time predictor depends on cohort pipeline'},
      {fromStory:'ST-PL4', toStory:'ST-PL3',type:'blocks',description:'Pipeline depends on event schema'}
    ],
    externalDeps:[
      {description:'App Store Connect API access for screenshot A/B testing',owner:'Apple',dueDate:'Sprint 1',status:'confirmed'},
      {description:'Push notification certificate renewal',owner:'DevOps',dueDate:'Before Sprint 2',status:'in-progress'}
    ],
    businessValueBullets:[
      'Reduce week-2 churn by 15% through habit formation mechanics',
      'Increase App Store rating from 4.1 to 4.4 via review management',
      'Deliver personalised nudge engine — 20% lift in weekly sessions',
      'Platform analytics + notification foundation for Q4 growth features'
    ],
    businessValueOneLiner:'This release builds the habit formation and platform infrastructure needed to convert first-week users into long-term subscribers.',
    backlogNotes:{
      'ST-GR7':'Low priority — rating trend data not available until ST-PL3 analytics schema lands'
    },
    squads:_demoSquads1
  };
  piPlans=[_demoPlan1];
  _piActivePlanId=_demoPlan1.id;
  piBacklogStoryIds=(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds))?piBacklogStoryIds:[];
  if(!piBacklogStoryIds.includes('ST-GR7'))piBacklogStoryIds.push('ST-GR7');

  // Set _inPIPlan flags on demo stories that are in the PI plan
  // ST-004, ST-005 (One-tap session start) and ST-001 (post-session share) are in Sprint 1/2
  const _piInPlanIds=['ST-004','ST-005','ST-001','ST-002'];
  scCanvas.forEach(function(f){
    if(f.stories){f.stories.forEach(function(st){
      st._inPIPlan=_piInPlanIds.includes(st.id);st._stagedForPI=false;st._inSC=false;st._hiddenFromSC=false;
    });}
  });
  // Add a demo dependency: ST-007 blocks ST-006 (GDPR)
  scCanvas.forEach(function(f){
    if(f.name==='GDPR Consent Settings'&&f.stories&&f.stories.length>1){
      f.stories[1].dependencies=[{direction:'blocks',storyId:'ST-006',storyTitle:'User can view and manage cookie consent preferences'}];
    }
  });
  // Add demo notes
  scCanvas.forEach(function(f){
    if(f.name==='One-tap session start from home screen'&&f.stories&&f.stories.length>0){
      f.stories[0].notes='Confirm with iOS team re widget refresh rate before Sprint 1 starts';
    }
  });
  // Rebuild scPiSelectedIds from story flags
  scPiSelectedIds=new Set();
  scCanvas.forEach(function(f){if(f.stories&&f.stories.some(function(s){return s._stagedForPI;}))scPiSelectedIds.add(f.id);});
  piScVersion=scCanvas.map(function(f){return f.id;}).join('|');
  if(typeof scApplyPIPlannedBadges==='function')scApplyPIPlannedBadges(_sa);
  if(typeof piUpdateTabBadge==='function')piUpdateTabBadge();

  // ── Set sessionContext for demo session ──
  sessionContext={
    companyProfile:JSON.parse(JSON.stringify(companyProfile)),
    productProfile:JSON.parse(JSON.stringify(productProfiles[0])),
    approach:'outcome-based',
    generationMode:'ai-generated',
    manualList:[],
    customValueChain:'',
    additionalContext:'',
    marketIntelligence:false,
    launchedAt:Date.now()
  ,
    allowAISuggestions:false,
    sessionDocs:[]
  };;
  sessionActive=true;

  // Reveal all tabs — mm, cc, mi, la, fc + gated sc and pi
  const tabMm=document.getElementById('tab-mm');
  if(tabMm)tabMm.style.display='';
  const tabCc=document.getElementById('tab-cc');
  if(tabCc)tabCc.style.display='';
  const tabMi=document.getElementById('tab-mi');
  if(tabMi)tabMi.style.display='';
  const tabLa=document.getElementById('tab-la');
  if(tabLa)tabLa.style.display='';
  const tabFc=document.getElementById('tab-fc');
  if(tabFc)tabFc.style.display='';
  const tabSc=document.getElementById('tab-sc');
  if(tabSc){tabSc.style.display='';tabSc.classList.add('revealed');}
  const tabPi=document.getElementById('tab-pi');
  if(tabPi){tabPi.style.display='';tabPi.classList.add('revealed');}

  // Demo sessions start pre-populated, not "newly sent" - clear any
  // stale pending dots from a prior live session
  ['cc','fc','sc','pi'].forEach(function(id){if(typeof clearTabPending==='function')clearTabPending(id);});

  // Force feature flags on for demo — overrides any user-saved settings that disabled them
  appSettings.featPI=true;
  appSettings.featMI=true;
  featPI=true;
  featMI=true;
  // Re-run applyFeats with full state so tab visibility reflects demo data
  if(typeof applyFeats==='function')applyFeats();

  // Navigate to Discovery Map and render KPI tree from loaded gData
  setTimeout(function(){
    switchTab('mm');
    if(typeof renderMM==='function'&&gData)renderMM(gData);
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    if(typeof fcRenderCapNav==='function')fcRenderCapNav();
    if(typeof newScRender==='function')newScRender();
  }, 300);

  // Hide lock message — session is now active
  const homeLock=document.getElementById('home-tab-lock');
  if(homeLock)homeLock.style.display='none';

  // Refresh Home tab selector so Focusly shows as selected if PM returns to Home
  if(typeof _homeRenderProductSelector==='function')_homeRenderProductSelector();

  // Outcome Verification Loop: demo hypothesis population — covers
  // aligned/opposed/awaiting/not-applicable, plus one feature deliberately
  // left with no hypothesis, so Outcome Pulse demos meaningfully.
  _demoAttachOutcomeHypotheses([
    {name:'One-tap session start from home screen',
      primary:{metric:'First Focus Session Completion Rate',unit:'%',baseline:38,target:60,
        rationale:'Removing setup friction should let more new users complete a first session within 48 hours.'},
      actual:57,signal:'aligned'},
    {name:'User can view and manage cookie consent preferences so that they have control over their data',
      primary:{metric:'Onboarding Completion Rate',unit:'%',baseline:72,target:85,
        rationale:'A clearer consent flow should reduce early drop-off during onboarding.'},
      actual:68,signal:'opposed'},
    {name:'User can share focus streak so that friends are inspired to start their own',
      primary:{metric:'Referral Install Rate',unit:'%',baseline:4,target:9,
        rationale:'Prompting a share at the peak streak moment should lift referral conversion.'}
      // no actual/signal — deliberately left Awaiting
    }
  ]);
  _demoSetNsmTracking(18,32,24.6);

  console.log('Demo data loaded — Focusly product, 12 metrics, '+Object.keys(capStore).length+' metrics with capabilities, '+scCanvas.length+' features on Story Canvas');
}

// Called when a real API key is entered after demo mode was active
// ── OrderHub demo dataset — B2B omnichannel order orchestration (Capability-Driven) ──
function _demoLoadOrderHub(){
  // ── 1. Populate company profile and product profiles ──

  companyProfile={
    companyName:'OrderHub Systems',
    companyIndustry:'Retail',
    companyUrl:'https://orderhub.io',
    companyStrategy:'Become the order orchestration layer of choice for large-format omnichannel retailers, unifying inventory promises, fulfilment, and returns across every channel.',
    companyContext:'B2B SaaS, mid-market to enterprise retail customers. Land-and-expand model — typically starts with order capture, expands into fulfilment orchestration and returns within 12-18 months.',
    companyRefLink:'',
    companyDocs:[]
  };

  const orderHubProfile={
    id:'demo-orderhub',
    productName:'OrderHub',
    productDesc:'A B2B SaaS order orchestration platform for large-format omnichannel retailers, coordinating order capture, real-time inventory promises, warehouse and store fulfilment, last-mile delivery, and returns across web, app, and in-store channels.',
    industry:'Retail',
    productType:'B2B SaaS',
    kpis:'Order fill rate, on-time-in-full (OTIF), return processing time',
    problem:'Customers see inaccurate stock promises at checkout, causing failed promises and order cancellations downstream',
    icp:'Omnichannel operations and fulfilment teams at large-format home, furniture, and big-box retailers',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  const focuslyProfile={
    id:'demo-focusly',
    productName:'Focusly',
    productDesc:'A B2C consumer productivity app that helps knowledge workers build deep focus habits through session tracking, distraction blocking, and habit loop reinforcement.',
    industry:'Technology & Software',
    productType:'B2C Product',
    kpis:'DAU, session length, 7-day retention',
    problem:'High drop-off after first week - users complete onboarding but never form a habit',
    icp:'Knowledge workers and students, 22-40, remote-first',
    additionalContext:'',
    refLink:'https://focusly.app',
    docs:[]
  };

  const mindBridgeProfile={
    id:'demo-mindbridge',
    productName:'MindBridge',
    productDesc:'A B2C mental wellness app offering guided CBT exercises, mood tracking, and therapist-matching for adults managing anxiety and stress.',
    industry:'Health & Life Sciences',
    productType:'B2C Product',
    kpis:'Daily active users, session completion rate, 30-day retention',
    problem:'Users complete intake assessment but disengage before completing first therapy module',
    icp:'Adults 25-45 experiencing work-related stress or mild anxiety, not in clinical care',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  const oneCartProfile={
    id:'demo-onecart',
    productName:'OneCart',
    productDesc:'A B2C unified cart and checkout platform for a multi-business consumer group (theme parks, resorts, dining, merchandise, and experiences), letting guests discover, assemble, and pay for items across business lines in a single transaction.',
    industry:'Travel & Hospitality',
    productType:'B2C Product',
    kpis:'Cross-business attach rate, unified checkout completion rate, average order value per booking',
    problem:'Guests booking a park ticket rarely add hotel, dining, or merchandise in the same transaction because each business line has its own checkout, causing fragmented bookings and lost attach revenue',
    icp:'Leisure travellers and families planning a multi-day visit across parks, hotels, dining, and experiences',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  productProfiles=[orderHubProfile, focuslyProfile, oneCartProfile, mindBridgeProfile];
  activeProfileId='demo-orderhub';

  // ── 2. Inject gData (Discovery Map — Capability-Driven, L1 only) ──
  gData={
    approach:'capability-based',
    nsm:{
      metric:'Order Fill Rate',
      definition:'Percentage of customer orders fulfilled in full from the originally promised location and date, without substitution, delay, or cancellation'
    },
    measurementModel:{
      modelName:'Omnichannel Order Orchestration Model',
      frameworks:['GS1 Supply Chain Reference Model','APQC PCF'],
      rationale:'OrderHub orchestrates the order lifecycle across channels for large-format retail — a supply-chain value chain lens fits better than a consumer growth funnel.'
    },
    stages:[
      {id:'order_capture',label:'Order Capture',description:'Capture and validate customer orders across web, app, and store',l1_metrics:[
        {name:'Real-Time Availability Promise at Capture',why:'Ensures stock promises shown at checkout reflect true available-to-promise inventory'},
        {name:'Multi-Channel Order Validation',why:'Catches address, payment, and configuration errors before orders enter fulfilment'},
        {name:'Store-to-Online Order Routing',why:'Lets in-store associates place online orders for out-of-stock items without losing the sale'}
      ]},
      {id:'inventory_atp',label:'Inventory & ATP',description:'Maintain a real-time available-to-promise view across all locations',l1_metrics:[
        {name:'Unified Inventory Ledger',why:'Single real-time view of stock across stores, warehouses, and in-transit'},
        {name:'Safety Stock & Buffer Management',why:'Prevents overselling by reserving buffer stock for high-demand SKUs'},
        {name:'Demand Signal Integration',why:'Feeds promotional and seasonal demand signals into ATP calculations'}
      ]},
      {id:'fulfillment',label:'Fulfillment Orchestration',description:'Route, pick, pack, and prepare orders for dispatch from the optimal location',l1_metrics:[
        {name:'Optimal Fulfilment Location Engine',why:'Selects the lowest-cost, fastest location to fulfil each order line'},
        {name:'Split Shipment Minimisation',why:'Reduces shipping cost and packaging waste from unnecessary multi-parcel orders'},
        {name:'Warehouse Pick-Pack Sequencing',why:'Sequences picks to reduce warehouse labour time per order'}
      ]},
      {id:'delivery',label:'Delivery & Last-Mile',description:'Coordinate carrier handoff and last-mile delivery to the customer',l1_metrics:[
        {name:'Carrier Selection & Rate Shopping',why:'Automatically selects the carrier offering the best cost-to-speed ratio per shipment'},
        {name:'Delivery Promise Accuracy Tracking',why:'Monitors whether delivery date promises made at checkout are actually met'},
        {name:'Proactive Delay Notification',why:'Notifies customers of delays before they contact support, reducing ticket volume'}
      ]},
      {id:'returns',label:'Returns',description:'Process return requests, validate eligibility, and restock or refund',l1_metrics:[
        {name:'Automated Return Eligibility Engine',why:'Validates return eligibility against order data and policy rules in real time'},
        {name:'Return Reason Capture & Routing',why:'Captures structured return reasons and routes items to restock, liquidation, or disposal'},
        {name:'Refund Processing Speed',why:'Reduces time between return receipt and refund issuance, a top driver of repeat purchase'}
      ]}
    ]
  };

  // ── 3. Inject capStore (full depth: Order Capture and Returns only) ──
  capStore={};
  capStoreInvalidated=false;

  const addCap=(stageId,metricName,stageLabel,capabilities)=>{
    const key=stageId+'||'+metricName;
    capStore[key]={metricName,stageLabel,stageId,capabilities};
  };

  // ── Order Capture: full capability → feature depth ──
  addCap('order_capture','Real-Time Availability Promise at Capture','Order Capture',[
    {name:'Live ATP Commit Engine',why:'Queries real-time available-to-promise stock per store and fulfilment unit at the moment of order capture',
      subCaps:[{name:'Store-level ATP query service',why:'Resolves stock availability per location in under 200ms at checkout'},{name:'Promise window calculator',why:'Computes the earliest fulfilable delivery window per location'}],
      featStore:{top:[
        {name:'Real-time stock check at add-to-cart',why:'Queries ATP across all locations the moment an item is added to cart, preventing late-stage cancellations',selected:true,metric:'Real-Time Availability Promise at Capture',stage:'Order Capture',cap:'Live ATP Commit Engine',subCap:null},
        {name:'Promise date recalculation on cart change',why:'Recalculates the delivery promise whenever cart contents or quantities change',selected:false,metric:'Real-Time Availability Promise at Capture',stage:'Order Capture',cap:'Live ATP Commit Engine',subCap:null},
        {name:'Low-stock threshold warning banner',why:'Warns customers when remaining stock is below a configurable threshold, nudging faster checkout',selected:false,metric:'Real-Time Availability Promise at Capture',stage:'Order Capture',cap:'Live ATP Commit Engine',subCap:null}
      ]}},
    {name:'Substitution & Alternative Fulfilment Suggestions',why:'Offers in-stock alternatives or nearby-store pickup when the requested item is unavailable',
      subCaps:null,
      featStore:{top:[
        {name:'Nearby store pickup suggestion on stockout',why:'When an item is out of stock for delivery, suggests pickup from the nearest store with stock',selected:false,metric:'Real-Time Availability Promise at Capture',stage:'Order Capture',cap:'Substitution & Alternative Fulfilment Suggestions',subCap:null},
        {name:'Similar-product substitution carousel',why:'Surfaces visually and functionally similar in-stock products when the selected SKU is unavailable',selected:false,metric:'Real-Time Availability Promise at Capture',stage:'Order Capture',cap:'Substitution & Alternative Fulfilment Suggestions',subCap:null}
      ]}},
    {name:'Checkout Promise Confidence Indicator',why:'Shows customers a confidence signal on delivery date accuracy based on historical fulfilment performance',
      subCaps:null,featStore:{}}
  ]);

  addCap('order_capture','Multi-Channel Order Validation','Order Capture',[
    {name:'Address & Serviceability Validation',why:'Validates delivery addresses against carrier serviceable zones before order confirmation',
      subCaps:null,
      featStore:{top:[
        {name:'Real-time address autocomplete with serviceability check',why:'Validates the entered address is within a deliverable zone before the customer completes checkout',selected:false,metric:'Multi-Channel Order Validation',stage:'Order Capture',cap:'Address & Serviceability Validation',subCap:null}
      ]}},
    {name:'Payment & Fraud Pre-Screening',why:'Screens high-risk orders before they enter the fulfilment queue',
      subCaps:null,featStore:{}}
  ]);

  addCap('order_capture','Store-to-Online Order Routing','Order Capture',[
    {name:'Associate-Initiated Order Capture',why:'Lets store associates place online orders for customers when in-store stock is unavailable',
      subCaps:null,featStore:{}}
  ]);

  // ── Returns: full capability → feature depth ──
  addCap('returns','Automated Return Eligibility Engine','Returns',[
    {name:'Policy Rule Engine for Returns',why:'Validates return eligibility against order line data, purchase date, and item condition rules in real time',
      subCaps:[{name:'Category-specific return windows',why:'Applies different return windows for furniture, appliances, and general merchandise'},{name:'Proof-of-purchase matching',why:'Matches return requests to original order lines using receipt or order number'}],
      featStore:{top:[
        {name:'Instant return eligibility check at request',why:'Validates return eligibility against order line data, purchase date, and item condition rules in real time, reducing manual review time and ensuring customers receive accurate decisions faster',selected:true,metric:'Automated Return Eligibility Engine',stage:'Returns',cap:'Policy Rule Engine for Returns',subCap:null},
        {name:'Category-specific return window enforcement',why:'Applies different return windows for furniture (30 days), appliances (14 days), and general merchandise (90 days) automatically',selected:false,metric:'Automated Return Eligibility Engine',stage:'Returns',cap:'Policy Rule Engine for Returns',subCap:null},
        {name:'Final-sale and custom-order exclusion flags',why:'Automatically flags final-sale and custom/made-to-order items as non-returnable at the point of return request',selected:false,metric:'Automated Return Eligibility Engine',stage:'Returns',cap:'Policy Rule Engine for Returns',subCap:null}
      ]}},
    {name:'Self-Service Return Initiation',why:'Lets customers initiate and track returns without contacting support',
      subCaps:null,
      featStore:{top:[
        {name:'Self-service return request flow',why:'Allows customers to select items, choose a return reason, and receive a prepaid label without contacting support',selected:false,metric:'Automated Return Eligibility Engine',stage:'Returns',cap:'Self-Service Return Initiation',subCap:null},
        {name:'Return status tracking page',why:'Shows customers real-time status of their return from drop-off through refund issuance',selected:false,metric:'Automated Return Eligibility Engine',stage:'Returns',cap:'Self-Service Return Initiation',subCap:null}
      ]}},
    {name:'In-Store Return Drop-off',why:'Allows online orders to be returned at any physical store location',
      subCaps:null,featStore:{}}
  ]);

  addCap('returns','Return Reason Capture & Routing','Returns',[
    {name:'Structured Return Reason Taxonomy',why:'Captures standardised return reasons that feed back into product and merchandising decisions',
      subCaps:null,
      featStore:{top:[
        {name:'Guided return reason selector',why:'Presents a structured set of return reasons (size, defect, changed mind, not as described) rather than free text',selected:false,metric:'Return Reason Capture & Routing',stage:'Returns',cap:'Structured Return Reason Taxonomy',subCap:null}
      ]}},
    {name:'Restock vs Liquidation Routing',why:'Routes returned items to restock, liquidation, or disposal based on condition and category rules',
      subCaps:null,featStore:{}}
  ]);

  addCap('returns','Refund Processing Speed','Returns',[
    {name:'Instant Refund on Drop-off Scan',why:'Triggers refund processing the moment a return is scanned at a carrier or store drop-off point',
      subCaps:null,
      featStore:{top:[
        {name:'Refund-on-scan at carrier drop-off',why:'Initiates refund processing as soon as the return parcel is scanned by the carrier, rather than waiting for warehouse receipt',selected:false,metric:'Refund Processing Speed',stage:'Returns',cap:'Instant Refund on Drop-off Scan',subCap:null}
      ]}}
  ]);

  // ── PI-first capability — Holiday Returns Policy (for traceability demo) ──
  capStore['pi||holiday-returns']={
    metricName:'Holiday Returns Policy',
    stageLabel:'PI Plan',
    stageId:'pi',
    capabilities:[{
      name:'Holiday Returns Policy',
      why:'Extended holiday return window required before Q4 peak season',
      subCaps:null,
      featStore:{top:[
        {name:'Extended Holiday Return Window',why:'Items purchased between November 1 and December 24 are returnable through January 31, overriding standard category return windows',
         selected:false,metric:'',stage:'PI Plan',cap:'Holiday Returns Policy',subCap:null}
      ]}
    }]
  };

  // ── 4. Pre-populate Story Canvas with 2 features ──
  scCanvas=[];
  Object.values(capStore).forEach(entry=>{
    entry.capabilities.forEach(cap=>{
      if(cap.featStore){
        Object.entries(cap.featStore).forEach(([fkey,feats])=>{
          (feats||[]).forEach(f=>{
            if(f.selected){
              const fid=scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name);
              if(!scCanvas.find(x=>x.id===fid)){
                scCanvas.push({id:fid,metric:f.metric,metricPath:scGetMetricPath(f.metric)||f.metric,stage:f.stage,
                  cap:f.cap+(f.subCap?' › '+f.subCap:''),name:f.name,why:f.why,stories:null,origin:'kpi'});
              }
            }
          });
        });
      }
    });
  });

  // ── 4a. Add one Path D (PI-first, unlinked) demo feature for traceability demo ──
  scCanvas.push({
    id:scMakeFeatureId('','Holiday Returns Policy','Extended Holiday Return Window'),
    metric:'',
    metricPath:'',
    stage:'PI Plan',
    cap:'Holiday Returns Policy',
    name:'Extended Holiday Return Window',
    why:'Extended holiday return window required before Q4 peak season',
    stories:null,
    origin:'pi'
  });

  // ── 4b. Add pre-built stories to 2 demo features + PI-first feature ──
  scStoryIdCounter=0;
  scCanvas.forEach(function(feat){
    if(feat.name==='Real-time stock check at add-to-cart'){
      feat.stories=[
        {id:'ST-001',title:'Customer sees live stock availability when adding an item to cart so that they trust the delivery promise',statement:'As an OrderHub customer, I want to see real-time stock availability when I add an item to my cart, so that I can trust the delivery date shown at checkout.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Item in stock at nearest fulfilment location',given:'Customer adds an in-stock item to cart',when:'The cart updates',then:'A live availability check confirms stock at the nearest fulfilment location within 200ms',and:'The estimated delivery date is calculated from that location'},{name:'Item out of stock at nearest location',given:'Customer adds an item that is out of stock at the nearest location',when:'The cart updates',then:'The system checks the next-nearest location with stock',and:'The delivery date reflects the alternate location, with a note explaining the change'}]},
        {id:'ST-002',title:'Customer sees the cart update the delivery date when quantity changes so that the promise stays accurate',statement:'As an OrderHub customer, I want the delivery date to update if I change the quantity of an item, so that the promise I see is always accurate.',points:2,priority:'Should Have',dor:'READY',dorReason:'',scenarios:[{name:'Quantity increase exceeds available stock at promised location',given:'Customer increases quantity beyond what is available at the promised location',when:'The cart recalculates',then:'The delivery date updates to reflect fulfilment from a secondary location or a later restock date',and:''}]},
        {id:'ST-003',title:'Ops team can configure the low-stock threshold per category so that promise accuracy is tuned by product type',statement:'As an OrderHub operations admin, I want to configure the low-stock warning threshold per product category, so that fast-moving categories trigger warnings earlier than slow-moving ones.',points:2,priority:'Could Have',dor:'READY',dorReason:'',scenarios:[{name:'Admin sets category threshold',given:'Admin opens the inventory threshold settings',when:'Admin sets a threshold of 10 units for the Sofas category',then:'Items in the Sofas category show a low-stock banner once available stock falls below 10',and:''}]}
      ];
      scStoryIdCounter=3;
    }
    if(feat.name==='Instant return eligibility check at request'){
      feat.stories=[
        {id:'ST-004',title:'Customer gets an instant return decision so that they know next steps without waiting for support',statement:'As an OrderHub customer, I want to get an instant return eligibility decision when I request a return, so that I know my next steps without waiting for support.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Item is within category return window',given:'Customer requests a return for an item purchased 20 days ago in a category with a 30-day window',when:'The eligibility engine evaluates the request',then:'The return is approved instantly and the customer is shown next steps',and:'A prepaid return label is generated automatically'},{name:'Item is outside category return window',given:'Customer requests a return for an item purchased 45 days ago in a category with a 30-day window',when:'The eligibility engine evaluates the request',then:'The return is declined instantly with the policy reason shown',and:'The customer is offered an option to contact support for an exception'}]},
        {id:'ST-005',title:'Ops team can configure category-specific return windows so that policy matches product type',statement:'As an OrderHub operations admin, I want to configure return windows by product category, so that furniture, appliances, and general merchandise each follow the correct policy.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Admin sets furniture return window to 30 days',given:'Admin opens category return policy settings',when:'Admin sets the Furniture category window to 30 days',then:'All future return eligibility checks for Furniture items use the 30-day window',and:'Existing in-flight return requests are unaffected'}]},
        {id:'ST-006',title:'System flags final-sale items as non-returnable at request time so that exceptions are minimised',statement:'As an OrderHub customer, I want to be told immediately if an item I am trying to return was a final-sale item, so that I do not waste time submitting an ineligible request.',points:2,priority:'Should Have',dor:'READY',dorReason:'',scenarios:[{name:'Customer attempts to return a final-sale item',given:'Customer selects a final-sale item from their order history to return',when:'The customer initiates the return request',then:'The system immediately shows a non-returnable message with the final-sale reason',and:'The request is not submitted for review'}]}
      ];
      scStoryIdCounter=6;
    }
    if(feat.name==='Extended Holiday Return Window'){
      feat.stories=[
        {id:'ST-007',title:'Customer sees the extended holiday return window applied to eligible purchases so that holiday shopping feels lower-risk',statement:'As an OrderHub customer, I want items purchased during the holiday period to have an extended return window through January 31, so that gifts bought in November and December can be returned after the holidays.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Item purchased in holiday window',given:'Customer purchased an item on December 10',when:'Customer requests a return on January 20',then:'The return is evaluated against the extended holiday window (through January 31) rather than the standard category window',and:'The return is approved as within policy'},{name:'Item purchased outside holiday window',given:'Customer purchased an item on October 15',when:'Customer requests a return on January 20',then:'The return is evaluated against the standard category return window, not the holiday extension',and:''}]},
        {id:'ST-008',title:'Ops team can set the holiday return window dates each year so that the policy can be reconfigured annually',statement:'As an OrderHub operations admin, I want to configure the holiday return window start and end dates each year, so that the policy can adapt to changing holiday calendars.',points:2,priority:'Should Have',dor:'READY',dorReason:''}
      ];
      scStoryIdCounter=8;
    }
  });

  // ── Market Intelligence demo data ──
  miGenerated=true;
  miProductMode='market';
  miData={
    productMode:'market',
    marketSnapshot:[
      {value:'$6.1B',label:'Order management software market 2025',source:'MarketsandMarkets',year:'2025',trend:'↑ 14.2% CAGR'},
      {value:'14.2%',label:'CAGR to 2030',source:'MarketsandMarkets',year:'2025',trend:''},
      {value:'$2.8B',label:'Returns management software TAM',source:'Gartner',year:'2025',trend:'↑'},
      {value:'#1',label:'Top buyer criterion',source:'Market analysis',year:'2025',trend:'Real-time ATP accuracy'}
    ],
    buyerCriteria:[
      {rank:1,criterion:'Real-time inventory accuracy across channels',evidence:'82% of omnichannel retailers cite inventory accuracy as the top blocker to expanding ship-from-store',source:'Retail Systems Research',year:'2025',productRelevance:'Core differentiator — Live ATP Commit Engine is OrderHub\'s flagship capability'},
      {rank:2,criterion:'Returns processing speed',evidence:'68% of consumers say return experience affects their decision to shop with a retailer again',source:'NRF Returns Study',year:'2025',productRelevance:'OrderHub has automated eligibility checks — refund speed is the remaining gap'},
      {rank:3,criterion:'Carrier rate shopping automation',evidence:'Retailers using automated carrier selection report 9-14% reduction in shipping cost per order',source:'Shipware Benchmark',year:'2025',productRelevance:'Current gap — carrier selection capability not yet generated'}
    ],
    trends:[
      {name:'AI-driven demand sensing for ATP',confidence:'CONFIRMED HIGH',signal:'ACTIVE',evidence:'Major order management vendors (Manhattan Associates, Fluent Commerce) launched AI demand-sensing modules in 2024-25 to improve ATP accuracy during promotions',source:'Gartner Market Guide, 2025',implication:'Static safety-stock buffers are no longer sufficient during promotional spikes',productGap:'OrderHub uses static buffer rules — no demand-sensing layer',roadmapAction:'Accelerate — add AI demand-sensing to Safety Stock & Buffer Management'},
      {name:'Returns-as-a-channel monetisation',confidence:'CONFIRMED MEDIUM',signal:'ACTIVE',evidence:'Retailers offering instant store credit on return drop-off see 23% higher repeat purchase within 30 days',source:'NRF Returns Study, 2025',implication:'Returns flows are becoming a retention and re-purchase lever, not just a cost centre',productGap:'OrderHub processes refunds but does not offer instant store-credit incentives',roadmapAction:'Accelerate — add instant store-credit option to Refund Processing Speed'},
      {name:'Carrier diversification post-disruption',confidence:'CONFIRMED MEDIUM',signal:'ACTIVE',evidence:'73% of large retailers added a second or third national carrier after 2023-24 peak season disruptions',source:'Supply Chain Dive, 2025',implication:'Single-carrier integrations are now a resilience risk for enterprise retailers',productGap:'OrderHub has no carrier selection or rate-shopping capability generated yet',roadmapAction:'Accelerate — prioritise Carrier Selection & Rate Shopping generation'},
      {name:'Buy-online-return-in-store (BORIS) saturation',confidence:'CONFIRMED HIGH',signal:'PEAKING',evidence:'BORIS is now offered by 91% of large-format retailers — adoption growth has plateaued',source:'Retail Systems Research, 2025',implication:'BORIS is table stakes, not a differentiator',productGap:'In-Store Return Drop-off capability already covers this',roadmapAction:'Protect — maintain BORIS reliability, do not over-invest in differentiation here'}
    ],
    competitors:[
      {name:'Manhattan Active Omni',capabilities:[{domain:'Real-time ATP',status:'present'},{domain:'AI demand sensing',status:'present'},{domain:'Returns automation',status:'present'},{domain:'Carrier rate shopping',status:'present'}]},
      {name:'Fluent Commerce',capabilities:[{domain:'Real-time ATP',status:'present'},{domain:'AI demand sensing',status:'partial'},{domain:'Returns automation',status:'present'},{domain:'Carrier rate shopping',status:'partial'}]},
      {name:'Salesforce Order Management',capabilities:[{domain:'Real-time ATP',status:'present'},{domain:'AI demand sensing',status:'gap'},{domain:'Returns automation',status:'partial'},{domain:'Carrier rate shopping',status:'gap'}]}
    ],
    competitorDeepDives:[
      {name:'Manhattan Active Omni',narrative:'Manhattan Active Omni is the enterprise incumbent with the deepest ATP and fulfilment orchestration footprint, now extended with AI demand-sensing for promotional accuracy. Its complexity and implementation timelines (often 9-12 months) are its main weakness against faster-deploying challengers.',leadAreas:'AI demand sensing, carrier rate shopping, enterprise scale',productAdvantage:'OrderHub\'s faster implementation timeline and simpler configuration for mid-market retailers',threat:'Manhattan\'s AI demand-sensing module sets a new market expectation for ATP accuracy during peak demand'},
      {name:'Fluent Commerce',narrative:'Fluent Commerce has grown quickly among mid-market omnichannel retailers with a cloud-native, faster-to-deploy platform. Its returns automation is mature, but carrier rate shopping remains partial, similar to OrderHub\'s current gap.',leadAreas:'Cloud-native deployment speed, returns automation maturity',productAdvantage:'OrderHub\'s Live ATP Commit Engine offers sub-200ms response — competitive with Fluent\'s benchmark',threat:'Fluent is closing the deployment-speed gap that has been OrderHub\'s main differentiator against Manhattan'}
    ],
    swot:{
      strengths:[
        {text:'Live ATP Commit Engine resolves stock availability in under 200ms at checkout',source:'Internal benchmark 2025'},
        {text:'Automated return eligibility engine reduces manual review time significantly',source:'Customer pilot data'}
      ],
      weaknesses:[
        {text:'No carrier rate-shopping or selection capability generated yet',source:'Capability Canvas gap',researchIdentified:false},
        {text:'No AI demand-sensing layer — safety stock buffers are static',source:'Gartner Market Guide 2025',researchIdentified:true}
      ],
      opportunities:[
        {text:'Returns-as-a-channel — instant store credit drives 23% higher repeat purchase within 30 days',source:'NRF Returns Study 2025'},
        {text:'AI demand-sensing for ATP — emerging market expectation during promotional spikes',source:'Gartner Market Guide 2025'}
      ],
      threats:[
        {text:'Manhattan Active Omni\'s AI demand-sensing module raises the market baseline for ATP accuracy',source:'Gartner Market Guide, 2025'},
        {text:'73% of large retailers now run multi-carrier strategies — single-carrier gaps are a competitive risk',source:'Supply Chain Dive, 2025'}
      ],
      synthesis:'OrderHub\'s Live ATP Commit Engine and automated returns eligibility are genuine strengths at the core of the order lifecycle. The structural risk is that AI demand-sensing and carrier rate shopping are becoming market expectations, and OrderHub has not yet generated capabilities in either area.'
    },
    capabilities:[
      {name:'Live ATP Commit Engine',marketEvidence:'82% of omnichannel retailers cite inventory accuracy as the top blocker to ship-from-store expansion (Retail Systems Research 2025)',kpiTreeMatch:'aligned',kpiTreeMetric:'Real-Time Availability Promise at Capture',kpiTreeStage:'Order Capture',kpiTreePath:'Real-Time Availability Promise at Capture'},
      {name:'AI demand-sensing for ATP',marketEvidence:'Manhattan Active Omni and Fluent Commerce both launched AI demand-sensing modules in 2024-25 — market baseline shifting',kpiTreeMatch:'none',kpiTreeMetric:'',kpiTreeStage:'',kpiTreePath:''},
      {name:'Automated Return Eligibility Engine',marketEvidence:'68% of consumers say return experience affects repeat purchase decisions (NRF Returns Study 2025)',kpiTreeMatch:'aligned',kpiTreeMetric:'Automated Return Eligibility Engine',kpiTreeStage:'Returns',kpiTreePath:'Automated Return Eligibility Engine'},
      {name:'Carrier Selection & Rate Shopping',marketEvidence:'Automated carrier selection reduces shipping cost per order by 9-14% (Shipware Benchmark 2025)',kpiTreeMatch:'partial',kpiTreeMetric:'Carrier Selection & Rate Shopping',kpiTreeStage:'Delivery & Last-Mile',kpiTreePath:'Carrier Selection & Rate Shopping'},
      {name:'Instant store-credit on returns',marketEvidence:'Retailers offering instant store credit on return drop-off see 23% higher repeat purchase within 30 days (NRF 2025)',kpiTreeMatch:'partial',kpiTreeMetric:'Refund Processing Speed',kpiTreeStage:'Returns',kpiTreePath:'Refund Processing Speed'}
    ],
    docxSections:{
      marketOverview:'The order management software market reached an estimated $6.1B in 2025, growing at 14.2% CAGR. Returns management software is a fast-growing adjacent category at $2.8B TAM, driven by rising consumer expectations around return speed and convenience.',
      buyerCriteriaNarrative:'Three buyer priorities dominate: real-time inventory accuracy across channels (82% cite as the top blocker to ship-from-store expansion), returns processing speed (68% say it affects repeat purchase decisions), and carrier rate shopping automation (9-14% shipping cost reduction).',
      productMarketPosition:'OrderHub is well-positioned on real-time ATP accuracy and returns eligibility automation, but has a confirmed gap on AI demand-sensing and an emerging gap on carrier rate shopping as competitors raise the market baseline.',
      trendsNarrative:'AI-driven demand sensing for ATP is the dominant active trend among enterprise vendors. Returns-as-a-channel monetisation is actively differentiating retention. Carrier diversification is now a resilience expectation. BORIS adoption has peaked and is now table stakes.',
      competitiveSummary:'Manhattan Active Omni leads on enterprise scale and AI demand-sensing but carries long implementation timelines. Fluent Commerce is closing the deployment-speed gap. OrderHub\'s advantage is its sub-200ms Live ATP Commit Engine and faster mid-market implementation.',
      swotSynthesis:'OrderHub\'s Live ATP Commit Engine and automated returns eligibility are defensible strengths today. The structural risk is that AI demand-sensing and carrier rate shopping are becoming table-stakes expectations set by Manhattan and Fluent.',
      gapMatrix:[
        {expectation:'AI-driven demand sensing for ATP during promotions',today:'Static safety-stock buffer rules only',severity:'H',gap:'No ML model adjusting buffers for promotional demand spikes',opportunity:'Add demand-sensing layer to Safety Stock & Buffer Management targeting promotional ATP accuracy'},
        {expectation:'Carrier rate shopping and multi-carrier selection',today:'No carrier selection capability generated',severity:'H',gap:'73% of large retailers run multi-carrier strategies; OrderHub has zero carrier orchestration capability',opportunity:'Generate Carrier Selection & Rate Shopping capabilities targeting 9-14% shipping cost reduction'},
        {expectation:'Instant store-credit incentive on returns',today:'Standard refund processing only',severity:'M',gap:'23% repeat-purchase uplift from instant store credit is unrealised',opportunity:'Add instant store-credit option alongside Refund Processing Speed capability'}
      ],
      capabilityMap:[
        {l1:'Order Capture',l2:'Live ATP Commit Engine',features:'Real-time stock check, promise recalculation, low-stock warnings',status:'Present',notes:'Sub-200ms response — genuine moat'},
        {l1:'Inventory & ATP',l2:'AI demand sensing',features:'Promotional demand forecasting, dynamic buffer adjustment',status:'GAP',notes:'Manhattan and Fluent both live — critical gap'},
        {l1:'Delivery & Last-Mile',l2:'Carrier rate shopping',features:'Multi-carrier rate comparison, automated carrier selection',status:'GAP',notes:'No capability generated yet — 9-14% cost reduction opportunity'},
        {l1:'Returns',l2:'Refund incentives',features:'Instant store credit, loyalty point bonus on return',status:'Partial',notes:'Refund processing exists but no incentive layer'}
      ],
      roadmap:[
        {capability:'AI demand-sensing for ATP',priority:'Accelerate',timeline:'Q3 2025',rationale:'Market baseline shifting ahead of peak season. Window to differentiate is 2-3 quarters.'},
        {capability:'Carrier Selection & Rate Shopping',priority:'Accelerate',timeline:'Q3 2025',rationale:'73% of large retailers run multi-carrier strategies. Zero current capability is a competitive gap.'},
        {capability:'Instant store-credit on returns',priority:'Protect',timeline:'Q4 2025',rationale:'23% repeat-purchase uplift. Extend existing returns automation investment.'},
        {capability:'BORIS reliability',priority:'Protect',timeline:'Ongoing',rationale:'Table stakes — maintain reliability, do not over-invest in differentiation.'}
      ],
      valueAnchors:[
        {capability:'AI demand-sensing for ATP',benchmark:'Manhattan and Fluent both launched AI demand-sensing modules in 2024-25',source:'Gartner Market Guide 2025'},
        {capability:'Carrier rate shopping',benchmark:'Automated carrier selection reduces shipping cost per order by 9-14%',source:'Shipware Benchmark 2025'},
        {capability:'Instant store-credit on returns',benchmark:'23% higher repeat purchase within 30 days when instant store credit is offered on return',source:'NRF Returns Study 2025'}
      ],
      sources:[
        {source:'MarketsandMarkets — Order Management Software Market',scope:'Market size, CAGR',year:'2025',confidence:'Medium-High'},
        {source:'Gartner — Market Guide for Order Management Systems',scope:'AI demand-sensing trend',year:'2025',confidence:'High'},
        {source:'NRF Returns Study',scope:'Returns processing speed and store-credit incentives',year:'2025',confidence:'High'},
        {source:'Shipware Benchmark',scope:'Carrier rate shopping cost impact',year:'2025',confidence:'Medium'},
        {source:'Supply Chain Dive',scope:'Carrier diversification trend',year:'2025',confidence:'Medium'}
      ],
      methodologyNote:'Research produced from AI training data. All stats should be verified independently. Web-sourced research will be added in v5.1.',
      limitations:'All statistics are AI-generated from training data. No live web search was performed in this generation (v5.0).'
    }
  };
  miCapabilities=miData.capabilities;
  capStore['mi||capabilities']={
    metricName:'MI Capabilities',
    stageLabel:'Market Intelligence',
    stageId:'mi',
    _miCap:true,
    capabilities:[{
      name:'AI demand-sensing for ATP',
      why:'AI demand-sensing improves ATP accuracy during promotions. Manhattan Active Omni and Fluent Commerce use similar modules to reduce stockouts and over-reservation on high-velocity SKUs.',
      subCaps:null,
      featStore:{top:[
        {name:'Promotional demand forecast overlay',why:'Adjusts ATP buffers upward ahead of known promotional windows based on historical uplift patterns.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'AI demand-sensing for ATP',_miSent:false},
        {name:'Dynamic safety stock recalculation',why:'Recalculates safety stock thresholds nightly based on rolling 7-day demand velocity rather than static rules.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'AI demand-sensing for ATP',_miSent:false},
        {name:'Promotional ATP accuracy alert',why:'Flags SKUs where promotional demand is likely to exceed current ATP buffers.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'AI demand-sensing for ATP',_miSent:false}
      ]}
    }]
  };
  // Reveal MI tab unconditionally in demo mode
  const miTabElD=document.getElementById('tab-mi');
  if(miTabElD) miTabElD.style.display='';

  // ── 5. Render everything ──
  ddGenerated=false;
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;

  // Update header
  const pnEl=document.getElementById('hdr-product-name');
  if(pnEl){pnEl.textContent='OrderHub';pnEl.classList.add('has-name');}

  // Show demo badge
  _showDemoBadge();

  // Render Discovery Map
  const esEl=document.getElementById('es');
  if(esEl)esEl.style.display='none';
  const lsEl=document.getElementById('ls');
  if(lsEl)lsEl.classList.remove('on');
  const erEl=document.getElementById('er');
  if(erEl)erEl.classList.remove('on');
  const mmOut=document.getElementById('mm-out');
  if(mmOut)mmOut.innerHTML='';
  // Reset banner state and populate productContext for demo
  mmBannerCollapsed=false;
  productContext={
    name:'OrderHub',
    url:'',
    description:'A B2B SaaS order orchestration platform for large-format omnichannel retailers, coordinating order capture, real-time inventory promises, warehouse and store fulfilment, last-mile delivery, and returns across web, app, and in-store channels.',
    industry:'Retail',
    productType:'B2B SaaS',
    kpis:'Order fill rate, on-time-in-full (OTIF), return processing time',
    problem:'Customers see inaccurate stock promises at checkout, causing failed promises and order cancellations downstream',
    icp:'Omnichannel operations and fulfilment teams at large-format home, furniture, and big-box retailers',
    additionalContext:'',
    measurementModelName:'Omnichannel Order Orchestration Model',
    frameworks:['GS1 Supply Chain Reference Model','APQC PCF'],
    nsmMetric:'Order Fill Rate'
  };
  renderMM(gData);
  document.getElementById('mm-out').classList.add('on');
  if(typeof renderDiagnosticActionBar==='function')renderDiagnosticActionBar();

  // Render story canvas with pre-built features and stories
  fcRenderCanvas();
  fcRenderCapNav();
  fcUpdateTabBadge();
  if(typeof ccUpdateTabBadge==='function')ccUpdateTabBadge();

  // No PLA / Metrics Definition for OrderHub — tab-la stays hidden
  ddGenerated=false;

  // Reveal Capability Canvas tab (has capStore data)
  const ccTabElD=document.getElementById('tab-cc');
  if(ccTabElD)ccTabElD.style.display='';

  // ── PI Planning demo data — light board (2 squads, 2 sprints, ~9 stories) ──
  piMode=false;
  const _demoSquadsOH=[
    {name:'Capture Squad',  devs:3,sprints:2,availability:85,capacity:14},
    {name:'Returns Squad',  devs:3,sprints:2,availability:80,capacity:12}
  ];
  piInputs={type:'caps-only',
    piGoal:'Improve order fill rate and reduce return processing time before Q4 peak season.',
    constraints:'Carrier integration work is out of scope for this release — focus on capture accuracy and returns automation.',
    parsedCaps:[],parsedFeatures:[],
    carryForwardItems:['Address serviceability validation (partially complete from PI-2026-Q1)'],
    overlapResolutions:{}};

  // ── Story pool (standalone — not attached to SC features) ──
  if(typeof piStoryPool==='undefined'){piStoryPool={};}
  var _psOH=[
    // Capture Squad stories
    {id:'ST-CAP1',title:'Low-stock banner shown on product page',statement:'As an OrderHub customer, I want to see a low-stock banner on the product page when availability is below threshold, so that I can decide quickly whether to buy now.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CAP2',title:'Promise date shown at product page level',statement:'As an OrderHub customer, I want to see an estimated delivery date on the product page before adding to cart, so that I can plan my purchase.',points:2,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-CAP3',title:'Similar-product substitution carousel on stockout',statement:'As an OrderHub customer, I want to see similar in-stock products when my selected item is unavailable, so that I can still complete my purchase.',points:3,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-CAP4',title:'Real-time address autocomplete with serviceability check',statement:'As an OrderHub customer, I want my delivery address validated against serviceable zones as I type, so that I know upfront whether delivery is possible.',points:3,priority:'Must Have',dor:'IN REVIEW',dorReason:'Depends on carrier zone data feed'},
    // Returns Squad stories
    {id:'ST-RET1',title:'Guided return reason selector',statement:'As an OrderHub customer, I want to choose from a guided list of return reasons rather than free text, so that my return is processed faster.',points:2,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-RET2',title:'Return status tracking page',statement:'As an OrderHub customer, I want to track my return status from drop-off through refund, so that I know when to expect my money back.',points:3,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-RET3',title:'In-store return drop-off for online orders',statement:'As an OrderHub customer, I want to return an online order at any physical store, so that I do not need to arrange a courier pickup.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-RET4',title:'Restock vs liquidation routing rule configuration',statement:'As an OrderHub operations admin, I want to configure rules that route returned items to restock, liquidation, or disposal based on condition, so that recovered value is maximised.',points:5,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-RET5',title:'Refund-on-scan at carrier drop-off',statement:'As an OrderHub customer, I want my refund to begin processing as soon as my return parcel is scanned by the carrier, so that I get my money back faster.',points:3,priority:'Could Have',dor:'BLOCKED',dorReason:'Requires carrier scan webhook integration'}
  ];
  _psOH.forEach(function(s){piStoryPool[s.id]=s;});

  // ── Sprint board assignments ──
  var _saOH={
    'ST-001':  {sprint:1,squad:'Capture Squad', points:3,status:'planned'},
    'ST-002':  {sprint:1,squad:'Capture Squad', points:2,status:'planned'},
    'ST-CAP1': {sprint:1,squad:'Capture Squad', points:3,status:'planned'},
    'ST-RET1': {sprint:1,squad:'Returns Squad', points:2,status:'planned'},
    'ST-RET2': {sprint:1,squad:'Returns Squad', points:3,status:'planned'},

    'ST-003':  {sprint:2,squad:'Capture Squad', points:2,status:'planned'},
    'ST-CAP2': {sprint:2,squad:'Capture Squad', points:2,status:'planned'},
    'ST-004':  {sprint:2,squad:'Returns Squad', points:3,status:'planned'},
    'ST-005':  {sprint:2,squad:'Returns Squad', points:3,status:'planned'},
    'ST-RET3': {sprint:2,squad:'Returns Squad', points:3,status:'planned'}
  };
  var _backlogIdsOH=['ST-006','ST-CAP3','ST-CAP4','ST-RET4','ST-RET5'];

  const demoStartOH=new Date();
  demoStartOH.setDate(demoStartOH.getDate()+(7-demoStartOH.getDay())+1);
  const fmtOH=function(d){return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});};
  const demoSprintsOH=[];
  for(var iOH=0;iOH<2;iOH++){
    const sOH=new Date(demoStartOH);sOH.setDate(sOH.getDate()+iOH*14);
    const eOH=new Date(sOH);eOH.setDate(eOH.getDate()+13);
    demoSprintsOH.push({id:iOH+1,label:'Sprint '+(iOH+1),dateRange:fmtOH(sOH)+' \u2013 '+fmtOH(eOH)});
  }

  const _demoPlanOH={
    id:'rp-demo-oh',
    createdAt:Date.now(),
    name:_genDemoReleasePlanName(),
    startDate:demoStartOH.toISOString().split('T')[0],
    sprintCount:2,sprintDuration:14,
    sprints:demoSprintsOH,
    storyAssignments:_saOH,
    dependencies:[
      {fromId:'ST-CAP4',toId:'ST-RET5',type:'blocks',description:'Address serviceability and carrier scan integrations share the same carrier data feed'}
    ],
    externalDeps:[
      {description:'Carrier zone data feed access for address serviceability validation',owner:'Carrier Partner API team',dueDate:'Sprint 1',status:'in-progress'}
    ],
    businessValueBullets:[
      'Improve order fill rate by surfacing accurate stock signals earlier in the funnel',
      'Reduce return processing time through guided reasons and in-store drop-off',
      'Lay groundwork for carrier-dependent capabilities (address validation, refund-on-scan)'
    ],
    businessValueOneLiner:'This release improves order capture accuracy and returns processing speed ahead of Q4 peak season.',
    backlogNotes:{
      'ST-CAP4':'Blocked on carrier zone data feed — see external dependency',
      'ST-RET5':'Blocked on carrier scan webhook integration'
    },
    squads:_demoSquadsOH
  };
  piPlans=[_demoPlanOH];
  _piActivePlanId=_demoPlanOH.id;
  piBacklogStoryIds=(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds))?piBacklogStoryIds:[];
  _backlogIdsOH.forEach(function(id){if(!piBacklogStoryIds.includes(id))piBacklogStoryIds.push(id);});

  // Set _inSC and _inPIPlan flags on demo stories
  const _piInPlanIdsOH=['ST-001','ST-002','ST-004','ST-005'];
  scCanvas.forEach(function(f){
    if(f.stories){f.stories.forEach(function(st){
      st._inSC=true;st._hiddenFromSC=false;
      st._inPIPlan=_piInPlanIdsOH.includes(st.id);st._stagedForPI=false;
    });}
  });
  // Add a demo dependency: ST-008 blocks ST-007 (Holiday Returns Policy)
  scCanvas.forEach(function(f){
    if(f.name==='Extended Holiday Return Window'&&f.stories&&f.stories.length>1){
      f.stories[1].dependencies=[{direction:'blocks',storyId:'ST-007',storyTitle:'Customer sees the extended holiday return window applied to eligible purchases'}];
    }
  });
  // Rebuild scPiSelectedIds from story flags
  scPiSelectedIds=new Set();
  scCanvas.forEach(function(f){if(f.stories&&f.stories.some(function(s){return s._stagedForPI;}))scPiSelectedIds.add(f.id);});
  piScVersion=scCanvas.map(function(f){return f.id;}).join('|');
  if(typeof scApplyPIPlannedBadges==='function')scApplyPIPlannedBadges(_saOH);
  if(typeof piUpdateTabBadge==='function')piUpdateTabBadge();

  // ── Set sessionContext for demo session ──
  sessionContext={
    companyProfile:JSON.parse(JSON.stringify(companyProfile)),
    productProfile:JSON.parse(JSON.stringify(productProfiles[0])),
    approach:'capability-based',
    generationMode:'ai-generated',
    manualList:[],
    customValueChain:'',
    additionalContext:'',
    marketIntelligence:false,
    launchedAt:Date.now()
  ,
    allowAISuggestions:false,
    sessionDocs:[]
  };;
  sessionActive=true;

  // Reveal tabs — mm, cc, mi, fc + gated sc and pi (no la — PLA decommissioned)
  const tabMm=document.getElementById('tab-mm');
  if(tabMm)tabMm.style.display='';
  const tabCc=document.getElementById('tab-cc');
  if(tabCc)tabCc.style.display='';
  const tabMi=document.getElementById('tab-mi');
  if(tabMi)tabMi.style.display='';
  const tabFc=document.getElementById('tab-fc');
  if(tabFc)tabFc.style.display='';
  const tabSc=document.getElementById('tab-sc');
  if(tabSc){tabSc.style.display='';tabSc.classList.add('revealed');}
  const tabPi=document.getElementById('tab-pi');
  if(tabPi){tabPi.style.display='';tabPi.classList.add('revealed');}

  // Demo sessions start pre-populated, not "newly sent" - clear any
  // stale pending dots from a prior live session
  ['cc','fc','sc','pi'].forEach(function(id){if(typeof clearTabPending==='function')clearTabPending(id);});

  // Force feature flags on for demo — overrides any user-saved settings that disabled them
  appSettings.featPI=true;
  appSettings.featMI=true;
  featPI=true;
  featMI=true;
  // Re-run applyFeats with full state so tab visibility reflects demo data
  if(typeof applyFeats==='function')applyFeats();

  // Navigate to Discovery Map and render KPI tree from loaded gData
  setTimeout(function(){
    switchTab('mm');
    if(typeof renderMM==='function'&&gData)renderMM(gData);
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    if(typeof fcRenderCapNav==='function')fcRenderCapNav();
    if(typeof newScRender==='function')newScRender();
  }, 300);

  // Hide lock message — session is now active
  const homeLock=document.getElementById('home-tab-lock');
  if(homeLock)homeLock.style.display='none';

  // Refresh Home tab selector so OrderHub shows as selected if PM returns to Home
  if(typeof _homeRenderProductSelector==='function')_homeRenderProductSelector();

  // Outcome Verification Loop: demo hypothesis population
  _demoAttachOutcomeHypotheses([
    {name:'GDPR Consent Settings',
      primary:{metric:'EU Signup Completion Rate',unit:'%',baseline:41,target:65,
        rationale:'Regulatory compliance removes a legal blocker preventing EU market signups entirely.'}
      // Not applicable — this is a pure compliance/legal feature, not an outcome bet
      ,signal:'not-applicable'},
    {name:'Extended Holiday Return Window',
      primary:{metric:'Return Processing Time',unit:'days',baseline:6,target:3,
        rationale:'Guided reasons and in-store drop-off should cut average return handling time.'},
      actual:3.4,signal:'aligned'}
  ]);
  _demoSetNsmTracking(64,80,71.2);

  console.log('Demo data loaded \u2014 OrderHub product (capability-driven), '+Object.keys(capStore).length+' capability groups, '+scCanvas.length+' features on Story Canvas');
}

function clearDemoMode(){
  const badge=document.getElementById('demo-badge');
  if(!badge)return; // demo was never loaded — nothing to clear
  // Reset session state
  sessionContext=null;
  sessionActive=false;
  // Restore the user's real profile state if it was snapshotted before demo
  // load; otherwise fall back to empty defaults (demo was loaded with nothing
  // real configured beforehand).
  if(_preDemoState!==null){
    companyProfile=_preDemoState.companyProfile||{companyName:'',companyIndustry:'',companyUrl:'',companyStrategy:'',companyContext:'',companyRefLink:'',companyDocs:[]};
    productProfiles=_preDemoState.productProfiles||[];
    activeProfileId=_preDemoState.activeProfileId||null;
    _preDemoState=null;
  } else {
    companyProfile={companyName:'',companyIndustry:'',companyUrl:'',companyStrategy:'',companyContext:'',companyRefLink:'',companyDocs:[]};
    productProfiles=[];
    activeProfileId=null;
  }
  // Reset all canvas state including diagnostic sessions (fix: demo dv data persisted after new generation)
  gData=null;
  productContext=null;
  capStore={};
  capStoreInvalidated=false;
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;
  scCanvas=[];
  if(typeof protoStore!=='undefined') protoStore={};
  if(typeof newScProtoView!=='undefined') newScProtoView=false;
  scCapNavFilter=null;
  diagnosticSessions=[];
  activeDiagnosticId=null;
  productLeakAnalysis=null;
  diagEvidenceDrawerMetricId=null;

  // Reset UI
  badge.remove();
  const mmOut=document.getElementById('mm-out');
  if(mmOut){mmOut.innerHTML='';mmOut.classList.remove('on');}
  const ddOut=document.getElementById('dd-out');
  if(ddOut){ddOut.innerHTML='';ddOut.classList.remove('on');}
  const esEl=document.getElementById('es');
  if(esEl)esEl.style.display='';
  // Reset form fields
  ['f-name','f-url','f-desc','f-kpis','f-problem','f-icp','f-context'].forEach(id=>{
    const el=document.getElementById(id);if(el)el.value='';
  });
  // Reset new seg fields to defaults
  seg.industry='Technology & Software';
  seg.productType='B2C Product';
  const indElC=document.getElementById('f-industry');
  if(indElC)indElC.value='Technology & Software';
  const ptSegC=document.getElementById('seg-producttype');
  if(ptSegC)ptSegC.querySelectorAll('.seg-btn').forEach(b=>{b.classList.toggle('active',b.dataset.v==='B2C Product');});
  // Reset tab badge and re-render canvas to clear DOM
  fcUpdateTabBadge();
  fcRenderCanvas();
  fcRenderCapNav();
  // Clear header product name
  const pnEl=document.getElementById('hdr-product-name');
  if(pnEl){pnEl.textContent='';pnEl.classList.remove('has-name');}
  ddGenerated=false;
  // Reset PI planning state
  piMode=false;
  piPlans=[];
  piBacklogStoryIds=[];
  _piActivePlanId=null;
  piScVersion=null;
  piInputs={type:'caps-only',piGoal:'',constraints:'',parsedCaps:[],parsedFeatures:[],carryForwardItems:[],overlapResolutions:{}};
  // Hide PI tab
  const piTabElC=document.getElementById('tab-pi');
  if(piTabElC)piTabElC.classList.remove('revealed');
  // Hide Story Canvas tab (no features after clear)
  const scTabElC=document.getElementById('tab-fc');
  if(scTabElC)scTabElC.style.display='none';
  const newScTabElC=document.getElementById('tab-sc');
  if(newScTabElC)newScTabElC.classList.remove('revealed');
  // Hide la tab
  const laTabElC=document.getElementById('tab-la');
  if(laTabElC)laTabElC.style.display='none';
  const laTabC=document.getElementById('la-tab');
  if(laTabC)laTabC.innerHTML='';
  const diagBarC=document.getElementById('diag-action-bar');
  if(diagBarC)diagBarC.remove();
  console.log('Demo mode cleared — ready for real API usage');
  // Reset MI state
  miData=null;miGenerated=false;miProductMode='market';miCapabilities=[];
  const miTabEl2=document.getElementById('tab-mi');
  if(miTabEl2)miTabEl2.style.display='none';
  if(curTab==='mi')switchTab('mm');
  const miTabContent=document.getElementById('mi-tab');
  if(miTabContent){miTabContent.innerHTML='';miTabContent.classList.remove('on');}
  // Refresh product selector so restored (or cleared) profiles are reflected
  if(typeof _homeRenderProductSelector==='function')_homeRenderProductSelector();
}

// ── Exit demo mode via the header "DEMO ✕" badge ──
// Confirms with the user (destructive: clears the demo session), then clears
// demo mode (restoring pre-demo profiles via clearDemoMode) and returns to Home.
function exitDemoMode(){
  showConfirm(
    'This clears the demo session and returns you to your setup. This cannot be undone.',
    'Exit demo mode?',
    function(){
      clearDemoMode();
      switchTab('home');
    },
    'Yes, exit demo',
    'danger'
  );
}

// ── Unified Cart & Checkout demo — coming in a future release ──
// ── OneCart demo dataset — B2C multi-business unified checkout (Outcome-Based) ──
function _demoLoadUnifiedCart(){
  // ── 1. Populate company profile and product profiles ──

  companyProfile={
    companyName:'OneCart Group',
    companyIndustry:'Travel & Hospitality',
    companyUrl:'https://onecart.example',
    companyStrategy:'Unify booking and checkout across parks, hotels, dining, and merchandise into a single guest cart, increasing cross-business attach rate and lifetime value per visit.',
    companyContext:'B2C consumer platform spanning multiple business lines (theme parks, resorts, dining, merchandise, experiences). Historically each business line had its own booking flow and checkout — OneCart unifies them into a single guest-facing cart.',
    companyRefLink:'',
    companyDocs:[]
  };

  const oneCartProfile={
    id:'demo-onecart',
    productName:'OneCart',
    productDesc:'A B2C unified cart and checkout platform for a multi-business consumer group (theme parks, resorts, dining, merchandise, and experiences), letting guests discover, assemble, and pay for items across business lines in a single transaction.',
    industry:'Travel & Hospitality',
    productType:'B2C Product',
    kpis:'Cross-business attach rate, unified checkout completion rate, average order value per booking',
    problem:'Guests booking a park ticket rarely add hotel, dining, or merchandise in the same transaction because each business line has its own checkout, causing fragmented bookings and lost attach revenue',
    icp:'Leisure travellers and families planning a multi-day visit across parks, hotels, dining, and experiences',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  const orderHubProfile={
    id:'demo-orderhub',
    productName:'OrderHub',
    productDesc:'A B2B SaaS order orchestration platform for large-format omnichannel retailers, coordinating order capture, real-time inventory promises, warehouse and store fulfilment, last-mile delivery, and returns across web, app, and in-store channels.',
    industry:'Retail',
    productType:'B2B SaaS',
    kpis:'Order fill rate, on-time-in-full (OTIF), return processing time',
    problem:'Customers see inaccurate stock promises at checkout, causing failed promises and order cancellations downstream',
    icp:'Omnichannel operations and fulfilment teams at large-format home, furniture, and big-box retailers',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  const focuslyProfile={
    id:'demo-focusly',
    productName:'Focusly',
    productDesc:'A B2C consumer productivity app that helps knowledge workers build deep focus habits through session tracking, distraction blocking, and habit loop reinforcement.',
    industry:'Technology & Software',
    productType:'B2C Product',
    kpis:'DAU, session length, 7-day retention',
    problem:'High drop-off after first week - users complete onboarding but never form a habit',
    icp:'Knowledge workers and students, 22-40, remote-first',
    additionalContext:'',
    refLink:'https://focusly.app',
    docs:[]
  };

  const mindBridgeProfile={
    id:'demo-mindbridge',
    productName:'MindBridge',
    productDesc:'A B2C mental wellness app offering guided CBT exercises, mood tracking, and therapist-matching for adults managing anxiety and stress.',
    industry:'Health & Life Sciences',
    productType:'B2C Product',
    kpis:'Daily active users, session completion rate, 30-day retention',
    problem:'Users complete intake assessment but disengage before completing first therapy module',
    icp:'Adults 25-45 experiencing work-related stress or mild anxiety, not in clinical care',
    additionalContext:'',
    refLink:'',
    docs:[]
  };

  productProfiles=[oneCartProfile, orderHubProfile, focuslyProfile, mindBridgeProfile];
  activeProfileId='demo-onecart';

  // ── 2. Inject gData (Discovery Map — Outcome-Based, full L1-L4) ──
  gData={
    approach:'outcome-based',
    nsm:{
      metric:'Cross-Business Attach Rate per Booking',
      definition:'Percentage of bookings that include items from two or more business lines (parks, hotels, dining, merchandise, experiences) in a single checkout'
    },
    measurementModel:{
      modelName:'Unified Booking & Checkout Model',
      frameworks:['APQC PCF','First principles'],
      rationale:'OneCart spans discovery, cart assembly, checkout, and post-purchase servicing across multiple business lines — a booking-funnel value chain captures the unification story better than a generic AAER consumer funnel.'
    },
    stages:[
      {id:'discovery',label:'Discovery',l1_metrics:[
        {name:'Cross-Business Recommendation Rate',why:'Measures how often guests are shown relevant items from other business lines during discovery',
          l2_metrics:[
            {name:'Itinerary-Based Suggestion Rate',why:'% of sessions where suggestions are based on the guest\'s emerging itinerary rather than generic upsells',
              l3_metrics:[{name:'Park Ticket to Dining Suggestion Rate',why:'When a guest selects a park date, dining suggestions for that date drive same-session attach',l4_metrics:[]},{name:'Hotel to Experience Suggestion Rate',why:'Hotel selection surfaces nearby experiences for the stay dates',l4_metrics:[]}]},
            {name:'Bundle Discovery Rate',why:'% of guests who view a pre-built multi-business bundle (e.g. park + hotel + dining)',
              l3_metrics:[{name:'Bundle Click-Through Rate',why:'Low click-through signals bundles are not visible or relevant enough',l4_metrics:[]},{name:'Bundle Detail View Completion Rate',why:'Guests who view full bundle details are closer to cross-business intent',l4_metrics:[]}]}
          ]},
        {name:'Search-to-Browse Conversion Rate',why:'% of searches that lead to browsing at least one bookable item — measures search relevance',
          l2_metrics:[
            {name:'Date-Based Search Accuracy',why:'Search results that respect the guest\'s selected dates across all business lines',
              l3_metrics:[{name:'Availability-Filtered Result Rate',why:'Results filtered to only show items available on selected dates reduce dead-end browsing',l4_metrics:[]},{name:'Cross-Business Date Conflict Detection Rate',why:'Detects when a hotel stay and park date do not overlap, prompting correction early',l4_metrics:[]}]},
            {name:'Personalised Result Ranking Rate',why:'% of search sessions where results are ranked using guest profile and past visit data',
              l3_metrics:[{name:'Repeat Guest Personalisation Rate',why:'Returning guests see results ranked by their prior business-line preferences',l4_metrics:[]},{name:'New Guest Cold-Start Ranking Quality',why:'First-time guests still need relevant ranking without historical data',l4_metrics:[]}]}
          ]},
        {name:'Account Sign-In Rate at Discovery',why:'Signed-in guests get personalised cross-business suggestions and saved itineraries',
          l2_metrics:[
            {name:'Guest Checkout Conversion to Account Rate',why:'% of guest-checkout sessions that create an account during or after discovery',
              l3_metrics:[{name:'Post-Booking Account Prompt Acceptance Rate',why:'Prompting account creation after a successful booking has higher acceptance than pre-booking',l4_metrics:[]},{name:'Social Sign-In Adoption Rate',why:'Faster sign-in reduces friction at the discovery-to-cart transition',l4_metrics:[]}]},
            {name:'Saved Itinerary Usage Rate',why:'% of signed-in guests who return to a previously saved itinerary',
              l3_metrics:[{name:'Itinerary Save Rate',why:'Guests who save an itinerary are more likely to complete a cross-business booking later',l4_metrics:[]},{name:'Itinerary Resume Rate',why:'Resuming a saved itinerary skips re-discovery, increasing completion likelihood',l4_metrics:[]}]}
          ]}
      ]},
      {id:'cart_assembly',label:'Cart Assembly',l1_metrics:[
        {name:'Multi-Business Cart Rate',why:'% of carts that contain items from 2+ business lines before checkout begins — the core unification metric',
          l2_metrics:[
            {name:'Cross-Sell Add-to-Cart Rate',why:'% of cart sessions where a cross-business suggestion is added without leaving the cart',
              l3_metrics:[{name:'In-Cart Dining Add Rate',why:'Dining add-ons shown directly in the park ticket cart, no separate flow needed',l4_metrics:['Quick-add from cart sidebar','Add via itinerary date match']},{name:'In-Cart Experience Add Rate',why:'Experience add-ons (e.g. a show or tour) shown alongside hotel stays in cart',l4_metrics:[]}]},
            {name:'Cart Abandonment Rate by Business Line Count',why:'Abandonment rate compared between single-business and multi-business carts',
              l3_metrics:[{name:'Multi-Business Cart Abandonment Rate',why:'If multi-business carts abandon more, the unification adds friction rather than value',l4_metrics:[]},{name:'Single-Business Cart Abandonment Rate',why:'Baseline comparison for whether unification improves or hurts conversion',l4_metrics:[]}]}
          ]},
        {name:'Date & Itinerary Consistency Rate',why:'% of multi-business carts where all items share consistent dates across business lines',
          l2_metrics:[
            {name:'Date Conflict Resolution Rate',why:'% of detected date conflicts (e.g. hotel checkout before park ticket date) that guests resolve without abandoning',
              l3_metrics:[{name:'Auto-Suggested Date Fix Acceptance Rate',why:'When OneCart suggests adjusting one item\'s date to match others, guests accept it most of the time',l4_metrics:[]},{name:'Manual Date Correction Rate',why:'Guests who manually fix date conflicts rather than accepting suggestions — signals suggestion quality gap',l4_metrics:[]}]},
            {name:'Itinerary View Engagement Rate',why:'% of cart sessions where the guest opens the itinerary/calendar view of their cart',
              l3_metrics:[{name:'Itinerary View to Edit Rate',why:'Guests who view the itinerary and then edit an item are actively curating a multi-day plan',l4_metrics:[]},{name:'Itinerary View Duration',why:'Longer engagement with the itinerary view correlates with higher cart value',l4_metrics:[]}]}
          ]},
        {name:'Cart Save & Resume Rate',why:'% of carts that are saved and later resumed rather than abandoned outright',
          l2_metrics:[
            {name:'Cart Reminder Effectiveness Rate',why:'% of saved-cart reminder notifications that lead to a resumed session within 48 hours',
              l3_metrics:[{name:'Email Reminder Open-to-Resume Rate',why:'Email reminders driving resumption indicate cart save is a genuine intent signal, not abandonment',l4_metrics:[]},{name:'Push Reminder Open-to-Resume Rate',why:'Push notification effectiveness for cart resumption on mobile',l4_metrics:[]}]},
            {name:'Price/Availability Change Impact on Resume Rate',why:'% of resumed carts where a price or availability change since save caused re-abandonment',
              l3_metrics:[{name:'Price Increase Re-Abandonment Rate',why:'Guests who see a higher price on resume are more likely to abandon again',l4_metrics:[]},{name:'Availability Loss Re-Abandonment Rate',why:'Guests who find an item sold out on resume need an immediate alternative or they abandon',l4_metrics:[]}]}
          ]}
      ]},
      {id:'unified_checkout',label:'Unified Checkout',l1_metrics:[
        {name:'Unified Checkout Completion Rate',why:'% of multi-business carts that complete checkout in a single payment flow without splitting',
          l2_metrics:[
            {name:'Single Payment Method Usage Rate',why:'% of unified checkouts paid with a single payment method across all business lines',
              l3_metrics:[{name:'Saved Payment Method Reuse Rate',why:'Returning guests reusing a saved payment method reduces checkout time significantly',l4_metrics:[]},{name:'Split Payment Request Rate',why:'Guests who attempt to split payment across cards may indicate budget allocation needs by business line',l4_metrics:[]}]},
            {name:'Checkout Step Completion Rate',why:'% of guests completing each step of the unified checkout flow without drop-off',
              l3_metrics:[{name:'Address & Contact Step Completion Rate',why:'First checkout step drop-off often signals account or form friction',l4_metrics:[]},{name:'Review & Confirm Step Completion Rate',why:'Final review step is where guests most often notice price changes and abandon',l4_metrics:[]}]}
          ]},
        {name:'Loyalty Point Redemption Rate at Checkout',why:'% of unified checkouts where guests redeem loyalty points across any business line',
          l2_metrics:[
            {name:'Cross-Business Point Redemption Rate',why:'% of point redemptions applied to a business line different from where points were earned',
              l3_metrics:[{name:'Park-Earned Points Redeemed on Dining Rate',why:'Cross-business point usage is the clearest signal that unification adds perceived value',l4_metrics:[]},{name:'Points Balance Visibility Impact Rate',why:'Showing the combined points balance at checkout increases redemption likelihood',l4_metrics:[]}]},
            {name:'Points Expiry Nudge Effectiveness Rate',why:'% of expiry nudges that lead to a redemption before points lapse',
              l3_metrics:[{name:'Expiry Nudge Open Rate',why:'Guests who open expiry nudges are primed for a redemption-driven booking',l4_metrics:[]},{name:'Expiry Nudge Conversion Rate',why:'Actual bookings driven by expiry nudges measure incremental revenue from the nudge',l4_metrics:[]}]}
          ]},
        {name:'Checkout Error & Retry Rate',why:'% of unified checkouts that encounter a payment or validation error requiring retry',
          l2_metrics:[
            {name:'Cross-Business Inventory Hold Failure Rate',why:'% of checkouts that fail because one business line\'s item lost availability during checkout',
              l3_metrics:[{name:'Hold Expiry During Checkout Rate',why:'Items held in cart expiring mid-checkout cause failed unified transactions',l4_metrics:[]},{name:'Partial Checkout Recovery Rate',why:'% of failed unified checkouts where the guest completes a partial booking instead of abandoning entirely',l4_metrics:[]}]},
            {name:'Payment Decline Recovery Rate',why:'% of payment declines where the guest successfully retries with an alternative method',
              l3_metrics:[{name:'Alternative Payment Prompt Acceptance Rate',why:'Prompting an alternative payment method immediately after decline recovers bookings that would otherwise abandon',l4_metrics:[]},{name:'Decline Reason Clarity Impact Rate',why:'Clear decline reasons (vs generic errors) correlate with higher retry success',l4_metrics:[]}]}
          ]}
      ]},
      {id:'post_purchase',label:'Post-Purchase Servicing',l1_metrics:[
        {name:'Unified Itinerary View Engagement Rate',why:'% of guests who view their full cross-business itinerary after booking, rather than separate confirmations',
          l2_metrics:[
            {name:'Post-Booking Itinerary Edit Rate',why:'% of guests who modify one business line of their booking (e.g. change dining time) from the unified itinerary view',
              l3_metrics:[{name:'In-Itinerary Reschedule Rate',why:'Rescheduling within the unified view (vs contacting each business line separately) is the core post-purchase value prop',l4_metrics:[]},{name:'In-Itinerary Add-On Rate',why:'Guests adding new items to an existing booking from the itinerary view extends attach beyond initial checkout',l4_metrics:[]}]},
            {name:'Day-Of Itinerary Usage Rate',why:'% of guests who open the unified itinerary on the day of their visit, used as a day-of guide',
              l3_metrics:[{name:'Day-Of Notification Open Rate',why:'Day-of reminders driving itinerary opens indicate the unified view is a trusted day-of tool',l4_metrics:[]},{name:'In-Itinerary Wait Time Check Rate',why:'Guests checking live wait times from the itinerary view shows ongoing engagement during the visit',l4_metrics:[]}]}
          ]},
        {name:'Cross-Business Refund & Change Rate',why:'% of post-purchase changes (cancellations, date changes) that span multiple business lines in one request',
          l2_metrics:[
            {name:'Unified Change Request Completion Rate',why:'% of cross-business change requests completed without needing to contact each business line separately',
              l3_metrics:[{name:'Single-Request Multi-Line Change Rate',why:'A single change request updating hotel, park, and dining dates together is the core post-purchase unification value',l4_metrics:[]},{name:'Change Request Escalation Rate',why:'% of unified change requests that still require escalation to a business-line-specific team',l4_metrics:[]}]},
            {name:'Refund Processing Time Across Business Lines',why:'Time to process a refund that touches multiple business lines, compared to single-line refunds',
              l3_metrics:[{name:'Cross-Business Refund SLA Adherence Rate',why:'Refunds spanning business lines often take longer — SLA adherence signals operational maturity',l4_metrics:[]},{name:'Refund Status Visibility Rate',why:'% of guests who can see real-time status of a multi-line refund without contacting support',l4_metrics:[]}]}
          ]},
        {name:'Repeat Cross-Business Booking Rate',why:'% of guests whose next booking within 12 months also includes 2+ business lines — measures durability of the unification habit',
          l2_metrics:[
            {name:'Post-Visit Rebooking Prompt Conversion Rate',why:'% of post-visit prompts (e.g. "plan your next trip") that convert to a new multi-business booking',
              l3_metrics:[{name:'Loyalty Tier Upsell Acceptance Rate',why:'Guests offered a loyalty tier upgrade post-visit are more likely to book multi-business again',l4_metrics:[]},{name:'Personalised Next-Trip Suggestion Rate',why:'Suggestions based on the prior trip\'s business-line mix drive repeat cross-business behaviour',l4_metrics:[]}]},
            {name:'Annual Pass Cross-Business Usage Rate',why:'% of annual pass holders who also book hotel, dining, or experiences in the same period',
              l3_metrics:[{name:'Pass Holder Bundle Offer Acceptance Rate',why:'Pass holders offered bundled hotel/dining deals convert at higher rates than general guests',l4_metrics:[]},{name:'Pass Holder Repeat Visit Attach Rate',why:'Each repeat visit by a pass holder is an opportunity for incremental cross-business attach',l4_metrics:[]}]}
          ]}
      ]}
    ]
  };

  // ── 3. Inject capStore (full depth: Cart Assembly and Unified Checkout) ──
  capStore={};
  capStoreInvalidated=false;

  const addCap=(stageId,metricName,stageLabel,capabilities)=>{
    const key=stageId+'||'+metricName;
    capStore[key]={metricName,stageLabel,stageId,capabilities};
  };

  // ── Cart Assembly: full capability → feature depth ──
  addCap('cart_assembly','Multi-Business Cart Rate','Cart Assembly',[
    {name:'Cross-Business Suggestion Engine',why:'Surfaces relevant items from other business lines directly inside the cart based on the guest\'s current selections and dates',
      subCaps:[{name:'Itinerary-aware suggestion ranking',why:'Ranks suggestions by date and location fit with items already in cart'},{name:'Quick-add without leaving cart',why:'Lets guests add a suggested item without navigating away from the cart view'}],
      featStore:{top:[
        {name:'In-cart dining suggestion carousel',why:'When a park ticket is added to cart, shows a carousel of dining reservations available on the same date at parks the guest is visiting',selected:true,metric:'Multi-Business Cart Rate',stage:'Cart Assembly',cap:'Cross-Business Suggestion Engine',subCap:null},
        {name:'One-tap add for cross-business items',why:'Suggested items can be added to cart with a single tap, with date and party size pre-filled from the existing cart',selected:false,metric:'Multi-Business Cart Rate',stage:'Cart Assembly',cap:'Cross-Business Suggestion Engine',subCap:null},
        {name:'Suggestion dismissal memory',why:'If a guest dismisses a suggestion category twice, similar suggestions are deprioritised for the rest of the session',selected:false,metric:'Multi-Business Cart Rate',stage:'Cart Assembly',cap:'Cross-Business Suggestion Engine',subCap:null}
      ]}},
    {name:'Multi-Business Bundle Builder',why:'Lets guests assemble a custom bundle across business lines and see a combined price before committing',
      subCaps:null,
      featStore:{top:[
        {name:'Custom bundle price preview',why:'Shows the combined price and any bundle discount as items from different business lines are added, updating live',selected:false,metric:'Multi-Business Cart Rate',stage:'Cart Assembly',cap:'Multi-Business Bundle Builder',subCap:null},
        {name:'Pre-built bundle templates for common itineraries',why:'Offers starting-point bundles (e.g. "2-day park + 1 night hotel") that guests can customise rather than building from scratch',selected:false,metric:'Multi-Business Cart Rate',stage:'Cart Assembly',cap:'Multi-Business Bundle Builder',subCap:null}
      ]}},
    {name:'Cart Sidebar Cross-Business View',why:'Persistent sidebar shows cart contents grouped by business line with running total',
      subCaps:null,featStore:{}}
  ]);

  addCap('cart_assembly','Date & Itinerary Consistency Rate','Cart Assembly',[
    {name:'Cross-Business Date Conflict Detection',why:'Detects when items in the cart have inconsistent dates across business lines and prompts resolution',
      subCaps:null,
      featStore:{top:[
        {name:'Date conflict banner with suggested fix',why:'When a hotel checkout date is before a park ticket date in the same cart, shows a banner with a one-tap suggested date adjustment',selected:false,metric:'Date & Itinerary Consistency Rate',stage:'Cart Assembly',cap:'Cross-Business Date Conflict Detection',subCap:null}
      ]}},
    {name:'Itinerary Calendar View',why:'Visual calendar showing all cart items by date and business line, editable inline',
      subCaps:null,featStore:{}}
  ]);

  addCap('cart_assembly','Cart Save & Resume Rate','Cart Assembly',[
    {name:'Cart Save & Reminder System',why:'Saves abandoned carts and sends timed reminders with price/availability change awareness',
      subCaps:null,featStore:{}}
  ]);

  // ── Unified Checkout: full capability → feature depth ──
  addCap('unified_checkout','Unified Checkout Completion Rate','Unified Checkout',[
    {name:'Single Payment Across Business Lines',why:'Processes one payment that is allocated across multiple business-line ledgers behind the scenes, so the guest sees a single charge',
      subCaps:[{name:'Multi-ledger payment allocation',why:'Splits a single charge into per-business-line ledger entries for finance reconciliation without guest-facing complexity'},{name:'Saved payment method vault',why:'Securely stores guest payment methods for one-tap reuse across future unified checkouts'}],
      featStore:{top:[
        {name:'Single-charge checkout summary',why:'Shows guests one total and one charge to their card, while internally allocating the amount to each business line\'s ledger',selected:true,metric:'Unified Checkout Completion Rate',stage:'Unified Checkout',cap:'Single Payment Across Business Lines',subCap:null},
        {name:'Saved payment method one-tap checkout',why:'Returning guests with a saved payment method can complete a unified checkout in one tap from the review step',selected:false,metric:'Unified Checkout Completion Rate',stage:'Unified Checkout',cap:'Single Payment Across Business Lines',subCap:null},
        {name:'Checkout step progress indicator',why:'Shows guests a 3-step progress indicator (details, review, confirm) so they know how close they are to completion',selected:false,metric:'Unified Checkout Completion Rate',stage:'Unified Checkout',cap:'Single Payment Across Business Lines',subCap:null}
      ]}},
    {name:'Cross-Business Inventory Hold Manager',why:'Holds inventory across all business lines for the duration of checkout, releasing automatically if checkout is not completed',
      subCaps:null,
      featStore:{top:[
        {name:'Unified inventory hold timer',why:'Displays a single countdown timer for all held items across business lines, extending automatically if the guest is actively completing checkout',selected:false,metric:'Unified Checkout Completion Rate',stage:'Unified Checkout',cap:'Cross-Business Inventory Hold Manager',subCap:null},
        {name:'Hold expiry recovery flow',why:'If a hold expires mid-checkout, attempts to re-hold the same item before showing the guest an alternative',selected:false,metric:'Unified Checkout Completion Rate',stage:'Unified Checkout',cap:'Cross-Business Inventory Hold Manager',subCap:null}
      ]}},
    {name:'Checkout Error Recovery Flow',why:'Guides guests through payment declines and inventory failures without losing their cart contents',
      subCaps:null,featStore:{}}
  ]);

  addCap('unified_checkout','Loyalty Point Redemption Rate at Checkout','Unified Checkout',[
    {name:'Cross-Business Loyalty Wallet',why:'Shows a single combined loyalty points balance that can be redeemed against any business line at checkout',
      subCaps:null,
      featStore:{top:[
        {name:'Combined points balance display at checkout',why:'Shows the guest their total points balance across all business lines, with a slider to apply points to the current order',selected:false,metric:'Loyalty Point Redemption Rate at Checkout',stage:'Unified Checkout',cap:'Cross-Business Loyalty Wallet',subCap:null}
      ]}},
    {name:'Points Expiry Nudges',why:'Notifies guests when points are nearing expiry and suggests a redemption opportunity',
      subCaps:null,featStore:{}}
  ]);

  addCap('unified_checkout','Checkout Error & Retry Rate','Unified Checkout',[
    {name:'Payment Decline Recovery',why:'Immediately offers an alternative payment method on decline without restarting checkout',
      subCaps:null,featStore:{}}
  ]);

  // ── PI-first capability — Accessibility (for traceability demo) ──
  capStore['pi||accessibility']={
    metricName:'Accessibility Compliance',
    stageLabel:'PI Plan',
    stageId:'pi',
    capabilities:[{
      name:'Accessibility Compliance',
      why:'WCAG 2.2 AA compliance required for unified checkout before Q3 regulatory deadline',
      subCaps:null,
      featStore:{top:[
        {name:'Screen Reader Support for Unified Checkout Steps',why:'All three checkout steps (details, review, confirm) must be fully navigable via screen reader, including the cross-business cart summary',
         selected:false,metric:'',stage:'PI Plan',cap:'Accessibility Compliance',subCap:null}
      ]}
    }]
  };

  // ── 4. Pre-populate Story Canvas with 2 features ──
  scCanvas=[];
  Object.values(capStore).forEach(entry=>{
    entry.capabilities.forEach(cap=>{
      if(cap.featStore){
        Object.entries(cap.featStore).forEach(([fkey,feats])=>{
          (feats||[]).forEach(f=>{
            if(f.selected){
              const fid=scMakeFeatureId(f.metric,f.cap+(f.subCap?'/'+f.subCap:''),f.name);
              if(!scCanvas.find(x=>x.id===fid)){
                scCanvas.push({id:fid,metric:f.metric,metricPath:scGetMetricPath(f.metric)||f.metric,stage:f.stage,
                  cap:f.cap+(f.subCap?' › '+f.subCap:''),name:f.name,why:f.why,stories:null,origin:'kpi'});
              }
            }
          });
        });
      }
    });
  });

  // ── 4a. Add one Path D (PI-first, unlinked) demo feature for traceability demo ──
  scCanvas.push({
    id:scMakeFeatureId('','Accessibility Compliance','Screen Reader Support for Unified Checkout Steps'),
    metric:'',
    metricPath:'',
    stage:'PI Plan',
    cap:'Accessibility Compliance',
    name:'Screen Reader Support for Unified Checkout Steps',
    why:'WCAG 2.2 AA compliance required for unified checkout before Q3 regulatory deadline',
    stories:null,
    origin:'pi'
  });

  // ── 4b. Add pre-built stories to 2 demo features + PI-first feature ──
  scStoryIdCounter=0;
  scCanvas.forEach(function(feat){
    if(feat.name==='In-cart dining suggestion carousel'){
      feat.stories=[
        {id:'ST-001',title:'Guest sees dining suggestions in cart after adding a park ticket so that they can plan meals without leaving checkout',statement:'As a OneCart guest, I want to see dining reservation suggestions in my cart after adding a park ticket, so that I can book a meal for the same day without starting a separate search.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Park ticket added with available dining nearby',given:'Guest adds a park ticket for a specific date to their cart',when:'The cart updates',then:'A carousel of dining reservations available at that park on that date appears below the cart summary',and:'Each suggestion shows time slots and party size pre-filled from the cart'},{name:'No dining availability for the date',given:'Guest adds a park ticket for a date with no dining availability',when:'The cart updates',then:'The carousel shows a message suggesting nearby dates with availability instead',and:''}]},
        {id:'ST-002',title:'Guest can dismiss dining suggestions so that the cart stays focused on their current intent',statement:'As a OneCart guest, I want to dismiss the dining suggestion carousel, so that my cart view stays focused if I am not interested in adding dining.',points:2,priority:'Should Have',dor:'READY',dorReason:'',scenarios:[{name:'Guest dismisses carousel once',given:'The dining suggestion carousel is shown in the cart',when:'Guest taps dismiss',then:'The carousel collapses for the remainder of the session',and:'It may reappear in a future session'},{name:'Guest dismisses carousel twice across sessions',given:'Guest has dismissed dining suggestions in two separate sessions',when:'Guest adds another park ticket to a new cart',then:'Dining suggestions are not shown for this and future sessions until re-enabled in settings',and:''}]},
        {id:'ST-003',title:'Guest can add a suggested dining reservation with pre-filled details so that booking takes one tap',statement:'As a OneCart guest, I want to add a suggested dining reservation to my cart with date, time, and party size pre-filled, so that I do not need to re-enter information I already provided.',points:3,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Guest adds suggestion with matching party size',given:'Guest\'s cart already specifies a party of 4 for the park ticket',when:'Guest taps a dining suggestion',then:'The dining reservation is added to the cart with party size 4 and the same date pre-filled',and:'The guest can adjust time slot before finalising'}]}
      ];
      scStoryIdCounter=3;
    }
    if(feat.name==='Single-charge checkout summary'){
      feat.stories=[
        {id:'ST-004',title:'Guest sees one total and one charge for a multi-business cart so that checkout feels simple',statement:'As a OneCart guest with items from multiple business lines in my cart, I want to see one combined total and make one payment, so that checkout feels like a single transaction rather than several.',points:5,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Cart contains park ticket, hotel, and dining',given:'Guest\'s cart contains a park ticket, a hotel stay, and a dining reservation',when:'Guest proceeds to checkout',then:'The checkout summary shows one combined total and a single payment field',and:'Internally, the amount is allocated to each business line\'s ledger for finance reconciliation'},{name:'Cart contains items from a single business line',given:'Guest\'s cart contains only a park ticket',when:'Guest proceeds to checkout',then:'The checkout summary still shows the unified single-payment flow, with no visible difference from a multi-business cart',and:''}]},
        {id:'ST-005',title:'Guest can expand the checkout summary to see a per-business-line breakdown so that they understand what they are paying for',statement:'As a OneCart guest, I want to expand my checkout summary to see how the total breaks down by business line, so that I understand what I am paying for even though I make one payment.',points:2,priority:'Should Have',dor:'READY',dorReason:'',scenarios:[{name:'Guest expands breakdown',given:'Guest is on the unified checkout review step with a multi-business cart',when:'Guest taps "show breakdown"',then:'A line-item breakdown appears showing the amount attributable to each business line',and:'The combined total remains visible and unchanged'}]},
        {id:'ST-006',title:'Guest receives one confirmation covering all business lines so that they do not get multiple separate emails',statement:'As a OneCart guest, I want to receive one booking confirmation that covers all business lines in my order, so that I have a single record of my purchase.',points:3,priority:'Must Have',dor:'IN REVIEW',dorReason:'Depends on unified notification template (Platform workstream)',scenarios:[{name:'Multi-business order confirmed',given:'Guest completes a unified checkout with park, hotel, and dining items',when:'The order is confirmed',then:'Guest receives a single confirmation email listing all three items with their respective dates and reference numbers',and:'Each business line also receives its respective booking record in their own systems'}]}
      ];
      scStoryIdCounter=6;
    }
    if(feat.name==='Screen Reader Support for Unified Checkout Steps'){
      feat.stories=[
        {id:'ST-007',title:'Screen reader users can complete all three checkout steps so that unified checkout is accessible',statement:'As a OneCart guest using a screen reader, I want to navigate all three unified checkout steps (details, review, confirm) with my screen reader, so that I can complete a booking independently.',points:5,priority:'Must Have',dor:'READY',dorReason:'',scenarios:[{name:'Guest navigates the review step with a screen reader',given:'Guest is on the unified checkout review step using a screen reader',when:'Guest navigates through the cross-business cart summary',then:'Each business-line item, its date, and its price are announced in a logical order',and:'The combined total is announced clearly as a distinct summary element'},{name:'Guest encounters a checkout error with a screen reader',given:'Guest is using a screen reader and a payment decline occurs',when:'The error message appears',then:'The screen reader announces the error and the recommended next action immediately',and:''}]},
        {id:'ST-008',title:'Focus order across checkout steps follows a logical sequence so that keyboard and screen reader users are not disoriented',statement:'As a OneCart guest using keyboard navigation, I want the focus order across all checkout steps to follow a logical visual sequence, so that I am not disoriented when moving between fields.',points:3,priority:'Must Have',dor:'READY',dorReason:''}
      ];
      scStoryIdCounter=8;
    }
  });

  // ── Market Intelligence demo data ──
  miGenerated=true;
  miProductMode='market';
  miData={
    productMode:'market',
    marketSnapshot:[
      {value:'$1.4T',label:'Global travel & leisure booking market 2025',source:'Phocuswright',year:'2025',trend:'↑ 9.4% CAGR'},
      {value:'9.4%',label:'CAGR to 2030',source:'Phocuswright',year:'2025',trend:''},
      {value:'34%',label:'Guests who book 2+ business lines when unified checkout is offered',source:'Skift Research',year:'2025',trend:'↑'},
      {value:'#1',label:'Top buyer criterion',source:'Market analysis',year:'2025',trend:'Single checkout across business lines'}
    ],
    buyerCriteria:[
      {rank:1,criterion:'Single checkout across business lines',evidence:'71% of multi-business travel guests say a separate checkout per business line is the top reason they do not add extra items to a booking',source:'Skift Research',year:'2025',productRelevance:'Core differentiator — Unified Checkout Completion Rate is OneCart\'s flagship metric'},
      {rank:2,criterion:'Cross-business loyalty point redemption',evidence:'Guests who can redeem points across business lines show 28% higher annual spend than single-program loyalty members',source:'Loyalty360 Benchmark',year:'2025',productRelevance:'OneCart has a Cross-Business Loyalty Wallet capability addressing this directly'},
      {rank:3,criterion:'Unified itinerary management post-booking',evidence:'62% of multi-business travellers say managing separate confirmations and changes across providers is their biggest post-booking frustration',source:'Phocuswright Traveller Survey',year:'2025',productRelevance:'Post-Purchase Servicing stage addresses this — capabilities not yet generated for this stage'}
    ],
    trends:[
      {name:'AI itinerary co-pilots',confidence:'CONFIRMED HIGH',signal:'ACTIVE',evidence:'Major travel platforms (Expedia, Booking.com) launched AI trip-planning assistants in 2024-25 that suggest cross-category bundles conversationally',source:'Skift, 2025',implication:'Guests increasingly expect conversational, itinerary-aware suggestions rather than static cross-sell banners',productGap:'OneCart\'s Cross-Business Suggestion Engine is rule-based, not conversational',roadmapAction:'Monitor — conversational AI is differentiating at the leaders but not yet table stakes for multi-business operators'},
      {name:'Unified loyalty wallets',confidence:'CONFIRMED HIGH',signal:'ACTIVE',evidence:'Marriott Bonvoy and Disney Genie+ both expanded points interoperability across business lines in 2024, reporting double-digit redemption increases',source:'Loyalty360, 2025',implication:'Cross-business point redemption is becoming a baseline loyalty expectation for multi-business operators',productGap:'OneCart\'s Cross-Business Loyalty Wallet exists but points expiry nudges are not yet generated',roadmapAction:'Accelerate — complete Points Expiry Nudges to capture redemption uplift'},
      {name:'Self-service post-booking changes',confidence:'CONFIRMED MEDIUM',signal:'ACTIVE',evidence:'62% of multi-business travellers cite separate-provider change management as their top frustration',source:'Phocuswright Traveller Survey, 2025',implication:'Self-service unified change requests are a clear opportunity, not yet addressed',productGap:'Post-Purchase Servicing stage has no capabilities generated yet',roadmapAction:'Accelerate — prioritise Unified Change Request Completion Rate capability generation'},
      {name:'Dynamic bundle pricing',confidence:'CONFIRMED MEDIUM',signal:'PEAKING',evidence:'Dynamic, demand-based bundle discounts are now offered by most major multi-business operators — adoption growth has slowed',source:'Phocuswright, 2025',implication:'Bundle pricing is becoming table stakes rather than a differentiator',productGap:'Multi-Business Bundle Builder shows static bundle templates, not dynamic pricing',roadmapAction:'Protect — maintain bundle builder reliability, dynamic pricing is lower priority than checkout unification'}
    ],
    competitors:[
      {name:'Disney Genie+',capabilities:[{domain:'Unified checkout',status:'present'},{domain:'Cross-business loyalty',status:'present'},{domain:'AI itinerary co-pilot',status:'partial'},{domain:'Self-service post-booking changes',status:'present'}]},
      {name:'Universal Orlando App',capabilities:[{domain:'Unified checkout',status:'partial'},{domain:'Cross-business loyalty',status:'partial'},{domain:'AI itinerary co-pilot',status:'gap'},{domain:'Self-service post-booking changes',status:'partial'}]},
      {name:'Marriott Bonvoy',capabilities:[{domain:'Unified checkout',status:'present'},{domain:'Cross-business loyalty',status:'present'},{domain:'AI itinerary co-pilot',status:'present'},{domain:'Self-service post-booking changes',status:'present'}]}
    ],
    competitorDeepDives:[
      {name:'Disney Genie+',narrative:'Genie+ pioneered the unified-cart model across parks, dining, and merchandise for a single resort operator, with strong cross-business loyalty integration. Its AI itinerary co-pilot is partial — mostly rule-based suggestions rather than conversational planning.',leadAreas:'Unified checkout maturity, cross-business loyalty depth',productAdvantage:'OneCart\'s multi-business bundle builder and date-conflict detection are comparable to Genie+\'s itinerary tools',threat:'Genie+\'s self-service post-booking change flow is more mature than OneCart\'s current (ungenerated) Post-Purchase Servicing capabilities'},
      {name:'Marriott Bonvoy',narrative:'Bonvoy has the most mature cross-business loyalty wallet in the industry, with points usable across hotels, dining, and experiences, plus an AI trip-planning assistant. Its checkout unification is strong but spans fewer business-line categories than a theme-park-style operator.',leadAreas:'Loyalty wallet maturity, AI itinerary co-pilot',productAdvantage:'OneCart spans more business-line categories (parks, hotels, dining, merchandise, experiences) than Bonvoy\'s hotel-centric model',threat:'Bonvoy\'s AI co-pilot sets a market expectation for conversational itinerary assistance that OneCart\'s rule-based suggestion engine does not yet meet'}
    ],
    swot:{
      strengths:[
        {text:'Multi-Business Bundle Builder shows live combined pricing as guests assemble a cross-business cart',source:'Internal product review 2025'},
        {text:'Cross-Business Date Conflict Detection catches itinerary mismatches before checkout',source:'User testing benchmark'}
      ],
      weaknesses:[
        {text:'No capabilities generated yet for Post-Purchase Servicing — 62% of travellers cite this as their top frustration',source:'Phocuswright Traveller Survey 2025',researchIdentified:true},
        {text:'Cross-Business Suggestion Engine is rule-based, not conversational',source:'Internal product review',researchIdentified:false}
      ],
      opportunities:[
        {text:'Self-service unified change requests — 62% of travellers want this and no major operator has fully solved it',source:'Phocuswright Traveller Survey 2025'},
        {text:'Cross-business point redemption — 28% higher annual spend among guests who can redeem across business lines',source:'Loyalty360 Benchmark 2025'}
      ],
      threats:[
        {text:'Disney Genie+ and Marriott Bonvoy both have more mature self-service post-booking change flows',source:'Industry analysis 2025'},
        {text:'AI itinerary co-pilots are becoming a market expectation, raising the baseline for suggestion quality',source:'Skift 2025'}
      ],
      synthesis:'OneCart\'s cart-assembly and unified-checkout capabilities are competitive with category leaders. The structural gap is Post-Purchase Servicing — the stage travellers cite as their biggest frustration has no generated capabilities yet, while Genie+ and Bonvoy both have mature self-service change flows.'
    },
    capabilities:[
      {name:'Multi-Business Bundle Builder',marketEvidence:'34% of guests book 2+ business lines when unified checkout and bundling are offered (Skift Research 2025)',kpiTreeMatch:'aligned',kpiTreeMetric:'Multi-Business Cart Rate',kpiTreeStage:'Cart Assembly',kpiTreePath:'Multi-Business Cart Rate'},
      {name:'Single Payment Across Business Lines',marketEvidence:'71% cite separate checkouts as the top reason they do not add extra items to a booking (Skift Research 2025)',kpiTreeMatch:'aligned',kpiTreeMetric:'Unified Checkout Completion Rate',kpiTreeStage:'Unified Checkout',kpiTreePath:'Unified Checkout Completion Rate'},
      {name:'Cross-Business Loyalty Wallet',marketEvidence:'Guests with cross-business point redemption show 28% higher annual spend (Loyalty360 Benchmark 2025)',kpiTreeMatch:'aligned',kpiTreeMetric:'Loyalty Point Redemption Rate at Checkout',kpiTreeStage:'Unified Checkout',kpiTreePath:'Loyalty Point Redemption Rate at Checkout'},
      {name:'Unified Change Request Management',marketEvidence:'62% of multi-business travellers cite separate-provider change management as their top post-booking frustration (Phocuswright 2025)',kpiTreeMatch:'none',kpiTreeMetric:'',kpiTreeStage:'',kpiTreePath:''},
      {name:'AI Itinerary Co-Pilot',marketEvidence:'Expedia and Booking.com launched conversational trip-planning assistants in 2024-25; Bonvoy already has one live',kpiTreeMatch:'partial',kpiTreeMetric:'Cross-Business Recommendation Rate',kpiTreeStage:'Discovery',kpiTreePath:'Cross-Business Recommendation Rate'}
    ],
    docxSections:{
      marketOverview:'The global travel and leisure booking market reached an estimated $1.4T in 2025, growing at 9.4% CAGR. Among multi-business operators, 34% of guests book two or more business lines when unified checkout and bundling are offered, compared to far lower attach rates with separate checkouts.',
      buyerCriteriaNarrative:'Three buyer priorities dominate: a single checkout across business lines (71% cite separate checkouts as the top blocker to adding extra items), cross-business loyalty point redemption (28% higher annual spend when available), and unified itinerary management post-booking (62% cite separate-provider change management as their biggest frustration).',
      productMarketPosition:'OneCart is well-positioned on cart assembly and unified checkout, comparable to Disney Genie+ and Marriott Bonvoy. The confirmed gap is Post-Purchase Servicing, where no capabilities have been generated yet despite this being the top traveller frustration.',
      trendsNarrative:'AI itinerary co-pilots are the dominant active trend among category leaders. Unified loyalty wallets are actively differentiating guest spend. Self-service post-booking changes remain a clear, unaddressed opportunity. Dynamic bundle pricing has peaked and is now table stakes.',
      competitiveSummary:'Disney Genie+ leads on unified checkout and loyalty maturity for a single-operator model. Marriott Bonvoy leads on cross-business loyalty wallet depth and AI co-pilot. OneCart\'s advantage is breadth of business-line categories, but Post-Purchase Servicing lags both competitors.',
      swotSynthesis:'OneCart\'s cart assembly and unified checkout capabilities are competitive with category leaders. Post-Purchase Servicing is the structural gap — the stage travellers cite as their biggest frustration has no generated capabilities, while competitors have mature self-service change flows.',
      gapMatrix:[
        {expectation:'Self-service unified change requests across business lines',today:'No capabilities generated for Post-Purchase Servicing',severity:'H',gap:'62% of travellers cite separate-provider change management as their top frustration; OneCart has zero coverage',opportunity:'Generate Unified Change Request Completion Rate capabilities targeting single-request multi-line changes'},
        {expectation:'AI conversational itinerary co-pilot',today:'Rule-based Cross-Business Suggestion Engine only',severity:'M',gap:'Bonvoy and Expedia both have conversational AI trip planning live',opportunity:'Evaluate conversational layer on top of existing itinerary-aware suggestion ranking'},
        {expectation:'Points expiry nudges for cross-business wallet',today:'Combined points balance display exists, expiry nudges do not',severity:'M',gap:'Expiry-driven redemption is a proven incremental revenue lever for loyalty programs',opportunity:'Generate Points Expiry Nudges capability under Cross-Business Loyalty Wallet'}
      ],
      capabilityMap:[
        {l1:'Cart Assembly',l2:'Cross-Business Suggestion Engine',features:'In-cart dining carousel, one-tap add, suggestion dismissal memory',status:'Present',notes:'Rule-based — comparable to early Genie+ suggestion model'},
        {l1:'Unified Checkout',l2:'Single Payment Across Business Lines',features:'Single-charge summary, saved payment one-tap, step progress indicator',status:'Present',notes:'Comparable to Genie+ and Bonvoy unified checkout'},
        {l1:'Unified Checkout',l2:'Cross-Business Loyalty Wallet',features:'Combined points balance display',status:'Partial',notes:'Expiry nudges not yet generated — 28% spend uplift opportunity unrealised'},
        {l1:'Post-Purchase Servicing',l2:'Unified Change Request Management',features:'None generated',status:'GAP',notes:'Top traveller frustration (62%) — zero coverage, both competitors more mature here'}
      ],
      roadmap:[
        {capability:'Unified Change Request Management',priority:'Accelerate',timeline:'Q3 2025',rationale:'62% of travellers cite this as their top frustration. Zero current coverage is the largest gap versus competitors.'},
        {capability:'Points Expiry Nudges',priority:'Accelerate',timeline:'Q3 2025',rationale:'28% annual spend uplift among guests with cross-business redemption. Low-effort extension of existing wallet.'},
        {capability:'AI Itinerary Co-Pilot evaluation',priority:'Monitor',timeline:'H1 2026',rationale:'Differentiating at category leaders but not yet table stakes for multi-business operators broadly.'},
        {capability:'Dynamic bundle pricing',priority:'Protect',timeline:'Ongoing',rationale:'Peaking trend — maintain current static bundle builder reliability rather than over-invest.'}
      ],
      valueAnchors:[
        {capability:'Unified checkout',benchmark:'34% of guests book 2+ business lines when unified checkout and bundling are offered',source:'Skift Research 2025'},
        {capability:'Cross-business loyalty redemption',benchmark:'28% higher annual spend among guests who can redeem points across business lines',source:'Loyalty360 Benchmark 2025'},
        {capability:'Self-service post-booking changes',benchmark:'62% of travellers cite separate-provider change management as their top frustration',source:'Phocuswright Traveller Survey 2025'}
      ],
      sources:[
        {source:'Phocuswright — Global Travel Market Report',scope:'Market size, CAGR, traveller frustration survey',year:'2025',confidence:'Medium-High'},
        {source:'Skift Research — Unified Checkout Study',scope:'Attach rate and checkout unification impact',year:'2025',confidence:'High'},
        {source:'Loyalty360 — Cross-Business Loyalty Benchmark',scope:'Cross-business point redemption spend impact',year:'2025',confidence:'Medium'}
      ],
      methodologyNote:'Research produced from AI training data. All stats should be verified independently. Web-sourced research will be added in v5.1.',
      limitations:'All statistics are AI-generated from training data. No live web search was performed in this generation (v5.0).'
    }
  };
  miCapabilities=miData.capabilities;
  capStore['mi||capabilities']={
    metricName:'MI Capabilities',
    stageLabel:'Market Intelligence',
    stageId:'mi',
    _miCap:true,
    capabilities:[{
      name:'Unified Change Request Management',
      why:'Disney Genie+ and Marriott Bonvoy demonstrate that unified multi-line change flows reduce support contacts and improve guest satisfaction scores.',
      subCaps:null,
      featStore:{top:[
        {name:'Single-request multi-line date change',why:'Lets a guest change dates for hotel, park ticket, and dining reservation in one request.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'Unified Change Request Management',_miSent:false},
        {name:'Unified cancellation with per-line refund breakdown',why:'A single cancellation request triggers per-business-line refund processing with one combined status view.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'Unified Change Request Management',_miSent:false},
        {name:'Change request status tracker',why:'Shows guests real-time status of each business line portion of a multi-line change request.',selected:false,metric:'MI Capabilities',stage:'Market Intelligence',cap:'Unified Change Request Management',_miSent:false}
      ]}
    }]
  };
  // Reveal MI tab unconditionally in demo mode
  const miTabElD=document.getElementById('tab-mi');
  if(miTabElD) miTabElD.style.display='';

  // ── 5. Render everything ──
  ddGenerated=false;
  capActiveMetricKey=null;capActiveCapIdx=null;capActiveSubCapIdx=null;

  // Update header
  const pnEl=document.getElementById('hdr-product-name');
  if(pnEl){pnEl.textContent='OneCart';pnEl.classList.add('has-name');}

  // Show demo badge
  _showDemoBadge();

  // Render Discovery Map
  const esEl=document.getElementById('es');
  if(esEl)esEl.style.display='none';
  const lsEl=document.getElementById('ls');
  if(lsEl)lsEl.classList.remove('on');
  const erEl=document.getElementById('er');
  if(erEl)erEl.classList.remove('on');
  const mmOut=document.getElementById('mm-out');
  if(mmOut)mmOut.innerHTML='';
  // Reset banner state and populate productContext for demo
  mmBannerCollapsed=false;
  productContext={
    name:'OneCart',
    url:'',
    description:'A B2C unified cart and checkout platform for a multi-business consumer group (theme parks, resorts, dining, merchandise, and experiences), letting guests discover, assemble, and pay for items across business lines in a single transaction.',
    industry:'Travel & Hospitality',
    productType:'B2C Product',
    kpis:'Cross-business attach rate, unified checkout completion rate, average order value per booking',
    problem:'Guests booking a park ticket rarely add hotel, dining, or merchandise in the same transaction because each business line has its own checkout, causing fragmented bookings and lost attach revenue',
    icp:'Leisure travellers and families planning a multi-day visit across parks, hotels, dining, and experiences',
    additionalContext:'',
    measurementModelName:'Unified Booking & Checkout Model',
    frameworks:['APQC PCF','First principles'],
    nsmMetric:'Cross-Business Attach Rate per Booking'
  };
  renderMM(gData);
  document.getElementById('mm-out').classList.add('on');
  if(typeof renderDiagnosticActionBar==='function')renderDiagnosticActionBar();

  // Render story canvas with pre-built features and stories
  fcRenderCanvas();
  fcRenderCapNav();
  fcUpdateTabBadge();
  if(typeof ccUpdateTabBadge==='function')ccUpdateTabBadge();

  // No PLA / Metrics Definition for OneCart — tab-la stays hidden
  ddGenerated=false;

  // Reveal Capability Canvas tab (has capStore data)
  const ccTabElD=document.getElementById('tab-cc');
  if(ccTabElD)ccTabElD.style.display='';

  // ── PI Planning demo data — light board (2 squads, 2 sprints, ~9-10 stories) ──
  piMode=false;
  const _demoSquadsOC=[
    {name:'Cart & Checkout Squad', devs:4,sprints:2,availability:85,capacity:16},
    {name:'Accessibility Squad',   devs:2,sprints:2,availability:80,capacity:10}
  ];
  piInputs={type:'caps-only',
    piGoal:'Increase cross-business attach rate and ship WCAG 2.2 AA compliance for unified checkout before the Q3 regulatory deadline.',
    constraints:'Accessibility Squad is dedicated to compliance work this release and cannot pick up cart/checkout features.',
    parsedCaps:[],parsedFeatures:[],
    carryForwardItems:['Multi-business bundle price preview (partially complete from REL-2026-Q1)'],
    overlapResolutions:{}};

  // ── Story pool (standalone — not attached to SC features) ──
  if(typeof piStoryPool==='undefined'){piStoryPool={};}
  var _psOC=[
    // Cart & Checkout Squad stories
    {id:'ST-CC1',title:'One-tap add for cross-business items',statement:'As a OneCart guest, I want to add a suggested cross-business item to my cart in one tap with date and party size pre-filled, so that I do not re-enter information.',points:3,priority:'Should Have',dor:'READY',dorReason:''},
    {id:'ST-CC2',title:'Date conflict banner with suggested fix',statement:'As a OneCart guest, I want to see a banner with a suggested date fix when my cart has a date conflict across business lines, so that I can resolve it in one tap.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CC3',title:'Unified inventory hold timer',statement:'As a OneCart guest, I want to see a single countdown timer for all items held across business lines during checkout, so that I know how long I have to complete my purchase.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-CC4',title:'Pre-built bundle templates for common itineraries',statement:'As a OneCart guest, I want to see pre-built bundle templates for common multi-day itineraries, so that I have a starting point to customise rather than building from scratch.',points:5,priority:'Should Have',dor:'IN REVIEW',dorReason:'Depends on bundle pricing engine (carry-forward from REL-2026-Q1)'},
    // Accessibility Squad stories
    {id:'ST-A1',title:'Checkout error messages announced clearly to screen readers',statement:'As a OneCart guest using a screen reader, I want checkout error messages to be announced clearly with a recommended next action, so that I can recover without sighted assistance.',points:3,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-A2',title:'Combined points balance slider is keyboard-operable',statement:'As a OneCart guest using only a keyboard, I want to adjust the points redemption slider at checkout using arrow keys, so that I can redeem points without a mouse.',points:2,priority:'Must Have',dor:'READY',dorReason:''},
    {id:'ST-A3',title:'Itinerary calendar view has accessible date labels',statement:'As a OneCart guest using a screen reader, I want each date in the itinerary calendar view to have an accessible label including the business line and item name, so that I can review my itinerary independently.',points:3,priority:'Should Have',dor:'READY',dorReason:''}
  ];
  _psOC.forEach(function(s){piStoryPool[s.id]=s;});

  // ── Sprint board assignments ──
  var _saOC={
    'ST-001':  {sprint:1,squad:'Cart & Checkout Squad', points:3,status:'planned'},
    'ST-002':  {sprint:1,squad:'Cart & Checkout Squad', points:2,status:'planned'},
    'ST-CC1':  {sprint:1,squad:'Cart & Checkout Squad', points:3,status:'planned'},
    'ST-007':  {sprint:1,squad:'Accessibility Squad',   points:5,status:'planned'},
    'ST-A1':   {sprint:1,squad:'Accessibility Squad',   points:3,status:'planned'},

    'ST-003':  {sprint:2,squad:'Cart & Checkout Squad', points:3,status:'planned'},
    'ST-CC2':  {sprint:2,squad:'Cart & Checkout Squad', points:3,status:'planned'},
    'ST-CC3':  {sprint:2,squad:'Cart & Checkout Squad', points:3,status:'planned'},
    'ST-008':  {sprint:2,squad:'Accessibility Squad',   points:3,status:'planned'},
    'ST-A2':   {sprint:2,squad:'Accessibility Squad',   points:2,status:'planned'}
  };
  var _backlogIdsOC=['ST-004','ST-005','ST-006','ST-CC4','ST-A3'];

  const demoStartOC=new Date();
  demoStartOC.setDate(demoStartOC.getDate()+(7-demoStartOC.getDay())+1);
  const fmtOC=function(d){return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});};
  const demoSprintsOC=[];
  for(var iOC=0;iOC<2;iOC++){
    const sOC=new Date(demoStartOC);sOC.setDate(sOC.getDate()+iOC*14);
    const eOC=new Date(sOC);eOC.setDate(eOC.getDate()+13);
    demoSprintsOC.push({id:iOC+1,label:'Sprint '+(iOC+1),dateRange:fmtOC(sOC)+' \u2013 '+fmtOC(eOC)});
  }

  const _demoPlanOC={
    id:'rp-demo-oc',
    createdAt:Date.now(),
    name:_genDemoReleasePlanName(),
    startDate:demoStartOC.toISOString().split('T')[0],
    sprintCount:2,sprintDuration:14,
    sprints:demoSprintsOC,
    storyAssignments:_saOC,
    dependencies:[
      {fromId:'ST-CC4',toId:'ST-CC1',type:'blocks',description:'Bundle templates depend on the cross-business suggestion engine\'s one-tap add capability'}
    ],
    externalDeps:[
      {description:'WCAG 2.2 AA audit checkpoint with external accessibility consultant',owner:'Accessibility Consultant',dueDate:'End of Sprint 2',status:'confirmed'}
    ],
    businessValueBullets:[
      'Increase cross-business attach rate via in-cart suggestions, date-conflict resolution, and single-charge checkout',
      'Ship WCAG 2.2 AA compliance for unified checkout ahead of the Q3 regulatory deadline',
      'Lay groundwork for bundle templates and points expiry nudges in the following release'
    ],
    businessValueOneLiner:'This release increases cross-business attach rate through cart and checkout improvements while delivering accessibility compliance ahead of the Q3 deadline.',
    backlogNotes:{
      'ST-CC4':'Blocked on bundle pricing engine carry-forward from REL-2026-Q1',
      'ST-A3':'Lower priority — itinerary calendar view accessibility scoped for next release'
    },
    squads:_demoSquadsOC
  };
  piPlans=[_demoPlanOC];
  _piActivePlanId=_demoPlanOC.id;
  piBacklogStoryIds=(typeof piBacklogStoryIds!=='undefined'&&Array.isArray(piBacklogStoryIds))?piBacklogStoryIds:[];
  _backlogIdsOC.forEach(function(id){if(!piBacklogStoryIds.includes(id))piBacklogStoryIds.push(id);});

  // Set _inSC and _inPIPlan flags on demo stories
  const _piInPlanIdsOC=['ST-001','ST-002','ST-003','ST-007','ST-008'];
  scCanvas.forEach(function(f){
    if(f.stories){f.stories.forEach(function(st){
      st._inSC=true;st._hiddenFromSC=false;
      st._inPIPlan=_piInPlanIdsOC.includes(st.id);st._stagedForPI=false;
    });}
  });
  // Add a demo dependency: ST-005 depends on ST-004 (single charge summary needs breakdown groundwork)
  scCanvas.forEach(function(f){
    if(f.name==='Single-charge checkout summary'&&f.stories&&f.stories.length>1){
      f.stories[1].dependencies=[{direction:'blocked-by',storyId:'ST-004',storyTitle:'Guest sees one total and one charge for a multi-business cart'}];
    }
  });
  // Rebuild scPiSelectedIds from story flags
  scPiSelectedIds=new Set();
  scCanvas.forEach(function(f){if(f.stories&&f.stories.some(function(s){return s._stagedForPI;}))scPiSelectedIds.add(f.id);});
  piScVersion=scCanvas.map(function(f){return f.id;}).join('|');
  if(typeof scApplyPIPlannedBadges==='function')scApplyPIPlannedBadges(_saOC);
  if(typeof piUpdateTabBadge==='function')piUpdateTabBadge();

  // ── Set sessionContext for demo session ──
  sessionContext={
    companyProfile:JSON.parse(JSON.stringify(companyProfile)),
    productProfile:JSON.parse(JSON.stringify(productProfiles[0])),
    approach:'outcome-based',
    generationMode:'ai-generated',
    manualList:[],
    customValueChain:'',
    additionalContext:'',
    marketIntelligence:false,
    launchedAt:Date.now()
  ,
    allowAISuggestions:false,
    sessionDocs:[]
  };;
  sessionActive=true;

  // Reveal tabs — mm, cc, mi, fc + gated sc and pi (no la — PLA decommissioned)
  const tabMm=document.getElementById('tab-mm');
  if(tabMm)tabMm.style.display='';
  const tabCc=document.getElementById('tab-cc');
  if(tabCc)tabCc.style.display='';
  const tabMi=document.getElementById('tab-mi');
  if(tabMi)tabMi.style.display='';
  const tabFc=document.getElementById('tab-fc');
  if(tabFc)tabFc.style.display='';
  const tabSc=document.getElementById('tab-sc');
  if(tabSc){tabSc.style.display='';tabSc.classList.add('revealed');}
  const tabPi=document.getElementById('tab-pi');
  if(tabPi){tabPi.style.display='';tabPi.classList.add('revealed');}

  // Demo sessions start pre-populated, not "newly sent" - clear any
  // stale pending dots from a prior live session
  ['cc','fc','sc','pi'].forEach(function(id){if(typeof clearTabPending==='function')clearTabPending(id);});

  // Force feature flags on for demo — overrides any user-saved settings that disabled them
  appSettings.featPI=true;
  appSettings.featMI=true;
  featPI=true;
  featMI=true;
  // Re-run applyFeats with full state so tab visibility reflects demo data
  if(typeof applyFeats==='function')applyFeats();

  // Navigate to Discovery Map and render KPI tree from loaded gData
  setTimeout(function(){
    switchTab('mm');
    if(typeof renderMM==='function'&&gData)renderMM(gData);
    if(typeof fcRenderCanvas==='function')fcRenderCanvas();
    if(typeof fcRenderCapNav==='function')fcRenderCapNav();
    if(typeof newScRender==='function')newScRender();
  }, 300);

  // Hide lock message — session is now active
  const homeLock=document.getElementById('home-tab-lock');
  if(homeLock)homeLock.style.display='none';

  // Refresh Home tab selector so OneCart shows as selected if PM returns to Home
  if(typeof _homeRenderProductSelector==='function')_homeRenderProductSelector();

  // Outcome Verification Loop: demo hypothesis population
  _demoAttachOutcomeHypotheses([
    {name:'Single-charge checkout summary',
      primary:{metric:'Unified Checkout Completion Rate',unit:'%',baseline:52,target:74,
        rationale:'A single combined payment should reduce the perceived complexity of a multi-business cart.',
        secondary:[{metric:'Cart Abandonment Rate by Business Line Count',unit:'%',baseline:31,target:20,direction:'decrease',actual:24}]},
      actual:58,signal:'no-change'}
  ]);
  _demoSetNsmTracking(22,30,24.6);

  console.log('Demo data loaded \u2014 OneCart product (outcome-based), '+Object.keys(capStore).length+' capability groups, '+scCanvas.length+' features on Story Canvas');
}
