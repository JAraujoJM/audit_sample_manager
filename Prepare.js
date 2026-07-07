/**
 * Prepare — server API for the Preparer "My tasks" view.
 * ------------------------------------------------------
 * Preparers see the evidence items routed to them, upload files, and submit for
 * review. Uploads are app-mediated: the web app runs as the deployer, so it owns
 * every file in the admin-only Evidence tree — preparers never need Drive access.
 * A preparer may only act on items assigned to them (admins may act on any).
 */

/* ---------- read ---------- */
function listMyAssignments() {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var ds = dataSs_();
  var email = me.email.toLowerCase();
  var tz = ds.getSpreadsheetTimeZone();

  var lines = {}; readObjects_(ds, 'Sample_Lines').forEach(function (l) { lines[String(l.line_id)] = l; });
  var reqs  = {}; readObjects_(ds, 'Requests').forEach(function (r) { reqs[String(r.request_id)] = r; });
  var evidence = readObjects_(ds, 'Evidence');

  return readObjects_(ds, 'Assignments')
    .filter(function (a) { return String(a.assigned_to || '').toLowerCase() === email; })
    .map(function (a) {
      var line = lines[String(a.line_id)] || {};
      var req  = reqs[String(a.request_id)] || {};
      var files = evidence
        .filter(function (e) { return String(e.assignment_id) === String(a.assignment_id); })
        .map(function (e) {
          return { evidence_id: e.evidence_id, file_name: e.file_name, mime: e.mime || '', uploaded_at: toDateStr_(e.uploaded_at, tz) };
        });
      return {
        assignment_id: a.assignment_id, request_id: a.request_id, line_id: a.line_id,
        request_title: req.title || '', document_no: line.document_no || '', vendor: line.vendor || '',
        statement_code: line.statement_code || '', statement_amount: line.closing_balance || '',
        paid_at: toDateStr_(line.paid_at, tz),
        evidence_type: a.evidence_type, status: a.status, due_date: toDateStr_(req.due_date, tz),
        note: line.note || '', files: files
      };
    })
    .sort(function (x, y) { return String(x.due_date || '9999').localeCompare(String(y.due_date || '9999')); });
}

/* ---------- evidence upload (app-mediated) ---------- */
function uploadEvidence(assignmentId, fileName, mimeType, base64Data) {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var ds = dataSs_();
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Assignment not found.');
  assertOwner_(asg, me);
  assertEditable_(asg, me);
  if (!base64Data) throw new Error('No file data received.');

  fileName = sanitizeName_(fileName || 'evidence');
  var line = findLine_(asg.line_id);
  var req  = findRequest_(asg.request_id);
  var docNo = line ? line.document_no : asg.line_id;
  var flowId = req ? req.flow_id : 'flowA';

  var folder = evidenceDocFolder_(flowId, asg.request_id, docNo);
  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType || 'application/octet-stream', fileName);
  var file = folder.createFile(blob);   // owned by the deployer; served to others via getEvidenceFile

  if (line && !String(line.evidence_folder_id || '').trim()) {
    updateRowById_(ds, 'Sample_Lines', 'line_id', asg.line_id, { evidence_folder_id: folder.getId() });
  }

  appendObject_(ds, 'Evidence', {
    evidence_id: newId_('EVD'), assignment_id: assignmentId, line_id: asg.line_id, request_id: asg.request_id,
    file_id: file.getId(), file_name: fileName, mime: file.getMimeType(),
    uploaded_by: me.email, uploaded_at: nowIso_(), status: 'uploaded'
  });

  if (['pending', 'assigned'].indexOf(String(asg.status).toLowerCase()) !== -1) {
    updateRowById_(ds, 'Assignments', 'assignment_id', assignmentId, { status: 'in_progress' });
  }
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('EVIDENCE_UPLOAD', 'assignment', assignmentId, fileName);
  return listMyAssignments();
}

function removeEvidence(evidenceId) {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var ds = dataSs_();
  var ev = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.evidence_id) === String(evidenceId); })[0];
  if (!ev) throw new Error('Evidence not found.');
  var asg = findAssignment_(ev.assignment_id);
  if (asg) assertOwner_(asg, me);
  if (asg && me.role !== ROLES.ADMIN) {
    var s = String(asg.status).toLowerCase();
    if (s === 'submitted') throw new Error('Withdraw the submission before removing files.');
    if (['pending', 'assigned', 'in_progress'].indexOf(s) === -1) throw new Error('This task is locked and can no longer be edited.');
  }

  try { DriveApp.getFileById(ev.file_id).setTrashed(true); } catch (e) { /* already gone */ }
  deleteRowById_(ds, 'Evidence', 'evidence_id', evidenceId);

  if (asg) {
    var left = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.assignment_id) === String(asg.assignment_id); }).length;
    if (left === 0 && ['in_progress', 'submitted'].indexOf(String(asg.status).toLowerCase()) !== -1) {
      updateRowById_(ds, 'Assignments', 'assignment_id', asg.assignment_id,
        { status: String(asg.assigned_to || '').trim() ? 'assigned' : 'pending' });
    }
    updateLineAssignmentRollup_(asg.line_id);
  }
  logActivity('EVIDENCE_REMOVE', 'assignment', ev.assignment_id, ev.file_name);
  return listMyAssignments();
}

/* ---------- submit / withdraw ---------- */
function submitAssignment(assignmentId) {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var ds = dataSs_();
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Assignment not found.');
  assertOwner_(asg, me);
  assertEditable_(asg, me);
  var files = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.assignment_id) === String(assignmentId); });
  if (!files.length) throw new Error('Upload at least one evidence file before submitting.');

  updateRowById_(ds, 'Assignments', 'assignment_id', assignmentId, { status: 'submitted', submitted_at: nowIso_() });
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('ASSIGNMENT_SUBMIT', 'assignment', assignmentId, files.length + ' file(s)');
  return listMyAssignments();
}

function withdrawAssignment(assignmentId) {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var ds = dataSs_();
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Assignment not found.');
  assertOwner_(asg, me);
  if (String(asg.status).toLowerCase() !== 'submitted') throw new Error('Only a submitted task can be withdrawn.');

  updateRowById_(ds, 'Assignments', 'assignment_id', assignmentId, { status: 'in_progress', submitted_at: '' });
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('ASSIGNMENT_WITHDRAW', 'assignment', assignmentId, '');
  return listMyAssignments();
}

/* ---------- helpers ---------- */
function assertOwner_(asg, me) {
  if (me.role === ROLES.ADMIN) return;
  if (String(asg.assigned_to || '').toLowerCase() !== me.email.toLowerCase()) {
    throw new Error('This task is not assigned to you.');
  }
}

/** A preparer may only edit while the item is still in their hands. */
function assertEditable_(asg, me) {
  if (me.role === ROLES.ADMIN) return;
  if (['pending', 'assigned', 'in_progress'].indexOf(String(asg.status).toLowerCase()) === -1) {
    throw new Error('This task is locked and can no longer be edited.');
  }
}

function sanitizeName_(n) { return String(n).replace(/[\/\\:*?"<>|]/g, '_').slice(0, 140); }

function evidenceDocFolder_(flowId, requestId, docNo) {
  var rootId = PropertiesService.getScriptProperties().getProperty(PROP.EVIDENCE);
  if (!rootId) throw new Error('Evidence folder not provisioned — run setup().');
  var f1 = getOrCreateFolder_(DriveApp.getFolderById(rootId), String(flowId || 'flow'));
  var f2 = getOrCreateFolder_(f1, String(requestId));
  return getOrCreateFolder_(f2, String(docNo || 'doc'));
}
