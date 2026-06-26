/**
 * Db — the data-access layer over the Config + Data spreadsheets.
 * ---------------------------------------------------------------
 * Generic primitives (open / read objects / append object) plus typed domain
 * helpers. Nothing here writes to the sheets except appendObject_ and the few
 * helpers built on it, so the read path can never mutate state.
 */

/* ---------- open the provisioned spreadsheets ---------- */
function configSs_() { return openSsByProp_(PROP.CONFIG_SS, 'Config'); }
function dataSs_()   { return openSsByProp_(PROP.DATA_SS,   'Data'); }

function openSsByProp_(key, label) {
  var id = PropertiesService.getScriptProperties().getProperty(key);
  if (!id) throw new Error('The ' + label + ' spreadsheet is not provisioned yet — run setup() first.');
  return SpreadsheetApp.openById(id);
}

/* ---------- generic row <-> object mapping ---------- */
function readObjects_(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;            // skip blank trailing lines
    var o = {};
    for (var c = 0; c < headers.length; c++) o[String(headers[c])] = row[c];
    out.push(o);
  }
  return out;
}

function appendObject_(ss, sheetName, obj) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
  sh.appendRow(row);
  return row;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/* ---------- config: users / flows / routing / settings ---------- */
function getUsers() { return readObjects_(configSs_(), 'Users'); }

function getRole(email) {
  if (!email) return null;
  var target = String(email).toLowerCase();
  var users = getUsers();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].email).toLowerCase() === target &&
        String(users[i].status).toLowerCase() === 'active') {
      return users[i].role;
    }
  }
  return null;
}

function getFlows() { return readObjects_(configSs_(), 'Flows'); }

function getFlow(flowId) {
  var hits = getFlows().filter(function (f) { return String(f.flow_id) === String(flowId); });
  return hits.length ? hits[0] : null;
}

function getRouting(flowId) {
  return readObjects_(configSs_(), 'Routing').filter(function (r) {
    return String(r.flow_id) === String(flowId) && r.active !== false && String(r.active) !== 'FALSE';
  });
}

function getSetting(key) {
  var hit = readObjects_(configSs_(), 'Settings').filter(function (s) { return String(s.key) === String(key); });
  return hit.length ? hit[0].value : null;
}

/* ---------- admin: register a user (idempotent upsert) ---------- */
function addUser(email, role) {
  requireRole_([ROLES.ADMIN]);
  if (!email || !/@jumia\.com$/i.test(String(email))) throw new Error('Email must be a @jumia.com address.');
  var valid = [ROLES.ADMIN, ROLES.PREPARER, ROLES.REVIEWER, ROLES.AUDITOR];
  if (valid.indexOf(role) === -1) throw new Error('Invalid role: ' + role + ' (expected one of ' + valid.join(', ') + ').');

  var cfg = configSs_();
  var sh = cfg.getSheetByName('Users');
  var users = readObjects_(cfg, 'Users');
  var roleCol = SCHEMA.config.Users.indexOf('role') + 1;
  var statusCol = SCHEMA.config.Users.indexOf('status') + 1;

  for (var i = 0; i < users.length; i++) {
    if (String(users[i].email).toLowerCase() === String(email).toLowerCase()) {
      var rowNum = i + 2;                          // +1 header, +1 to 1-based
      sh.getRange(rowNum, roleCol).setValue(role);
      sh.getRange(rowNum, statusCol).setValue('active');
      logActivity('USER_UPSERT', 'user', email, 'role=' + role + ' (updated)');
      return getRole(email);
    }
  }
  appendObject_(cfg, 'Users', {
    email: email, role: role, status: 'active',
    added_by: Session.getActiveUser().getEmail() || 'system', added_at: nowIso_()
  });
  logActivity('USER_UPSERT', 'user', email, 'role=' + role + ' (added)');
  return getRole(email);
}

/* ---------- audit trail ---------- */
function logActivity(action, entityType, entityId, details) {
  try {
    appendObject_(dataSs_(), 'Activity_Log', {
      ts: nowIso_(),
      actor: Session.getActiveUser().getEmail() || 'system',
      action: action,
      entity_type: entityType || '',
      entity_id: entityId || '',
      details: details || ''
    });
  } catch (e) {
    Logger.log('logActivity failed (non-fatal): ' + e);   // never let logging break the action
  }
}
