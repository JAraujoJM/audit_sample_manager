/**
 * Flow C — Marketplace revenues / COGS, sampled by SALES-ORDER ITEM.
 * ------------------------------------------------------------------
 * Same audit objective as Flow A, but the auditor hands us ID_COMPANY +
 * COD_OMS_SALES_ORDER_ITEM (like Cash Anchor) instead of RING transaction numbers,
 * and most of the work is a RECONCILIATION the app can do itself:
 *
 *   stage 1  RPT_SOI  → unit price (MTR_UNIT_PRICE) + IS_MARKETPLACE splits the
 *                        population into Retail vs Marketplace.
 *   Retail   → NAV Posted Sales Invoices + Lines (AIG_Nav_DW), keyed on the package
 *              number. Two checks: sampled line (Line No_ = COD_BOB_SALES_ORDER_ITEM)
 *              amount incl. VAT = unit price; invoice header = sum of its lines.
 *              Fully resolved by the data — no preparer work.
 *   MPL      → RING: the statement(s) that carry the item (all their transactions)
 *              + NAV G/L (account 18314, document 'IS'+statement). Three checks:
 *              Item Price Credit = unit price; statement transactions = closing
 *              balance; NAV revenue = statement REVENUES. Then Flow A's task rules:
 *              advance sellers → contract + down-payment; regular → proof of payment
 *              (or VC screenshot when unpaid).
 *
 * The reconciliation becomes a SYSTEM task on each sample: the app builds one
 * workbook per request (summaries + raw extracts), attaches it as evidence, assigns
 * the task to the request's reviewer and auto-submits it — the reviewer only checks
 * the numbers. Human tasks (MPL only) follow the normal preparer path.
 *
 * ENGINE HOOKS USED (all optional, additive — see Code.js):
 *   parseSample, buildQuery/mapRow (stage 1), `stages` (N dependent queries run in
 *   waves: those without dependsOn start together after stage 1; the rest once their
 *   dependency has landed), `finalize` (compute checks + routing facts after every
 *   fold), `evidenceWorkbook` (sheets for the system-evidence xlsx), requiresReviewer.
 *
 * QUERY RULES (do not regress):
 *  - Every WHERE names the sampled companies (ID_Company IN (...)) AND the per-company
 *    key list: the RING/NAV indexes all lead with the company column, so this is what
 *    turns a full-year scan into a seek. Keep it.
 *  - Dates are inlined literals from the period; no DECLARE (gateway rejects it).
 *  - RING is read with a one-month margin past the period end (a statement that opens
 *    on the last days of the period closes in the next month); NAV / invoices are
 *    bounded only from below (Posting Date >= start) — a June transaction posts in July.
 *  - Build every IN (...) with sqlLiteral_ — sample values are external input.
 */
var FLOWC_TOLERANCE = 5;          // |difference| at or below this is a match (currency units)
var FLOWC_NAV_ACCOUNT = '18314';  // G/L account carrying the marketplace revenue per statement
// Retail: the receivable-side accounts of a posted sales invoice in NAV — their sum equals the
// invoice total incl. VAT (the auditor's "(Multiple Items)" filter). Adjust here if the chart changes.
var FLOWC_RETAIL_AR_ACCOUNTS = ['13003', '13005'];

function flowC_() {
  return {
    id: 'flowC',
    sampleKey: 'SampleKey',
    requiresReviewer: true,       // the reconciliation task is assigned to the request's reviewer

    parseSample: function (text) { return parseCompanySoiSample_(text); },

    buildQuery: function (items, p) { return flowCQuerySoi_(items, p); },

    /** Stage-1 row → line fields + the population fact. */
    mapRow: function (cell) {
      var flag = String(cell('IS_MARKETPLACE') || '').trim().toLowerCase();
      var isMpl = flag === '1' || flag === 'true';
      return {
        document_no:    cell('COD_OMS_SALES_ORDER_ITEM'),
        company:        cell('ID_COMPANY'),
        subpopulation:  isMpl ? 'Marketplace' : 'Retail',
        amount:         cell('MTR_UNIT_PRICE'),            // the unit price we tie out
        bob_soi:        cell('COD_BOB_SALES_ORDER_ITEM'),
        sku:            cell('COD_SKU'),
        package_number: cell('PACKAGE_NUMBER'),
        delivered_date: String(cell('DELIVERED_DATE') || '').slice(0, 10),
        po:             cell('PO_NUMBER'),
        facts: { population: isMpl ? 'marketplace' : 'retail' }
      };
    },

    /* ------------------------------------------------------------------ *
     * Dependent queries. Wave 1 (inv, invl, ringcodes) needs only stage 1;
     * wave 2 (ring, gl) needs the statement codes found by ringcodes.
     * `refs` returns [] when a stage has nothing to fetch (e.g. no retail items).
     * ------------------------------------------------------------------ */
    stages: [
      {
        tag: 'inv', label: 'NAV Posted Sales Invoices', server: 'finrec', database: 'AIG_Nav_DW',
        refs: function (mapped) { return flowCRetailPackages_(mapped); },
        buildQuery: function (refs, p) { return flowCQueryInvoices_(refs, p); },
        fold: function (csv, cell, mapped, ctx) { flowCFoldInvoices_(csv, cell, mapped, ctx); }
      },
      {
        tag: 'invl', label: 'NAV Posted Sales Invoice Lines', server: 'finrec', database: 'AIG_Nav_DW',
        refs: function (mapped) { return flowCRetailPackages_(mapped); },
        buildQuery: function (refs, p) { return flowCQueryInvoiceLines_(refs, p); },
        fold: function (csv, cell, mapped, ctx) { flowCFoldInvoiceLines_(csv, cell, mapped, ctx); }
      },
      {
        tag: 'glr', label: 'NAV G/L entries (retail invoices)', server: 'finrec', database: 'AIG_Nav_DW',
        refs: function (mapped, ctx) { ctx.data.retailDates = flowCRetailDates_(mapped); return flowCRetailPackages_(mapped); },
        buildQuery: function (refs, p, ctx) { return flowCQueryGlRetail_(refs, p, ctx); },
        fold: function (csv, cell, mapped, ctx) { flowCFoldGlRetail_(csv, cell, mapped, ctx); }
      },
      {
        tag: 'ringcodes', label: 'RING — sampled items → statements', server: 'finrec', database: 'AIG_Nav_Jumia_Reconciliation',
        refs: function (mapped) { return flowCMplItems_(mapped); },
        buildQuery: function (refs, p) { return flowCQueryRingCodes_(refs, p); },
        fold: function (csv, cell, mapped, ctx) { flowCFoldRingCodes_(csv, cell, mapped, ctx); }
      },
      {
        tag: 'ring', label: 'RING — full statements', server: 'finrec', database: 'AIG_Nav_Jumia_Reconciliation',
        dependsOn: ['ringcodes'],
        refs: function (mapped, ctx) { return (ctx.data && ctx.data.codes) || []; },
        buildQuery: function (refs, p, ctx) { return flowCQueryRing_(refs, p, ctx); },   // ctx → date window from hop 1
        fold: function (csv, cell, mapped, ctx) { flowCFoldRing_(csv, cell, mapped, ctx); }
      },
      {
        tag: 'gl', label: 'NAV G/L entries (statement revenue)', server: 'finrec', database: 'AIG_Nav_DW',
        dependsOn: ['ringcodes'],
        refs: function (mapped, ctx) { return (ctx.data && ctx.data.codes) || []; },
        buildQuery: function (refs, p, ctx) { return flowCQueryGl_(refs, p, ctx); },     // ctx → posting window from hop 1
        fold: function (csv, cell, mapped, ctx) { flowCFoldGl_(csv, cell, mapped, ctx); }
      }
    ],

    /** After every fold: compute the checks, the system-task verdict and the routing facts. */
    finalize: function (mapped, ctx) { flowCFinalize_(mapped, ctx); },

    /** Sheets of the one reconciliation workbook attached to every system task of the request. */
    evidenceWorkbook: function (mapped, ctx) { return flowCWorkbook_(mapped, ctx); }
  };
}

/* ---------- sample parser (ID_COMPANY + COD_OMS_SALES_ORDER_ITEM per line) ----------
 * Same paste format as Cash Anchor. Kept as its own helper so Flow B stays untouched. */
function parseCompanySoiSample_(text) {
  var seen = {}, out = [];
  String(text || '').split(/[\r\n]+/).forEach(function (line) {
    var parts = line.split(/[\t,;]+|\s+/).map(function (s) { return s.replace(/^['"\s]+|['"\s]+$/g, ''); }).filter(Boolean);
    if (parts.length < 2) return;
    var company = parts[0], soi = parts[1];
    if (!/^\d+$/.test(soi)) return;                 // SOI is numeric — skips a header row
    var key = (company + soi).toUpperCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push({ key: key, company: company, soi: soi });
  });
  return out;
}

/* ---------- small helpers ---------- */
function flowCNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}
function flowCRound_(n) { return Math.round(n * 100) / 100; }
function flowCUp_(s) { return String(s == null ? '' : s).trim().toUpperCase(); }
/** Distinct company list as SQL literals. */
function flowCCompanyList_(refs) {
  var seen = {};
  refs.forEach(function (r) { if (r.company) seen[flowCUp_(r.company)] = true; });
  return Object.keys(seen).map(sqlLiteral_).join(',') || "''";
}
/**
 * Per-company key predicate: ((c='EC_IC' AND col IN (…)) OR (c='JM_EG' AND col IN (…))).
 * `numeric` inlines the values unquoted (validated digits) so the seek stays numeric.
 */
function flowCTuples_(refs, companyCol, keyCol, keyField, numeric) {
  var by = {};
  refs.forEach(function (r) {
    var c = flowCUp_(r.company), k = String(r[keyField] == null ? '' : r[keyField]).trim();
    if (!c || !k) return;
    (by[c] = by[c] || {})[k] = true;
  });
  var parts = Object.keys(by).map(function (c) {
    var keys = Object.keys(by[c]).map(function (k) { return numeric ? String(parseInt(k, 10)) : sqlLiteral_(k); });
    return '(' + companyCol + ' = ' + sqlLiteral_(c) + ' AND ' + keyCol + ' IN (' + keys.join(',') + '))';
  });
  return parts.length ? '(' + parts.join(' OR ') + ')' : '(1 = 0)';
}

/* ---------- reference builders ---------- */
function flowCRetailPackages_(mapped) {
  var seen = {}, out = [];
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Retail') return;
    var m = mr.mapped, k = flowCUp_(m.company) + '|' + flowCUp_(m.package_number);
    if (!m.package_number || seen[k]) return;
    seen[k] = true; out.push({ company: m.company, package: m.package_number });
  });
  return out;
}
/** Delivered-date span of the retail items — bounds the retail G/L posting window. */
function flowCRetailDates_(mapped) {
  var min = '', max = '';
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Retail') return;
    var d = String(mr.mapped.delivered_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (!min || d < min) min = d; if (!max || d > max) max = d;
  });
  return min ? { min: min, max: max } : null;
}
function flowCMplItems_(mapped) {
  var out = [];
  mapped.forEach(function (mr) {
    if (mr.found && mr.mapped.subpopulation === 'Marketplace') out.push({ company: mr.mapped.company, soi: mr.mapped.document_no });
  });
  return out;
}

/* ================================ STAGE 1 ================================ *
 * RPT_SOI (the base table — the V_RPT_SOI view does not expose IS_MARKETPLACE).
 * Delivered-date window = the request period. */
function flowCQuerySoi_(items, p) {
  var DB = p.database, S = "'" + p.fyStart + "'", E = "'" + p.fyEnd + "'";
  var refs = items.map(function (i) { return { company: i.company, soi: i.soi }; });
  return [
"SELECT soi.[ID_COMPANY]",
"      ,CONCAT(soi.[ID_COMPANY], soi.[COD_OMS_SALES_ORDER_ITEM]) AS 'SampleKey'",
"      ,soi.[COD_OMS_SALES_ORDER_ITEM]",
"      ,soi.[COD_BOB_SALES_ORDER_ITEM]",
"      ,soi.[COD_SKU]",
"      ,soi.[PACKAGE_NUMBER]",
"      ,soi.[IS_MARKETPLACE]",
"      ,soi.[MTR_UNIT_PRICE]",
"      ,CONVERT(date, soi.[DELIVERED_DATE]) AS 'DELIVERED_DATE'",
"      ,soi.[PO_NUMBER]",
"  FROM [" + DB + "].[dbo].[RPT_SOI] soi",
" WHERE soi.[ID_COMPANY] IN (" + flowCCompanyList_(refs) + ")",
"   AND " + flowCTuples_(refs, 'soi.[ID_COMPANY]', 'soi.[COD_OMS_SALES_ORDER_ITEM]', 'soi', true),
"   AND soi.[DELIVERED_DATE] >= " + S,
"   AND soi.[DELIVERED_DATE] <  " + E
  ].join('\n');
}

/* ============================ RETAIL — NAV invoices ============================ */
function flowCQueryInvoices_(refs, p) {
  var S = "'" + p.fyStart + "'";
  return [
"SELECT i.[id_company]",
"      ,i.[No_]",
"      ,i.[Customer No_]",
"      ,i.[Customer Name]",
"      ,i.[Amount excl_ VAT]",
"      ,i.[Amount incl_ VAT]",
"      ,i.[Currency]",
"      ,CONVERT(date, i.[Posting Date]) AS 'Posting Date'",
"      ,CONVERT(date, i.[Document Date]) AS 'Document Date'",
"      ,i.[Posted by]",
"  FROM [AIG_Nav_DW].[dbo].[Posted Sales Invoices] i",
" WHERE i.[id_company] IN (" + flowCCompanyList_(refs) + ")",
"   AND i.[Posting Date] >= " + S,
"   AND " + flowCTuples_(refs, 'i.[id_company]', 'i.[No_]', 'package', false)
  ].join('\n');
}
function flowCQueryInvoiceLines_(refs, p) {
  var S = "'" + p.fyStart + "'";
  return [
"SELECT l.[id_company]",
"      ,l.[Document No_]",
"      ,l.[Line No_]",
"      ,l.[Type]",
"      ,l.[No_]",
"      ,l.[Description]",
"      ,l.[Quantity]",
"      ,l.[Amount]",
"      ,l.[Amount Including VAT]",
"      ,l.[VAT Base Amount]",
"      ,l.[VAT Prod_ Posting Group]",
"      ,l.[OMS Order No_]",
"      ,l.[Order Line No_]",
"      ,CONVERT(date, l.[Posting Date]) AS 'Posting Date'",
"  FROM [AIG_Nav_DW].[dbo].[Posted Sales Invoice Line] l",
" WHERE l.[id_company] IN (" + flowCCompanyList_(refs) + ")",
"   AND l.[Posting Date] >= " + S,
"   AND l.[Quantity] <> 0",                       // zero-quantity lines carry no amount — noise for the reconciliation
"   AND " + flowCTuples_(refs, 'l.[id_company]', 'l.[Document No_]', 'package', false)
  ].join('\n');
}
/** Retail G/L: every entry of each posted sales invoice (source SALES, document = package number),
 *  all accounts — the document must net to zero, and the receivable accounts must equal the
 *  invoice total incl. VAT. Posting window = the items' delivered dates −1 / +3 months. */
function flowCQueryGlRetail_(refs, p, ctx) {
  var W = flowCWindow_(p, ctx, 1, 3, 'retailDates');
  return [
"SELECT g.[id_company]",
"      ,g.[Entry No_]",
"      ,g.[Document No_]",
"      ,CONVERT(date, g.[Posting Date]) AS 'Posting Date'",
"      ,g.[Document Type]",
"      ,g.[Amount]",
"      ,g.[Chart of Accounts No_]",
"      ,g.[Account Name]",
"      ,g.[Bal_ Account Type]",
"      ,g.[Bal_ Account No_]",
"      ,g.[Source Code]",
"      ,g.[Source Type]",
"      ,g.[Source No]",
"      ,g.[Document Description]",
"      ,g.[External Document No_]",
"      ,g.[VAT Amount]",
"      ,g.[VAT Prod_ Posting Group]",
"      ,g.[VAT Bus_ Posting Group]",
"  FROM [AIG_Nav_DW].[dbo].[G_L Entries] g",
" WHERE g.[Posting Date] >= " + W.lo,
"   AND g.[Posting Date] <  " + W.hi,
"   AND g.[id_company] IN (" + flowCCompanyList_(refs) + ")",
"   AND g.[Source Code] = 'SALES'",
"   AND " + flowCTuples_(refs, 'g.[id_company]', 'g.[Document No_]', 'package', false)
  ].join('\n');
}
function flowCFoldGlRetail_(csv, cell, mapped, ctx) {
  var g = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r]; if (!row || row.length < 2) continue;
    var c = cell(row), k = flowCUp_(c('id_company')) + '|' + flowCUp_(c('Document No_'));
    var a = g[k] = g[k] || { total: 0, ar: 0, n: 0 };
    var amt = flowCNum_(c('Amount')) || 0;
    a.total = flowCRound_(a.total + amt); a.n++;
    if (FLOWC_RETAIL_AR_ACCOUNTS.indexOf(String(c('Chart of Accounts No_')).trim()) !== -1) a.ar = flowCRound_(a.ar + amt);
  }
  ctx.data.glrRows = csv;
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Retail') return;
    var m = mr.mapped, a = g[flowCUp_(m.company) + '|' + flowCUp_(m.package_number)];
    if (!a) return;
    m.glr_receivable = a.ar; m.glr_total = a.total; m.glr_entries = a.n;
  });
}
function flowCFoldInvoices_(csv, cell, mapped, ctx) {
  var inv = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r]; if (!row || row.length < 2) continue;
    var c = cell(row);
    inv[flowCUp_(c('id_company')) + '|' + flowCUp_(c('No_'))] = {
      total: flowCNum_(c('Amount incl_ VAT')), excl: flowCNum_(c('Amount excl_ VAT')),
      customer: c('Customer Name'), posting: c('Posting Date')
    };
  }
  ctx.data.invRows = csv;
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Retail') return;
    var m = mr.mapped, h = inv[flowCUp_(m.company) + '|' + flowCUp_(m.package_number)];
    if (!h) return;
    m.inv_no = m.package_number; m.inv_total = h.total; m.inv_excl = h.excl; m.inv_customer = h.customer; m.inv_posting = h.posting;
  });
}
function flowCFoldInvoiceLines_(csv, cell, mapped, ctx) {
  var groups = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r]; if (!row || row.length < 2) continue;
    var c = cell(row), k = flowCUp_(c('id_company')) + '|' + flowCUp_(c('Document No_'));
    (groups[k] = groups[k] || []).push({ line_no: String(c('Line No_')).trim(), amount: flowCNum_(c('Amount Including VAT')), desc: c('Description'), no: c('No_') });
  }
  // Flag the sampled line in the raw extract so the reviewer sees what was compared.
  var selected = {};
  mapped.forEach(function (mr) { if (mr.found && mr.mapped.subpopulation === 'Retail') selected[flowCUp_(mr.mapped.company) + '|' + flowCUp_(mr.mapped.package_number) + '|' + String(mr.mapped.bob_soi).trim()] = true; });
  ctx.data.invlRows = csv.map(function (row, i) {
    if (i === 0) return row.concat(['Selected?']);
    var c = cell(row);
    return row.concat([selected[flowCUp_(c('id_company')) + '|' + flowCUp_(c('Document No_')) + '|' + String(c('Line No_')).trim()] ? 'TRUE' : 'FALSE']);
  });
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Retail') return;
    var m = mr.mapped, rows = groups[flowCUp_(m.company) + '|' + flowCUp_(m.package_number)];
    if (!rows) return;
    var sum = 0; rows.forEach(function (x) { sum += (x.amount || 0); });
    m.inv_lines_total = flowCRound_(sum); m.inv_lines_count = rows.length;
    var hit = rows.filter(function (x) { return x.line_no === String(m.bob_soi).trim(); })[0];
    if (hit) { m.inv_line_amount = hit.amount; m.inv_line_desc = hit.desc; m.inv_line_item = hit.no; }
  });
}

/* ============================ MPL — RING + NAV ============================ */
/** Hop 1: which statement carries each sampled item (company + date seek, then the SOI
 *  filter), plus — for these few items only — the PO number and its down payment. The
 *  down-payment join is on a text `notes` column (the slow one), which is exactly why it
 *  lives here on a handful of rows and NOT on the 20k+ rows of hop 2. */
function flowCQueryRingCodes_(refs, p) {
  var DB = 'AIG_Nav_Jumia_Reconciliation', S = "'" + p.fyStart + "'", E1 = "DATEADD(MONTH, 1, '" + p.fyEnd + "')";
  return [
"SELECT s.[ID_Company]",
"      ,s.[OMS_ID_Sales_Order_Item]",
"      ,s.[Payout_Statement_Code]",
"      ,s.[Transaction_Type]",
"      ,s.[Transaction_Amount]",
"      ,s.[Transaction_No]",
"      ,CONVERT(date, s.[Created_Date]) AS 'Created_Date'",
"      ,s.[Vendor_Short_Code]",
"      ,s.[Vendor_Name]",
"      ,soi.[PO_NUMBER]",
"      ,dp.[Transaction_No]     AS [Down Payment Transaction]",
"      ,dp.[Transaction_Amount] AS [Down Payment Amount]",
"  FROM [" + DB + "].[dbo].[RPT_TRANSACTIONS_SELLER] s",
"  LEFT JOIN [" + DB + "].[dbo].[RPT_SOI] soi",
"         ON soi.ID_COMPANY              = s.ID_Company",
"        AND soi.COD_OMS_SALES_ORDER_ITEM = s.OMS_ID_Sales_Order_Item",
"        AND soi.DELIVERED_DATE          >= " + S,
"  LEFT JOIN [" + DB + "].[dbo].[RPT_TRANSACTIONS_SELLER] dp",
"         ON dp.ID_Company       = s.ID_Company",
"        AND dp.[notes]          = soi.[PO_NUMBER]",
"        AND dp.Transaction_Type = 'Down Payment'",
"        AND dp.[Created_Date]  >= " + S,
" WHERE s.[ID_Company] IN (" + flowCCompanyList_(refs) + ")",
"   AND s.[Created_Date] >= " + S,
"   AND s.[Created_Date] <  " + E1,
"   AND " + flowCTuples_(refs, 's.[ID_Company]', 's.[OMS_ID_Sales_Order_Item]', 'soi', true)
  ].join('\n');
}
/** Date window for the statement-level queries: the sampled items' RING dates ± a margin
 *  (a statement's transactions all fall in its own week; NAV posts shortly after it closes).
 *  Falls back to the period when hop 1 gave no dates. Returns SQL literals. */
function flowCWindow_(p, ctx, beforeMonths, afterMonths, key) {
  var d = ctx && ctx.data && ctx.data[key || 'codeDates'];
  var lo = (d && d.min) ? d.min : p.fyStart, hi = (d && d.max) ? d.max : p.fyEnd;
  return { lo: "DATEADD(MONTH, -" + beforeMonths + ", '" + lo + "')", hi: "DATEADD(MONTH, " + afterMonths + ", '" + hi + "')" };
}
/** Hop 2: every transaction of those statements with Flow A's evidence columns (insured =
 *  MPL type, payout = paid, statement balances). Literal codes per company; raw ON-driven
 *  joins only; window = the items' dates ± 1 month. */
function flowCQueryRing_(refs, p, ctx) {
  var DB = 'AIG_Nav_Jumia_Reconciliation', S = "'" + p.fyStart + "'", W = flowCWindow_(p, ctx, 1, 1);
  return [
"SELECT t.[ID_Company]",
"      ,t.[Transaction_No]",
"      ,CONVERT(date, t.[Created_Date]) AS 'Created_Date'",
"      ,t.[Vendor_Short_Code]",
"      ,t.[Vendor_Name]",
"      ,CASE WHEN insured.Target_code IS NOT NULL THEN 'MPL advance' ELSE 'Regular' END AS [MPL type]",
"      ,t.[Transaction_Type]",
"      ,t.[Nav_Type]",
"      ,t.[Transaction_Amount]",
"      ,t.[OMS_ID_Sales_Order_Item]",
"      ,t.[Order_Number]",
"      ,t.[sku_simple]",
"      ,t.[Payout_Statement_Code]",
"      ,CONVERT(date, payouts.[Paid_At_Date]) AS [Paid_At_Date]",
"      ,payouts.[Amount] AS [Paid_Amount]",
"      ,payouts.[Payout_Method]",
"      ,payouts.[Source_Provider]",
"      ,payouts.[Payment_Reference]",
"      ,st.[Start_Date]      AS [Statement Start Date]",
"      ,st.[End_Date]        AS [Statement End Date]",
"      ,st.[Opening_Balance] AS [Statement Opening Balance]",
"      ,st.[Closing_Balance] AS [Statement Closing Balance]",
"  FROM [" + DB + "].[dbo].[RPT_TRANSACTIONS_SELLER] t",
"  LEFT JOIN [" + DB + "].[RING].[RPT_TARGET_VARIABLE] insured",
"         ON insured.Company_ID  = t.ID_Company",
"        AND insured.Target_code = t.Vendor_Short_Code",
"        AND insured.[type]      = 'SELLER'",
"        AND insured.Variable    = 'Damaged Items Insurance - Active'",
"  LEFT JOIN [" + DB + "].[dbo].[RPT_PAYOUT] payouts",
"         ON payouts.ID_Company              = t.ID_Company",
"        AND payouts.Account_Statement_Number = t.Payout_Statement_Code",
"        AND payouts.Partner_Type            = 'SELLER'",
"        AND payouts.Paid_At_Date           >= " + S,
"  LEFT JOIN [" + DB + "].[dbo].[RPT_SELLER_STATEMENTS_PAYOUT] st",
"         ON st.ID_Company               = t.ID_Company",
"        AND st.ID_Transaction_Statement = t.ID_Account_Statement",
"        AND st.[Start_Date]            >= " + W.lo,
" WHERE t.[ID_Company] IN (" + flowCCompanyList_(refs) + ")",
"   AND t.[Created_Date] >= " + W.lo,
"   AND t.[Created_Date] <  " + W.hi,
"   AND " + flowCTuples_(refs, 't.[ID_Company]', 't.[Payout_Statement_Code]', 'code', false)
  ].join('\n');
}
/** NAV G/L: every entry of the 'IS…' document of each statement (source PURCHASES), ALL accounts —
 *  the reconciliation uses account 18314, the rest shows the document nets to zero. The table's
 *  index leads on Posting Date, so bounding the posting window to the statements' dates
 *  (-1 / +3 months) is what keeps this a range seek instead of a multi-minute scan. */
function flowCQueryGl_(refs, p, ctx) {
  var W = flowCWindow_(p, ctx, 1, 3);
  var isRefs = refs.map(function (r) { return { company: r.company, isdoc: flowCIsDoc_(r.code) }; });
  return [
"SELECT g.[id_company]",
"      ,g.[Entry No_]",
"      ,g.[Document No_]",
"      ,CONVERT(date, g.[Posting Date]) AS 'Posting Date'",
"      ,g.[Document Type]",
"      ,g.[Amount]",
"      ,g.[Chart of Accounts No_]",
"      ,g.[Account Name]",
"      ,g.[Bal_ Account No_]",
"      ,g.[Source Code]",
"      ,g.[Document Description]",
"      ,g.[External Document No_]",
"      ,g.[VAT Amount]",
"      ,g.[Partner Code]",
"  FROM [AIG_Nav_DW].[dbo].[G_L Entries] g",
" WHERE g.[Posting Date] >= " + W.lo,
"   AND g.[Posting Date] <  " + W.hi,
"   AND g.[id_company] IN (" + flowCCompanyList_(isRefs) + ")",
"   AND g.[Source Code] = 'PURCHASES'",
"   AND " + flowCTuples_(isRefs, 'g.[id_company]', 'g.[Document No_]', 'isdoc', false)
  ].join('\n');
}
/** PS260119EG141H7 → IS260119EG141H7 (the NAV document swaps the 'PS' prefix for 'IS'). */
function flowCIsDoc_(code) { code = String(code || '').trim(); return code.length > 2 ? 'IS' + code.slice(2) : code; }

function flowCFoldRingCodes_(csv, cell, mapped, ctx) {
  var bySoi = {}, minD = '', maxD = '';
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r]; if (!row || row.length < 2) continue;
    var c = cell(row), k = flowCUp_(c('ID_Company')) + '|' + String(c('OMS_ID_Sales_Order_Item')).trim();
    (bySoi[k] = bySoi[k] || []).push({
      code: String(c('Payout_Statement_Code') || '').trim(), type: c('Transaction_Type'), amount: flowCNum_(c('Transaction_Amount')),
      txn: c('Transaction_No'), vendor: c('Vendor_Name'), po: c('PO_NUMBER'), dp_txn: c('Down Payment Transaction'), dp_amount: flowCNum_(c('Down Payment Amount'))
    });
    var d = String(c('Created_Date') || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { if (!minD || d < minD) minD = d; if (!maxD || d > maxD) maxD = d; }
  }
  ctx.data.ringCodeRows = csv;
  if (minD) ctx.data.codeDates = { min: minD, max: maxD };    // bounds the statement / NAV windows
  var codes = {}, out = [];
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Marketplace') return;
    var m = mr.mapped, rows = bySoi[flowCUp_(m.company) + '|' + String(m.document_no).trim()];
    if (!rows || !rows.length) return;
    var ipc = rows.filter(function (x) { return /^item price credit$/i.test(String(x.type || '')); })[0];
    var pick = ipc || rows.filter(function (x) { return x.code; })[0] || rows[0];
    m.statement = pick.code; m.vendor = m.vendor || pick.vendor;
    if (ipc) { m.ipc_amount = ipc.amount; m.ipc_txn = ipc.txn; }
    var withPo = rows.filter(function (x) { return x.po; })[0] || pick;
    if (withPo.po) m.po = withPo.po;
    if (withPo.dp_amount !== null && withPo.dp_amount !== undefined) { m.downpay = withPo.dp_amount; m.downpay_txn = withPo.dp_txn; }
    if (pick.code) { var ck = flowCUp_(m.company) + '|' + pick.code; if (!codes[ck]) { codes[ck] = true; out.push({ company: m.company, code: pick.code }); } }
  });
  ctx.data.codes = out;
}
function flowCFoldRing_(csv, cell, mapped, ctx) {
  var st = {};        // company|code → aggregate
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r]; if (!row || row.length < 2) continue;
    var c = cell(row), k = flowCUp_(c('ID_Company')) + '|' + String(c('Payout_Statement_Code') || '').trim();
    var a = st[k] = st[k] || { byNav: {}, n: 0, opening: null, closing: null, paid_at: '', paid_amount: null, method: '', ref: '', provider: '', mpl: 'Regular', rpf: false, vendor: '', start: '', end: '' };
    var nav = flowCUp_(c('Nav_Type')) || 'OTHER', amt = flowCNum_(c('Transaction_Amount')) || 0;
    a.byNav[nav] = flowCRound_((a.byNav[nav] || 0) + amt); a.n++;
    if (a.opening === null && c('Statement Opening Balance') !== '') a.opening = flowCNum_(c('Statement Opening Balance'));
    if (a.closing === null && c('Statement Closing Balance') !== '') a.closing = flowCNum_(c('Statement Closing Balance'));
    if (!a.paid_at && c('Paid_At_Date')) { a.paid_at = String(c('Paid_At_Date')).slice(0, 10); a.paid_amount = flowCNum_(c('Paid_Amount')); a.method = c('Payout_Method'); a.ref = c('Payment_Reference'); a.provider = c('Source_Provider'); }
    if (/advance/i.test(String(c('MPL type')))) a.mpl = 'MPL advance';
    if (/^return protection fee$/i.test(String(c('Transaction_Type')))) a.rpf = true;
    if (!a.vendor) a.vendor = c('Vendor_Name');
    if (!a.start) { a.start = String(c('Statement Start Date') || '').slice(0, 10); a.end = String(c('Statement End Date') || '').slice(0, 10); }
  }
  ctx.data.ringRows = csv;
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Marketplace' || !mr.mapped.statement) return;
    var m = mr.mapped, a = st[flowCUp_(m.company) + '|' + String(m.statement).trim()];
    if (!a) return;
    m.stmt_liabilities = a.byNav['LIABILITIES'] || 0; m.stmt_revenues = a.byNav['REVENUES'] || 0;
    var other = 0; Object.keys(a.byNav).forEach(function (k) { if (k !== 'LIABILITIES' && k !== 'REVENUES') other += a.byNav[k]; });
    m.stmt_other = flowCRound_(other); m.stmt_txn_count = a.n;
    m.opening_balance = a.opening; m.closing_balance = a.closing;
    m.stmt_start = a.start; m.stmt_end = a.end;
    m.paid_at = a.paid_at; m.paid_amount = a.paid_amount; m.payout_method = a.method; m.payment_ref = a.ref; m.source_provider = a.provider;
    m.mpl = a.mpl; m.has_rpf = a.rpf ? 'yes' : 'no'; m.vendor = a.vendor || m.vendor;
    m.facts.mpl = /advance/i.test(m.mpl) ? 'advance' : 'regular';     // same method as Flow A
    m.facts.paid = m.paid_at ? 'yes' : 'no';
  });
}
function flowCFoldGl_(csv, cell, mapped, ctx) {
  var g = {};
  for (var r = 1; r < csv.length; r++) {
    var row = csv[r]; if (!row || row.length < 2) continue;
    var c = cell(row), k = flowCUp_(c('id_company')) + '|' + flowCUp_(c('Document No_'));
    var a = g[k] = g[k] || { total: 0, acct: 0, n: 0 };
    var amt = flowCNum_(c('Amount')) || 0;
    a.total = flowCRound_(a.total + amt); a.n++;
    if (String(c('Chart of Accounts No_')).trim() === FLOWC_NAV_ACCOUNT) a.acct = flowCRound_(a.acct + amt);
  }
  ctx.data.glRows = csv;
  mapped.forEach(function (mr) {
    if (!mr.found || mr.mapped.subpopulation !== 'Marketplace' || !mr.mapped.statement) return;
    var m = mr.mapped, doc = flowCIsDoc_(m.statement), a = g[flowCUp_(m.company) + '|' + flowCUp_(doc)];
    m.nav_doc = doc;
    if (!a) return;
    m.nav_amount = a.acct; m.nav_total = a.total; m.nav_entries = a.n;
  });
}

/* ================================ CHECKS ================================ */
function flowCCheck_(name, a, b, note) {
  if (a === null || a === undefined || b === null || b === undefined) return { name: name, a: a, b: b, diff: null, status: 'missing', note: note || '' };
  var diff = flowCRound_(a - b);
  return { name: name, a: a, b: b, diff: diff, status: Math.abs(diff) <= FLOWC_TOLERANCE ? 'match' : 'variance', note: note || '' };
}
function flowCFinalize_(mapped, ctx) {
  mapped.forEach(function (mr) {
    if (!mr.found) return;
    var m = mr.mapped, price = flowCNum_(m.amount), checks;
    if (m.subpopulation === 'Retail') {
      checks = [
        flowCCheck_('NAV invoice item VS SOI', m.inv_line_amount, price, m.inv_line_amount === undefined ? 'No invoice line found for the BOB item' : ''),
        flowCCheck_('Invoice header VS Invoice items', m.inv_total, m.inv_lines_total, m.inv_total === undefined ? 'No posted sales invoice found for the package' : ''),
        flowCCheck_('Invoice header VS NAV GL entries', m.inv_total, m.glr_receivable, m.glr_receivable === undefined ? 'No G/L entries (SALES) found for the invoice' : (m.glr_total ? 'G/L document does not net to zero (' + m.glr_total + ')' : ''))
      ];
    } else {
      var stmtSum = (m.opening_balance === undefined || m.opening_balance === null) ? null
        : flowCRound_((m.opening_balance || 0) + (m.stmt_liabilities || 0) + (m.stmt_revenues || 0) + (m.stmt_other || 0));
      checks = [
        flowCCheck_('Item Price Credit (RING) VS SOI', m.ipc_amount, price, m.ipc_amount === undefined ? 'No Item Price Credit transaction found for the item' : ''),
        flowCCheck_('RING transactions VS RING statement', stmtSum, m.closing_balance, !m.statement ? 'Item not found on any statement' : ''),
        flowCCheck_('NAV revenue VS RING revenue', m.nav_amount, (m.stmt_revenues === undefined ? null : -m.stmt_revenues), m.nav_amount === undefined ? 'No G/L entries found for ' + (m.nav_doc || 'the statement document') : (m.nav_total ? 'G/L document does not net to zero (' + m.nav_total + ')' : ''))
      ];
    }
    m.checks = checks;
    var worst = 'accept';
    checks.forEach(function (c) { if (c.status !== 'match') worst = 'uncertain'; });
    m.recon_verdict = worst;   // never 'reject' — a variance is for the reviewer to judge
    m.recon_summary = checks.map(function (c) {
      return c.name + ': ' + (c.status === 'match' ? 'match' : c.status === 'variance' ? ('variance ' + c.diff) : ('missing' + (c.note ? ' — ' + c.note : '')));
    }).join(' | ');
  });
}

/* ============================== WORKBOOK ============================== *
 * Modelled on the reviewer's own "Reconciliation - Marketplace and retail.xlsx":
 *   REC - MPL / REC - Retail  — logo, title, period; four numbered sections per sheet
 *                               (sample → each check), orange header band, Calibri 8, no
 *                               gridlines, frozen at the header; every number is a LIVE
 *                               formula into the raw tabs (VLOOKUP / SUMIFS), so the
 *                               reviewer can trace any figure to its source rows.
 *   Data Extractions ->       — divider tab
 *   SOI, NAV_PostedSalesInvoices, NAV_PostedSalesInvoiceLine, NAV_Retail, RING, NAV
 *                             — the raw extracts (bold frozen header, filter, dates)
 * The workbook's 4th check ("NAV completeness": the G/L document nets to zero) lives in
 * the file only — the app's own checks are the three per population (see flowCFinalize_).
 * Column letters in the formulas are those of the raw tabs' query columns — keep in sync
 * with the SELECT lists above if columns are added or reordered.
 */
var FLOWC_WB = {
  orange: '#FF6D01', white: '#FFFFFF', grey: '#BFBFBF', black: '#000000',
  font: { family: 'Calibri', size: 8 },
  numFmt: '#,##0 ;(#,##0);"-" ',          // integers, negatives in parentheses, zero as a dash (no decimals)
  widths: { margin: 25, data: 114, gap: 74 },
  rowH: { title: 21, header: 30, data: 15 },
  firstDataRow: 11
};
function flowCWorkbook_(mapped, ctx) {
  var d = ctx.data || {};
  var title = 'Marketplace and retail revenues';
  var sub = [(ctx.period && ctx.period.name) || '', (ctx.requestRef || '').trim()].filter(Boolean).join(' · ');
  var mplLines = [], retailLines = [];
  mapped.forEach(function (mr) { if (!mr.found) return; (mr.mapped.subpopulation === 'Retail' ? retailLines : mplLines).push(mr.mapped); });
  var sheets = [
    flowCRecSheet_('REC - MPL', title, sub, flowCMplLayout_(), mplLines),
    flowCRecSheet_('REC - Retail', title, sub, flowCRetailLayout_(), retailLines),
    { name: 'Data Extractions ->', rows: [], header: false, tabColor: FLOWC_WB.white }
  ];
  var raw = function (name, rows) { if (rows && rows.length) sheets.push({ name: name, rows: rows, autoFilter: true, dateCols: 'auto' }); };
  raw('SOI', ctx.csv1); raw('NAV_PostedSalesInvoices', d.invRows); raw('NAV_PostedSalesInvoiceLine', d.invlRows);
  raw('NAV_Retail', d.glrRows); raw('RING', d.ringRows); raw('NAV', d.glRows);
  return { name: 'Reconciliation - ' + ((ctx.requestRef || '').trim() || (ctx.flow && ctx.flow.name) || 'Flow C'), sheets: sheets };
}

/* ---- REC sheet layouts: one entry per column B..V; null = a narrow gap column ----
 * { h: header, sec: section index, check: true → italic un-filled header, num: true → number
 *   format, v(m, r): cell value — a string starting with '=' is a formula; r = the row number. */
function flowCMplLayout_() {
  var S = function (k, r) { return "SUMIFS(RING!I:I,RING!M:M,K" + r + ",RING!H:H,\"" + k + "\")"; };
  return {
    sections: ['1. Selected Marketplace samples:', '2. Item Price Credit (RING) VS SOI:', '3. RING Transactions VS RING Statements:', '4. RING VS NAV:'],
    cols: [
      { h: 'ID_COMPANY', sec: 0, v: function (m) { return m.company; } },
      { h: 'COD_OMS_SALES_ORDER_ITEM', sec: 0, v: function (m) { return flowCNum_(m.document_no) !== null ? flowCNum_(m.document_no) : m.document_no; } },
      { h: 'COD_SKU', sec: 0, v: function (m) { return m.sku || ''; } },
      { h: 'PACKAGE_NUMBER', sec: 0, v: function (m) { return m.package_number || ''; } },
      { h: 'MTR_UNIT_PRICE', sec: 0, num: true, v: function (m, r) { return '=IFERROR(VLOOKUP(B' + r + '&C' + r + ',SOI!B:H,7,FALSE),0)'; } },
      null,
      { h: 'Item Price Credit (RING)', sec: 1, num: true, v: function (m, r) { return '=SUMIFS(RING!I:I,RING!J:J,C' + r + ',RING!G:G,"Item Price Credit")'; } },
      { h: 'Check 1', sec: 1, check: true, num: true, v: function (m, r) { return '=H' + r + '-F' + r; } },
      null,
      { h: 'Payout_Statement_Code', sec: 2, v: function (m) { return m.statement || ''; } },
      { h: 'Statement Opening Balance', sec: 2, num: true, v: function (m, r) { return '=IFERROR(VLOOKUP(K' + r + ',RING!M:V,9,FALSE),0)'; } },
      { h: 'Statement Closing Balance', sec: 2, num: true, v: function (m, r) { return '=IFERROR(VLOOKUP(K' + r + ',RING!M:V,10,FALSE),0)'; } },
      { h: 'Transactions - Liabilities', sec: 2, num: true, v: function (m, r) { return '=' + S('LIABILITIES', r); } },
      { h: 'Transactions - Revenues', sec: 2, num: true, v: function (m, r) { return '=' + S('REVENUES', r); } },
      { h: 'Check 2', sec: 2, check: true, num: true, v: function (m, r) { return '=(M' + r + '-L' + r + ')-SUM(N' + r + ':O' + r + ')'; } },
      null,
      { h: 'NAV document', sec: 3, v: function (m) { return m.nav_doc || (m.statement ? flowCIsDoc_(m.statement) : ''); } },
      { h: 'NAV (' + FLOWC_NAV_ACCOUNT + ')', sec: 3, num: true, v: function (m, r) { return '=SUMIFS(NAV!F:F,NAV!G:G,' + FLOWC_NAV_ACCOUNT + ',NAV!C:C,R' + r + ')'; } },
      { h: 'NAV (other accounts)', sec: 3, num: true, v: function (m, r) { return '=SUMIFS(NAV!F:F,NAV!G:G,"<>' + FLOWC_NAV_ACCOUNT + '",NAV!C:C,R' + r + ')'; } },
      { h: 'Check 3: NAV VS RING', sec: 3, check: true, num: true, v: function (m, r) { return '=S' + r + '+O' + r; } },
      { h: 'Check 4: NAV completeness', sec: 3, check: true, num: true, v: function (m, r) { return '=SUM(S' + r + ':T' + r + ')'; } }
    ]
  };
}
function flowCRetailLayout_() {
  var L = 'NAV_PostedSalesInvoiceLine', I = 'NAV_PostedSalesInvoices', G = 'NAV_Retail';
  var ar = function (r) { return FLOWC_RETAIL_AR_ACCOUNTS.map(function (a) { return 'SUMIFS(' + G + '!F:F,' + G + '!A:A,B' + r + ',' + G + '!C:C,R' + r + ',' + G + '!G:G,' + a + ')'; }).join('+'); };
  return {
    sections: ['1. Selected Retail samples:', '2. NAV invoice item VS SOI:', '3. Invoice header VS Invoice items:', '4. Invoice header VS NAV GL entries:'],
    cols: [
      { h: 'ID_COMPANY', sec: 0, v: function (m) { return m.company; } },
      { h: 'COD_OMS_SALES_ORDER_ITEM', sec: 0, v: function (m) { return flowCNum_(m.document_no) !== null ? flowCNum_(m.document_no) : m.document_no; } },
      { h: 'COD_BOB_SALES_ORDER_ITEM', sec: 0, v: function (m) { return flowCNum_(m.bob_soi) !== null ? flowCNum_(m.bob_soi) : (m.bob_soi || ''); } },
      { h: 'COD_SKU', sec: 0, v: function (m) { return m.sku || ''; } },
      { h: 'PACKAGE_NUMBER', sec: 0, v: function (m) { return m.package_number || ''; } },
      { h: 'MTR_UNIT_PRICE', sec: 0, num: true, v: function (m, r) { return '=IFERROR(VLOOKUP(B' + r + '&C' + r + ',SOI!B:H,7,FALSE),0)'; } },
      null,
      { h: 'Invoice No_', sec: 1, v: function (m) { return m.package_number || ''; } },
      { h: 'NAV invoice item incl. VAT', sec: 1, num: true, v: function (m, r) { return '=SUMIFS(' + L + '!I:I,' + L + '!A:A,B' + r + ',' + L + '!B:B,I' + r + ',' + L + '!C:C,D' + r + ')'; } },
      { h: 'Check 1', sec: 1, check: true, num: true, v: function (m, r) { return '=J' + r + '-G' + r; } },
      null,
      { h: 'Invoice No_', sec: 2, v: function (m) { return m.package_number || ''; } },
      { h: 'Invoice items total', sec: 2, num: true, v: function (m, r) { return '=SUMIFS(' + L + '!I:I,' + L + '!A:A,B' + r + ',' + L + '!B:B,M' + r + ')'; } },
      { h: 'Invoice header incl. VAT', sec: 2, num: true, v: function (m, r) { return '=SUMIFS(' + I + '!F:F,' + I + '!A:A,B' + r + ',' + I + '!B:B,M' + r + ')'; } },
      { h: 'Check 2', sec: 2, check: true, num: true, v: function (m, r) { return '=O' + r + '-N' + r; } },
      null,
      { h: 'Invoice No_', sec: 3, v: function (m) { return m.package_number || ''; } },
      { h: 'NAV GL receivables (' + FLOWC_RETAIL_AR_ACCOUNTS.join('+') + ')', sec: 3, num: true, v: function (m, r) { return '=' + ar(r); } },
      { h: 'NAV (other accounts)', sec: 3, num: true, v: function (m, r) { return '=SUMIFS(' + G + '!F:F,' + G + '!A:A,B' + r + ',' + G + '!C:C,R' + r + ')-S' + r; } },
      { h: 'Check 3: Invoice header VS GL entries', sec: 3, check: true, num: true, v: function (m, r) { return '=S' + r + '-O' + r; } },
      { h: 'Check 4: NAV completeness', sec: 3, check: true, num: true, v: function (m, r) { return '=SUM(S' + r + ':T' + r + ')'; } }
    ]
  };
}

/** Render one REC sheet spec (grid + styles + logo) from a layout and its lines. Column A is a
 *  margin; layout columns start at B. Rows: 1-5 logo, 6 title, 7 period, 9 sections, 10 headers, 11+ data. */
function flowCRecSheet_(name, title, sub, layout, lines) {
  var W = FLOWC_WB, first = W.firstDataRow, cols = layout.cols, width = cols.length + 1;
  var col = function (i) { return String.fromCharCode(65 + i + 1); };            // layout index → letter (B..)
  var blank = function () { var r = []; for (var i = 0; i < width; i++) r.push(''); return r; };
  var rows = [];
  for (var r = 1; r < first; r++) rows.push(blank());
  rows[5][1] = title; rows[6][1] = sub;                                          // B6, B7
  cols.forEach(function (c, i) { if (c) rows[9][i + 1] = c.h; });                // row 10 headers
  // Section titles on row 9, one per section at its first column.
  var secStart = {}, secEnd = {};
  cols.forEach(function (c, i) { if (!c) return; if (secStart[c.sec] === undefined) secStart[c.sec] = i; secEnd[c.sec] = i; });
  layout.sections.forEach(function (t, s) { if (secStart[s] !== undefined) rows[8][secStart[s] + 1] = t; });
  lines.forEach(function (m, k) {
    var rn = first + k, row = blank();
    cols.forEach(function (c, i) { if (c) { var v = c.v(m, rn); row[i + 1] = (v === null || v === undefined) ? '' : v; } });
    rows.push(row);
  });
  var last = first + Math.max(lines.length, 1) - 1;

  var styles = [
    { range: 'B6', bold: true }, { range: 'B7', bold: true }
  ];
  layout.sections.forEach(function (t, s) {
    if (secStart[s] === undefined) return;
    styles.push({ range: col(secStart[s]) + '9:' + col(secEnd[s]) + '9', bold: true, italic: true, border: { bottom: true, color: W.black, style: 'medium' } });
  });
  var widths = [W.widths.margin];
  cols.forEach(function (c, i) {
    var letter = col(i);
    if (!c) { widths.push(W.widths.gap); return; }
    widths.push(W.widths.data);
    if (c.check) styles.push({ range: letter + '10', italic: true, wrap: true, valign: 'middle' });
    else styles.push({ range: letter + '10', bg: W.orange, color: W.white, bold: true, wrap: true, valign: 'middle', border: { top: true, left: true, bottom: true, right: true, color: W.grey, style: 'thin' } });
    if (c.num && lines.length) styles.push({ range: letter + first + ':' + letter + last, numberFormat: W.numFmt });
  });
  var rowHeights = { 6: W.rowH.title, 7: W.rowH.title, 9: W.rowH.title, 10: W.rowH.header };
  for (var k = first; k <= last; k++) rowHeights[k] = W.rowH.data;

  return {
    name: name, rows: rows, header: false, freezeRows: first - 1, gridlines: false,
    font: W.font, colWidths: widths, rowHeights: rowHeights, styles: styles,
    images: [{ b64: (typeof JUMIA_LOGO_PNG_B64 === 'string') ? JUMIA_LOGO_PNG_B64 : '', mime: 'image/png', name: 'jumia.png', col: 1, row: 1, offX: 9, offY: 7, width: 264, height: 79 }].filter(function (im) { return im.b64; })
  };
}
