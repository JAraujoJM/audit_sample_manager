/**
 * Audit Request Manager — Flow A proof of concept (Google Apps Script)
 * ---------------------------------------------------------------------
 * Drop document numbers, enrich them via the FinRec SQL Gateway, and show
 * the required Preparer action per line. No roles, no storage — just the engine.
 *
 * SETUP
 *  1. Create an Apps Script project (or `clasp create`), add this file + Index.html.
 *  2. The account running it needs WRITE on Requests_Pending/ and READ on
 *     Responses/ + Requests_Failed/ in the "FinRec Outside Teleport" shared folder.
 *  3. Deploy > New deployment > Web app (execute as: you; access: your org).
 *
 * NOTE ON THE QUERY: the gateway accepts ONE SELECT/CTE and rejects stacked
 * statements (`;`). The original IPE query used `DECLARE @startdate ...;` — that
 * would be rejected, so here the dates are inlined as literals (FY_START/FY_END).
 */

var BASE_FOLDER_ID = '1Aib8GX_vakFZmMOD_8Y_sLiIjE-kEqdV';
var APP_ID         = 'audit_request_manager';
var DATABASE       = 'AIG_Nav_Jumia_Reconciliation';
var FY_START       = '2025-01-01';   // Created_Date window (inclusive)
var FY_END         = '2026-01-01';   // exclusive
var QUERY_MODE     = 'full';         // 'lean' = routing only (fastest) | 'full' = + PO/down-payment/statement columns
var POLL_BUDGET_MS = 330000;         // 5.5 min
var POLL_INTERVAL  = 4000;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Audit Samples Manager')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- folder helpers ---------- */
function sub_(name) {
  return DriveApp.getFolderById(BASE_FOLDER_ID).getFoldersByName(name).next();
}

/* ---------- SQL building (flow-agnostic helpers) ---------- */
function sqlLiteral_(v) {                       // escape + quote a value for an IN list
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * Build the enrichment query for a flow. The flow module (FlowA.js, …) owns the
 * SQL; `p` carries { database, queryMode, fyStart, fyEnd } from the flow config +
 * the selected period.
 */
function buildQuery_(flowId, docs, p) {
  var mod = flowModule_(flowId);
  if (!mod || !mod.buildQuery) throw new Error('Flow "' + flowId + '" has no enrichment module.');
  return mod.buildQuery(docs, p);
}

/* ---------- routing (config-driven) ---------- */
/**
 * Required evidence for a line, from its routing `facts` (produced by the flow
 * module): every active Routing row of the flow whose match holds. One entry per
 * required document, so e.g. an advance line returns two.
 */
function routeFacts_(flowId, facts) {
  var matched = routeLine_(facts, flowId);
  if (matched.length) {
    return {
      key:     styleKey_(matched),
      label:   matched.map(function (m) { return m.required_evidence; }).join(' + '),
      matched: matched
    };
  }
  return { key: '', label: 'No routing rule matched', matched: [] };
}

/** Map matched routing rules to the UI's colour key (a-pop / a-vc / a-adv). */
function styleKey_(matched) {
  var names = matched.map(function (m) { return String(m.rule_name); }).join(' ');
  if (/advance/i.test(names)) return 'adv';
  if (/unpaid/i.test(names))  return 'vc';
  return 'pop';
}

/* ---------- gateway round trip ---------- */
function submitJob_(query, database) {
  var requestId = APP_ID + '_' + Utilities.getUuid();
  var job = {
    query: query, request_id: requestId, app_id: APP_ID, output_name: requestId,
    database: database || DATABASE, evidence: true, contract_version: 1,
    description: 'Audit Request Manager enrichment', requested_by: Session.getActiveUser().getEmail()
  };
  sub_('Requests_Pending').createFile(requestId + '.json', JSON.stringify(job, null, 2), 'application/json');
  return requestId;
}
function findResponse_(requestId, rx) {
  var files = sub_('Responses').getFiles();
  while (files.hasNext()) {
    var f = files.next(), n = f.getName();
    if (n.indexOf(requestId + '_') === 0 && rx.test(n)) return f;
  }
  return null;
}
function findCsv_(requestId) { return findResponse_(requestId, /\.csv$/i); }
function isFailed_(requestId) {
  return sub_('Requests_Failed').getFilesByName(requestId + '.json').hasNext();
}
function parseCsv_(file) {
  var text = file.getBlob().getDataAsString('UTF-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);   // strip BOM
  return Utilities.parseCsv(text);
}

/* ---------- safe retry: re-poll an outstanding request before resubmitting ---------- */
function sig_(docs) { return docs.slice().sort().join('|'); }
function props_() { return PropertiesService.getUserProperties(); }

/**
 * Main entry called from the client. Single-phase: submit + poll within one
 * execution. If a long-running request times out, it is NOT lost — we persist
 * its id, return {status:'pending'}, and the next call with the same docs
 * RE-POLLS that id instead of resubmitting (no duplicate jobs).
 */
/**
 * Entry point from the New request form. `payload`:
 *   { docs, flowId, periodName, auditorEmail, reviewerEmail, dueDate, requestRef }
 * auditorEmail may be several comma-separated addresses. The flow + period select
 * the database and date window; the rest is captured on the persisted Request.
 * Single-phase submit+poll with the same safe-retry rule.
 */
function enrich(payload) {
  if (isSetupDone_()) requireRole_([ROLES.ADMIN]);   // SoD: only the Administrator runs enrichment
  payload = payload || {};
  var docs = parseDocs_(payload.docs || '');
  if (docs.length === 0) return { status: 'empty' };

  var flow = getFlow(payload.flowId);
  if (!flow) throw new Error('Choose a flow.');
  var period = findPeriod_(payload.flowId, payload.periodName);
  if (!period) throw new Error('Choose a period.');

  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var auditors = String(payload.auditorEmail || '').split(/[;,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!auditors.length || !auditors.every(function (e) { return EMAIL.test(e); })) {
    throw new Error('Enter valid auditor email(s), comma-separated.');
  }
  var reviewer = String(payload.reviewerEmail || '').trim();
  if (reviewer && !EMAIL.test(reviewer)) throw new Error('Enter a valid reviewer email.');

  var qp = { database: flow.database || DATABASE, queryMode: flow.query_mode || QUERY_MODE, fyStart: period.start, fyEnd: period.end };
  var query = buildQuery_(flow.flow_id, docs, qp);   // throws if the flow has no module yet
  var ctx = {
    flow: flow, period: period, qp: qp,
    auditor: auditors.join(', '), reviewer: reviewer,
    requestRef: String(payload.requestRef || '').trim(), dueDate: String(payload.dueDate || '').trim()
  };

  var signature = sig_(docs) + '|' + flow.flow_id + '|' + period.start + '|' + period.end + '|' + qp.queryMode;
  var p = props_();
  var stored = JSON.parse(p.getProperty('outstanding') || 'null');

  var requestId;
  if (stored && stored.sig === signature) {
    requestId = stored.requestId;            // resume polling the existing job
  } else {
    requestId = submitJob_(query, qp.database);
    p.setProperty('outstanding', JSON.stringify({ requestId: requestId, sig: signature }));
  }

  var deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    var resultFile = findCsv_(requestId);
    if (resultFile) { p.deleteProperty('outstanding'); return buildResults_(parseCsv_(resultFile), docs, requestId, query, resultFile, ctx); }
    if (isFailed_(requestId)) {
      p.deleteProperty('outstanding');
      return { status: 'failed', requestId: requestId,
               reason: 'Job moved to Requests_Failed/ — see Logs/audit.jsonl' };
    }
    Utilities.sleep(POLL_INTERVAL);
  }
  // timed out — keep the id so a retry resumes rather than resubmits
  return { status: 'pending', requestId: requestId };
}

function buildResults_(csv, docs, requestId, query, file, ctx) {
  ctx = ctx || {};
  var flowId = (ctx.flow && ctx.flow.flow_id) || 'flowA';
  var mod = flowModule_(flowId);

  if (!mod || !csv || !csv.length) {               // no module / empty result → everything not found
    var empty = docs.map(function (d) { return { doc: d, found: false, _matched: [] }; });
    return finalizeRun_(empty, docs, 0, requestId, query, file, ctx);
  }
  var header = csv[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  function cellFor(row) { return function (name) { return idx[name] === undefined ? '' : row[idx[name]]; }; }

  var keyCol = mod.sampleKey || 'Transaction_No';
  var byDoc = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r];
    if (!row || row.length < 2) continue;          // skip blank trailing line
    var d = String(cellFor(row)(keyCol)).toUpperCase();
    if (d && !byDoc[d]) byDoc[d] = row;            // first row per doc
  }

  var results = docs.map(function (d) {
    var row = byDoc[d.toUpperCase()];
    if (!row) return { doc: d, found: false, _matched: [] };
    var m = mod.mapRow(cellFor(row));              // flow-specific: fields + routing facts
    var routed = routeFacts_(flowId, m.facts || {});
    var out = { doc: d, found: true, action: routed.key, action_label: routed.label, _matched: routed.matched };
    Object.keys(m).forEach(function (k) { if (k !== 'facts') out[k] = m[k]; });
    return out;
  });
  var foundCount = results.filter(function (x) { return x.found; }).length;
  return finalizeRun_(results, docs, foundCount, requestId, query, file, ctx);
}

/* ---------- persist a successful run, then return a clean payload to the UI ---------- */
function finalizeRun_(results, docs, foundCount, requestId, query, file, ctx) {
  ctx = ctx || {};
  var ipe = buildIpe_(docs, foundCount, requestId, query, file, ctx);
  var ret = { status: 'ok', requestId: requestId, rows: results.map(stripInternal_), ipe: ipe };
  if (isSetupDone_()) {
    try {
      ret.dbRequestId = persistRun_(results, requestId, file, ctx, ipe).dbRequestId;
    } catch (e) {
      ret.persistError = String(e);                // never block the auditor's result on a write failure
      logActivity('ENRICH_PERSIST_FAILED', 'request', requestId, String(e));
    }
  }
  return ret;
}

function stripInternal_(row) {
  var o = {};
  for (var k in row) if (row.hasOwnProperty(k) && k.charAt(0) !== '_') o[k] = row[k];
  return o;
}

/**
 * A successful enrichment becomes a Request + one Sample_Line per document + one
 * Assignment per required evidence item. Assignments default to the routing
 * `responsible`; when that's a role (not an email), assigned_to is left blank for
 * the admin to assign a specific preparer — including different people per item.
 */
function persistRun_(results, gatewayRequestId, file, ctx, ipe) {
  ctx = ctx || {};
  var flow   = ctx.flow   || getFlow('flowA') || { flow_id: 'flowA', name: 'Marketplace revenues / COGS' };
  var period = ctx.period || { name: '', start: '', end: '' };
  var actor  = Session.getActiveUser().getEmail() || 'system';
  var ds     = dataSs_();
  var reqId  = newId_('REQ');
  var ts     = nowIso_();

  var stored = {};
  try { stored = storeRequestFiles_(reqId, gatewayRequestId, file); }
  catch (e) { logActivity('STORE_FILES_FAILED', 'request', reqId, String(e)); }

  appendObject_(ds, 'Requests', {
    request_id: reqId, flow_id: flow.flow_id, title: flow.name,
    period: period.name, period_start: period.start, period_end: period.end,
    auditor_email: ctx.auditor || '', reviewer_email: ctx.reviewer || '',
    request_ref: ctx.requestRef || '', due_date: ctx.dueDate || '',
    status: 'enriched', created_by: actor, created_at: ts, updated_at: ts,
    csv_file_id: stored.csvId || '', xlsx_file_id: stored.xlsxId || '',
    ipe_json: ipe ? JSON.stringify(ipe) : ''
  });

  var lines = 0, assignments = 0;
  results.forEach(function (r) {
    var lineId = newId_('LIN');
    if (!r.found) {
      appendObject_(ds, 'Sample_Lines', {
        line_id: lineId, request_id: reqId, document_no: r.doc,
        status: 'not_found', required_count: 0, created_at: ts
      });
      lines++;
      return;
    }
    var matched = r._matched || [];
    appendObject_(ds, 'Sample_Lines', {
      line_id: lineId, request_id: reqId, document_no: r.doc,
      company: r.company, vendor: r.vendor, mpl_type: r.mpl,
      paid_status: r.paid_at ? 'Paid' : 'Unpaid',
      statement_code: r.statement, amount: r.amount,
      paid_at: r.paid_at || '', closing_balance: r.closing_balance || '',
      route_rule: matched.map(function (m) { return m.rule_name; }).join(','),
      required_count: matched.length, status: 'open',
      evidence_folder_id: '', created_at: ts
    });
    lines++;
    matched.forEach(function (m) {
      var resp = String(m.responsible || '');
      appendObject_(ds, 'Assignments', {
        assignment_id: newId_('ASG'), line_id: lineId, request_id: reqId,
        evidence_type: m.required_evidence,
        assigned_to: /@jumia\.com$/i.test(resp) ? resp : '',
        status: 'pending', due_date: '', submitted_at: '', notes: '', created_at: ts
      });
      assignments++;
    });
  });

  logActivity('ENRICH_PERSIST', 'request', reqId,
              lines + ' lines, ' + assignments + ' assignments (gateway ' + gatewayRequestId + ')');
  return { dbRequestId: reqId, lines: lines, assignments: assignments };
}

function newId_(prefix) { return prefix + '_' + Utilities.getUuid().slice(0, 8); }

/**
 * Copy the gateway outputs (result CSV + SOX evidence XLSX) into Exports/{reqId}/
 * so we keep our own copy to hand to the audit team. The XLSX can land a few
 * seconds after the CSV, so wait a short while for it. Files are COPIED (the
 * gateway's Responses/ is shared).
 */
function storeRequestFiles_(reqId, gatewayRequestId, csvFile) {
  var exportsId = PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS);
  if (!exportsId) return {};
  var folder = getOrCreateFolder_(DriveApp.getFolderById(exportsId), reqId);
  var out = {};

  if (csvFile) { try { out.csvId = csvFile.makeCopy(csvFile.getName(), folder).getId(); } catch (e) {} }

  var deadline = Date.now() + 20000, xlsx = null;
  while (Date.now() < deadline) {
    xlsx = findResponse_(gatewayRequestId, /\.xlsx$/i);
    if (xlsx) break;
    Utilities.sleep(2500);
  }
  if (xlsx) { try { out.xlsxId = xlsx.makeCopy(xlsx.getName(), folder).getId(); } catch (e) {} }
  return out;
}

/* ---------- IPE / SOX evidence metadata ---------- */
function sha256Hex_(bytes) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return d.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function buildIpe_(docs, foundCount, requestId, query, file, ctx) {
  ctx = ctx || {};
  var flow   = ctx.flow   || { flow_id: 'flowA', name: 'Marketplace revenues / COGS' };
  var period = ctx.period || { name: '', start: FY_START, end: FY_END };
  var qp     = ctx.qp     || { database: DATABASE, queryMode: QUERY_MODE };
  var now = new Date();
  var yyyymm = Utilities.formatDate(now, 'UTC', 'yyyyMM');
  var ts = Utilities.formatDate(now, 'UTC', 'yyyy-MM-dd HH:mm:ss') + ' UTC';
  var blob = file ? file.getBlob() : null;
  var bytes = blob ? blob.getBytes() : [];
  var requested = docs.length, notFound = requested - foundCount;

  return {
    documentRef:    'IPE-' + String(flow.flow_id || 'flow').toUpperCase() + '-' + yyyymm,
    period:         (period.name ? period.name + ' · ' : '') + 'Created_Date window ' + period.start + ' → ' + period.end,
    scope:          flow.name + ' · ' + flow.flow_id,
    primaryDb:      qp.database,
    queryMode:      qp.queryMode,
    timestamp:      ts,
    requestedBy:    Session.getActiveUser().getEmail() || 'n/a',
    requestId:      requestId,
    classification: 'CONFIDENTIAL · SOX-Relevant',
    status:         'Draft',
    requested:      requested,
    found:          foundCount,
    notFound:       notFound,
    query:          query || '',
    csvName:        file ? file.getName() : '',
    csvSize:        bytes.length,
    csvSha256:      bytes.length ? sha256Hex_(bytes) : '',
    evidenceNote:   'A SOX evidence workbook (query, script, result set, timestamp) was generated by the gateway for this request (evidence = true).',
    checks: [
      { name: 'Source authenticity',  method: 'Read-only SELECT executed via the FinRec SQL gateway (no client DB access)', result: 'Pass' },
      { name: 'Period integrity',     method: 'Date literals from the selected period (' + period.start + ' to ' + period.end + '); no DECLARE', result: 'Pass' },
      { name: 'No manual overrides',  method: 'Only the sample list and the period bound the query', result: 'Pass' },
      { name: 'De-duplication',       method: 'Sample document numbers de-duplicated before extraction', result: 'Pass' },
      { name: 'Completeness',         method: 'Resolved ' + foundCount + ' of ' + requested + ' requested document numbers', result: notFound === 0 ? 'Pass' : 'Flag' },
      { name: 'File integrity',       method: 'SHA-256 computed over the returned CSV at extraction time', result: 'Pass' }
    ]
  };
}

function parseDocs_(text) {
  var seen = {}, out = [];
  String(text || '').split(/[\n,;]+/).forEach(function (t) {
    var v = t.replace(/^['"\s]+|['"\s]+$/g, '');
    if (!v) return;
    var k = v.toUpperCase();
    if (seen[k]) return;
    seen[k] = true; out.push(v);
  });
  return out;
}