/**
 * Cache — fast reads for the screens (20 Oct 2026).
 * -------------------------------------------------
 * Measured on the Executions log (14–20 Oct): every call opened Config to look up the
 * caller's role, then opened Data and read 3–4 whole tabs, so a screen cost 4–5 s
 * server-side on a data set of a few hundred rows. This module keeps those reads in
 * CacheService:
 *
 *  - Config tabs (Users, Flows, Periods, Routing, Settings): 5-minute TTL — the
 *    BankRec roster pattern. An app write (addUser, a reseed) invalidates at once; a
 *    hand edit of the Config sheet goes live within 5 minutes (or run flushAppCache()).
 *  - Data tabs: stamped with a per-tab version (script property DV_<tab>) that every
 *    app write bumps (Db.js appendObject_/updateRowById_/deleteRowById_ call
 *    noteTabWrite_). Writes are flushed BEFORE the bump, so a reader that sees the new
 *    version can only read the new rows. The 30-minute TTL only bounds hand edits.
 *
 * ONLY read paths (lists, details, the dashboard) use readTabsCached_. Actions
 * (submit, review, close, return, assign, enrich, export, AI checks) keep reading the
 * sheet itself through readObjects_, so they never decide on a cached copy.
 * (Within one execution readObjects_ reuses its own fresh sheet read — Db.js __tabMemo_ —
 * until that tab is written; that is a read of the sheet, not this cache.)
 */

var CACHE_TTL_CONFIG_ = 300;    // seconds
var CACHE_TTL_DATA_   = 1800;   // seconds
var CACHE_CHUNK_      = 30000;  // chars per cache value (CacheService caps a value at 100 KB; UTF-8 can triple a char)
var CONFIG_TABS_      = ['Users', 'Flows', 'Routing', 'Periods', 'Settings'];
var UNCACHED_TABS_    = ['Access_Log'];   // append-only usage log: never read through the cache, never bumped

/* ---------- script properties, read once per execution ---------- */
var __propsSnap_ = null;
function scriptProps_() {
  if (!__propsSnap_) {
    try { __propsSnap_ = PropertiesService.getScriptProperties().getProperties(); } catch (e) { __propsSnap_ = {}; }
  }
  return __propsSnap_;
}
/** One property, from the snapshot; falls back to a live read when the snapshot lacks it (setup() sets ids mid-run). */
function scriptProp_(key) {
  var v = scriptProps_()[key];
  if (v == null || v === '') {
    v = PropertiesService.getScriptProperties().getProperty(key);
    if (v != null) __propsSnap_[key] = v;
  }
  return v;
}

/* ---------- versions ---------- */
function tabVersion_(name) { return scriptProps_()['DV_' + name] || '0'; }

/**
 * Bulk writers (persistRun_ writes one row per sample and per task) bump each touched tab
 * ONCE, at the end, instead of after every row. Readers in between can only cache under the
 * pre-batch version, which the final bump retires.
 */
var __batchTabs_ = null;
function withBatchedTabWrites_(fn) {
  if (__batchTabs_) return fn();
  __batchTabs_ = {};
  try { return fn(); }
  finally { var touched = Object.keys(__batchTabs_); __batchTabs_ = null; touched.forEach(noteTabWrite_); }
}

/** Called by every Db write helper AFTER the write: flush, then move the tab's version on. */
function noteTabWrite_(name) {
  if (UNCACHED_TABS_.indexOf(name) !== -1) return;
  if (__batchTabs_) { __batchTabs_[name] = true; return; }
  try {
    SpreadsheetApp.flush();
    var v = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    PropertiesService.getScriptProperties().setProperty('DV_' + name, v);
    scriptProps_()['DV_' + name] = v;
  } catch (e) {
    Logger.log('noteTabWrite_ failed (non-fatal, cache may serve the previous copy until its TTL): ' + e);
  }
}

/** Editor helper: drop every cached copy now (e.g. after editing the Config or Data sheet by hand). */
function flushAppCache() {
  CONFIG_TABS_.concat(SCHEMA ? Object.keys(SCHEMA.data) : []).forEach(function (n) { noteTabWrite_(n); });
  Logger.log('App cache flushed: every tab version moved on.');
}

/* ---------- cached tab reads ---------- */
/**
 * { tabName: [rowObjects] } for the requested tabs, from CacheService where the copy
 * matches the tab's current version, else from the sheet (opened once, only on a miss).
 * Config and Data tabs may be mixed in one call.
 */
function readTabsCached_(names) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) {}
  var out = {}, keyOf = {};
  names.forEach(function (n) { keyOf[n] = 'T|' + n + '|' + tabVersion_(n); });

  var miss = names.slice();
  if (cache) {
    try {
      var heads = cache.getAll(names.map(function (n) { return keyOf[n]; }));
      var partKeys = [];
      names.forEach(function (n) {
        var k = Number(heads[keyOf[n]] || 0);
        for (var i = 0; i < k; i++) partKeys.push(keyOf[n] + '|' + i);
      });
      var parts = partKeys.length ? cache.getAll(partKeys) : {};
      miss = [];
      names.forEach(function (n) {
        var k = Number(heads[keyOf[n]] || 0), s = k ? '' : null;
        for (var i = 0; i < k; i++) {
          var p = parts[keyOf[n] + '|' + i];
          if (p == null) { s = null; break; }
          s += p;
        }
        if (s == null) { miss.push(n); return; }
        try { out[n] = JSON.parse(s); } catch (e) { miss.push(n); }
      });
    } catch (e) { miss = names.slice(); }
  }

  if (miss.length) {
    var put = {}, putCfg = {};
    miss.forEach(function (n) {
      var isCfg = CONFIG_TABS_.indexOf(n) !== -1;
      var rows = readObjects_(isCfg ? configSs_() : dataSs_(), n);
      out[n] = rows;
      var s = JSON.stringify(rows), k = Math.max(1, Math.ceil(s.length / CACHE_CHUNK_));
      var bucket = isCfg ? putCfg : put;
      for (var i = 0; i < k; i++) bucket[keyOf[n] + '|' + i] = s.substr(i * CACHE_CHUNK_, CACHE_CHUNK_);
      bucket[keyOf[n]] = String(k);
    });
    if (cache) {
      try { if (Object.keys(put).length) cache.putAll(put, CACHE_TTL_DATA_); } catch (e) { Logger.log('cache put (data) skipped: ' + e); }
      try { if (Object.keys(putCfg).length) cache.putAll(putCfg, CACHE_TTL_CONFIG_); } catch (e) { Logger.log('cache put (config) skipped: ' + e); }
    }
  }
  return out;
}
function readTabCached_(name) { return readTabsCached_([name])[name]; }

/** Small computed payloads (the dashboard) keyed on the versions they were built from. */
function cachedJson_(key, ttl, build) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); var hit = cache.get(key); if (hit) return JSON.parse(hit); } catch (e) {}
  var v = build();
  try { var s = JSON.stringify(v); if (cache && s.length < 90000) cache.put(key, s, ttl); } catch (e) {}
  return v;
}
function cachedJsonPeek_(key) {
  try { var hit = CacheService.getScriptCache().get(key); return hit ? JSON.parse(hit) : null; } catch (e) { return null; }
}
