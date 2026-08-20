/**
 * Flow B — Cash Anchor.
 * ---------------------
 * Sample = sales-order items. We enrich from the sale up to the moment the cash is
 * received, then route each line to the evidence that supports that cash collection.
 *
 * Two things make this flow richer than Flow A, and they're the reason the engine
 * grows a couple of optional hooks (all still driven by this one module):
 *
 *  1. COMPOSITE SAMPLE KEY — the auditor gives us ID_COMPANY + COD_OMS_SALES_ORDER_ITEM
 *     per line (two columns). The match key is their concatenation, exactly as the
 *     master query filters: concat(ID_COMPANY, COD_OMS_SALES_ORDER_ITEM).
 *
 *  2. TWO-STAGE, DEPENDENT ENRICHMENT — query 1 (AIG_Nav_Jumia_Reconciliation) drills
 *     each item down to its subpopulation and cash-collection detail. For the JumiaPay
 *     rows, query 2 (PAY_DWH) then pulls the wallet-transfer/transaction detail, keyed
 *     by a reference built from query 1's output (see stage2.refOf — the DAX the master
 *     file uses).
 *
 * The module owns the two things config can't express: the SQL and how to read a row
 * (into line fields + the routing `facts`). Subpopulation → evidence → responsible team
 * lives in Routing config (Phase 2).
 *
 * QUERY RULES (same as Flow A — do not regress):
 *  - One SELECT, no stacked statements. The master file uses `Declare @startdate…`; the
 *    gateway rejects that, so the period dates are inlined as literals (p.fyStart/fyEnd)
 *    and the DATEADD look-back/forward windows are computed around those literals.
 *  - Build every IN (...) list with sqlLiteral_ (all of it is external sample input):
 *    the concat sample keys, the distinct company codes, and the stage-2 references.
 *  - The company list is derived from the sample (variable — works as new companies open),
 *    not hard-coded to the 9 in the master file.
 */
function flowB_() {
  return {
    id: 'flowB',
    sampleKey: 'SampleKey',   // query 1 emits concat(ID_COMPANY,COD_OMS_SALES_ORDER_ITEM) as this column

    /**
     * Parse the paste box into sample items. Each line carries two columns —
     * ID_COMPANY then COD_OMS_SALES_ORDER_ITEM — separated by tab / comma / semicolon
     * / whitespace. Returns de-duplicated items { key, company, soi }; `key` is the
     * concatenation used to match rows and as the line's identity.
     */
    parseSample: function (text) {
      var seen = {}, out = [];
      String(text || '').split(/[\r\n]+/).forEach(function (line) {
        var parts = line.split(/[\t,;]+|\s+/).map(function (s) { return s.replace(/^['"\s]+|['"\s]+$/g, ''); }).filter(Boolean);
        if (parts.length < 2) return;                 // need both columns
        var company = parts[0], soi = parts[1];
        if (!/^\d+$/.test(soi)) return;               // SOI is numeric — skips a header row
        var key = (company + soi).toUpperCase();
        if (seen[key]) return;
        seen[key] = true;
        out.push({ key: key, company: company, soi: soi });
      });
      return out;
    },

    buildQuery: function (items, p) { return flowBQuery1_(items, p); },

    /**
     * Read one query-1 row into the line's fields + the routing facts. The facts are
     * the subpopulation (which Routing maps to evidence + owner) and whether stage 2
     * applies. We keep the raw reference inputs on the row so stage2.refOf can build
     * the PAY_DWH key without re-reading the CSV.
     */
    mapRow: function (cell) {
      var type    = String(cell('Payment type') || '').trim();          // 'Prepaid' | 'Postpaid'
      var method  = String(cell('Payment method') || '').trim();        // query-1 CASE output
      var bankJp  = /jumiapay/i.test(String(cell('OMS_Bank_Account') || ''));
      var isPre   = /prepaid/i.test(type);
      var sub     = flowBSubpopulation_(isPre, method, bankJp);

      return {
        document_no:     cell('COD_OMS_SALES_ORDER_ITEM'),   // the line's identity (SOI)
        company:         cell('ID_COMPANY'),
        company_country: cell('Company_Country'),
        payment_type:    type,
        payment_method:  method,
        subpopulation:   sub,
        amount:          cell('OMS_Payment_Amount'),   // generic amount column (cash received)
        collection_partner: cell('COLLECTION_PARTNER'),
        order_nr:        cell('ORDER_NR'),
        package_number:  cell('PACKAGE_NUMBER'),
        jpay_order_id:   cell('JPay_Merchant_order_ID'),
        packlist_no:     cell('OMS_Packlist_No'),
        payment_no:      cell('OMS_Payment_No'),
        payment_ref:     cell('OMS_Payment_Reference'),
        bank_account:    cell('OMS_Bank_Account'),
        prepaid_amount:  cell('Prepaid amount'),
        package_amount:  cell('OMS_Package_Amount_Received'),
        payment_amount:  cell('OMS_Payment_Amount'),
        payment_date:    cell('OMS_Payment_Date'),
        facts: {
          payment_type:  isPre ? 'prepaid' : 'postpaid',
          subpopulation: sub,
          jumiapay:      flowBStage2Ref_(sub, cell('Company_Country'), cell) ? 'yes' : 'no'
        }
      };
    },

    /**
     * Stage 2 — PAY_DWH detail for the JumiaPay subpopulations. Runs only when at least
     * one stage-1 row produces a reference. `refOf(mapped)` is the master file's DAX,
     * ported: it builds concat(isocode, <order ref>) where the order ref depends on the
     * subpopulation. `merge` folds the PAY_DWH fields onto the matching line.
     */
    stage2: {
      database: 'PAY_DWH',
      keyCol:   'UniqueReference',                                  // query-2 column = the reference
      refOf:    function (mapped) { return flowBStage2Ref_(mapped.subpopulation, mapped.company_country, function (k) { return mapped[flowBCellAlias_(k)]; }); },
      buildQuery: function (refs, p) { return flowBQuery2_(refs, p); },
      mapRow2: function (cell) {
        return {
          jp_reference:   cell('UniqueReference'),
          jp_isocode:     cell('isocode'),
          jp_order_nr:    cell('cod_order_nr'),
          jp_retrieval:   cell('retrieval_reference_nr'),
          jp_gateway:     cell('Gateway'),
          jp_provider:    cell('dsc_payment_provider'),
          jp_created:     cell('creation_datetime'),
          jp_amount_txn:  cell('Amount_Transactions'),
          jp_amount_mtr:  cell('Amount_Merchants')
        };
      },
      merge: function (line, row2) { for (var k in row2) if (row2.hasOwnProperty(k)) line[k] = row2[k]; }
    }
  };
}

/* ---------- subpopulation classifier ----------
 * Mirrors the master file's "Payment method" CASE + the Payments-mapping lookup,
 * collapsed to the six buckets that are the workbook's sheet tabs. `bankJp` = the
 * OMS_Bank_Account is JumiaPay (the 3PL-remits-via-JumiaPay split of postpaid cash). */
function flowBSubpopulation_(isPrepaid, method, bankJp) {
  var m = String(method || '').toLowerCase();
  if (isPrepaid) {
    if (m === 'jumia_pay' || m === 'jumiapay' || m === 'hellopay') return 'Prepaid - JumiaPay';
    if (m === 'voucher') return 'Prepaid - Voucher';
    return 'Prepaid - Other methods';
  }
  if (m === 'jumiapay on delivery') return 'Postpaid - JumiaPay on delivery';
  if (m === 'cash' && bankJp)       return 'Postpaid - Cash - 3PL via JPay';
  return 'Postpaid - Cash & POS';   // Cash / POS / MTN / M-Pesa / Netplus / Other
}

/* ---------- stage-2 reference (the master file's DAX, ported) ----------
 * JumiaPay on Delivery  -> isocode + JPay_Merchant_order_ID
 * Prepaid - JumiaPay    -> isocode + ORDER_NR
 * Cash + bank=JumiaPay  -> isocode + OMS_Payment_No       (3PL via JPay)
 * anything else         -> null (not a JumiaPay row, no stage 2). */
function flowBStage2Ref_(subpopulation, isocode, cell) {
  var iso = String(isocode || '').trim();
  function ref(part) { part = String(part == null ? '' : part).trim(); return (iso && part) ? (iso + part) : null; }
  if (subpopulation === 'Postpaid - JumiaPay on delivery') return ref(cell('JPay_Merchant_order_ID'));
  if (subpopulation === 'Prepaid - JumiaPay')              return ref(cell('ORDER_NR'));
  if (subpopulation === 'Postpaid - Cash - 3PL via JPay')  return ref(cell('OMS_Payment_No'));
  return null;
}
// mapRow stores the ref inputs under friendly keys; map a query column name to that key.
function flowBCellAlias_(col) {
  return ({ 'JPay_Merchant_order_ID': 'jpay_order_id', 'ORDER_NR': 'order_nr', 'OMS_Payment_No': 'payment_no' })[col] || col;
}

/* ================================ QUERY 1 ================================ *
 * AIG_Nav_Jumia_Reconciliation. Base V_RPT_SOI + five ON-driven left joins; the
 * sample drives the seek via concat(ID_COMPANY,SOI) IN (...). Emits SampleKey as the
 * match column. Dates inlined from the period; DATEADD windows computed around them. */
function flowBQuery1_(items, p) {
  var DB = p.database;
  var S = "'" + p.fyStart + "'", E = "'" + p.fyEnd + "'";        // inlined period literals
  var keyList = items.map(function (i) { return sqlLiteral_(i.key); }).join(',');
  var companies = {};
  items.forEach(function (i) { if (i.company) companies[String(i.company).toLowerCase()] = true; });
  var coList = Object.keys(companies).map(sqlLiteral_).join(',') || "''";

  return [
"SELECT soi.[ID_COMPANY]",
"      ,comp.[Company_Country] AS 'Company_Country'",
"      ,CONCAT(soi.[ID_COMPANY], soi.[COD_OMS_SALES_ORDER_ITEM]) AS 'SampleKey'",
"      ,CASE WHEN soi.[FLG_IS_PREPAYMENT] = 1 OR soi.[PAYMENT_METHOD] = 'NoPayment' THEN 'Prepaid' ELSE 'Postpaid' END AS 'Payment type'",
"      ,CASE WHEN soi.[FLG_IS_PREPAYMENT] = 1 THEN soi.[PAYMENT_METHOD] ELSE",
"            CASE WHEN soi.[PAYMENT_METHOD] = 'NoPayment' THEN 'Voucher' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] LIKE '%netplus%' THEN 'Netplus' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] LIKE '%POS' THEN 'POS' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] LIKE 'JumiaPayPost%' THEN 'JumiaPay on delivery' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] = 'MtnMoMo Postpaid' THEN 'MTN' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] = 'Mobile Money' THEN 'M-Pesa manual' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] = 'MPESAOnDelivery' THEN 'M-Pesa integrated' ELSE",
"            CASE WHEN soi.[COLLECTION_PARTNER] IS NOT NULL THEN 'Cash' ELSE 'Other'",
"            END END END END END END END END END AS 'Payment method'",
"      ,soi.[COLLECTION_PARTNER]",
"      ,soi.[COD_OMS_SALES_ORDER_ITEM]",
"      ,soi.[ORDER_NR]",
"      ,soi.[PACKAGE_NUMBER]",
"      ,CASE WHEN soi.[COLLECTION_PARTNER] = 'JumiaPayPost' THEN cashrec.[JPay_Merchant_order_ID] ELSE NULL END AS 'JPay_Merchant_order_ID'",
"      ,CONVERT(date, soi.[FINANCE_VERIFIED_DATE]) AS 'Prepayment date'",
"      ,prepayments.[OMS_Pre_Payment_Amount] AS 'Prepaid amount'",
"      ,CPMT_packages.[OMS_Package_Amount_Received]",
"      ,CPMT_packages.[OMS_Packlist_No]",
"      ,CPMT_packages.[OMS_Payment_Method_Confirmed]",
"      ,CPMT_packages.[OMS_Collection_Partner_Name]",
"      ,CPMT_payments.[OMS_Payment_No]",
"      ,CPMT_payments.[OMS_Payment_Reference]",
"      ,CPMT_payments.[OMS_Source_Provider]",
"      ,CPMT_payments.[OMS_Bank_Account]",
"      ,CPMT_payments.[OMS_Payment_Amount]",
"      ,CPMT_payments.[OMS_Charges_Amount]",
"      ,CPMT_payments.[OMS_Payment_Charges_Reconciled_Amount]",
"      ,CONVERT(date, CPMT_payments.[OMS_Payment_Date]) AS 'OMS_Payment_Date'",
"  FROM [" + DB + "].[dbo].[V_RPT_SOI] soi",
"  LEFT JOIN (SELECT * FROM [" + DB + "].[fdw].[Dim_Company] WHERE [Flg_In_Conso_Scope] = 1) comp",
"         ON soi.[ID_Company] = comp.[Company_Code]",
"  LEFT JOIN (SELECT [ID_Company],[OMS_Package_No],[JPay_transaction_ID],[JPay_Merchant_order_ID]",
"               FROM [" + DB + "].[dbo].[RPT_CASHREC_PACKAGES]",
"              WHERE [OMS_Package_Delivery_Date] >= " + S,
"                AND [OMS_Package_Delivery_Date] <  DATEADD(MONTH, +1, " + E + ")",
"                AND [OMS_Collection_Partner] = 'JumiaPayPost'",
"                AND [ID_Company] IN (" + coList + ")) cashrec",
"         ON soi.[ID_COMPANY] = cashrec.[ID_Company] AND soi.[PACKAGE_NUMBER] = cashrec.[OMS_Package_No]",
"  LEFT JOIN (SELECT [ID_Company],[Order_Nr],[OMS_Source_Provider],[OMS_Pre_Payment_Amount]",
"               FROM [" + DB + "].[dbo].[RPT_CUSTOMER_PRE_PAYMENTS]",
"              WHERE [OMS_Finance_Verified_Date] >= DATEADD(MONTH, -2, " + S + ")",
"                AND [ID_Company] IN (" + coList + ")) prepayments",
"         ON soi.[ID_COMPANY] = prepayments.[ID_Company] AND soi.[ORDER_NR] = prepayments.[Order_Nr]",
"  LEFT JOIN (SELECT [ID_Company],[OMS_Package_No],[OMS_Packlist_No],[OMS_Package_Amount_Received]",
"                   ,[OMS_Payment_Method_Confirmed],[OMS_Last_Mile],[OMS_Collection_Partner_Name],[OMS_ERP_Name]",
"               FROM [" + DB + "].[dbo].[RPT_PACKLIST_PACKAGES]",
"              WHERE [ID_Company] IN (" + coList + ")",
"                AND [OMS_Delivery_Date] >= " + S,
"                AND [OMS_Delivery_Date] <  DATEADD(MONTH, +1, " + E + ")",
"                AND [OMS_Packlist_Status] <> 'deleted') CPMT_packages",
"         ON soi.[ID_COMPANY] = CPMT_packages.[ID_Company] AND soi.[PACKAGE_NUMBER] = CPMT_packages.[OMS_Package_No]",
"  LEFT JOIN (SELECT [ID_Company],[OMS_Packlist_No],[OMS_Payment_No],[OMS_Payment_Reference],[OMS_Source_Provider]",
"                   ,[OMS_Bank_Account],[OMS_Payment_Amount],[OMS_Charges_Amount],[OMS_Payment_Charges_Reconciled_Amount]",
"                   ,[OMS_Payment_Date],[OMS_Packlist_Status]",
"               FROM [" + DB + "].[dbo].[RPT_PACKLIST_PAYMENTS]",
"              WHERE [ID_Company] IN (" + coList + ")",
"                AND [OMS_Payment_Date] >= " + S,
"                AND [OMS_Packlist_Status] <> 'deleted') CPMT_payments",
"         ON CPMT_packages.[ID_Company] = CPMT_payments.[ID_Company]",
"        AND CPMT_packages.[OMS_Packlist_No] = CPMT_payments.[OMS_Packlist_No]",
" WHERE soi.[FLG_IS_DELIVERED] = 1",
"   AND soi.[DELIVERED_DATE] >= " + S,
"   AND soi.[DELIVERED_DATE] <  " + E,
"   AND soi.[ID_COMPANY] IN (" + coList + ")",
"   AND CONCAT(soi.[ID_COMPANY], soi.[COD_OMS_SALES_ORDER_ITEM]) IN (" + keyList + ")"
  ].join('\n');
}

/* ================================ QUERY 2 ================================ *
 * PAY_DWH. Wallet-transfer + transaction detail for the JumiaPay references built
 * from query 1. Same inlined-period rule; keyed by concat(isocode, cod_order_nr). */
function flowBQuery2_(refs, p) {
  var S = "'" + p.fyStart + "'", E = "'" + p.fyEnd + "'";
  var refList = refs.map(sqlLiteral_).join(',') || "''";
  return [
"SELECT CONCAT(Country.[isocode], Main.[cod_order_nr]) AS 'UniqueReference'",
"      ,Country.[isocode]",
"      ,Main.[cod_order_nr]",
"      ,Transactions.[retrieval_reference_nr]",
"      ,Gateways.[Gateway]",
"      ,Providers.[dsc_payment_provider]",
"      ,Main.[creation_datetime]",
"      ,Transactions.[amount] AS 'Amount_Transactions'",
"      ,Main.[mtr_amount]     AS 'Amount_Merchants'",
"  FROM [PAY_DWH].[pay].[f_merchant_wallet_transfer] AS Main",
"  LEFT JOIN (SELECT [sk_country],[isocode],[country],[currency] FROM [PAY_DWH].[dbo].[d_country]) AS Country",
"         ON Country.[sk_country] = Main.[sk_country]",
"  LEFT JOIN (SELECT * FROM [PAY_DWH].[pay].[f_transactions]",
"             WHERE [sk_transaction_status] = 3 AND [type] = 'Authorization'",
"               AND created_at >= DATEADD(MONTH, -2, " + S + ")",
"               AND created_at <  DATEADD(MONTH, +1, " + E + ")) AS Transactions",
"         ON Transactions.[sk_country] = Main.[sk_country]",
"        AND Transactions.[fk_wallet_purchase] = Main.[fk_wallet_purchase]",
"  LEFT JOIN (SELECT * FROM [PAY_DWH].[pay].[d_gateway]) AS Gateways",
"         ON Gateways.[sk_gateway] = Transactions.[sk_gateway]",
"  LEFT JOIN (SELECT * FROM [PAY_DWH].[pay].[d_payment_provider]) AS Providers",
"         ON Providers.[cod_country] = Main.[sk_country]",
"        AND Providers.[sk_payment_provider] = Transactions.[sk_payment_provider]",
" WHERE Main.[sk_acc_transfer_type] = 16",
"   AND Main.[creation_datetime] >= DATEADD(MONTH, -2, " + S + ")",
"   AND Main.[creation_datetime] <  DATEADD(MONTH, +1, " + E + ")",
"   AND CONCAT(Country.[isocode], Main.[cod_order_nr]) IN (" + refList + ")"
  ].join('\n');
}
