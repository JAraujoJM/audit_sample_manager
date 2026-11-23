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
**16 Nov 2026:** Flows A, B, C are in production (prod = @43). **Flow D** (COGS by NAV value entry, one openquery to live
NAV) is **built and on `/dev`, awaiting `seedFlowD()` + a first real run** — see its section below.

**23 Nov 2026:** prod = **@50** (promoted on João's go): everything above plus the 23 Nov batch — logo, My-tasks export
follows the screen, JPay Order, auditor returns → reviewer, evidence visible to the auditor only after review, and the
living audit folder (`AuditFolder.js`). The living folder was promoted **before its first run on real Drive** — its first
real Export click is the live test. Versions 44–49 were created outside these sessions (no description): before the
promotion prod was already at @49, not @43 — check `clasp deployments` rather than trusting a version number written here.
Flow D is in the prod code but still needs `seedFlowD()` to be selectable.

## Stack
- **Google Apps Script** (V8, synced with `clasp`). Server is split by concern: `Code.js` (enrichment
  engine), `Db.js` (data layer), `Config.js` (SCHEMA/PROP/ROLES), `Setup.js` (provisioning/seed),
  `Request.js`, `Assign.js` (assignment + status rollup), `Prepare.js` (preparer/My tasks),
  `Review.js` (review/audit/AI/export), `Gemini.js` (AI client), `Flows.js` (registry), `FlowA.js`,
  `FlowB.js`, `FlowC.js`, `FlowD.js`, `AuditFolder.js` (the living audit folder), `Cache.js`, `Dashboard.js`.
  `Index.html` = single-file client UI; `appsscript.json` = manifest.
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

**Auditor return → REVIEWER (23 Nov 2026, João).** Most auditor returns are clarifications the reviewer answers alone, so a
return no longer goes to the preparer. `auditorReturnTask` (per-task flows): the task is `submitted` again with
`notes = 'Returned by auditor: …'`; files, AI result, preparer comment and `submitted_at` untouched. `auditorReturn`
(whole-sample flows — Flow A, Voucher, JumiaPay): its reviewed tasks are `submitted` again and the sample goes to
`pending_review` with the note on `Sample_Lines.note`, AI verdict kept. The reviewer then either **answers** — a note is
mandatory (`reviewerSubmit` / `reviewerSubmitTask` refuse an empty note while the stored note is an auditor return;
`isAuditorReturn_`) — or **passes it on** with the usual reviewer return (then it is a normal preparer task and a normal
review: the stored note is the reviewer's, so the next submit needs no note). While it is on the reviewer's desk the
preparer cannot withdraw it (`returnedByAuditor_`, `with_reviewer` on the My-tasks card). `reviewDetail(…,'review')` sends
`from_auditor` (task and sample) → amber "Returned by auditor" tag in the lists and windows. Nothing was migrated: tasks
an auditor returned before this change stay with their preparer; when resubmitted they still carry the auditor's note, so
the reviewer's answer is required for them too. The note prefixes are load-bearing (`isAuditorReturn_`, `auditorNote_`,
client `NOTE_PREFIX`) — do not reword them.

**The auditor gets evidence only after the reviewer's approval (23 Nov 2026).** One rule, `auditorSeesTask_(line, asg)`:
task `reviewed` / `accepted`; for whole-sample flows also a task still `submitted` on a sample that is `pending_audit` /
`closed` (older rows, optional evidence handed in later). It is applied **server-side in three places**: `reviewDetail(…,'audit')`
(no `files`, `files_hidden` flag, an unapproved app reconciliation is cut to `{kind:'system'}` — no checks), `getEvidenceFile`
(an Auditor is refused by evidence id) and `auditExport` (**whoever runs it, admins included**; held tasks stay listed with
their status, `notReady` in the result and in the `AUDIT_EXPORT` log). The audit payload's `note` also goes through
`auditorNote_` (auditor ↔ reviewer prefixes only — a reviewer's return to the preparer used to show under the thread).
Any new way for an auditor to reach a file must go through `auditorSeesTask_`.

**AI visibility segregation:** the reviewer sees the AI verdict/summary and may override it with a comment;
the **auditor never sees any AI output** — only reviewer comments addressed to them (stored on
`Assignments.notes`, surfaced via `reviewDetail`). The reviewer's override comment is saved on submit and
shown in Sample history.

**Comment channels (same segregation shape):** the Preparer may add an optional comment when submitting a
task (`Assignments.preparer_note`, set by `submitAssignment(id, note)`) — e.g. flagging a known variance +
its justification up front. It reaches the **Reviewer only** (`reviewDetail` sends `preparer_note` for the
`review` stage only; shown in both line and per-payment review windows); the **Auditor never sees it** — the
reviewer transcribes/edits/ignores it into their own note-to-auditor. Preparers can also **export their tasks
to Excel** (`exportMyTasks`, Prepare.js — one-tab xlsx, Export button in the My-tasks toolbar). Since 16 Nov 2026 it
carries **everything the card shows, one column per card field** (`myTasksTable_`: fixed columns, then the union of the
card fields of the task types the preparer actually has, then files uploaded / reviewer note / own comment), so the work can
be done offline. The field specs `CA_FIELDS_EXPORT_` mirror the client's `CA_FIELDS` label for label — **a field added to a
card must be added there too**. Cells are text (`@`) except the amount columns (`CA_NUM_EXPORT_`), which stay numbers.
**The export holds what the screen shows (23 Nov 2026):** the client passes its two filters — `exportMyTasks({ pendingOnly, company })`
("Pending my action" toggle = statuses `MY_ACTION_STATUSES_`, and the company dropdown added 18 Nov) — and the server applies
them; no argument = every task. A filter added to the My-tasks toolbar must be passed and applied there too.

**Comment thread (13 Nov 2026).** `Assignments.notes` / `Sample_Lines.note` keep only the LAST comment (each action
overwrites it), so an auditor who got a task back could not read why they had returned it. The review and audit windows
now show every comment, oldest first, latest in amber: `commentThread(lineId, stage)` (Review.js) rebuilds it from
`Activity_Log` (nothing to migrate — running requests show their past exchanges) using `THREAD_RULES_` (action → author,
label, and an **anchored regex that cuts the comment out of the log line**; a line that does not match is skipped — the
reviewer's log line starts with the AI verdict, so an unknown format must never be passed through). Cut server-side by
stage: `audit` = auditor ↔ reviewer only (auditor returns / closing notes, reviewer notes to the auditor); `review` adds
the reviewer's returns to the preparer and the preparer's comments. **If the text an action logs changes, update its regex
in `THREAD_RULES_`** (and never log a comment only in `notes`). Client: the window opens with the last note as before
(`threadSlot`), one call per sample (`loadThread`, reused until the sample's statuses/notes change) replaces it
(`mountThread`); a stored note that is not in the thread stays visible under it, and a preparer comment already in the
thread is not repeated above it. The stored columns and every action are unchanged. In prod since **@43** (13 Nov 2026).

**Auditor export = ONE living folder per request (23 Nov 2026, João; `AuditFolder.js`).** The auditors found the export
slow and `Exports/{reqId}/` filled with one dated folder per click. Now a request has a single audit folder
`Exports/{reqId}/{PBC ref} - audit export/`, created and shared (reader — clicker + the request's auditor(s) and reviewer,
`shareFileWith_`) on the **first** click on Export, then **kept up to date in the background**; the button only returns its
link and state (`auditExport` → `{ folderUrl, status: 'ready'|'updating', refreshedAt, fileCount, totalMb, done, total, notReady,
missing, missingFiles, shared, error }`; **no ZIP any more**), and the client follows a sync with `auditFolderStatus` (8 s poll).
The audit view shows the folder line without a click to whoever it is shared with (`reviewDetail(…,'audit').export_folder`).
- **Content**: the workbook at the root (same tabs as before + a last tab `Export status`), `Extraction/`, `Execution log/`
  (+ `jobs/`), `Sample list/`, `Evidence/<soi>/<task>/<file>`, `Reconciliation (system)/`. Evidence follows
  `auditorSeesTask_` only: copied in when the reviewer approves the task, **trashed again when the auditor returns it**
  (empty task folders pruned). Files are still copied Drive-side one at a time (`makeCopy`, no in-memory aggregate — **never
  go back to zipping in memory**, that was the 70 MB failure). The workbook is rebuilt only when everything it lists is in the
  folder, and **in place** (Drive REST media upload, same file id; if Drive refuses: new file, old one binned).
- **State**: script property `AFR_<reqId>` (folder id/url, `sig` = hash of everything the workbook shows and the folder holds,
  `complete`, `pending`, counts, `missing[]`, `shared[]`); a folder is *stale* when the hash of the current rows differs
  (`afSig_`) — so a missed notification can never leave it silently out of date. Manifest = new Data tab **`Export_Files`**
  (one row per file / folder placed; rows are never deleted, a removed file keeps its row with status `removed`; created on
  the first sync, in `UNCACHED_TABS_`). The heavy IPE inputs (`exportStaticBundle_`: re-hash of every CSV + the gateway log
  scan) are computed **once per extraction** and kept as `Exports/{reqId}/_audit_folder_extractions.json` (not in the shared
  folder); a re-extraction / file repair changes `afStaticSig_` and rebuilds them.
- **Background job**: time trigger `runExportSync_` (own handler — the AI pre-check trigger is untouched). Actions call
  `noteExportChange_()` **after** their writes (end of `updateLineAssignmentRollup_`, and the four whole-sample actions in
  Review.js); it does nothing while no folder exists (`AF_ANY`). First change → ~1 min later; background syncs are ≥ 5 min apart
  (`AF_MIN_GAP_MS_` — trigger runtime is a daily quota shared with the AI checks); an Export click schedules one within seconds.
  The handler clears `AF_SYNC_AT` **before** reading, holds the script lock (one sync at a time), works `AF_BUDGET_MS_` (4.5 min)
  and reschedules itself until complete ("n of m files so far"). Opening the audit view of a stale folder also schedules a sync.
- **Safety nets**: a killed run (or a manifest that could not be written) leaves `AFRUN_<reqId>` → the next run looks in Drive
  before copying (no duplicates); a scheduled sync that did not fire within 3 min, or no trigger scope → the next Export click
  syncs inline; a file that cannot be copied is listed in the state, the `Export status` tab, the `AUDIT_FOLDER_SYNC` log and a
  red box on screen (**never swallow a failed copy**) and retried on every click; a folder binned in Drive → the next click starts
  a new one. Old dated folders are never touched. Admin, in the editor: `auditFolderStates()`, `auditFolderSyncNow()`,
  `auditFolderForget(reqId)`.
- A new write path that changes what the workbook shows must end with `noteExportChange_()`; a change to the workbook layout =
  bump `AF_VERSION_` (every folder then rebuilds its workbook). The package builders stay in Review.js (`exportPlan_`,
  `buildExportWorkbook_`, `exportStaticBundle_`, `exportMethodology_`).

**IPE package (Forvis Mazars ask, 20 Oct 2026 — thread "Jumia FY26 - Tool testing").** The audit folder also carries:
- **IPE tab: ONE ROW PER EXTRACTION** (`exportExtractions_`: stage 1, Flow B stage 2, every `stages_json` query) —
  export file ↔ original gateway filename (the stored copy keeps the gateway's name) ↔ gateway request_id, server,
  database, completion time, duration, row count and SHA-256 three ways (gateway log / app at extraction / file in
  the package, re-hashed at export), evidence-xlsx hash, query hash, `Integrity` Pass/Flag (`extractionIntegrity_`),
  SQL as executed. The gateway's `query_sha256` = SHA-256 of the job's UTF-8 query, `request_sha256` = SHA-256 of
  the job file, `row_count` = CSV data rows (verified on REQ_bc265bfa).
- **Execution log**: tab + `Execution log/execution_log.jsonl` = the gateway's `Logs/audit.jsonl` lines for those
  request_ids, **verbatim**, + `Execution log/jobs/<job_file>` (from `Requests_Completed/`). `gatewayLogLines_` reads
  the log BACKWARDS in Drive Range requests (8 MB chunks cut on newlines) — never the whole file.
- **Sample list**: tab (numbered; Samples & Tasks column A hyperlinks to it) + `Sample list/sample_list.csv`, and the
  paste byte-for-byte as `Sample list/sample_list_as_received.txt` — `persistRun_` now stores it as
  `Exports/{reqId}/sample_list_as_received.txt` (`storeSampleList_`). Older requests show a "reconstructed" list
  (Sample_Lines in received order, incl. not-found).
- **Methodology** (flows whose module has `methodology(sources)` — Flow C): tab in the export workbook + standalone
  `Reconciliation (system)/Methodology - reconciliation.xlsx`; new Flow C workbooks carry it as a tab too, and each
  raw tab's footnote names the original gateway file + SHA-256. The rows are generated from FlowC.js constants —
  **edit `flowCMethodology_` whenever a filter, window, join or check changes**.
- CSV bytes are never touched (makeCopy); only the export name (`<tag>_result.csv`) differs from the gateway's.
  Independent checker: `verify_audit_export.py` (Gonçalo's side-session notes, 20 Oct 2026).
- **Dead stored copies → gateway original (26 Oct 2026).** REQ_b16a4636's stored CSV/xlsx in `Exports/{reqId}/` were
  gone, so `Extraction/` shipped EMPTY (copy errors were swallowed). Now `resolveExtraction_` falls back to the
  ORIGINAL `{gatewayId}_*.csv|.xlsx` in the gateway's `Responses/` (title search, `gatewayOriginal_`) — a CSV only
  when its SHA-256 = the hash recorded at extraction (`verifiedOriginal_`); the IPE `Integrity` text says "file in
  this package: gateway original from Responses/…". Stage-2 / stage gateway ids come from `ipe.csv2Name` /
  `stages[].csvName` (`gatewayIdFromName_`), so their log lines now appear too. Admin repair (Setup.js):
  `repairRequestFiles(id)` (wrapper `repairFiles_REQ_b16a4636`) re-copies dead slots into `Exports/{reqId}/` and
  re-points the Requests row — never on a hash mismatch; `auditRequestFileLinks()` is the read-only scan.
  The folder state carries `missingFiles[]`; the client shows a red box listing them + a warn toast, and the
  `AUDIT_FOLDER_SYNC` log names them. **Never swallow a failed copy silently.**

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
Cash & POS = one Proof-of-payment task **per payment**, fanned via `mapGroup`). **Sample amount per
subpopulation**: Prepaid – JumiaPay and Postpaid – JumiaPay on delivery take it from **query 2's
`Amount_Transactions`** (`stage2.merge`), falling back to stage 1 (`flowBLineAmount_`: `Prepaid amount` /
`OMS_Package_Amount_Received`) only when query 2 has no row — never `OMS_Payment_Amount`, which for JumiaPay on
delivery is the whole settlement payment; everything else → `OMS_Payment_Amount`. Corrected 2026-09-14; earlier requests are repaired with the admin-run
`fixFlowBAmounts(requestId)` (Setup.js — recomputes from the stored extraction, only `Sample_Lines.amount`,
idempotent, logged as `AMOUNT_FIX`). Full detail (queries, subpopulations, owners, phase-by-phase build log)
is in the **`flow-b-cash-anchor` memory**.
**"JPay Order" (23 Nov 2026):** the *Postpaid - JumiaPay on delivery* card (and only that one — `CA_JPOD` / `CA_JPOD_EXPORT_`)
shows query 2's `cod_order_nr` (`jp_order_nr` in `detail_json`, stored since the first run — no query change, live requests
show it at once), right after *Order*; the preparers track the evidence by it. When query 2 returned no row it falls back to
query 1's merchant order id (`jpay_order_id` — the reference query 2 was asked for) via `CA_ALT` / `CA_ALT_EXPORT_`.

## Flow C — Marketplace revenues / COGS by sales-order item (live — REQ_bc265bfa in flight)
Input = `ID_COMPANY` + `COD_OMS_SALES_ORDER_ITEM` (Flow B's paste format). **Stage 1** `RPT_SOI` (the base
TABLE — `V_RPT_SOI` lacks `IS_MARKETPLACE`) → unit price + Retail/Marketplace split (`subpopulation`).
**Retail**: NAV `Posted Sales Invoices` + `Posted Sales Invoice Line` (`AIG_Nav_DW`, keyed on
`id_company` + `No_`/`Document No_` = `PACKAGE_NUMBER`; sampled line = `Line No_` = `COD_BOB_SALES_ORDER_ITEM`;
lines with `Quantity = 0` are filtered out) + `glr` = the invoice's `G_L Entries` (source **SALES**, all accounts;
the receivable accounts `FLOWC_RETAIL_AR_ACCOUNTS = ['13003','13005']` sum to the invoice total incl. VAT).
Checks: *NAV invoice item VS SOI*; *Invoice header VS Invoice items*; *Invoice header VS NAV GL entries*.
**Marketplace**: hop 1 `ringcodes` (item → statement code, + PO/down payment for those few items — the text
`notes` join lives HERE, not on the big query), then in parallel hop 2 `ring` (all transactions of those
statements: MPL type via the insurance join, payout, balances) and `gl` (NAV `G_L Entries`, **all accounts** of
`Document No_` = `'IS' + code.slice(2)`, source PURCHASES — 18314 is the reconciled one, the rest shows the
document nets to zero). Checks: *Item Price Credit (RING) VS SOI*; *RING transactions VS RING statement*;
*NAV revenue VS RING revenue*. Tolerance `FLOWC_TOLERANCE = 5` (|diff| ≤ 5 → match; else variance — verdict
`uncertain`, never reject). Then Flow A's
task rules on the marketplace items (advance → contract + down-payment; regular → PoP, or VC screenshot when
unpaid; same insurance-join method as Flow A). Routing seeded by `seedFlowC()` / `reseedFlowCRouting()`.
**Query performance rules (measured on the gateway):** every WHERE names the sampled companies
(`ID_Company IN (…)`) **and** a per-company key list — RING/NAV indexes all lead with the company column;
statement/NAV windows are bounded by hop-1 dates (`flowCWindow_`: RING −1/+1 month, NAV −1/+3 months — NAV's
index leads on `Posting Date, Chart of Accounts No_`). Literal statement codes beat an `IN (subquery)` (412 s vs
605 s); the unbounded literal shapes ran 5–7 min, so expect the first executions to return *pending* and resume.
Evidence = ONE workbook per request, modelled on the reviewer's own file: `REC - MPL` / `REC - Retail` (Jumia
logo from `Assets.js` over A1:D5, title + period, four numbered section bands with a medium bottom rule, orange
`#FF6D01` header band with white bold text, Calibri 8, gridlines off, frozen at row 10, `#,##0 ;(#,##0);"-" `
— **no decimals**, every figure a **live formula** into the raw tabs: `VLOOKUP` on `SOI!B:H` for the unit price,
`SUMIFS` on RING / NAV / invoice tabs; a 4th **workbook-only** check "NAV completeness" = document nets to zero),
a `Data Extractions ->` divider tab, then raw `SOI` / `NAV_PostedSalesInvoices` / `NAV_PostedSalesInvoiceLine` /
`NAV_Retail` / `RING` / `NAV` (bold frozen header, autofilter, `yyyy-mm-dd`). Layouts live in `flowCMplLayout_` /
`flowCRetailLayout_` (column letters = the raw tabs' query columns — keep in sync with the SELECTs); the
renderer is the generic `buildXlsxFile_` sheet spec (rows with `=` formulas, styles, widths, images…). The
auditor export copies the workbook **once** into `Reconciliation (system)/` at the export root (every sample's
row points there — `auditExport` dedupes by file id). Deep detail in the **`flow-c-revenue-soi` memory**.

**Retail "Sales invoice" task (12 Nov 2026).** A Retail sample now carries TWO tasks: the system reconciliation and a
manual **`Sales invoice`** (Routing rule `retail_sales_invoice`, `population=retail` → Preparer; constants
`FLOWC_SALES_INVOICE` / `FLOWC_SALES_INVOICE_RULE` in FlowC.js). The preparer uploads the PDF Jumia issued to the customer;
the reviewer's AI check is its own prompt (`assessSalesInvoice_`, Review.js — routed from `assessAssignmentCore_`, NOT the
Flow-A-style per-document check): four named checks — document type, **invoice total incl. VAT = `inv_total`**
(NAV `Posted Sales Invoices`.`Amount incl_ VAT`, rounding ≤ `FLOWC_INVOICE_TOLERANCE` = 1) and **customer name =
`inv_customer`**. NAV keeps mostly the customer's FIRST NAME only, sometimes in Arabic script (seen on REQ_bc265bfa), so
the name rule is "recorded name is part of the printed name, transliteration allowed" — never tighten it to an exact match.
Fourth check, **invoice number**: NAV `No_` = the package number = `<OMS order number>-<suffix>` (288 of 288 invoice lines on
REQ_bc265bfa), so it passes when the PDF shows the full number OR the order number; a number that is absent or different
gives `uncertain` (the reviewer decides), never a reject on its own — only a wrong document type, total or customer rejects.
An `accept` that carries a failed check is downgraded to `uncertain`;
no recorded total (NAV invoice not found) → `uncertain` with no model call. The values come from the sample's
`detail_json` (already stored at extraction — no query change; new runs also store `inv_currency`). Card / export / review
window show *Customer* + *Invoice total* (`CA_FIELDS['Retail']`, `CA_FIELDS_EXPORT_`, `renderFlowCTask`; numeric keys via
`caFmt` / `CA_NUM_KEYS`).
**Adding the task to a request that is already running** (Setup.js, admin-run, editor): `previewFlowCSalesInvoiceTasks(id)`
(dry run, writes nothing) then `addFlowCSalesInvoiceTasks(id)` — wrappers `previewSalesInvoiceTasks_REQ_bc265bfa` /
`addSalesInvoiceTasks_REQ_bc265bfa`; with no id it takes the only Flow C request that is not closed. It appends ONE pending,
unassigned task per Retail sample that lacks it, adds the Routing rule if missing, re-derives each sample's status with the
normal rollup (a sample already past review shows `in_progress` again; its reconciliation task keeps its own status), bumps
`required_count` / `route_rule` LAST (= the per-sample "done" marker, so a half-finished run resumes without duplicates),
reopens a `closed` request to `enriched`, and logs `TASK_BACKFILL`. Existing tasks, evidence and extractions are never
rewritten. This is the pattern for any future "add a task to a live request" change. `addFlowCSalesInvoiceRule()` only adds
the rule (future requests). Triggers and the editor run HEAD; the invoice-specific AI check and the new card fields reach
the live `/exec` URL only once prod is promoted (done: prod = **@41**, 12 Nov 2026, deployed by João).

## Flow D — COGS by NAV value entry (built 16 Nov 2026 — on `/dev`, awaiting `seedFlowD()` + a first real run)
Input = company code + NAV `Value Entry`.`Entry No_` (`EC_MA 14356476`, either order; `flowDParseSample_`). Each sampled
entry is the cost of an item sold / returned, or a later **adjustment** of that cost; the support is the vendor's purchase
invoice and, for an adjustment, the vendor credit / debit note behind it. Module `FlowD.js`, registered as `flowD`.
- **One query on LIVE NAV**, gateway server `finrec`, db `AIG_Nav_DW`: `select * from openquery([ERP_NAVBC01|02], '<inner>')`,
  one block per company, `union all`. Company → linked server / database / NAV company name = `FLOWD_COMPANIES` (8 companies;
  a new country = one line). openquery's string is capped at 8,000 chars → `flowDQuery_` splits a company's entry list into
  blocks (`FLOWD_OPENQUERY_MAX`). No date window (an entry number is unique within its company) — the period is a label and
  the module rewords the IPE checks (`ipeChecks` hook in `buildIpe_`).
- **Inner query** = recursive CTE `chain` from the sampled entry to the inbound entry it took its cost from
  (`Item Application Entry`), then on when that is not a purchase: member 1 = the origin NAV **recorded** (return / undone
  shipment / transfer); member 2 = a return receipt `R<order>-<nnnn>` with no recorded origin matched to the original sale on
  **order number + item** (`Guessed = 1`); `Hop < FLOWD_MAX_HOPS` (8; seen 5). Then one row per (sample, chain node, purchase
  value entry of document type 5 / 6 / 8) with `External Document No_` (= the vendor's own number, as printed on the PDF),
  `Item Charge No_` (`PP-` price protection, `BM-` back margin), vendor, OMS PO. The anchor is a LEFT join, so an entry with
  nothing applied still returns one row; an entry NAV does not have returns none → `not_found`.
- **Gateway CSV quirk:** a column holding a NULL anywhere arrives as floats (document type `6.0`, entry no. `70445007.0`) and
  rows come in no fixed order → read every code / id through `flowDCode_`, and never take "the first row" of a document
  (vendor number = first one filled in, document date = earliest posting date; receipts and documents are sorted).
- **What the app decides** (`flowDMapGroup_`): the purchase receipt(s) = nodes reached without a guess, else the guessed ones
  (a manual credit memo for several units fans out into several candidate receipts — all kept). Tasks, via the new
  **`taskUnits[rule_name]`** hook in `persistRunRows_` (units per Routing rule; `units` stays the shared fan-out of Flow B):
  one **`Purchase invoice`** per goods invoice (rule `cogs_purchase_invoice`, `cogs=yes`), at least one per sample, flagged
  `pending: 'not_invoiced' | 'no_receipt'` when NAV shows none; for an **adjustment** sample, one **`Credit / debit note`**
  per note that explains the amount (rule `cogs_credit_debit_note`, `notes=yes`) — `flowDExplain_`: amount = quantity × the
  document's per-unit amount `(Cost Actual + Cost Expected) / Valued Qty`, one document first, else the documents of one
  posting date; tolerance `FLOWD_TOLERANCE` 0.015 **and** ≤ 25 % of the amount. Other notes are listed on the card only
  (the team's own H1 2026 practice: only the explaining notes were delivered). Subpopulations `COGS - Original cost` /
  `COGS - Adjustment`, both in `PER_TASK_SUBPOPS` (per-task review, like Cash & POS). Line field is `purchase_order`, not
  `po` (`po` is in `LINE_STD_` and never reaches `detail_json`).
- **No invoice in NAV yet** (`pending` task) — **a file is mandatory** (João, 17 Nov 2026, replacing the 16 Nov "comment and
  no file" rule): the preparer uploads the invoice if the team has it, **otherwise the purchase order**; the card says so
  (`renderTaskCard`) and `submitAssignment` refuses a pending task without a file. The AI check (`assessCogsDocument_`,
  `isPending`) then accepts **an invoice or a Jumia purchase order**, and its third check is the **purchase order number**
  (`unit.po`) instead of the vendor document number NAV does not have. Left in place for tasks submitted under the old rule:
  no files → `uncertain` with no model call, and `reviewerSubmitTask` requires a note to the auditor when a pending task has
  no evidence (the preparer's comment never reaches them).
- **AI check** = its own prompt (`assessCogsDocument_`, Review.js, routed from `assessAssignmentCore_`): document type, vendor
  (NAV names carry suffixes like "Retail" / "NF" — "recorded name is part of the issuer's name", never exact), vendor
  document number; a missing number is `uncertain`, only a wrong document type or vendor rejects.
- **No screenshots** (João, 16 Nov 2026: the auditors will accept a system extract): no NAV-screenshot slot. The extraction
  CSV + the gateway's SOX workbook ship in the audit export; the module adds its own columns to "Samples & Tasks"
  (`exportHeaders` / `exportValues` hook in `auditExport`). A formatted "NAV value entries" workbook per request (the old
  screenshot + "breakdown" files) is the next step, not built.
- Validated on the 94 samples of H1 + Q3 2026 **through the gateway** (20 s): 94 found, amount = the auditors' on 94, a goods
  invoice for 85 (the hand query: 65), 9 pending, 114 tasks. Offline end-to-end test `test_flowd.js` (side-session notes).
  Open: two H1 Adidas Morocco samples where the team delivered an invoice NAV does not show on the receipt; preparer teams
  (one or per country) not decided. Deep detail in the **`flow-d-cogs` memory**.

## Load times, CFO dashboard, access log (20 Oct 2026, Gonçalo)
Measured on the Executions log (149 calls, 14–20 Oct): every call opened Config for the role, then Data, and read
3–4 whole tabs; a screen cost 4–5 s server-side and the first open ~12.5 s. Now:
- **`Cache.js`**: `readTabsCached_(names)` serves tabs from CacheService. Config tabs: 5-min TTL (BankRec roster
  pattern). Data tabs: keyed on a per-tab version `DV_<tab>` (script property) that **every** Db write helper
  (`appendObject_`/`updateRowById_`/`deleteRowById_`) bumps via `noteTabWrite_` **after** `SpreadsheetApp.flush()`.
  **Only read paths use the cache** (lists, details, dashboard, getUsers/getFlows/getRouting/getPeriods/getSetting).
  Actions (submit/review/close/return/assign/enrich/export/AI) keep `readObjects_` on the sheet — never decide on a
  cached copy. A new write path that bypasses the three helpers MUST call `noteTabWrite_(tab)`. Hand edits of the
  sheets: run `flushAppCache()` in the editor (or wait for the TTL). Spreadsheets open once per execution (`__ssOpen_`).
- **Actions (21 Oct 2026)**: `Db.js` keeps an **execution-local memo of FRESH sheet reads** (`__tabMemo_`, Data
  spreadsheet only — never the CacheService copy). A decision read (`readObjects_`, so `findAssignment_`/`findLine_`/
  `getAssignments`/the rollup) reuses it only while nothing was written to that tab since and it is ≤5 s old
  (`MEMO_FRESH_MS_`); after a write the next read goes back to the sheet, so the rollup always sees its own write and
  any concurrent one (tested: two auditors closing sibling tasks at once still closes the sample). `updateRowById_`
  only needs the row number (rows of Requests/Sample_Lines/Assignments are never deleted; appends don't shift rows), so
  it uses a memo ≤30 s old, written or not, and falls back to a fresh read when the id is missing; `deleteRowById_`
  always reads the sheet and drops the memo. Each run of adjacent patched columns is written with ONE `setValues`;
  gap columns are never rewritten (a concurrent write to them survives). `noteTabWrite_` still runs after every write.
  A new direct write to a Data tab must call `forgetTab_(tab)` as well as `noteTabWrite_(tab)`. Offline proof:
  `scenario.js`/`compare.js`/`memo-test.js` in the 21 Oct side-session notes (68 action calls on the real Data
  export: results, refusals and all Data tabs identical to the previous code).
- **Boot**: `doGet` embeds `{user, canDash, dash?}` into Index.html (string placeholder `"__ASM_BOOT__"` — a
  `/*comment*/` placeholder does NOT survive HtmlService), so the client skips the getCurrentUser round trip; the
  client starts the first screen on the next tick (stage configs must be defined first). pdf.js loads on first PDF.
- **Client**: `RUN()` = timed `google.script.run` (Proxy); screens keep their last copy (`MEMO`) and refresh quietly;
  the Request screen is one call (`requestScreen`).
- **CFO dashboard** (`Dashboard.js`, first tab): Administrators + Settings `dashboard_viewers` (comma list), never
  Auditors (`canSeeDashboard_`). No AI output. Orphan Sample_Lines (deleted requests) flagged "Data check first".
- **Access_Log** (Data tab, created on first write; also in SCHEMA): every open / call / dashboard view with user,
  role, outcome (served/refused), server_ms, client_ms, scope, visit — client beacon `logUi`, refusals server-side.
  Read it for before/after numbers. Activity_Log stays the SOX trail.
- **SoD fixes**: `reviewDetail(…,'audit')` strips `ai_verdict/ai_summary` server-side (they used to reach the
  auditor's browser, hidden only by the UI); `taskTimeline` refuses Auditors; screens get the Requests row without
  `ipe_json`/`stages_json` (`slimRequest_`).
- **Look**: BankRec direction C (white top bar with tabs, orange underline = chrome only; state colours
  `--st-done/audit/review/todo/nf` on progress bars, tiles and charts). Offline harness + tests in the 20 Oct
  side-session notes (`harness.js`/`test.js`: real server code, mocked services, real Data export).

## Roadmap / next
- **Flow D first real run**: `seedFlowD()` in the editor (no `setup()` — no schema change) → run a sample on `/dev` →
  check the tasks → promote to prod only when asked. Then: the "NAV value entries" workbook (system extract), preparer teams.
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
