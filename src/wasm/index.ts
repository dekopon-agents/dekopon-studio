import { evaluate, initSync } from './generated/policy';
import { policyBytes } from './generated/policy-bytes';
import type { PermissionRecord } from '../record';

let initialized = false;
export function whatIf(policy: PermissionRecord, principal: string, capability: string): { kind: 'gap'; reason: string; engine: string } {
  if (!initialized) {
    initSync({ module: Uint8Array.from(atob(policyBytes), ch => ch.charCodeAt(0)) });
    initialized = true;
  }
  // Bundle v1 never supplies a complete world. Do not assemble one from decisions,
  // an execution allowlist, prompt join lines, or defaults.
  const result: unknown = JSON.parse(evaluate(policy.policy.state === 'known' ? policy.policy.value : '', undefined,
    JSON.stringify({ principal, capability })));
  if (typeof result !== 'object' || result === null || !('kind' in result) || result.kind !== 'gap' ||
    !('reason' in result) || typeof result.reason !== 'string' || !('engine' in result) || typeof result.engine !== 'string')
    throw new Error('Unexpected policy bridge result');
  return { kind: 'gap', reason: result.reason, engine: result.engine };
}
