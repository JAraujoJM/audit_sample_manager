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
  var actTask = stage === 'audit' ? 'reviewed' : 'submitted';   // the TASK status this role acts on
  var tz = Session.getScriptTimeZone();
  var t = readTabsCached_(['Sample_Lines', 'Assignments', 'Requests']);
  var lines = t.Sample_Lines;
  var asg = t.Assignments;
  return t.Requests.filter(function (r) {
    // The reviewer is set per request; a Reviewer sees only their own (admins see all).
    return stage !== 'review' || me.role === ROLES.ADMIN ||
           String(r.reviewer_email || '').toLowerCase() === me.email.toLowerCase();
  }).map(function (r) {
    var rid = String(r.request_id);
    var rl = lines.filter(function (l) { return String(l.request_id) === rid; });
    var ra = asg.filter(function (a) { return String(a.request_id) === rid; });
    var byLine = {}; ra.forEach(function (a) { (byLine[String(a.line_id)] = byLine[String(a.line_id)] || []).push(a); });
    // "Pending" is task-based: a sample counts if ANY of its tasks is on this role's desk.
    var pending = rl.filter(function (l) {
      return (byLine[String(l.line_id)] || []).some(function (a) { return String(a.status).toLowerCase() === actTask; });
    }).length;
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
  var t = readTabsCached_(['Requests', 'Evidence', 'Assignments', 'Sample_Lines']);
  var req = t.Requests.filter(function (r) { return String(r.request_id) === String(requestId); })[0];
  if (!req) throw new Error('Request not found.');
  // SoD: the auditor never sees AI output — not on screen and not in the payload either
  // (until 20 Oct 2026 the verdicts reached the auditor's browser and were only hidden there).
  var noAi = stage === 'audit';
  if (stage === 'review' && me.role !== ROLES.ADMIN &&
      String(req.reviewer_email || '').toLowerCase() !== me.email.toLowerCase()) {
    throw new Error('This request is assigned to a different reviewer.');
  }

  // Evidence is served through the app (getEvidenceFile) — we no longer share
  // files on Drive, so reviewers/auditors get no "shared with you" emails.
  var evByAsg = {};
  t.Evidence
    .filter(function (e) { return String(e.request_id) === String(requestId); })
    .forEach(function (e) {
      (evByAsg[e.assignment_id] = evByAsg[e.assignment_id] || []).push({
        evidence_id: e.evidence_id, file_name: e.file_name, mime: e.mime || '', slot: e.slot || ''
      });
    });

  var asgByLine = {};
  t.Assignments
    .filter(function (a) { return String(a.request_id) === String(requestId); })
    .forEach(function (a) { (asgByLine[a.line_id] = asgByLine[a.line_id] || []).push(a); });

  var tz = Session.getScriptTimeZone();
  var lines = t.Sample_Lines
    .filter(function (l) { return String(l.request_id) === String(requestId); })
    .map(function (l) {
      return {
        line_id: l.line_id, document_no: l.document_no, company: l.company, vendor: l.vendor,
        mpl_type: l.mpl_type, paid_status: l.paid_status, statement_code: l.statement_code,
        amount: l.amount, closing_balance: l.closing_balance, paid_at: toDateStr_(l.paid_at, tz),
        status: l.status, note: l.note || '',
        subpopulation: l.subpopulation || '', detail: parseJson_(l.detail_json),
        ai_verdict: noAi ? '' : (l.ai_verdict || ''), ai_summary: noAi ? '' : (l.ai_summary || ''), ai_checked_at: noAi ? '' : (l.ai_checked_at || ''),
        assignments: (asgByLine[l.line_id] || []).map(function (a) {
          var slts = parseJson_(a.slots_json); if (!Array.isArray(slts)) slts = [];
          return { assignment_id: a.assignment_id, evidence_type: a.evidence_type, assigned_to: a.assigned_to, status: a.status,
                   optional: isOptional_(a.optional), unit: parseJson_(a.detail_json), slots: slts, files: evByAsg[a.assignment_id] || [],
                   note: a.notes || '', ai_verdict: noAi ? '' : (a.ai_verdict || ''), ai_summary: noAi ? '' : (a.ai_summary || ''),
                   // The preparer's comment is for the reviewer only — the auditor never sees it
                   // (the reviewer transcribes what's relevant into their own note to the auditor).
                   preparer_note: (stage === 'review') ? (a.preparer_note || '') : '' };
        })
      };
    });
  return { request: slimRequest_(req), stage: stage, actionable: STAGE_STATUS[stage], lines: lines };
}

/**
 * Stream one evidence file to the client as a data URL (app-mediated — the file
 * is never shared on Drive). Reviewer/Auditor/Admin may fetch any; a Preparer
 * only their own uploads.
 */
function getEvidenceFile(evidenceId) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.AUDITOR, ROLES.ADMIN, ROLES.PREPARER]);
  var ev = readTabCached_('Evidence').filter(function (e) { return String(e.evidence_id) === String(evidenceId); })[0];
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
 * Full history of one SAMPLE: every status change, human note and AI assessment,
 * oldest first — the sample's own Activity_Log entries plus those of its tasks
 * (uploads, submits, per-payment review/audit). Any role that can see the sample may
 * read it; a preparer only for a sample they're assigned on. When the sample has more
 * than one task (Cash & POS), also returns `tabs` (Sample + one per payment) so the
 * client can separate the per-task histories.
 */
function taskTimeline(lineId) {
  // Auditors never get the history between the other roles: it carries the AI checks
  // and the reviewer's decisions (the client never offers it in the audit stage).
  var me = requireRole_([ROLES.PREPARER, ROLES.REVIEWER, ROLES.ADMIN]);
  var t = readTabsCached_(['Sample_Lines', 'Assignments', 'Activity_Log']);
  var line = t.Sample_Lines.filter(function (l) { return String(l.line_id) === String(lineId); })[0];
  if (!line) throw new Error('Sample not found.');
  var asgs = t.Assignments.filter(function (a) { return String(a.line_id) === String(lineId); });
  if (me.role === ROLES.PREPARER &&
      !asgs.some(function (a) { return String(a.assigned_to || '').toLowerCase() === me.email.toLowerCase(); })) {
    throw new Error('This sample is not assigned to you.');
  }
  var labelByAsg = {};
  asgs.forEach(function (a) { labelByAsg[String(a.assignment_id)] = parseJson_(a.detail_json).payment_no || a.evidence_type || 'Task'; });

  var events = t.Activity_Log.filter(function (e) {
    return (String(e.entity_type) === 'line' && String(e.entity_id) === String(lineId)) ||
           (String(e.entity_type) === 'assignment' && labelByAsg[String(e.entity_id)] != null);
  }).map(function (e) {
    var isAsg = String(e.entity_type) === 'assignment';
    return {
      ts: e.ts, actor: e.actor, action: e.action, details: e.details,
      entity_type: String(e.entity_type), assignment_id: String(e.entity_id),
      evidence_type: isAsg ? (labelByAsg[String(e.entity_id)] || '') : ''
    };
  }).sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });

  var out = {
    sample: { line_id: line.line_id, document_no: line.document_no, vendor: line.vendor, status: line.status, subpopulation: line.subpopulation || '' },
    multi: asgs.length > 1, events: events
  };
  if (out.multi) {
    var tabs = [{ key: 'sample', label: 'Sample', events: events.filter(function (e) { return e.entity_type === 'line'; }) }];
    asgs.forEach(function (a) {
      var id = String(a.assignment_id);
      tabs.push({ key: id, label: labelByAsg[id], events: events.filter(function (e) { return e.entity_type === 'assignment' && e.assignment_id === id; }) });
    });
    out.tabs = tabs;
  }
  return out;
}

/* ---------- comment thread (review + audit windows) ---------- */
/**
 * Which Activity_Log actions carry a human comment, who wrote it, and how to cut the comment
 * out of the log line. `re` is anchored on the exact text the action writes: its first group
 * is the comment, and a line that does not match is SKIPPED (older log formats carried no
 * comment, and an unknown format must never reach the auditor as-is — the reviewer's line
 * starts with the AI verdict). `reviewOnly` = never sent to the auditor.
 */
var THREAD_RULES_ = {
  AUDIT_RETURN:       { from: 'Auditor',  kind: 'Returned' },
  AUDIT_RETURN_TASK:  { from: 'Auditor',  kind: 'Returned' },
  AUDIT_CLOSE:        { from: 'Auditor',  kind: 'Closed' },
  AUDIT_CLOSE_TASK:   { from: 'Auditor',  kind: 'Closed',               re: /^closed(?: — ([\s\S]*))?$/ },
  REVIEW_SUBMIT:      { from: 'Reviewer', kind: 'Submitted to auditor', re: /^to auditor \(AI [^)]*\)(?: — ([\s\S]*))?$/ },
  REVIEW_SUBMIT_TASK: { from: 'Reviewer', kind: 'Submitted to auditor', re: /^reviewed \(AI [^)]*\)(?: — ([\s\S]*))?$/ },
  REVIEW_RETURN:      { from: 'Reviewer', kind: 'Returned to preparer', reviewOnly: true },
  REVIEW_RETURN_TASK: { from: 'Reviewer', kind: 'Returned to preparer', reviewOnly: true },
  ASSIGNMENT_SUBMIT:  { from: 'Preparer', kind: 'Submitted',            re: /^\d+ file\(s\)(?: — ([\s\S]*))?$/, reviewOnly: true }
};

/**
 * Every comment exchanged on one SAMPLE, oldest first — shown in the review / audit windows
 * in place of the single "last note". Assignments.notes / Sample_Lines.note keep only the
 * LATEST comment, so an auditor who got a task back could no longer read why they had
 * returned it. Rebuilt from Activity_Log, which has kept every comment since the start, so a
 * request that is already running shows its past exchanges too (nothing to migrate).
 *
 * SoD — the list is cut here, on the server, by stage:
 *   audit  → the auditor ↔ reviewer channel only: the auditor's returns and closing notes,
 *            and the reviewer's notes to the auditor. Never a preparer's comment, never a
 *            reviewer → preparer return, never anything about the AI.
 *   review → the same, plus the reviewer's returns to the preparer and the preparer's comments.
 * Returns { line_id, messages: [{ ts, from, kind, actor, text, assignment_id, task }] };
 * `assignment_id` is '' for a comment made on the sample as a whole.
 */
function commentThread(lineId, stage) {
  stage = stage === 'audit' ? 'audit' : 'review';
  var me = requireRole_(stageRoles_(stage));
  var t = readTabsCached_(['Sample_Lines', 'Assignments', 'Activity_Log']);
  var line = t.Sample_Lines.filter(function (l) { return String(l.line_id) === String(lineId); })[0];
  if (!line) throw new Error('Sample not found.');
  if (stage === 'review') assertReviewer_(line.request_id, me);

  var labelByAsg = {};
  t.Assignments.forEach(function (a) {
    if (String(a.line_id) === String(lineId)) labelByAsg[String(a.assignment_id)] = parseJson_(a.detail_json).payment_no || a.evidence_type || 'Task';
  });

  var messages = [];
  t.Activity_Log.forEach(function (e) {
    var rule = THREAD_RULES_[String(e.action)];
    if (!rule || (rule.reviewOnly && stage !== 'review')) return;
    var isAsg = String(e.entity_type) === 'assignment', id = String(e.entity_id);
    if (isAsg ? labelByAsg[id] == null : !(String(e.entity_type) === 'line' && id === String(lineId))) return;
    var text = String(e.details == null ? '' : e.details);
    if (rule.re) { var m = rule.re.exec(text); text = m ? (m[1] || '') : ''; }
    text = text.trim();
    if (!text) return;                                   // an action without a comment is not a message
    messages.push({ ts: e.ts, from: rule.from, kind: rule.kind, actor: e.actor || '', text: text,
                    assignment_id: isAsg ? id : '', task: isAsg ? labelByAsg[id] : '' });
  });
  messages.sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });
  return { line_id: line.line_id, messages: messages };
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

  // Voucher = two-image cross-check; Cash & POS = one verdict per payment task; Flow C
  // (Retail / Marketplace) = per task too (system tasks are deterministic, no AI call);
  // everything else = per-document.
  var result = (sub === 'Prepaid - Voucher') ? assessVoucher_(line, detail, docs)
    : (sub === 'Postpaid - Cash & POS') ? assessCashPos_(lineId, line, ds)
    : isPerTaskSub_(sub) ? assessPerTaskLine_(lineId, line, ds)
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
/**
 * Flow C line-level check: one verdict per task. A SYSTEM task carries its deterministic
 * verdict already (the reconciliation checks computed at enrichment); a submitted human
 * task (proof of payment / contract / down-payment) gets the Flow-A-style per-document AI
 * check on its own files. Tasks not yet submitted are skipped. The line verdict is the
 * worst of the assessed tasks.
 */
function assessPerTaskLine_(lineId, line, ds) {
  var worst = null, parts = [], perDoc = [];
  getAssignments(lineId).forEach(function (a) {
    var st = String(a.status || '').toLowerCase();
    if (['submitted', 'reviewed', 'accepted'].indexOf(st) === -1) return;
    var r = assessAssignmentCore_(a, line);
    if (!r) return;
    if (st === 'submitted' && parseJson_(a.detail_json).kind !== 'system') {
      updateRowById_(ds, 'Assignments', 'assignment_id', a.assignment_id, { ai_verdict: r.verdict, ai_summary: String(r.summary || '').substring(0, 900), ai_checked_at: nowIso_() });
    }
    worst = worst === null ? r.verdict : worseVerdict_(worst, r.verdict);
    parts.push((a.evidence_type || 'task') + ' → ' + r.verdict);
    (r.perDoc || []).forEach(function (p) { perDoc.push(p); });
  });
  if (worst === null) return { verdict: 'uncertain', summary: 'No submitted task to assess yet.', perDoc: [] };
  return { verdict: worst, summary: parts.join('  |  '), perDoc: perDoc };
}

/** The verdict of an app-produced reconciliation task, straight from its stored checks (no AI). */
function systemVerdict_(unit) {
  var checks = unit.checks || [];
  return {
    verdict: unit.verdict || 'uncertain',
    summary: unit.summary || checks.map(function (c) { return c.name + ': ' + c.status; }).join(' | '),
    perDoc: checks.map(function (c) { return { file: c.name, verdict: c.status === 'match' ? 'accept' : 'uncertain', summary: c.status === 'match' ? ('match (diff ' + c.diff + ')') : c.status === 'variance' ? ('variance of ' + c.diff) : ('missing data' + (c.note ? ' — ' + c.note : '')) }; })
  };
}

/* ---------- Flow C Retail: the customer's SALES INVOICE (a PDF Jumia issued) ---------- */
function isSalesInvoiceTask_(asg) {
  return String(asg.evidence_type || '').trim().toLowerCase() === FLOWC_SALES_INVOICE.toLowerCase();
}
/**
 * The invoice PDF against what NAV "Posted Sales Invoices" recorded for it at extraction (stored
 * on the sample: inv_total = Amount incl_ VAT, inv_customer = Customer Name, inv_no = No_).
 * Three things decide the verdict: the invoice TOTAL, the CUSTOMER NAME and the INVOICE NUMBER.
 * NAV mostly keeps the customer's first name only, sometimes in Arabic script (seen on
 * REQ_bc265bfa), so the name check is "the recorded name is part of the printed name", never an
 * exact comparison. The NAV invoice number is the package number = "<OMS order number>-<suffix>"
 * (288 of 288 invoice lines on REQ_bc265bfa), so the number check passes on the full number OR
 * the order number; a number that is absent or different is "uncertain" (the reviewer decides),
 * never a reject on its own — a wrong total or customer is what rejects.
 * With no recorded total (NAV invoice not found at extraction) there is nothing to compare the
 * document with: the verdict is "uncertain" and no model call is made.
 */
function assessSalesInvoice_(asg, line, ldet, files) {
  var has = function (v) { return v !== undefined && v !== null && String(v).trim() !== ''; };
  if (!has(ldet.inv_total) || isNaN(Number(ldet.inv_total))) {
    return { verdict: 'uncertain', perDoc: [],
             summary: 'No NAV posted sales invoice was found for this sample at extraction — there is no recorded total to validate the invoice against.' };
  }
  var total = Number(ldet.inv_total), customer = String(ldet.inv_customer || '').trim();
  var invNo = String(ldet.inv_no || ldet.package_number || '').trim();
  var orderNo = /^\d{5,}-\d+$/.test(invNo) ? invNo.split('-')[0] : '';      // "<order number>-<suffix>"
  var facts = [
    'Company: ' + (line.company || '—'),
    'Recorded invoice number (NAV "No_" = package number): ' + (invNo || '(none recorded — skip check 4 and say so)'),
    'Order number (the part of the invoice number before the dash): ' + (orderNo || '—'),
    'Recorded invoice total INCLUDING VAT: ' + total + (has(ldet.inv_currency) ? ' ' + ldet.inv_currency : ''),
    'Recorded customer name: ' + (customer || '(none recorded — skip check 3 and say so)'),
    'Recorded amount excluding VAT (reference only): ' + (has(ldet.inv_excl) ? ldet.inv_excl : '—'),
    'NAV posting date (reference only — the invoice date can be a few days earlier): ' + (String(ldet.inv_posting || '').slice(0, 10) || '—'),
    'Sampled item on this invoice (reference only): SKU ' + (ldet.sku || '—') + ', unit price ' + (has(line.amount) ? line.amount : '—')
  ].join('\n');
  var system =
    'You are a meticulous financial-audit evidence reviewer at Jumia. The attached document should be a SALES INVOICE ' +
    'that Jumia issued to a customer (a PDF in Jumia\'s standard invoice layout). You are given what the accounting system ' +
    '(NAV, "Posted Sales Invoices") recorded for that invoice. Run exactly four checks and report each one in "checks":\n' +
    '1) "Document type" — the document is a sales invoice issued by Jumia. An order confirmation, delivery note, credit ' +
    'note, payment receipt or a screenshot of a system is not.\n' +
    '2) "Invoice total" — the invoice\'s grand total INCLUDING VAT (the final amount of the whole invoice, after shipping, ' +
    'discounts and taxes) equals the recorded total including VAT. Compare the numeric value only: ignore the currency ' +
    'symbol, thousands separators and decimal formatting, and accept a difference of up to ' + FLOWC_INVOICE_TOLERANCE +
    ' currency unit as rounding. Never compare against a single item line, a subtotal or the VAT amount on its own.\n' +
    '3) "Customer name" — the customer (bill-to / ship-to name) printed on the invoice is the same person or company as ' +
    'the recorded customer name. The accounting system often keeps ONLY THE FIRST NAME or a shortened name, and may hold ' +
    'it in Arabic script while the invoice prints it in Latin letters (or the reverse): the check passes when the recorded ' +
    'name appears as the first name or as any part of the printed name, allowing for transliteration, letter case, accents, ' +
    'spacing and spelling variants. It fails only when the printed customer is clearly a different name.\n' +
    '4) "Invoice number" — the document identifies the same invoice: the recorded invoice number, or the order number ' +
    '(its part before the dash), is printed on the document as an invoice, package, shipment, order or reference number. ' +
    'Ignore spaces, dashes and leading zeros when comparing. The check fails when neither number can be found on the ' +
    'document; in the note, quote the invoice / order numbers the document does show.\n' +
    'The dates are reference only — never fail the document on a date.\n' +
    'Verdict: "accept" only when all four checks pass. "reject" when the document is not a Jumia sales invoice, the total ' +
    'differs, or the customer is clearly someone else — say which, quoting the value on the document and the recorded value. ' +
    '"uncertain" when the total or the customer name cannot be read or found on the document, or when checks 1 to 3 pass ' +
    'but check 4 fails (the numbers on the document do not include the recorded invoice or order number).\n' +
    'In each check\'s note quote the value you read on the document. Summary: one specific sentence (under 240 characters) ' +
    'quoting the total, the customer name and the invoice / order number read on the invoice against the recorded ones.';

  var perDoc = [], worst = 'accept';
  files.forEach(function (e) {
    var d = loadEvidenceBytes_(e);
    if (d.err) { perDoc.push({ file: e.file_name, type: asg.evidence_type, verdict: 'uncertain', summary: d.err }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var prompt = 'Expected evidence type: "' + FLOWC_SALES_INVOICE + '" (issued by Jumia).\n\nRecorded in NAV:\n' + facts +
      '\n\nAssess the attached document (file name: ' + e.file_name + ').';
    var res;
    try { res = geminiAssess_(system, prompt, { mimeType: d.mime, bytes: d.bytes }); }
    catch (err) { perDoc.push({ file: e.file_name, type: asg.evidence_type, verdict: 'uncertain', summary: 'AI error: ' + (err.message || err) }); worst = worseVerdict_(worst, 'uncertain'); return; }
    var v = String(res.verdict || 'uncertain').toLowerCase();
    if (['accept', 'reject', 'uncertain'].indexOf(v) === -1) v = 'uncertain';
    // An "accept" that carries a failed check contradicts itself — leave it to the reviewer.
    var failed = (res.checks || []).filter(function (c) { return c && c.ok === false; });
    if (v === 'accept' && failed.length) v = 'uncertain';
    var sm = String(res.summary || '');
    if (failed.length) sm += ' [failed: ' + failed.map(function (c) { return c.name; }).join(', ') + ']';
    perDoc.push({ file: e.file_name, type: asg.evidence_type, verdict: v, summary: sm });
    worst = worseVerdict_(worst, v);
  });
  return { verdict: worst, summary: perDoc.map(function (p) { return p.file + ' → ' + p.verdict + (p.summary ? (': ' + p.summary) : ''); }).join('  |  '), perDoc: perDoc };
}

function assessAssignmentCore_(asg, line) {
  var ds = dataSs_();
  var unit = parseJson_(asg.detail_json), ldet = parseJson_(line.detail_json);
  if (unit.kind === 'system') return systemVerdict_(unit);           // deterministic — never sent to the model
  var files = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.assignment_id) === String(asg.assignment_id); });
  if (!files.length) return { verdict: 'uncertain', summary: 'No file uploaded for this task.', perDoc: [] };
  // Flow C Retail — the customer's sales invoice: its own check (total incl. VAT + customer name).
  if (String(line.subpopulation) === 'Retail' && isSalesInvoiceTask_(asg)) return assessSalesInvoice_(asg, line, ldet, files);
  if (isPerTaskSub_(line.subpopulation) && String(line.subpopulation) !== 'Postpaid - Cash & POS') {
    // Flow C human task: Flow A's per-document check (statement / balance / paid / MPL facts) on THIS task's files.
    var types = {}; types[String(asg.assignment_id)] = asg.evidence_type;
    return assessPerDoc_(line, ldet, '', files, types);
  }
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
      logActivity('AI_CHECK', 'assignment', a.assignment_id, (parseJson_(a.detail_json).payment_no || '') + ' → ' + v + ' :: ' + sm.substring(0, 300));
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
  logActivity('AI_CHECK', 'assignment', assignmentId, (parseJson_(asg.detail_json).payment_no || '') + ' → ' + r.verdict + ' :: ' + String(r.summary || '').substring(0, 300));
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

/* ---------- per-subtask review (Cash & POS: one payment task at a time) ----------
 * Tasks are handled INDEPENDENTLY: a task can be reviewed/returned as soon as it is
 * submitted, regardless of its siblings, and returning one never blocks the others.
 * The sample status is recomputed from all tasks by updateLineAssignmentRollup_. */

/** Mark ONE submitted payment task as reviewed. */
function reviewerSubmitTask(assignmentId, override, note) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  assertReviewer_(asg.request_id, me);
  if (String(asg.status).toLowerCase() !== 'submitted') throw new Error('Only a submitted task can be reviewed (now: ' + asg.status + ').');
  var verdict = String(asg.ai_verdict || '').toLowerCase();
  if (!verdict) throw new Error('Run the AI check before submitting this payment to the auditor.');
  if (verdict !== 'accept' && !override) throw new Error('The AI flagged this payment (' + verdict + '). Tick the confirmation to proceed anyway.');

  note = String(note || '').trim();
  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'reviewed', notes: note ? ('Reviewer: ' + note) : '' });
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('REVIEW_SUBMIT_TASK', 'assignment', assignmentId, 'reviewed (AI ' + verdict + (verdict !== 'accept' ? ', override' : '') + ')' + (note ? ' — ' + note : ''));
  return reviewDetail(asg.request_id, 'review');
}

/** Return ONE payment task to its preparer — only that task; siblings are untouched. */
function reviewerReturnTask(assignmentId, note) {
  var me = requireRole_([ROLES.REVIEWER, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  assertReviewer_(asg.request_id, me);
  if (String(asg.status).toLowerCase() !== 'submitted') throw new Error('Only a submitted task can be returned (now: ' + asg.status + ').');
  if (parseJson_(asg.detail_json).kind === 'system') throw new Error('This reconciliation was produced by the app — there is no preparer to return it to. Submit it with your note, or ask an administrator to re-run the enrichment.');

  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'in_progress', submitted_at: '', ai_verdict: '', ai_summary: '', ai_checked_at: '', notes: 'Returned by reviewer: ' + note });
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('REVIEW_RETURN_TASK', 'assignment', assignmentId, note);
  return reviewDetail(asg.request_id, 'review');
}

/* ---------- per-subtask audit (Cash & POS: close/return one payment at a time) ---------- */
/** Auditor accepts ONE reviewed payment; the sample closes once every payment is accepted. */
function auditorCloseTask(assignmentId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  if (String(asg.status).toLowerCase() !== 'reviewed') throw new Error('Only a reviewed task can be closed (now: ' + asg.status + ').');

  note = String(note || '').trim();
  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, { status: 'accepted', notes: note ? ('Auditor: ' + note) : '' });
  updateLineAssignmentRollup_(asg.line_id);   // closes the sample when all accepted
  logActivity('AUDIT_CLOSE_TASK', 'assignment', assignmentId, 'closed' + (note ? ' — ' + note : ''));
  return reviewDetail(asg.request_id, 'audit');
}

/** Auditor returns ONE payment to the preparer — only that task; siblings are untouched. */
function auditorReturnTask(assignmentId, note) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  if (!String(note || '').trim()) throw new Error('Please add a note explaining what to fix.');
  var asg = findAssignment_(assignmentId);
  if (!asg) throw new Error('Task not found.');
  if (String(asg.status).toLowerCase() !== 'reviewed') throw new Error('Only a reviewed task can be returned (now: ' + asg.status + ').');

  // An app-produced reconciliation has no preparer: the auditor's return sends it back to
  // the REVIEWER (status submitted again, checks kept); anything else goes back to in_progress.
  var patch = parseJson_(asg.detail_json).kind === 'system'
    ? { status: 'submitted', notes: 'Returned by auditor: ' + note }
    : { status: 'in_progress', submitted_at: '', ai_verdict: '', ai_summary: '', ai_checked_at: '', notes: 'Returned by auditor: ' + note };
  updateRowById_(dataSs_(), 'Assignments', 'assignment_id', assignmentId, patch);
  updateLineAssignmentRollup_(asg.line_id);
  logActivity('AUDIT_RETURN_TASK', 'assignment', assignmentId, note);
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

/* ---------- auditor export ----------
 * One ZIP the auditor can drop into their own working papers:
 *   • an Excel workbook — Samples & Tasks (enriched), the IPE (queries + SHA-256 +
 *     checks + procedure), and an Evidence index (which file is where in the zip);
 *   • Extraction/ — the gateway result CSVs + SOX evidence workbooks (raw data + hashes);
 *   • Evidence/<sample>/<task>/<file> — every collected evidence file, clearly named.
 * The workbook is built in a throwaway Google Sheet, exported to .xlsx, then zipped.
 */
function auditExport(requestId) {
  var me = requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var ds = dataSs_();
  var tz = ds.getSpreadsheetTimeZone();
  var req = findRequest_(requestId);
  if (!req) throw new Error('Request not found.');
  var allLines = readObjects_(ds, 'Sample_Lines').filter(function (l) { return String(l.request_id) === String(requestId); });
  var lines = allLines.filter(function (l) { return String(l.status).toLowerCase() !== 'not_found'; });
  var asg = readObjects_(ds, 'Assignments').filter(function (a) { return String(a.request_id) === String(requestId); });
  var evd = readObjects_(ds, 'Evidence').filter(function (e) { return String(e.request_id) === String(requestId); });

  // IPE inputs, gathered once: every extraction of the request (stored gateway CSV + SOX xlsx,
  // re-hashed and row-counted now) joined to the gateway's own execution-log line.
  var ipe = null; if (req.ipe_json) { try { ipe = JSON.parse(req.ipe_json); } catch (e) {} }
  var flowMod = flowModule_(req.flow_id);
  var ext = exportExtractions_(req, ipe, flowMod);
  var gwLog = gatewayLogLines_(ext.map(function (x) { return x.gatewayId; }));
  ext.forEach(function (x) { x.log = gwLog.byId[x.gatewayId] || null; x.integrity = extractionIntegrity_(x); });
  var methodRows = (flowMod && typeof flowMod.methodology === 'function')
    ? flowMod.methodology(ext.map(function (x) { return { tag: x.tag, database: x.database, originalCsv: x.originalCsv, sha256: x.csvShaNow }; }))
    : null;

  // The submitted sample list: the stored paste (requests created since the app keeps it) or,
  // for older requests, the de-duplicated keys the app parsed from it, in the order received.
  var sample = exportSampleList_(req, allLines);

  var zipName = sanitizeName_((req.request_ref || requestId) + ' - audit export');
  var ss = SpreadsheetApp.create('Audit export ' + (req.request_ref || requestId));
  try {
    // Tab 1 (Samples & Tasks) + Tab 3 rows (Evidence index) + evidence blobs, one pass.
    // Column A links each row to its entry in the 'Sample list' tab.
    var H1 = ['Sample list #', 'Sample (SOI)', 'Company', 'Subpopulation', 'Sample status', 'Task / evidence', 'Payment no', 'Amount', 'Payment date', 'Bank account', 'Payment reference', 'Order no', 'Gateway / provider', 'Assigned to', 'Task status', 'Evidence files'];
    var R1 = [H1];
    var sampleLink = function (l) {
      var n = sample.noByLine[l.line_id];
      return n ? '=HYPERLINK("#\'Sample list\'!A' + (sample.firstRow + n - 1) + '","' + n + '")' : '';
    };
    var H3 = ['Sample (SOI)', 'Task / evidence', 'Payment no', 'Slot', 'File name', 'Uploaded by', 'Uploaded at', 'Path in export'];
    var R3 = [H3];
    var evFiles = [];   // {fileId, soi, task, fileName} — copied into the Drive folder later
    lines.forEach(function (l) {
      var det = parseJson_(l.detail_json);
      var la = asg.filter(function (a) { return String(a.line_id) === String(l.line_id); });
      if (!la.length) { R1.push([sampleLink(l), l.document_no, l.company, l.subpopulation, l.status, '', '', l.amount, '', '', '', det.order_nr || '', '', '', '', '']); return; }
      la.forEach(function (a) {
        var u = parseJson_(a.detail_json);
        var files = evd.filter(function (e) { return String(e.assignment_id) === String(a.assignment_id); });
        var taskLabel = u.payment_no || a.evidence_type || 'task';
        R1.push([sampleLink(l), l.document_no, l.company, l.subpopulation, l.status, a.evidence_type,
          u.payment_no || '', (u.amount != null && u.amount !== '' ? u.amount : (l.amount || '')),
          String(u.payment_date || '').slice(0, 10), u.bank_account || '', u.payment_ref || '', det.order_nr || '',
          [det.jp_gateway, det.jp_provider].filter(Boolean).join(' / '), a.assigned_to || '', a.status,
          files.map(function (e) { return e.file_name; }).join(', ')]);
        // App-produced evidence (Flow C's reconciliation workbook) is ONE file shared by every
        // system task of the request: it goes once into 'Reconciliation (system)/' at the export
        // root and every sample's row points to that same path — no per-sample copies.
        var isSystem = u.kind === 'system';
        files.forEach(function (e) {
          var soiDir = sanitizeName_(l.document_no), taskDir = sanitizeName_(taskLabel), fName = sanitizeName_(e.file_name);
          var path = isSystem ? ('Reconciliation (system)/' + fName) : ('Evidence/' + soiDir + '/' + taskDir + '/' + fName);
          evFiles.push({ fileId: e.file_id, soi: soiDir, task: taskDir, fileName: fName, system: isSystem, path: path });
          R3.push([l.document_no, a.evidence_type, u.payment_no || '', e.slot || '', e.file_name, e.uploaded_by || '', toDateStr_(e.uploaded_at, tz), path]);
        });
      });
    });
    var t1 = ss.getSheets()[0].setName('Samples & Tasks');
    t1.getRange(1, 1, R1.length, H1.length).setValues(R1);
    t1.setFrozenRows(1); t1.getRange(1, 1, 1, H1.length).setFontWeight('bold');

    // Tab 2: IPE — the request header, then ONE ROW PER EXTRACTION (every query of the request,
    // not just query 1): export file ↔ original gateway file ↔ gateway log line, hashes three
    // ways (gateway log / app at extraction / file in this package), row counts, SQL as executed.
    var t2 = ss.insertSheet('IPE');
    var R2 = [];
    if (ipe) {
      R2.push(['IPE / SOX — IT-Produced Evidence', '']);
      R2.push(['Document ref', ipe.documentRef || '']);
      R2.push(['Scope', ipe.scope || '']);
      R2.push(['Period', ipe.period || '']);
      R2.push(['Primary database', ipe.primaryDb || '']);
      R2.push(['Generated at (UTC)', ipe.timestamp || '']);
      R2.push(['Requested by', ipe.requestedBy || '']);
      R2.push(['Classification', ipe.classification || '']);
      R2.push(['Requested / Found / Not found', [ipe.requested, ipe.found, ipe.notFound].join(' / ')]);
      R2.push(['Extractions', ext.length + ' (one row each below; files in Extraction/, gateway log lines in the Execution log tab and Execution log/)']);
      R2.push(['Sample list submitted', "Tab 'Sample list' and folder Sample list/ (" + sample.sourceShort + ')']);
      R2.push(['', '']);
      R2.push(['Completeness & accuracy checks', '']);
      (ipe.checks || []).forEach(function (c) { R2.push([c.name, c.method + ' — ' + c.result]); });
      R2.push(['Gateway log tie-out', 'Per extraction: CSV SHA-256 and row count in this package = the gateway execution log; SQL SHA-256 = the log\'s query_sha256 — see column Integrity']);
    } else { R2.push(['No IPE was captured for this request.', '']); }
    R2.push(['', '']);
    var extHead = R2.length + 1;
    var HX = ['#', 'Extraction', 'Export file (Extraction/)', 'Export evidence file (Extraction/)', 'Original gateway CSV filename',
              'Original gateway evidence filename', 'Gateway request_id', 'Server', 'Database', 'Execution completed at (UTC, gateway log)',
              'Duration (s)', 'Requested by (gateway log)', 'Row count (gateway log)', 'Row count (CSV in this package)',
              'CSV SHA-256 (gateway log)', 'CSV SHA-256 (app, at extraction)', 'CSV SHA-256 (file in this package)',
              'Evidence xlsx SHA-256 (gateway log)', 'Evidence xlsx SHA-256 (file in this package)',
              'Query SHA-256 (gateway log)', 'Query SHA-256 (SQL in this row)', 'Integrity', 'SQL as executed'];
    R2.push(HX);
    ext.forEach(function (x, i) {
      var g = x.log ? x.log.obj : {};
      R2.push([String(i + 1), x.label, x.exportCsv, x.xlsxId ? x.exportXlsx : '', x.originalCsv, g.evidence_file || x.originalXlsx || '',
               x.gatewayId, g.server || x.server, g.database || x.database, g.timestamp_utc || '',
               g.duration_seconds != null ? String(g.duration_seconds) : '', g.requested_by || '',
               g.row_count != null ? String(g.row_count) : '', String(x.rowsNow),
               g.output_sha256 || '', x.shaAtExtraction || '', x.csvShaNow,
               g.evidence_sha256 || '', x.xlsxShaNow || '',
               g.query_sha256 || '', x.querySha, x.integrity, String(x.query || '').slice(0, 49000)]);
    });
    var W2 = HX.length;
    var G2 = R2.map(function (r) { var o = r.slice(0, W2); while (o.length < W2) o.push(''); return o; });
    t2.getRange(1, 1, G2.length, W2).setNumberFormat('@').setValues(G2);   // plain text: hashes/ids/timestamps stay verbatim
    t2.getRange(1, 1, 1, 2).setFontWeight('bold');
    t2.getRange(extHead, 1, 1, W2).setFontWeight('bold').setWrap(true);
    t2.getRange(extHead, 1, ext.length + 1, W2).setVerticalAlignment('top');
    if (ext.length) t2.getRange(extHead + 1, W2, ext.length, 1).setWrap(true);
    t2.setColumnWidth(1, 220); t2.setColumnWidth(2, 260);
    for (var c2 = 3; c2 < W2; c2++) t2.setColumnWidth(c2, 170);
    t2.setColumnWidth(W2, 700);

    // Tab 3: Evidence index.
    var t3 = ss.insertSheet('Evidence index');
    t3.getRange(1, 1, R3.length, H3.length).setValues(R3);
    t3.setFrozenRows(1); t3.getRange(1, 1, 1, H3.length).setFontWeight('bold');

    // Tab 4: Sample list — the list as submitted, numbered (Samples & Tasks column A links here).
    var t4 = ss.insertSheet('Sample list');
    var W4 = sample.table[0].length;
    var G4 = sample.head.concat([[]], sample.table).map(function (r) { var o = r.slice(0, W4); while (o.length < W4) o.push(''); return o; });
    t4.getRange(1, 1, G4.length, W4).setNumberFormat('@').setValues(G4);   // keys keep leading zeros
    t4.getRange(1, 1, sample.head.length, 1).setFontWeight('bold');
    t4.getRange(sample.firstRow - 1, 1, 1, W4).setFontWeight('bold');
    t4.setColumnWidth(1, 160); t4.setColumnWidth(2, 420);

    // Tab 5: Execution log — the gateway's audit.jsonl lines for this request, parsed + verbatim.
    var t5 = ss.insertSheet('Execution log');
    var LK = ['timestamp_utc', 'request_id', 'status', 'server', 'database', 'row_count', 'output_file', 'output_sha256',
              'evidence_file', 'evidence_sha256', 'query_sha256', 'request_sha256', 'script_sha256', 'duration_seconds', 'requested_by', 'error'];
    var R5 = [LK.concat(['Raw log line (verbatim)'])];
    gwLog.lines.forEach(function (ln) {
      R5.push(LK.map(function (k) { var v = ln.obj[k]; return v === null || v === undefined ? '' : String(v); }).concat([ln.raw.slice(0, 49000)]));
    });
    if (gwLog.error) R5.push(['Log read error: ' + gwLog.error]);
    var W5 = R5[0].length;
    var G5 = R5.map(function (r) { var o = r.slice(0, W5); while (o.length < W5) o.push(''); return o; });
    t5.getRange(1, 1, G5.length, W5).setNumberFormat('@').setValues(G5);
    t5.setFrozenRows(1); t5.getRange(1, 1, 1, W5).setFontWeight('bold');
    t5.getRange(G5.length + 2, 1).setValue('Source: ' + (gwLog.path || 'FinRec SQL gateway Logs/audit.jsonl') + ' — the lines are copied unchanged into Execution log/execution_log.jsonl; the job files they hash (request_sha256) are in Execution log/jobs/.');

    // Tab 6: Methodology — flows that reconcile (Flow C): every transformation not in the formulas.
    if (methodRows) {
      var t6 = ss.insertSheet('Methodology');
      var W6 = methodRows[0].length;
      var G6 = methodRows.map(function (r) { var o = r.slice(0, W6); while (o.length < W6) o.push(''); return o; });
      t6.getRange(1, 1, G6.length, W6).setNumberFormat('@').setValues(G6).setWrap(true).setVerticalAlignment('top');
      t6.setFrozenRows(1); t6.getRange(1, 1, 1, W6).setFontWeight('bold');
      [30, 150, 620, 230, 420].forEach(function (px, i) { if (i < W6) t6.setColumnWidth(i + 1, px); });
    }

    SpreadsheetApp.flush();

    // Export the workbook as .xlsx.
    var resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + ss.getId() + '/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (resp.getResponseCode() >= 300) throw new Error('Could not build the Excel file (HTTP ' + resp.getResponseCode() + ').');
    var xlsxBlob = resp.getBlob().setName(zipName + '.xlsx');

    // ---- Assemble the export as REAL files in a Drive folder ----------------
    // Evidence is copied Drive-side (makeCopy), one file at a time — so the run
    // never holds the whole export in memory and there is no ~50 MB blob ceiling.
    // The folder is the reliable deliverable; the ZIP below is a bonus for small runs.
    var exportsId = PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS);
    if (!exportsId) throw new Error('Exports folder not provisioned — run setup().');
    var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH-mm');
    var reqFolder = getOrCreateFolder_(DriveApp.getFolderById(exportsId), requestId);
    var outFolder = reqFolder.createFolder(zipName + ' (' + stamp + ')');
    // ONE tally of what actually lands in the folder (every file below goes through place):
    // it is what the Audit card shows the auditor — "N file(s) · X MB" must be the real folder.
    var placed = 0, placedBytes = 0, missing = 0, missingFiles = [];   // missingFiles: export paths that could not be copied
    var place = function (file) { placed++; try { placedBytes += Number(file.getSize()) || 0; } catch (e) {} return file; };
    place(outFolder.createFile(xlsxBlob));

    // [fileId, path]: one CSV (+ SOX evidence xlsx) per extraction — the same list as the IPE tab.
    // makeCopy keeps the bytes, so the hashes in the IPE / execution log still match; only the
    // name is the export's stable one (query1_result.csv …) that the reconciliation tabs cite.
    var extraction = [];
    ext.forEach(function (x) {
      extraction.push([x.csvId, 'Extraction/' + x.exportCsv]);
      if (x.xlsxId) extraction.push([x.xlsxId, 'Extraction/' + x.exportXlsx]);
    });
    var extFolder = extraction.length ? outFolder.createFolder('Extraction') : null;
    extraction.forEach(function (p) { try { place(DriveApp.getFileById(p[0]).makeCopy(p[1].replace(/^Extraction\//, ''), extFolder)); } catch (e) { missing++; missingFiles.push(p[1]); } });
    // Execution log/: the gateway log lines (verbatim, file order) + the job files they hash.
    var logFolder = outFolder.createFolder('Execution log');
    var logText = gwLog.lines.map(function (ln) { return ln.raw; }).join('\n') + (gwLog.lines.length ? '\n' : '');
    var logFile = place(logFolder.createFile(Utilities.newBlob(logText, 'text/plain', 'execution_log.jsonl')));
    extraction.push([logFile.getId(), 'Execution log/execution_log.jsonl']);
    var jobsFolder = null;
    gwLog.lines.forEach(function (ln) {
      var jf = ln.obj.job_file; if (!jf) return;
      try {
        var it = sub_('Requests_Completed').getFilesByName(jf);
        if (!it.hasNext()) return;
        var cp = place(it.next().makeCopy(jf, jobsFolder || (jobsFolder = logFolder.createFolder('jobs'))));
        extraction.push([cp.getId(), 'Execution log/jobs/' + jf]);
      } catch (e) {}
    });

    // Sample list/: the paste as received (when stored) + the numbered list as CSV.
    var smpFolder = outFolder.createFolder('Sample list');
    if (sample.fileId) {
      try { var sf = place(DriveApp.getFileById(sample.fileId).makeCopy(SAMPLE_LIST_FILE, smpFolder)); extraction.push([sf.getId(), 'Sample list/' + SAMPLE_LIST_FILE]); } catch (e) {}
    }
    var smpCsv = place(smpFolder.createFile(Utilities.newBlob(sample.csv, 'text/csv', 'sample_list.csv')));
    extraction.push([smpCsv.getId(), 'Sample list/sample_list.csv']);

    var dirCache = {}, seenFile = {};
    var evRoot = evFiles.some(function (f) { return !f.system; }) ? outFolder.createFolder('Evidence') : null;
    var sysRoot = null;
    evFiles.forEach(function (f) {
      if (seenFile[f.fileId]) return;                       // one Drive copy per distinct file
      try {
        var dest;
        if (f.system) {
          dest = sysRoot || (sysRoot = outFolder.createFolder('Reconciliation (system)'));
        } else {
          var soiF = dirCache[f.soi] || (dirCache[f.soi] = evRoot.createFolder(f.soi));
          var tk = f.soi + ' ' + f.task;
          dest = dirCache[tk] || (dirCache[tk] = soiF.createFolder(f.task));
        }
        place(DriveApp.getFileById(f.fileId).makeCopy(f.fileName, dest)); seenFile[f.fileId] = true;
      } catch (err) { missing++; missingFiles.push(f.path); }
    });

    // The methodology also sits NEXT TO the reconciliation workbook (whose own Methodology tab
    // exists only for requests enriched after it was added).
    if (methodRows && sysRoot) {
      try {
        var mf = place(buildXlsxFile_('Methodology - reconciliation', [{ name: 'Methodology', rows: methodRows, freezeRows: 1,
          colWidths: [30, 150, 620, 230, 420], styles: [{ range: 'A1:E' + methodRows.length, wrap: true, valign: 'top' }] }], sysRoot));
        extraction.push([mf.getId(), 'Reconciliation (system)/' + mf.getName()]);
      } catch (e) { logActivity('EXPORT_METHODOLOGY_FAILED', 'request', requestId, String(e)); }
    }

    // Auto-share with the requester + the request's reviewer/auditor, so they can
    // open it straight from the Drive without asking anyone for access.
    var recipients = [me.email, req.auditor_email, req.reviewer_email]
      .filter(function (x) { return x; })
      .map(function (x) { return String(x).toLowerCase().trim(); })
      .filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    var shared = shareFileWith_(outFolder.getId(), recipients);

    // Convenience one-click ZIP — only for small exports (in-memory zip + base64
    // return have a hard cap); larger exports are delivered via the Drive link. The ZIP carries
    // EVERYTHING in the folder, so the gate is the folder total, not the evidence alone.
    var download = null;
    if (placedBytes <= 30 * 1024 * 1024) {
      try {
        var zipBlobs = [xlsxBlob.copyBlob().setName(zipName + '.xlsx')];
        extraction.forEach(function (p) { try { var b = DriveApp.getFileById(p[0]).getBlob().copyBlob(); b.setName(p[1]); zipBlobs.push(b); } catch (e) {} });
        var zipped = {};
        evFiles.forEach(function (f) { if (zipped[f.fileId]) return; try { var b = DriveApp.getFileById(f.fileId).getBlob().copyBlob(); b.setName(f.path); zipBlobs.push(b); zipped[f.fileId] = true; } catch (e) {} });
        var zip = Utilities.zip(zipBlobs, zipName + '.zip');
        download = { name: zip.getName(), mime: 'application/zip', dataUrl: 'data:application/zip;base64,' + Utilities.base64Encode(zip.getBytes()) };
      } catch (e) { download = null; }   // fall back to the Drive link
    }

    logActivity('AUDIT_EXPORT', 'request', requestId,
      placed + ' file(s), ~' + Math.round(placedBytes / 1048576) + ' MB' + (missing ? (', ' + missing + ' missing') : '') + ', shared: ' + (shared.join(', ') || 'none')
      + '; IPE: ' + ext.length + ' extraction(s), ' + ext.filter(function (x) { return String(x.integrity).indexOf('Pass') === 0; }).length + ' pass, '
      + gwLog.lines.length + ' log line(s)' + (gwLog.error ? ' (log error: ' + gwLog.error + ')' : '') + ', sample list ' + sample.sourceShort
      + (function () { var g = ext.filter(function (x) { return String(x.source).indexOf('gateway original') === 0; }); return g.length ? '; gateway originals used: ' + g.map(function (x) { return x.tag; }).join(', ') : ''; })()
      + (missingFiles.length ? '; MISSING: ' + missingFiles.join(' | ').substring(0, 1500) : ''));
    return {
      folderUrl: outFolder.getUrl(), folderName: outFolder.getName(),
      fileCount: placed, missing: missing, missingFiles: missingFiles, totalMb: Math.round(placedBytes / 1048576 * 10) / 10,
      shared: shared, download: download,
      ipe: { extractions: ext.length, pass: ext.filter(function (x) { return String(x.integrity).indexOf('Pass') === 0; }).length,
             logLines: gwLog.lines.length, logError: gwLog.error || '', sampleList: sample.sourceShort }
    };
  } finally {
    try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) {}
  }
}

/**
 * Every extraction of a request, in run order: stage 1, the Flow B stage 2, then each N-stage
 * query (Flow C) from stages_json. For each, the stored gateway CSV (its Drive name IS the
 * original gateway filename — storeRequestFiles_ copies it under that name) is re-hashed and
 * row-counted NOW, so the IPE shows the file in the package equals what was hashed at extraction
 * and what the gateway logged. `exportCsv` is the stable export name the reconciliation tabs cite.
 * A stored copy that is gone (deleted Exports/{reqId}/ file — REQ_b16a4636, Oct 2026) falls back to
 * the gateway ORIGINAL in Responses/ (resolveExtraction_); `x.source` says which file was used.
 */
function exportExtractions_(req, ipe, mod) {
  ipe = ipe || {};
  var stg = parseJson_(req.stages_json); if (!Array.isArray(stg)) stg = [];
  var hashes = {}; (ipe.stages || []).forEach(function (s) { hashes[s.tag] = s; });
  var list = [
    { tag: 'query1', label: 'Query 1 — stage 1', csvId: req.csv_file_id, xlsxId: req.xlsx_file_id, gatewayId: ipe.requestId || gatewayIdFromName_(ipe.csvName),
      server: 'finrec', database: ipe.primaryDb || '', query: ipe.query || '', shaAtExtraction: ipe.csvSha256 || '' },
    { tag: 'query2', label: 'Query 2 — stage 2', csvId: req.csv2_file_id, xlsxId: req.xlsx2_file_id, gatewayId: gatewayIdFromName_(ipe.csv2Name),
      server: (mod && mod.stage2 && mod.stage2.server) || 'finrec', database: ipe.query2Db || '', query: ipe.query2 || '', shaAtExtraction: ipe.csv2Sha256 || '' }
  ];
  stg.forEach(function (s) {
    var h = hashes[s.tag] || {};
    list.push({ tag: s.tag || 'stage', label: s.label || s.tag, csvId: s.csvId, xlsxId: s.xlsxId, gatewayId: s.gatewayId || gatewayIdFromName_(s.csvName),
                server: s.server || 'finrec', database: s.db || h.db || '', query: h.query || '', shaAtExtraction: h.csvSha256 || '' });
  });
  return list.filter(function (x) { return x.csvId || x.gatewayId; }).map(function (x) {
    x.exportCsv = x.tag + '_result.csv'; x.exportXlsx = x.tag + '_evidence.xlsx';
    x.querySha = x.query ? sha256HexStr_(x.query) : '';
    resolveExtraction_(x);
    try {
      var f = DriveApp.getFileById(x.csvId), bytes = f.getBlob().getBytes();
      x.originalCsv = f.getName();
      x.csvShaNow = sha256Hex_(bytes);
      var text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);
      var rows = Utilities.parseCsv(text).filter(function (r) { return !(r.length === 1 && r[0] === ''); });
      x.rowsNow = Math.max(0, rows.length - 1);              // header excluded — the gateway's row_count
    } catch (e) { x.originalCsv = x.originalCsv || ''; x.csvShaNow = 'unreadable: ' + e; x.rowsNow = ''; }
    if (x.xlsxId) { try { var xf = DriveApp.getFileById(x.xlsxId); x.originalXlsx = xf.getName(); x.xlsxShaNow = sha256Hex_(xf.getBlob().getBytes()); } catch (e) { x.xlsxShaNow = ''; } }
    // The gateway names its output {request_id}_{yyyyMMdd_HHmmss}.csv — recover the id when not stored.
    if (!x.gatewayId && x.originalCsv) x.gatewayId = x.originalCsv.replace(/_\d{8}_\d{6}\.csv$/i, '');
    return x;
  });
}

/** 'Pass' when the package file, the app's hash at extraction and the gateway log all agree
 *  (CSV hash, row count, SQL hash, evidence xlsx hash); otherwise 'Flag: …' naming what differs. */
function extractionIntegrity_(x) {
  if (!x.log) return 'Flag: no gateway log line found for ' + (x.gatewayId || 'this extraction') + sourceNote_(x);
  var g = x.log.obj, bad = [];
  if (g.status && String(g.status).toUpperCase() !== 'SUCCESS') bad.push('log status ' + g.status);
  if (g.output_sha256 !== x.csvShaNow) bad.push('CSV hash ≠ log');
  if (x.shaAtExtraction && x.shaAtExtraction !== x.csvShaNow) bad.push('CSV hash ≠ hash at extraction');
  if (String(g.row_count) !== String(x.rowsNow)) bad.push('row count ≠ log');
  if (x.querySha && g.query_sha256 && g.query_sha256 !== x.querySha) bad.push('SQL hash ≠ log');
  if (x.xlsxShaNow && g.evidence_sha256 && g.evidence_sha256 !== x.xlsxShaNow) bad.push('evidence xlsx hash ≠ log');
  return (bad.length ? 'Flag: ' + bad.join('; ') : 'Pass') + sourceNote_(x);
}
/** Integrity suffix when the package file is not the app's stored copy (the auditor must see it). */
function sourceNote_(x) {
  return x.source && x.source !== 'stored' ? ' — file in this package: ' + x.source : '';
}

/* ---------- stored extraction files ↔ gateway originals ----------
 * The app keeps COPIES of the gateway outputs in Exports/{reqId}/ (storeRequestFiles_); the
 * originals stay in the gateway's Responses/ as {gateway request_id}_{yyyyMMdd_HHmmss}.csv|.xlsx.
 * When a stored copy is gone, the original is the same bytes — accepted only on a hash match. */

/** Gateway request id from a gateway output name, or '' when the name is not one. */
function gatewayIdFromName_(name) {
  var m = String(name || '').match(/^(.+)_\d{8}_\d{6}\.(csv|xlsx)$/i);
  return m ? m[1] : '';
}
/** The Drive file behind an id, or null when the id is empty or the file is gone / trashed / not readable. */
function liveFile_(id) {
  if (!id) return null;
  try { var f = DriveApp.getFileById(id); return f.isTrashed() ? null : f; } catch (e) { return null; }
}
/** The gateway's original output ({gatewayId}_*) in Responses/ — searched by title, never a folder walk. */
function gatewayOriginal_(gatewayId, rx) {
  if (!gatewayId) return null;
  try {
    var it = sub_('Responses').searchFiles('title contains "' + String(gatewayId).replace(/["\\]/g, '') + '" and trashed = false');
    while (it.hasNext()) { var f = it.next(), n = f.getName(); if (n.indexOf(gatewayId + '_') === 0 && rx.test(n)) return f; }
    return null;
  } catch (e) { return findResponse_(gatewayId, rx); }
}
/** The gateway original, verified: { file, status: found|not_found|hash_mismatch, note }. A file is
 *  accepted only when its SHA-256 equals `sha` (the hash recorded at extraction); no `sha` = accepted, noted. */
function verifiedOriginal_(gatewayId, rx, sha) {
  var f = gatewayOriginal_(gatewayId, rx);
  if (!f) return { file: null, status: 'not_found', note: gatewayId ? 'no ' + gatewayId + '_* in Responses/' : 'no gateway request id' };
  if (!sha) return { file: f, status: 'found', note: 'no hash recorded at extraction' };
  var now = sha256Hex_(f.getBlob().getBytes());
  return now === sha ? { file: f, status: 'found', note: '' }
                     : { file: null, status: 'hash_mismatch', note: f.getName() + ' SHA-256 ' + now + ' ≠ ' + sha };
}
/** Point one extraction at a readable CSV + evidence xlsx: the stored copy, else the verified original. */
function resolveExtraction_(x) {
  x.source = 'stored';
  if (!liveFile_(x.csvId)) {
    var v = verifiedOriginal_(x.gatewayId, /\.csv$/i, x.shaAtExtraction);
    if (v.file) { x.csvId = v.file.getId(); x.source = 'gateway original from Responses/ (app\'s stored copy missing)' + (v.note ? ', ' + v.note : ''); }
    else x.source = 'MISSING — app\'s stored copy gone; gateway original ' + (v.status === 'hash_mismatch' ? 'hash mismatch: ' : '') + v.note;
  }
  if (!liveFile_(x.xlsxId)) {
    var ox = gatewayOriginal_(x.gatewayId, /\.xlsx$/i);   // checked against the log's evidence_sha256 in extractionIntegrity_
    x.xlsxId = ox ? ox.getId() : '';
  }
}

/**
 * The FinRec SQL gateway's own execution log lines (Logs/audit.jsonl) for the given gateway
 * request ids — returned VERBATIM (raw text, in file order) and parsed.
 * The log is append-only and only grows, so it is read BACKWARDS in byte ranges (Drive alt=media +
 * Range): each chunk is cut at its first newline and the next chunk ends exactly there, so lines are
 * never split. The scan stops once every id is found and it has passed an hour before the earliest
 * hit (a job logs once, when it finishes) — no whole-file read, no blob ceiling as the log grows.
 * Returns { lines: [{ raw, obj }], byId: { id: line }, path, error }.
 */
function gatewayLogLines_(ids) {
  var want = {}, out = { lines: [], byId: {}, path: '', error: '' };
  (ids || []).forEach(function (id) { if (id) want[id] = true; });
  var need = Object.keys(want);
  if (!need.length) return out;
  try {
    var it = sub_('Logs').getFilesByName('audit.jsonl');
    if (!it.hasNext()) { out.error = 'Logs/audit.jsonl not found'; return out; }
    var file = it.next(), fileId = file.getId(), token = ScriptApp.getOAuthToken();
    out.path = 'FinRec SQL gateway Logs/' + file.getName();
    var CH = 8 * 1024 * 1024, end = Number(file.getSize()), hits = [], earliest = '';
    while (end > 0) {
      var start = Math.max(0, end - CH);
      var r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media&supportsAllDrives=true',
        { headers: { Authorization: 'Bearer ' + token, Range: 'bytes=' + start + '-' + (end - 1) }, muteHttpExceptions: true });
      if (r.getResponseCode() >= 300) throw new Error('log read HTTP ' + r.getResponseCode());
      var bytes = r.getContent(), text = Utilities.newBlob(bytes).getDataAsString('UTF-8');
      if (start > 0) {
        var nl = -1; for (var b = 0; b < bytes.length; b++) { if (bytes[b] === 10) { nl = b; break; } }
        if (nl < 0) throw new Error('log line longer than ' + CH + ' bytes');
        text = text.substring(text.indexOf('\n') + 1);   // drop the partial first line; re-read next round
        end = start + nl + 1;
      } else { end = 0; }
      var chunk = [], chunkFirstTs = '';
      text.split('\n').forEach(function (raw) {
        if (!raw) return;
        if (!chunkFirstTs) { var m = raw.match(/"timestamp_utc"\s*:\s*"([^"]+)"/); if (m) chunkFirstTs = m[1]; }
        for (var i = 0; i < need.length; i++) {
          if (raw.indexOf(need[i]) === -1) continue;
          var obj = null; try { obj = JSON.parse(raw); } catch (e) {}
          if (obj && obj.request_id === need[i]) { chunk.push({ raw: raw, obj: obj }); break; }
        }
      });
      hits = chunk.concat(hits);                           // keep file order across backward chunks
      hits.forEach(function (h) { if (!earliest || String(h.obj.timestamp_utc) < earliest) earliest = String(h.obj.timestamp_utc); });
      var foundAll = need.every(function (id) { return hits.some(function (h) { return h.obj.request_id === id; }); });
      if (foundAll && chunkFirstTs && earliest && new Date(chunkFirstTs).getTime() < new Date(earliest).getTime() - 3600000) break;
    }
    out.lines = hits;
    hits.forEach(function (h) { out.byId[h.obj.request_id] = h; });   // the last line per id wins
  } catch (e) { out.error = String(e); }
  return out;
}

/**
 * The sample list as submitted, for the 'Sample list' tab + Sample list/ folder. Requests created
 * since the app keeps the paste (SAMPLE_LIST_FILE in Exports/{reqId}/) ship that file byte-for-byte;
 * older ones ship the keys reconstructed from Sample_Lines (incl. not-found), which the app wrote
 * in the order the de-duplicated list was received — the same keys as Query 1's IN (…) list.
 * Returns { head, table, firstRow, noByLine, csv, fileId, sourceShort }.
 */
function exportSampleList_(req, allLines) {
  var tz = dataSs_().getSpreadsheetTimeZone();
  var fileId = '';
  try {
    var exportsId = PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS);
    var fit = exportsId ? DriveApp.getFolderById(exportsId).getFoldersByName(String(req.request_id)) : null;
    if (fit && fit.hasNext()) { var sit = fit.next().getFilesByName(SAMPLE_LIST_FILE); if (sit.hasNext()) fileId = sit.next().getId(); }
  } catch (e) {}
  var created = req.created_at instanceof Date ? Utilities.formatDate(req.created_at, tz, "yyyy-MM-dd'T'HH:mm:ssXXX") : String(req.created_at || '');
  var source = fileId
    ? 'As received: the list pasted at request creation is in Sample list/' + SAMPLE_LIST_FILE + ' (unchanged). The table below is that list after parsing and de-duplication, in the order received.'
    : 'Reconstructed: this request was created before the app kept a copy of the pasted list. The table below is the de-duplicated list of keys the app parsed from it, in the order received — the same keys as the IN (…) list of the Query 1 SQL (IPE tab).';
  var head = [
    ['Sample list submitted for the request'],
    ['Request ref', String(req.request_ref || '')],
    ['App request id', String(req.request_id)],
    ['Flow', String(req.title || req.flow_id || '')],
    ['Period', String(req.period || '')],
    ['Created at', created],
    ['Created by', String(req.created_by || '')],
    ['Auditor(s)', String(req.auditor_email || '')],
    ['Reviewer', String(req.reviewer_email || '')],
    ['Source', source]
  ];
  var table = [['Sample list #', 'ID_COMPANY', 'Sample key (as submitted)', 'Result']];
  var noByLine = {};
  var csvRows = [['sample_no', 'request_ref', 'request_id', 'created_at', 'created_by', 'id_company', 'sample_key', 'result']];
  allLines.forEach(function (l, i) {
    var n = i + 1; noByLine[l.line_id] = n;
    var res = String(l.status).toLowerCase() === 'not_found' ? 'not found in the source data' : 'found (see Samples & Tasks)';
    table.push([String(n), String(l.company || ''), String(l.document_no || ''), res]);
    csvRows.push([String(n), String(req.request_ref || ''), String(req.request_id), created, String(req.created_by || ''), String(l.company || ''), String(l.document_no || ''), res]);
  });
  var csv = csvRows.map(function (r) { return r.map(function (v) { v = String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\r\n') + '\r\n';
  return { head: head, table: table, firstRow: head.length + 3, noByLine: noByLine, csv: csv, fileId: fileId,
           sourceShort: fileId ? 'as received' : 'reconstructed from the parsed keys' };
}

/**
 * Grant each email reader access to a Drive file/folder (works on Shared Drives).
 * Uses the deployer's OAuth token + Drive REST so no extra scope is needed beyond
 * the full-drive scope DriveApp already pulls in. Returns the emails actually shared.
 */
function shareFileWith_(fileId, emails) {
  if (!emails || !emails.length) return [];
  var token = ScriptApp.getOAuthToken();
  var done = [];
  emails.forEach(function (email) {
    try {
      var r = UrlFetchApp.fetch(
        'https://www.googleapis.com/drive/v3/files/' + fileId + '/permissions?supportsAllDrives=true&sendNotificationEmail=false',
        { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email }), muteHttpExceptions: true });
      if (r.getResponseCode() < 300) done.push(email);
    } catch (e) { /* leave it out of the shared list */ }
  });
  return done;
}
