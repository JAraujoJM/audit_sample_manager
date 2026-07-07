/**
 * Flow registry.
 * --------------
 * A business flow is CONFIG (rows in Flows / Routing / Periods) plus a small
 * CODE module for the two things config can't express: the enrichment SQL and
 * how to read a result row (into the app's line fields + the `facts` the routing
 * rules match on). Everything else — assignment, evidence, review/audit,
 * storage, IPE — is flow-agnostic and needs no per-flow code.
 *
 * TO ADD A FLOW:
 *   1. Add its Flows / Periods / Routing rows in the Config sheet.
 *   2. Write a module file modelled on FlowA.js: an object with
 *        { id, sampleKey, buildQuery(docs, p), mapRow(cell) }.
 *   3. Register it in the map below.
 *   (A flow's results table in Index.html is still flow-shaped — adjust it if the
 *    new flow surfaces different columns; the engine itself needs no changes.)
 *
 * The registry is built inside the function so it never depends on file load
 * order — the module builders are hoisted function declarations.
 */
function flowModule_(flowId) {
  var registry = {
    flowA: flowA_
    // flowB: flowB_,
  };
  var builder = registry[String(flowId)];
  return builder ? builder() : null;
}
