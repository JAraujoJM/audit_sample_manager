/**
 * Db — the data-access layer over the Config + Data spreadsheets.
 * ---------------------------------------------------------------
 * Generic primitives (open / read objects / append object) plus typed domain
 * helpers. Nothing here writes to the sheets except appendObject_ and the few
 * helpers built on it, so the read path can never mutate state.
 */

/* ---------- open the provisioned spreadsheets ---------- */
// Opened at most once per execution (openById was ~1 s of every call before 20 Oct 2026).
var __ssOpen_ = {};
function configSs_() { return openSsByProp_(PROP.CONFIG_SS, 'Config'); }
function dataSs_()   { return openSsByProp_(PROP.DATA_SS,   'Data'); }

function openSsByProp_(key, label) {
  var id = scriptProp_(key);
  if (!id) throw new Error('The ' + label + ' spreadsheet is not provisioned yet — run setup() first.');
  if (!__ssOpen_[id]) __ssOpen_[id] = SpreadsheetApp.openById(id);
  return __ssOpen_[id];
}

/* ---------- execution-local memo of FRESH sheet reads (actions, 21 Oct 2026) ----------
 * An action used to re-read the same Data tab 8-11 times (findAssignment_, the rollup,
 * recomputeRequestStatus_, every updateRowById_), ~1 s each: auditorCloseTask took 12 s.
 * Now each Data tab is read from the SHEET at most once per execution while nothing has
 * changed it. This is not the CacheService copy (Cache.js): it is this execution's own
 * read of the sheet, so actions still decide on the sheet.
 *  - A decision read (readObjects_) reuses the memo only while it is FRESH: nothing written
 *    to that tab since, and at most MEMO_FRESH_MS_ old. After a write the next read goes
 *    back to the sheet — the rollup always sees the task it just changed, plus anything a
 *    concurrent execution wrote meanwhile (two auditors closing sibling tasks at once).
 *  - updateRowById_ only needs the ROW NUMBER of an id. Rows of Requests / Sample_Lines /
 *    Assignments are never deleted by the app and appends never shift rows, so a memo up to
 *    MEMO_ROWS_MS_ old, written to or not, locates the row; an id it lacks falls back to a
 *    fresh read. deleteRowById_ (shifts rows) always reads the sheet and drops the memo.
 * Data spreadsheet only (Config has its own 5-minute cache and direct clear/rewrite paths).
 * A new write path to a Data tab that bypasses appendObject_/updateRowById_/deleteRowById_
 * must call forgetTab_(tab), as well as noteTabWrite_(tab). */
var __tabMemo_ = {};
var MEMO_FRESH_MS_ = 5000;
var MEMO_ROWS_MS_  = 30000;

function isDataSs_(ss) {
  var id = scriptProp_(PROP.DATA_SS);
  return !!id && __ssOpen_[id] === ss;
}
/** Raw values (header row first) of a tab, or null if the tab does not exist. */
function sheetValues_(ss, sheetName, forRowLookup) {
  var memoOk = isDataSs_(ss), m = memoOk ? __tabMemo_[sheetName] : null, now = Date.now();
  if (m && (forRowLookup ? now - m.at <= MEMO_ROWS_MS_ : (!m.dirty && now - m.at <= MEMO_FRESH_MS_))) return m.values;
  return readSheetValues_(ss, sheetName);
}
function readSheetValues_(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  if (isDataSs_(ss)) __tabMemo_[sheetName] = { values: values, at: Date.now(), dirty: false };
  return values;
}
/** After a write that keeps row numbers (update, append): decision reads must re-read the sheet. */
function markTabDirty_(ss, sheetName) { if (isDataSs_(ss) && __tabMemo_[sheetName]) __tabMemo_[sheetName].dirty = true; }
function forgetTab_(sheetName) { delete __tabMemo_[sheetName]; }

var __ssTz_ = {};
function ssTimeZone_(ss) {
  for (var id in __ssOpen_) if (__ssOpen_[id] === ss) return __ssTz_[id] || (__ssTz_[id] = ss.getSpreadsheetTimeZone());
  return ss.getSpreadsheetTimeZone();
}

/* ---------- generic row <-> object mapping ---------- */
function readObjects_(ss, sheetName) {
  var values = sheetValues_(ss, sheetName, false);
  if (!values || values.length < 2) return [];
  var headers = values[0];
  var tz = ssTimeZone_(ss);
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
  markTabDirty_(ss, sheetName);
  noteTabWrite_(sheetName);
  return row;
}

/**
 * Patch the first row whose `idCol` equals `idValue`. Returns true if found.
 * Each run of adjacent patched columns is written with ONE setValues (it was one setValue
 * per field). Columns between two runs are not rewritten, so a concurrent write to them
 * is never overwritten with this execution's older copy.
 */
function updateRowById_(ss, sheetName, idCol, idValue, patch) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  var values = sheetValues_(ss, sheetName, true);
  var r = rowIndexOf_(values, idCol, sheetName, idValue);
  if (r === -1 && isDataSs_(ss) && __tabMemo_[sheetName] && __tabMemo_[sheetName].values === values) {
    values = readSheetValues_(ss, sheetName);        // memo may predate the row: ask the sheet
    r = rowIndexOf_(values, idCol, sheetName, idValue);
  }
  if (r === -1) return false;
  var headers = values[0], cols = [];
  Object.keys(patch).forEach(function (k) {
    var c = headers.indexOf(k);
    if (c !== -1) cols.push({ c: c, v: patch[k] });
  });
  cols.sort(function (a, b) { return a.c - b.c; });
  for (var i = 0; i < cols.length; ) {
    var j = i;
    while (j + 1 < cols.length && cols[j + 1].c === cols[j].c + 1) j++;
    sh.getRange(r + 1, cols[i].c + 1, 1, j - i + 1).setValues([cols.slice(i, j + 1).map(function (x) { return x.v; })]);
    i = j + 1;
  }
  markTabDirty_(ss, sheetName);
  noteTabWrite_(sheetName);
  return true;
}
function rowIndexOf_(values, idCol, sheetName, idValue) {
  if (!values) throw new Error('Sheet not found: ' + sheetName);
  var idIdx = values[0].indexOf(idCol);
  if (idIdx === -1) throw new Error('No column "' + idCol + '" in ' + sheetName);
  for (var r = 1; r < values.length; r++) if (String(values[r][idIdx]) === String(idValue)) return r;
  return -1;
}

/** Delete the first row whose `idCol` equals `idValue`. Returns true if found. Always reads the sheet (rows shift). */
function deleteRowById_(ss, sheetName, idCol, idValue) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Sheet not found: ' + sheetName);
  var values = sh.getDataRange().getValues();
  var idIdx = values[0].indexOf(idCol);
  if (idIdx === -1) throw new Error('No column "' + idCol + '" in ' + sheetName);
  for (var r = values.length - 1; r >= 1; r--) {
    if (String(values[r][idIdx]) === String(idValue)) { sh.deleteRow(r + 1); forgetTab_(sheetName); noteTabWrite_(sheetName); return true; }
  }
  return false;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/* ---------- config: users / flows / routing / settings ----------
 * Read through the 5-minute config cache (Cache.js). App writes to these tabs bump
 * their version, so a change made in the app is live at once. */
function getUsers() { return readTabCached_('Users'); }

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

function getFlows() { return readTabCached_('Flows'); }

function getFlow(flowId) {
  var hits = getFlows().filter(function (f) { return String(f.flow_id) === String(flowId); });
  return hits.length ? hits[0] : null;
}

function getRouting(flowId) {
  return readTabCached_('Routing').filter(function (r) {
    return String(r.flow_id) === String(flowId) && r.active !== false && String(r.active) !== 'FALSE';
  });
}

function getSetting(key) {
  var hit = readTabCached_('Settings').filter(function (s) { return String(s.key) === String(key); });
  return hit.length ? hit[0].value : null;
}

/** Active audit periods for a flow, with dates normalised to yyyy-MM-dd strings. */
function getPeriods(flowId) {
  // readObjects_ already turned date cells into ISO strings, so the zone only matters for a raw Date.
  var tz = Session.getScriptTimeZone();
  return readTabCached_('Periods')
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
      noteTabWrite_('Users');
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

/** Parse a JSON cell to an object; {} on empty/invalid (detail_json is app-written). */
function parseJson_(s) {
  if (!s) return {};
  try { var o = JSON.parse(s); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
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
