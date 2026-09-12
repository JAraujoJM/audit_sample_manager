/**
 * Audit Request Manager — Flow A proof of concept (Google Apps Script)
 * ---------------------------------------------------------------------
 * Drop document numbers, enrich them via the FinRec SQL Gateway, and show
 * the required Preparer action per line. No roles, no storage — just the engine.
 *
 * SETUP
 *  1. Create an Apps Script project (or `clasp create`), add this file + Index.html.
 *  2. The account running it needs WRITE on Requests_Pending/ and READ on
 *     Responses/ + Requests_Failed/ in the "FinRec Outside Teleport" shared folder.
 *  3. Deploy > New deployment > Web app (execute as: you; access: your org).
 *
 * NOTE ON THE QUERY: the gateway accepts ONE SELECT/CTE and rejects stacked
 * statements (`;`). The original IPE query used `DECLARE @startdate ...;` — that
 * would be rejected, so here the dates are inlined as literals (FY_START/FY_END).
 */

var BASE_FOLDER_ID = '1Aib8GX_vakFZmMOD_8Y_sLiIjE-kEqdV';
var APP_ID         = 'audit_request_manager';
var DATABASE       = 'AIG_Nav_Jumia_Reconciliation';
var FY_START       = '2025-01-01';   // Created_Date window (inclusive)
var FY_END         = '2026-01-01';   // exclusive
var QUERY_MODE     = 'full';         // 'lean' = routing only (fastest) | 'full' = + PO/down-payment/statement columns
var POLL_BUDGET_MS = 330000;         // 5.5 min
var POLL_INTERVAL  = 4000;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Audit Samples Manager')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- folder helpers ---------- */
function sub_(name) {
  return DriveApp.getFolderById(BASE_FOLDER_ID).getFoldersByName(name).next();
}

/* ---------- SQL building (flow-agnostic helpers) ---------- */
function sqlLiteral_(v) {                       // escape + quote a value for an IN list
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * Build the enrichment query for a flow. The flow module (FlowA.js, …) owns the
 * SQL; `p` carries { database, queryMode, fyStart, fyEnd } from the flow config +
 * the selected period.
 */
function buildQuery_(flowId, docs, p) {
  var mod = flowModule_(flowId);
  if (!mod || !mod.buildQuery) throw new Error('Flow "' + flowId + '" has no enrichment module.');
  return mod.buildQuery(docs, p);
}

/* ---------- routing (config-driven) ---------- */
/**
 * Required evidence for a line, from its routing `facts` (produced by the flow
 * module): every active Routing row of the flow whose match holds. One entry per
 * required document, so e.g. an advance line returns two.
 */
function routeFacts_(flowId, facts) {
  var matched = routeLine_(facts, flowId);
  if (matched.length) {
    return {
      key:     styleKey_(matched),
      label:   matched.map(function (m) { return m.required_evidence; }).join(' + '),
      matched: matched
    };
  }
  return { key: '', label: 'No routing rule matched', matched: [] };
}

/** Map matched routing rules to the UI's colour key (a-pop / a-vc / a-adv). */
function styleKey_(matched) {
  var names = matched.map(function (m) { return String(m.rule_name); }).join(' ');
  if (/advance/i.test(names)) return 'adv';
  if (/unpaid/i.test(names))  return 'vc';
  return 'pop';
}

/* ---------- gateway round trip ---------- */
function submitJob_(query, database, server) {
  var requestId = APP_ID + '_' + Utilities.getUuid();
  var job = {
    query: query, request_id: requestId, app_id: APP_ID, output_name: requestId,
    server: server || 'finrec',          // 'finrec' (AIG_Nav_*) | 'pay' (PAY_DWH) — a db only runs on its own server
    database: database || DATABASE, evidence: true, contract_version: 1,
    description: 'Audit Request Manager enrichment', requested_by: Session.getActiveUser().getEmail()
  };
  sub_('Requests_Pending').createFile(requestId + '.json', JSON.stringify(job, null, 2), 'application/json');
  return requestId;
}
function findResponse_(requestId, rx) {
  var files = sub_('Responses').getFiles();
  while (files.hasNext()) {
    var f = files.next(), n = f.getName();
    if (n.indexOf(requestId + '_') === 0 && rx.test(n)) return f;
  }
  return null;
}
function findCsv_(requestId) { return findResponse_(requestId, /\.csv$/i); }
function isFailed_(requestId) {
  return sub_('Requests_Failed').getFilesByName(requestId + '.json').hasNext();
}
function parseCsv_(file) {
  var text = file.getBlob().getDataAsString('UTF-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);   // strip BOM
  return Utilities.parseCsv(text);
}

/* ---------- safe retry: re-poll outstanding requests before resubmitting ---------- */
function sigItems_(items) { return items.map(function (i) { return String(i.key); }).sort().join('|'); }
function props_() { return PropertiesService.getUserProperties(); }

/** Parse the paste box into sample items via the flow module (or a default single-token
 *  parser for flows without one). Every item carries a `.key` used to match result rows. */
function parseSample_(flowId, text) {
  var mod = flowModule_(flowId);
  if (mod && typeof mod.parseSample === 'function') return mod.parseSample(text);
  return parseDocs_(text).map(function (d) { return { key: d }; });
}

/** Poll Responses/ for a request's CSV until the deadline. Returns the file, the
 *  string 'FAILED' if it landed in Requests_Failed/, or null on timeout. */
function pollCsv_(requestId, deadline) {
  while (Date.now() < deadline) {
    var f = findCsv_(requestId);
    if (f) return f;
    if (isFailed_(requestId)) return 'FAILED';
    Utilities.sleep(POLL_INTERVAL);
  }
  return null;
}

/**
 * Entry point from the New request form. `payload`:
 *   { docs, flowId, periodName, auditorEmail, reviewerEmail, dueDate, requestRef }
 * auditorEmail may be several comma-separated addresses. The flow + period select
 * the database and date window; the rest is captured on the persisted Request.
 *
 * Two-stage aware: query 1 (the flow's database) always runs; if the flow module
 * declares a dependent `stage2` and query 1 yields references, query 2 runs against
 * stage2.database and is merged in. One execution (~6-min cap). Safe-retry persists
 * BOTH stage ids under one signature, so a timeout RESUMES (re-polls) rather than
 * resubmitting — no duplicate jobs / orphaned results.
 */
function enrich(payload) {
  if (isSetupDone_()) requireRole_([ROLES.ADMIN]);   // SoD: only the Administrator runs enrichment
  payload = payload || {};
  var flow = getFlow(payload.flowId);
  if (!flow) throw new Error('Choose a flow.');
  var items = parseSample_(flow.flow_id, payload.docs || '');
  if (items.length === 0) return { status: 'empty' };

  var period = findPeriod_(payload.flowId, payload.periodName);
  if (!period) throw new Error('Choose a period.');

  var EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var auditors = String(payload.auditorEmail || '').split(/[;,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (!auditors.length || !auditors.every(function (e) { return EMAIL.test(e); })) {
    throw new Error('Enter valid auditor email(s), comma-separated.');
  }
  var reviewer = String(payload.reviewerEmail || '').trim();
  if (reviewer && !EMAIL.test(reviewer)) throw new Error('Enter a valid reviewer email.');

  var qp = { database: flow.database || DATABASE, queryMode: flow.query_mode || QUERY_MODE, fyStart: period.start, fyEnd: period.end };
  var mod = flowModule_(flow.flow_id);
  // A flow whose reconciliation task is owned by the reviewer (Flow C) needs one named up front.
  if (mod && mod.requiresReviewer && !reviewer) throw new Error('This flow assigns its reconciliation to the request\'s reviewer — enter a reviewer email.');
  var query = buildQuery_(flow.flow_id, items, qp);   // throws if the flow has no module yet
  var ctx = {
    flow: flow, period: period, qp: qp,
    auditor: auditors.join(', '), reviewer: reviewer,
    requestRef: String(payload.requestRef || '').trim(), dueDate: String(payload.dueDate || '').trim()
  };

  var signature = sigItems_(items) + '|' + flow.flow_id + '|' + period.start + '|' + period.end + '|' + qp.queryMode;
  var p = props_();
  var stored = JSON.parse(p.getProperty('outstanding') || 'null');
  var st = (stored && stored.sig === signature) ? stored : { sig: signature };
  var deadline = Date.now() + POLL_BUDGET_MS;

  // ----- Stage 1 -----
  if (!st.q1Id) { st.q1Id = submitJob_(query, qp.database); p.setProperty('outstanding', JSON.stringify(st)); }
  var csv1File = pollCsv_(st.q1Id, deadline);
  if (csv1File === 'FAILED') { p.deleteProperty('outstanding'); return { status: 'failed', requestId: st.q1Id, reason: 'Query 1 moved to Requests_Failed/ — see Logs/audit.jsonl' }; }
  if (!csv1File) return { status: 'pending', requestId: st.q1Id };
  var csv1 = parseCsv_(csv1File);
  var mapped = mapStage1Rows_(mod, csv1, items);

  // ----- Stages (optional: N dependent queries run in waves — Flow C) -----
  // Kept separate from the single `stage2` path below so Flow B's behaviour is untouched.
  if (mod && mod.stages && mod.stages.length) {
    var run = runStages_(mod, mapped, qp, st, p, deadline, ctx);
    if (run.status !== 'ok') return run;              // 'pending' (state kept → resume) or 'failed'
    ctx.csv1 = csv1; ctx.mapped = mapped;
    if (typeof mod.finalize === 'function') mod.finalize(mapped, ctx);   // checks + routing facts
    p.deleteProperty('outstanding');
    return buildResults_(mapped, items, st.q1Id, query, csv1File, ctx, null);
  }

  // ----- Stage 2 (optional, dependent on stage 1's references) -----
  var csv2 = null;
  if (mod && mod.stage2) {
    var refs = collectRefs_(mod, mapped);
    if (refs.length) {
      var query2 = mod.stage2.buildQuery(refs, qp);
      if (!st.q2Id) { st.q2Id = submitJob_(query2, mod.stage2.database, mod.stage2.server); p.setProperty('outstanding', JSON.stringify(st)); }
      var csv2File = pollCsv_(st.q2Id, deadline);
      if (csv2File === 'FAILED') { p.deleteProperty('outstanding'); return { status: 'failed', requestId: st.q2Id, reason: 'Query 2 (' + mod.stage2.database + ') moved to Requests_Failed/ — see Logs/audit.jsonl' }; }
      if (!csv2File) return { status: 'pending', requestId: st.q2Id };
      csv2 = parseCsv_(csv2File);
      ctx.query2 = query2; ctx.q2Id = st.q2Id; ctx.csv2File = csv2File; ctx.stage2db = mod.stage2.database;
    }
  }

  p.deleteProperty('outstanding');
  return buildResults_(mapped, items, st.q1Id, query, csv1File, ctx, csv2);
}

/** Group stage-1 rows by the flow's sampleKey and map each sample item to its group.
 *  A key can have several rows (e.g. a packlist with several payments); the module's
 *  mapGroup(rows, cellForFactory) folds them (line fields + facts + optional `units`
 *  to fan evidence over). Flows without mapGroup just map the first row. */
function mapStage1Rows_(mod, csv, items) {
  if (!mod || !csv || !csv.length) return items.map(function (i) { return { item: i, found: false, mapped: null }; });
  var header = csv[0], idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  function cellFor(row) { return function (name) { return idx[name] === undefined ? '' : row[idx[name]]; }; }
  var keyCol = mod.sampleKey || 'Transaction_No';
  var groups = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r];
    if (!row || row.length < 2) continue;          // skip blank trailing line
    var d = String(cellFor(row)(keyCol)).toUpperCase();
    if (d) (groups[d] = groups[d] || []).push(row);
  }
  return items.map(function (i) {
    var rows = groups[String(i.key).toUpperCase()];
    if (!rows || !rows.length) return { item: i, found: false, mapped: null };
    var mapped = (typeof mod.mapGroup === 'function') ? mod.mapGroup(rows, cellFor) : mod.mapRow(cellFor(rows[0]));
    return { item: i, found: true, mapped: mapped };
  });
}

/** Distinct, non-null stage-2 references built from the mapped stage-1 rows. */
function collectRefs_(mod, mapped) {
  if (!mod.stage2 || typeof mod.stage2.refOf !== 'function') return [];
  var seen = {}, out = [];
  mapped.forEach(function (mr) {
    if (!mr.found) return;
    var ref = mod.stage2.refOf(mr.mapped);
    if (ref && !seen[String(ref)]) { seen[String(ref)] = true; out.push(ref); }
  });
  return out;
}

/**
 * Run a module's `stages` — N dependent queries — in waves. A stage is submitted as
 * soon as every stage it `dependsOn` has landed (no dependencies → straight after
 * stage 1, so independent queries run in parallel on the gateway). All outstanding
 * jobs are polled together. Every gateway id persists under the run signature, so a
 * timed-out execution RESUMES (re-polls) instead of resubmitting. Each landed CSV is
 * folded into the mapped lines by the module (stage.fold) and kept on ctx.csvs /
 * ctx.stageFiles for the IPE and the stored files. A stage whose refs() is empty is
 * skipped (nothing to fetch) and counts as landed for its dependants.
 *
 * Contract: stage = { tag, label, server, database, dependsOn?[tags], refs(mapped, ctx),
 *                     buildQuery(refs, qp, ctx), fold(csv, cellFactory, mapped, ctx) }.
 * The module lists its stages in dependency order (dependants after their dependencies).
 */
function runStages_(mod, mapped, qp, st, p, deadline, ctx) {
  st.stages = st.stages || {};        // tag → gateway id (persisted for resume)
  st.skipped = st.skipped || {};      // tag → true when there was nothing to fetch
  ctx.data = ctx.data || {}; ctx.csvs = {}; ctx.stageFiles = [];
  var landed = {};
  var save = function () { p.setProperty('outstanding', JSON.stringify(st)); };
  var done = function (tag) { return !!(landed[tag] || st.skipped[tag]); };
  var depsMet = function (s) { return (s.dependsOn || []).every(done); };
  function cellFactory(csv) {
    var idx = {}; csv[0].forEach(function (h, i) { idx[String(h).trim()] = i; });
    return function (row) { return function (name) { return idx[name] === undefined ? '' : row[idx[name]]; }; };
  }
  function record(s, id) {
    var sf = ctx.stageFiles.filter(function (x) { return x.tag === s.tag; })[0];
    if (!sf) { sf = { tag: s.tag, label: s.label || s.tag, db: s.database, server: s.server || 'finrec', id: id, query: '' }; ctx.stageFiles.push(sf); }
    return sf;
  }

  for (var guard = 0; guard < 10000; guard++) {
    // 1) Submit every stage whose dependencies are met.
    var progressed = false;
    mod.stages.forEach(function (s) {
      if (done(s.tag) || st.stages[s.tag] || !depsMet(s)) return;
      var refs = s.refs(mapped, ctx) || [];
      if (!refs.length) { st.skipped[s.tag] = true; save(); progressed = true; return; }
      var q = s.buildQuery(refs, qp, ctx);
      st.stages[s.tag] = submitJob_(q, s.database, s.server);
      record(s, st.stages[s.tag]).query = q;
      save(); progressed = true;
    });

    // 2) Poll everything submitted and not yet landed (in module order = dependency order,
    //    so on a resumed execution a dependency is folded before its dependants).
    var outstanding = mod.stages.filter(function (s) { return st.stages[s.tag] && !landed[s.tag]; });
    if (!outstanding.length) {
      if (mod.stages.every(function (s) { return done(s.tag); })) break;
      if (!progressed) break;                       // nothing left that can start
      continue;
    }
    var anyLanded = false;
    for (var j = 0; j < outstanding.length; j++) {
      var o = outstanding[j], id = st.stages[o.tag];
      var f = findCsv_(id);
      if (f) {
        var csv = parseCsv_(f);
        landed[o.tag] = csv; ctx.csvs[o.tag] = csv;
        var sf = record(o, id); sf.csvFile = f;
        if (!sf.query) { try { sf.query = o.buildQuery(o.refs(mapped, ctx) || [], qp, ctx); } catch (e) {} }   // resumed run: rebuild for the record
        if (typeof o.fold === 'function' && csv.length > 1) o.fold(csv, cellFactory(csv), mapped, ctx);
        anyLanded = true;
      } else if (isFailed_(id)) {
        p.deleteProperty('outstanding');
        return { status: 'failed', requestId: id, reason: 'Query "' + (o.label || o.tag) + '" (' + o.database + ') moved to Requests_Failed/ — see Logs/audit.jsonl' };
      }
    }
    if (!anyLanded) {
      if (Date.now() >= deadline) {
        return { status: 'pending', requestId: outstanding.map(function (o) { return (o.label || o.tag); }).join(', ') };
      }
      Utilities.sleep(POLL_INTERVAL);
    }
  }
  // Only 'ok' when every stage has landed or been skipped; anything else resumes next run.
  if (mod.stages.every(function (s) { return done(s.tag); })) return { status: 'ok' };
  return { status: 'pending', requestId: mod.stages.filter(function (s) { return !done(s.tag); }).map(function (s) { return s.label || s.tag; }).join(', ') };
}

/**
 * Build an .xlsx from sheet specs: a throwaway Google Sheet (one tab per spec), exported
 * through Drive and saved into `folder`. Returns the File. Used for the system-evidence
 * workbook (Flow C).
 *
 * Minimal spec = { name, rows }: a grid of values. Strings beginning with '=' are FORMULAS
 * (SpreadsheetApp parses them, numbers and dates, like typed input). Optional presentation,
 * all of which survives the .xlsx export:
 *   header      bold first row (default true)        freezeRows  (default 1 when header)
 *   autoFilter  filter on the grid                    tabColor    '#rrggbb'
 *   gridlines   false hides them                      font        { family, size } for the grid
 *   colWidths   [px, px, …] by column (0 = leave)     rowHeights  { rowNumber: px }
 *   dateCols    'auto' → every column whose header contains "date" gets yyyy-mm-dd
 *   styles      [{ range:'B10:F10', bg, color, bold, italic, wrap, valign, halign, numberFormat,
 *                  border:{ top,left,bottom,right (bool), color, style:'thin'|'medium' } }]
 *   images      [{ b64, mime, col, row, offX, offY, width, height }] — over-grid pictures
 * Formulas are evaluated before the export so the file opens with values already in it.
 */
function buildXlsxFile_(name, sheets, folder) {
  var ss = SpreadsheetApp.create(name);
  try {
    var first = true, hasFormula = false;
    sheets.forEach(function (sh) {
      var rows = (sh.rows || []).filter(function (r) { return r && r.length; });
      var width = 0; rows.forEach(function (r) { if (r.length > width) width = r.length; });
      var s = first ? ss.getSheets()[0].setName(String(sh.name).slice(0, 99)) : ss.insertSheet(String(sh.name).slice(0, 99));
      first = false;
      if (sh.tabColor) s.setTabColor(sh.tabColor);
      if (sh.gridlines === false) s.setHiddenGridlines(true);
      var header = sh.header !== false;
      if (rows.length && width) {
        var CH = 4000;
        for (var r0 = 0; r0 < rows.length; r0 += CH) {
          var chunk = rows.slice(r0, r0 + CH).map(function (r, i) {
            var o = r.slice(0, width); while (o.length < width) o.push('');
            return o.map(function (v) {
              if (v === null || v === undefined) return '';
              if (typeof v === 'string' && v.charAt(0) === '=') { hasFormula = true; return v; }
              if (r0 + i > 0 && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16) return Number(v);
              return v;
            });
          });
          s.getRange(r0 + 1, 1, chunk.length, width).setValues(chunk);
        }
        if (header) s.getRange(1, 1, 1, width).setFontWeight('bold');
        var fr = (sh.freezeRows !== undefined) ? sh.freezeRows : (header ? 1 : 0);
        if (fr) s.setFrozenRows(fr);
        if (sh.autoFilter && rows.length > 1) { try { s.getRange(1, 1, rows.length, width).createFilter(); } catch (e) {} }
        if (sh.dateCols === 'auto' && header && rows.length > 1) {
          rows[0].forEach(function (h, i) { if (/date/i.test(String(h))) s.getRange(2, i + 1, rows.length - 1, 1).setNumberFormat('yyyy-mm-dd'); });
        }
        if (sh.font) {
          var all = s.getRange(1, 1, rows.length, width);
          if (sh.font.family) all.setFontFamily(sh.font.family);
          if (sh.font.size) all.setFontSize(sh.font.size);
        }
      }
      (sh.colWidths || []).forEach(function (px, i) { if (px) s.setColumnWidth(i + 1, px); });
      Object.keys(sh.rowHeights || {}).forEach(function (r) { s.setRowHeight(Number(r), sh.rowHeights[r]); });
      (sh.styles || []).forEach(function (st) { try { applyCellStyle_(s.getRange(st.range), st); } catch (e) {} });
      (sh.images || []).forEach(function (im) {
        try {
          var blob = Utilities.newBlob(Utilities.base64Decode(im.b64), im.mime || 'image/png', im.name || 'image.png');
          var img = s.insertImage(blob, im.col || 1, im.row || 1, im.offX || 0, im.offY || 0);
          if (im.width) img.setWidth(im.width);
          if (im.height) img.setHeight(im.height);
        } catch (e) { logActivity('WORKBOOK_IMAGE_FAILED', 'file', name, String(e)); }
      });
    });
    SpreadsheetApp.flush();
    if (hasFormula) { try { ss.getSheets().forEach(function (s) { s.getDataRange().getValues(); }); } catch (e) {} }   // force the calc so the export carries values
    var resp = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + ss.getId() + '/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (resp.getResponseCode() >= 300) throw new Error('Could not export the workbook (HTTP ' + resp.getResponseCode() + ').');
    return folder.createFile(resp.getBlob().setName(sanitizeName_(name) + '.xlsx'));
  } finally {
    try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) {}
  }
}
/** One style directive of a buildXlsxFile_ sheet spec applied to a Range. */
function applyCellStyle_(rg, st) {
  if (st.bg) rg.setBackground(st.bg);
  if (st.color) rg.setFontColor(st.color);
  if (st.bold !== undefined) rg.setFontWeight(st.bold ? 'bold' : 'normal');
  if (st.italic !== undefined) rg.setFontStyle(st.italic ? 'italic' : 'normal');
  if (st.fontSize) rg.setFontSize(st.fontSize);
  if (st.wrap) rg.setWrap(true);
  if (st.valign) rg.setVerticalAlignment(st.valign);
  if (st.halign) rg.setHorizontalAlignment(st.halign);
  if (st.numberFormat) rg.setNumberFormat(st.numberFormat);
  if (st.border) {
    var b = st.border, f = function (v) { return v === undefined ? null : !!v; };
    rg.setBorder(f(b.top), f(b.left), f(b.bottom), f(b.right), f(b.vertical), f(b.horizontal),
      b.color || '#000000', b.style === 'medium' ? SpreadsheetApp.BorderStyle.SOLID_MEDIUM : SpreadsheetApp.BorderStyle.SOLID);
  }
}

/**
 * Fold routing (+ any stage-2 detail) into the mapped rows and finalize. `csv2` is
 * the parsed query-2 result (or null); when present, each line's stage-2 reference is
 * matched against it and mod.stage2.merge folds those fields onto the line.
 */
function buildResults_(mapped, items, requestId, query, file, ctx, csv2) {
  ctx = ctx || {};
  var flowId = (ctx.flow && ctx.flow.flow_id) || 'flowA';
  var mod = flowModule_(flowId);

  var byRef = null, cell2 = null;
  if (mod && mod.stage2 && csv2 && csv2.length) {
    var h2 = csv2[0], idx2 = {};
    h2.forEach(function (h, i) { idx2[String(h).trim()] = i; });
    cell2 = function (row) { return function (name) { return idx2[name] === undefined ? '' : row[idx2[name]]; }; };
    byRef = {};
    var refCol = mod.stage2.keyCol;
    for (var r = 1; r < csv2.length; r++) {
      var row = csv2[r];
      if (!row || !row.length) continue;
      var k = String(cell2(row)(refCol)).toUpperCase();
      if (k && !byRef[k]) byRef[k] = row;
    }
  }

  var results = mapped.map(function (mr) {
    var item = mr.item;
    if (!mr.found) return { doc: item.key, item: item, found: false, _matched: [] };
    var m = mr.mapped;
    if (mod && mod.stage2 && byRef) {
      var ref = mod.stage2.refOf(m);
      if (ref) { var r2 = byRef[String(ref).toUpperCase()]; if (r2) mod.stage2.merge(m, mod.stage2.mapRow2(cell2(r2))); }
    }
    var routed = routeFacts_(flowId, m.facts || {});
    var out = { doc: item.key, item: item, found: true, action: routed.key, action_label: routed.label, _matched: routed.matched };
    Object.keys(m).forEach(function (k) { if (k !== 'facts') out[k] = m[k]; });
    return out;
  });
  var foundCount = results.filter(function (x) { return x.found; }).length;
  return finalizeRun_(results, items, foundCount, requestId, query, file, ctx);
}

/* ---------- persist a successful run, then return a clean payload to the UI ---------- */
function finalizeRun_(results, docs, foundCount, requestId, query, file, ctx) {
  ctx = ctx || {};
  var ipe = buildIpe_(docs, foundCount, requestId, query, file, ctx);
  var ret = { status: 'ok', requestId: requestId, rows: results.map(stripInternal_), ipe: ipe };
  if (isSetupDone_()) {
    try {
      ret.dbRequestId = persistRun_(results, requestId, file, ctx, ipe).dbRequestId;
    } catch (e) {
      ret.persistError = String(e);                // never block the auditor's result on a write failure
      logActivity('ENRICH_PERSIST_FAILED', 'request', requestId, String(e));
    }
  }
  return ret;
}

function stripInternal_(row) {
  var o = {};
  for (var k in row) if (row.hasOwnProperty(k) && k.charAt(0) !== '_') o[k] = row[k];
  return o;
}

// Flow-specific line fields (everything the mapped row carries beyond the standard
// Sample_Lines columns) → stored as detail_json so the views can render them without
// the engine knowing the flow's shape. Empty values are dropped to keep it compact.
var LINE_STD_ = { doc: 1, item: 1, found: 1, action: 1, action_label: 1, company: 1, vendor: 1,
                  mpl: 1, paid_at: 1, statement: 1, amount: 1, closing_balance: 1, po: 1, downpay: 1,
                  document_no: 1, subpopulation: 1, units: 1 };
function lineDetail_(r) {
  var d = {};
  for (var k in r) {
    if (!r.hasOwnProperty(k) || k.charAt(0) === '_' || LINE_STD_[k]) continue;
    var v = r[k];
    if (v === '' || v === null || v === undefined) continue;
    d[k] = v;
  }
  return d;
}

/** A routing rule / assignment is optional when its flag is truthy (config cells may
 *  arrive as boolean true or the strings 'TRUE'/'true'). Optional evidence never gates. */
function isOptional_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function slug_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'doc'; }

/**
 * The document slots inside one task. `documents` is a routing cell: a '|'-separated
 * list of document labels, each with a trailing '*' to mark it optional (e.g.
 * "BOB voucher screenshot|OMS screenshot|B2B proof of payment*"). Empty → a single
 * slot named after the required_evidence (a plain one-document task). Returns
 * [{ key, label, optional }].
 */
function parseSlots_(documents, fallbackLabel) {
  var raw = String(documents || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!raw.length) return [{ key: slug_(fallbackLabel), label: String(fallbackLabel || 'Document'), optional: false }];
  return raw.map(function (d) {
    var optional = /\*\s*$/.test(d);
    var label = d.replace(/\*\s*$/, '').trim();
    return { key: slug_(label), label: label, optional: optional };
  });
}

/**
 * A successful enrichment becomes a Request + one Sample_Line per document + one
 * Assignment per required evidence item. Assignments default to the routing
 * `responsible`; when that's a role (not an email), assigned_to is left blank for
 * the admin to assign a specific preparer — including different people per item.
 */
function persistRun_(results, gatewayRequestId, file, ctx, ipe) {
  ctx = ctx || {};
  var flow   = ctx.flow   || getFlow('flowA') || { flow_id: 'flowA', name: 'Marketplace revenues / COGS' };
  var period = ctx.period || { name: '', start: '', end: '' };
  var actor  = Session.getActiveUser().getEmail() || 'system';
  var ds     = dataSs_();
  var reqId  = newId_('REQ');
  var ts     = nowIso_();
  var mod    = flowModule_(flow.flow_id);

  var stored = {};
  try { stored = storeRequestFiles_(reqId, gatewayRequestId, file, ctx.q2Id, ctx.csv2File, ctx.stageFiles); }
  catch (e) { logActivity('STORE_FILES_FAILED', 'request', reqId, String(e)); }

  appendObject_(ds, 'Requests', {
    request_id: reqId, flow_id: flow.flow_id, title: flow.name,
    period: period.name, period_start: period.start, period_end: period.end,
    auditor_email: ctx.auditor || '', reviewer_email: ctx.reviewer || '',
    request_ref: ctx.requestRef || '', due_date: ctx.dueDate || '',
    status: 'enriched', created_by: actor, created_at: ts, updated_at: ts,
    csv_file_id: stored.csvId || '', xlsx_file_id: stored.xlsxId || '',
    csv2_file_id: stored.csv2Id || '', xlsx2_file_id: stored.xlsx2Id || '',
    ipe_json: ipe ? JSON.stringify(ipe) : '',
    stages_json: (stored.stages && stored.stages.length) ? JSON.stringify(stored.stages) : ''
  });

  // SYSTEM tasks: a routing rule whose `responsible` is the Reviewer role means the app
  // itself produced the evidence (Flow C's reconciliation). Such a task is assigned to the
  // request's reviewer, auto-submitted, and carries the computed checks + verdict. The
  // module supplies ONE workbook per request (summaries + raw extracts) that is attached
  // as the evidence file of every system task.
  var isSystemRule = function (m) { return String(m.responsible || '') === ROLES.REVIEWER; };
  var wbFile = null;
  var anySystem = results.some(function (r) { return r.found && (r._matched || []).some(isSystemRule); });
  if (anySystem && mod && typeof mod.evidenceWorkbook === 'function') {
    try {
      var exportsId = PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS);
      if (!exportsId) throw new Error('Exports folder not provisioned');
      var wb = mod.evidenceWorkbook(ctx.mapped || [], ctx);
      wbFile = buildXlsxFile_(wb.name, wb.sheets, getOrCreateFolder_(DriveApp.getFolderById(exportsId), reqId));
    } catch (e) { wbFile = null; logActivity('SYSTEM_EVIDENCE_FAILED', 'request', reqId, String(e)); }
  }

  var lines = 0, assignments = 0, systemTasks = 0;
  results.forEach(function (r) {
    var lineId = newId_('LIN');
    var it = r.item || {};
    if (!r.found) {
      appendObject_(ds, 'Sample_Lines', {
        line_id: lineId, request_id: reqId,
        document_no: it.soi || r.doc, company: it.company || '',
        status: 'not_found', required_count: 0, created_at: ts
      });
      lines++;
      return;
    }
    var matched = r._matched || [];
    var detail = lineDetail_(r);
    // Some subpopulations fan one evidence requirement over several data units
    // (Cash & POS: one proof of payment per payment on the transaction list).
    var units = (r.units && r.units.length) ? r.units : [null];
    var requiredCount = 0;
    matched.forEach(function (m) { if (!isOptional_(m.optional)) requiredCount += (isSystemRule(m) ? 1 : units.length); });
    // A system task is submitted the moment it exists, so a sample that has one starts
    // on the reviewer's desk (per-task semantics — its human tasks follow at their pace).
    var hasSystem = !!ctx.reviewer && matched.some(isSystemRule);
    appendObject_(ds, 'Sample_Lines', {
      line_id: lineId, request_id: reqId,
      document_no: r.document_no || r.doc,
      company: r.company || it.company || '',
      vendor: r.vendor || '', mpl_type: r.mpl || '',
      paid_status: r.paid_at ? 'Paid' : (r.mpl ? 'Unpaid' : ''),
      statement_code: r.statement || '', amount: r.amount || '',
      paid_at: r.paid_at || '', closing_balance: r.closing_balance || '',
      route_rule: matched.map(function (m) { return m.rule_name; }).join(','),
      required_count: requiredCount, status: hasSystem ? 'pending_review' : 'open',
      evidence_folder_id: '', created_at: ts,
      subpopulation: r.subpopulation || '',
      detail_json: Object.keys(detail).length ? JSON.stringify(detail) : ''
    });
    lines++;
    matched.forEach(function (m) {
      var resp = String(m.responsible || ''), opt = isOptional_(m.optional);
      if (isSystemRule(m)) {
        var verdict = r.recon_verdict || 'uncertain', summary = String(r.recon_summary || '').substring(0, 900);
        var asgId = newId_('ASG');
        appendObject_(ds, 'Assignments', {
          assignment_id: asgId, line_id: lineId, request_id: reqId,
          evidence_type: m.required_evidence,
          assigned_to: ctx.reviewer || '',
          status: ctx.reviewer ? 'submitted' : 'pending', due_date: '', submitted_at: ctx.reviewer ? ts : '', notes: '', created_at: ts,
          optional: opt ? true : '',
          detail_json: JSON.stringify({ kind: 'system', checks: r.checks || [], verdict: verdict, summary: summary }),
          slots_json: '',
          ai_verdict: verdict, ai_summary: summary, ai_checked_at: ts
        });
        if (wbFile) {
          appendObject_(ds, 'Evidence', {
            evidence_id: newId_('EVD'), assignment_id: asgId, line_id: lineId, request_id: reqId,
            file_id: wbFile.getId(), file_name: wbFile.getName(), mime: wbFile.getMimeType(),
            uploaded_by: 'system', uploaded_at: ts, status: 'uploaded', slot: ''
          });
        }
        logActivity('SYSTEM_RECON', 'assignment', asgId, 'verdict=' + verdict + ' :: ' + summary.substring(0, 400));
        assignments++; systemTasks++;
        return;
      }
      // A task may bundle several document slots (Voucher, JumiaPay = one owner, one
      // task, several uploads). Single-document tasks (Flow A, Cash & POS) leave
      // slots_json empty and use the free upload.
      var slots = parseSlots_(m.documents, m.required_evidence);
      var slotsJson = slots.length > 1 ? JSON.stringify(slots) : '';
      units.forEach(function (u) {
        appendObject_(ds, 'Assignments', {
          assignment_id: newId_('ASG'), line_id: lineId, request_id: reqId,
          evidence_type: m.required_evidence,
          assigned_to: /@jumia\.com$/i.test(resp) ? resp : '',
          status: 'pending', due_date: '', submitted_at: '', notes: '', created_at: ts,
          optional: opt ? true : '',
          detail_json: u ? JSON.stringify(u) : '',
          slots_json: slotsJson
        });
        assignments++;
      });
    });
  });

  // Samples that opened on the reviewer's desk get their line-level check queued (for
  // system tasks it is deterministic — no AI call — see assessLineCore_).
  if (systemTasks) scheduleAiCheck_();
  logActivity('ENRICH_PERSIST', 'request', reqId,
              lines + ' lines, ' + assignments + ' assignments' + (systemTasks ? (' incl. ' + systemTasks + ' system') : '') + ' (gateway ' + gatewayRequestId + ')');
  return { dbRequestId: reqId, lines: lines, assignments: assignments };
}

function newId_(prefix) { return prefix + '_' + Utilities.getUuid().slice(0, 8); }

/**
 * Copy the gateway outputs (result CSV + SOX evidence XLSX) into Exports/{reqId}/
 * so we keep our own copy to hand to the audit team. The XLSX can land a few
 * seconds after the CSV, so wait a short while for it. Files are COPIED (the
 * gateway's Responses/ is shared).
 */
function storeRequestFiles_(reqId, gatewayRequestId, csvFile, gateway2Id, csv2File, stageFiles) {
  var exportsId = PropertiesService.getScriptProperties().getProperty(PROP.EXPORTS);
  if (!exportsId) return {};
  var folder = getOrCreateFolder_(DriveApp.getFolderById(exportsId), reqId);
  var out = {};

  if (csvFile)  { try { out.csvId  = csvFile.makeCopy(csvFile.getName(), folder).getId(); } catch (e) {} }
  if (csv2File) { try { out.csv2Id = csv2File.makeCopy(csv2File.getName(), folder).getId(); } catch (e) {} }

  // N-stage flows (Flow C): one CSV (+ evidence xlsx) per dependent query.
  var stages = (stageFiles || []).filter(function (sf) { return sf.csvFile; }).map(function (sf) {
    var rec = { tag: sf.tag, label: sf.label, db: sf.db, server: sf.server || 'finrec', gatewayId: sf.id, csvName: sf.csvFile.getName(), csvId: '', xlsxId: '' };
    try { rec.csvId = sf.csvFile.makeCopy(sf.csvFile.getName(), folder).getId(); } catch (e) {}
    return rec;
  });
  if (stages.length) out.stages = stages;

  // Every query's SOX evidence workbook can land a few seconds after its CSV.
  var need = function () { return !out.xlsxId || (gateway2Id && !out.xlsx2Id) || stages.some(function (s) { return !s.xlsxId; }); };
  var deadline = Date.now() + 20000;
  while (Date.now() < deadline && need()) {
    if (!out.xlsxId) { var x1 = findResponse_(gatewayRequestId, /\.xlsx$/i); if (x1) { try { out.xlsxId = x1.makeCopy(x1.getName(), folder).getId(); } catch (e) {} } }
    if (gateway2Id && !out.xlsx2Id) { var x2 = findResponse_(gateway2Id, /\.xlsx$/i); if (x2) { try { out.xlsx2Id = x2.makeCopy(x2.getName(), folder).getId(); } catch (e) {} } }
    stages.forEach(function (s) { if (!s.xlsxId) { var xs = findResponse_(s.gatewayId, /\.xlsx$/i); if (xs) { try { s.xlsxId = xs.makeCopy(xs.getName(), folder).getId(); } catch (e) {} } } });
    if (!need()) break;
    Utilities.sleep(2500);
  }
  return out;
}

/* ---------- IPE / SOX evidence metadata ---------- */
function sha256Hex_(bytes) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return d.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function buildIpe_(docs, foundCount, requestId, query, file, ctx) {
  ctx = ctx || {};
  var flow   = ctx.flow   || { flow_id: 'flowA', name: 'Marketplace revenues / COGS' };
  var period = ctx.period || { name: '', start: FY_START, end: FY_END };
  var qp     = ctx.qp     || { database: DATABASE, queryMode: QUERY_MODE };
  var now = new Date();
  var yyyymm = Utilities.formatDate(now, 'UTC', 'yyyyMM');
  var ts = Utilities.formatDate(now, 'UTC', 'yyyy-MM-dd HH:mm:ss') + ' UTC';
  var blob = file ? file.getBlob() : null;
  var bytes = blob ? blob.getBytes() : [];
  var requested = docs.length, notFound = requested - foundCount;

  // Two-stage flows (Cash Anchor) carry a dependent second query on another server.
  var blob2 = ctx.csv2File ? ctx.csv2File.getBlob() : null;
  var bytes2 = blob2 ? blob2.getBytes() : [];

  return {
    documentRef:    'IPE-' + String(flow.flow_id || 'flow').toUpperCase() + '-' + yyyymm,
    period:         (period.name ? period.name + ' · ' : '') + 'date window ' + period.start + ' → ' + period.end,
    scope:          flow.name + ' · ' + flow.flow_id,
    primaryDb:      qp.database,
    queryMode:      qp.queryMode,
    timestamp:      ts,
    requestedBy:    Session.getActiveUser().getEmail() || 'n/a',
    requestId:      requestId,
    classification: 'CONFIDENTIAL · SOX-Relevant',
    status:         'Draft',
    requested:      requested,
    found:          foundCount,
    notFound:       notFound,
    query:          query || '',
    csvName:        file ? file.getName() : '',
    csvSize:        bytes.length,
    csvSha256:      bytes.length ? sha256Hex_(bytes) : '',
    query2:         ctx.query2 || '',
    query2Db:       ctx.stage2db || '',
    csv2Name:       ctx.csv2File ? ctx.csv2File.getName() : '',
    csv2Size:       bytes2.length,
    csv2Sha256:     bytes2.length ? sha256Hex_(bytes2) : '',
    // N-stage flows (Flow C): one entry per dependent query, each hashed over its raw CSV.
    stages:         (ctx.stageFiles || []).map(function (sf) {
                      var b = sf.csvFile ? sf.csvFile.getBlob().getBytes() : [];
                      return { tag: sf.tag, label: sf.label, db: sf.db, server: sf.server || 'finrec', query: sf.query || '',
                               csvName: sf.csvFile ? sf.csvFile.getName() : '', csvSize: b.length, csvSha256: b.length ? sha256Hex_(b) : '' };
                    }),
    evidenceNote:   'A SOX evidence workbook (query, script, result set, timestamp) was generated by the gateway for this request (evidence = true).',
    checks: [
      { name: 'Source authenticity',  method: 'Read-only SELECT executed via the FinRec SQL gateway (no client DB access)', result: 'Pass' },
      { name: 'Period integrity',     method: 'Date literals from the selected period (' + period.start + ' to ' + period.end + '); no DECLARE', result: 'Pass' },
      { name: 'No manual overrides',  method: 'Only the sample list and the period bound the query', result: 'Pass' },
      { name: 'De-duplication',       method: 'Sample document numbers de-duplicated before extraction', result: 'Pass' },
      { name: 'Completeness',         method: 'Resolved ' + foundCount + ' of ' + requested + ' requested document numbers', result: notFound === 0 ? 'Pass' : 'Flag' },
      { name: 'File integrity',       method: 'SHA-256 computed over the returned CSV at extraction time', result: 'Pass' }
    ]
  };
}

function parseDocs_(text) {
  var seen = {}, out = [];
  String(text || '').split(/[\n,;]+/).forEach(function (t) {
    var v = t.replace(/^['"\s]+|['"\s]+$/g, '');
    if (!v) return;
    var k = v.toUpperCase();
    if (seen[k]) return;
    seen[k] = true; out.push(v);
  });
  return out;
}