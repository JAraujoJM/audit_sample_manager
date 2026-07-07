/**
 * Flow A — Marketplace revenues / COGS.
 * ------------------------------------
 * The CODE half of a flow (see Flows.js for the pattern). Everything config can
 * express — routing rules, periods, evidence types, responsible roles — lives in
 * the Config sheet; this module owns only the two things it can't:
 *   • buildQuery(docs, p) — the enrichment SQL
 *   • mapRow(cell)        — how to read a result row into the app's line fields
 *                           plus the `facts` the Routing rules match on
 *
 * QUERY RULES (do not regress):
 *  - One SELECT, no stacked statements; dates are inlined literals (the gateway
 *    rejects DECLARE). `p.fyStart`/`p.fyEnd` come from the selected period.
 *  - Build the IN (...) list with sqlLiteral_ (external input).
 *  - Keep the raw ON-driven joins so the sample drives an index seek — never
 *    revert to derived-table joins that scan a full year (the >10-min slowdown).
 *  - full mode's down-payment join is on a text `notes` column — the one to watch.
 */
function flowA_() {
  return {
    id: 'flowA',
    sampleKey: 'Transaction_No',            // CSV column the sample document numbers match on

    buildQuery: function (docs, p) {
      return p.queryMode === 'full' ? flowAQueryFull_(docs, p) : flowAQueryLean_(docs, p);
    },

    /** cell(name) -> value for one resolved row. Returns line fields + routing facts. */
    mapRow: function (cell) {
      var mpl = cell('MPL type'), paid = cell('Paid_At_Date');
      return {
        company:         cell('ID_Company'),
        vendor:          cell('Vendor_Name'),
        mpl:             mpl,
        paid_at:         paid,
        statement:       cell('Payout_Statement_Code'),
        amount:          cell('Transaction_Amount'),
        closing_balance: cell('Statement Closing Balance'),
        po:              cell('PO_NUMBER'),
        downpay:         cell('Down Payment Amount'),
        facts: {
          mpl:  /advance/i.test(String(mpl)) ? 'advance' : 'regular',
          paid: (paid && String(paid).trim() !== '') ? 'yes' : 'no'
        }
      };
    }
  };
}

/**
 * LEAN — routing only. The sample filters the base table first; the two joins
 * needed for the decision (insured = MPL type, payout = Paid_At_Date) are RAW
 * tables with their conditions in the ON clause, so the join key drives an index
 * seek instead of materialising a full year per join.
 */
function flowAQueryLean_(docs, p) {
  var inList = docs.map(sqlLiteral_).join(',');
  var DATABASE = p.database, FY_START = p.fyStart, FY_END = p.fyEnd;
  return [
"SELECT t.[ID_Company]",
"      ,t.[Transaction_No]",
"      ,t.[Created_Date]",
"      ,t.[Vendor_Short_Code]",
"      ,t.[Vendor_Name]",
"      ,CASE WHEN insured.Target_code IS NOT NULL THEN 'MPL advance' ELSE 'Regular' END AS [MPL type]",
"      ,t.[Transaction_Type]",
"      ,t.[Transaction_Amount]",
"      ,t.[Payout_Statement_Code]",
"      ,CONVERT(date, payouts.[Paid_At_Date]) AS [Paid_At_Date]",
"      ,payouts.[Payout_Method]",
"      ,payouts.[Payment_Reference]",
"  FROM [" + DATABASE + "].[dbo].[RPT_TRANSACTIONS_SELLER] t",
"  LEFT JOIN [" + DATABASE + "].[RING].[RPT_TARGET_VARIABLE] insured",
"         ON insured.Company_ID  = t.ID_Company",
"        AND insured.Target_code = t.Vendor_Short_Code",
"        AND insured.[type]      = 'SELLER'",
"        AND insured.Variable    = 'Damaged Items Insurance - Active'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_PAYOUT] payouts",
"         ON payouts.ID_Company              = t.ID_Company",
"        AND payouts.Account_Statement_Number = t.Payout_Statement_Code",
"        AND payouts.Partner_Type            = 'SELLER'",
"        AND payouts.Paid_At_Date           >= '" + FY_START + "'",
"  WHERE t.[Created_Date] >= '" + FY_START + "'",
"    AND t.[Created_Date] <  '" + FY_END + "'",
"    AND t.[Transaction_No] IN (" + inList + ")"
  ].join('\n');
}

/**
 * FULL — adds PO number, down-payment and statement balances for the evidence
 * pack, in the same fast ON-driven shape. The down-payment join is on a text
 * `notes` column (dp.notes = soi.PO_NUMBER); if it's unindexed this is the join
 * to watch, so keep this mode for when you actually need those columns.
 */
function flowAQueryFull_(docs, p) {
  var inList = docs.map(sqlLiteral_).join(',');
  var DATABASE = p.database, FY_START = p.fyStart, FY_END = p.fyEnd;
  return [
"SELECT t.[ID_Company]",
"      ,t.[Transaction_No]",
"      ,t.[Created_Date]",
"      ,t.[Vendor_Short_Code]",
"      ,t.[Vendor_Name]",
"      ,CASE WHEN insured.Target_code IS NOT NULL THEN 'MPL advance' ELSE 'Regular' END AS [MPL type]",
"      ,t.[Transaction_Type]",
"      ,t.[Transaction_Amount]",
"      ,t.[Payout_Statement_Code]",
"      ,CONVERT(date, payouts.[Paid_At_Date]) AS [Paid_At_Date]",
"      ,payouts.[Payout_Method]",
"      ,payouts.[Payment_Reference]",
"      ,soi.[PO_NUMBER]",
"      ,st.[Start_Date]      AS [Statement Start Date]",
"      ,st.[End_Date]        AS [Statement End Date]",
"      ,st.[Opening_Balance] AS [Statement Opening Balance]",
"      ,st.[Closing_Balance] AS [Statement Closing Balance]",
"      ,dp.[Transaction_No]     AS [Down Payment Transaction]",
"      ,dp.[Transaction_Amount] AS [Down Payment Amount]",
"  FROM [" + DATABASE + "].[dbo].[RPT_TRANSACTIONS_SELLER] t",
"  LEFT JOIN [" + DATABASE + "].[RING].[RPT_TARGET_VARIABLE] insured",
"         ON insured.Company_ID  = t.ID_Company",
"        AND insured.Target_code = t.Vendor_Short_Code",
"        AND insured.[type]      = 'SELLER'",
"        AND insured.Variable    = 'Damaged Items Insurance - Active'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_PAYOUT] payouts",
"         ON payouts.ID_Company              = t.ID_Company",
"        AND payouts.Account_Statement_Number = t.Payout_Statement_Code",
"        AND payouts.Partner_Type            = 'SELLER'",
"        AND payouts.Paid_At_Date           >= '" + FY_START + "'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_SOI] soi",
"         ON soi.ID_COMPANY              = t.ID_Company",
"        AND soi.COD_OMS_SALES_ORDER_ITEM = t.OMS_ID_Sales_Order_Item",
"        AND soi.DELIVERED_DATE          >= '" + FY_START + "'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_TRANSACTIONS_SELLER] dp",
"         ON dp.ID_Company       = t.ID_Company",
"        AND dp.[notes]          = soi.[PO_NUMBER]",
"        AND dp.Transaction_Type = 'Down Payment'",
"        AND dp.[Created_Date]  >= '" + FY_START + "'",
"  LEFT JOIN [" + DATABASE + "].[dbo].[RPT_SELLER_STATEMENTS_PAYOUT] st",
"         ON st.ID_Company             = t.ID_Company",
"        AND st.ID_Transaction_Statement = t.ID_Account_Statement",
"        AND st.[Start_Date]         >= '" + FY_START + "'",
"  WHERE t.[Created_Date] >= '" + FY_START + "'",
"    AND t.[Created_Date] <  '" + FY_END + "'",
"    AND t.[Transaction_No] IN (" + inList + ")"
  ].join('\n');
}
