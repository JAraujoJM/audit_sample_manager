/**
 * Review — server API for the Reviewer and Auditor stages.
 * --------------------------------------------------------
 * Once every preparer has submitted a line's evidence (line status 'submitted'),
 * the Reviewer submits it to the Auditor; the Auditor then closes it or returns
 * it for rework. Returning reopens the line's assignments so preparers can fix
 * and resubmit.
 *
 * SoD: Reviewer submits, Auditor returns/closes — a user holds one role, so the
 * two can't be the same person. Administrator may act as an override.
 *
 * Line lifecycle:
 *   open -> assigned -> in_progress -> submitted -> with_auditor -> closed
 *                                  ^------------ returned (note) -----------|
 */

var STAGE_STATUS = { review: 'submitted', audit: 'with_auditor' };

function stageRoles_(stage) {
  return stage === 'audit' ? [ROLES.AUDITOR, ROLES.ADMIN] : [ROLES.REVIEWER, ROLES.ADMIN];
}

/* ---------- read ---------- */
function reviewQueue(stage) {
  requireRole_(stageRoles_(stage));
  var want = STAGE_STATUS[stage];
  var ds = dataSs_();
  var lines = readObjects_(ds, 'Sample_Lines');
  return readObjects_(ds, 'Requests').map(function (r) {
    var rid = String(r.request_id);
    var rl = lines.filter(function (l) { return String(l.request_id) === rid; });
    var pending = rl.filter(function (l) { return String(l.status).toLowerCase() === want; }).length;
    return {
      request_id: r.request_id, title: r.title, period: r.period, status: r.status,
      created_at: r.created_at, lineCount: rl.length, pendingCount: pending
    };
  }).sort(function (a, b) {
    if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

function reviewDetail(requestId, stage) {
  var me = requireRole_(stageRoles_(stage));
  var ds = dataSs_();
  var req = readObjects_(ds, 'Requests').filter(function (r) { return String(r.request_id) === String(requestId); })[0];
  if (!req) throw new Error('Request not found.');

  var evidence = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.request_id) === String(requestId); });
  evidence.forEach(function (e) {                       // let the reviewer/auditor open the evidence
    if (e.file_id) { try { DriveApp.getFileById(e.file_id).addViewer(me.email); } catch (err) {} }
  });
  var evByAsg = {};
  evidence.forEach(function (e) {
    (evByAsg[e.assignment_id] = evByAsg[e.assignment_id] || []).push({
      file_name: e.file_name, url: e.file_id ? ('https://drive.google.com/file/d/' + e.file_id + '/view') : ''
    });
  });

  var asgByLine = {};
  readObjects_(ds, 'Assignments')
    .filter(function (a) { return String(a.request_id) === String(requestId); })
    .forEach(function (a) { (asgByLine[a.line_id] = asgByLine[a.line_id] || []).push(a); });

  var lines = readObjects_(ds, 'Sample_Lines')
    .filter(function (l) { return String(l.request_id) === String(requestId); })
    .map(function (l) {
      return {
        line_id: l.line_id, document_no: l.document_no, vendor: l.vendor,
        mpl_type: l.mpl_type, paid_status: l.paid_status, status: l.status, note: l.note || '',
        assignments: (asgByLine[l.line_id] || []).map(function (a) {
          return { evidence_type: a.evidence_type, assigned_to: a.assigned_to, status: a.status, files: evByAsg[a.assignment_id] || [] };
        })
      };
    });
  return { request: req, stage: stage, actionable: STAGE_STATUS[stage], lines: lines };
}

/* ---------- reviewer actions ---------- */
function reviewerSubmit(lineId) {
  requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'submitted');
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'with_auditor', note: '' });
  logActivity('REVIEW_SUBMIT', 'line', lineId, 'submitted to auditor');
  return reviewDetail(line.request_id, 'review');
}

function reviewerReturn(lineId, note) {
  requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var line = requireLineStatus_(lineId, 'submitted');
  reopenLineAssignments_(lineId);
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'in_progress', note: 'Returned by reviewer: ' + note });
  logActivity('REVIEW_RETURN', 'line', lineId, note);
  return reviewDetail(line.request_id, 'review');
}

/* ---------- auditor actions ---------- */
function auditorClose(lineId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'with_auditor');
  getAssignments(lineId).forEach(function (a) {
    if (String(a.status).toLowerCase() === 'submitted') {
      updateRowById_(dataSs_(), 'Assignments', 'assignment_id', a.assignment_id, { status: 'accepted' });
    }
  });
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'closed', note: note ? ('Closed: ' + note) : '' });
  recomputeRequestStatus_(line.request_id);
  logActivity('AUDIT_CLOSE', 'line', lineId, note || '');
  return reviewDetail(line.request_id, 'audit');
}

function auditorReturn(lineId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var line = requireLineStatus_(lineId, 'with_auditor');
  reopenLineAssignments_(lineId);
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'in_progress', note: 'Returned by auditor: ' + note });
  logActivity('AUDIT_RETURN', 'line', lineId, note);
  return reviewDetail(line.request_id, 'audit');
}

/* ---------- helpers ---------- */
function requireLineStatus_(lineId, want) {
  var line = findLine_(lineId);
  if (!line) throw new Error('Line not found.');
  if (String(line.status).toLowerCase() !== want) {
    throw new Error('This line is no longer in the expected state (now: ' + line.status + ').');
  }
  return line;
}

function reopenLineAssignments_(lineId) {
  getAssignments(lineId).forEach(function (a) {
    var s = String(a.status).toLowerCase();
    if (s === 'submitted' || s === 'accepted') {
      updateRowById_(dataSs_(), 'Assignments', 'assignment_id', a.assignment_id, { status: 'in_progress', submitted_at: '' });
    }
  });
}

function recomputeRequestStatus_(requestId) {
  var relevant = readObjects_(dataSs_(), 'Sample_Lines')
    .filter(function (l) { return String(l.request_id) === String(requestId) && String(l.status).toLowerCase() !== 'not_found'; });
  if (relevant.length && relevant.every(function (l) { return String(l.status).toLowerCase() === 'closed'; })) {
    updateRowById_(dataSs_(), 'Requests', 'request_id', requestId, { status: 'closed', updated_at: nowIso_() });
  }
}
