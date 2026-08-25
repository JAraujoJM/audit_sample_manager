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
          return { evidence_id: e.evidence_id, file_name: e.file_name, mime: e.mime || '', uploaded_at: toDateStr_(e.uploaded_at, tz), slot: e.slot || '' };
        });
      var slots = parseJson_(a.slots_json); if (!Array.isArray(slots)) slots = [];
      return {
        assignment_id: a.assignment_id, request_id: a.request_id, line_id: a.line_id,
        request_title: req.title || '', document_no: line.document_no || '', vendor: line.vendor || '',
        company: line.company || '', amount: line.amount || '',
        statement_code: line.statement_code || '', statement_amount: line.closing_balance || '',
        paid_at: toDateStr_(line.paid_at, tz),
        subpopulation: line.subpopulation || '', detail: parseJson_(line.detail_json), unit: parseJson_(a.detail_json),
        evidence_type: a.evidence_type, optional: isOptional_(a.optional), slots: slots,
        status: a.status, due_date: toDateStr_(req.due_date, tz),
        note: a.notes || line.note || '', preparer_note: a.preparer_note || '', files: files
      };
    })
    .sort(function (x, y) { return String(x.due_date || '9999').localeCompare(String(y.due_date || '9999')); });
}

/* ---------- export my tasks to Excel ----------
 * A working checklist the preparer can use while gathering evidence: every task
 * routed to them, with the documents to collect and the sample facts. Read-only,
 * no evidence files — just the list. Same Sheet→xlsx export path as auditExport. */

// Field specs mirror the client's CA_FIELDS (Index.html) so the export's Details
// column carries exactly what the "My tasks" card shows on screen — keep in sync.
var CA_JP_EXPORT_ = [['Order', 'order_nr'], ['Amount', 'amount'], ['Payment date', 'jp_created'], ['Gateway', 'jp_gateway'], ['Payment provider', 'jp_provider'], ['Retrieval ref', 'jp_retrieval']];
var CA_FIELDS_EXPORT_ = {
  'Prepaid - Voucher': [['Order', 'order_nr'], ['Amount', 'amount']],
  'Prepaid - JumiaPay': CA_JP_EXPORT_, 'Postpaid - JumiaPay on delivery': CA_JP_EXPORT_, 'Postpaid - Cash - 3PL via JPay': CA_JP_EXPORT_,
  'Postpaid - Cash & POS': [['Package no', 'package_number'], ['Collection partner', 'collection_partner'], ['Payment no', 'payment_no'], ['Payment date', 'payment_date'], ['Payment reference', 'payment_ref'], ['Bank account', 'bank_account'], ['Amount', 'amount']],
  'Prepaid - Other methods': [['Order', 'order_nr'], ['Amount', 'amount']]
};
// Value resolves per-payment unit → line detail → the task row, same order as caVal.
function caValExport_(key, t) {
  var u = t.unit || {}, d = t.detail || {};
  if (u[key] != null && u[key] !== '') return u[key];
  if (d[key] != null && d[key] !== '') return d[key];
  if (t[key] != null && t[key] !== '') return t[key];
  return '';
}
function taskDetails_(t) {
  var spec = t.subpopulation && CA_FIELDS_EXPORT_[t.subpopulation];
  if (spec) {
    return spec.map(function (f) { var v = caValExport_(f[1], t); return f[0] + ' ' + (v === '' ? '—' : v); }).join(' · ');
  }
  // Flow A card shows statement no. / statement amount / paid at.
  return [t.statement_code ? 'Statement no ' + t.statement_code : '',
          (t.statement_amount != null && t.statement_amount !== '') ? 'Statement amount ' + t.statement_amount : '',
          t.paid_at ? 'Paid at ' + t.paid_at : ''].filter(String).join(' · ');
}

function exportMyTasks() {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var tasks = listMyAssignments();
  if (!tasks.length) throw new Error('You have no tasks to export yet.');

  var H = ['Request', 'Sample', 'Company', 'Subpopulation / type', 'Evidence / task', 'Documents to collect',
           'Details', 'Status', 'Due date', 'Note from reviewer', 'My comment'];
  var rows = [H];
  tasks.forEach(function (t) {
    var docs = (t.slots && t.slots.length)
      ? t.slots.map(function (s) { return s.label + (s.optional ? ' (optional)' : ''); }).join('\n')
      : (t.evidence_type + (t.optional ? ' (optional)' : ''));
    rows.push([t.request_title || '', t.document_no || '', t.company || '', t.subpopulation || (t.mpl_type || ''),
      t.evidence_type || '', docs, taskDetails_(t), String(t.status || '').replace(/_/g, ' '),
      t.due_date || '', t.note || '', t.preparer_note || '']);
  });

  var name = sanitizeName_('My audit tasks - ' + me.email.split('@')[0]);
  var ss = SpreadsheetApp.create(name);
  try {
    var sh = ss.getSheets()[0].setName('My tasks');
    sh.getRange(1, 1, rows.length, H.length).setValues(rows);
    sh.setFrozenRows(1); sh.getRange(1, 1, 1, H.length).setFontWeight('bold');
    sh.getRange(1, 1, rows.length, H.length).setVerticalAlignment('top').setWrap(true);
    [180, 120, 90, 150, 160, 200, 220, 110, 100, 240, 240].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
    SpreadsheetApp.flush();

    var resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + ss.getId() + '/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (resp.getResponseCode() >= 300) throw new Error('Could not build the Excel file (HTTP ' + resp.getResponseCode() + ').');
    var bytes = resp.getBlob().getBytes();
    logActivity('MY_TASKS_EXPORT', 'user', me.email, tasks.length + ' task(s)');
    return { name: name + '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
             dataUrl: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + Utilities.base64Encode(bytes) };
  } finally {
    try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) {}
  }
}

/* ---------- evidence upload (app-mediated) ---------- */
function uploadEvidence(assignmentId, fileName, mimeType, base64Data, slot) {
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
    uploaded_by: me.email, uploaded_at: nowIso_(), status: 'uploaded', slot: String(slot || '')
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
function submitAssignment(assignmentId, note) {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var ds = dataSs_();
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Assignment not found.');
  assertOwner_(asg, me);
  assertEditable_(asg, me);
  var files = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.assignment_id) === String(assignmentId); });
  var slots = parseJson_(asg.slots_json);
  if (Array.isArray(slots) && slots.length) {
    // Multi-slot task (e.g. Voucher, JumiaPay): every required slot needs a file.
    var have = {}; files.forEach(function (f) { have[String(f.slot || '')] = true; });
    var missing = slots.filter(function (s) { return !s.optional && !have[s.key]; });
    if (missing.length) throw new Error('Upload ' + missing.map(function (s) { return s.label; }).join(', ') + ' before submitting.');
  } else if (!files.length) {
    throw new Error('Upload at least one evidence file before submitting.');
  }

  // Optional preparer comment: seen by the reviewer only (never the auditor), so the
  // preparer can flag a known variance + its justification up front. Stored on its own
  // column so it never collides with the reviewer/auditor `notes` channel.
  note = String(note || '').trim();
  updateRowById_(ds, 'Assignments', 'assignment_id', assignmentId,
    { status: 'submitted', submitted_at: nowIso_(), preparer_note: note });
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('ASSIGNMENT_SUBMIT', 'assignment', assignmentId, files.length + ' file(s)' + (note ? ' — ' + note : ''));
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
