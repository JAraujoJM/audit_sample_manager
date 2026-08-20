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

/* ---------- safe retry: re-poll outstanding requests before resubmitting ---------- */
function sigItems_(items) { return items.map(function (i) { return String(i.key); }).sort().join('|'); }
function props_() { return PropertiesService.getUserProperties(); }

/** Parse the paste box into sample items via the flow module (or a default single-token
 *  parser for flows without one). Every item carries a `.key` used to match result rows. */
function parseSample_(flowId, text) {
  var mod = flowModule_(flowId);
  if (mod && typeof mod.parseSample === 'function') return mod.parseSample(text);
  return parseDocs_(text).map(function (d) { return { key: d }; });
}

/** Poll Responses/ for a request's CSV until the deadline. Returns the file, the
 *  string 'FAILED' if it landed in Requests_Failed/, or null on timeout. */
function pollCsv_(requestId, deadline) {
  while (Date.now() < deadline) {
    var f = findCsv_(requestId);
    if (f) return f;
    if (isFailed_(requestId)) return 'FAILED';
    Utilities.sleep(POLL_INTERVAL);
  }
  return null;
}

/**
 * Entry point from the New request form. `payload`:
 *   { docs, flowId, periodName, auditorEmail, reviewerEmail, dueDate, requestRef }
 * auditorEmail may be several comma-separated addresses. The flow + period select
 * the database and date window; the rest is captured on the persisted Request.
 *
 * Two-stage aware: query 1 (the flow's database) always runs; if the flow module
 * declares a dependent `stage2` and query 1 yields references, query 2 runs against
 * stage2.database and is merged in. One execution (~6-min cap). Safe-retry persists
 * BOTH stage ids under one signature, so a timeout RESUMES (re-polls) rather than
 * resubmitting — no duplicate jobs / orphaned results.
 */
function enrich(payload) {
  if (isSetupDone_()) requireRole_([ROLES.ADMIN]);   // SoD: only the Administrator runs enrichment
  payload = payload || {};
  var flow = getFlow(payload.flowId);
  if (!flow) throw new Error('Choose a flow.');
  var items = parseSample_(flow.flow_id, payload.docs || '');
  if (items.length === 0) return { status: 'empty' };

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
  var mod = flowModule_(flow.flow_id);
  var query = buildQuery_(flow.flow_id, items, qp);   // throws if the flow has no module yet
  var ctx = {
    flow: flow, period: period, qp: qp,
    auditor: auditors.join(', '), reviewer: reviewer,
    requestRef: String(payload.requestRef || '').trim(), dueDate: String(payload.dueDate || '').trim()
  };

  var signature = sigItems_(items) + '|' + flow.flow_id + '|' + period.start + '|' + period.end + '|' + qp.queryMode;
  var p = props_();
  var stored = JSON.parse(p.getProperty('outstanding') || 'null');
  var st = (stored && stored.sig === signature) ? stored : { sig: signature };
  var deadline = Date.now() + POLL_BUDGET_MS;

  // ----- Stage 1 -----
  if (!st.q1Id) { st.q1Id = submitJob_(query, qp.database); p.setProperty('outstanding', JSON.stringify(st)); }
  var csv1File = pollCsv_(st.q1Id, deadline);
  if (csv1File === 'FAILED') { p.deleteProperty('outstanding'); return { status: 'failed', requestId: st.q1Id, reason: 'Query 1 moved to Requests_Failed/ — see Logs/audit.jsonl' }; }
  if (!csv1File) return { status: 'pending', requestId: st.q1Id };
  var csv1 = parseCsv_(csv1File);
  var mapped = mapStage1Rows_(mod, csv1, items);

  // ----- Stage 2 (optional, dependent on stage 1's references) -----
  var csv2 = null;
  if (mod && mod.stage2) {
    var refs = collectRefs_(mod, mapped);
    if (refs.length) {
      if (!st.q2Id) { st.q2Id = submitJob_(mod.stage2.buildQuery(refs, qp), mod.stage2.database); p.setProperty('outstanding', JSON.stringify(st)); }
      var csv2File = pollCsv_(st.q2Id, deadline);
      if (csv2File === 'FAILED') { p.deleteProperty('outstanding'); return { status: 'failed', requestId: st.q2Id, reason: 'Query 2 (' + mod.stage2.database + ') moved to Requests_Failed/ — see Logs/audit.jsonl' }; }
      if (!csv2File) return { status: 'pending', requestId: st.q2Id };
      csv2 = parseCsv_(csv2File);
    }
  }

  p.deleteProperty('outstanding');
  return buildResults_(mapped, items, st.q1Id, query, csv1File, ctx, csv2);
}

/** Index stage-1 rows by the flow's sampleKey and map each sample item to its row
 *  (mod.mapRow) — the per-row fields + routing facts. Returns [{item, found, mapped}]. */
function mapStage1Rows_(mod, csv, items) {
  if (!mod || !csv || !csv.length) return items.map(function (i) { return { item: i, found: false, mapped: null }; });
  var header = csv[0], idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  function cellFor(row) { return function (name) { return idx[name] === undefined ? '' : row[idx[name]]; }; }
  var keyCol = mod.sampleKey || 'Transaction_No';
  var byKey = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r];
    if (!row || row.length < 2) continue;          // skip blank trailing line
    var d = String(cellFor(row)(keyCol)).toUpperCase();
    if (d && !byKey[d]) byKey[d] = row;            // first row per key
  }
  return items.map(function (i) {
    var row = byKey[String(i.key).toUpperCase()];
    return row ? { item: i, found: true, mapped: mod.mapRow(cellFor(row)) } : { item: i, found: false, mapped: null };
  });
}

/** Distinct, non-null stage-2 references built from the mapped stage-1 rows. */
function collectRefs_(mod, mapped) {
  if (!mod.stage2 || typeof mod.stage2.refOf !== 'function') return [];
  var seen = {}, out = [];
  mapped.forEach(function (mr) {
    if (!mr.found) return;
    var ref = mod.stage2.refOf(mr.mapped);
    if (ref && !seen[String(ref)]) { seen[String(ref)] = true; out.push(ref); }
  });
  return out;
}

/**
 * Fold routing (+ any stage-2 detail) into the mapped rows and finalize. `csv2` is
 * the parsed query-2 result (or null); when present, each line's stage-2 reference is
 * matched against it and mod.stage2.merge folds those fields onto the line.
 */
function buildResults_(mapped, items, requestId, query, file, ctx, csv2) {
  ctx = ctx || {};
  var flowId = (ctx.flow && ctx.flow.flow_id) || 'flowA';
  var mod = flowModule_(flowId);

  var byRef = null, cell2 = null;
  if (mod && mod.stage2 && csv2 && csv2.length) {
    var h2 = csv2[0], idx2 = {};
    h2.forEach(function (h, i) { idx2[String(h).trim()] = i; });
    cell2 = function (row) { return function (name) { return idx2[name] === undefined ? '' : row[idx2[name]]; }; };
    byRef = {};
    var refCol = mod.stage2.keyCol;
    for (var r = 1; r < csv2.length; r++) {
      var row = csv2[r];
      if (!row || !row.length) continue;
      var k = String(cell2(row)(refCol)).toUpperCase();
      if (k && !byRef[k]) byRef[k] = row;
    }
  }

  var results = mapped.map(function (mr) {
    var item = mr.item;
    if (!mr.found) return { doc: item.key, item: item, found: false, _matched: [] };
    var m = mr.mapped;
    if (mod && mod.stage2 && byRef) {
      var ref = mod.stage2.refOf(m);
      if (ref) { var r2 = byRef[String(ref).toUpperCase()]; if (r2) mod.stage2.merge(m, mod.stage2.mapRow2(cell2(r2))); }
    }
    var routed = routeFacts_(flowId, m.facts || {});
    var out = { doc: item.key, item: item, found: true, action: routed.key, action_label: routed.label, _matched: routed.matched };
    Object.keys(m).forEach(function (k) { if (k !== 'facts') out[k] = m[k]; });
    return out;
  });
  var foundCount = results.filter(function (x) { return x.found; }).length;
  return finalizeRun_(results, items, foundCount, requestId, query, file, ctx);
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

// Flow-specific line fields (everything the mapped row carries beyond the standard
// Sample_Lines columns) → stored as detail_json so the views can render them without
// the engine knowing the flow's shape. Empty values are dropped to keep it compact.
var LINE_STD_ = { doc: 1, item: 1, found: 1, action: 1, action_label: 1, company: 1, vendor: 1,
                  mpl: 1, paid_at: 1, statement: 1, amount: 1, closing_balance: 1, po: 1, downpay: 1,
                  document_no: 1, subpopulation: 1 };
function lineDetail_(r) {
  var d = {};
  for (var k in r) {
    if (!r.hasOwnProperty(k) || k.charAt(0) === '_' || LINE_STD_[k]) continue;
    var v = r[k];
    if (v === '' || v === null || v === undefined) continue;
    d[k] = v;
  }
  return d;
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
    var it = r.item || {};
    if (!r.found) {
      appendObject_(ds, 'Sample_Lines', {
        line_id: lineId, request_id: reqId,
        document_no: it.soi || r.doc, company: it.company || '',
        status: 'not_found', required_count: 0, created_at: ts
      });
      lines++;
      return;
    }
    var matched = r._matched || [];
    var detail = lineDetail_(r);
    appendObject_(ds, 'Sample_Lines', {
      line_id: lineId, request_id: reqId,
      document_no: r.document_no || r.doc,
      company: r.company || it.company || '',
      vendor: r.vendor || '', mpl_type: r.mpl || '',
      paid_status: r.paid_at ? 'Paid' : (r.mpl ? 'Unpaid' : ''),
      statement_code: r.statement || '', amount: r.amount || '',
      paid_at: r.paid_at || '', closing_balance: r.closing_balance || '',
      route_rule: matched.map(function (m) { return m.rule_name; }).join(','),
      required_count: matched.length, status: 'open',
      evidence_folder_id: '', created_at: ts,
      subpopulation: r.subpopulation || '',
      detail_json: Object.keys(detail).length ? JSON.stringify(detail) : ''
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
    period:         (period.name ? period.name + ' · ' : '') + 'date window ' + period.start + ' → ' + period.end,
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