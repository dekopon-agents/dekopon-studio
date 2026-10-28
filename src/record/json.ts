import type { Fact, Gap, Json, Location, Note, ReadError } from './types';

export type Value = null | boolean | number | bigint | string | Value[] | ObjectValue;
export interface ObjectValue { [key: string]: Value }
export class Failure {
  constructor(readonly error: ReadError) {}
}
export class Context {
  readonly gaps: Gap[] = [];
  readonly notes: Note[] = [];
  fail(kind: ReadError['kind'], at: Location): never { throw new Failure({ kind, at }); }
  gap(kind: Exclude<Gap['kind'], 'journal-format' | 'summary-input-unavailable'>,
    at: Location, details: Omit<Extract<Gap, { attribute?: string }>, 'kind' | 'at'> = {}): Gap {
    const gap: Gap = { kind, at, ...details };
    this.gaps.push(gap);
    return gap;
  }
  unknown<T>(kind: Parameters<Context['gap']>[0], at: Location,
    details: Parameters<Context['gap']>[2] = {}): Fact<T> {
    return { state: 'unknown', gap: this.gap(kind, at, details) };
  }
  note(kind: Note['kind'], at: Location, name: string) { this.notes.push({ kind, at, name }); }
}
export const wellFormed = (value: string): boolean => !/[\uD800-\uDFFF]/u.test(value);
export const known = <T>(value: T): Fact<T> => ({ state: 'known', value });
export const field = (at: Location, name: string): Location => ({ ...at, field: at.field ? at.field + '.' + name : name });
export function object(value: Value | undefined, c: Context, at: Location, kind: ReadError['kind']): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) c.fail(kind, at);
  return value;
}
export function array(value: Value | undefined, c: Context, at: Location, kind: ReadError['kind']): Value[] {
  if (!Array.isArray(value)) c.fail(kind, at);
  return value;
}
export function text(value: Value | undefined, c: Context, at: Location, kind: ReadError['kind']): string {
  if (typeof value !== 'string' || !wellFormed(value)) c.fail(kind, at);
  return value;
}
export function integer(value: Value | undefined, c: Context, at: Location, kind: ReadError['kind'],
  min = 0n, max = 18446744073709551615n, strings = false): string {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (strings && typeof value === 'string' && /^-?[0-9]{1,20}$/.test(value)) n = BigInt(value);
  else return c.fail(kind, at);
  if (n < min || n > max) c.fail(kind, at);
  return n.toString();
}
export function decimal(value: Value | undefined): string | undefined {
  if (typeof value === 'bigint' && value >= 0n && value <= 18446744073709551615n) return value.toString();
  if (typeof value === 'string' && /^[0-9]{1,20}$/.test(value) && BigInt(value) <= 18446744073709551615n) return BigInt(value).toString();
}
export function unknownFields(o: ObjectValue, keys: readonly string[], c: Context, at: Location) {
  for (const key of Object.keys(o)) if (!keys.includes(key)) c.note('unknown-field', at, key);
}
export function decode(bytes: Uint8Array, c: Context, at: Location): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return c.fail('utf8', at); }
}
export function parse(raw: string, c: Context, at: Location): Value {
  try {
    return JSON.parse(raw, (_key: string, value: Value, context?: { source?: string }) => {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) c.fail('json', at);
        if (context?.source && /^-?[0-9]+$/.test(context.source)) return BigInt(context.source);
        if (!context?.source && Number.isInteger(value) && !Number.isSafeInteger(value)) c.fail('json', at);
      }
      if (typeof value === 'number' && !context?.source && Number.isSafeInteger(value)) return BigInt(value);
      return value;
    }) as Value;
  } catch (error) {
    if (error instanceof Failure) throw error;
    return c.fail('json', at);
  }
}
export function json(value: Value, safeNumbers = false): Json {
  if (typeof value === 'bigint') return safeNumbers && value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(v => json(v, safeNumbers));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v, safeNumbers)]));
  return value;
}
export function lines(bytes: Uint8Array): { bytes: Uint8Array; line: number; terminated: boolean }[] {
  const result = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
    result.push({ bytes: bytes.subarray(start, i + 1), line: result.length + 1, terminated: true });
    start = i + 1;
  }
  if (start < bytes.length) result.push({ bytes: bytes.subarray(start), line: result.length + 1, terminated: false });
  return result;
}
export function canonical(value: Value): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return typeof value === 'bigint' ? value.toString() : JSON.stringify(value);
}
