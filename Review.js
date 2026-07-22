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

var STAGE_STATUS = { review: 'pending_review', audit: 'pending_audit' };

function stageRoles_(stage) {
  return stage === 'audit' ? [ROLES.AUDITOR, ROLES.ADMIN] : [ROLES.REVIEWER, ROLES.ADMIN];
}

/* ---------- read ---------- */
function reviewQueue(stage) {
  var me = requireRole_(stageRoles_(stage));
  var want = STAGE_STATUS[stage];
  var ds = dataSs_();
  var tz = ds.getSpreadsheetTimeZone();
  var lines = readObjects_(ds, 'Sample_Lines');
  return readObjects_(ds, 'Requests').filter(function (r) {
    // The reviewer is set per request; a Reviewer sees only their own (admins see all).
    return stage !== 'review' || me.role === ROLES.ADMIN ||
           String(r.reviewer_email || '').toLowerCase() === me.email.toLowerCase();
  }).map(function (r) {
    var rid = String(r.request_id);
    var rl = lines.filter(function (l) { return String(l.request_id) === rid; });
    var pending = rl.filter(function (l) { return String(l.status).toLowerCase() === want; }).length;
    return {
      request_id: r.request_id, title: r.title, period: r.period, status: r.status,
      request_ref: r.request_ref || '', due_date: toDateStr_(r.due_date, tz),
      created_at: r.created_at, lineCount: rl.length, pendingCount: pending, progress: progressOf_(rl)
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
  if (stage === 'review' && me.role !== ROLES.ADMIN &&
      String(req.reviewer_email || '').toLowerCase() !== me.email.toLowerCase()) {
    throw new Error('This request is assigned to a different reviewer.');
  }

  // Evidence is served through the app (getEvidenceFile) — we no longer share
  // files on Drive, so reviewers/auditors get no "shared with you" emails.
  var evByAsg = {};
  readObjects_(ds, 'Evidence')
    .filter(function (e) { return String(e.request_id) === String(requestId); })
    .forEach(function (e) {
      (evByAsg[e.assignment_id] = evByAsg[e.assignment_id] || []).push({
        evidence_id: e.evidence_id, file_name: e.file_name, mime: e.mime || ''
      });
    });

  var asgByLine = {};
  readObjects_(ds, 'Assignments')
    .filter(function (a) { return String(a.request_id) === String(requestId); })
    .forEach(function (a) { (asgByLine[a.line_id] = asgByLine[a.line_id] || []).push(a); });

  var tz = ds.getSpreadsheetTimeZone();
  var lines = readObjects_(ds, 'Sample_Lines')
    .filter(function (l) { return String(l.request_id) === String(requestId); })
    .map(function (l) {
      return {
        line_id: l.line_id, document_no: l.document_no, company: l.company, vendor: l.vendor,
        mpl_type: l.mpl_type, paid_status: l.paid_status, statement_code: l.statement_code,
        amount: l.amount, closing_balance: l.closing_balance, paid_at: toDateStr_(l.paid_at, tz),
        status: l.status, note: l.note || '',
        ai_verdict: l.ai_verdict || '', ai_summary: l.ai_summary || '', ai_checked_at: l.ai_checked_at || '',
        assignments: (asgByLine[l.line_id] || []).map(function (a) {
          return { evidence_type: a.evidence_type, assigned_to: a.assigned_to, status: a.status, files: evByAsg[a.assignment_id] || [] };
        })
      };
    });
  return { request: req, stage: stage, actionable: STAGE_STATUS[stage], lines: lines };
}

/**
 * Stream one evidence file to the client as a data URL (app-mediated — the file
 * is never shared on Drive). Reviewer/Auditor/Admin may fetch any; a Preparer
 * only their own uploads.
 */
function getEvidenceFile(evidenceId) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.AUDITOR, ROLES.ADMIN, ROLES.PREPARER]);
  var ev = readObjects_(dataSs_(), 'Evidence').filter(function (e) { return String(e.evidence_id) === String(evidenceId); })[0];
  if (!ev) throw new Error('File not found.');
  if (me.role === ROLES.PREPARER && String(ev.uploaded_by).toLowerCase() !== me.email.toLowerCase()) {
    throw new Error('That file is not yours.');
  }
  var blob = DriveApp.getFileById(ev.file_id).getBlob();
  var bytes = blob.getBytes();
  if (bytes.length > 12 * 1024 * 1024) throw new Error('File is too large to preview here (' + Math.round(bytes.length / 1048576) + ' MB). Open it in Drive instead.');
  var mime = blob.getContentType();
  return { name: ev.file_name, mime: mime, size: bytes.length, dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(bytes) };
}

/* ---------- AI pre-check (review stage) ---------- */
/**
 * Ask Gemini to compare each of a line's submitted documents against its expected
 * evidence type + the sampled transaction's data, and report accept / reject /
 * uncertain. The overall verdict is the worst of the per-document verdicts. The
 * result is persisted on the line (ai_verdict/ai_summary/ai_checked_at) and logged,
 * so the SOX trail records what the AI said before the reviewer decided.
 *
 * Advisory only: it gates the *client* Submit button, but the human reviewer always
 * decides and can override a non-accept verdict with a signed confirmation.
 */
function assessLine(lineId) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'pending_review');
  assertReviewer_(line.request_id, me);
  var ds = dataSs_();

  var typeByAsg = {};
  getAssignments(lineId).forEach(function (a) { typeByAsg[String(a.assignment_id)] = a.evidence_type; });
  var docs = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.line_id) === String(lineId); });
  if (!docs.length) throw new Error('No evidence documents to assess on this line.');

  var facts = [
    'Seller / vendor: ' + (line.vendor || '—'),
    'Document / transaction no.: ' + (line.document_no || '—'),
    'Statement number: ' + (line.statement_code || '—'),
    'Transaction amount: ' + (line.amount != null && line.amount !== '' ? line.amount : '—'),
    'Statement balance: ' + (line.closing_balance != null && line.closing_balance !== '' ? line.closing_balance : '—'),
    'Paid-at date: ' + (line.paid_at || '(not paid)'),
    'MPL type: ' + (/advance/i.test(String(line.mpl_type)) ? 'MPL advance' : 'Regular')
  ].join('\n');

  var system =
    'You are a meticulous financial-audit evidence reviewer at Jumia. For each document you are given: ' +
    'the type of evidence it is meant to be, the sampled transaction\'s known data, and the document itself (image or PDF). ' +
    'Judge whether the document (a) is the correct KIND of evidence for that type, and (b) corroborates the transaction data. ' +
    'Minor formatting or layout differences are fine; material mismatches (wrong party, wrong amount, wrong date, wrong document) are not. ' +
    'Return verdict "accept" only when it is clearly valid, "reject" when it is the wrong document or contradicts the data, and ' +
    '"uncertain" when the document is unreadable or you cannot confirm. Keep the summary under 240 characters and specific.';

  var perDoc = [], worst = 'accept';
  docs.forEach(function (e) {
    var etype = typeByAsg[String(e.assignment_id)] || 'evidence';
    var blob;
    try { blob = DriveApp.getFileById(e.file_id).getBlob(); }
    catch (err) { perDoc.push({ file: e.file_name, type: etype, verdict: 'uncertain', summary: 'Could not open the file in Drive.' }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var bytes = blob.getBytes();
    if (bytes.length > 12 * 1024 * 1024) { perDoc.push({ file: e.file_name, type: etype, verdict: 'uncertain', summary: 'File too large to assess (' + Math.round(bytes.length / 1048576) + ' MB).' }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var prompt = 'Expected evidence type: "' + etype + '".\n\nSampled transaction data:\n' + facts + '\n\nAssess the attached document (file name: ' + e.file_name + ').';
    var res;
    try { res = geminiAssess_(system, prompt, { mimeType: blob.getContentType(), bytes: bytes }); }
    catch (err) { perDoc.push({ file: e.file_name, type: etype, verdict: 'uncertain', summary: 'AI error: ' + (err.message || err) }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var v = String(res.verdict || 'uncertain').toLowerCase();
    if (['accept', 'reject', 'uncertain'].indexOf(v) === -1) v = 'uncertain';
    perDoc.push({ file: e.file_name, type: etype, verdict: v, summary: String(res.summary || '') });
    worst = worseVerdict_(worst, v);
  });

  var summary = perDoc.map(function (p) { return p.file + ' → ' + p.verdict + (p.summary ? (': ' + p.summary) : ''); }).join('  |  ');
  var at = nowIso_();
  updateRowById_(ds, 'Sample_Lines', 'line_id', lineId, { ai_verdict: worst, ai_summary: summary.substring(0, 900), ai_checked_at: at });
  logActivity('AI_CHECK', 'line', lineId, 'verdict=' + worst + ' :: ' + summary.substring(0, 400));
  return { verdict: worst, perDoc: perDoc, checkedAt: at };
}

// accept < uncertain < reject — the overall verdict is the worst of the documents'.
function worseVerdict_(a, b) {
  var rank = { accept: 0, uncertain: 1, reject: 2 };
  return (rank[b] > rank[a]) ? b : a;
}

/* ---------- reviewer actions ---------- */
function reviewerSubmit(lineId, override) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'pending_review');
  assertReviewer_(line.request_id, me);
  var verdict = String(line.ai_verdict || '').toLowerCase();
  if (!verdict) throw new Error('Run the AI check before submitting this line to the auditor.');
  if (verdict !== 'accept' && !override) {
    throw new Error('The AI flagged this evidence (' + verdict + '). Tick the confirmation to proceed anyway.');
  }
  getAssignments(lineId).forEach(function (a) {
    if (String(a.status).toLowerCase() === 'submitted') {
      updateRowById_(dataSs_(), 'Assignments', 'assignment_id', a.assignment_id, { status: 'reviewed' });
    }
  });
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'pending_audit', note: '' });
  logActivity('REVIEW_SUBMIT', 'line', lineId,
    'to auditor (AI ' + verdict + (verdict !== 'accept' ? '; reviewer override' : '') + ')');
  return reviewDetail(line.request_id, 'review');
}

function reviewerReturn(lineId, note) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var line = requireLineStatus_(lineId, 'pending_review');
  assertReviewer_(line.request_id, me);
  reopenLineAssignments_(lineId);
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'in_progress', note: 'Returned by reviewer: ' + note });
  logActivity('REVIEW_RETURN', 'line', lineId, note);
  return reviewDetail(line.request_id, 'review');
}

/* ---------- auditor actions ---------- */
function auditorClose(lineId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'pending_audit');
  getAssignments(lineId).forEach(function (a) {
    if (['submitted', 'reviewed'].indexOf(String(a.status).toLowerCase()) !== -1) {
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
  var line = requireLineStatus_(lineId, 'pending_audit');
  reopenLineAssignments_(lineId);
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'in_progress', note: 'Returned by auditor: ' + note });
  logActivity('AUDIT_RETURN', 'line', lineId, note);
  return reviewDetail(line.request_id, 'audit');
}

/* ---------- helpers ---------- */
function assertReviewer_(requestId, me) {
  if (me.role === ROLES.ADMIN) return;
  var req = findRequest_(requestId);
  if (!req || String(req.reviewer_email || '').toLowerCase() !== me.email.toLowerCase()) {
    throw new Error('You are not the reviewer for this request.');
  }
}

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
    if (['submitted', 'reviewed', 'accepted'].indexOf(String(a.status).toLowerCase()) !== -1) {
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
