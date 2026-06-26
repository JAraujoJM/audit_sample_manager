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
    var firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (firstRow.join('') === '') {                 // only write headers if row 1 is blank
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
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
      fy_start: '2025-01-01', fy_end: '2026-01-01',
      sample_key: 'Transaction_No', dedup_keys: 'Posting Date|Id_Company|Document No.', active: true
    });
  }

  if (sheetIsEmpty_(cfg, 'Routing')) {
    appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'mpl_advance',    match: 'mpl=advance',         required_evidence: 'Consignment contract + down-payment proof', responsible: ROLES.PREPARER, active: true });
    appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'regular_paid',   match: 'mpl=regular;paid=yes', required_evidence: 'Proof of payment',                          responsible: ROLES.PREPARER, active: true });
    appendObject_(cfg, 'Routing', { flow_id: 'flowA', rule_name: 'regular_unpaid', match: 'mpl=regular;paid=no',  required_evidence: 'VC screenshot (Unpaid)',                     responsible: ROLES.PREPARER, active: true });
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
