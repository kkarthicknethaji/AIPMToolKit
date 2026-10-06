// ── MARKET INTELLIGENCE DOCX EXPORT ──
// Owns: miBuildDocx

function miBuildDocx(miData, ctx, exportMode){
  if(!miData){return;}
  // v9.01.01 fix: exportMode distinguishes Current View (instant, no AI
  // call, Sections 1-5 only) from Full Report (Sections 1-8, requires the
  // separate AI-enhancement call in miDownloadDocx). Previously this
  // function always wrote all 8 section headers unconditionally and
  // Section 5 always read from ds.gapMatrix -- data that only exists
  // after the Full Report AI call -- so Current View's Section 5 was
  // always empty and Sections 6-8 always showed as empty headers.
  // Defaults to 'full' so the existing miDownloadDocx call site (which
  // doesn't pass this param) keeps its current, already-confirmed-working
  // behavior unchanged. Named distinctly from the existing local `mode`
  // below (market/category product mode) to avoid a naming collision.
  const isCurrentView=exportMode==='current';
  const mode=miData.productMode||'market';
  const isCategory=(mode==='category');
  const productName=(ctx&&ctx.name)||'Product';
  const now=new Date();
  const monthYear=now.toLocaleString('default',{month:'long',year:'numeric'});
  const reportTitle=isCategory?'Category Intelligence':'Market Research & Discovery';

  // ── Build HTML content for Word-compatible DOCX ──
  const ds=miData.docxSections||{};
  const snap=miData.marketSnapshot||[];
  const criteria=miData.buyerCriteria||[];
  const trends=miData.trends||[];
  const competitors=miData.competitors||[];
  const deepDives=miData.competitorDeepDives||[];
  const swot=miData.swot||{};
  const caps=miData.capabilities||[];

  const esc=s=>(s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ── Cover header ──
  const _orgNameMi=typeof getOrgName==='function'?getOrgName():'';
  let html=`<html><head><meta charset="utf-8"/></head><body style="font-family:Arial,sans-serif;font-size:12pt;color:#000;">`;
  html+=`<div style="background:#003087;padding:24px;margin-bottom:24px;">
    ${_orgNameMi?`<p style="color:#aabbcc;font-size:11pt;margin:0 0 4px;">${esc(_orgNameMi)} · ${APP_NAME}</p>`:''}
    <p style="color:#fff;font-size:22pt;font-weight:bold;margin:0 0 4px;">${esc(productName)} — ${esc(reportTitle)}</p>
    <p style="color:#8C69F0;font-size:13pt;margin:0 0 12px;">${isCategory?'Category Intelligence Report':'Market Intelligence Report'}</p>
    <p style="color:#aabbcc;font-size:11pt;margin:0;">Research Period: ${esc(monthYear)} &nbsp;|&nbsp; Produced by: ${APP_NAME}</p>
  </div>`;

  // ── Disclaimer ──
  html+=`<div style="background:#fff4d7;border-left:4px solid #C8870A;padding:10px 14px;margin-bottom:20px;">
    <strong style="color:#C8870A;">Research Note:</strong> All market intelligence is AI-generated from training data. Statistics should be verified independently before client use. Web-sourced research will be added in v5.1.
  </div>`;

  // ── Section 1: Market Context ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;">Section 1 — Market Context</h1>`;
  if(ds.marketOverview)html+=`<h2 style="color:#5F1EBE;font-size:13pt;">1.1 Market Overview</h2><p>${esc(ds.marketOverview)}</p>`;

  // Market snapshot table
  if(snap.length){
    html+=`<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr style="background:#003087;color:#fff;"><th>Metric</th><th>Value</th><th>Source</th><th>Year</th></tr>
      ${snap.map(s=>`<tr><td>${esc(s.label)}</td><td><strong>${esc(s.value)}</strong></td><td>${esc(s.source)}</td><td>${esc(s.year)}</td></tr>`).join('')}
    </table>`;
  }

  if(ds.buyerCriteriaNarrative)html+=`<h2 style="color:#5F1EBE;font-size:13pt;">1.2 Buyer Behaviour &amp; Criteria</h2><p>${esc(ds.buyerCriteriaNarrative)}</p>`;

  if(criteria.length){
    html+=`<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr style="background:#003087;color:#fff;"><th>#</th><th>Criterion</th><th>Evidence</th><th>Relevance to Product</th></tr>
      ${criteria.map(c=>`<tr><td>${esc(c.rank)}</td><td><strong>${esc(c.criterion)}</strong></td><td>${esc(c.evidence)}${c.source?' ('+esc(c.source)+')':''}</td><td>${esc(c.productRelevance)}</td></tr>`).join('')}
    </table>`;
  }

  if(ds.productMarketPosition)html+=`<h2 style="color:#5F1EBE;font-size:13pt;">1.3 Product Market Position</h2><p>${esc(ds.productMarketPosition)}</p>`;

  // ── Section 2: Competitive Landscape ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 2 — ${isCategory?'Analogous Products &amp; Best Practice':'Competitive Landscape'}</h1>`;

  if(competitors.length){
    const domains=[];
    competitors.forEach(c=>(c.capabilities||[]).forEach(cap=>{if(!domains.includes(cap.domain))domains.push(cap.domain);}));
    const statusText={present:'✓ Present',partial:'~ Partial',gap:'✗ Gap'};
    html+=`<h2 style="color:#5F1EBE;font-size:13pt;">2.1 Feature Parity Matrix</h2>
    <table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr style="background:#003087;color:#fff;"><th>Capability</th>${competitors.map(c=>`<th>${esc(c.name)}</th>`).join('')}</tr>
      ${domains.map(d=>`<tr><td><strong>${esc(d)}</strong></td>${competitors.map(comp=>{
        const cap=(comp.capabilities||[]).find(c=>c.domain===d);
        const s=cap?cap.status:'unknown';
        const col=s==='present'?'#E1F5EE':s==='partial'?'#FFF4D7':s==='gap'?'#FDE8E8':'#F4F6FA';
        return`<td style="background:${col};text-align:center;">${esc(statusText[s]||'—')}</td>`;
      }).join('')}</tr>`).join('')}
    </table>`;
  }

  if(ds.competitiveSummary)html+=`<h2 style="color:#5F1EBE;font-size:13pt;">2.2 Competitive Summary</h2><p>${esc(ds.competitiveSummary)}</p>`;

  if(deepDives.length){
    html+=`<h2 style="color:#5F1EBE;font-size:13pt;">2.3 ${isCategory?'Benchmark Deep Dives':'Competitor Deep Dives'}</h2>`;
    deepDives.forEach(d=>{
      html+=`<div style="border:1px solid #D0D5E8;border-radius:6px;padding:12px;margin:10px 0;">
        <p style="font-weight:bold;color:#003087;margin:0 0 6px;">${esc(d.name)}</p>
        <p>${esc(d.narrative)}</p>
        ${d.leadAreas?`<p><strong>Where they lead:</strong> ${esc(d.leadAreas)}</p>`:''}
        ${d.productAdvantage?`<p><strong>Our advantage:</strong> ${esc(d.productAdvantage)}</p>`:''}
        ${d.threat?`<p style="color:#A32D2D;"><strong>Threat:</strong> ${esc(d.threat)}</p>`:''}
      </div>`;
    });
  }

  // ── Section 3: Industry Trends ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 3 — Industry Trend Signals</h1>`;
  if(ds.trendsNarrative)html+=`<p>${esc(ds.trendsNarrative)}</p>`;

  const signalColour={ACTIVE:'#DCE6F0',PEAKING:'#FFF4D7','TAIL-END':'#F4F6FA'};
  const signalText={ACTIVE:'ACTIVE','TAIL-END':'TAIL-END',PEAKING:'PEAKING'};
  trends.forEach((t,i)=>{
    const bg=signalColour[t.signal]||'#F4F6FA';
    html+=`<div style="border:1px solid #D0D5E8;border-radius:6px;padding:12px;margin:10px 0;">
      <div style="display:flex;gap:8px;margin-bottom:6px;">
        <span style="font-size:9pt;font-weight:bold;color:#6B6B68;">${esc(t.confidence||'')}</span>
        <span style="background:${bg};padding:2px 8px;border-radius:3px;font-size:9pt;font-weight:bold;">${esc(signalText[t.signal]||t.signal||'')}</span>
      </div>
      <p style="font-weight:bold;color:#003087;margin:0 0 4px;">${esc(t.name||'')}</p>
      <p style="margin:0 0 4px;"><strong>Evidence:</strong> ${esc(t.evidence||'')}${t.source?' ('+esc(t.source)+')':''}</p>
      <p style="margin:0 0 4px;"><strong>Implication:</strong> ${esc(t.implication||'')}</p>
      ${t.productGap?`<p style="margin:0 0 4px;"><strong>Product gap:</strong> ${esc(t.productGap)}</p>`:''}
      ${t.roadmapAction?`<p style="margin:0;color:#007873;"><strong>Roadmap action:</strong> ${esc(t.roadmapAction)}</p>`:''}
    </div>`;
  });

  // ── Section 4: SWOT ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 4 — ${isCategory?'Category-Perspective SWOT':'Market-Perspective SWOT'}</h1>`;
  html+=`<p style="font-style:italic;color:#6B6B68;">Based on AI training data — not internal product assessment. All weaknesses marked "Research-identified" are structural gaps confirmed with high confidence.</p>`;

  const swotDefs=[
    ['Strengths',swot.strengths||[],'#E1F5EE','#007873'],
    ['Weaknesses',swot.weaknesses||[],'#FDE8E8','#A32D2D'],
    ['Opportunities',swot.opportunities||[],'#DCE6F0','#0F5FDC'],
    ['Threats',swot.threats||[],'#FFF4D7','#C8870A']
  ];
  html+=`<table border="1" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
    <tr>${swotDefs.map(([label,,bg,tc])=>`<td style="width:50%;background:${bg};padding:10px;vertical-align:top;border:1px solid #D0D5E8;">
      <p style="font-weight:bold;color:${tc};font-size:9pt;text-transform:uppercase;margin:0 0 8px;">${label}</p>
      ${swotDefs[swotDefs.indexOf(swotDefs.find(d=>d[0]===label))][1].map(it=>`<p style="margin:0 0 6px;">• ${esc(it.text||'')}${it.researchIdentified?' <em>(Research-identified)</em>':''}${it.source?' <span style="font-size:9pt;color:#6B6B68;">['+esc(it.source)+']</span>':''}</p>`).join('')}
    </td>`).join('')}</tr>
  </table>`;
  if(swot.synthesis)html+=`<p style="background:#EEEDFE;border-left:4px solid #5F1EBE;padding:10px 14px;"><strong>SWOT Synthesis:</strong> ${esc(swot.synthesis)}</p>`;

  // ── Section 5: Capability Gap Matrix ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 5 — Capability Gap Analysis</h1>`;
  if(isCurrentView){
    // v9.01.01 fix: Current View has no docxSections (no AI-enhancement
    // call made), so render Section 5 from miData.capabilities directly --
    // already generated, already available, same data the in-app
    // "Capability Recommendations" panel shows.
    if(caps.length){
      const matchBg={aligned:'#E1F5EE',partial:'#FFF4D7'};
      const matchLabel={aligned:'In Discovery Map',partial:'Partial in Discovery Map'};
      html+=`<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
        <tr style="background:#003087;color:#fff;"><th>Capability</th><th>Discovery Map Alignment</th><th>Tree Path</th></tr>
        ${caps.map(c=>{
          const bg=matchBg[c.kpiTreeMatch]||'#FDE8E8';
          const label=matchLabel[c.kpiTreeMatch]||'Gap';
          return`<tr><td>${esc(c.name)}</td><td style="background:${bg};text-align:center;font-weight:bold;">${esc(label)}</td><td>${esc(c.kpiTreePath||'')}${c.kpiTreeStage?' &middot; '+esc(c.kpiTreeStage):''}</td></tr>`;
        }).join('')}
      </table>`;
    }
  } else {
    const gapMatrix=ds.gapMatrix||[];
    if(gapMatrix.length){
      html+=`<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
        <tr style="background:#003087;color:#fff;"><th>Market Expectation</th><th>Product Today</th><th>Sev</th><th>Gap</th><th>Opportunity</th></tr>
        ${gapMatrix.map(r=>{
          const sevBg=r.severity==='H'?'#FDE8E8':r.severity==='M'?'#FFF4D7':'#DCE6F0';
          return`<tr><td>${esc(r.expectation)}</td><td>${esc(r.today)}</td><td style="background:${sevBg};text-align:center;font-weight:bold;">${esc(r.severity)}</td><td>${esc(r.gap)}</td><td>${esc(r.opportunity)}</td></tr>`;
        }).join('')}
      </table>`;
    }
  }

  // v9.01.01 fix: Current View stops here -- Sections 6-8 all depend on
  // docxSections fields that only exist after Full Report's AI call, and
  // were previously always rendered as empty headers with no content for
  // Current View. Skipped entirely now rather than shown empty.
  if(!isCurrentView){

  // ── Section 6: Product Capability Map ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 6 — Product Capability Map</h1>`;
  const capMap=ds.capabilityMap||[];
  if(capMap.length){
    // Group by L1
    const l1Groups={};
    capMap.forEach(row=>{if(!l1Groups[row.l1])l1Groups[row.l1]=[];l1Groups[row.l1].push(row);});
    Object.entries(l1Groups).forEach(([l1,rows])=>{
      html+=`<h2 style="color:#5F1EBE;font-size:13pt;">L1: ${esc(l1)}</h2>
      <table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:10px 0 20px;">
        <tr style="background:#EEEDFE;"><th>L2 Sub-Capability</th><th>Features</th><th>Status</th><th>Notes</th></tr>
        ${rows.map(r=>{
          const statusBg=r.status==='GAP'?'#FDE8E8':r.status==='Partial'?'#FFF4D7':r.status==='INFERRED'?'#DCE6F0':'#E1F5EE';
          return`<tr><td><strong>${esc(r.l2)}</strong></td><td>${esc(r.features)}</td><td style="background:${statusBg};text-align:center;font-weight:bold;">${esc(r.status)}</td><td>${esc(r.notes)}</td></tr>`;
        }).join('')}
      </table>`;
    });
  }

  // ── Section 7: Roadmap ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 7 — Roadmap Recommendations</h1>`;
  const roadmap=(ds.roadmap||[]).filter(r=>r.priority!=='Deprioritise'||true);
  if(roadmap.length){
    const priorityBg={Accelerate:'#E1F5EE',Protect:'#DCE6F0',Monitor:'#FFF4D7',Deprioritise:'#F4F6FA'};
    html+=`<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr style="background:#003087;color:#fff;"><th>Capability</th><th>Priority</th><th>Timeline</th><th>Strategic Rationale</th></tr>
      ${roadmap.map(r=>`<tr>
        <td><strong>${esc(r.capability)}</strong></td>
        <td style="background:${priorityBg[r.priority]||'#F4F6FA'};text-align:center;font-weight:bold;">${esc(r.priority)}</td>
        <td>${esc(r.timeline)}</td>
        <td>${esc(r.rationale)}</td>
      </tr>`).join('')}
    </table>`;
    // Business value anchors
    const anchors=ds.valueAnchors||[];
    if(anchors.length){
      html+=`<h2 style="color:#5F1EBE;font-size:13pt;">7.2 Business Value Anchors</h2>
      <table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
        <tr style="background:#EEEDFE;color:#5F1EBE;"><th>Capability</th><th>Benchmark</th><th>Source</th></tr>
        ${anchors.map(a=>`<tr><td>${esc(a.capability)}</td><td>${esc(a.benchmark)}</td><td>${esc(a.source)}</td></tr>`).join('')}
      </table>`;
    }
  }

  // ── Section 8: Sources ──
  html+=`<h1 style="color:#003087;font-size:16pt;border-bottom:2px solid #003087;padding-bottom:6px;page-break-before:always;">Section 8 — Sources &amp; Methodology</h1>`;
  const sources=ds.sources||[];
  if(sources.length){
    html+=`<table border="1" cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12px 0;">
      <tr style="background:#003087;color:#fff;"><th>Source</th><th>Scope</th><th>Year</th><th>Confidence</th></tr>
      ${sources.map(s=>`<tr><td>${esc(s.source)}</td><td>${esc(s.scope)}</td><td>${esc(s.year)}</td><td>${esc(s.confidence)}</td></tr>`).join('')}
    </table>`;
  }
  if(ds.methodologyNote)html+=`<h2 style="color:#5F1EBE;font-size:13pt;">8.2 Methodology</h2><p>${esc(ds.methodologyNote)}</p>`;
  if(ds.limitations)html+=`<h2 style="color:#5F1EBE;font-size:13pt;">8.3 Limitations &amp; Caveats</h2><p>${esc(ds.limitations)}</p>`;

  } // end !isCurrentView (Sections 6-8)

  html+=`<div style="background:#F4F6FA;border-top:2px solid #D0D5E8;padding:12px;margin-top:24px;text-align:center;font-size:10pt;color:#6B6B68;">
    ${_orgNameMi?esc(_orgNameMi)+' · ':''}${APP_NAME} · ${esc(monthYear)}
  </div>`;
  html+=`</body></html>`;

  // ── Trigger download ──
  const blob=new Blob([html],{type:'application/msword'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const fname=`Market-Intelligence-${(productName||'Product').replace(/[^a-z0-9]/gi,'-')}-${monthYear.replace(/\s/g,'-')}.doc`;
  a.href=url;a.download=fname;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1000);
}
