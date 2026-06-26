/**
 * Assign — server API for the admin assignment view.
 * --------------------------------------------------
 * Inspect enrichment runs and route each required evidence item to a preparer
 * (with an optional due date). A line can carry several assignments, each owned
 * by a different preparer — assign them independently here.
 *
 * Reading is open to Administrator + Reviewer; writing is Administrator-only (SoD).
 */

/** Every request, newest first, annotated with line / assignment progress. */
function listRequests() {
  requireRole_([ROLES.ADMIN, ROLES.REVIEWER]);
  var ds = dataSs_();
  var lines = readObjects_(ds, 'Sample_Lines');
  var asg = readObjects_(ds, 'Assignments');
  return readObjects_(ds, 'Requests').map(function (r) {
    var rid = String(r.request_id);
    var rLines = lines.filter(function (l) { return String(l.request_id) === rid; });
    var rAsg = asg.filter(function (a) { return String(a.request_id) === rid; });
    var assigned = rAsg.filter(function (a) { return String(a.assigned_to || '').trim() !== ''; }).length;
    return {
      request_id: r.request_id, title: r.title, period: r.period, status: r.status,
      created_by: r.created_by, created_at: r.created_at,
      lineCount: rLines.length, assignmentCount: rAsg.length, assignedCount: assigned
    };
  }).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
}

/** A request with its lines, each carrying its assignment list. */
function getRequestDetail(requestId) {
  requireRole_([ROLES.ADMIN, ROLES.REVIEWER]);
  var ds = dataSs_();
  var req = readObjects_(ds, 'Requests').filter(function (r) { return String(r.request_id) === String(requestId); })[0];
  if (!req) throw new Error('Request not found.');
  var tz = ds.getSpreadsheetTimeZone();

  var byLine = {};
  readObjects_(ds, 'Assignments')
    .filter(function (a) { return String(a.request_id) === String(requestId); })
    .forEach(function (a) { (byLine[a.line_id] = byLine[a.line_id] || []).push(a); });

  var lines = readObjects_(ds, 'Sample_Lines')
    .filter(function (l) { return String(l.request_id) === String(requestId); })
    .map(function (l) {
      return {
        line_id: l.line_id, document_no: l.document_no, vendor: l.vendor,
        mpl_type: l.mpl_type, paid_status: l.paid_status, status: l.status,
        required_count: l.required_count,
        assignments: (byLine[l.line_id] || []).map(function (a) {
          return {
            assignment_id: a.assignment_id, evidence_type: a.evidence_type,
            assigned_to: a.assigned_to, status: a.status, due_date: toDateStr_(a.due_date, tz)
          };
        })
      };
    });
  return { request: req, lines: lines };
}

/** Active preparers — suggestions for the assignee field. */
function listPreparers() {
  requireRole_([ROLES.ADMIN]);
  return getUsers()
    .filter(function (u) { return String(u.status).toLowerCase() === 'active' && String(u.role) === ROLES.PREPARER; })
    .map(function (u) { return u.email; })
    .sort();
}

/**
 * Apply a batch of assignment edits: [{assignment_id, assigned_to, due_date}].
 * Setting an assignee moves a pending item to 'assigned'; clearing it reverts to
 * 'pending'. Downstream statuses (submitted/accepted/...) are left untouched.
 */
function assignBatch(updates) {
  var who = requireRole_([ROLES.ADMIN]);
  if (!updates || !updates.length) return { ok: true, updated: 0 };

  var ds = dataSs_();
  var current = {};
  readObjects_(ds, 'Assignments').forEach(function (a) { current[String(a.assignment_id)] = a; });

  updates.forEach(function (u) {
    var email = String(u.assigned_to || '').trim();
    if (email && !/@jumia\.com$/i.test(email)) throw new Error('Assignee must be a @jumia.com email: ' + email);
  });

  var touchedLines = {}, requestId = '';
  updates.forEach(function (u) {
    var cur = current[String(u.assignment_id)];
    if (!cur) return;
    requestId = cur.request_id;
    var email = String(u.assigned_to || '').trim();
    var patch = { assigned_to: email, due_date: u.due_date || '' };
    if (['pending', 'assigned'].indexOf(String(cur.status).toLowerCase()) !== -1) {
      patch.status = email ? 'assigned' : 'pending';
    }
    updateRowById_(ds, 'Assignments', 'assignment_id', u.assignment_id, patch);
    touchedLines[cur.line_id] = true;
  });

  Object.keys(touchedLines).forEach(updateLineAssignmentRollup_);
  logActivity('ASSIGN', 'request', requestId, updates.length + ' assignment(s) updated by ' + who.email);
  return { ok: true, updated: updates.length };
}

/** A Sheets-coerced date cell -> 'yyyy-MM-dd' string (in the sheet's own timezone). */
function toDateStr_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

/**
 * Roll the assignment lifecycle up to the line status (pre-review only):
 *   open -> assigned -> in_progress -> submitted.
 * 'submitted' means every required item is submitted/accepted — i.e. all
 * preparers have responded, so the line is ready to advance. Review/closed
 * states are left untouched.
 */
function updateLineAssignmentRollup_(lineId) {
  var items = getAssignments(lineId);
  if (!items.length) return;
  var line = readObjects_(dataSs_(), 'Sample_Lines').filter(function (l) { return String(l.line_id) === String(lineId); })[0];
  if (!line) return;
  if (['open', 'assigned', 'in_progress', 'submitted'].indexOf(String(line.status).toLowerCase()) === -1) return;

  var st = function (a) { return String(a.status).toLowerCase(); };
  var allDone     = items.every(function (a) { return st(a) === 'submitted' || st(a) === 'accepted'; });
  var anyWork     = items.some(function (a) { return ['in_progress', 'submitted', 'accepted'].indexOf(st(a)) !== -1; });
  var allAssigned = items.every(function (a) { return String(a.assigned_to || '').trim() !== ''; });
  var next = allDone ? 'submitted' : anyWork ? 'in_progress' : allAssigned ? 'assigned' : 'open';
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: next });
}
