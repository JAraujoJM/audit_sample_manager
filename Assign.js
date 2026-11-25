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
  var t = readTabsCached_(['Sample_Lines', 'Assignments', 'Requests']);
  var lines = t.Sample_Lines;
  var asg = t.Assignments;
  return t.Requests.map(function (r) {
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
  var t = readTabsCached_(['Requests', 'Assignments', 'Sample_Lines']);
  var req = t.Requests.filter(function (r) { return String(r.request_id) === String(requestId); })[0];
  if (!req) throw new Error('Request not found.');
  var tz = Session.getScriptTimeZone();

  var byLine = {};
  t.Assignments
    .filter(function (a) { return String(a.request_id) === String(requestId); })
    .forEach(function (a) { (byLine[a.line_id] = byLine[a.line_id] || []).push(a); });

  var lines = t.Sample_Lines
    .filter(function (l) { return String(l.request_id) === String(requestId); })
    .map(function (l) {
      return {
        line_id: l.line_id, document_no: l.document_no, company: l.company, vendor: l.vendor,
        mpl_type: l.mpl_type, paid_status: l.paid_status, status: l.status,
        subpopulation: l.subpopulation || '', amount: l.amount || '', detail: parseJson_(l.detail_json),
        required_count: l.required_count,
        // System tasks (Flow C reconciliation) are owned by the app + the reviewer — never routed to a preparer here.
        assignments: (byLine[l.line_id] || []).filter(function (a) { return parseJson_(a.detail_json).kind !== 'system'; }).map(function (a) {
          return {
            assignment_id: a.assignment_id, evidence_type: a.evidence_type,
            assigned_to: a.assigned_to, status: a.status, due_date: toDateStr_(a.due_date, tz),
            optional: isOptional_(a.optional), unit: parseJson_(a.detail_json)
          };
        })
      };
    });
  return { request: slimRequest_(req), lines: lines };
}

/** The Requests row without the heavy JSON cells (IPE snapshot, stage list): screens never read them. */
function slimRequest_(r) {
  var o = {};
  Object.keys(r || {}).forEach(function (k) { if (k !== 'ipe_json' && k !== 'stages_json') o[k] = r[k]; });
  return o;
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
 * 'pending'. Downstream statuses (submitted/reviewed) still allow reassignment —
 * so a preparer who leaves mid-request can be swapped out — but an 'accepted'
 * item is a locked historical record and is never reassigned.
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

  var touchedLines = {}, requestId = '', updated = 0, locked = 0, moves = [];
  updates.forEach(function (u) {
    var cur = current[String(u.assignment_id)];
    if (!cur) return;
    requestId = cur.request_id;
    if (String(cur.status).toLowerCase() === 'accepted') { locked++; return; }   // historical record — never reassign
    var email = String(u.assigned_to || '').trim();
    var patch = { assigned_to: email };   // due date is set at request level, not per task
    if (['pending', 'assigned'].indexOf(String(cur.status).toLowerCase()) !== -1) {
      patch.status = email ? 'assigned' : 'pending';
    }
    updateRowById_(ds, 'Assignments', 'assignment_id', u.assignment_id, patch);
    var was = String(cur.assigned_to || '').trim();
    if (was.toLowerCase() !== email.toLowerCase()) moves.push([String(u.assignment_id), was, email]);
    touchedLines[cur.line_id] = true;
    updated++;
  });

  Object.keys(touchedLines).forEach(updateLineAssignmentRollup_);
  logActivity('ASSIGN', 'request', requestId, updated + ' assignment(s) updated by ' + who.email +
    (locked ? (' (' + locked + ' accepted item(s) left unchanged)') : ''));
  logAssignedTasks_(requestId, moves);
  return { ok: true, updated: updated, locked: locked };
}

/**
 * Who each task was given to, and taken from (25 Nov 2026). The ASSIGN line above only says how
 * many tasks a save touched, so the trail could not tell who had held a task before a
 * reassignment. ONE Activity_Log line per save — not one per task: a 300-task save must not get
 * slower, and a single appendRow cannot collide with another execution's log line — with
 * details = {"v":1,"tasks":[[assignment_id, from, to], …]} (only the tasks whose assignee changed).
 * Read by the dashboard (Dashboard.js: a reassigned task keeps its previous preparer's days with
 * them) and by Sample history (taskTimeline). Split so a line stays far below the cell limit.
 * The format is load-bearing for both readers — change them together.
 */
function logAssignedTasks_(requestId, moves) {
  for (var i = 0; i < moves.length; i += 400) {
    logActivity(ASSIGN_LOG_ACTION_, 'request', requestId, JSON.stringify({ v: 1, tasks: moves.slice(i, i + 400) }));
  }
}

/** Normalise a date cell to a 'yyyy-MM-dd' string. Handles both raw Date cells
 * and the ISO strings readObjects_ now produces (keeps just the date part). */
function toDateStr_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = v == null ? '' : String(v);
  var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

/**
 * Roll the sample status up from its tasks across the WHOLE lifecycle. This is
 * called after every task change (preparer upload/submit/withdraw, reviewer/auditor
 * per-task actions) so tasks advance independently:
 *   open -> assigned -> in_progress -> pending_review -> pending_audit -> closed.
 *
 * For subpopulations reviewed PER TASK (Cash & POS), the sample is pending_review as
 * soon as ANY task is submitted (the reviewer starts immediately, and returning one
 * task never blocks the others). For the rest, the whole sample moves together, so it
 * only reaches pending_review once every required task is in. Optional evidence never
 * gates. pending_audit = every required task reviewed; closed = every required task accepted.
 */
function updateLineAssignmentRollup_(lineId) {
  var items = getAssignments(lineId);
  if (!items.length) return;
  var line = readObjects_(dataSs_(), 'Sample_Lines').filter(function (l) { return String(l.line_id) === String(lineId); })[0];
  if (!line) return;

  var st = function (a) { return String(a.status).toLowerCase(); };
  var required = items.filter(function (a) { return !isOptional_(a.optional); });
  var gate = required.length ? required : items;
  var perTask = isPerTaskSub_(line.subpopulation);
  var prev = String(line.status).toLowerCase();

  var allAccepted = gate.every(function (a) { return st(a) === 'accepted'; });
  var allReviewed = gate.every(function (a) { return ['reviewed', 'accepted'].indexOf(st(a)) !== -1; });
  var anySubmitted = gate.some(function (a) { return st(a) === 'submitted'; });
  var allSubmitted = gate.every(function (a) { return ['submitted', 'reviewed', 'accepted'].indexOf(st(a)) !== -1; });
  var anyWork = items.some(function (a) { return ['in_progress', 'submitted', 'reviewed', 'accepted'].indexOf(st(a)) !== -1; });
  var allAssigned = gate.every(function (a) { return String(a.assigned_to || '').trim() !== ''; });

  var next = allAccepted ? 'closed'
    : allReviewed ? 'pending_audit'
    : (perTask ? anySubmitted : allSubmitted) ? 'pending_review'
    : anyWork ? 'in_progress'
    : allAssigned ? 'assigned' : 'open';

  var patch = { status: next };
  // Regressing to the preparer invalidates the sample-level AI verdict — clear it so a
  // fresh check runs when it comes back (per-task verdicts live on the assignments).
  if (['pending_review', 'pending_audit', 'closed'].indexOf(next) === -1 && String(line.ai_verdict || '').trim()) {
    patch.ai_verdict = ''; patch.ai_summary = ''; patch.ai_checked_at = '';
  }
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, patch);

  if (next === 'closed' && prev !== 'closed') recomputeRequestStatus_(line.request_id);
  // First time a sample becomes ready for the reviewer, queue the AI pre-check in the
  // background (a time trigger) so it never delays the preparer's submit.
  if (next === 'pending_review' && prev !== 'pending_review') scheduleAiCheck_();
  // A task changed: a request that has an audit folder gets it refreshed in the background
  // (AuditFolder.js — does nothing, and costs nothing, while no audit folder exists).
  noteExportChange_();
}
