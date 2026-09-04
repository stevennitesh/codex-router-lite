import { readFileSync } from "node:fs";

import { INSTALL_MANIFEST_PATH } from "./paths.mjs";

const PROXY_ENVIRONMENT_VARIABLES = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
];

// Node's built-in proxy support is deliberately opt-in. Keep the same
// contract when the router installs its own HTTP/1.1 dispatcher: merely
// inheriting HTTP(S)_PROXY from a shell must not silently reroute traffic.
// `--use-env-proxy` is allowed in NODE_OPTIONS on supported Node releases;
// process.execArgv covers the equivalent direct command-line form.
export function environmentProxyOptedIn(
  environment = process.env,
  execArgv = process.execArgv,
) {
  if (Array.isArray(execArgv) && execArgv.includes("--use-env-proxy")) return true;
  if (/(^|\s)--use-env-proxy(?:\s|$)/.test(String(environment.NODE_OPTIONS || ""))) {
    return true;
  }
  return environment.NODE_USE_ENV_PROXY === "1";
}

// Match EnvHttpProxyAgent's precedence exactly: a present lowercase value,
// including an empty string, overrides its uppercase counterpart. ALL_PROXY
// is preserved for child processes but is not supported by EnvHttpProxyAgent.
export function environmentHttpProxyConfigured(
  environment = process.env,
  execArgv = process.execArgv,
) {
  if (!environmentProxyOptedIn(environment, execArgv)) return false;
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY;
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY;
  return Boolean(httpProxy || httpsProxy);
}

// Which variables actually name a proxy. `no_proxy` is deliberately absent: it
// lists hosts to *bypass* and says nothing about which proxy to use, or whether
// to use one at all.
const PROXY_ADDRESS_VARIABLES = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
];

// An environment that names no proxy at all is silent, not a decision. Naming
// one -- or naming `NODE_USE_ENV_PROXY`, including as 0, which is how a proxy
// gets turned back off -- is the operator speaking and outranks whatever a
// previous install recorded.
//
// A bypass list on its own is not that statement. Treating it as one can erase
// the proxy from a Windows app launch that inherited only `no_proxy`, then
// record the damage as authoritative state.
//
// An empty value is read the same way, for the same reason: a login session
// that exports `HTTP_PROXY=` has not chosen to stop proxying.
function proxyEnvironmentDeclared(
  environment = process.env,
  execArgv = process.execArgv,
) {
  if (environmentProxyOptedIn(environment, execArgv)) return true;
  if (environment.NODE_USE_ENV_PROXY !== undefined) return true;
  return PROXY_ADDRESS_VARIABLES.some((name) => Boolean(environment[name]));
}

// The proxy settings the last install committed to the service.
//
// Install and repair may run without the configured proxy in their environment,
// especially when launched from the Windows Codex app. Restore the recorded
// values so the service does not silently lose its upstream connection.
//
// This reads the manifest file directly rather than through
// install-manifest.mjs, which would import this module back and drag its
// install-time dependencies into every process that merely resolves a proxy.
function recordedProxyEnvironment(manifestPath = INSTALL_MANIFEST_PATH) {
  let recorded;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed?.version !== 1) return undefined;
    recorded = parsed.current?.proxyEnvironment;
  } catch {
    return undefined;
  }
  if (!recorded || typeof recorded !== "object") return undefined;
  const values = {};
  for (const name of PROXY_ENVIRONMENT_VARIABLES) {
    if (typeof recorded[name] === "string") values[name] = recorded[name];
  }
  return Object.keys(values).length ? values : undefined;
}

// Proxy variables the service carries but the router will never use.
//
// Node's proxy support is opt-in, so a service installed with HTTP_PROXY and
// no NODE_USE_ENV_PROXY looks correctly configured at every glance -- the
// variables are right there in the service definition -- and still dials every
// upstream directly. On a network that requires the proxy the failure surfaces
// much later as a router 502 naming a connect timeout, with nothing near the
// cause pointing back at the missing opt-in.
//
// This reports the state rather than assuming intent: proxy variables that are
// deliberately ignored are a defensible setup, just never an obvious one.
// `@` before the first `/` is userinfo; after it, it is part of a path and
// must be left alone. Proxy variables also hold bare `host:port` values and
// comma-separated bypass lists, so this deliberately does not go through URL
// parsing, which would reject them.
function redactUserinfo(value) {
  const scheme = value.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  const rest = scheme ? scheme[2] : value;
  const at = rest.indexOf("@");
  if (at === -1) return value;
  const slash = rest.indexOf("/");
  if (slash !== -1 && slash < at) return value;
  return `${scheme ? scheme[1] : ""}[REDACTED]@${rest.slice(at + 1)}`;
}

// Startup diagnostics show the restored proxy host and port. Strip URL
// credentials before writing that address to stderr.
export function redactProxyCredentials(values) {
  if (!values || typeof values !== "object") return values;
  const output = {};
  for (const [name, value] of Object.entries(values)) {
    output[name] = typeof value === "string" ? redactUserinfo(value) : value;
  }
  return output;
}

// Background service managers do not read a user's shell startup files. Keep
// the proxy environment present during installation so the router and the
// child processes it launches see the same network policy after a restart.
export function serviceProxyEnvironment(
  environment = process.env,
  { recorded, manifestPath } = {},
) {
  // install.ps1 renders the service before rewriting the manifest, so these
  // values still describe the previous installation at this point.
  const preserved = recorded !== undefined ? recorded : recordedProxyEnvironment(manifestPath);
  if (!proxyEnvironmentDeclared(environment)) {
    if (preserved) return { ...preserved };
  }
  const values = {};
  for (const name of PROXY_ENVIRONMENT_VARIABLES) {
    if (environment[name] !== undefined) values[name] = environment[name];
  }
  // A command-line flag is not automatically present in the environment of a
  // later Task Scheduler invocation. Persist the equivalent
  // environment opt-in so the service and every Node child retain the same
  // decision after the installer exits. A positive CLI/NODE_OPTIONS opt-in
  // wins over NODE_USE_ENV_PROXY=0, matching Node's precedence.
  if (environmentProxyOptedIn(environment)) values.NODE_USE_ENV_PROXY = "1";
  else if (
    environment.NODE_USE_ENV_PROXY === undefined
    && preserved?.NODE_USE_ENV_PROXY === "1"
    && (values.http_proxy ?? values.HTTP_PROXY ?? values.https_proxy ?? values.HTTPS_PROXY)
  ) {
    // The address and the permission to use it are separate answers, and an
    // ordinary shell only ever gives the first: exporting HTTP_PROXY says
    // nothing about NODE_USE_ENV_PROXY. Reading that silence as "stop using
    // the proxy this service was installed with" reinstates the original bug
    // from a terminal -- the variables stay in the service, quietly ignored.
    // Naming NODE_USE_ENV_PROXY at all, including as 0, still decides it.
    values.NODE_USE_ENV_PROXY = "1";
  }
  return values;
}

// The proxy environment a router process should adopt when its own is silent.
//
// `serviceProxyEnvironment` keeps the proxy alive across restarts by writing it
// into the service definition, which covers every Task Scheduler start.
// Nothing covers a router started another way, such as a foreground debugging
// run from a terminal. Such a process inherits the
// caller's environment, finds no opt-in, dials every upstream directly, and
// times out on a network that requires the proxy. The 502 surfaces far from
// the cause and names an opt-in the operator can prove is already set, because
// it is set -- in the service definition, not in this process.
//
// Silence is the only trigger. `proxyEnvironmentDeclared` treats a named proxy
// or any `NODE_USE_ENV_PROXY`, including `0`, as the operator speaking, so a
// deliberate unproxied run stays unproxied.
export function inheritedProxyEnvironment(
  environment = process.env,
  { recorded, manifestPath, execArgv } = {},
) {
  if (proxyEnvironmentDeclared(environment, execArgv ?? process.execArgv)) return {};
  const preserved = recorded !== undefined ? recorded : recordedProxyEnvironment(manifestPath);
  return preserved ? { ...preserved } : {};
}
