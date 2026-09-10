// GATE — step 4 of the hybrid loop.
//
// A candidate survives ONLY if a tool confirmed it: a taint path proven and/or
// a working local PoC produced. Everything else is killed. This is the static-
// confirmation step that removes the bulk of the LLM stage's false positives.
// An honest empty result is valid — we never promote an unconfirmed candidate.

export function applyGate(confirmation, { requireDynamicPoc = false } = {}) {
  if (!confirmation.confirmed) {
    const hadTool = confirmation.verdicts.some((verdict) => verdict.status === "unconfirmed" || verdict.status === "confirmed" || verdict.status === "error");
    return {
      survives: false,
      reason: hadTool ? "no confirmer proved the property at this site" : "no confirmer was available to prove the property",
    };
  }
  if (requireDynamicPoc && !confirmation.dynamicConfirmed) {
    return { survives: false, reason: "static/taint confirmation only; a working dynamic PoC is required (confirm.requireDynamicPoc)" };
  }
  return {
    survives: true,
    reason: `confirmed by ${confirmation.confirmingTools.join(", ")}${confirmation.dynamicConfirmed ? " (dynamic PoC)" : confirmation.taintProven ? " (taint/static proof)" : ""}`,
  };
}

// Partition per-candidate confirmation results into survivors and killed.
export function gateCandidates(evaluations, { requireDynamicPoc = false } = {}) {
  const survivors = [];
  const killed = [];
  for (const evaluation of evaluations) {
    const gate = applyGate(evaluation.confirmation, { requireDynamicPoc });
    const tagged = { ...evaluation, gate };
    if (gate.survives) survivors.push(tagged);
    else killed.push(tagged);
  }
  return { survivors, killed };
}
