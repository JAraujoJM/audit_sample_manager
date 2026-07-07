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
  var tz = ss.getSpreadsheetTimeZone();
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.join('') === '') continue;            // skip blank trailing lines
    var o = {};
    for (var c = 0; c < headers.length; c++) {
      var v = row[c];
      // Sheets coerces date-like cells to Date objects, which google.script.run
      // cannot return to the client (it hangs silently). Always hand back strings.
      o[String(headers[c])] = (v instanceof Date) ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ss") : v;
    }
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

/** Patch the first row whose `idCol` equals `idValue`. Returns true if found. */
function updateRowById_(ss, sheetName, idCol, idValue, patch) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf(idCol);
  if (idIdx === -1) throw new Error('No column "' + idCol + '" in ' + sheetName);
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idIdx]) === String(idValue)) {
      Object.keys(patch).forEach(function (k) {
        var c = headers.indexOf(k);
        if (c !== -1) sh.getRange(r + 1, c + 1).setValue(patch[k]);
      });
      return true;
    }
  }
  return false;
}

/** Delete the first row whose `idCol` equals `idValue`. Returns true if found. */
function deleteRowById_(ss, sheetName, idCol, idValue) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  var values = sh.getDataRange().getValues();
  var idIdx = values[0].indexOf(idCol);
  if (idIdx === -1) throw new Error('No column "' + idCol + '" in ' + sheetName);
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][idIdx]) === String(idValue)) { sh.deleteRow(r + 1); return true; }
  }
  return false;
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

/** Active audit periods for a flow, with dates normalised to yyyy-MM-dd strings. */
function getPeriods(flowId) {
  var cfg = configSs_();
  var tz = cfg.getSpreadsheetTimeZone();
  return readObjects_(cfg, 'Periods')
    .filter(function (p) { return String(p.flow_id) === String(flowId) && p.active !== false && String(p.active) !== 'FALSE'; })
    .map(function (p) { return { name: String(p.name), start: toDateStr_(p.start_date, tz), end: toDateStr_(p.end_date, tz) }; });
}

function findPeriod_(flowId, name) {
  var ps = getPeriods(flowId);
  for (var i = 0; i < ps.length; i++) if (ps[i].name === String(name)) return ps[i];
  return null;
}

/* ---------- routing engine (config-driven) ----------
 * Facts are produced by the flow module (see FlowA.js). routeLine_ matches them
 * against the flow's Routing rows — flow-agnostic. */

/** Required evidence for a line = every active Routing row whose match holds. */
function routeLine_(facts, flowId) {
  return getRouting(flowId).filter(function (r) { return conditionsMet_(String(r.match), facts); });
}

/** `match` is a ';'-separated list of key=value conditions, all of which must hold. */
function conditionsMet_(matchStr, facts) {
  if (!matchStr) return true;
  return matchStr.split(';').every(function (cond) {
    var kv = cond.split('=');
    if (kv.length !== 2) return true;
    var k = kv[0].trim().toLowerCase(), v = kv[1].trim().toLowerCase();
    return String(facts[k] === undefined ? '' : facts[k]).toLowerCase() === v;
  });
}

/* ---------- row lookups by id ---------- */
function findRequest_(id)    { return readObjects_(dataSs_(), 'Requests').filter(function (r) { return String(r.request_id) === String(id); })[0] || null; }
function findLine_(id)       { return readObjects_(dataSs_(), 'Sample_Lines').filter(function (l) { return String(l.line_id) === String(id); })[0] || null; }
function findAssignment_(id) { return readObjects_(dataSs_(), 'Assignments').filter(function (a) { return String(a.assignment_id) === String(id); })[0] || null; }

/* ---------- assignments (multi-preparer per line) ---------- */
function getAssignments(lineId) {
  return readObjects_(dataSs_(), 'Assignments').filter(function (a) { return String(a.line_id) === String(lineId); });
}

/**
 * A line advances only once EVERY required-evidence Assignment is satisfied —
 * this is the "all preparers must respond before moving forward" rule.
 */
function lineIsComplete_(lineId) {
  var items = getAssignments(lineId);
  return items.length > 0 && items.every(function (a) {
    return ['accepted', 'complete'].indexOf(String(a.status).toLowerCase()) !== -1;
  });
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
