# Audit Requests Manager — project context

Internal Jumia FinOps app (UI title: **"Audit Samples Manager"**) to manage external-auditor
**sampling requests** end to end: intake a sample → enrich it → route each sampled item ("**sample**")
to the evidence ("**tasks**") a Preparer must collect → assign preparers → track collection →
review (with an AI pre-check) → audit → close/export to the auditors. Built to grow one **business
flow** at a time. (Terminology: user-facing UI says "sample" for a sampled item and "task" for a
required evidence item; the data layer still calls them `Sample_Lines` rows and `Assignments`.)

**Current state (2026-09-11):** the full lifecycle is **in production** for **Flow A** (Marketplace
revenues / COGS by RING transaction, single query) and **Flow B** (Cash Anchor, two-stage query; a real
request is in flight). **Flow C** (Marketplace revenues / COGS by **sales-order item**, N-stage queries +
system reconciliation tasks) is **built and pushed, awaiting `setup()` + `seedFlowC()` + a first real run**.
Everything new is additive — Flow A/B code paths are unchanged.

## Stack
- **Google Apps Script** (V8, synced with `clasp`). Server is split by concern: `Code.js` (enrichment
  engine), `Db.js` (data layer), `Config.js` (SCHEMA/PROP/ROLES), `Setup.js` (provisioning/seed),
  `Request.js`, `Assign.js` (assignment + status rollup), `Prepare.js` (preparer/My tasks),
  `Review.js` (review/audit/AI/export), `Gemini.js` (AI client), `Flows.js` (registry), `FlowA.js`,
  `FlowB.js`. `Index.html` = single-file client UI; `appsscript.json` = manifest.
- Data plane: **Google Sheets** (state), **Drive** (app-mediated evidence files, owned by the deployer),
  Gmail + time-driven triggers (notifications/reminders — not yet built). Internal users live in Jumia
  Google Workspace.
- **Enrichment** comes only from the **FinRec SQL gateway** (read-only, file-based). Apps Script never touches SQL Server directly.
- **AI evidence pre-check**: Gemini via Generative Language API (`Gemini.js`). The `GEMINI_API_KEY`
  Script Property **MUST be paid-tier** — confidential audit evidence is sent to the model, so free-tier
  (trains on data) is never acceptable. See the `ai-evidence-check` memory.

## Core design principle
A business flow's **workflow is configuration, not code**: its metadata (`Flows`), selectable periods
(`Periods`), and routing rules (`Routing`: sample attribute → required evidence → responsible role) are all
Config-sheet rows. The two things config can't express — the enrichment **SQL** and how to **read a result
row** (into line fields + the routing `facts`) — live in a small per-flow **module** (see `FlowA.js`),
registered in `Flows.js`.

**Adding a flow** = add its `Flows`/`Periods`/`Routing` rows + write one module
(`{ id, sampleKey, buildQuery(items, p), mapRow(cell) }`) + register it in `Flows.js`. The rest of the engine
(assignment, evidence, review/audit, storage, IPE) is flow-agnostic. Optional module hooks (used by Flow B —
Cash Anchor): `parseSample(text)` to turn the paste box into sample items with a `.key` (default = one token
per line), and `stage2 { server, database, refOf(mapped), keyCol, buildQuery(refs, p), mapRow2(cell), merge(line,row2) }`
for a **dependent second query** (Flow B: query 1 on `AIG_Nav_Jumia_Reconciliation`/server `finrec` → query 2 on
`PAY_DWH`/server `pay`). The gateway job needs a `server` field (`finrec` default | `pay`); a db only runs on its own server.
enrich() runs both stages in one execution, resumable (persists both stage ids under one signature). Flow-specific
line fields the standard `Sample_Lines` columns don't cover are stored as `detail_json` (+ a `subpopulation`
column). Flow-shaped views (assign detail, review/preparer panels) still need per-flow tweaks when columns differ.

**N-stage hook (Flow C) — `stages: [...]`** (separate from `stage2`, which Flow B keeps): each stage =
`{ tag, label, server, database, dependsOn?[tags], refs(mapped, ctx), buildQuery(refs, qp, ctx), fold(csv, cellFactory, mapped, ctx) }`.
`runStages_` (Code.js) runs them in **waves** — a stage is submitted as soon as its dependencies have landed
(none → right after stage 1, so independent queries run in parallel on the gateway), all outstanding jobs are
polled together, every gateway id persists under the run signature (timeout → **resume**, never resubmit), a
stage whose `refs()` is empty is skipped and counts as landed. Module lists stages in dependency order. Then
`mod.finalize(mapped, ctx)` (checks + routing facts) → routing → persist. Per-stage CSVs are stored and recorded
in `Requests.stages_json`; the IPE carries `stages[]` (query + SHA-256 each). `ctx.data` is the module's scratch.

**System tasks** (Flow C): a Routing row whose `responsible` is the **Reviewer role** marks a task whose evidence
the app produces itself. `persistRun_` assigns it to the request's reviewer, creates it **already `submitted`**
with `detail_json = { kind:'system', checks[], verdict, summary }` and `ai_verdict` preset (deterministic — never
sent to Gemini), attaches the module's `evidenceWorkbook` xlsx (one per request, built by `buildXlsxFile_`) as
its Evidence, and opens the sample at `pending_review`. `enrich()` refuses to run a `requiresReviewer` flow
without a reviewer. System tasks are hidden from My tasks / Assign, cannot be returned by the reviewer or
withdrawn, and an auditor return sends them back to the reviewer (`submitted`). `PER_TASK_SUBPOPS`
(Config.js, mirrored as `PER_TASK_SUBS` in the client) = Cash & POS + Retail + Marketplace.

## Roles
Administrator, Preparer, Reviewer, Auditor — assigned by email, restricted to `@jumia.com`.
Segregation of duties: Preparer collects + submits; Reviewer reviews/returns/submits to audit;
Auditor returns/closes; Administrator configures and runs enrichment/assignment.

## Lifecycle & status model
Sample (`Sample_Lines.status`): `open → assigned → in_progress → pending_review → pending_audit → closed`
(+ `not_found`). Task (`Assignments.status`): `pending → assigned → in_progress → submitted → reviewed →
accepted`. `updateLineAssignmentRollup_` (Assign.js) derives the sample status from its tasks across the
**whole lifecycle**.

**Per-task independence (Flow B Cash & POS):** a sample can fan out into many tasks (one Proof-of-payment
per payment). Reviewer/auditor actions gate on the **TASK** status, not the sample — returning one payment
must never block its siblings. For `subpopulation === 'Postpaid - Cash & POS'` the rollup is per-task:
`pending_review` if ANY task submitted, `pending_audit` if all reviewed, `closed` if all accepted. The
Review/Audit request table "Pending" column + "Pending my action" filter are **task-based** (a sample with
3 tasks where only 1 is on your desk counts that 1). Do NOT reintroduce a rule that requires all of a
sample's tasks to be on-desk before acting — that was tried and reverted.

**AI visibility segregation:** the reviewer sees the AI verdict/summary and may override it with a comment;
the **auditor never sees any AI output** — only reviewer comments addressed to them (stored on
`Assignments.notes`, surfaced via `reviewDetail`). The reviewer's override comment is saved on submit and
shown in Sample history.

**Comment channels (same segregation shape):** the Preparer may add an optional comment when submitting a
task (`Assignments.preparer_note`, set by `submitAssignment(id, note)`) — e.g. flagging a known variance +
its justification up front. It reaches the **Reviewer only** (`reviewDetail` sends `preparer_note` for the
`review` stage only; shown in both line and per-payment review windows); the **Auditor never sees it** — the
reviewer transcribes/edits/ignores it into their own note-to-auditor. Preparers can also **export their tasks
to Excel** (`exportMyTasks`, Prepare.js — one-tab xlsx checklist, Export button in the My-tasks toolbar).

**Auditor export** (`auditExport(requestId)`, Review.js; Export button in the Audit request detail): builds
a temp Google Sheet → exports `.xlsx` (tabs: Samples & Tasks enriched / IPE with queries + SHA-256 + checks /
Evidence index), then **assembles the export as real files in a Drive folder** `Exports/{reqId}/{name} (stamp)/`
— the xlsx at the root, `Extraction/` (gateway CSVs + SOX xlsx) and `Evidence/<soi>/<task>/<file>` copied
**Drive-side via `makeCopy`**, one file at a time (no in-memory aggregate, so no size ceiling). The folder is
**auto-shared** (reader) with the current user + the request's reviewer/auditor via Drive REST
`permissions.create` (`supportsAllDrives`, `shareFileWith_`), and the client shows its link. A convenience
one-click **ZIP download is produced only when the evidence totals ≤30 MB** (`Utilities.zip` + base64 return
have a ~50 MB blob cap); larger exports are delivered by the Drive link alone — it never throws on size.
Return shape: `{ folderUrl, folderName, fileCount, missing, totalMb, shared[], download|null }`. Uses existing
scopes only (full-drive, already pulled in by DriveApp). **Do NOT revert to zipping everything in memory** —
that was the 70 MB failure (and the fragile `zip.copyBlob()` left an empty Exports folder).

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
  `output_name`, `server` (`finrec` default | `pay`), `database`, `evidence`, `contract_version`, `requested_by`.
  Server↔db: `finrec` → `AIG_Nav_DW` / `AIG_Nav_Jumia_Reconciliation` / `STG_AIG_NAV_JUMIA_REC`; `pay` → `PAY_DWH`.
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

## Flow B — Cash Anchor (built)
Two-stage enrichment: Q1 on `AIG_Nav_Jumia_Reconciliation` (server `finrec`) classifies each
sales-order-item into a **subpopulation** (Prepaid/Postpaid × JumiaPay / Voucher / Cash & POS / etc.);
Q2 on `PAY_DWH` (server `pay`) enriches the JumiaPay subpopulations up to the wallet transfer. Composite
sample key `concat(ID_COMPANY, COD_OMS_SALES_ORDER_ITEM)`. Routing sends each subpopulation to one of two
owner teams as **document-slot tasks** (Voucher/JumiaPay = one task with several named upload slots;
Cash & POS = one Proof-of-payment task **per payment**, fanned via `mapGroup`). Full detail (queries,
subpopulations, owners, phase-by-phase build log) is in the **`flow-b-cash-anchor` memory**.

## Flow C — Marketplace revenues / COGS by sales-order item (built, not yet seeded)
Input = `ID_COMPANY` + `COD_OMS_SALES_ORDER_ITEM` (Flow B's paste format). **Stage 1** `RPT_SOI` (the base
TABLE — `V_RPT_SOI` lacks `IS_MARKETPLACE`) → unit price + Retail/Marketplace split (`subpopulation`).
**Retail**: NAV `Posted Sales Invoices` + `Posted Sales Invoice Line` (`AIG_Nav_DW`, keyed on
`id_company` + `No_`/`Document No_` = `PACKAGE_NUMBER`; sampled line = `Line No_` = `COD_BOB_SALES_ORDER_ITEM`);
checks: line amount incl. VAT = unit price; header = Σ lines. **Marketplace**: hop 1 `ringcodes` (item → statement
code, + PO/down payment for those few items — the text `notes` join lives HERE, not on the big query), then in
parallel hop 2 `ring` (all transactions of those statements: MPL type via the insurance join, payout, balances)
and `gl` (NAV `G_L Entries`, account **18314**, `Document No_` = `'IS' + code.slice(2)`, source PURCHASES);
checks: Item Price Credit = unit price; opening + Σ by `Nav_Type` = closing; NAV 18314 = −REVENUES. Tolerance
`FLOWC_TOLERANCE = 5` (|diff| ≤ 5 → match; else variance — verdict `uncertain`, never reject). Then Flow A's
task rules on the marketplace items (advance → contract + down-payment; regular → PoP, or VC screenshot when
unpaid; same insurance-join method as Flow A). Routing seeded by `seedFlowC()` / `reseedFlowCRouting()`.
**Query performance rules (measured on the gateway):** every WHERE names the sampled companies
(`ID_Company IN (…)`) **and** a per-company key list — RING/NAV indexes all lead with the company column;
statement/NAV windows are bounded by hop-1 dates (`flowCWindow_`: RING −1/+1 month, NAV −1/+3 months — NAV's
index leads on `Posting Date, Chart of Accounts No_`). Literal statement codes beat an `IN (subquery)` (412 s vs
605 s); the unbounded literal shapes ran 5–7 min, so expect the first executions to return *pending* and resume.
Evidence = ONE workbook per request (`Summary - Retail`, `Summary - MPL`, raw `SOI` / `NAV_PostedSalesInvoices` /
`NAV_PostedSalesInvoiceLine` / `RING` / `NAV` tabs) attached to every system task. Deep detail in the
**`flow-c-revenue-soi` memory**.

## Roadmap / next
- **Flow C first real run**: `setup()` (adds `Requests.stages_json`) → `seedFlowC()` → run the H1 2026 sample on
  the `/dev` deployment → check the gateway timings + the workbook → then promote to prod.
- **Pilot** of Flows A/B continues in production.
- Not yet built: Gmail notifications + reminders (default provisional: due +1 week, daily, escalate at
  due date) and their time-driven triggers.
- Possible next: refine Flow B after first real Q2 run (a column tweak may surface), or add a new flow
  (adding a flow = Flows/Periods/Routing rows + one module + register in Flows.js).

## Dev workflow
- **Deploy**: `clasp push --force` MUST run under Node **v24.16.0** (system 24.17.0 breaks clasp):
  `export PATH="/c/Users/joao.araujo/node-v24.16.0:$PATH" && clasp push --force`. Then redeploy the web app.
  Commit with `Co-Authored-By: Claude Opus 4.8`. Repo: `github.com/JAraujoJM/audit_sample_manager`.
- **After a schema change** (new SCHEMA columns): run `setup()` once in the Apps Script editor, then the
  relevant `reseed*()` (e.g. `reseedFlowBRouting()`, `seedFlowC()`). Client-only changes just need a redeploy.
- **Prod vs dev**: `clasp push` updates the project (= the `@HEAD` `/dev` deployment). The prod `/exec` URL is a
  **versioned deployment** (`@NN`) — promote with
  `clasp deploy -i <deploymentId> -d "<note>"` only when asked; it changes what live users run.
- **Heavy SQL**: the FinRec MCP times out on queries over ~30 s — benchmark through the gateway itself
  (drop a job JSON into `FinRec Outside Teleport/Requests_Pending`, poll `Responses/`, read `Logs/audit.jsonl`
  for `duration_seconds`). The gateway allows 45 min of SQL; the app polls 5.5 min per execution and resumes.
- **Verify before push**: syntax-check Index.html inline scripts via `node -e` (`vm.Script` per `<script>`)
  and `node --check` on `.js` files; browser-verify by concatenating a scratchpad mock (a
  `window.google.script.run` shim) + Index.html into `_preview_ai.html` **inside the project folder**
  (files outside it render as static snapshots — CSP blocks scripts), navigate `file://`, drive with
  javascript_tool, then delete `_preview_ai.html` before push.
- UI must stay Apple-minimal and consistent across views (see `ui-design-apple-minimal` memory).
