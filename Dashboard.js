/**
 * Dashboard — the CFO view of where the audit stands (20 Oct 2026).
 * -----------------------------------------------------------------
 * One payload: samples and tasks by audit stream (flow) × company × status bucket,
 * per-request due dates, where the tasks sit (preparer vs system), and the controls
 * the page runs on open. Built from the cached Data tabs (Cache.js) and itself cached
 * on the versions of the three tabs it reads, so an open costs ~one Apps Script call.
 *
 * Access: canSeeDashboard_ (Auth.js) — Administrators + Settings `dashboard_viewers`,
 * never Auditors. No AI output is read or returned here.
 *
 * Every open is logged in the Data spreadsheet's Access_Log tab: served opens by the
 * client beacon (logUi) with the server and browser time, refusals here on the server.
 */

var DASH_TABS_ = ['Requests', 'Sample_Lines', 'Assignments'];
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
  return 'DASH|' + DASH_TABS_.map(tabVersion_).join('|') + '|' + tabVersion_('Flows') + '|' + today;
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

function dashboardData_() {
  var tz = Session.getScriptTimeZone();
  var t = readTabsCached_(DASH_TABS_);
  var flowName = {};
  getFlows().forEach(function (f) { flowName[String(f.flow_id)] = String(f.name || f.flow_id); });
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var zero = function () { return { todo: 0, review: 0, audit: 0, done: 0, nf: 0 }; };

  var reqById = {};
  var requests = t.Requests.map(function (r) {
    var o = { request_id: String(r.request_id), flow_id: String(r.flow_id || ''), flow: flowName[String(r.flow_id)] || String(r.flow_id || ''),
              title: String(r.title || ''), ref: String(r.request_ref || r.title || r.request_id), period: String(r.period || ''),
              due: toDateStr_(r.due_date, tz), reviewer: String(r.reviewer_email || ''), status: String(r.status || ''),
              s: zero(), tk: zero(), samples: 0, tasks: 0 };
    reqById[o.request_id] = o;
    return o;
  });

  var lineById = {}, orphanLines = 0, orphanReqs = {};
  var grid = {};   // flow|company -> row
  t.Sample_Lines.forEach(function (l) {
    var r = reqById[String(l.request_id)];
    if (!r) { orphanLines++; orphanReqs[String(l.request_id)] = true; return; }
    lineById[String(l.line_id)] = { req: r, company: String(l.company || '—') };
    var b = sampleBucket_(l.status);
    r.s[b]++; r.samples++;
    var k = r.flow_id + '|' + String(l.company || '—');
    if (!grid[k]) {
      var c = companyCountry_(l.company);
      grid[k] = { flow_id: r.flow_id, flow: r.flow, company: String(l.company || '—'), cc: c.code, country: c.name, s: zero(), tk: zero(), samples: 0, tasks: 0 };
    }
    grid[k].s[b]++; grid[k].samples++;
  });

  var desk = { prep: zero(), sys: zero() }, orphanTasks = 0;
  t.Assignments.forEach(function (a) {
    var ln = lineById[String(a.line_id)];
    if (!ln) { if (reqById[String(a.request_id)]) orphanTasks++; return; }
    var b = taskBucket_(a.status), sys = parseJson_(a.detail_json).kind === 'system';
    ln.req.tk[b]++; ln.req.tasks++;
    var g = grid[ln.req.flow_id + '|' + ln.company]; g.tk[b]++; g.tasks++;
    desk[sys ? 'sys' : 'prep'][b]++;
  });

  requests.forEach(function (r) {
    var open = r.samples - r.s.done - r.s.nf;
    r.daysLate = (r.due && r.due < today && open > 0) ? Math.round((Date.parse(today) - Date.parse(r.due)) / 864e5) : 0;
  });
  var rows = Object.keys(grid).map(function (k) { return grid[k]; })
    .sort(function (a, b) { return a.flow.localeCompare(b.flow) || a.country.localeCompare(b.country); });

  var reviewers = {};
  t.Sample_Lines.forEach(function (l) {
    var r = reqById[String(l.request_id)];
    if (r && sampleBucket_(l.status) === 'review' && r.reviewer) reviewers[r.reviewer] = (reviewers[r.reviewer] || 0) + 1;
  });

  var controls = [];
  var sumSamples = requests.reduce(function (n, r) { return n + r.samples; }, 0);
  controls.push({ ok: true, text: 'Samples in scope = Sample_Lines rows of the ' + requests.length + ' request(s): ' + sumSamples });
  controls.push(orphanTasks ? { ok: false, text: orphanTasks + ' task(s) point to a sample that no longer exists' }
                            : { ok: true, text: 'Every task belongs to a sample in scope (' + t.Assignments.filter(function (a) { return reqById[String(a.request_id)]; }).length + ')' });
  if (orphanLines) controls.push({ ok: false, tag: 'Data check first',
    text: orphanLines + ' sample row(s) belong to request(s) no longer in Requests (' + Object.keys(orphanReqs).join(', ') + ') and are left out' });
  controls.push({ ok: true, text: 'No AI output on this page' });

  return {
    asOf: Utilities.formatDate(new Date(), tz, 'd MMM yyyy HH:mm'), tz: tz, today: today, scope: 'ALL',
    requests: requests, rows: rows, desk: desk, reviewers: reviewers, controls: controls
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
