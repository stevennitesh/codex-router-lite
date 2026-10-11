import assert from "node:assert/strict";
import test from "node:test";
import { environmentHttpProxyConfigured, redactProxyCredentials, serviceProxyEnvironment } from "../src/proxy-environment.mjs";

test("proxy redaction removes complete authority credentials and preserves paths", () => {
  for (const [address, expected] of [
    ["http://user:password@tail@host.invalid:8080/path@name?x=@y", "http://[REDACTED]@host.invalid:8080/path@name?x=@y"],
    ["https://user:password%40tail@[::1]:8080", "https://[REDACTED]@[::1]:8080"],
    ["user:password@tail@host.invalid:8080", "[REDACTED]@host.invalid:8080"],
    ["http://host.invalid/path@name", "http://host.invalid/path@name"],
    ["http://host.invalid?key=user@name", "http://host.invalid?key=user@name"],
    ["localhost,127.0.0.1,.internal", "localhost,127.0.0.1,.internal"],
  ]) assert.equal(redactProxyCredentials({ HTTPS_PROXY: address }).HTTPS_PROXY, expected);
});

test("service handoff and transport agree on independent HTTP and HTTPS precedence", () => {
  const recorded = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://recorded.invalid:8080" };
  for (const environment of [
    { http_proxy: "", https_proxy: "http://new.invalid:8080" },
    { HTTP_PROXY: "", HTTPS_PROXY: "http://new.invalid:8080" },
    { https_proxy: "", http_proxy: "http://new.invalid:8080" },
    { http_proxy: "", HTTP_PROXY: "http://ignored.invalid:8080", HTTPS_PROXY: "http://new.invalid:8080" },
  ]) {
    const generated = serviceProxyEnvironment(environment, { recorded });
    assert.equal(generated.NODE_USE_ENV_PROXY, "1");
    assert.equal(environmentHttpProxyConfigured(generated, []), true);
    const optedOut = serviceProxyEnvironment({ ...environment, NODE_USE_ENV_PROXY: "0" }, { recorded });
    assert.equal(environmentHttpProxyConfigured(optedOut, []), false);
  }
  assert.equal(environmentHttpProxyConfigured({ http_proxy: "", HTTP_PROXY: "http://ignored.invalid", NODE_USE_ENV_PROXY: "1" }, []), false);
  assert.deepEqual(serviceProxyEnvironment({}, { recorded }), recorded);
  assert.equal(serviceProxyEnvironment({ HTTPS_PROXY: "http://new.invalid", NODE_USE_ENV_PROXY: "0", NODE_OPTIONS: "--use-env-proxy" }, { recorded }).NODE_USE_ENV_PROXY, "1");
});
