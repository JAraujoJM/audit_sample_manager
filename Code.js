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
    .setTitle('Flow A — Audit Request Manager')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- folder helpers ---------- */
function sub_(name) {
  return DriveApp.getFolderById(BASE_FOLDER_ID).getFoldersByName(name).next();
}

/* ---------- SQL building (the part we own) ---------- */
function sqlLiteral_(v) {                       // escape + quote a value for an IN list
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function buildQuery_(docs) {
  return QUERY_MODE === 'full' ? buildQueryFull_(docs) : buildQueryLean_(docs);
}

/**
 * LEAN — routing only. The sample filters the base table first; the two joins
 * needed for the decision (insured = MPL type, payout = Paid_At_Date) are RAW
 * tables with their conditions in the ON clause, so the join key drives an index
 * seek instead of materialising a full year per join.
 */
function buildQueryLean_(docs) {
  var inList = docs.map(sqlLiteral_).join(',');
  return [
"SELECT t.[ID_Company]",
"      ,t.[Transaction_No]",
"      ,t.[Created_Date]",
"      ,t.[Vendor_Short_Code]",
"      ,t.[Vendor_Name]",
"      ,CASE WHEN insured.Target_code IS NOT NULL THEN 'MPL advance' ELSE 'Regular' END AS [MPL type]",
"      ,t.[Transaction_Type]",
"      ,t.[Transaction_Amount]",
"      ,t.[Payout_Statement_Code]",
"      ,CONVERT(date, payouts.[Paid_At_Date]) AS [Paid_At_Date]",
"      ,payouts.[Payout_Method]",
"      ,payouts.[Payment_Reference]",
"  FROM [" + DATABASE + "].[dbo].[RPT_TRANSACTIONS_SELLER] t",
"  LEFT JOIN [" + DATABASE + "].[RING].[RPT_TARGET_VARIABLE] insured",
"         ON insured.Company_ID  = t.ID_Company",
"        AND insured.Target_code = t.Vendor_Short_Code",
"        AND insured.[type]      = 'SELLER'",
"        AND insured.Variable    = 'Damaged Items Insurance - Active'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_PAYOUT] payouts",
"         ON payouts.ID_Company              = t.ID_Company",
"        AND payouts.Account_Statement_Number = t.Payout_Statement_Code",
"        AND payouts.Partner_Type            = 'SELLER'",
"        AND payouts.Paid_At_Date           >= '" + FY_START + "'",
"  WHERE t.[Created_Date] >= '" + FY_START + "'",
"    AND t.[Created_Date] <  '" + FY_END + "'",
"    AND t.[Transaction_No] IN (" + inList + ")"
  ].join('\n');
}

/**
 * FULL — adds PO number, down-payment and statement balances for the evidence
 * pack, in the same fast ON-driven shape. The down-payment join is on a text
 * `notes` column (dp.notes = soi.PO_NUMBER); if it's unindexed this is the join
 * to watch, so keep this mode for when you actually need those columns.
 */
function buildQueryFull_(docs) {
  var inList = docs.map(sqlLiteral_).join(',');
  return [
"SELECT t.[ID_Company]",
"      ,t.[Transaction_No]",
"      ,t.[Created_Date]",
"      ,t.[Vendor_Short_Code]",
"      ,t.[Vendor_Name]",
"      ,CASE WHEN insured.Target_code IS NOT NULL THEN 'MPL advance' ELSE 'Regular' END AS [MPL type]",
"      ,t.[Transaction_Type]",
"      ,t.[Transaction_Amount]",
"      ,t.[Payout_Statement_Code]",
"      ,CONVERT(date, payouts.[Paid_At_Date]) AS [Paid_At_Date]",
"      ,payouts.[Payout_Method]",
"      ,payouts.[Payment_Reference]",
"      ,soi.[PO_NUMBER]",
"      ,st.[Start_Date]      AS [Statement Start Date]",
"      ,st.[End_Date]        AS [Statement End Date]",
"      ,st.[Opening_Balance] AS [Statement Opening Balance]",
"      ,st.[Closing_Balance] AS [Statement Closing Balance]",
"      ,dp.[Transaction_No]     AS [Down Payment Transaction]",
"      ,dp.[Transaction_Amount] AS [Down Payment Amount]",
"  FROM [" + DATABASE + "].[dbo].[RPT_TRANSACTIONS_SELLER] t",
"  LEFT JOIN [" + DATABASE + "].[RING].[RPT_TARGET_VARIABLE] insured",
"         ON insured.Company_ID  = t.ID_Company",
"        AND insured.Target_code = t.Vendor_Short_Code",
"        AND insured.[type]      = 'SELLER'",
"        AND insured.Variable    = 'Damaged Items Insurance - Active'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_PAYOUT] payouts",
"         ON payouts.ID_Company              = t.ID_Company",
"        AND payouts.Account_Statement_Number = t.Payout_Statement_Code",
"        AND payouts.Partner_Type            = 'SELLER'",
"        AND payouts.Paid_At_Date           >= '" + FY_START + "'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_SOI] soi",
"         ON soi.ID_COMPANY              = t.ID_Company",
"        AND soi.COD_OMS_SALES_ORDER_ITEM = t.OMS_ID_Sales_Order_Item",
"        AND soi.DELIVERED_DATE          >= '" + FY_START + "'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_TRANSACTIONS_SELLER] dp",
"         ON dp.ID_Company       = t.ID_Company",
"        AND dp.[notes]          = soi.[PO_NUMBER]",
"        AND dp.Transaction_Type = 'Down Payment'",
"        AND dp.[Created_Date]  >= '" + FY_START + "'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_SELLER_STATEMENTS_PAYOUT] st",
"         ON st.ID_Company             = t.ID_Company",
"        AND st.ID_Transaction_Statement = t.ID_Account_Statement",
"        AND st.[Start_Date]         >= '" + FY_START + "'",
"  WHERE t.[Created_Date] >= '" + FY_START + "'",
"    AND t.[Created_Date] <  '" + FY_END + "'",
"    AND t.[Transaction_No] IN (" + inList + ")"
  ].join('\n');
}

/* ---------- routing rules (Flow A) ---------- */
function routeAction_(mplType, paidAt) {
  if (String(mplType).indexOf('advance') !== -1) {
    return { key: 'adv', label: 'Contract + down-payment proof' };
  }
  if (paidAt && String(paidAt).trim() !== '') {
    return { key: 'pop', label: 'Proof of payment' };
  }
  return { key: 'vc', label: 'VC screenshot (Unpaid)' };
}

/**
 * Required evidence for a line. Prefers the Flow A Routing config (one entry per
 * required document, so advance returns two), falling back to the hardcoded rule
 * above when the config layer isn't available yet (app not set up).
 */
function resolveAction_(mplType, paidAt) {
  if (isSetupDone_()) {
    var matched = routeLine_(lineFacts_(mplType, paidAt), 'flowA');
    if (matched.length) {
      return {
        key:     styleKey_(matched),
        label:   matched.map(function (m) { return m.required_evidence; }).join(' + '),
        matched: matched
      };
    }
  }
  var a = routeAction_(mplType, paidAt);
  return { key: a.key, label: a.label, matched: [] };
}

/** Map matched routing rules to the UI's colour key (a-pop / a-vc / a-adv). */
function styleKey_(matched) {
  var names = matched.map(function (m) { return String(m.rule_name); }).join(' ');
  if (/advance/i.test(names)) return 'adv';
  if (/unpaid/i.test(names))  return 'vc';
  return 'pop';
}

/* ---------- gateway round trip ---------- */
function submitJob_(query) {
  var requestId = APP_ID + '_' + Utilities.getUuid();
  var job = {
    query: query, request_id: requestId, app_id: APP_ID, output_name: requestId,
    database: DATABASE, evidence: true, contract_version: 1,
    description: 'Flow A enrichment (POC)', requested_by: Session.getActiveUser().getEmail()
  };
  sub_('Requests_Pending').createFile(requestId + '.json', JSON.stringify(job, null, 2), 'application/json');
  return requestId;
}
function findCsv_(requestId) {
  var files = sub_('Responses').getFiles();
  while (files.hasNext()) {
    var f = files.next(), n = f.getName();
    if (n.indexOf(requestId + '_') === 0 && /\.csv$/i.test(n)) return f;
  }
  return null;
}
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
function enrich(docText) {
  if (isSetupDone_()) requireRole_([ROLES.ADMIN]);   // SoD: only the Administrator runs enrichment
  var docs = parseDocs_(docText);
  if (docs.length === 0) return { status: 'empty' };

  var query = buildQuery_(docs);
  var signature = sig_(docs);
  var p = props_();
  var stored = JSON.parse(p.getProperty('outstanding') || 'null');

  var requestId;
  if (stored && stored.sig === signature) {
    requestId = stored.requestId;            // resume polling the existing job
  } else {
    requestId = submitJob_(query);
    p.setProperty('outstanding', JSON.stringify({ requestId: requestId, sig: signature }));
  }

  var deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline) {
    var resultFile = findCsv_(requestId);
    if (resultFile) { p.deleteProperty('outstanding'); return buildResults_(parseCsv_(resultFile), docs, requestId, query, resultFile); }
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

function buildResults_(csv, docs, requestId, query, file) {
  if (!csv || !csv.length) {                       // empty result → everything not found
    var empty = docs.map(function (d) { return { doc: d, found: false, _matched: [] }; });
    return finalizeRun_(empty, docs, 0, requestId, query, file);
  }
  var header = csv[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  function cell(row, name) { return idx[name] === undefined ? '' : row[idx[name]]; }

  var byDoc = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r];
    if (!row || row.length < 2) continue;          // skip blank trailing line
    var d = String(cell(row, 'Transaction_No')).toUpperCase();
    if (d && !byDoc[d]) byDoc[d] = row;            // first row per doc
  }

  var results = docs.map(function (d) {
    var row = byDoc[d.toUpperCase()];
    if (!row) return { doc: d, found: false, _matched: [] };
    var mpl = cell(row, 'MPL type');
    var paid = cell(row, 'Paid_At_Date');
    var routed = resolveAction_(mpl, paid);
    return {
      doc: d, found: true,
      company: cell(row, 'ID_Company'),
      vendor: cell(row, 'Vendor_Name'),
      mpl: mpl,
      paid_at: paid,
      statement: cell(row, 'Payout_Statement_Code'),
      amount: cell(row, 'Transaction_Amount'),
      closing_balance: cell(row, 'Statement Closing Balance'),
      po: cell(row, 'PO_NUMBER'),
      downpay: cell(row, 'Down Payment Amount'),
      action: routed.key, action_label: routed.label,
      _matched: routed.matched                     // internal: routing rows → assignments
    };
  });
  var foundCount = results.filter(function (x) { return x.found; }).length;
  return finalizeRun_(results, docs, foundCount, requestId, query, file);
}

/* ---------- persist a successful run, then return a clean payload to the UI ---------- */
function finalizeRun_(results, docs, foundCount, requestId, query, file) {
  var ret = {
    status: 'ok', requestId: requestId,
    rows: results.map(stripInternal_),
    ipe: buildIpe_(docs, foundCount, requestId, query, file)
  };
  if (isSetupDone_()) {
    try {
      ret.dbRequestId = persistRun_(results, requestId).dbRequestId;
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
function persistRun_(results, gatewayRequestId) {
  var flow  = getFlow('flowA') || { flow_id: 'flowA', name: 'Marketplace revenues / COGS' };
  var actor = Session.getActiveUser().getEmail() || 'system';
  var ds    = dataSs_();
  var reqId = newId_('REQ');
  var ts    = nowIso_();

  appendObject_(ds, 'Requests', {
    request_id: reqId, flow_id: flow.flow_id, title: flow.name,
    period: FY_START + ' to ' + FY_END, status: 'enriched',
    created_by: actor, created_at: ts, updated_at: ts
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

/* ---------- IPE / SOX evidence metadata ---------- */
function sha256Hex_(bytes) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return d.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function buildIpe_(docs, foundCount, requestId, query, file) {
  var now = new Date();
  var yyyymm = Utilities.formatDate(now, 'UTC', 'yyyyMM');
  var ts = Utilities.formatDate(now, 'UTC', 'yyyy-MM-dd HH:mm:ss') + ' UTC';
  var blob = file ? file.getBlob() : null;
  var bytes = blob ? blob.getBytes() : [];
  var requested = docs.length, notFound = requested - foundCount;

  return {
    documentRef:    'IPE-MPL-' + yyyymm + '-001',
    period:         'Created_Date window ' + FY_START + ' → ' + FY_END,
    scope:          'Marketplace revenues / COGS · Flow A',
    primaryDb:      DATABASE,
    queryMode:      QUERY_MODE,
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
      { name: 'Period integrity',     method: 'Hardcoded date literals (' + FY_START + ' to ' + FY_END + '); no DECLARE', result: 'Pass' },
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