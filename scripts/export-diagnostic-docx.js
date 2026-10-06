// ── DIAGNOSTIC DOCX EXPORT ──

function laDownloadDocx(){
  if(!productLeakAnalysis||!productLeakAnalysis.length){showToast('No analysis to export.','info');return;}
  // Export active run if one is selected; otherwise export the most recent run
  var la=typeof laGetActiveRun==='function'?laGetActiveRun():null;
  if(!la)la=productLeakAnalysis[productLeakAnalysis.length-1];
  const productName=getProductCtx().name;
  const htmlContent=buildDiagnosticDocxHTML(la,productName);
  const blob=new Blob([htmlContent],{type:'application/msword'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=productName.replace(/[^a-z0-9]/gi,'_')+'_Product_Leak_Analysis.doc';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Safely convert an array item to a plain string regardless of shape
function safeStr(x){
  if(!x)return'';
  if(typeof x==='string')return x;
  if(typeof x==='object'){
    // Common shapes the AI returns
    return x.point||x.text||x.finding||x.gap||x.summary||x.description||x.metric||JSON.stringify(x);
  }
  return String(x);
}

function buildDiagnosticDocxHTML(la,productName){
  const prioBg={P1:'#fde8e8',P2:'#fff4d7',P3:'#dce6f0'};
  const prioColor={P1:'#a32d2d',P2:'#c8870a',P3:'#0f5fdc'};

  // Experiments table — fixed column widths totalling ~680px to fit within Word page
  // Drop instrumentation column to keep table readable
  const expsRows=(la.experiments||[]).map(exp=>{
    const sm=exp.successMetric||{};
    return`<tr>
      <td style="padding:4px 6px;border:1px solid #d0d5e8;width:8%;text-align:center;vertical-align:top;">
        <span style="display:inline-block;padding:2px 6px;border-radius:10px;background:${prioBg[exp.priority]||'#f0f2f7'};color:${prioColor[exp.priority]||'#3d3d3a'};font-weight:bold;font-size:9pt;">${exp.priority||''}</span>
      </td>
      <td style="padding:4px 6px;border:1px solid #d0d5e8;width:32%;font-size:9pt;font-weight:bold;word-wrap:break-word;vertical-align:top;">${exp.experimentTitle||''}</td>
      <td style="padding:4px 6px;border:1px solid #d0d5e8;width:22%;font-size:9pt;word-wrap:break-word;vertical-align:top;">${exp.linkedMetricName||''}</td>
      <td style="padding:4px 6px;border:1px solid #d0d5e8;width:38%;font-size:9pt;word-wrap:break-word;vertical-align:top;">${exp.hypothesis||''}</td>
    </tr>`;
  }).join('');

  const evidenceSummaryHTML=(la.evidenceSummary||[]).length
    ?`<h2 style="font-family:Arial;font-size:13pt;color:#003087;margin-top:16pt;margin-bottom:5pt;">Evidence Summary</h2><ul>${(la.evidenceSummary||[]).map(x=>`<li style="font-family:Arial;font-size:10.5pt;margin-bottom:3pt;">${safeStr(x)}</li>`).join('')}</ul>`:'';

  const gapsHTML=(la.instrumentationGaps||[]).length
    ?`<h2 style="font-family:Arial;font-size:13pt;color:#003087;margin-top:16pt;margin-bottom:5pt;">Instrumentation Gaps</h2><ul>${(la.instrumentationGaps||[]).map(x=>`<li style="font-family:Arial;font-size:10.5pt;margin-bottom:3pt;color:#c8870a;">${safeStr(x)}</li>`).join('')}</ul>`:'';

  return`<html><head><meta charset="UTF-8">
  <style>
    body{font-family:Arial,sans-serif;margin:0.5cm 0.6cm;color:#1a1a1a;}
    h1{font-size:16pt;color:#003087;margin-bottom:4pt;line-height:1.3;}
    h2{font-size:13pt;color:#003087;margin-top:14pt;margin-bottom:4pt;}
    p{font-size:10.5pt;line-height:1.5;margin-bottom:6pt;}
    table{border-collapse:collapse;}
    th{background:#e9eef8;text-align:left;padding:5px 6px;border:1px solid #cbd4ea;font-size:9pt;font-weight:bold;}
    .section-block{background:#f8f9fc;border-left:3px solid #5f1ebe;padding:8px 12px;margin-bottom:10pt;}
    .caveat-block{background:#fff4d7;border-left:3px solid #c8870a;padding:6px 10px;margin-bottom:8pt;}
  </style>
  </head><body>
  <h1>${productName} - Experiment Canvas</h1>
  <p style="font-family:Arial;font-size:10pt;color:#aabbcc;margin:0 0 12pt;">${typeof getOrgName==='function'&&getOrgName()?getOrgName()+' · ':''}${APP_NAME}</p>

  <h2>North Star Metric</h2>
  <p>${(gData&&gData.nsm&&gData.nsm.metric)||'Not available'}</p>

  <h2>Diagnostic Summary</h2>
  <table style="width:460px;">
    <tr><th style="width:130px;">Field</th><th style="width:330px;">Value</th></tr>
    <tr><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">Leaking stage</td><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;font-weight:bold;">${la.leakingStage||'—'}</td></tr>
    <tr><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">Bottleneck metric</td><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;font-weight:bold;">${la.primaryBottleneckMetric||'—'}</td></tr>
    ${la.secondaryConcern?`<tr><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">Secondary concern</td><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">${la.secondaryConcern}</td></tr>`:''}
    <tr><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">Severity</td><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">${la.severity||'—'}</td></tr>
    <tr><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">Evidence strength</td><td style="padding:4px 6px;border:1px solid #d0d5e8;font-size:10pt;">${la.evidenceStrength||'—'}</td></tr>
  </table>

  ${la.diagnosticCaveat?`<div class="caveat-block"><p style="font-size:10pt;margin:0;"><b>Diagnostic caveat:</b> ${la.diagnosticCaveat}</p></div>`:''}

  <h2>Consulting Problem Statement</h2>
  <div class="section-block"><p style="font-size:10.5pt;margin:0;font-style:italic;">${la.problemStatement||''}</p></div>

  ${evidenceSummaryHTML}
  ${gapsHTML}

  <h2>Prioritized Experiments</h2>
  <table style="width:100%;table-layout:fixed;">
    <thead><tr>
      <th style="width:8%;">Priority</th>
      <th style="width:32%;">Experiment</th>
      <th style="width:22%;">Linked metric</th>
      <th style="width:38%;">Hypothesis</th>
    </tr></thead>
    <tbody>${expsRows}</tbody>
  </table>
  </body></html>`;
}
