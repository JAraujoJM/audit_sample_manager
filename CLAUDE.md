# Audit Requests Manager — project context

Internal Jumia FinOps app to manage external-auditor **sampling requests** end to end:
intake a sample → enrich it → route each line to the evidence a Preparer must collect →
track collection → report status to the auditors. Built to grow one **business flow** at a time.

This repo currently holds the **Flow A proof of concept** (Marketplace revenues / COGS):
paste document numbers, enrich them via the FinRec SQL gateway, and show the required action.

## Stack
- **Google Apps Script** (synced with `clasp`). Server is split by concern (`Code.gs` engine, `Db`, `Auth`,
  `Setup`, `Request`, `Assign`, `Prepare`, `Review`, `Flows`/`FlowA` flow modules); `Index.html` = client UI;
  `appsscript.json` = manifest.
- Target data plane for the full build: **Google Sheets** (state), **Drive** (evidence files), **Gmail** (notifications), time-driven triggers (reminders). Internal users live in Jumia Google Workspace.
- **Enrichment** comes only from the **FinRec SQL gateway** (read-only, file-based). Apps Script never touches SQL Server directly.

## Core design principle
A business flow's **workflow is configuration, not code**: its metadata (`Flows`), selectable periods
(`Periods`), and routing rules (`Routing`: sample attribute → required evidence → responsible role) are all
Config-sheet rows. The two things config can't express — the enrichment **SQL** and how to **read a result
row** (into line fields + the routing `facts`) — live in a small per-flow **module** (see `FlowA.js`),
registered in `Flows.js`.

**Adding a flow** = add its `Flows`/`Periods`/`Routing` rows + write one module
(`{ id, sampleKey, buildQuery(docs, p), mapRow(cell) }`) + register it in `Flows.js`. The rest of the engine
(assignment, evidence, review/audit, storage, IPE) is flow-agnostic. (The Request view's results table in
`Index.html` is still flow-shaped — adjust it if a new flow surfaces different columns.)

## Roles (full build)
Administrator, Preparer, Reviewer, Auditor — assigned by email, restricted to `@jumia.com`.
Segregation of duties: Reviewer submits, Auditor returns/closes; Administrator configures and runs enrichment/assignment.

## Flow A routing rules (the decision the engine encodes)
Two facts decide each line:
1. **MPL type** — `MPL advance` if the seller carries *Damaged Items Insurance – Active*
   (`RING.RPT_TARGET_VARIABLE`), else `Regular`.
2. **Statement paid status** — a line is **Unpaid** when `Paid_At_Date` IS NULL, else **Paid**.

| MPL type | Statement | Required evidence (Preparer) |
|----------|-----------|------------------------------|
| Regular  | Paid      | Proof of payment |
| Regular  | Unpaid    | Vendor Center (VC) screenshot showing *Unpaid* |
| MPL advance | (n/a)  | Consignment contract + down-payment proof |

Sample key: the auditor's `Document No.` maps to `Transaction_No`.
De-dup key: fiscal year (`Posting Date`) + `Id_Company` + `Document No.`.
`Sample type` (Conso/Stat) is a tag only — no routing impact.

## Gateway contract (enrichment)
- Shared Drive base folder ID is set in `Code.gs` (`BASE_FOLDER_ID`); `app_id = audit_request_manager`.
- Submit: write `{requestId}.json` to `Requests_Pending/` with `query`, `request_id`, `app_id`,
  `output_name`, `database`, `evidence`, `contract_version`, `requested_by`.
- Poll: CSV appears in `Responses/` as `{requestId}_*.csv`; failures land in `Requests_Failed/`
  (reason in `Logs/audit.jsonl`). CSV is UTF-8 **with BOM** — strip it before parsing.
- `evidence: true` makes the gateway also produce a SOX evidence workbook for the run.

## Execution model (important constraints)
- **Single-phase**: submit + poll within one Apps Script execution (~6-min cap; poll budget is 5.5 min).
- **Safe retry**: the `requestId` is persisted; if an execution times out, the next run with the same
  document set **re-polls that id instead of resubmitting** (no duplicate jobs / orphaned results).
  Do NOT change this to blind resubmit.
- Gateway answers in seconds once warm; the first call after a long idle can be slow — retry resumes it.

## Query rules (do not regress)
- Per-flow SQL lives in the flow module (`FlowA.js`), built via `buildQuery_(flowId, docs, p)`.
- `query_mode` (from the `Flows` row): `lean` (routing only — fast) or `full` (adds PO / down-payment /
  statement balances).
- Dates are **inlined literals** from the selected period (`p.fyStart`/`p.fyEnd`) — the gateway rejects
  stacked statements, so no `DECLARE @startdate ...;`.
- Build the `IN (...)` list with `sqlLiteral_` (doubles single quotes) — sample values are external input.
- **Never** revert to the old derived-table shape (`LEFT JOIN (SELECT ... WHERE date >= ...)`); it scans a
  full year per join and was the >10-min slowdown. Keep raw ON-driven joins so the sample drives a seek.
- In `full` mode, the down-payment join is on a text `notes` column — the one to watch if it ever drags.

## IPE / SOX
The app surfaces an IPE panel: completeness/accuracy checks, the exact SQL executed, and the **SHA-256**
of the returned CSV (computed over raw bytes, BOM included). Keep this evidence-grade and honest.

## Roadmap (not yet built)
Roles + Sheets-backed state (requests/sample lines/assignments/evidence/activity log), Preparer tracker,
Gmail notifications + reminders (default: due +1 week, daily, escalate at due date — provisional),
admin-only Drive evidence folder, optional Auditor read view. Flow B (collections) is on standby.

## Dev workflow
Deployment is currently manual copy-paste into the Apps Script editor until clasp login is resolved.
