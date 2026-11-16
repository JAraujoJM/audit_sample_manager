/**
 * Flow D — COGS (cost of goods sold) by NAV value entry.
 * ------------------------------------------------------
 * Sample = NAV `Value Entry` numbers, one per line with the company code (EC_MA 14356476).
 * Each sampled entry is the cost of an item sold (or returned), or a later ADJUSTMENT of
 * that cost. The support the auditors want is the purchase document behind it: the vendor's
 * invoice for the goods and, for an adjustment, the vendor credit / debit note that caused it.
 *
 * ONE QUERY, on live NAV. The gateway (server `finrec`) reaches NAV BC through linked
 * servers, so the query is `select * from openquery([ERP_NAVBCnn], '<inner query>')`, one
 * block per company joined by `union all`. The inner query:
 *   - `chain` (recursive CTE) walks from the sampled entry to the item entry it took its
 *     cost from (`Item Application Entry`), and on, when that entry is not a purchase:
 *       member 1 — the origin NAV RECORDED (a customer return, an undone shipment or a
 *                  transfer points at the outbound entry it reverses, which points at the
 *                  inbound entry it was applied to);
 *       member 2 — a customer return receipt `R<order>-<nnnn>` with no recorded origin is
 *                  matched to the original sale on ORDER NUMBER + ITEM (`Guessed = 1`).
 *     Stops after FLOWD_MAX_HOPS hops (seen: 5, a unit sold and returned four times).
 *   - then one row per (sample, chain node, purchase value entry on that node): the
 *     receipt (type 5), the invoices (6) and the credit memos (8), with the vendor's own
 *     document number (`External Document No_`) and the item-charge code of a note.
 * Validated on the 94 samples of H1 + Q3 2026 (16 Nov 2026): 94 returned, amount = the
 * auditors' amount on 94, a goods invoice found for 85 (the query used by hand: 65).
 *
 * QUERY RULES
 *  - openquery takes ONE string of at most 8,000 characters: a company whose sample list
 *    does not fit is split into several blocks (flowDQuery_). Single quotes are doubled.
 *  - The sample is external input: entry numbers are checked to be digits only and company
 *    codes are looked up in FLOWD_COMPANIES — nothing pasted reaches the SQL as text.
 *  - No date window: an entry number is unique within its company. The period chosen on
 *    the request is a label (the IPE says so — see ipeChecks).
 *
 * WHAT THE APP DECIDES FROM THE ROWS (flowDMapGroup_)
 *  - the purchase receipt(s) behind the sample: those reached without a guess when there
 *    are any, else the guessed ones. A manual credit memo for several units fans out into
 *    several candidate receipts — all are kept, the app cannot tell which unit it was;
 *  - tasks: one "Purchase invoice" per goods invoice on those receipts — at least one per
 *    sample, flagged `pending` when NAV shows none (receipt not invoiced yet, or no receipt
 *    found), which lets the preparer submit a comment with no file;
 *    and, for an ADJUSTMENT sample, one "Credit / debit note" per note that explains the
 *    sampled amount (amount = quantity × the note's per-unit amount, or of the notes
 *    posted on one date). The team's own practice in H1 2026: only the explaining notes
 *    were delivered, not every note on the receipt. The others are listed on the card.
 */
var FLOWD_INVOICE      = 'Purchase invoice';        // Routing.required_evidence / Assignments.evidence_type
var FLOWD_INVOICE_RULE = 'cogs_purchase_invoice';   // Routing.rule_name
var FLOWD_NOTE         = 'Credit / debit note';
var FLOWD_NOTE_RULE    = 'cogs_credit_debit_note';
var FLOWD_SUB_ORIGINAL   = 'COGS - Original cost';  // Sample_Lines.subpopulation (both reviewed per task — Config.js)
var FLOWD_SUB_ADJUSTMENT = 'COGS - Adjustment';
var FLOWD_TOLERANCE = 0.015;        // currency units — sampled amount vs quantity × per-unit amount of a document
var FLOWD_MAX_HOPS  = 8;
var FLOWD_OPENQUERY_MAX = 7800;     // openquery's string limit is 8,000 — length counted with the quotes doubled

// Company code → NAV linked server, database and NAV company name (the table prefix).
// A new country = one line here.
var FLOWD_COMPANIES = {
  EC_IC: { server: 'ERP_NAVBC01', db: 'D365BC14_CI', company: 'JUMIA IVORY COAST' },
  EC_KE: { server: 'ERP_NAVBC01', db: 'D365BC14_KE', company: 'JUMIA KENYA' },
  EC_MA: { server: 'ERP_NAVBC01', db: 'D365BC14_MA', company: 'JUMIA MOROCCO' },
  EC_NG: { server: 'ERP_NAVBC02', db: 'D365BC14_NG', company: 'JUMIA NIGERIA' },
  HF_SN: { server: 'ERP_NAVBC01', db: 'D365BC14_SN', company: 'Hellofood SN' },
  JD_GH: { server: 'ERP_NAVBC01', db: 'D365BC14_GH', company: 'Jade GH' },
  JD_UG: { server: 'ERP_NAVBC02', db: 'D365BC14_UG', company: 'Jade UG' },
  JM_EG: { server: 'ERP_NAVBC02', db: 'D365BC14_EG', company: 'JUMIA EGYPT' }
};

// NAV option values. Value Entry / Item Ledger Entry "Document Type":
var FLOWD_DOC_TYPES = { '1': 'Sales shipment', '2': 'Sales invoice', '3': 'Sales return receipt', '4': 'Sales credit memo',
                        '5': 'Purchase receipt', '6': 'Purchase invoice', '7': 'Purchase return shipment', '8': 'Purchase credit memo',
                        '9': 'Transfer shipment', '10': 'Transfer receipt' };
// Item Ledger Entry "Entry Type":
var FLOWD_ILE_TYPES = { '0': 'Purchase', '1': 'Sale', '2': 'Positive adjustment', '3': 'Negative adjustment', '4': 'Transfer',
                        '5': 'Consumption', '6': 'Output' };

function flowD_() {
  return {
    id: 'flowD',
    sampleKey: 'SampleKey',      // the query emits <company code><entry no.> as this column

    parseSample: function (text) { return flowDParseSample_(text); },
    buildQuery:  function (items, p) { return flowDQuery_(items, p); },
    mapRow:      function (cell) { return flowDMapGroup_([cell]); },
    mapGroup:    function (rows, cellForFactory) { return flowDMapGroup_(rows.map(cellForFactory)); },

    /** The IPE's standard checks assume a date window; this flow has none — say what bounds it. */
    ipeChecks: function (checks) {
      return (checks || []).map(function (c) {
        if (c.name === 'Period integrity') {
          return { name: c.name, result: 'Pass',
                   method: 'No date window: each sample is one NAV value entry number, unique within its company. The period on the request is a label; the posting date NAV returned is shown per sample' };
        }
        if (c.name === 'Source authenticity') {
          return { name: c.name, result: c.result,
                   method: 'Read-only SELECT executed via the FinRec SQL gateway against live NAV (linked servers ERP_NAVBC01 / ERP_NAVBC02, openquery) — no client DB access' };
        }
        if (c.name === 'No manual overrides') {
          return { name: c.name, result: c.result, method: 'Only the sample list (company + value entry number) bounds the query' };
        }
        if (c.name === 'De-duplication') {
          return { name: c.name, result: c.result, method: 'Sample entries de-duplicated on company + value entry number before extraction' };
        }
        if (c.name === 'Completeness') {
          return { name: c.name, result: c.result, method: c.method.replace('document numbers', 'value entries') };
        }
        return c;
      });
    },

    /** Extra columns of the auditor export's "Samples & Tasks" tab (one row per task). */
    exportHeaders: ['Posting date', 'Sales document', 'Entry type', 'Cost type', 'Item', 'Vendor', 'Purchase receipt', 'Purchase order',
                    'How the receipt was reached', 'Purchase document (NAV)', 'Vendor document no.', 'Document date', 'Document status'],
    exportValues: function (line, det, asg, unit) {
      det = det || {}; unit = unit || {};
      return [det.entry_date || '', det.sales_doc || '', det.entry_type || '', det.cost_type || '',
              [det.item_no, det.item_desc].filter(Boolean).join(' · '), unit.vendor || line.vendor || '',
              unit.receipt_no || det.receipt_no || '', unit.po || det.purchase_order || '', det.trace || '',
              unit.doc_no || '', unit.vendor_doc_no || '', unit.doc_date || '',
              unit.pending ? flowDPendingText_(unit.pending) : (unit.doc_no ? 'Posted in NAV' : '')];
    }
  };
}

function isCogsSub_(sub) { sub = String(sub || ''); return sub === FLOWD_SUB_ORIGINAL || sub === FLOWD_SUB_ADJUSTMENT; }

function flowDPendingText_(code) {
  return code === 'no_receipt' ? 'No purchase receipt found behind this entry'
                               : 'Receipt not invoiced in NAV at extraction — invoice pending';
}

/* ---------- sample ---------- */
/**
 * Two columns per line — company code and value entry number, in either order, separated by
 * a tab, comma, semicolon or spaces. Lines without both (a header row) are skipped. Returns
 * de-duplicated { key, company, ref } with key = <COMPANY><entry no.>.
 */
function flowDParseSample_(text) {
  var seen = {}, out = [];
  String(text || '').split(/[\r\n]+/).forEach(function (line) {
    var cells = (line.indexOf('\t') !== -1 ? line.split('\t') : line.split(/[;,\s]+/))
      .map(function (s) { return s.replace(/^['"\s ]+|['"\s ]+$/g, ''); }).filter(Boolean);
    var company = '', entry = '';
    cells.forEach(function (c) {
      if (!company && /^[A-Za-z]{2}_[A-Za-z]{2}$/.test(c)) { company = c.toUpperCase(); return; }
      // An entry number copied out of Excel can arrive as 14,356,476 or 14356476.0.
      var n = c.replace(/\.0+$/, '').replace(/[,\s ]/g, '');
      if (!entry && /^\d{1,12}$/.test(n)) entry = String(Number(n));
    });
    if (!company || !entry) return;
    var key = company + entry;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ key: key, company: company, ref: entry });
  });
  return out;
}

/* ---------- query ---------- */
var FLOWD_INNER_SQL = [
  'with chain as (',
  'select VE1.[Entry No_] Value_Entry_No, cast(0 as int) Hop, cast(0 as int) Guessed, IAE.[Inbound Item Entry No_] In_Entry',
  'from {t}Value Entry] VE1',
  'left join {t}Item Application Entry] IAE on IAE.[Item Ledger Entry No_] = VE1.[Item Ledger Entry No_]',
  'where VE1.[Entry No_] in ({ids})',
  'union all',
  'select c.Value_Entry_No, c.Hop + 1, c.Guessed, n.[Inbound Item Entry No_]',
  'from chain c',
  'join {t}Item Application Entry] o on o.[Item Ledger Entry No_] = c.In_Entry and o.[Inbound Item Entry No_] = c.In_Entry and o.[Outbound Item Entry No_] <> 0',
  'join {t}Item Application Entry] n on n.[Item Ledger Entry No_] = o.[Outbound Item Entry No_] and n.[Outbound Item Entry No_] = o.[Outbound Item Entry No_]',
  'where c.Hop < {hops}',
  'union all',
  'select c.Value_Entry_No, c.Hop + 1, cast(1 as int), n.[Inbound Item Entry No_]',
  'from chain c',
  'join {t}Item Ledger Entry] R on R.[Entry No_] = c.In_Entry and R.[Document Type] = 3',
  'join {t}Item Ledger Entry] G on G.[Item No_] = R.[Item No_] and G.[Entry Type] = 1 and G.[Quantity] < 0 and G.[Posting Date] <= R.[Posting Date]',
  " and G.[Document No_] like case when R.[Document No_] like 'R%-%' then substring(R.[Document No_], 2, charindex('-', R.[Document No_]) - 1) + '%' end",
  'join {t}Item Application Entry] n on n.[Item Ledger Entry No_] = G.[Entry No_]',
  'where c.Hop < {hops}',
  ')',
  "select '{co}' + cast(c.Value_Entry_No as varchar(20)) SampleKey, '{co}' id_company, c.Value_Entry_No",
  ', S.[Posting Date] S_Posting_Date, S.[Document Type] S_Document_Type, S.[Document No_] S_Document_No, S.[Adjustment] S_Adjustment, S.[Cost Amount (Actual)] S_Cost_Actual, S.[Valued Quantity] S_Valued_Qty',
  ', SI.[Entry No_] ILE_No, SI.[Item No_] Item_No, IT.[Description] Item_Description, SH.[OMS Order No_] OMS_Sales_Order',
  ', c.Hop, c.Guessed, c.In_Entry, E.[Entry Type] In_ILE_Type, E.[Document Type] In_Document_Type, E.[Document No_] In_Document_No, E.[Posting Date] In_Posting_Date, E.[Quantity] In_Qty',
  ', PRH.[OMS Order No_] OMS_Purchase_Order',
  ', X.[Entry No_] X_Value_Entry_No, X.[Document Type] X_Document_Type, X.[Document No_] X_Document_No, X.[External Document No_] X_External_Document_No, X.[Item Charge No_] X_Item_Charge',
  ', X.[Posting Date] X_Posting_Date, X.[Source No_] X_Vendor_No, V.[Name] X_Vendor_Name',
  ', X.[Cost Amount (Actual)] X_Cost_Actual, X.[Cost Amount (Expected)] X_Cost_Expected, X.[Valued Quantity] X_Valued_Qty, X.[Invoiced Quantity] X_Invoiced_Qty',
  'from chain c',
  'join {t}Value Entry] S on S.[Entry No_] = c.Value_Entry_No',
  'left join {t}Item Ledger Entry] SI on SI.[Entry No_] = S.[Item Ledger Entry No_]',
  'left join {t}Item] IT on IT.[No_] = SI.[Item No_]',
  'left join {t}Sales Shipment Header] SH on SH.[No_] = SI.[Document No_]',
  'left join {t}Item Ledger Entry] E on E.[Entry No_] = c.In_Entry',
  'left join {t}Purch_ Rcpt_ Header] PRH on PRH.[No_] = E.[Document No_] and E.[Entry Type] = 0',
  'left join {t}Value Entry] X on X.[Item Ledger Entry No_] = c.In_Entry and E.[Entry Type] = 0 and X.[Document Type] in (5,6,8)',
  'left join {t}Vendor] V on V.[No_] = X.[Source No_]'
].join(' ');

/** The inner (NAV-side) query of one company for a list of entry numbers. */
function flowDInnerQuery_(code, ids) {
  var c = FLOWD_COMPANIES[code];
  var t = '[' + c.db + '].[dbo].[' + c.company + '$';
  return FLOWD_INNER_SQL.split('{t}').join(t).split('{co}').join(code)
    .split('{hops}').join(String(FLOWD_MAX_HOPS)).split('{ids}').join(ids.join(','));
}

function flowDQuery_(items, p) {
  var byCo = {}, order = [];
  (items || []).forEach(function (it) {
    var code = String(it.company || '').toUpperCase(), ref = String(it.ref || '');
    if (!FLOWD_COMPANIES[code]) {
      throw new Error('Unknown company code "' + it.company + '" in the sample — known: ' + Object.keys(FLOWD_COMPANIES).join(', ') + '.');
    }
    if (!/^\d{1,12}$/.test(ref)) throw new Error('Value entry number "' + ref + '" is not a number.');
    if (!byCo[code]) { byCo[code] = []; order.push(code); }
    if (byCo[code].indexOf(ref) === -1) byCo[code].push(ref);
  });
  if (!order.length) throw new Error('No sample entries to query.');

  var blocks = [];
  order.forEach(function (code) {
    var srv = FLOWD_COMPANIES[code].server;
    var room = FLOWD_OPENQUERY_MAX - flowDInnerQuery_(code, []).replace(/'/g, "''").length;
    var chunk = [], used = 0;
    var flush = function () {
      if (!chunk.length) return;
      blocks.push("select * from openquery([" + srv + "],'" + flowDInnerQuery_(code, chunk).replace(/'/g, "''") + "')");
      chunk = []; used = 0;
    };
    byCo[code].forEach(function (id) {
      if (chunk.length && used + id.length + 1 > room) flush();
      chunk.push(id); used += id.length + 1;
    });
    flush();
  });
  return blocks.join('\nunion all\n');
}

/* ---------- reading the rows ---------- */
function flowDNum_(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 0;
  var n = Number(String(v).replace(/\s/g, ''));
  return isNaN(n) ? 0 : n;
}
function flowDBlank_(v) { var s = String(v == null ? '' : v).trim(); return s === '' || s.toUpperCase() === 'NULL'; }
function flowDRound_(n, d) { var f = Math.pow(10, d === undefined ? 2 : d); return Math.round(n * f) / f; }
/** yyyy-mm-dd from whatever the gateway CSV carries; NAV's empty date (1753-01-01) reads as ''. */
function flowDDate_(v) {
  var m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v));
  if (!m || m[1] === '1753') return '';
  return m[1] + '-' + m[2] + '-' + m[3];
}
/**
 * A whole number / code as text. The gateway writes a column that holds a NULL anywhere (every
 * left-joined one) as floats — document type 6 arrives as "6.0", an entry number as
 * "70445007.0" — so codes and ids are read through this, never compared raw.
 */
function flowDCode_(v) {
  var s = String(v == null ? '' : v).trim();
  if (s.toUpperCase() === 'NULL') return '';
  return /^-?\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s;
}
function flowDFlag_(v) { var s = flowDCode_(v).toLowerCase(); return s === '1' || s === 'true'; }
function flowDFmt_(n) { return String(flowDRound_(n, 2)); }

/**
 * Fold every row of ONE sampled entry into the sample's fields, its routing facts and the
 * units its tasks fan over (`taskUnits`, by Routing rule). `cells` = one cell reader per row.
 */
function flowDMapGroup_(cells) {
  var c0 = cells[0];
  var amount = c0('S_Cost_Actual'), qty = flowDNum_(c0('S_Valued_Qty'));
  var adjustment = flowDFlag_(c0('S_Adjustment'));
  var sDate = flowDDate_(c0('S_Posting_Date'));
  var sType = flowDCode_(c0('S_Document_Type'));

  // Chain nodes: (hop, guessed, inbound entry) → the purchase value entries on that entry.
  var nodes = [], nodeBy = {};
  cells.forEach(function (c) {
    if (flowDBlank_(c('In_Entry'))) return;                    // an entry with nothing applied to it
    var k = [flowDCode_(c('Hop')), flowDCode_(c('Guessed')), flowDCode_(c('In_Entry'))].join('|');
    var n = nodeBy[k];
    if (!n) {
      n = nodeBy[k] = { hop: flowDNum_(c('Hop')), guessed: flowDFlag_(c('Guessed')), entry: flowDCode_(c('In_Entry')),
                        ileType: flowDCode_(c('In_ILE_Type')), docType: flowDCode_(c('In_Document_Type')),
                        docNo: flowDCode_(c('In_Document_No')), date: flowDDate_(c('In_Posting_Date')),
                        qty: flowDNum_(c('In_Qty')), po: flowDBlank_(c('OMS_Purchase_Order')) ? '' : String(c('OMS_Purchase_Order')).trim(), rows: [] };
      nodes.push(n);
    }
    n.rows.push(c);
  });

  // The purchase receipts behind the sample: recorded links win over guessed ones.
  var purch = nodes.filter(function (n) { return n.ileType === '0'; });
  var recorded = purch.filter(function (n) { return !n.guessed; });
  var use = recorded.length ? recorded : purch;
  var how = !use.length ? 'unresolved'
    : use.some(function (n) { return n.hop === 0; }) ? 'direct'
    : recorded.length ? 'recorded' : 'order_match';
  var receipts = [], seenRcpt = {};
  use.forEach(function (n) { if (!seenRcpt[n.entry]) { seenRcpt[n.entry] = true; receipts.push(n); } });
  // The gateway returns rows in no particular order: fix one, so a re-run gives the same tasks.
  receipts.sort(function (a, b) { return (a.hop - b.hop) || (a.docNo < b.docNo ? -1 : a.docNo > b.docNo ? 1 : 0); });
  var maxHop = 0; use.forEach(function (n) { if (n.hop > maxHop) maxHop = n.hop; });

  // Purchase documents on those receipts: goods invoices, item-charge notes, credit memos.
  var docs = [], docBy = {}, vendor = '', vendorNo = '';
  receipts.forEach(function (rc) {
    var seenVe = {};
    rc.rows.forEach(function (c) {
      if (flowDBlank_(c('X_Document_No'))) return;
      var ve = flowDCode_(c('X_Value_Entry_No'));
      if (ve && seenVe[ve]) return;
      seenVe[ve] = true;
      var xType = flowDCode_(c('X_Document_Type'));
      var vName = flowDBlank_(c('X_Vendor_Name')) ? '' : String(c('X_Vendor_Name')).trim();
      if (xType === '5') { if (!rc.vendor) { rc.vendor = vName; rc.vendorNo = flowDCode_(c('X_Vendor_No')); } return; }
      var charge = flowDBlank_(c('X_Item_Charge')) ? '' : String(c('X_Item_Charge')).trim();
      var kind = charge ? 'charge' : (xType === '6' ? 'invoice' : 'credit_memo');
      var no = String(c('X_Document_No')).trim(), k = rc.entry + '|' + kind + '|' + no;
      var d = docBy[k];
      if (!d) {
        d = docBy[k] = { kind: kind, no: no, type: FLOWD_DOC_TYPES[xType] || ('Document type ' + xType), ext: '', charge: charge,
                         date: '', vendor: vName, vendorNo: flowDCode_(c('X_Vendor_No')), actual: 0, expected: 0, vq: 0, receipt: rc };
        docs.push(d);
      }
      // One document can have several value entries on the receipt (the invoice line, then
      // rounding entries posted months later with no vendor number): the vendor's number is the
      // first one filled in, the document date the earliest posting date.
      var ext = flowDBlank_(c('X_External_Document_No')) ? '' : flowDCode_(c('X_External_Document_No'));
      var xd = flowDDate_(c('X_Posting_Date')), xq = flowDNum_(c('X_Valued_Qty'));
      if (!d.ext && ext) d.ext = ext;
      if (xd && (!d.date || xd < d.date)) d.date = xd;
      if (!d.vendor && vName) d.vendor = vName;
      if (Math.abs(xq) > Math.abs(d.vq)) d.vq = xq;
      d.actual += flowDNum_(c('X_Cost_Actual'));
      d.expected += flowDNum_(c('X_Cost_Expected'));
    });
    if (!vendor && rc.vendor) { vendor = rc.vendor; vendorNo = rc.vendorNo; }
  });
  docs.forEach(function (d) {
    d.perUnit = d.vq ? (d.actual + d.expected) / d.vq : 0;     // what the document changed on the cost of ONE unit of the receipt
    if (!vendor && d.vendor) { vendor = d.vendor; vendorNo = d.vendorNo; }
  });
  var rank = {}; receipts.forEach(function (rc, i) { rank[rc.entry] = i; });
  docs.sort(function (a, b) {
    return (rank[a.receipt.entry] - rank[b.receipt.entry]) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.no < b.no ? -1 : a.no > b.no ? 1 : 0);
  });
  var invoices = docs.filter(function (d) { return d.kind === 'invoice'; });
  var notes = docs.filter(function (d) { return d.kind !== 'invoice'; });

  // ADJUSTMENT sample: which document(s) explain the amount? Only when ONE receipt is behind it.
  var explain = [];
  if (adjustment && receipts.length === 1 && docs.length) explain = flowDExplain_(flowDNum_(amount), qty, docs, sDate);
  var explainNotes = explain.filter(function (d) { return d.kind !== 'invoice'; });

  // ----- task units -----
  var unitOf = function (d) {
    return { doc_no: d.no, vendor_doc_no: d.ext, doc_type: d.type, item_charge: d.charge, doc_date: d.date,
             vendor: d.vendor || d.receipt.vendor || vendor, doc_amount: flowDFmt_(d.actual), unit_amount: d.kind === 'invoice' ? '' : flowDFmt_(d.perUnit),
             receipt_no: d.receipt.docNo, po: d.receipt.po };
  };
  // One task per DOCUMENT: an invoice (or note) that sits on several candidate receipts is one PDF.
  var unitsOfDocs = function (list) {
    var by = {}, out = [];
    list.forEach(function (d) {
      var u = by[d.no];
      if (!u) { u = by[d.no] = unitOf(d); out.push(u); return; }
      if (d.receipt.docNo && u.receipt_no.split(', ').indexOf(d.receipt.docNo) === -1) u.receipt_no += ', ' + d.receipt.docNo;
      if (d.receipt.po && String(u.po || '').split(', ').indexOf(d.receipt.po) === -1) u.po = [u.po, d.receipt.po].filter(Boolean).join(', ');
    });
    return out;
  };
  var invoiceUnits = unitsOfDocs(invoices);
  if (!invoiceUnits.length) {
    if (receipts.length) {
      receipts.forEach(function (rc) {
        invoiceUnits.push({ pending: 'not_invoiced', vendor: rc.vendor || vendor, receipt_no: rc.docNo, po: rc.po, receipt_date: rc.date });
      });
    } else {
      invoiceUnits.push({ pending: 'no_receipt' });
    }
  }
  var noteUnits = unitsOfDocs(explainNotes);
  var taskUnits = {}; taskUnits[FLOWD_INVOICE_RULE] = invoiceUnits;
  if (noteUnits.length) taskUnits[FLOWD_NOTE_RULE] = noteUnits;

  // ----- what the card says -----
  var last = nodes.length ? nodes[nodes.length - 1] : null;
  var trace = how === 'direct' ? 'Direct: the entry took its cost from the purchase receipt'
    : how === 'recorded' ? 'Through ' + maxHop + ' link' + (maxHop > 1 ? 's' : '') + ' recorded in NAV (return, undone shipment or transfer) back to the purchase receipt'
    : how === 'order_match' ? 'Customer return with no origin recorded in NAV: matched to the original sale on order number and item, then to its purchase receipt'
    : last ? 'No purchase receipt found: the chain ends on ' + (FLOWD_ILE_TYPES[last.ileType] || 'entry type ' + last.ileType).toLowerCase() + ' ' + (last.docNo || last.entry)
    : 'No purchase receipt found: nothing is applied to this entry in NAV';
  if (receipts.length > 1) trace += ' (' + receipts.length + ' candidate receipts — the quantity came from several)';

  var describe = function (d) {
    return d.no + (d.charge ? ' · ' + d.charge : '') + (d.ext ? ' · vendor no. ' + d.ext : '') + (d.date ? ' · ' + d.date : '') +
           ' · ' + flowDFmt_(d.perUnit) + ' per unit';
  };
  var taskNotes = {}; explainNotes.forEach(function (d) { taskNotes[d.receipt.entry + '|' + d.no] = true; });
  var others = notes.filter(function (d) { return !taskNotes[d.receipt.entry + '|' + d.no]; });
  var invoiceStatus = invoices.length ? (invoiceUnits.length + ' invoice' + (invoiceUnits.length > 1 ? 's' : '') + ' posted in NAV')
    : receipts.length ? 'Not invoiced in NAV at extraction' : 'No purchase receipt found';
  var explained = '';
  if (adjustment) {
    explained = explain.length ? 'Explained by ' + explain.map(describe).join('; ')
      : receipts.length > 1 ? 'Not tested: several candidate receipts'
      : 'Not explained by one purchase document' + (notes.length ? ' — see the notes on the receipt' : '');
  }
  var uniq = function (a) { var s = {}, o = []; a.forEach(function (x) { if (x && !s[x]) { s[x] = true; o.push(x); } }); return o; };

  return {
    document_no:   flowDCode_(c0('Value_Entry_No')),
    company:       String(c0('id_company') || '').trim(),
    vendor:        vendor,
    amount:        amount,
    subpopulation: adjustment ? FLOWD_SUB_ADJUSTMENT : FLOWD_SUB_ORIGINAL,
    entry_date:    sDate,
    sales_doc:     String(c0('S_Document_No') || '').trim(),
    entry_type:    FLOWD_DOC_TYPES[sType] || (sType && sType !== '0' ? 'Document type ' + sType : 'No document type'),
    cost_type:     adjustment ? 'Adjustment' : 'Original cost',
    quantity:      flowDBlank_(c0('S_Valued_Qty')) ? '' : String(qty),
    item_no:       flowDBlank_(c0('Item_No')) ? '' : String(c0('Item_No')).trim(),
    item_desc:     flowDBlank_(c0('Item_Description')) ? '' : String(c0('Item_Description')).trim(),
    sales_order:   flowDCode_(c0('OMS_Sales_Order')),
    vendor_no:     vendorNo,
    receipt_no:    uniq(receipts.map(function (r) { return r.docNo; })).join(', '),
    receipt_date:  uniq(receipts.map(function (r) { return r.date; })).join(', '),
    purchase_order: uniq(receipts.map(function (r) { return r.po; })).join(', '),   // not `po`: the engine treats that key as a standard line field and keeps it out of detail_json
    trace:         trace,
    resolution:    how,
    invoice_status: invoiceStatus,
    explained:     explained,
    other_notes:   others.slice(0, 12).map(describe).join('; ') + (others.length > 12 ? '; … ' + (others.length - 12) + ' more' : ''),
    taskUnits:     taskUnits,
    facts: {
      cogs: 'yes',
      cost: adjustment ? 'adjustment' : 'original',
      invoice: invoices.length ? 'found' : (receipts.length ? 'pending' : 'no_receipt'),
      notes: noteUnits.length ? 'yes' : 'no'
    }
  };
}

/**
 * The purchase document(s) that explain an adjustment: sampled amount = sampled quantity ×
 * the document's per-unit amount. One document first (when several fit, the one posted on
 * the sampled entry's own date); else the documents posted on ONE date taken together (a
 * vendor's notes of one day are adjusted in one go). [] when nothing fits.
 */
function flowDExplain_(amount, qty, docs, sDate) {
  // Within the tolerance AND within a quarter of the amount itself: a 0.01 rounding entry must
  // match to the cent, or any document with a near-zero per-unit amount would "explain" it.
  var fits = function (perUnit) {
    var diff = Math.abs(qty * perUnit - amount);
    return diff <= FLOWD_TOLERANCE && diff <= Math.max(0.0051, Math.abs(amount) * 0.25);
  };
  var cand = docs.filter(function (d) { return d.vq && Math.abs(d.perUnit) > 0; });
  var single = cand.filter(function (d) { return fits(d.perUnit); });
  if (single.length) {
    var sameDay = single.filter(function (d) { return d.date === sDate; });
    return sameDay.length ? [sameDay[0]] : [single[0]];
  }
  var byDate = {}, dates = [];
  cand.forEach(function (d) { if (!byDate[d.date]) { byDate[d.date] = []; dates.push(d.date); } byDate[d.date].push(d); });
  var groups = dates.map(function (dt) { return byDate[dt]; }).filter(function (g) {
    return g.length > 1 && fits(g.reduce(function (s, d) { return s + d.perUnit; }, 0));
  });
  if (!groups.length) return [];
  var own = groups.filter(function (g) { return g[0].date === sDate; });
  return own.length ? own[0] : groups[0];
}
