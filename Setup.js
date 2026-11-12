/**
 * Setup — one-time, idempotent provisioning. Run from the editor by an admin.
 * ---------------------------------------------------------------------------
 * Creates (or reuses) the Config + Data spreadsheets and the Drive folder tree
 * under APP_ROOT_FOLDER_ID, seeds Flow A config, and persists every id it makes
 * into Script Properties. Safe to run repeatedly: existing objects are reused,
 * existing config rows are left untouched.
 *
 *   Audit Requests Manager/            (APP_ROOT_FOLDER_ID — shared folder)
 *   ├── DB/        Config + Data spreadsheets
 *   ├── Evidence/  {flow_id}/{request_id}/{document_no}/  (created on demand later)
 *   └── Exports/   status reports / IPE workbooks
 */
function setup() {
  var runner = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
  var root = appRootFolder_();

  // 1. folder tree
  var dbFolder = getOrCreateFolder_(root, NAME.DB_FOLDER);
  var evidence = getOrCreateFolder_(root, NAME.EVIDENCE_FOLDER);
  var exports  = getOrCreateFolder_(root, NAME.EXPORTS_FOLDER);

  // 2. spreadsheets (sets CONFIG_SS_ID / DATA_SS_ID props)
  var configSs = getOrCreateSpreadsheet_(PROP.CONFIG_SS, NAME.CONFIG_SS, dbFolder);
  var dataSs   = getOrCreateSpreadsheet_(PROP.DATA_SS,   NAME.DATA_SS,   dbFolder);

  // 3. tabs + headers
  ensureSheets_(configSs, SCHEMA.config);
  ensureSheets_(dataSs,   SCHEMA.data);

  // 4. remember the folder ids
  PropertiesService.getScriptProperties().setProperties({
    DB_FOLDER_ID:       dbFolder.getId(),
    EVIDENCE_FOLDER_ID: evidence.getId(),
    EXPORTS_FOLDER_ID:  exports.getId(),
    SETUP_AT:           nowIso_()
  });

  // 5. seed config (only fills empty sheets — never overwrites edits)
  seedConfig_(runner, { evidence: evidence.getId(), exports: exports.getId() });

  logActivity('SETUP', 'system', 'setup', 'Provisioned spreadsheets and folder tree');

  var summary = {
    runBy:          runner,
    configSheetUrl: configSs.getUrl(),
    dataSheetUrl:   dataSs.getUrl(),
    dbFolderId:     dbFolder.getId(),
    evidenceId:     evidence.getId(),
    exportsId:      exports.getId()
  };
  Logger.log('Setup complete:\n' + JSON.stringify(summary, null, 2));
  return summary;
}

/* ---------- folder / spreadsheet provisioning helpers ---------- */
function appRootFolder_() {
  var id = (typeof APP_ROOT_FOLDER_ID === 'string') ? APP_ROOT_FOLDER_ID.trim() : '';
  if (!id) {
    throw new Error('Set APP_ROOT_FOLDER_ID in Config.gs to the Drive folder id of the ' +
                    '"Audit Requests Manager" shared folder (the one containing App/), then run setup() again.');
  }
  return DriveApp.getFolderById(id);
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getOrCreateSpreadsheet_(propKey, name, folder) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(propKey);
  if (id) {
    try { return SpreadsheetApp.openById(id); }     // reuse if still reachable
    catch (e) { /* id stale — fall through and recreate */ }
  }
  var ss = SpreadsheetApp.create(name);
  DriveApp.getFileById(ss.getId()).moveTo(folder);  // create lands in My Drive; move into the DB folder
  props.setProperty(propKey, ss.getId());
  return ss;
}

function ensureSheets_(ss, schema) {
  Object.keys(schema).forEach(function (sheetName) {
    var sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    var headers = schema[sheetName];
    if (sh.getLastRow() <= 1) {
      // Empty (header-only or blank): write the canonical headers exactly. This
      // also cleans up renamed/removed columns from an earlier schema version.
      if (sh.getLastColumn() > headers.length) sh.getRange(1, 1, 1, sh.getLastColumn()).clearContent();
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // Has data: only ADD missing columns at the end (never touch existing data).
      var existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      headers.forEach(function (h) {
        if (existing.indexOf(h) === -1) sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      });
    }
    forgetTab_(sheetName);   // headers may have changed: drop this execution's copy (Db.js memo)
  });
  var def = ss.getSheetByName('Sheet1');             // drop the empty default tab
  if (def && !schema['Sheet1'] && ss.getSheets().length > 1 && def.getLastRow() === 0) {
    ss.deleteSheet(def);
  }
}

/* ---------- Flow A seed (idempotent: skips any sheet that already has rows) ---------- */
function seedConfig_(runner, folderIds) {
  var cfg = configSs_();

  if (sheetIsEmpty_(cfg, 'Users')) {
    appendObject_(cfg, 'Users', {
      email: runner, role: ROLES.ADMIN, status: 'active', added_by: runner, added_at: nowIso_()
    });
  }

  if (sheetIsEmpty_(cfg, 'Flows')) {
    appendObject_(cfg, 'Flows', {
      flow_id: 'flowA', name: 'Marketplace revenues / COGS',
      database: 'AIG_Nav_Jumia_Reconciliation', query_mode: 'full',
      sample_key: 'Transaction_No', dedup_keys: 'Posting Date|Id_Company|Document No.', active: true
    });
  }

  if (sheetIsEmpty_(cfg, 'Routing')) seedFlowARouting_(cfg);

  if (sheetIsEmpty_(cfg, 'Periods')) {
    appendObject_(cfg, 'Periods', { flow_id: 'flowA', name: 'Full year audit 2025', start_date: '2025-01-01', end_date: '2026-01-01', active: true });
    appendObject_(cfg, 'Periods', { flow_id: 'flowA', name: 'Interim audit 2025',   start_date: '2025-01-01', end_date: '2025-07-01', active: true });
  }

  if (sheetIsEmpty_(cfg, 'Settings')) {
    appendObject_(cfg, 'Settings', { key: 'evidence_folder_id',        value: folderIds.evidence, description: 'Drive folder where preparer evidence is stored' });
    appendObject_(cfg, 'Settings', { key: 'exports_folder_id',         value: folderIds.exports,  description: 'Drive folder for generated reports / IPE workbooks' });
    appendObject_(cfg, 'Settings', { key: 'reminder_due_offset_days',  value: '7',                description: 'Days after assignment a line is due (provisional)' });
    appendObject_(cfg, 'Settings', { key: 'reminder_cadence',          value: 'daily',            description: 'How often reminder emails are sent (provisional)' });
    appendObject_(cfg, 'Settings', { key: 'reminder_escalate_at',      value: 'due',              description: 'When to escalate reminders (provisional)' });
  }
}

function sheetIsEmpty_(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  return !sh || sh.getLastRow() <= 1;               // header only (or missing) = empty
}

/**
 * Canonical Flow A routing — one row per required document. The advance case is
 * split into two rows (contract + down-payment) so each can be assigned to a
 * different preparer; the engine treats every matching row as its own Assignment.
 */
function seedFlowARouting_(cfg) {
  appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'mpl_advance_contract',    match: 'mpl=advance',          required_evidence: 'Consignment contract',   responsible: ROLES.PREPARER, active: true });
  appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'mpl_advance_downpayment', match: 'mpl=advance',          required_evidence: 'Down-payment proof',     responsible: ROLES.PREPARER, active: true });
  appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'regular_paid',            match: 'mpl=regular;paid=yes', required_evidence: 'Proof of payment',       responsible: ROLES.PREPARER, active: true });
  appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'regular_unpaid',          match: 'mpl=regular;paid=no',  required_evidence: 'VC screenshot (Unpaid)', responsible: ROLES.PREPARER, active: true });
}

/**
 * Admin-run: rewrite Flow A routing to the canonical set above. OVERWRITES the
 * existing Flow A rows (other flows are preserved). Use once on a sheet seeded
 * before the advance rule was split into two documents.
 */
function reseedFlowARouting() {
  requireRole_([ROLES.ADMIN]);
  var cfg = configSs_();
  var sh = cfg.getSheetByName('Routing');
  var kept = readObjects_(cfg, 'Routing').filter(function (r) { return String(r.flow_id) !== 'flowA'; });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  kept.forEach(function (r) { appendObject_(cfg, 'Routing', r); });
  seedFlowARouting_(cfg);
  logActivity('ROUTING_RESEED', 'flow', 'flowA', 'Reseeded Flow A routing (advance split into contract + down-payment)');
  return getRouting('flowA');
}

/**
 * Admin-run: seed Flow B (Cash Anchor) config — a Flows row, quarterly Periods, and
 * placeholder Routing (one row per subpopulation → owning team). Idempotent: does
 * nothing if a flowB Flows row already exists. Run once from the editor after setup()
 * (also run setup() first so Sample_Lines gains the subpopulation/detail_json columns).
 */
function seedFlowB() {
  requireRole_([ROLES.ADMIN]);
  var cfg = configSs_();
  if (getFlows().some(function (f) { return String(f.flow_id) === 'flowB'; })) {
    Logger.log('Flow B already seeded.');
    return { seeded: false };
  }

  appendObject_(cfg, 'Flows', {
    flow_id: 'flowB', name: 'Cash Anchor',
    database: 'AIG_Nav_Jumia_Reconciliation', query_mode: '',
    sample_key: 'SampleKey', dedup_keys: 'ID_COMPANY+COD_OMS_SALES_ORDER_ITEM', active: true
  });

  // Quarterly delivered-date windows (end-exclusive). Add new quarters here as they open.
  [['Q4 2025 (Oct–Dec)', '2025-10-01', '2026-01-01'],
   ['Q3 2025 (Jul–Sep)', '2025-07-01', '2025-10-01'],
   ['H1 2025 (Jan–Jun)', '2025-01-01', '2025-07-01']].forEach(function (q) {
    appendObject_(cfg, 'Periods', { flow_id: 'flowB', name: q[0], start_date: q[1], end_date: q[2], active: true });
  });

  seedFlowBRouting_(cfg);
  logActivity('FLOW_SEED', 'flow', 'flowB', 'Seeded Cash Anchor (Flows + Periods + placeholder Routing)');
  return { seeded: true };
}

/**
 * Cash Anchor routing — required (and a few optional) evidence per subpopulation, each
 * tagged with the owning team. `responsible` is a team label (not an email), so each
 * line is left unassigned for the admin to route to a specific person at assign time.
 * Cash & POS carries one proof of payment PER PAYMENT on the transaction list — the
 * engine fans that single rule over the line's payment units.
 */
function seedFlowBRouting_(cfg) {
  var JP = 'JumiaPay & Banks accounting', FO = 'Shared FinOps';
  // One row = one task. `documents` lists the upload slots inside that task
  // ('|'-separated; a trailing '*' marks a slot optional). Empty = a single-document
  // task (Cash & POS fans this over each payment).
  function row(rule, sub, taskLabel, resp, documents) {
    appendObject_(cfg, 'Routing', { flow_id: 'flowB', rule_name: rule, match: 'subpopulation=' + sub,
      required_evidence: taskLabel, documents: documents || '', responsible: resp, optional: '', active: true });
  }

  // Voucher — one task: prove the voucher (BOB) + tie it to the item (OMS); B2B proof if applicable.
  row('voucher', 'Prepaid - Voucher', 'BOB + OMS screenshot', FO,
      'BOB voucher screenshot|OMS screenshot|B2B proof of payment*');

  // JumiaPay family — one task: settlement report + proof of payment (ties to settlement
  // total) + optional document tie-out (NAV → settlement → proof).
  ['Prepaid - JumiaPay', 'Postpaid - JumiaPay on delivery', 'Postpaid - Cash - 3PL via JPay'].forEach(function (sub, i) {
    row(['pre_jpay', 'post_jpay', 'cash_3pl'][i], sub, 'Settlement report + proof of payment', JP,
        'Settlement report|Proof of payment|Document tie-out*');
  });

  // Cash & POS — one proof of payment PER payment on the transaction list (fanned by units).
  row('cash_pos_pop', 'Postpaid - Cash & POS', 'Proof of payment', FO, '');

  // Residual.
  row('prepaid_other', 'Prepaid - Other methods', 'Payment evidence', FO, '');
}

/* ==================== Flow C — Marketplace revenues / COGS by sales-order item ==================== */
/**
 * Admin-run: seed Flow C — a Flows row, half-year Periods and its Routing. Idempotent
 * (does nothing if a flowC Flows row exists). Run once from the editor AFTER setup()
 * (which adds the Requests.stages_json column). Existing requests are untouched.
 */
function seedFlowC() {
  requireRole_([ROLES.ADMIN]);
  var cfg = configSs_();
  if (getFlows().some(function (f) { return String(f.flow_id) === 'flowC'; })) {
    Logger.log('Flow C already seeded.');
    return { seeded: false };
  }
  appendObject_(cfg, 'Flows', {
    flow_id: 'flowC', name: 'Marketplace revenues / COGS (by sales-order item)',
    database: 'AIG_Nav_Jumia_Reconciliation', query_mode: '',
    sample_key: 'SampleKey', dedup_keys: 'ID_COMPANY+COD_OMS_SALES_ORDER_ITEM', active: true
  });
  // Delivered-date windows (end-exclusive). NAV / statement queries widen them on their own.
  [['H1 2026 (Jan–Jun)', '2026-01-01', '2026-07-01'],
   ['H2 2026 (Jul–Dec)', '2026-07-01', '2027-01-01'],
   ['FY 2026',           '2026-01-01', '2027-01-01']].forEach(function (q) {
    appendObject_(cfg, 'Periods', { flow_id: 'flowC', name: q[0], start_date: q[1], end_date: q[2], active: true });
  });
  seedFlowCRouting_(cfg);
  logActivity('FLOW_SEED', 'flow', 'flowC', 'Seeded Flow C (Flows + Periods + Routing)');
  return { seeded: true };
}

/**
 * Flow C routing. `responsible` = the Reviewer ROLE marks a SYSTEM task: the app produces
 * the evidence (the reconciliation workbook), assigns the task to the request's reviewer
 * and auto-submits it. The marketplace items additionally get Flow A's preparer tasks,
 * decided by the facts the RING stage sets (mpl = advance|regular, paid = yes|no).
 */
function seedFlowCRouting_(cfg) {
  function row(rule, match, evidence, resp) {
    appendObject_(cfg, 'Routing', { flow_id: 'flowC', rule_name: rule, match: match, required_evidence: evidence,
      documents: '', responsible: resp, optional: '', active: true });
  }
  row('recon_retail',            'population=retail',                            'Reconciliation (system)', ROLES.REVIEWER);
  row('recon_mpl',               'population=marketplace',                       'Reconciliation (system)', ROLES.REVIEWER);
  row('mpl_advance_contract',    'population=marketplace;mpl=advance',           'Consignment contract',    ROLES.PREPARER);
  row('mpl_advance_downpayment', 'population=marketplace;mpl=advance',           'Down-payment proof',      ROLES.PREPARER);
  row('regular_paid',            'population=marketplace;mpl=regular;paid=yes',  'Proof of payment',        ROLES.PREPARER);
  row('regular_unpaid',          'population=marketplace;mpl=regular;paid=no',   'VC screenshot (Unpaid)',  ROLES.PREPARER);
}

/** Admin-run: rewrite Flow C routing to the set above (other flows preserved). */
function reseedFlowCRouting() {
  requireRole_([ROLES.ADMIN]);
  var cfg = configSs_();
  var sh = cfg.getSheetByName('Routing');
  var kept = readObjects_(cfg, 'Routing').filter(function (r) { return String(r.flow_id) !== 'flowC'; });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  kept.forEach(function (r) { appendObject_(cfg, 'Routing', r); });
  seedFlowCRouting_(cfg);
  logActivity('ROUTING_RESEED', 'flow', 'flowC', 'Reseeded Flow C routing');
  return getRouting('flowC');
}

/**
 * Admin-run: rewrite Cash Anchor routing to the set above. OVERWRITES the existing
 * flowB rows (other flows preserved). Run once after updating the evidence rules (and
 * after setup(), which adds the new Routing/Assignments columns).
 */
function reseedFlowBRouting() {
  requireRole_([ROLES.ADMIN]);
  var cfg = configSs_();
  var sh = cfg.getSheetByName('Routing');
  var kept = readObjects_(cfg, 'Routing').filter(function (r) { return String(r.flow_id) !== 'flowB'; });
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  kept.forEach(function (r) { appendObject_(cfg, 'Routing', r); });
  seedFlowBRouting_(cfg);
  logActivity('ROUTING_RESEED', 'flow', 'flowB', 'Reseeded Cash Anchor routing (real evidence per subpopulation)');
  return getRouting('flowB');
}

/**
 * Admin-run, one-off DATA REPAIR: recompute the `amount` of a Cash Anchor request's samples
 * from the request's own stored query-1 extraction, using the CURRENT FlowB.mapRow (the
 * amount rule for the JumiaPay subpopulations was corrected on 2026-09-14 — see
 * flowBLineAmount_). Touches ONLY Sample_Lines.amount of the listed subpopulations; statuses,
 * tasks, evidence and every other column are untouched. Idempotent — a second run updates 0.
 * Every change is written to the Activity_Log (AMOUNT_FIX), so it shows in Sample history.
 *   The editor's Run button cannot pass arguments — run the wrapper below, or call this one
 *   with the id from another function. The result is written to the execution log.
 */
function repairFlowBAmounts_REQ_b16a4636() { return fixFlowBAmounts('REQ_b16a4636'); }

function fixFlowBAmounts(requestId, subpopulations) {
  requireRole_([ROLES.ADMIN]);
  if (!requestId) throw new Error('fixFlowBAmounts needs a request id — the editor\'s Run button passes none. Run repairFlowBAmounts_REQ_b16a4636() (or add a similar one-line wrapper for another request).');
  var req = findRequest_(requestId);
  if (!req) throw new Error('Request not found: ' + requestId);
  if (String(req.flow_id) !== 'flowB') throw new Error('Not a Cash Anchor request (flow ' + req.flow_id + ').');
  if (!req.csv_file_id) throw new Error('This request has no stored extraction (csv_file_id) to recompute from.');
  var subs = subpopulations || ['Prepaid - JumiaPay', 'Postpaid - JumiaPay on delivery'];
  var ds = dataSs_();
  var lines = readObjects_(ds, 'Sample_Lines').filter(function (l) {
    return String(l.request_id) === String(requestId) && subs.indexOf(String(l.subpopulation || '')) !== -1;
  });
  if (!lines.length) return { requestId: requestId, updated: 0, unchanged: 0, notFound: 0, changes: [], note: 'No samples in ' + subs.join(' / ') };

  var csv = parseCsv_(DriveApp.getFileById(req.csv_file_id));
  var mod = flowModule_('flowB');
  var items = lines.map(function (l) {
    return { key: (String(l.company || '') + String(l.document_no || '')).toUpperCase(), company: l.company, soi: l.document_no, line: l };
  });
  var mapped = mapStage1Rows_(mod, csv, items);

  // Replay query 2 exactly as enrich() does (buildResults_): the JumiaPay amount comes from it.
  var byRef = null, cell2 = null;
  if (req.csv2_file_id && mod.stage2) {
    var csv2 = parseCsv_(DriveApp.getFileById(req.csv2_file_id));
    if (csv2 && csv2.length > 1) {
      var idx2 = {}; csv2[0].forEach(function (h, i) { idx2[String(h).trim()] = i; });
      cell2 = function (row) { return function (name) { return idx2[name] === undefined ? '' : row[idx2[name]]; }; };
      byRef = {};
      for (var r = 1; r < csv2.length; r++) {
        var row2 = csv2[r]; if (!row2 || !row2.length) continue;
        var k2 = String(cell2(row2)(mod.stage2.keyCol)).toUpperCase();
        if (k2 && !byRef[k2]) byRef[k2] = row2;
      }
    }
  }

  var updated = 0, unchanged = 0, notFound = 0, changes = [];
  var norm = function (v) { return (v === null || v === undefined) ? '' : String(v).trim(); };
  mapped.forEach(function (mr) {
    var l = mr.item.line;
    if (!mr.found) { notFound++; return; }
    if (byRef) {
      var ref = mod.stage2.refOf(mr.mapped);
      if (ref) { var r2 = byRef[String(ref).toUpperCase()]; if (r2) mod.stage2.merge(mr.mapped, mod.stage2.mapRow2(cell2(r2))); }
    }
    var next = norm(mr.mapped.amount), prev = norm(l.amount);
    if (next === prev) { unchanged++; return; }
    updateRowById_(ds, 'Sample_Lines', 'line_id', l.line_id, { amount: next });
    logActivity('AMOUNT_FIX', 'line', l.line_id, l.subpopulation + ': amount ' + (prev || '(empty)') + ' → ' + (next || '(empty)') + ' — recomputed from the stored extraction');
    changes.push({ line_id: l.line_id, document_no: l.document_no, subpopulation: l.subpopulation, from: prev, to: next });
    updated++;
  });
  logActivity('AMOUNT_FIX', 'request', requestId, updated + ' sample amount(s) corrected, ' + unchanged + ' already right, ' + notFound + ' not found in the extraction');
  var result = { requestId: requestId, updated: updated, unchanged: unchanged, notFound: notFound, changes: changes };
  Logger.log(JSON.stringify(result, null, 2));   // the editor shows logs, not return values
  return result;
}

/**
 * The stored-file slots of a Requests row (stage 1, stage 2, every stages_json query; CSV + SOX xlsx
 * each) with what is needed to find and verify the gateway original. `stg` = the parsed stages_json,
 * so a repair can write a relinked id back into it.
 */
function requestFileSlots_(req, stg) {
  var ipe = parseJson_(req.ipe_json);
  var hashes = {}; (ipe.stages || []).forEach(function (s) { hashes[s.tag] = s; });
  var g1 = ipe.requestId || gatewayIdFromName_(ipe.csvName), g2 = gatewayIdFromName_(ipe.csv2Name);
  var slots = [
    { slot: 'query1 csv',  col: 'csv_file_id',   id: req.csv_file_id,   gatewayId: g1, rx: /\.csv$/i,  sha: ipe.csvSha256 || '' },
    { slot: 'query1 xlsx', col: 'xlsx_file_id',  id: req.xlsx_file_id,  gatewayId: g1, rx: /\.xlsx$/i, sha: '' },
    { slot: 'query2 csv',  col: 'csv2_file_id',  id: req.csv2_file_id,  gatewayId: g2, rx: /\.csv$/i,  sha: ipe.csv2Sha256 || '' },
    { slot: 'query2 xlsx', col: 'xlsx2_file_id', id: req.xlsx2_file_id, gatewayId: g2, rx: /\.xlsx$/i, sha: '' }
  ];
  stg.forEach(function (s, i) {
    var g = s.gatewayId || gatewayIdFromName_(s.csvName), h = hashes[s.tag] || {};
    slots.push({ slot: s.tag + ' csv',  stage: i, key: 'csvId',  id: s.csvId,  gatewayId: g, rx: /\.csv$/i,  sha: h.csvSha256 || '' });
    slots.push({ slot: s.tag + ' xlsx', stage: i, key: 'xlsxId', id: s.xlsxId, gatewayId: g, rx: /\.xlsx$/i, sha: '' });
  });
  return slots.filter(function (s) { return s.id || s.gatewayId; });
}

/**
 * Admin-run DATA REPAIR: re-store a request's extraction files whose stored copy in Exports/{reqId}/
 * is gone (REQ_b16a4636: the Oct 2026 export shipped an empty Extraction/). Each dead slot is
 * re-copied from the gateway ORIGINAL in Responses/ under its gateway name (as storeRequestFiles_
 * does) and the Requests row is re-pointed. A CSV is relinked ONLY when its SHA-256 equals the
 * hash recorded at extraction — never on a mismatch. Live slots are untouched. Idempotent.
 * Returns [{ slot, oldId, status: ok|relinked|not_found|hash_mismatch, newId, name }].
 */
function repairFiles_REQ_b16a4636() { return repairRequestFiles('REQ_b16a4636'); }

function repairRequestFiles(requestId) {
  requireRole_([ROLES.ADMIN]);
  if (!requestId) throw new Error('repairRequestFiles needs a request id — run repairFiles_REQ_b16a4636() (or add a similar one-line wrapper).');
  var req = findRequest_(requestId);
  if (!req) throw new Error('Request not found: ' + requestId);
  var exportsId = PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS);
  if (!exportsId) throw new Error('Exports folder not provisioned — run setup().');
  var folder = getOrCreateFolder_(DriveApp.getFolderById(exportsId), requestId);
  var stg = parseJson_(req.stages_json); if (!Array.isArray(stg)) stg = [];
  var patch = {}, stagesChanged = false, report = [];
  requestFileSlots_(req, stg).forEach(function (s) {
    var r = { slot: s.slot, oldId: String(s.id || ''), status: 'ok', newId: '', name: '' };
    var live = liveFile_(s.id);
    if (live) { r.name = live.getName(); report.push(r); return; }
    var v = verifiedOriginal_(s.gatewayId, s.rx, s.sha);
    if (!v.file) { r.status = v.status; r.name = v.note; report.push(r); return; }
    var cp = v.file.makeCopy(v.file.getName(), folder);   // makeCopy keeps the bytes = the logged hash
    r.status = 'relinked'; r.newId = cp.getId(); r.name = cp.getName() + (v.note ? ' (' + v.note + ')' : '');
    if (s.col) patch[s.col] = r.newId; else { stg[s.stage][s.key] = r.newId; stagesChanged = true; }
    report.push(r);
  });
  if (stagesChanged) patch.stages_json = JSON.stringify(stg);
  if (Object.keys(patch).length) updateRowById_(dataSs_(), 'Requests', 'request_id', requestId, patch);
  logActivity('REPAIR_FILES', 'request', requestId, report.map(function (r) {
    return r.slot + ': ' + r.status + (r.status === 'relinked' ? ' ' + r.oldId + ' → ' + r.newId + ' (' + r.name + ')' : (r.status === 'ok' ? '' : ' — ' + r.name));
  }).join('; '));
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Admin, READ-ONLY: every request's stored extraction files — which ids are dead, and whether a
 * hash-matching gateway original exists in Responses/ (then repairRequestFiles(id) fixes it).
 * Returns [{ request_id, request_ref, flow_id, slots, dead: [{ slot, id, status, note }] }].
 */
function auditRequestFileLinks() {
  requireRole_([ROLES.ADMIN]);
  var out = readObjects_(dataSs_(), 'Requests').map(function (req) {
    var stg = parseJson_(req.stages_json); if (!Array.isArray(stg)) stg = [];
    var slots = requestFileSlots_(req, stg), dead = [];
    slots.forEach(function (s) {
      if (liveFile_(s.id)) return;
      var v = verifiedOriginal_(s.gatewayId, s.rx, s.sha);
      dead.push({ slot: s.slot, id: String(s.id || ''), status: v.file ? 'repairable' : v.status, note: v.note });
    });
    return { request_id: req.request_id, request_ref: req.request_ref || '', flow_id: req.flow_id, slots: slots.length, dead: dead };
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
