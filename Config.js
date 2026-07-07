/**
 * Config — shared constants for the app backbone.
 * ------------------------------------------------
 * All .gs files share one global scope, so everything declared here is visible
 * to Setup / Db / Auth. This file holds NO logic — only names, schema, and seeds.
 */

/**
 * Drive folder ID of the "Audit Requests Manager" shared folder (the one that
 * contains App/). setup() provisions DB/, Evidence/ and Exports/ inside it.
 *
 * HOW TO GET IT: open that folder in Drive and copy the id from the URL
 * (…/folders/<THIS_ID>). Paste it below, then run setup() from the editor.
 */
var APP_ROOT_FOLDER_ID = '1IL-QbHfxkGMjwPlcc8iWvllj2BDn6X07';

/* Roles (assigned by email, @jumia.com only). */
var ROLES = {
  ADMIN:    'Administrator',
  PREPARER: 'Preparer',
  REVIEWER: 'Reviewer',
  AUDITOR:  'Auditor'
};

/* Script Property keys — where setup() persists the IDs it creates. */
var PROP = {
  CONFIG_SS: 'CONFIG_SS_ID',
  DATA_SS:   'DATA_SS_ID',
  DB_FOLDER: 'DB_FOLDER_ID',
  EVIDENCE:  'EVIDENCE_FOLDER_ID',
  EXPORTS:   'EXPORTS_FOLDER_ID',
  SETUP_AT:  'SETUP_AT'
};

/* Human-facing names for the things setup() creates. */
var NAME = {
  CONFIG_SS:       'Audit Requests Manager — Config',
  DATA_SS:         'Audit Requests Manager — Data',
  DB_FOLDER:       'DB',
  EVIDENCE_FOLDER: 'Evidence',
  EXPORTS_FOLDER:  'Exports'
};

/**
 * Tab → header schema. Config is admin-edited; Data is written only by the app.
 * Order matters: appendObject_/seed map objects onto these headers by name, but
 * the header row is written in this exact order.
 */
var SCHEMA = {
  config: {
    Users:    ['email', 'role', 'status', 'added_by', 'added_at'],
    Flows:    ['flow_id', 'name', 'database', 'query_mode', 'sample_key', 'dedup_keys', 'active'],
    Routing:  ['flow_id', 'rule_name', 'match', 'required_evidence', 'responsible', 'active'],
    Periods:  ['flow_id', 'name', 'start_date', 'end_date', 'active'],
    Settings: ['key', 'value', 'description']
  },
  data: {
    Requests:     ['request_id', 'flow_id', 'title', 'period', 'period_start', 'period_end',
                   'auditor_email', 'reviewer_email', 'request_ref', 'due_date',
                   'status', 'created_by', 'created_at', 'updated_at',
                   'csv_file_id', 'xlsx_file_id', 'ipe_json'],
    Sample_Lines: ['line_id', 'request_id', 'document_no', 'company', 'vendor', 'mpl_type', 'paid_status',
                   'statement_code', 'amount', 'paid_at', 'closing_balance', 'route_rule', 'required_count',
                   'status', 'evidence_folder_id', 'note', 'created_at'],
    // One row per required evidence item per line — this is where multi-preparer lives.
    // A line can carry several Assignments (e.g. invoice + proof of payment), each owned
    // by a different preparer; the line only advances once every Assignment is satisfied.
    Assignments:  ['assignment_id', 'line_id', 'request_id', 'evidence_type', 'assigned_to', 'status',
                   'due_date', 'submitted_at', 'notes', 'created_at'],
    Evidence:     ['evidence_id', 'assignment_id', 'line_id', 'request_id', 'file_id', 'file_name', 'mime', 'uploaded_by', 'uploaded_at', 'status'],
    Activity_Log: ['ts', 'actor', 'action', 'entity_type', 'entity_id', 'details']
  }
};
