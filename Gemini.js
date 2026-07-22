/**
 * Gemini.js — multimodal evidence-check transport.
 * -------------------------------------------------
 * House pattern (from finops-reports-portal / finops-aios-collector): UrlFetchApp →
 * Generative Language API, key held in a Script Property and sent as the
 * `x-goog-api-key` HEADER, retry/backoff on 429/5xx, model fallback. Adapted here to
 * send a document (image/PDF) as inlineData and return a structured JSON verdict.
 *
 * DATA GOVERNANCE: this MUST use a PAID-TIER key (Script Property GEMINI_API_KEY).
 * We send confidential audit evidence to the model; paid tier / Vertex is not used to
 * train Google's models. Never point this at a free-tier key.
 *
 * Runs server-side as the deploying account (executeAs = USER_DEPLOYING), so reviewers
 * never see the key and only the deployer needs the external_request scope.
 */
var GEMINI = {
  API_BASE:       'https://generativelanguage.googleapis.com/v1beta',
  API_KEY_PROP:   'GEMINI_API_KEY',
  MODEL:          'gemini-3.5-flash',
  MODEL_FALLBACK: 'gemini-3.1-flash-lite',   // tried only on transient 429/5xx; '' to disable
  MAX_RETRIES:    3,
  THINKING_BUDGET: 0                          // off = predictable latency; null to omit
};

function getGeminiKey_() {
  var v = PropertiesService.getScriptProperties().getProperty(GEMINI.API_KEY_PROP);
  if (!v) throw new Error('Missing Script Property "' + GEMINI.API_KEY_PROP +
    '" — set the paid-tier Gemini API key in Project Settings → Script properties.');
  return v;
}

/**
 * Assess one document. `doc` = { mimeType, bytes } (bytes from Blob.getBytes()), or null.
 * `system` is the instruction, `prompt` the case facts. Returns the parsed JSON verdict
 * { verdict:'accept'|'reject'|'uncertain', confidence, summary, checks:[{name,ok,note}] }.
 */
function geminiAssess_(system, prompt, doc) {
  var models = [GEMINI.MODEL].concat(GEMINI.MODEL_FALLBACK ? [GEMINI.MODEL_FALLBACK] : []);
  var lastErr = '';
  for (var i = 0; i < models.length; i++) {
    try { return geminiAssessOne_(models[i], system, prompt, doc); }
    catch (e) {
      lastErr = e.message || String(e);
      if (i < models.length - 1 && /HTTP (429|5\d\d)/.test(lastErr)) continue;
      throw e;
    }
  }
  throw new Error('All Gemini models failed. Last: ' + lastErr);
}

function geminiAssessOne_(model, system, prompt, doc) {
  var apiKey = getGeminiKey_();
  var url = GEMINI.API_BASE + '/models/' + model + ':generateContent';

  var parts = [];
  if (doc && doc.bytes) parts.push({ inlineData: { mimeType: doc.mimeType || 'application/octet-stream', data: Utilities.base64Encode(doc.bytes) } });
  parts.push({ text: prompt });

  var payload = {
    contents: [{ role: 'user', parts: parts }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          verdict:    { type: 'STRING', enum: ['accept', 'reject', 'uncertain'] },
          confidence: { type: 'NUMBER' },
          summary:    { type: 'STRING' },
          checks:     { type: 'ARRAY', items: { type: 'OBJECT', properties: {
                          name: { type: 'STRING' }, ok: { type: 'BOOLEAN' }, note: { type: 'STRING' } } } }
        },
        required: ['verdict', 'summary']
      }
    }
  };
  if (typeof GEMINI.THINKING_BUDGET === 'number') payload.generationConfig.thinkingConfig = { thinkingBudget: GEMINI.THINKING_BUDGET };

  var request = {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };

  var lastErr = '';
  for (var attempt = 0; attempt <= GEMINI.MAX_RETRIES; attempt++) {
    if (attempt > 0) Utilities.sleep(Math.pow(2, attempt - 1) * 1000 + Math.floor(Math.random() * 400));
    var resp = UrlFetchApp.fetch(url, request);
    var code = resp.getResponseCode(), body = resp.getContentText();
    if (code >= 200 && code < 300) return parseAssess_(body);
    if (code === 429 || code >= 500) { lastErr = 'HTTP ' + code + ': ' + body; continue; }
    throw new Error('Gemini API error HTTP ' + code + ': ' + body);   // 4xx = bad key/model/request
  }
  throw new Error('Gemini ' + model + ' failed after ' + (GEMINI.MAX_RETRIES + 1) + ' attempts. Last: ' + lastErr);
}

function parseAssess_(body) {
  var r = JSON.parse(body);
  if (r && r.promptFeedback && r.promptFeedback.blockReason) throw new Error('Gemini blocked the prompt: ' + r.promptFeedback.blockReason);
  var cand = r && r.candidates && r.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) throw new Error('Gemini returned no content (finishReason: ' + (cand ? cand.finishReason : 'none') + ').');
  var text = cand.content.parts.map(function (p) { return p.text || ''; }).join('').trim();
  try { return JSON.parse(text); } catch (e) { throw new Error('Gemini returned non-JSON: ' + text.substring(0, 200)); }
}

/** Editor test: verifies the key + model round-trip (no document). */
function pingGemini() {
  var out = geminiAssess_('You are a test. Return strictly valid JSON.',
    'Return exactly {"verdict":"accept","summary":"ok"}.', null);
  Logger.log(JSON.stringify(out));
  return out;
}
