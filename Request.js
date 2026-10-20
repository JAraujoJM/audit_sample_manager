/**
 * Request — server API for the Request view (Administrator).
 * ---------------------------------------------------------
 * Feeds the "New request" form (flows + their periods) and the "Previous
 * requests" tracker (progress + the IPE snapshot captured at enrichment time,
 * plus the stored CSV / evidence XLSX / email-thread files).
 */

/** Flows (active) with their selectable periods — drives the cascading form. */
function requestFormConfig() {
  requireRole_([ROLES.ADMIN]);
  return {
    flows: getFlows()
      .filter(function (f) { return f.active !== false && String(f.active) !== 'FALSE'; })
      .map(function (f) {
        return { flow_id: f.flow_id, name: f.name, periods: getPeriods(f.flow_id) };
      })
  };
}

/**
 * The Request screen in ONE call (was three: requestOverview + requestFormConfig +
 * listPreparers, each re-opening Config). Later refreshes call requestOverview alone.
 */
function requestScreen() {
  requireRole_([ROLES.ADMIN]);
  return { requests: requestOverview(), form: requestFormConfig(), preparers: listPreparers() };
}

/** Every request, newest first, with a line-status breakdown for the progress view. */
function requestOverview() {
  requireRole_([ROLES.ADMIN]);
  var tz = Session.getScriptTimeZone();
  var t = readTabsCached_(['Sample_Lines', 'Assignments', 'Requests']);
  var lines = t.Sample_Lines;
  var asg = t.Assignments;
  return t.Requests.map(function (r) {
    var rid = String(r.request_id);
    var rl = lines.filter(function (l) { return String(l.request_id) === rid; });
    var ra = asg.filter(function (a) { return String(a.request_id) === rid; });
    return {
      request_id: r.request_id, flow_id: r.flow_id, title: r.title,
      period: r.period, request_ref: r.request_ref || '', due_date: toDateStr_(r.due_date, tz),
      auditor_email: r.auditor_email || '', reviewer_email: r.reviewer_email || '',
      status: r.status, created_at: r.created_at, created_by: r.created_by,
      lineCount: rl.length, progress: progressOf_(rl),
      taskCount: ra.length, taskProgress: progressOf_(ra),
      files: { csv: !!r.csv_file_id, xlsx: !!r.xlsx_file_id, csv2: !!r.csv2_file_id, xlsx2: !!r.xlsx2_file_id }
    };
  }).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
}

/** One request in full: header, progress, which files are stored, and the IPE snapshot. */
function requestReport(requestId) {
  requireRole_([ROLES.ADMIN]);
  var t = readTabsCached_(['Requests', 'Sample_Lines']);
  var r = t.Requests.filter(function (x) { return String(x.request_id) === String(requestId); })[0];
  if (!r) throw new Error('Request not found.');
  var lines = t.Sample_Lines.filter(function (l) { return String(l.request_id) === String(requestId); });
  var ipe = null;
  if (r.ipe_json) { try { ipe = JSON.parse(r.ipe_json); } catch (e) {} }
  return {
    request: {
      request_id: r.request_id, flow_id: r.flow_id, title: r.title,
      period: r.period, period_start: r.period_start, period_end: r.period_end,
      auditor_email: r.auditor_email || '', reviewer_email: r.reviewer_email || '',
      request_ref: r.request_ref || '', due_date: r.due_date || '',
      status: r.status, created_at: r.created_at, created_by: r.created_by
    },
    lineCount: lines.length,
    progress: progressOf_(lines),
    files: { csv: !!r.csv_file_id, xlsx: !!r.xlsx_file_id, csv2: !!r.csv2_file_id, xlsx2: !!r.xlsx2_file_id },
    ipe: ipe
  };
}

/** Download a stored request file (which = 'csv' | 'xlsx' | 'csv2' | 'xlsx2') as a data URL. */
function getRequestFile(requestId, which) {
  requireRole_([ROLES.ADMIN, ROLES.REVIEWER, ROLES.AUDITOR]);
  var r = findRequest_(requestId);
  if (!r) throw new Error('Request not found.');
  var fid = { csv: r.csv_file_id, xlsx: r.xlsx_file_id, csv2: r.csv2_file_id, xlsx2: r.xlsx2_file_id }[which];
  if (!fid) throw new Error('That file was not stored for this request.');
  var blob = DriveApp.getFileById(fid).getBlob();
  var bytes = blob.getBytes();
  if (bytes.length > 12 * 1024 * 1024) throw new Error('File is too large to download here (' + Math.round(bytes.length / 1048576) + ' MB).');
  var mime = blob.getContentType();
  return { name: blob.getName(), mime: mime, dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(bytes) };
}

/* ---------- helpers ---------- */
function progressOf_(lines) {
  var p = {};
  lines.forEach(function (l) { var s = String(l.status).toLowerCase(); p[s] = (p[s] || 0) + 1; });
  return p;
}
