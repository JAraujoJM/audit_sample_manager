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
  var email = me.email.toLowerCase();
  var tz = Session.getScriptTimeZone();
  // Cached read: a write in this same execution (upload / submit / withdraw) has already
  // moved the tab versions on, so the list returned after an action is always fresh.
  var t = readTabsCached_(['Sample_Lines', 'Requests', 'Evidence', 'Assignments']);

  var lines = {}; t.Sample_Lines.forEach(function (l) { lines[String(l.line_id)] = l; });
  var reqs  = {}; t.Requests.forEach(function (r) { reqs[String(r.request_id)] = r; });
  var evidence = t.Evidence;

  return t.Assignments
    .filter(function (a) { return String(a.assigned_to || '').toLowerCase() === email; })
    .filter(function (a) { return parseJson_(a.detail_json).kind !== 'system'; })   // app-produced reconciliations are reviewed, not prepared
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
        closing_balance: line.closing_balance || '', mpl_type: line.mpl_type || '',
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
 * A working list the preparer can take offline: every task routed to them with
 * EVERYTHING the "My tasks" card shows — one column per card field, so the file
 * can be filtered and sorted in Excel. Read-only, no evidence files — just the
 * list. Same Sheet→xlsx export path as auditExport. */

// Field specs = the client's CA_FIELDS (Index.html): same labels, keys and order, so
// every fact on a "My tasks" card is one column of the export. KEEP IN SYNC — a field
// added to a card must be added here too.
var CA_JP_EXPORT_ = [['Order', 'order_nr'], ['Amount', 'amount'], ['Payment date', 'jp_created'], ['Gateway', 'jp_gateway'], ['Payment provider', 'jp_provider'], ['Retrieval ref', 'jp_retrieval']];
var CA_COGS_EXPORT_ = [['Posted', 'entry_date'], ['Sales document', 'sales_doc'], ['Type', 'entry_type'], ['Item', 'item_no'], ['Description', 'item_desc'],
  ['Cost amount', 'amount'], ['Receipt', 'receipt_no'], ['PO', 'po'],
  ['NAV document', 'doc_no'], ['Vendor document no.', 'vendor_doc_no'], ['Document date', 'doc_date'], ['Charge', 'item_charge'], ['Per unit', 'unit_amount']];
// Flow A card (and any type without a spec of its own).
var CA_FLOWA_EXPORT_ = [['Statement no.', 'statement_code'], ['Statement amount', 'statement_amount'], ['Paid at', 'paid_at']];
var CA_FIELDS_EXPORT_ = {
  'Prepaid - Voucher': [['Order', 'order_nr'], ['Amount', 'amount']],
  'Prepaid - JumiaPay': CA_JP_EXPORT_, 'Postpaid - JumiaPay on delivery': CA_JP_EXPORT_, 'Postpaid - Cash - 3PL via JPay': CA_JP_EXPORT_,
  'Postpaid - Cash & POS': [['Package no', 'package_number'], ['Collection partner', 'collection_partner'], ['Payment no', 'payment_no'], ['Payment date', 'payment_date'], ['Payment reference', 'payment_ref'], ['Bank account', 'bank_account'], ['Amount', 'amount']],
  'Prepaid - Other methods': [['Order', 'order_nr'], ['Amount', 'amount']],
  // Flow C Retail (the "Sales invoice" task) — same fields as the card.
  'Retail': [['Package no', 'package_number'], ['BOB item', 'bob_soi'], ['SKU', 'sku'], ['Unit price', 'amount'], ['Delivered', 'delivered_date'], ['Customer', 'inv_customer'], ['Invoice total', 'inv_total']],
  'Marketplace': [['Package no', 'package_number'], ['SKU', 'sku'], ['Unit price', 'amount'], ['Statement', 'statement_code'], ['Closing balance', 'closing_balance'], ['Paid at', 'paid_at'], ['Payout method', 'payout_method'], ['Source provider', 'source_provider'], ['Payment reference', 'payment_ref'], ['MPL type', 'mpl_type'], ['PO', 'po']],
  // Flow D (COGS by NAV value entry) — same fields as the card.
  'COGS - Original cost': CA_COGS_EXPORT_, 'COGS - Adjustment': CA_COGS_EXPORT_
};
// Value resolves per-payment unit → line detail → the task row, same order as caVal.
function caValExport_(key, t) {
  var u = t.unit || {}, d = t.detail || {};
  if (u[key] != null && u[key] !== '') return u[key];
  if (d[key] != null && d[key] !== '') return d[key];
  if (t[key] != null && t[key] !== '') return t[key];
  return '';
}
// Keys written as numbers (the client's CA_NUM_KEYS + the two balances) and fields a card
// leaves out when empty (the client's CA_OPTIONAL) — such a column only exists when a task fills it.
var CA_NUM_EXPORT_ = { amount: 1, inv_total: 1, unit_amount: 1, doc_amount: 1, statement_amount: 1, closing_balance: 1 };
var CA_OPTIONAL_EXPORT_ = { item_charge: 1, unit_amount: 1, item_desc: 1 };
var CA_WIDE_EXPORT_ = { 'Description': 1, 'Purchase trace': 1, 'Adjustment explained by': 1, 'Other notes on the receipt': 1, 'Document status': 1 };

function isRegularMpl_(t) { return t.subpopulation === 'Marketplace' && /regular/i.test(String(t.mpl_type || '')); }

// The card's header vendor: a Regular-MPL seller leads with its RING short code.
function cardVendorExport_(t) {
  if (!isRegularMpl_(t)) return t.vendor || '';
  return [caValExport_('vendor_short_code', t), t.vendor || ''].filter(String).join(' :: ');
}

// Every fact one task's card shows, in card order: [{ label, value, num, optional }].
function cardFieldsExport_(t) {
  var spec = (t.subpopulation && CA_FIELDS_EXPORT_[t.subpopulation]) || CA_FLOWA_EXPORT_;
  if (isRegularMpl_(t)) spec = spec.filter(function (f) { return f[1] !== 'po'; });   // the card hides the PO for these
  var out = spec.map(function (f) {
    var v = caValExport_(f[1], t), num = !!CA_NUM_EXPORT_[f[1]];
    if (num && v !== '' && isFinite(Number(v))) v = Number(v);
    return { label: f[0], value: v, num: num, optional: !!CA_OPTIONAL_EXPORT_[f[1]] };
  });
  // Flow D: the plain lines under the card's facts (what NAV says about the purchase behind the entry).
  if (isCogsSub_(t.subpopulation)) {
    var u = t.unit || {}, d = t.detail || {};
    out.push({ label: 'Document status', value: u.pending ? flowDPendingText_(u.pending) : '', optional: true },
             { label: 'Purchase trace', value: d.trace || '' },
             { label: 'Adjustment explained by', value: d.explained || '', optional: true },
             { label: 'Other notes on the receipt', value: d.other_notes || '', optional: true },
             { label: 'Invoices in NAV', value: d.invoice_status || '' });
  }
  return out;
}

/** The export as a table: fixed columns, then ONE COLUMN PER CARD FIELD (the union of the fields
 *  of the task types this preparer actually has, in card order), then files and comments.
 *  Returns { headers, rows, numericCols (1-based), widths }. */
function myTasksTable_(tasks) {
  var lead = ['Request', 'Sample', 'Company', 'Vendor', 'Subpopulation / type', 'Evidence / task', 'Documents to collect', 'Status', 'Due date'];
  var tail = ['Files uploaded', 'Note from reviewer', 'My comment'];
  var mid = [], at = {}, numeric = {};
  var cards = tasks.map(function (t) {
    var byLabel = {};
    cardFieldsExport_(t).forEach(function (f) {
      var empty = f.value === '' || f.value == null;
      if (f.optional && empty) return;
      if (!Object.prototype.hasOwnProperty.call(at, f.label)) { at[f.label] = mid.length; mid.push(f.label); }
      if (f.num) numeric[f.label] = 1;
      byLabel[f.label] = empty ? '' : f.value;
    });
    return byLabel;
  });
  var rows = tasks.map(function (t, i) {
    var slotLabel = {}; (t.slots || []).forEach(function (s) { slotLabel[s.key] = s.label; });
    var docs = (t.slots && t.slots.length)
      ? t.slots.map(function (s) { return s.label + (s.optional ? ' (optional)' : ''); }).join('\n')
      : (t.evidence_type + (t.optional ? ' (optional)' : ''));
    var files = (t.files || []).map(function (f) { return (slotLabel[f.slot] ? slotLabel[f.slot] + ': ' : '') + f.file_name; }).join('\n');
    return [t.request_title || '', t.document_no || '', t.company || '', cardVendorExport_(t), t.subpopulation || (t.mpl_type || ''),
            t.evidence_type || '', docs, String(t.status || '').replace(/_/g, ' '), t.due_date || '']
      .concat(mid.map(function (label) { var v = cards[i][label]; return v == null ? '' : v; }),
              [files, t.note || '', t.preparer_note || '']);
  });
  return {
    headers: lead.concat(mid, tail), rows: rows,
    numericCols: mid.map(function (label, i) { return numeric[label] ? lead.length + i + 1 : 0; }).filter(Number),
    widths: [180, 120, 90, 180, 150, 160, 200, 110, 100]
      .concat(mid.map(function (label) { return CA_WIDE_EXPORT_[label] ? 260 : 130; }), [220, 240, 240])
  };
}

function exportMyTasks() {
  var me = requireRole_([ROLES.PREPARER, ROLES.ADMIN]);
  var tasks = listMyAssignments();
  if (!tasks.length) throw new Error('You have no tasks to export yet.');

  var tb = myTasksTable_(tasks), H = tb.headers, rows = [H].concat(tb.rows);

  var name = sanitizeName_('My audit tasks - ' + me.email.split('@')[0]);
  var ss = SpreadsheetApp.create(name);
  try {
    var sh = ss.getSheets()[0].setName('My tasks');
    if (H.length > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), H.length - sh.getMaxColumns());
    if (rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows());
    // Text everywhere (a document / payment number must never become a number, a date or a formula),
    // except the amount columns, which stay numbers so they can be summed.
    sh.getRange(1, 1, rows.length, H.length).setNumberFormat('@');
    tb.numericCols.forEach(function (c) { sh.getRange(2, c, rows.length - 1, 1).setNumberFormat('#,##0.00'); });
    sh.getRange(1, 1, rows.length, H.length).setValues(rows);
    sh.setFrozenRows(1); sh.getRange(1, 1, 1, H.length).setFontWeight('bold');
    sh.getRange(1, 1, rows.length, H.length).setVerticalAlignment('top').setWrap(true);
    tb.widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
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
    // Flow D: a purchase-invoice task whose invoice NAV does not show yet (`pending` on the
    // task) may be submitted with a comment alone — the auditor is told the invoice is still
    // to be received. Everything else needs a file.
    if (!parseJson_(asg.detail_json).pending) throw new Error('Upload at least one evidence file before submitting.');
    if (!String(note || '').trim()) throw new Error('No file on this task: add a comment for the reviewer saying why (for example, the invoice has not been received yet), or upload the document.');
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
  if (parseJson_(asg.detail_json).kind === 'system') throw new Error('A system reconciliation cannot be withdrawn.');
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
