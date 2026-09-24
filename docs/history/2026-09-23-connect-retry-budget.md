# Bounded connect retry integration - 2026-09-23

Historical source-validation evidence, not live deployment status. Current
transport authority remains `src/connect-timeout.mjs`,
`src/fetch-transport.mjs`, and `src/upstream-retry.mjs`.

## Reproduced defect

Before the change, Router Lite named `UND_ERR_CONNECT_TIMEOUT` as retryable,
but its default retry budget was 5 seconds while the shared Undici dispatcher
used the longer implicit connect timeout.

On the authorized Windows development host, two direct blackhole probes against
`10.255.255.1:443` and `192.0.2.1:443` failed after 10.647 s and 10.653 s.
Both surfaced `UND_ERR_CONNECT_TIMEOUT` and Router started zero retries. The
first failed connect had already spent the entire retry budget.

## Accepted change

Router Lite now:

- owns a dependency-free connect timeout policy in `src/connect-timeout.mjs`;
- defaults TCP connect establishment to 3 seconds, clamped to 500 ms through
  30 seconds via `CODEX_ROUTER_CONNECT_TIMEOUT_MS`;
- enables Undici address-family racing with a 250 ms family-attempt interval;
- applies the same connection policy to the direct Agent and the explicitly
  selected `EnvHttpProxyAgent`; and
- derives the default pre-header retry budget from that connect bound
  (`max(5s, 3 * connectTimeout)`), so the retryable connect failure cannot
  arrive only after its budget has expired.

The new source file is part of the Windows managed package.

## Runtime probes

With the candidate source:

- a raw direct blackhole connection failed in 3.547 s with
  `UND_ERR_CONNECT_TIMEOUT`;
- a blackhole proxy connection through the real `EnvHttpProxyAgent` failed in
  3.538 s with the same code;
- a local sentinel proxy proved the actual proxy dispatcher path was selected
  and intercepted an otherwise unreachable literal target; and
- a full default `fetchWithRetry` blackhole run made both configured retries,
  then failed after 11.651 s instead of exposing the first timeout with zero
  retries.

The final all-attempts-fail case is slightly longer than the former single
10.65-second failed connect because it now spends two bounded retry
opportunities plus backoff. The important contract is that a transient connect
failure can recover while the total remains bounded. Slow HTTP failures are
still refused once the retry budget is spent.

The higher derived budget does not turn every routed request into a retrying
request. Router loopback routes and billed image generation explicitly use
`retries: 0`; the OpenRouter forwarder permits one pre-header retry, while the
native turn path uses the default two.

## Verification

The focused transport/retry regression suite passed 4/4. The complete retained
Router suite passed 345/345 and the Node production dependency audit reported
zero vulnerabilities. No provider credential, paid model call, or live managed
runtime was used or changed by these probes.

The original-Router candidate is therefore moved from deferred to integrated in
`maintenance/upstream-router.json`.
