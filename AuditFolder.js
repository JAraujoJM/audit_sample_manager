/**
 * AuditFolder — the request's living audit folder (23 Nov 2026).
 * ---------------------------------------------------------------
 * Until now every click on Export rebuilt the whole package (workbook + every evidence file)
 * into a NEW dated Drive folder: slow for the auditor, and Exports/{request}/ filled up with
 * one folder per click. Now a request has ONE audit folder:
 *
 *   Exports/{request id}/{PBC ref} - audit export/
 *
 * created and shared the first time someone clicks Export, and from then on kept up to date by
 * a background job (a time trigger, the same mechanism as the AI pre-check, its own handler):
 *   - evidence is copied in when the reviewer approves its task and taken out again if the
 *     auditor returns the task (the rule is auditorSeesTask_, Review.js — nothing else);
 *   - the extraction files, execution log and sample list are copied once;
 *   - the workbook is rebuilt IN PLACE (same file) whenever anything it shows has changed.
 * The Export button only hands out the link and says whether the folder is up to date.
 *
 * How it stays correct:
 *   - Script property AFR_<request id> = the folder's state (id, url, the signature of the data
 *     it was built from, when, counts). A request is "stale" when the signature of its current
 *     rows differs — so a missed notification can never leave a folder silently out of date:
 *     the next run, the next Export click or the next time the audit view opens sees it.
 *   - Data tab Export_Files = one row per file / folder placed in an audit folder (the manifest).
 *     A sync only does what the manifest lacks, so it is idempotent and can stop at any file:
 *     a run works for AF_BUDGET_MS_, then schedules itself again until the folder is complete.
 *   - One sync at a time (script lock). A run that was killed leaves AFRUN_<id> behind; the next
 *     one then looks in Drive before copying, so nothing is copied twice.
 *   - Actions call noteExportChange_() AFTER their writes; the handler clears the "scheduled"
 *     flag BEFORE it reads — a change is either seen by the run or schedules the next one.
 *
 * Nothing here touches Requests / Sample_Lines / Assignments / Evidence, and the folders the
 * old export created (… - audit export (yyyy-MM-dd HH-mm)) are left as they are.
 */

var AF_STATE_   = 'AFR_';           // + request id → JSON state of that request's audit folder
var AF_RUNNING_ = 'AFRUN_';         // + request id → a sync of it is in progress (left behind only by a killed run)
var AF_ANY_     = 'AF_ANY';         // '1' once any audit folder exists (lets actions skip everything otherwise)
var AF_SYNC_AT_ = 'AF_SYNC_AT';     // when the pending background sync is due (ms); absent = none scheduled
var AF_LAST_    = 'AF_LAST_SYNC';   // when the last background sync ended (ms)
var AF_TAB_     = 'Export_Files';
var AF_VERSION_ = '1';              // bump to make every folder rebuild its workbook (a change of its layout)

var AF_FIRST_DELAY_MS_ = 60 * 1000;        // a change is picked up about a minute later…
var AF_MIN_GAP_MS_     = 5 * 60 * 1000;    // …but background syncs are at least this far apart (trigger runtime is a daily quota)
var AF_BUDGET_MS_      = 270 * 1000;       // one run works this long, then continues in the next one
var AF_RESERVE_MS_     = 60 * 1000;        // kept back at the end of a run for the workbook
var AF_FLAG_TTL_MS_    = 15 * 60 * 1000;   // a "scheduled" flag older than this is ignored (a trigger that never fired)
var AF_OVERDUE_MS_     = 3 * 60 * 1000;    // a scheduled sync this late did not fire: the next Export click does the work itself
var AF_BUNDLE_FILE_    = '_audit_folder_extractions.json';
var AF_XLSX_MIME_      = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ---------- state ---------- */
function afState_(requestId) {
  try { var s = PropertiesService.getScriptProperties().getProperty(AF_STATE_ + requestId); return s ? JSON.parse(s) : null; }
  catch (e) { return null; }
}
function afSave_(requestId, st) {
  st.missing = (st.missing || []).slice(0, 25).map(function (p) { return String(p).substring(0, 200); });
  var s = JSON.stringify(st);
  if (s.length > 8500) { st.missing = st.missing.slice(0, 5); st.err = String(st.err || '').substring(0, 300); s = JSON.stringify(st); }
  PropertiesService.getScriptProperties().setProperty(AF_STATE_ + requestId, s);
  try { scriptProps_()[AF_STATE_ + requestId] = s; } catch (e) {}
}
function afIsStale_(st, sig) { return !st.complete || !!st.pending || st.sig !== sig; }

/** What the client shows under the Export button. `staleNow` = the data moved on since the last sync. */
function afInfo_(st, staleNow) {
  return {
    folderUrl: st.url, folderName: st.name,
    status: (st.complete && !st.pending && !staleNow) ? 'ready' : 'updating',
    refreshedAt: st.at || '', fileCount: st.files || 0, totalMb: Math.round((st.bytes || 0) / 1048576 * 10) / 10,
    done: st.done || 0, total: st.total || 0, notReady: st.notReady || 0,
    missing: (st.missing || []).length, missingFiles: st.missing || [], shared: st.shared || [],
    error: st.err || '', download: null
  };
}

/* ---------- signatures: what a folder was built from ---------- */
function afStaticSig_(req) {
  return sha256HexStr_([AF_VERSION_, req.csv_file_id, req.xlsx_file_id, req.csv2_file_id, req.xlsx2_file_id, req.stages_json, req.ipe_json].join('|'));
}
/** Everything the workbook shows and the folder holds — not the notes and not the AI fields. */
function afSig_(req, lines, asg, evd) {
  return sha256HexStr_(JSON.stringify([afStaticSig_(req), req.request_ref, req.title, req.period, req.auditor_email, req.reviewer_email,
    lines.map(function (l) { return [l.line_id, l.status, l.document_no, l.company, l.subpopulation, l.amount, l.detail_json]; }),
    asg.map(function (a) { return [a.assignment_id, a.line_id, a.status, a.assigned_to, a.evidence_type, a.detail_json]; }),
    evd.map(function (e) { return [e.evidence_id, e.assignment_id, e.file_id, e.file_name, e.slot]; })]));
}
function afRowsOf_(rows, requestId) { return rows.filter(function (r) { return String(r.request_id) === String(requestId); }); }

/* ---------- the Export button ---------- */
/**
 * Hand out the request's audit folder: create and share it on the first click, make sure a sync
 * is on its way when it is not up to date, and return its link + state at once (the client then
 * follows the progress with auditFolderStatus). No ZIP any more: the folder is the deliverable.
 */
function auditExport(requestId) {
  var me = requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var req = findRequest_(requestId);
  if (!req) throw new Error('Request not found.');
  requestId = String(req.request_id);
  var props = PropertiesService.getScriptProperties();
  var exportsId = props.getProperty(PROP.EXPORTS);
  if (!exportsId) throw new Error('Exports folder not provisioned — run setup().');

  var st = afState_(requestId), created = false;
  if (!st || !afLiveFolder_(st.folderId)) {
    // Two first clicks at the same moment must not make two folders: the creation is locked
    // (when a long sync holds the lock we go on without it — the folder is found by its name).
    var lock = LockService.getScriptLock(), locked = false;
    try { locked = lock.tryLock(5000); } catch (e) {}
    try {
      st = afState_(requestId);
      if (!st || !afLiveFolder_(st.folderId)) {
        var name = sanitizeName_((req.request_ref || requestId) + ' - audit export');
        var folder = afNamedFolder_(getOrCreateFolder_(DriveApp.getFolderById(exportsId), requestId), name);
        st = { folderId: folder.getId(), url: folder.getUrl(), name: name, sig: '', staticSig: '', bundleId: '', complete: false, pending: true,
               at: '', files: 0, bytes: 0, done: 0, total: 0, notReady: 0, missing: [], shared: [], err: '', createdBy: me.email, createdAt: nowIso_() };
        afSave_(requestId, st);
        props.setProperty(AF_ANY_, '1');
        try { scriptProps_()[AF_ANY_] = '1'; } catch (e) {}
        created = true;
      }
    } finally { if (locked) { try { lock.releaseLock(); } catch (e) {} } }
  }

  // Share with whoever asks + the request's auditor(s) and reviewer (reader), once each.
  var have = st.shared || [];
  var add = afEmails_([me.email, req.auditor_email, req.reviewer_email]).filter(function (x) { return have.indexOf(x) === -1; });
  if (add.length) {
    var done = shareFileWith_(st.folderId, add);
    if (done.length) { st = afState_(requestId) || st; st.shared = afUnion_(st.shared, done); afSave_(requestId, st); }
  }

  var ds = dataSs_();
  var sig = afSig_(req, afRowsOf_(readObjects_(ds, 'Sample_Lines'), requestId), afRowsOf_(readObjects_(ds, 'Assignments'), requestId), afRowsOf_(readObjects_(ds, 'Evidence'), requestId));
  // Stale = the data moved on since the last sync; a file that could not be copied is tried again on every click.
  var stale = afIsStale_(st, sig) || (st.missing || []).length > 0;
  if (stale) {
    st = afState_(requestId) || st; st.pending = true; afSave_(requestId, st);
    // The background does the work. Safety net: when a sync that was scheduled did not start
    // (the trigger never fired), or no trigger can be created at all (scope not granted), the
    // click does it here — as far as one run goes; the next click continues.
    var dueAt = Number(props.getProperty(AF_SYNC_AT_) || 0);
    var overdue = dueAt > 0 && Date.now() - dueAt > AF_OVERDUE_MS_;
    if (overdue) { try { props.deleteProperty(AF_SYNC_AT_); } catch (e) {} }
    if (overdue || !scheduleExportSync_(true)) {
      if (afRunLocked_(Date.now() + AF_BUDGET_MS_) === 'more') scheduleExportSync_(true);
    }
    st = afState_(requestId) || st;
  }
  var info = afInfo_(st, false);
  logActivity('AUDIT_EXPORT', 'request', requestId,
    (created ? 'audit folder created; ' : '') + 'folder link given to ' + me.email + '; '
    + (info.status === 'ready' ? 'up to date (last updated ' + (st.at || '—') + ')' : 'being updated')
    + '; ' + info.fileCount + ' file(s); shared: ' + ((st.shared || []).join(', ') || 'none'));
  return info;
}

/** The folder's state, for the client to follow a sync (and nothing else: no work is done here). */
function auditFolderStatus(requestId) {
  requireRole_([ROLES.AUDITOR, ROLES.ADMIN]);
  var st = afState_(String(requestId));
  return st ? afInfo_(st, false) : null;
}

/**
 * The folder line of the audit view (reviewDetail, audit stage): shown without a click to the
 * people the folder is shared with. `t` = the tabs reviewDetail already read. When the data has
 * moved on since the last sync, a sync is scheduled — the view never waits for it.
 */
function afInfoForViewer_(req, me, t) {
  var raw = scriptProps_()[AF_STATE_ + req.request_id];
  if (!raw) return null;
  var st; try { st = JSON.parse(raw); } catch (e) { return null; }
  if (me.role !== ROLES.ADMIN && (st.shared || []).indexOf(String(me.email).toLowerCase()) === -1) return null;
  var id = req.request_id;
  var stale = afIsStale_(st, afSig_(req, afRowsOf_(t.Sample_Lines, id), afRowsOf_(t.Assignments, id), afRowsOf_(t.Evidence, id)));
  if (stale) noteExportChange_();
  return afInfo_(st, stale);
}

function afEmails_(list) {
  var out = [];
  list.forEach(function (x) {
    String(x || '').split(/[,;\s]+/).forEach(function (e) { e = e.toLowerCase().trim(); if (e && out.indexOf(e) === -1) out.push(e); });
  });
  return out;
}
function afUnion_(a, b) { var out = (a || []).slice(); (b || []).forEach(function (x) { if (out.indexOf(x) === -1) out.push(x); }); return out; }
function afLiveFolder_(id) {
  if (!id) return false;
  try { return !DriveApp.getFolderById(id).isTrashed(); } catch (e) { return false; }
}
/** The folder `name` under `parent` that is not in the bin, created when there is none. */
function afNamedFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) { var f = it.next(); try { if (!f.isTrashed()) return f; } catch (e) {} }
  return parent.createFolder(name);
}

/* ---------- scheduling (a time trigger, like the AI pre-check — its own handler) ---------- */
var __afNotedAt_ = 0;
/**
 * Called by an action AFTER it has written a status: if any audit folder exists, make sure a
 * background sync is on its way. Never throws; costs nothing while no folder exists.
 */
function noteExportChange_() {
  try {
    if (!scriptProps_()[AF_ANY_]) return;
    var now = Date.now();
    if (now - __afNotedAt_ < 3000) return;         // a loop over many tasks asks once every few seconds, not per task
    __afNotedAt_ = now;
    scheduleExportSync_(false);
  } catch (e) { /* the action never fails because of the folder */ }
}

/**
 * Make sure a sync trigger is pending. `soon` (the Export button) = within seconds; otherwise
 * about a minute after the first change, and at least AF_MIN_GAP_MS_ after the previous sync.
 * Returns false when no trigger could be created (the caller may then sync inline).
 */
function scheduleExportSync_(soon) {
  try {
    var props = PropertiesService.getScriptProperties(), now = Date.now();
    var dueAt = Number(props.getProperty(AF_SYNC_AT_) || 0);
    var pending = dueAt && now - dueAt < AF_FLAG_TTL_MS_;
    if (pending && (!soon || dueAt - now <= 5000)) return true;      // one is already on its way (soon enough)
    var delay = soon ? 1000 : Math.max(AF_FIRST_DELAY_MS_, Number(props.getProperty(AF_LAST_) || 0) + AF_MIN_GAP_MS_ - now);
    ScriptApp.newTrigger('runExportSync_').timeBased().after(delay).create();
    props.setProperty(AF_SYNC_AT_, String(now + delay));
    return true;
  } catch (e) {
    Logger.log('scheduleExportSync_ failed (the audit folder is then refreshed on the next Export click): ' + e);
    return false;
  }
}

/** Trigger handler: bring every stale audit folder up to date, as far as one run goes. */
function runExportSync_() {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'runExportSync_') ScriptApp.deleteTrigger(t);
    });
  } catch (e) { Logger.log('runExportSync_ cleanup: ' + e); }
  // BEFORE any data is read: a change noted from here on schedules the next run.
  try { PropertiesService.getScriptProperties().deleteProperty(AF_SYNC_AT_); } catch (e) {}
  var r = afRunLocked_(Date.now() + AF_BUDGET_MS_);
  if (r === 'busy') scheduleExportSync_(false);      // another sync holds the lock: come back later
  else if (r === 'more') scheduleExportSync_(true);  // not finished within the budget: continue
}

/** Run afSyncAll_ under the script lock. Returns 'done' | 'more' | 'busy' | 'error'. */
function afRunLocked_(deadline) {
  var lock = LockService.getScriptLock(), got = false;
  try { got = lock.tryLock(500); } catch (e) {}
  if (!got) return 'busy';
  try { return afSyncAll_(deadline) ? 'more' : 'done'; }
  catch (e) { Logger.log('audit folder sync failed: ' + e); return 'error'; }
  finally {
    try { PropertiesService.getScriptProperties().setProperty(AF_LAST_, String(Date.now())); } catch (e) {}
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** Sync every request whose folder is stale. Returns true when work is left for another run. */
function afSyncAll_(deadline) {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties();
  var ids = Object.keys(all).filter(function (k) { return k.indexOf(AF_STATE_) === 0; }).map(function (k) { return k.substring(AF_STATE_.length); });
  if (!ids.length) return false;
  var ds = dataSs_();
  var reqs = readObjects_(ds, 'Requests'), lines = readObjects_(ds, 'Sample_Lines'), asg = readObjects_(ds, 'Assignments'), evd = readObjects_(ds, 'Evidence');
  var more = false;
  ids.forEach(function (id) {
    var st = afState_(id);
    if (!st) return;
    var req = reqs.filter(function (r) { return String(r.request_id) === id; })[0];
    if (!req) { props.deleteProperty(AF_STATE_ + id); return; }      // the request is gone: forget the folder, leave it in Drive
    var rl = afRowsOf_(lines, id), ra = afRowsOf_(asg, id), re = afRowsOf_(evd, id);
    var sig = afSig_(req, rl, ra, re);
    if (!afIsStale_(st, sig)) return;
    if (Date.now() > deadline - AF_RESERVE_MS_) { more = true; return; }
    if (afSyncOne_(req, rl, ra, re, st, sig, deadline) === 'more') more = true;
  });
  return more;
}

/* ---------- one request ---------- */
/**
 * Bring one request's folder up to date. Order matters: (1) take out what the reviewer has not
 * approved (any more), (2) the extraction files, (3) the approved evidence, (4) the workbook —
 * rebuilt only when everything it lists is in the folder. Returns 'done' | 'more' | 'error'.
 */
function afSyncOne_(req, allLines, asg, evd, st, sig, deadline) {
  var requestId = String(req.request_id), props = PropertiesService.getScriptProperties();
  var tz = dataSs_().getSpreadsheetTimeZone();
  var recovery = !!props.getProperty(AF_RUNNING_ + requestId);      // the previous run of this request was killed mid-way
  props.setProperty(AF_RUNNING_ + requestId, String(Date.now()));
  var man = afManifest_(requestId), ch = { added: 0, removed: 0, statics: false, workbook: false };
  var pending = 0, missing = [], err = '', doneBefore = Number(st.done || 0);
  var inTime = function () { return Date.now() < deadline - AF_RESERVE_MS_; };
  try {
    var root = DriveApp.getFolderById(st.folderId);
    var mf = man.get('folder');
    if (mf && mf.file_id && mf.file_id !== st.folderId) man.resetAll();        // a new folder replaces a deleted one: nothing is in it yet
    man.set('folder', { kind: 'folder', path: '', source_id: '', file_id: st.folderId, bytes: 0, status: 'ok' });
    var dirs = afDirs_(root, man, recovery), known = recovery ? man.fileIds() : null;

    var flowMod = flowModule_(req.flow_id);
    var lines = allLines.filter(function (l) { return String(l.status).toLowerCase() !== 'not_found'; });
    var sample = exportSampleList_(req, allLines);
    var plan = exportPlan_(lines, asg, evd, sample, flowMod, tz);

    // 1. Out first: evidence of a task that is not approved (any more) must not stay in the folder.
    var want = {}; plan.copies.forEach(function (f) { want[f.key] = true; });
    man.rows('evidence').forEach(function (r) {
      if (r.status !== 'ok' || want[r.key]) return;
      afTrash_(r.file_id, false);
      man.set(r.key, { file_id: '', bytes: 0, status: 'removed' }); ch.removed++;
    });
    if (ch.removed) afPruneDirs_(man);

    // 2. The extraction side (IPE): computed once per extraction, then kept.
    var staticSig = afStaticSig_(req), bundle = (st.staticSig === staticSig && st.bundleId) ? afLoadBundle_(st.bundleId) : null;
    if (!bundle) {
      if (st.staticSig && st.staticSig !== staticSig) {                        // the request was extracted again / its files repaired
        man.rows('static').forEach(function (r) { if (r.status === 'ok') afTrash_(r.file_id, false); man.set(r.key, { file_id: '', bytes: 0, status: 'removed' }); });
      }
      bundle = exportStaticBundle_(req, flowMod);
      st.bundleId = ''; st.staticSig = '';
      if (!bundle.gwLog.error) {                                              // a failed log read is not kept: the next sync reads it again
        st.bundleId = afSaveBundle_(requestId, bundle);
        if (st.bundleId) st.staticSig = staticSig;
      }
      ch.statics = true;
    }
    var methodRows = exportMethodology_(flowMod, bundle.ext);
    var statics = afStaticItems_(bundle, sample, methodRows, plan);
    statics.forEach(function (it) {
      if (man.ok(it.key)) return;
      if (!inTime()) { pending++; return; }
      try {
        var f = it.make(function () { return dirs.get(it.dir); });
        if (!f) return;                                                        // an optional file that does not exist (yet)
        man.set(it.key, { kind: 'static', path: it.path, source_id: it.sourceId || '', file_id: f.getId(), bytes: afSize_(f), status: 'ok' }); ch.added++;
      } catch (e) {
        if (it.optional) return;
        man.set(it.key, { kind: 'static', path: it.path, source_id: it.sourceId || '', file_id: '', bytes: 0, status: 'missing' }); missing.push(it.path);
      }
    });

    // 3. The approved evidence, one Drive-side copy per file (no in-memory aggregate, no size ceiling).
    plan.copies.forEach(function (f) {
      if (man.ok(f.key)) return;
      if (!inTime()) { pending++; return; }
      try {
        var dest = dirs.get(f.dir), cp = recovery ? afAdopt_(dest, f.fileName, known) : null;
        if (!cp) cp = DriveApp.getFileById(f.fileId).makeCopy(f.fileName, dest);
        if (known) known[cp.getId()] = true;
        man.set(f.key, { kind: 'evidence', path: f.path, source_id: f.fileId, file_id: cp.getId(), bytes: afSize_(cp), status: 'ok' }); ch.added++;
        if (ch.added % 25 === 0) man.flush();
      } catch (e) {
        // Never swallow a failed copy: it is listed in the state, the workbook and on the screen.
        man.set(f.key, { kind: 'evidence', path: f.path, source_id: f.fileId, file_id: '', bytes: 0, status: 'missing' }); missing.push(f.path);
      }
    });

    // 4. The workbook: same file, new content — only once everything it lists is in the folder.
    // "n of m files": an optional file (a job file, the paste as received) counts once it is there.
    var planned = statics.filter(function (it) { return !it.optional || man.ok(it.key); }).length + plan.copies.length;
    st.total = planned + 1;
    st.done = statics.filter(function (it) { return man.ok(it.key); }).length
            + plan.copies.filter(function (f) { return man.ok(f.key); }).length + (man.ok('wb') ? 1 : 0);
    st.notReady = plan.notReady;
    if (!pending) {
      var need = st.sig !== sig || ch.added || ch.removed || ch.statics || !man.ok('wb')
              || JSON.stringify(missing) !== JSON.stringify(st.missing || []);
      if (need) {
        var at = nowIso_(), tot0 = man.totals();
        var blob = buildExportWorkbook_(req, plan, bundle, sample, methodRows,
          afStatusRows_(req, plan, lines.length, tot0.files + (man.ok('wb') ? 0 : 1), missing, bundle, tz), st.name + '.xlsx');
        var wb = man.get('wb'), size = 0;
        try { size = blob.getBytes().length; } catch (e) {}
        if (wb && wb.status === 'ok' && wb.file_id && afReplaceContent_(wb.file_id, blob)) {
          man.set('wb', { bytes: size, synced_at: at });
        } else {
          var nf = root.createFile(blob);
          if (wb && wb.file_id) afTrash_(wb.file_id, false);
          man.set('wb', { kind: 'workbook', path: st.name + '.xlsx', source_id: '', file_id: nf.getId(), bytes: afSize_(nf) || size, status: 'ok' });
        }
        ch.workbook = true; st.at = at; st.done = st.total - missing.length;
      }
      st.sig = sig; st.complete = true;
    } else {
      st.complete = false;
    }
    st.missing = missing;
  } catch (e) {
    err = String(e && e.message || e); st.complete = false;
  } finally {
    // A manifest that could not be written = files in Drive the app has no record of: the
    // "running" marker then stays, so the next run looks in Drive before it copies anything.
    var recorded = true;
    try { man.flush(); } catch (e2) { recorded = false; st.complete = false; err = err || ('the list of copied files could not be saved (' + e2 + ')'); }
    var tot = man.totals();
    st.files = tot.files; st.bytes = tot.bytes;
    // A sync that copies nothing three runs in a row stops asking for another run.
    st.stall = (!st.complete && !err && Number(st.done || 0) <= doneBefore) ? Number(st.stall || 0) + 1 : 0;
    if (st.stall >= 3) err = 'the folder is not progressing (' + st.done + ' of ' + st.total + ' files) — it will be tried again on the next change or Export click';
    st.err = err; st.pending = false;
    var cur = afState_(requestId);                                             // keep what an Export click added meanwhile
    if (cur) st.shared = afUnion_(st.shared, cur.shared);
    afSave_(requestId, st);
    if (recorded) { try { props.deleteProperty(AF_RUNNING_ + requestId); } catch (e3) {} }
  }
  if (ch.added || ch.removed || ch.workbook || err) {
    logActivity('AUDIT_FOLDER_SYNC', 'request', requestId,
      'added ' + ch.added + ' file(s), removed ' + ch.removed + (ch.workbook ? ', workbook refreshed' : '')
      + '; folder: ' + st.files + ' file(s), ~' + Math.round(st.bytes / 1048576) + ' MB'
      + (st.complete ? '' : '; ' + st.done + ' of ' + st.total + ' so far')
      + (st.notReady ? '; evidence of ' + st.notReady + ' task(s) not approved by the reviewer left out' : '')
      + (missing.length ? '; MISSING: ' + missing.join(' | ').substring(0, 1500) : '')
      + (err ? '; ERROR: ' + err : ''));
  }
  return err ? 'error' : (st.complete ? 'done' : 'more');
}

/** The files that are the same for the life of an extraction: [{ key, dir, path, sourceId, optional, make(getDir) }]. */
function afStaticItems_(bundle, sample, methodRows, plan) {
  var items = [];
  var copyOf = function (id, name) { return function (dir) { return DriveApp.getFileById(id).makeCopy(name, dir()); }; };
  // One CSV (+ SOX evidence xlsx) per extraction — the same list as the IPE tab. makeCopy keeps the
  // bytes, so the hashes in the IPE / execution log still match; only the name is the export's
  // stable one (query1_result.csv …) that the reconciliation tabs cite.
  bundle.ext.forEach(function (x) {
    items.push({ key: 'static:Extraction/' + x.exportCsv, dir: 'Extraction', path: 'Extraction/' + x.exportCsv, sourceId: x.csvId, make: copyOf(x.csvId, x.exportCsv) });
    if (x.xlsxId) items.push({ key: 'static:Extraction/' + x.exportXlsx, dir: 'Extraction', path: 'Extraction/' + x.exportXlsx, sourceId: x.xlsxId, make: copyOf(x.xlsxId, x.exportXlsx) });
  });
  // Execution log/: the gateway log lines (verbatim, file order) + the job files they hash.
  var logText = bundle.gwLog.lines.map(function (ln) { return ln.raw; }).join('\n') + (bundle.gwLog.lines.length ? '\n' : '');
  items.push({ key: 'static:Execution log/execution_log.jsonl', dir: 'Execution log', path: 'Execution log/execution_log.jsonl',
    make: function (dir) { return dir().createFile(Utilities.newBlob(logText, 'text/plain', 'execution_log.jsonl')); } });
  var jobs = {};
  bundle.gwLog.lines.forEach(function (ln) {
    var jf = ln.obj && ln.obj.job_file; if (!jf || jobs[jf]) return; jobs[jf] = true;
    items.push({ key: 'static:Execution log/jobs/' + jf, dir: 'Execution log/jobs', path: 'Execution log/jobs/' + jf, optional: true,
      make: function (dir) { var it = sub_('Requests_Completed').getFilesByName(jf); return it.hasNext() ? it.next().makeCopy(jf, dir()) : null; } });
  });
  // Sample list/: the paste as received (when stored) + the numbered list as CSV.
  if (sample.fileId) items.push({ key: 'static:Sample list/' + SAMPLE_LIST_FILE, dir: 'Sample list', path: 'Sample list/' + SAMPLE_LIST_FILE, sourceId: sample.fileId, optional: true, make: copyOf(sample.fileId, SAMPLE_LIST_FILE) });
  items.push({ key: 'static:Sample list/sample_list.csv', dir: 'Sample list', path: 'Sample list/sample_list.csv',
    make: function (dir) { return dir().createFile(Utilities.newBlob(sample.csv, 'text/csv', 'sample_list.csv')); } });
  // The methodology also sits NEXT TO the reconciliation workbook (whose own Methodology tab
  // exists only for requests enriched after it was added).
  if (methodRows && plan.copies.some(function (f) { return f.system; })) {
    items.push({ key: 'static:Reconciliation (system)/Methodology - reconciliation.xlsx', dir: 'Reconciliation (system)', path: 'Reconciliation (system)/Methodology - reconciliation.xlsx', optional: true,
      make: function (dir) {
        return buildXlsxFile_('Methodology - reconciliation', [{ name: 'Methodology', rows: methodRows, freezeRows: 1,
          colWidths: [30, 150, 620, 230, 420], styles: [{ range: 'A1:E' + methodRows.length, wrap: true, valign: 'top' }] }], dir());
      } });
  }
  return items;
}

/** The 'Export status' tab: when the folder was last refreshed and what it holds. */
function afStatusRows_(req, plan, sampleCount, fileCount, missing, bundle, tz) {
  var when = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + ' (' + tz + ')';
  return [
    ['Audit folder of the request', String(req.request_ref || req.request_id)],
    ['Last refreshed', when],
    ['How this folder works', 'The Audit Samples Manager keeps this folder up to date by itself: a few minutes after anything changes on the request, this workbook is rebuilt and the files are updated. There is no need to export again — reopen the folder.'],
    ['What it holds', 'The evidence of every task the reviewer has approved. If the auditor returns a task, its evidence is taken out until the reviewer approves it again. Tasks that are not approved yet are listed in "Samples & Tasks" with their status, without files.'],
    ['Samples', String(sampleCount)],
    ['Tasks', String(plan.tasks)],
    ['Tasks approved by the reviewer', String(plan.approved)],
    ['Tasks with evidence not included yet (not approved)', String(plan.notReady)],
    ['Files in this folder', String(fileCount)],
    ['Extraction files copied and hashed at (UTC)', String(bundle.builtAt || '')],
    ['Files that could not be copied', missing.length ? missing.join('\n') : 'none']
  ];
}

/* ---------- the manifest (Data tab Export_Files) ---------- */
/**
 * The rows of one request, read once; changes are kept in memory and written by flush() — each
 * changed row in place, new rows in one block at the end. Rows are never deleted (a file that is
 * taken out keeps its row, status 'removed'), so row numbers never move. Only a sync writes here,
 * and syncs hold the script lock.
 */
function afManifest_(requestId) {
  var ss = dataSs_(), H = SCHEMA.data[AF_TAB_], sh = ss.getSheetByName(AF_TAB_);
  if (!sh) {
    sh = ss.insertSheet(AF_TAB_);
    sh.getRange(1, 1, 1, H.length).setValues([H]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var values = sh.getDataRange().getValues(), hdr = values[0].map(String);
  var col = {}; H.forEach(function (h) { col[h] = hdr.indexOf(h); });
  var byKey = {}, order = [], fresh = [];
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][col.request_id]) !== requestId) continue;
    var o = {}; H.forEach(function (h) { o[h] = col[h] === -1 ? '' : values[r][col[h]]; });
    o.key = String(o.key); o.status = String(o.status); o.file_id = String(o.file_id || '');
    byKey[o.key] = { row: r + 1, v: o, dirty: false }; order.push(o.key);
  }
  var toRow = function (o) { var row = hdr.map(function () { return ''; }); H.forEach(function (h) { if (col[h] !== -1) row[col[h]] = o[h] == null ? '' : o[h]; }); return row; };
  return {
    get: function (key) { return byKey[key] ? byKey[key].v : null; },
    ok: function (key) { var e = byKey[key]; return !!e && e.v.status === 'ok' && !!e.v.file_id; },
    rows: function (kind) { return order.map(function (k) { return byKey[k].v; }).filter(function (v) { return v.kind === kind; }); },
    fileIds: function () { var s = {}; order.forEach(function (k) { var v = byKey[k].v; if (v.status === 'ok' && v.file_id) s[v.file_id] = true; }); return s; },
    set: function (key, patch) {
      var e = byKey[key];
      if (!e) {
        e = byKey[key] = { row: 0, v: { request_id: requestId, key: key, kind: '', path: '', source_id: '', file_id: '', bytes: 0, status: '', synced_at: '' }, dirty: true };
        order.push(key); fresh.push(key);
      }
      var changed = e.row === 0;
      Object.keys(patch).forEach(function (k) { if (String(e.v[k]) !== String(patch[k])) { e.v[k] = patch[k]; changed = true; } });
      if (changed) { if (!patch.synced_at) e.v.synced_at = nowIso_(); e.dirty = true; }
    },
    resetAll: function () {
      order.forEach(function (k) { var e = byKey[k]; if (e.v.status !== 'removed') { e.v.status = 'removed'; e.v.file_id = ''; e.v.bytes = 0; e.v.synced_at = nowIso_(); e.dirty = true; } });
    },
    totals: function () {
      var n = 0, b = 0;
      order.forEach(function (k) { var v = byKey[k].v; if (v.status === 'ok' && (v.kind === 'static' || v.kind === 'evidence' || v.kind === 'workbook')) { n++; b += Number(v.bytes) || 0; } });
      return { files: n, bytes: b };
    },
    flush: function () {
      var wrote = false;
      order.forEach(function (k) {
        var e = byKey[k];
        if (!e.dirty || e.row === 0) return;
        sh.getRange(e.row, 1, 1, hdr.length).setValues([toRow(e.v)]); e.dirty = false; wrote = true;
      });
      if (fresh.length) {
        var first = sh.getLastRow() + 1, short = first + fresh.length - 1 - sh.getMaxRows();
        if (short > 0) sh.insertRowsAfter(sh.getMaxRows(), short);
        sh.getRange(first, 1, fresh.length, hdr.length).setValues(fresh.map(function (k) { return toRow(byKey[k].v); }));
        fresh.forEach(function (k, i) { byKey[k].row = first + i; byKey[k].dirty = false; });
        fresh = []; wrote = true;
      }
      if (wrote) { forgetTab_(AF_TAB_); noteTabWrite_(AF_TAB_); }
    }
  };
}

/* ---------- Drive helpers ---------- */
/** Sub-folders of the audit folder by path ('Evidence/<sample>/<task>'), created on first use and remembered in the manifest. */
function afDirs_(root, man, recovery) {
  var cache = { '': root };
  var get = function (path) {
    if (cache[path]) return cache[path];
    var i = path.lastIndexOf('/'), parent = get(i === -1 ? '' : path.substring(0, i)), name = i === -1 ? path : path.substring(i + 1);
    var row = man.get('dir:' + path), f = null;
    if (row && row.status === 'ok' && row.file_id) { try { f = DriveApp.getFolderById(row.file_id); if (f.isTrashed()) f = null; } catch (e) { f = null; } }
    if (!f && recovery) {                                  // a killed run may have created it without recording it
      var it = parent.getFoldersByName(name);
      while (!f && it.hasNext()) { var c = it.next(); try { if (!c.isTrashed()) f = c; } catch (e) {} }
    }
    if (!f) f = parent.createFolder(name);
    man.set('dir:' + path, { kind: 'dir', path: path, source_id: '', file_id: f.getId(), bytes: 0, status: 'ok' });
    return (cache[path] = f);
  };
  return { get: get };
}
/** After a killed run: a file of that name already in `dest` that the manifest does not know is the copy we lost track of. */
function afAdopt_(dest, name, known) {
  try {
    var it = dest.getFilesByName(name);
    while (it.hasNext()) { var f = it.next(); if (!known[f.getId()] && !f.isTrashed()) return f; }
  } catch (e) {}
  return null;
}
/** Trash the folders under Evidence/ that hold no file any more (deepest first). */
function afPruneDirs_(man) {
  var live = man.rows('evidence').filter(function (r) { return r.status === 'ok'; }).map(function (r) { return String(r.path); });
  man.rows('dir').filter(function (d) { return d.status === 'ok' && String(d.path).indexOf('Evidence/') === 0; })
    .sort(function (a, b) { return String(b.path).length - String(a.path).length; })
    .forEach(function (d) {
      if (live.some(function (p) { return p.indexOf(d.path + '/') === 0; })) return;
      afTrash_(d.file_id, true);
      man.set(d.key, { file_id: '', status: 'removed' });
    });
}
function afTrash_(id, isFolder) {
  if (!id) return;
  try { (isFolder ? DriveApp.getFolderById(id) : DriveApp.getFileById(id)).setTrashed(true); } catch (e) {}
}
function afSize_(f) { try { return Number(f.getSize()) || 0; } catch (e) { return 0; } }

/** New content into the SAME Drive file (the workbook keeps its id, link and place). False when Drive refuses. */
function afReplaceContent_(fileId, blob) {
  try {
    var r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=media&supportsAllDrives=true',
      { method: 'patch', contentType: AF_XLSX_MIME_, payload: blob.getBytes(), headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    return r.getResponseCode() < 300;
  } catch (e) { return false; }
}

/** The extraction bundle (exportStaticBundle_) is kept as a JSON file next to the stored CSVs — not in the shared folder. */
function afSaveBundle_(requestId, bundle) {
  try {
    var folder = getOrCreateFolder_(DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS)), requestId);
    var old = folder.getFilesByName(AF_BUNDLE_FILE_);
    while (old.hasNext()) { try { old.next().setTrashed(true); } catch (e) {} }
    return folder.createFile(Utilities.newBlob(JSON.stringify(bundle), 'application/json', AF_BUNDLE_FILE_)).getId();
  } catch (e) { return ''; }
}
function afLoadBundle_(fileId) {
  try {
    var f = DriveApp.getFileById(fileId);
    if (f.isTrashed()) return null;
    var b = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
    return (b && Array.isArray(b.ext) && b.gwLog && Array.isArray(b.gwLog.lines)) ? b : null;
  } catch (e) { return null; }
}

/* ---------- administrator helpers (Apps Script editor) ---------- */
/** Bring every stale audit folder up to date now, in this execution (no trigger involved). */
function auditFolderSyncNow() {
  requireRole_([ROLES.ADMIN]);
  var r = afRunLocked_(Date.now() + AF_BUDGET_MS_);
  Logger.log('auditFolderSyncNow: ' + r + (r === 'more' ? ' — run it again to continue' : ''));
  return r;
}
/** Read-only: the state of every audit folder. */
function auditFolderStates() {
  requireRole_([ROLES.ADMIN]);
  var all = PropertiesService.getScriptProperties().getProperties(), out = {};
  Object.keys(all).forEach(function (k) { if (k.indexOf(AF_STATE_) === 0) { try { out[k.substring(AF_STATE_.length)] = JSON.parse(all[k]); } catch (e) {} } });
  Logger.log(JSON.stringify(out, null, 1));
  return out;
}
/**
 * Forget a request's audit folder: the next Export click starts a new one. The folder itself is
 * NOT deleted (rename or bin it by hand first — a folder of the same name would be reused), its
 * manifest rows are marked 'removed'.
 */
function auditFolderForget(requestId) {
  requireRole_([ROLES.ADMIN]);
  requestId = String(requestId || '');
  if (!afState_(requestId)) { Logger.log('No audit folder recorded for ' + requestId); return false; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('A sync is running — try again in a few minutes.');
  try {
    var man = afManifest_(requestId); man.resetAll(); man.flush();
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty(AF_STATE_ + requestId); props.deleteProperty(AF_RUNNING_ + requestId);
    logActivity('AUDIT_FOLDER_FORGET', 'request', requestId, 'audit folder forgotten by an administrator (the Drive folder is left as it is)');
  } finally { lock.releaseLock(); }
  return true;
}
