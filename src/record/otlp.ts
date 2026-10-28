import { array, Context, decode, field, integer, lines, object, parse, text, unknownFields } from './json';
import type { ObjectValue, Value } from './json';
import type { Location, SpanKey } from './types';

export interface Event {
  key: SpanKey; at: Location; name: string; time: string; origin: 'span' | 'log'; attributes: ObjectValue;
}
export interface Span {
  key: SpanKey; at: Location; parent: string; name: string; start: string; end: string; attributes: ObjectValue;
}
export interface Export { spans: Span[]; events: Event[] }
const arr = (o: ObjectValue, key: string, c: Context, at: Location) =>
  array(o[key] === undefined ? [] : o[key], c, field(at, key), 'otlp-shape');
const str = (o: ObjectValue, key: string, c: Context, at: Location) =>
  text(o[key] === undefined ? '' : o[key], c, field(at, key), 'otlp-scalar');
const nanos = (o: ObjectValue, key: string, c: Context, at: Location) =>
  integer(o[key] === undefined ? 0n : o[key], c, field(at, key), 'otlp-scalar', 0n, 18446744073709551615n, true);
function value(v: Value | undefined, c: Context, at: Location, depth: number): Value {
  if (depth > 32) c.fail('otlp-depth', at);
  const o = object(v, c, at, 'otlp-shape');
  const keys = Object.keys(o);
  if (!keys.length) return null;
  if (keys.length !== 1) c.fail('otlp-shape', at);
  const key = keys[0], inner = o[key], loc = field(at, key);
  switch (key) {
    case 'stringValue': case 'bytesValue': return text(inner, c, loc, 'otlp-scalar');
    case 'boolValue':
      if (typeof inner !== 'boolean') c.fail('otlp-scalar', loc);
      return inner;
    case 'intValue': return BigInt(integer(inner, c, loc, 'otlp-scalar', -9223372036854775808n, 9223372036854775807n, true));
    case 'doubleValue': {
      if (!['number', 'bigint', 'string'].includes(typeof inner) || typeof inner === 'string' && !inner.trim())
        c.fail('otlp-scalar', loc);
      if (typeof inner === 'string' && !/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(inner.trim()))
        c.fail('otlp-scalar', loc);
      const number = Number(inner);
      if (!Number.isFinite(number)) c.fail('otlp-scalar', loc);
      return number;
    }
    case 'arrayValue': {
      const a = object(inner, c, loc, 'otlp-shape'); unknownFields(a, ['values'], c, loc);
      return arr(a, 'values', c, loc).map(v => value(v, c, loc, depth + 1));
    }
    case 'kvlistValue': {
      const a = object(inner, c, loc, 'otlp-shape'); unknownFields(a, ['values'], c, loc);
      return attributes(arr(a, 'values', c, loc), c, loc, depth + 1);
    }
    default: c.note('unknown-variant', at, key); return null;
  }
}
function attributes(items: Value[], c: Context, at: Location, depth = 0): ObjectValue {
  return Object.fromEntries(items.map(item => {
    const o = object(item, c, at, 'otlp-shape');
    unknownFields(o, ['key', 'value'], c, at);
    const key = text(o.key, c, field(at, 'key'), 'otlp-scalar');
    return [key, value(o.value === undefined ? {} : o.value, c, field(at, key), depth)];
  }));
}
function attrs(o: ObjectValue, c: Context, at: Location) { return attributes(arr(o, 'attributes', c, at), c, at); }
function name(name: string, attributes: ObjectValue): string {
  for (const key of ['audit.event', 'event']) if (typeof attributes[key] === 'string' && attributes[key]) return attributes[key] as string;
  return name;
}
export function otlp(bytes: Uint8Array, path: string, logs: boolean, c: Context): Export {
  const result: Export = { spans: [], events: [] };
  for (const line of lines(bytes)) {
    const at = { path, line: line.line };
    const raw = decode(line.bytes, c, at);
    if (!raw.trim()) continue;
    const request = object(parse(raw, c, at), c, at, 'otlp-shape');
    const root = logs ? 'resourceLogs' : 'resourceSpans', scopes = logs ? 'scopeLogs' : 'scopeSpans';
    if (request[root] === undefined) c.fail('otlp-shape', at);
    unknownFields(request, [root], c, at);
    for (const resource of arr(request, root, c, at)) {
      const r = object(resource, c, at, 'otlp-shape');
      unknownFields(r, ['resource', scopes, 'schemaUrl'], c, at);
      const res = object(r.resource === undefined ? {} : r.resource, c, at, 'otlp-shape');
      unknownFields(res, ['attributes', 'droppedAttributesCount'], c, at);
      for (const key of Object.keys(attrs(res, c, at))) if (!['service.name', 'service.version', 'service.instance.id'].includes(key))
        c.note('unknown-field', field(at, 'resource.attributes'), key);
      for (const scope of arr(r, scopes, c, at)) {
        const s = object(scope, c, at, 'otlp-shape');
        unknownFields(s, ['scope', logs ? 'logRecords' : 'spans', 'schemaUrl'], c, at);
        const instrumentation = object(s.scope === undefined ? {} : s.scope, c, at, 'otlp-shape');
        unknownFields(instrumentation, ['name', 'version', 'attributes', 'droppedAttributesCount'], c, at);
        str(instrumentation, 'name', c, at);
        if (instrumentation.version !== undefined) str(instrumentation, 'version', c, at);
        for (const key of Object.keys(attrs(instrumentation, c, at))) c.note('unknown-field', field(at, 'scope.attributes'), key);
        for (const [index, item] of arr(s, logs ? 'logRecords' : 'spans', c, at).entries()) {
          const loc = field(at, (logs ? 'logRecords' : 'spans') + '[' + index + ']');
          const o = object(item, c, loc, 'otlp-shape'), attributes = attrs(o, c, loc);
          const key = { traceId: str(o, 'traceId', c, loc), spanId: str(o, 'spanId', c, loc) };
          if (logs) {
            unknownFields(o, ['traceId', 'spanId', 'timeUnixNano', 'observedTimeUnixNano', 'attributes',
              'body', 'severityText', 'severityNumber', 'flags', 'droppedAttributesCount', 'eventName'], c, loc);
            const body = value(o.body === undefined ? {} : o.body, c, loc, 0);
            if (o.severityText !== undefined) str(o, 'severityText', c, loc);
            result.events.push({ key, at: loc, name: name(typeof body === 'string' ? body : '', attributes),
              time: nanos(o, 'timeUnixNano', c, loc) === '0' ? nanos(o, 'observedTimeUnixNano', c, loc) : nanos(o, 'timeUnixNano', c, loc),
              origin: 'log', attributes });
          } else {
            unknownFields(o, ['traceId', 'spanId', 'parentSpanId', 'name', 'startTimeUnixNano', 'endTimeUnixNano',
              'attributes', 'events', 'status', 'kind', 'links', 'droppedAttributesCount', 'droppedEventsCount',
              'droppedLinksCount', 'flags', 'traceState'], c, loc);
            const status = object(o.status === undefined ? {} : o.status, c, loc, 'otlp-shape');
            unknownFields(status, ['code', 'message'], c, loc);
            if (status.message !== undefined) str(status, 'message', c, loc);
            if (status.code !== undefined) integer(status.code, c, loc, 'otlp-scalar', 0n, 2n);
            const span: Span = { key, at: loc, parent: str(o, 'parentSpanId', c, loc),
              name: str(o, 'name', c, loc), start: nanos(o, 'startTimeUnixNano', c, loc),
              end: nanos(o, 'endTimeUnixNano', c, loc), attributes };
            result.spans.push(span);
            for (const [index, raw] of arr(o, 'events', c, loc).entries()) {
              const eventAt = field(loc, 'events[' + index + ']');
              const e = object(raw, c, eventAt, 'otlp-shape');
              unknownFields(e, ['timeUnixNano', 'name', 'attributes', 'droppedAttributesCount'], c, eventAt);
              const attributes = attrs(e, c, eventAt);
              result.events.push({ key, at: eventAt, name: name(str(e, 'name', c, eventAt), attributes),
                time: nanos(e, 'timeUnixNano', c, eventAt), origin: 'span', attributes });
            }
          }
        }
      }
    }
  }
  return result;
}
