function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// Only a turn the provider actually accepted proves capacity. A failed turn
// proves nothing: the request may have been rejected for exactly this reason.
// Estimated counts prove nothing either -- the router substitutes those when a
// provider reports zero, and an estimate cannot disprove a provider's own
// limit.
// An empty-completion retry sends the same prompt twice and both attempts are
// billed, so the meter deliberately sums them (mergeTokenUsage) and the turn
// lands as a normal 200 carrying roughly double the prompt it actually sent.
// Believed as capacity that is a ~2x window overstatement invented out of one
// retry -- and the remediation this check prints is "raise the window", so the
// bad sample would talk an operator into doubling a correct number.
// provider-usage.mjs drops these same events from its throughput math for the
// same reason: a merged pair is not one measurement. Rows that keep the
// selected attempt in `inputTokens` and aggregate cost in `billedInputTokens`
// are valid context measurements. Older rows only have the retry marker and
// remain excluded because their count was summed.
// Bare `retries` is not excluded — a transport retry records only the
// successful attempt's tokens.
export function acceptedInputTokens(event) {
  if (event?.status !== 200) return undefined;
  if (event?.estimatedInputTokens !== undefined) return undefined;
  if (event?.emptyCompletionRetried === true) return undefined;
  if (event?.progressOnlyRetried === true && event?.billedInputTokens === undefined) {
    return undefined;
  }
  return positiveInteger(event?.inputTokens);
}
