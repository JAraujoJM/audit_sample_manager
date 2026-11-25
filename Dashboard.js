/**
 * Dashboard — the CFO view of where the audit stands (20 Oct 2026).
 * -----------------------------------------------------------------
 * One payload, ONE ENTRY PER REQUEST (oldest first — 25 Nov 2026; it used to group by audit
 * stream, which merged e.g. Cash Anchor H1 and Q3): samples and tasks by status, by company,
 * by preparer, and where the time went (days with nobody / the preparers / the reviewer / the
 * auditors, replayed from Activity_Log). Built from the cached Data tabs (Cache.js) and itself
 * cached on the versions of the tabs it reads, so an open costs ~one Apps Script call.
 *
 * Access: canSeeDashboard_ (Auth.js) — Administrators + Settings `dashboard_viewers`,
 * never Auditors. No AI output is read or returned here.
 *
 * Every open is logged in the Data spreadsheet's Access_Log tab: served opens by the
 * client beacon (logUi) with the server and browser time, refusals here on the server.
 */

var DASH_TABS_ = ['Requests', 'Sample_Lines', 'Assignments', 'Activity_Log'];
var COUNTRY_NAMES_ = { CI: "Côte d'Ivoire", KE: 'Kenya', NG: 'Nigeria', GH: 'Ghana', EG: 'Egypt', MA: 'Morocco',
  SN: 'Senegal', UG: 'Uganda', DZ: 'Algeria', TN: 'Tunisia', ZA: 'South Africa', PT: 'Portugal', DE: 'Germany', AE: 'UAE' };
var COUNTRY_ALIAS_ = { IC: 'CI' };

function sampleBucket_(s) {
  s = String(s || '').toLowerCase();
  return s === 'closed' ? 'done' : s === 'pending_audit' ? 'audit' : s === 'pending_review' ? 'review' : s === 'not_found' ? 'nf' : 'todo';
}
function taskBucket_(s) {
  s = String(s || '').toLowerCase();
  return s === 'accepted' ? 'done' : s === 'reviewed' ? 'audit' : s === 'submitted' ? 'review' : 'todo';
}
function companyCountry_(company) {
  var m = String(company || '').toUpperCase().match(/_([A-Z]{2})$/);
  var cc = m ? (COUNTRY_ALIAS_[m[1]] || m[1]) : '';
  return { code: cc, name: COUNTRY_NAMES_[cc] || cc || '—' };
}

function dashKey_() {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return 'DASH2|' + DASH_TABS_.map(tabVersion_).join('|') + '|' + tabVersion_('Flows') + '|' + today;
}

/** The cached payload if there is one (doGet embeds it), else null — never builds. */
function dashboardPeek_() {
  var d = cachedJsonPeek_(dashKey_());
  if (d) d.fromCache = true;
  return d;
}

/** Client endpoint. */
function getDashboard() {
  var t0 = Date.now();
  var me = getCurrentUser();
  if (!me.canDash) {
    logAccess_([{ event: 'dashboard', view: 'dash', outcome: 'refused', server_ms: Date.now() - t0, scope: '',
                  detail: 'role=' + (me.role || 'none') + ' (dashboard is for Administrators and dashboard_viewers)' }]);
    throw new Error('The dashboard is not available for your account.');
  }
  var d = cachedJson_(dashKey_(), 1800, dashboardData_);
  d.srvMs = Date.now() - t0;
  return d;
}

/* ---------- where the time went: each task's history, replayed from Activity_Log ----------
 * A task is always waiting on exactly one party: nobody yet (not assigned), its preparer, the
 * reviewer or the auditors. Every hand-over is a line of Activity_Log, so the days a task spent
 * with each of them are rebuilt from the log — nothing is stored, and a request that was already
 * running (or closed) before this page existed shows its whole history.
 *
 * Stages: pre (before the reviewer: not assigned, or with the preparer who owns it) → rev → aud →
 * done. An auditor's return ('ret') went to the preparer until 23 Nov 2026 and goes to the reviewer
 * since: the log line is the same, so it is decided by what happened NEXT (a preparer's submit =
 * it was with the preparer; anything else = with the reviewer; nothing yet = today's status).
 *
 * If the text or the meaning of one of these actions changes, update DASH_TASK_EV_ / DASH_LINE_EV_.
 * The rebuilt final stage is compared with the task's status: a task that does not land on its
 * own status is counted in `timeOff` and shown as a data check — never silently trusted.
 */
var DASH_TASK_EV_ = { ASSIGNMENT_SUBMIT: 'rev', ASSIGNMENT_WITHDRAW: 'pre', REVIEW_SUBMIT_TASK: 'aud', REVIEW_RETURN_TASK: 'pre',
                      AUDIT_CLOSE_TASK: 'done', AUDIT_RETURN_TASK: 'ret' };
// Whole-sample actions (logged on the sample): [stages of a task they concern, stage they lead to].
var DASH_LINE_EV_ = { REVIEW_SUBMIT: [['rev'], 'aud'], REVIEW_SUBMIT_TASK: [['rev'], 'aud'],
                      REVIEW_RETURN: [['rev', 'aud', 'done'], 'pre'], REVIEW_RETURN_TASK: [['rev', 'aud', 'done'], 'pre'],
                      AUDIT_CLOSE: [['rev', 'aud'], 'done'], AUDIT_RETURN: [['aud', 'done'], 'ret'] };
var ASSIGN_LOG_ACTION_ = 'ASSIGN_TASKS';   // Assign.js: one line per save, details = {"v":1,"tasks":[[assignment_id, from, to], …]}

function dashMs_(v) {
  if (v instanceof Date) return v.getTime();
  var n = Date.parse(String(v == null ? '' : v));
  return isNaN(n) ? 0 : n;
}
function dashStageOfStatus_(st) {
  st = String(st || '').toLowerCase();
  return st === 'accepted' ? 'done' : st === 'reviewed' ? 'aud' : st === 'submitted' ? 'rev' : 'pre';
}

/** The log, indexed once for the replay: status events per task / per sample, assignment history. */
function dashLogIndex_(log) {
  var ix = { asg: {}, line: {}, reqAssign: {}, owner: {} };
  var add = function (map, id, o) { (map[id] = map[id] || []).push(o); };
  log.forEach(function (e) {
    var action = String(e.action), type = String(e.entity_type), id = String(e.entity_id), ts = dashMs_(e.ts);
    if (!ts) return;
    if (type === 'assignment' && DASH_TASK_EV_[action]) add(ix.asg, id, { ts: ts, to: DASH_TASK_EV_[action], action: action, actor: String(e.actor || '') });
    else if (type === 'line' && DASH_LINE_EV_[action]) add(ix.line, id, { ts: ts, from: DASH_LINE_EV_[action][0], to: DASH_LINE_EV_[action][1], action: action, actor: String(e.actor || '') });
    else if (type === 'request' && action === 'ASSIGN') add(ix.reqAssign, id, ts);
    else if (type === 'request' && action === ASSIGN_LOG_ACTION_) {
      var list = parseJson_(e.details).tasks;
      if (Array.isArray(list)) list.forEach(function (x) {
        if (x && x.length >= 3) add(ix.owner, String(x[0]), { ts: ts, from: String(x[1] || ''), who: String(x[2] || '') });
      });
    }
  });
  return ix;
}

/**
 * One task → { segs: [{ h: 'none'|'prep'|'rev'|'aud', who, a, b }], end (ms it was closed, or 0),
 * ok (the replay lands on the task's status), exact (its assignments were logged per task),
 * acts: [{ action, actor }] the auditors' actions on it }.
 */
function dashReplayTask_(a, sys, reqCreatedMs, ix, now) {
  var t0 = dashMs_(a.created_at) || reqCreatedMs || now;
  if (t0 > now) t0 = now;
  var byTs = function (x, y) { return x.ts - y.ts; };
  var status = (ix.asg[String(a.assignment_id)] || []).concat(ix.line[String(a.line_id)] || []).sort(byTs);
  var own = (ix.owner[String(a.assignment_id)] || []).slice().sort(byTs);
  var exact = own.length > 0;

  // Who owned it first, and since when. With per-task assignment lines: the "from" of the first
  // one. Without (assigned before they existed): today's assignee, from the request's first
  // Assign save — an approximation, flagged by `exact`.
  var first = exact ? own[0].from : String(a.assigned_to || '').trim();
  var events = [];
  if (!sys && first) {
    var saves = (ix.reqAssign[String(a.request_id)] || []).filter(function (t) { return t >= t0 - 1000; }).sort(function (x, y) { return x - y; });
    var at = saves.length ? saves[0] : t0;
    if (status.length) at = Math.min(at, status[0].ts);
    if (own.length) at = Math.min(at, own[0].ts);
    events.push({ ts: Math.max(t0, at), who: first, k: 0 });
  }
  own.forEach(function (o) { events.push({ ts: o.ts, who: o.who, k: 0 }); });
  status.forEach(function (s) { events.push({ ts: s.ts, st: s, k: 1 }); });
  events.sort(function (x, y) { return (x.ts - y.ts) || (x.k - y.k); });

  var stage = sys ? 'rev' : 'pre', owner = '', cur = t0, end = 0, segs = [], acts = [], marks = [];
  var cut = function (to) {
    to = Math.min(Math.max(to, cur), now);
    if (to > cur && stage !== 'done') {
      segs.push({ h: stage === 'pre' ? (owner ? 'prep' : 'none') : stage === 'ret' ? 'ret' : stage, who: owner, a: cur, b: to });
    }
    cur = to;
  };
  events.forEach(function (e) {
    // A whole-sample action that did not concern this task is skipped. A task the auditor returned
    // counts as the reviewer's here: the only whole-sample actions that can follow are the reviewer's.
    if (e.st && e.st.from && e.st.from.indexOf(stage === 'ret' ? 'rev' : stage) === -1) return;
    cut(e.ts);
    if (e.st) {
      stage = e.st.to;
      end = stage === 'done' ? e.ts : 0;
      marks.push({ ts: e.ts, action: e.st.action });
      if (/^AUDIT_/.test(e.st.action)) acts.push({ action: e.st.action, actor: e.st.actor });
    } else owner = e.who;
  });
  cut(now);

  // An auditor's return: with the preparer or with the reviewer? (see the header)
  var today = dashStageOfStatus_(a.status);
  segs.forEach(function (s) {
    if (s.h !== 'ret') return;
    var next = null;
    for (var i = 0; i < marks.length; i++) if (marks[i].ts >= s.b) { next = marks[i]; break; }
    var toPrep = next ? next.action === 'ASSIGNMENT_SUBMIT' : today !== 'rev';
    s.h = toPrep ? (s.who ? 'prep' : 'none') : 'rev';
  });
  if (stage === 'ret') stage = today === 'rev' ? 'rev' : 'pre';
  return { segs: segs, end: end, ok: stage === today, exact: exact || sys, acts: acts };
}

function dashboardData_() {
  var tz = Session.getScriptTimeZone();
  var t = readTabsCached_(DASH_TABS_);
  var flowName = {};
  getFlows().forEach(function (f) { flowName[String(f.flow_id)] = String(f.name || f.flow_id); });
  var nowMs = Date.now(), DAY = 864e5;
  var today = Utilities.formatDate(new Date(nowMs), tz, 'yyyy-MM-dd');
  var zero = function () { return { todo: 0, review: 0, audit: 0, done: 0, nf: 0 }; };
  var day_ = function (ms) { return ms ? Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd') : ''; };
  var r1 = function (n) { return Math.round(n * 10) / 10; };

  var reqById = {};
  var requests = t.Requests.map(function (r) {
    var o = { request_id: String(r.request_id), flow_id: String(r.flow_id || ''), flow: flowName[String(r.flow_id)] || String(r.flow_id || ''),
              title: String(r.title || ''), ref: String(r.request_ref || r.title || r.request_id), period: String(r.period || ''),
              due: toDateStr_(r.due_date, tz), reviewer: String(r.reviewer_email || ''), auditor: String(r.auditor_email || ''), status: String(r.status || ''),
              createdMs: dashMs_(r.created_at), s: zero(), tk: zero(), samples: 0, tasks: 0, un: 0 };
    o.x = { co: {}, prep: {}, sys: zero(), time: { none: 0, prep: 0, rev: 0, aud: 0 }, held: { none: 0, prep: 0, rev: 0, aud: 0 },
            audBy: {}, open: 0, end: 0, off: 0, approx: 0 };
    reqById[o.request_id] = o;
    return o;
  });

  var lineById = {}, orphanLines = 0, orphanReqs = {};
  t.Sample_Lines.forEach(function (l) {
    var r = reqById[String(l.request_id)];
    if (!r) { orphanLines++; orphanReqs[String(l.request_id)] = true; return; }
    var company = String(l.company || '—');
    lineById[String(l.line_id)] = { req: r, company: company };
    var b = sampleBucket_(l.status);
    r.s[b]++; r.samples++;
    if (String(l.status).toLowerCase() === 'open') r.un++;
    if (!r.x.co[company]) {
      var c = companyCountry_(company);
      r.x.co[company] = { company: company, cc: c.code, country: c.name, s: zero(), tk: zero(), samples: 0, tasks: 0 };
    }
    r.x.co[company].s[b]++; r.x.co[company].samples++;
  });

  var ix = dashLogIndex_(t.Activity_Log || []), orphanTasks = 0;
  t.Assignments.forEach(function (a) {
    var ln = lineById[String(a.line_id)];
    if (!ln) { if (reqById[String(a.request_id)]) orphanTasks++; return; }
    var r = ln.req, x = r.x, b = taskBucket_(a.status), sys = parseJson_(a.detail_json).kind === 'system';
    r.tk[b]++; r.tasks++;
    var g = x.co[ln.company]; g.tk[b]++; g.tasks++;
    var owner = String(a.assigned_to || '').trim().toLowerCase();
    var person = function (who) { return x.prep[who] || (x.prep[who] = { who: who, tk: zero(), tasks: 0, days: 0, held: 0 }); };
    if (sys) x.sys[b]++;
    else { var p = person(owner); p.tk[b]++; p.tasks++; }

    var rp = dashReplayTask_(a, sys, r.createdMs, ix, nowMs);
    if (!rp.ok) x.off++;
    if (!rp.exact) x.approx++;
    if (b === 'done' && rp.end) x.end = Math.max(x.end, rp.end); else if (b !== 'done') x.open++;
    var seen = {}, seenWho = {};
    rp.segs.forEach(function (s) {
      var d = (s.b - s.a) / DAY;
      x.time[s.h] += d;
      if (!seen[s.h]) { seen[s.h] = true; x.held[s.h]++; }
      if (s.h === 'prep') {
        var who = String(s.who || '').toLowerCase(), pp = person(who);
        pp.days += d;
        if (!seenWho[who]) { seenWho[who] = true; pp.held++; }
      }
    });
    rp.acts.forEach(function (c) {
      var k = String(c.actor || '').toLowerCase(), q = x.audBy[k] || (x.audBy[k] = { who: k, closed: 0, returned: 0 });
      if (/CLOSE/.test(c.action)) q.closed++; else q.returned++;
    });
  });

  var timeOff = 0;
  requests.forEach(function (r) {
    var x = r.x; delete r.x;
    var open = r.samples - r.s.done - r.s.nf;
    r.daysLate = (r.due && r.due < today && open > 0) ? Math.round((Date.parse(today) - Date.parse(r.due)) / 864e5) : 0;
    var closedMs = (r.tasks && !x.open && x.end) ? x.end : 0;
    r.created = day_(r.createdMs); r.closed = day_(closedMs);
    r.days = r.createdMs ? Math.max(0, Math.round(((closedMs || nowMs) - r.createdMs) / DAY)) : 0;
    r.co = Object.keys(x.co).map(function (k) { return x.co[k]; }).sort(function (a, b) { return a.country.localeCompare(b.country) || a.company.localeCompare(b.company); });
    r.prep = Object.keys(x.prep).map(function (k) { var p = x.prep[k]; p.days = r1(p.days); return p; })
      .sort(function (a, b) { return (a.who === '') - (b.who === '') || b.tasks - a.tasks || a.who.localeCompare(b.who); });
    r.sys = x.sys;
    r.time = { none: r1(x.time.none), prep: r1(x.time.prep), rev: r1(x.time.rev), aud: r1(x.time.aud), held: x.held };
    r.audBy = Object.keys(x.audBy).map(function (k) { return x.audBy[k]; }).sort(function (a, b) { return (b.closed + b.returned) - (a.closed + a.returned); });
    r.approx = x.approx;
    timeOff += x.off;
  });
  requests.sort(function (a, b) { return (a.createdMs - b.createdMs) || a.request_id.localeCompare(b.request_id); });   // oldest first
  requests.forEach(function (r) { delete r.createdMs; });

  var reviewers = {};
  t.Sample_Lines.forEach(function (l) {
    var r = reqById[String(l.request_id)];
    if (r && sampleBucket_(l.status) === 'review' && r.reviewer) reviewers[r.reviewer] = (reviewers[r.reviewer] || 0) + 1;
  });

  // Shown only when one fails (the page no longer lists the checks that pass).
  var checks = [];
  if (orphanLines) checks.push(orphanLines + ' sample row(s) belong to request(s) no longer in Requests (' + Object.keys(orphanReqs).join(', ') + ') and are left out');
  if (orphanTasks) checks.push(orphanTasks + ' task(s) point to a sample that no longer exists and are left out');
  if (timeOff) checks.push('The history of ' + timeOff + ' task(s) does not end on their current status: their days may be attributed to the wrong party');

  return {
    asOf: Utilities.formatDate(new Date(nowMs), tz, 'd MMM yyyy HH:mm'), tz: tz, today: today, scope: 'ALL',
    requests: requests, reviewers: reviewers, checks: checks
  };
}

/* ---------- access log (rule 8: who, served/refused, server ms, scope) ---------- */
var ACCESS_EVENTS_ = ['open', 'view', 'call', 'dashboard', 'error'];

/**
 * Client beacon: a small batch of {event, view, outcome, server_ms, client_ms, scope, detail, visit}.
 * The user and role are taken from the session, never from the client. Any signed-in
 * @jumia.com user may log their own opens (refused opens included).
 */
function logUi(events) {
  if (!Array.isArray(events) || !events.length) return 0;
  var rows = events.slice(0, 40).filter(function (e) { return e && ACCESS_EVENTS_.indexOf(String(e.event)) !== -1; });
  logAccess_(rows);
  return rows.length;
}

function logAccess_(events) {
  if (!events || !events.length) return;
  try {
    var me = getCurrentUser();
    var ss = dataSs_();
    var sh = ss.getSheetByName('Access_Log');
    if (!sh) {
      sh = ss.insertSheet('Access_Log');
      sh.getRange(1, 1, 1, SCHEMA.data.Access_Log.length).setValues([SCHEMA.data.Access_Log]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    var cut = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
    var num = function (v) { var n = Number(v); return isFinite(n) && v !== '' && v != null ? Math.round(n) : ''; };
    events.forEach(function (e) {
      // appendRow per event: atomic, so two executions logging at once cannot overwrite each other.
      sh.appendRow([nowIso_(), me.email || '', me.role || '', cut(e.event, 20), cut(e.view, 40), cut(e.outcome, 20),
                    num(e.server_ms), num(e.client_ms), cut(e.scope, 40), cut(e.detail, 300), cut(e.visit, 12)]);
    });
  } catch (err) {
    Logger.log('logAccess_ failed (non-fatal): ' + err);
  }
}
