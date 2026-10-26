import { isAbsolute } from 'node:path';

export const INTERRUPT_TOOL = 'router_web_interrupt';
export const ADAPTER_HOOK_STATUS = 'Stopping ChatGPT Web generation through Router adapter';

// One trusted callback owns child draining, browser cancellation and readback.
// Leave 150 ms for the host callback, 350 ms for the native terminal receipt,
// and 100 ms between the browser script and its native execution allowance.
const hookTimeoutMs = 10_000, graceMs = hookTimeoutMs - 150, cleanupMs = graceMs - 350;
const scriptReturnMarginMs = 100;
export const STOP_BUDGET = Object.freeze({ hookTimeoutMs, graceMs, cleanupMs, scriptReturnMarginMs,
  scriptMs: cleanupMs - scriptReturnMarginMs, proofElapsedMs: hookTimeoutMs });

export function createAdapterHook() {
  return { type: 'mcp_tool', server: 'node_repl', tool: INTERRUPT_TOOL, input: {
    hook_event_name: '${hook_event_name}', session_id: '${session_id}', turn_id: '${turn_id}' },
  timeout: STOP_BUDGET.hookTimeoutMs / 1000, statusMessage: ADAPTER_HOOK_STATUS };
}

export const validAdapterThreadIds = value => value === null || Array.isArray(value) && value.length > 0
  && value.length <= 128 && value.every(id => typeof id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))
  && new Set(value).size === value.length;

export function createAdapterConfig({ server, serverSha256, stateDir, runtimeModule, sdkPackageJson, threadIds, receiptPath }) {
  return validateAdapterConfig({ version: 1, server, serverSha256, stateDir, runtimeModule, sdkPackageJson, threadIds, receiptPath });
}

export function validateAdapterConfig(value) {
  const fields = ['version', 'server', 'serverSha256', 'stateDir', 'runtimeModule', 'sdkPackageJson', 'threadIds', 'receiptPath'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
      || value.version !== 1 || !validAdapterThreadIds(value.threadIds) || !/^[a-f0-9]{64}$/u.test(value.serverSha256 ?? '')
      || ['server', 'stateDir', 'runtimeModule', 'sdkPackageJson', 'receiptPath'].some(key => typeof value[key] !== 'string'
        || !isAbsolute(value[key]) || value[key].includes('\0'))) throw new Error('config_refused');
  return value;
}

export const STOP_STAGES = Object.freeze(['scope', 'ledger', 'metadata', 'public_setup', 'browser_inventory', 'public_browser',
  'tab_inventory', 'public_tab', 'generation_proof', 'stop_visibility', 'mutation_url', 'stop_click',
  'stop_readback_visibility', 'handoff', 'complete']);
export const STOP_CODES = Object.freeze(['metadata_missing', 'metadata_mismatch', 'ledger_invalid', 'ledger_changed', 'ledger_unreadable',
  'registry_invalid', 'owner_mismatch', 'owner_changed', 'state_unavailable', 'controller_invalid', 'browser_ambiguous',
  'browser_mismatch', 'tab_ambiguous', 'tab_mismatch', 'tab_url_mismatch', 'generation_mismatch', 'stop_confirmation_failed', 'budget_exhausted',
  'hook_busy', 'hook_registry_invalid', 'browser_operation_failed']);
