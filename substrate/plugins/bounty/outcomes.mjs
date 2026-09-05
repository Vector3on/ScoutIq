// plugins/bounty/outcomes.mjs — the vocabulary the operator uses to close a cell,
// and how each maps to a Loam judgment value on the target.
//
// A cell is (target, seam, technique). When the operator has looked (in their own
// authorized environment) and knows the result, they mark the cell tried with one
// of these outcomes. That does two things: the cell never re-appears, and the
// outcome becomes evidence for the value model — did this target's anatomy/EV
// profile actually pay? Positive outcomes teach the model what a good lead looks
// like; negative ones teach it what a dead end looks like.
//
// The judgment is recorded on the TARGET (the substrate's judgment granularity),
// so it is aggregated, noisy evidence (DECISIONS D26/D29), not a per-cell label.
export const OUTCOMES = {
  'real-defect':            { value: 0.95, polarity: 'positive', desc: 'a real defect was found at this cell' },
  disclosed:                { value: 0.9,  polarity: 'positive', desc: 'a real, publicly disclosed finding' },
  fixed:                    { value: 0.85, polarity: 'positive', desc: 'a real finding, already fixed' },
  'impact-not-established':  { value: 0.35, polarity: 'weak',     desc: 'a deviation was seen but impact was not established' },
  unreproducible:           { value: 0.25, polarity: 'weak',     desc: 'looked promising but could not be reproduced' },
  prevented:                { value: 0.15, polarity: 'negative', desc: 'a safeguard prevented it; the invariant held' },
  intended:                 { value: 0.1,  polarity: 'negative', desc: 'intended behaviour, not a defect' },
  'out-of-scope':           { value: 0.1,  polarity: 'negative', desc: 'out of scope / not payable' },
};
export const OUTCOME_KEYS = Object.keys(OUTCOMES);

export function outcomeInfo(outcome) {
  const e = OUTCOMES[outcome];
  if (!e) throw new Error(`unknown outcome "${outcome}" — use one of: ${OUTCOME_KEYS.join(', ')}`);
  return e;
}
export function outcomeValue(outcome) { return outcomeInfo(outcome).value; }
