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
  var asg = readObjects_(ds, 'Assignments');
  return readObjects_(ds, 'Requests').filter(function (r) {
    // The reviewer is set per request; a Reviewer sees only their own (admins see all).
    return stage !== 'review' || me.role === ROLES.ADMIN ||
           String(r.reviewer_email || '').toLowerCase() === me.email.toLowerCase();
  }).map(function (r) {
    var rid = String(r.request_id);
    var rl = lines.filter(function (l) { return String(l.request_id) === rid; });
    var ra = asg.filter(function (a) { return String(a.request_id) === rid; });
    var pending = rl.filter(function (l) { return String(l.status).toLowerCase() === want; }).length;
    return {
      request_id: r.request_id, title: r.title, period: r.period, status: r.status,
      request_ref: r.request_ref || '', due_date: toDateStr_(r.due_date, tz),
      created_at: r.created_at, lineCount: rl.length, pendingCount: pending, progress: progressOf_(rl),
      taskCount: ra.length, taskProgress: progressOf_(ra)
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
        evidence_id: e.evidence_id, file_name: e.file_name, mime: e.mime || '', slot: e.slot || ''
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
        subpopulation: l.subpopulation || '', detail: parseJson_(l.detail_json),
        ai_verdict: l.ai_verdict || '', ai_summary: l.ai_summary || '', ai_checked_at: l.ai_checked_at || '',
        assignments: (asgByLine[l.line_id] || []).map(function (a) {
          var slts = parseJson_(a.slots_json); if (!Array.isArray(slts)) slts = [];
          return { assignment_id: a.assignment_id, evidence_type: a.evidence_type, assigned_to: a.assigned_to, status: a.status,
                   optional: isOptional_(a.optional), unit: parseJson_(a.detail_json), slots: slts, files: evByAsg[a.assignment_id] || [],
                   ai_verdict: a.ai_verdict || '', ai_summary: a.ai_summary || '' };
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

/**
 * Full history of one task (sample line): every status change, human note and AI
 * assessment, oldest first. Pulls the line's own Activity_Log entries plus those of
 * its assignments (uploads, submits, withdrawals). Any role that can see the task
 * may read it; a preparer only for a line they're assigned on.
 */
function taskTimeline(lineId) {
  var me = requireRole_([ROLES.PREPARER, ROLES.REVIEWER, ROLES.AUDITOR, ROLES.ADMIN]);
  var ds = dataSs_();
  var line = findLine_(lineId);
  if (!line) throw new Error('Task not found.');
  var asgs = getAssignments(lineId);
  if (me.role === ROLES.PREPARER &&
      !asgs.some(function (a) { return String(a.assigned_to || '').toLowerCase() === me.email.toLowerCase(); })) {
    throw new Error('This task is not assigned to you.');
  }
  var typeByAsg = {}; asgs.forEach(function (a) { typeByAsg[String(a.assignment_id)] = a.evidence_type; });

  var events = readObjects_(ds, 'Activity_Log').filter(function (e) {
    return (String(e.entity_type) === 'line' && String(e.entity_id) === String(lineId)) ||
           (String(e.entity_type) === 'assignment' && typeByAsg[String(e.entity_id)] != null);
  }).map(function (e) {
    return {
      ts: e.ts, actor: e.actor, action: e.action, details: e.details,
      evidence_type: String(e.entity_type) === 'assignment' ? (typeByAsg[String(e.entity_id)] || '') : ''
    };
  }).sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });

  return { line: { line_id: line.line_id, document_no: line.document_no, vendor: line.vendor, status: line.status }, events: events };
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
 *
 * Reviewer entry point: guards role + status, then runs the check.
 */
function assessLine(lineId) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'pending_review');
  assertReviewer_(line.request_id, me);
  return assessLineCore_(lineId, line, 'reviewer');
}

/**
 * When a line first reaches pending_review (every preparer has submitted), the AI
 * check should run so the reviewer opens to a ready verdict — but NOT on the
 * preparer's submit thread. Instead we schedule a one-off, near-immediate time
 * trigger and return at once; the preparer keeps working while the assessment lands
 * a few moments later (Apps Script has no threads, so a trigger is the "background").
 *
 * Deduped via a Script Property so rapid submits don't pile up triggers; skipped
 * entirely when no key is configured. Never allowed to break the caller's action.
 */
function scheduleAiCheck_() {
  try {
    if (!PropertiesService.getScriptProperties().getProperty(GEMINI.API_KEY_PROP)) return;   // not configured yet
    // Dedupe on the actual trigger list (not a flag that can get stuck): if one is
    // already pending, let it pick up every ready line when it runs.
    var pending = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runQueuedAiChecks_'; });
    if (pending) return;
    ScriptApp.newTrigger('runQueuedAiChecks_').timeBased().after(3 * 1000).create();
  } catch (e) {
    Logger.log('scheduleAiCheck_ failed (non-fatal — background AI check needs the script.scriptapp scope authorized): ' + e);
  }
}

/**
 * Trigger handler: assess every pending_review line with no verdict yet, then delete
 * its own trigger(s). Runs as the deployer, so it has the key + Drive + external_request.
 * Idempotent (skips already-assessed lines), so overlapping runs are harmless.
 */
function runQueuedAiChecks_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'runQueuedAiChecks_') ScriptApp.deleteTrigger(t);
    });
  } catch (e) { Logger.log('runQueuedAiChecks_ cleanup: ' + e); }
  assessPendingLines_();
}

/**
 * Assess all pending_review lines that still lack a verdict. Shared by the background
 * trigger and by processAiChecksNow(). Skipped when no key is configured.
 */
function assessPendingLines_() {
  if (!PropertiesService.getScriptProperties().getProperty(GEMINI.API_KEY_PROP)) return 0;
  var lines = readObjects_(dataSs_(), 'Sample_Lines')
    .filter(function (l) { return String(l.status).toLowerCase() === 'pending_review' && !String(l.ai_verdict || '').trim(); });
  lines.forEach(function (l) {
    try { assessLineCore_(l.line_id, l, 'auto'); }
    catch (e) { logActivity('AI_CHECK_ERROR', 'line', l.line_id, String(e && e.message || e)); }
  });
  return lines.length;
}

/** Editor / admin catch-up: assess any pending_review lines missing a verdict right
 *  now (no trigger involved — only needs the Gemini scope). Handy to backfill or test. */
function processAiChecksNow() {
  requireRole_([ROLES.ADMIN]);
  var n = assessPendingLines_();
  Logger.log('processAiChecksNow assessed ' + n + ' line(s).');
  return { assessed: n };
}

/** The actual assessment — no role/status guards, so both the reviewer button and
 *  the auto-on-submit path can use it. `how` labels the trail ('reviewer' | 'auto'). */
function assessLineCore_(lineId, line, how) {
  var ds = dataSs_();
  if (!line) { line = findLine_(lineId); if (!line) throw new Error('Sample not found.'); }
  var detail = parseJson_(line.detail_json);
  var sub = String(line.subpopulation || '');
  var typeByAsg = {};
  getAssignments(lineId).forEach(function (a) { typeByAsg[String(a.assignment_id)] = a.evidence_type; });
  var docs = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.line_id) === String(lineId); });
  if (!docs.length) throw new Error('No evidence documents to assess on this sample.');

  // Voucher = two-image cross-check; Cash & POS = one verdict per payment task;
  // everything else = per-document.
  var result = (sub === 'Prepaid - Voucher') ? assessVoucher_(line, detail, docs)
    : (sub === 'Postpaid - Cash & POS') ? assessCashPos_(lineId, line, ds)
    : assessPerDoc_(line, detail, sub, docs, typeByAsg);

  var at = nowIso_();
  updateRowById_(ds, 'Sample_Lines', 'line_id', lineId, { ai_verdict: result.verdict, ai_summary: String(result.summary || '').substring(0, 900), ai_checked_at: at });
  logActivity('AI_CHECK', 'line', lineId, (how === 'auto' ? 'auto on submit · ' : '') + 'verdict=' + result.verdict + ' :: ' + String(result.summary || '').substring(0, 400));
  return { verdict: result.verdict, perDoc: result.perDoc, checkedAt: at };
}

/** Load an evidence file's bytes (with a size guard). Returns {bytes,mime} or {err}. */
function loadEvidenceBytes_(e) {
  try {
    var blob = DriveApp.getFileById(e.file_id).getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > 12 * 1024 * 1024) return { err: 'File too large to assess (' + Math.round(bytes.length / 1048576) + ' MB).' };
    return { bytes: bytes, mime: blob.getContentType() };
  } catch (err) { return { err: 'Could not open the file in Drive.' }; }
}

/** Sampled data given to the model, by flow. Flow B leads with the ORDER NUMBER and
 *  explicitly flags the sales-order-item so the model never matches on the wrong one. */
function buildFacts_(line, detail, sub) {
  if (sub) {
    var f = [
      'Subpopulation: ' + sub,
      'Company: ' + (line.company || '—'),
      'Order number: ' + (detail.order_nr || '—'),
      'Sales-order-item number (an item id — NOT the order number): ' + (line.document_no || '—')
    ];
    if (detail.jp_gateway || detail.jp_provider) f.push('Payment gateway / provider: ' + [detail.jp_gateway, detail.jp_provider].filter(Boolean).join(' / '));
    if (detail.jp_retrieval) f.push('Retrieval reference: ' + detail.jp_retrieval);
    if (detail.payment_no)   f.push('Payment number: ' + detail.payment_no);
    if (detail.payment_ref)  f.push('Payment reference: ' + detail.payment_ref);
    if (detail.bank_account) f.push('Bank account: ' + detail.bank_account);
    if (line.amount != null && line.amount !== '') f.push('Amount: ' + line.amount);
    return f.join('\n');
  }
  return [
    'Seller / vendor: ' + (line.vendor || '—'),
    'Document / transaction no.: ' + (line.document_no || '—'),
    'Statement number: ' + (line.statement_code || '—'),
    'Recorded transaction amount: ' + (line.amount != null && line.amount !== '' ? line.amount : '—'),
    'Statement balance: ' + (line.closing_balance != null && line.closing_balance !== '' ? line.closing_balance : '—'),
    'Paid-at date: ' + (String(line.paid_at || '').slice(0, 10) || '(not recorded as paid)'),
    'MPL type: ' + (/advance/i.test(String(line.mpl_type)) ? 'MPL advance' : 'Regular')
  ].join('\n');
}

/** Generic per-document assessment (Flow A + non-voucher Cash Anchor subpopulations). */
function assessPerDoc_(line, detail, sub, docs, typeByAsg) {
  var facts = buildFacts_(line, detail, sub);
  var system =
    'You are a meticulous financial-audit evidence reviewer at Jumia. You receive, per document: the type of ' +
    'evidence it should be, the sampled transaction\'s recorded data, and the document itself (image or PDF). ' +
    'Decide whether the document is acceptable evidence for that item, judging two things: ' +
    '(1) TYPE — is it the right KIND of document for the expected evidence type? ' +
    '(2) MATCH — does it plausibly correspond to the SAME transaction, using the strongest identifiers available. ' +
    'When an order number is provided, match on the ORDER NUMBER, not the sales-order-item number (they are different). ' +
    'Be strict about substance but tolerant of form: the recorded amount may be negative (an accounting sign) or in a ' +
    'different currency or number format than the document — compare the underlying magnitude and identity, not the exact ' +
    'sign or formatting, and do not expect every recorded field to appear on the document. ' +
    'Return "accept" when it is clearly the right kind of document and nothing material contradicts the transaction; ' +
    '"reject" when it is the wrong kind of document or a material detail clearly contradicts the data (wrong party, wrong ' +
    'amount, wrong date); "uncertain" when the document is unreadable or you cannot reasonably confirm. ' +
    'Give a specific one-sentence summary (under 240 characters) citing the key evidence for your verdict.';

  var perDoc = [], worst = 'accept';
  docs.forEach(function (e) {
    var etype = typeByAsg[String(e.assignment_id)] || 'evidence';
    var d = loadEvidenceBytes_(e);
    if (d.err) { perDoc.push({ file: e.file_name, type: etype, verdict: 'uncertain', summary: d.err }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var prompt = 'Expected evidence type: "' + etype + '".\n\nSampled data:\n' + facts + '\n\nAssess the attached document (file name: ' + e.file_name + ').';
    var res;
    try { res = geminiAssess_(system, prompt, { mimeType: d.mime, bytes: d.bytes }); }
    catch (err) { perDoc.push({ file: e.file_name, type: etype, verdict: 'uncertain', summary: 'AI error: ' + (err.message || err) }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var v = String(res.verdict || 'uncertain').toLowerCase();
    if (['accept', 'reject', 'uncertain'].indexOf(v) === -1) v = 'uncertain';
    perDoc.push({ file: e.file_name, type: etype, verdict: v, summary: String(res.summary || '') });
    worst = worseVerdict_(worst, v);
  });
  return { verdict: worst, summary: perDoc.map(function (p) { return p.file + ' → ' + p.verdict + (p.summary ? (': ' + p.summary) : ''); }).join('  |  '), perDoc: perDoc };
}

/**
 * Voucher: cross-check the two screenshots together.
 *   1) the ORDER NUMBER in the OMS screenshot == the sample's order number (NOT the SOI);
 *   2) the voucher code in the OMS screenshot == the voucher code in the BOB screenshot.
 * Both images go in one call so the model can compare the codes across them.
 */
function assessVoucher_(line, detail, docs) {
  var bob = docs.filter(function (e) { return String(e.slot) === 'bob_voucher_screenshot'; })[0];
  var oms = docs.filter(function (e) { return String(e.slot) === 'oms_screenshot'; })[0];
  if (!bob || !oms) return { verdict: 'uncertain', summary: 'Both the OMS and BOB screenshots are needed to cross-check the voucher.', perDoc: [] };
  var o = loadEvidenceBytes_(oms), b = loadEvidenceBytes_(bob);
  if (o.err || b.err) return { verdict: 'uncertain', summary: (o.err || b.err), perDoc: [] };

  var system =
    'You are a meticulous financial-audit evidence reviewer at Jumia verifying a VOUCHER sample. You are given two ' +
    'screenshots: an OMS screenshot (Jumia\'s order management system) and a BOB screenshot (the back-office system where ' +
    'vouchers are created). Perform exactly two cross-checks, and accept ONLY if both hold:\n' +
    '1) ORDER NUMBER — the order number shown in the OMS screenshot must equal the sampled order number given below. ' +
    'Match on the ORDER NUMBER only; it is DIFFERENT from the sales-order-item number — never compare against the sales-order-item.\n' +
    '2) VOUCHER CODE — the voucher code shown in the OMS screenshot must match the voucher code shown in the BOB screenshot.\n' +
    'Return "accept" if both checks pass; "reject" if either clearly fails (say which and cite the values); "uncertain" if a ' +
    'screenshot is unreadable or a value cannot be located. One specific sentence (<240 chars) citing the order number and voucher code compared.';
  var prompt =
    'Sampled ORDER NUMBER (use this for check 1): ' + (detail.order_nr || '—') + '\n' +
    'Sales-order-item number (reference only — do NOT use for check 1): ' + (line.document_no || '—') + '\n' +
    'Company: ' + (line.company || '—') + '\n\n' +
    'The first image is the OMS screenshot; the second image is the BOB screenshot.';
  var res;
  try {
    res = geminiAssess_(system, prompt, [
      { mimeType: o.mime, bytes: o.bytes, label: 'OMS screenshot (' + oms.file_name + ')' },
      { mimeType: b.mime, bytes: b.bytes, label: 'BOB screenshot (' + bob.file_name + ')' }
    ]);
  } catch (err) { return { verdict: 'uncertain', summary: 'AI error: ' + (err.message || err), perDoc: [] }; }
  var v = String(res.verdict || 'uncertain').toLowerCase();
  if (['accept', 'reject', 'uncertain'].indexOf(v) === -1) v = 'uncertain';
  var sm = String(res.summary || '');
  return { verdict: v, summary: sm, perDoc: [{ file: 'OMS + BOB screenshots', type: 'Voucher evidence', verdict: v, summary: sm }] };
}

// accept < uncertain < reject — the overall verdict is the worst of the documents'.
function worseVerdict_(a, b) {
  var rank = { accept: 0, uncertain: 1, reject: 2 };
  return (rank[b] > rank[a]) ? b : a;
}

/* ---------- per-assignment (per-payment) AI check — Cash & POS ---------- */
/** Assess one Cash & POS payment task's proof of payment against that payment's data. */
function assessAssignmentCore_(asg, line) {
  var ds = dataSs_();
  var files = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.assignment_id) === String(asg.assignment_id); });
  if (!files.length) return { verdict: 'uncertain', summary: 'No file uploaded for this task.', perDoc: [] };
  var unit = parseJson_(asg.detail_json), ldet = parseJson_(line.detail_json);
  var facts = [
    'Company: ' + (line.company || '—'),
    'Order number: ' + (ldet.order_nr || '—'),
    'Payment number: ' + (unit.payment_no || '—'),
    'Payment date: ' + (String(unit.payment_date || '').slice(0, 10) || '—'),
    'Payment reference: ' + (unit.payment_ref || '—'),
    'Bank account: ' + (unit.bank_account || '—'),
    'Amount received: ' + (unit.amount != null && unit.amount !== '' ? unit.amount : '—')
  ].join('\n');
  var system =
    'You are a meticulous financial-audit evidence reviewer at Jumia checking the proof of payment for a single cash ' +
    'remittance. Confirm the document IS a proof of payment (bank / wallet transfer receipt or statement line) and that ' +
    'it corroborates the payment below, matching on the strongest available identifiers (amount, bank account, value ' +
    'date, payment reference). Tolerate formatting/currency-format differences; focus on substance. Return "accept" when ' +
    'it is clearly a proof of payment and nothing material contradicts the recorded payment; "reject" when it is the wrong ' +
    'kind of document or a material detail clearly contradicts it; "uncertain" when unreadable or unverifiable. Give one ' +
    'specific sentence (<240 chars) citing the amount / reference you compared.';
  var perDoc = [], worst = 'accept';
  files.forEach(function (e) {
    var d = loadEvidenceBytes_(e);
    if (d.err) { perDoc.push({ file: e.file_name, verdict: 'uncertain', summary: d.err }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var prompt = 'Expected evidence type: "' + (asg.evidence_type || 'Proof of payment') + '".\n\nPayment data:\n' + facts + '\n\nAssess the attached document (file name: ' + e.file_name + ').';
    var res;
    try { res = geminiAssess_(system, prompt, { mimeType: d.mime, bytes: d.bytes }); }
    catch (err) { perDoc.push({ file: e.file_name, verdict: 'uncertain', summary: 'AI error: ' + (err.message || err) }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var v = String(res.verdict || 'uncertain').toLowerCase(); if (['accept', 'reject', 'uncertain'].indexOf(v) === -1) v = 'uncertain';
    perDoc.push({ file: e.file_name, verdict: v, summary: String(res.summary || '') });
    worst = worseVerdict_(worst, v);
  });
  return { verdict: worst, summary: perDoc.map(function (p) { return p.file + ' → ' + p.verdict + (p.summary ? (': ' + p.summary) : ''); }).join('  |  '), perDoc: perDoc };
}

/** Cash & POS line assessment = assess each payment task that has no verdict yet; the
 *  line's verdict is the worst of them (kept so the background sweep won't re-run). */
function assessCashPos_(lineId, line, ds) {
  var items = getAssignments(lineId), worst = 'accept', per = [];
  items.forEach(function (a) {
    var v = String(a.ai_verdict || '').toLowerCase(), sm = String(a.ai_summary || '');
    if (!v) {
      var r = assessAssignmentCore_(a, line);
      v = r.verdict; sm = String(r.summary || '');
      updateRowById_(ds, 'Assignments', 'assignment_id', a.assignment_id, { ai_verdict: v, ai_summary: sm.substring(0, 900), ai_checked_at: nowIso_() });
    }
    per.push({ file: (parseJson_(a.detail_json).payment_no || a.evidence_type), verdict: v, summary: sm });
    worst = worseVerdict_(worst, v);
  });
  return { verdict: worst, summary: 'Per payment: ' + per.map(function (p) { return p.file + '→' + p.verdict; }).join(', '), perDoc: per };
}

/** Reviewer button: (re)assess one payment task's proof of payment and store the verdict. */
function assessAssignment(assignmentId) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  assertReviewer_(asg.request_id, me);
  var line = requireLineStatus_(asg.line_id, 'pending_review');
  var r = assessAssignmentCore_(asg, line);
  var at = nowIso_();
  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { ai_verdict: r.verdict, ai_summary: String(r.summary || '').substring(0, 900), ai_checked_at: at });
  logActivity('AI_CHECK', 'line', asg.line_id, 'payment ' + (parseJson_(asg.detail_json).payment_no || '') + ' → ' + r.verdict + ' :: ' + String(r.summary || '').substring(0, 300));
  return { verdict: r.verdict, perDoc: r.perDoc, checkedAt: at };
}

/* ---------- reviewer actions ---------- */
function reviewerSubmit(lineId, override, note) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var line = requireLineStatus_(lineId, 'pending_review');
  assertReviewer_(line.request_id, me);
  var verdict = String(line.ai_verdict || '').toLowerCase();
  if (!verdict) throw new Error('Run the AI check before submitting this sample to the auditor.');
  if (verdict !== 'accept' && !override) {
    throw new Error('The AI flagged this evidence (' + verdict + '). Tick the confirmation to proceed anyway.');
  }
  getAssignments(lineId).forEach(function (a) {
    if (String(a.status).toLowerCase() === 'submitted') {
      updateRowById_(dataSs_(), 'Assignments', 'assignment_id', a.assignment_id, { status: 'reviewed' });
    }
  });
  note = String(note || '').trim();
  // Keep the reviewer's comment on the sample so the auditor sees it, and in the trail.
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', lineId, { status: 'pending_audit', note: note ? ('Reviewer: ' + note) : '' });
  logActivity('REVIEW_SUBMIT', 'line', lineId,
    'to auditor (AI ' + verdict + (verdict !== 'accept' ? '; reviewer override' : '') + ')' + (note ? ' — ' + note : ''));
  return reviewDetail(line.request_id, 'review');
}

/* ---------- per-subtask review (Cash & POS: one payment task at a time) ---------- */
/**
 * Mark ONE submitted task (a single payment) as reviewed. When every required task of
 * the line is reviewed, the line advances to the auditor — so the reviewer works
 * payment-by-payment instead of the whole line at once. No AI gate at this level.
 */
function reviewerSubmitTask(assignmentId, override, note) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  assertReviewer_(asg.request_id, me);
  var line = requireLineStatus_(asg.line_id, 'pending_review');
  if (String(asg.status).toLowerCase() !== 'submitted') throw new Error('Only a submitted task can be reviewed (now: ' + asg.status + ').');
  var verdict = String(asg.ai_verdict || '').toLowerCase();
  if (!verdict) throw new Error('Run the AI check before submitting this payment to the auditor.');
  if (verdict !== 'accept' && !override) throw new Error('The AI flagged this payment (' + verdict + '). Tick the confirmation to proceed anyway.');

  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'reviewed' });

  var items = getAssignments(asg.line_id);
  var required = items.filter(function (a) { return !isOptional_(a.optional); });
  var gate = required.length ? required : items;
  var allReviewed = gate.every(function (a) { return ['reviewed', 'accepted'].indexOf(String(a.status).toLowerCase()) !== -1; });
  if (allReviewed) updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', asg.line_id, { status: 'pending_audit', note: '' });

  note = String(note || '').trim();
  logActivity('REVIEW_SUBMIT_TASK', 'line', asg.line_id, 'payment reviewed (' + (parseJson_(asg.detail_json).payment_no || asg.evidence_type || '') + '; AI ' + verdict + (verdict !== 'accept' ? ', override' : '') + ')' + (allReviewed ? ' — sample to auditor' : '') + (note ? ' — ' + note : ''));
  return reviewDetail(asg.request_id, 'review');
}

/** Return ONE payment task to its preparer; the whole line drops back to in_progress
 *  so that payment can be redone, while already-reviewed tasks keep their status. */
function reviewerReturnTask(assignmentId, note) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  assertReviewer_(asg.request_id, me);
  var line = requireLineStatus_(asg.line_id, 'pending_review');

  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'in_progress', submitted_at: '', ai_verdict: '', ai_summary: '', ai_checked_at: '' });
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', asg.line_id, { status: 'in_progress', note: 'Returned by reviewer (' + (parseJson_(asg.detail_json).payment_no || asg.evidence_type || 'task') + '): ' + note });
  logActivity('REVIEW_RETURN_TASK', 'line', asg.line_id, note);
  return reviewDetail(asg.request_id, 'review');
}

/* ---------- per-subtask audit (Cash & POS: close/return one payment at a time) ---------- */
/** Auditor accepts ONE reviewed payment. When every required payment is accepted the
 *  sample closes (and the request may close). */
function auditorCloseTask(assignmentId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  var line = requireLineStatus_(asg.line_id, 'pending_audit');
  if (['reviewed', 'submitted'].indexOf(String(asg.status).toLowerCase()) === -1) throw new Error('Only a reviewed task can be closed (now: ' + asg.status + ').');

  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'accepted' });

  var items = getAssignments(asg.line_id);
  var required = items.filter(function (a) { return !isOptional_(a.optional); });
  var gate = required.length ? required : items;
  var allAccepted = gate.every(function (a) { return String(a.status).toLowerCase() === 'accepted'; });
  note = String(note || '').trim();
  if (allAccepted) {
    updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', asg.line_id, { status: 'closed', note: note ? ('Closed: ' + note) : '' });
    recomputeRequestStatus_(asg.request_id);
  }
  logActivity('AUDIT_CLOSE_TASK', 'line', asg.line_id, 'payment closed (' + (parseJson_(asg.detail_json).payment_no || asg.evidence_type || '') + ')' + (allAccepted ? ' — sample closed' : '') + (note ? ' — ' + note : ''));
  return reviewDetail(asg.request_id, 'audit');
}

/** Auditor returns ONE payment; the sample drops to in_progress so it can be redone. */
function auditorReturnTask(assignmentId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  var line = requireLineStatus_(asg.line_id, 'pending_audit');

  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'in_progress', submitted_at: '', ai_verdict: '', ai_summary: '', ai_checked_at: '' });
  updateRowById_(dataSs_(), 'Sample_Lines', 'line_id', asg.line_id, { status: 'in_progress', note: 'Returned by auditor (' + (parseJson_(asg.detail_json).payment_no || asg.evidence_type || 'task') + '): ' + note });
  logActivity('AUDIT_RETURN_TASK', 'line', asg.line_id, note);
  return reviewDetail(asg.request_id, 'audit');
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
  if (!line) throw new Error('Sample not found.');
  if (String(line.status).toLowerCase() !== want) {
    throw new Error('This sample is no longer in the expected state (now: ' + line.status + ').');
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
