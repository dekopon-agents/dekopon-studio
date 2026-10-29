"""First cold projection at v0.70.0, from validated Studio records and frozen byte slices.

The policy follows gatewayd memory/project.rs at 2e0a3986. This is a comparison
oracle, not a journal reader: all envelopes, indexes, slots and joins come from src/record.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import re
from functools import cache
from typing import Any

from .bridge import Seed, SeedError
from .evidence import decimal


def prefix(raw: bytes, limit: int) -> bytes:
    """A JSON-string slice ending at a complete escape and UTF-8 boundary."""
    end = min(len(raw), max(0, limit))
    if end == len(raw):
        return raw
    index = 0
    while index < end:
        byte = raw[index]
        if byte == 92:
            width = 6 if raw[index + 1:index + 2] == b'u' else 2
        else:
            width = 1 if byte < 128 else 2 if byte < 224 else 3 if byte < 240 else 4
        if index + width > end:
            return raw[:index]
        index += width
    return raw[:end]


def native(raw: bytes, record: dict[str, Any], share: int) -> tuple[list[dict[str, Any]], int]:
    spans = record['spans']
    fields = {(s['item'], s['field']): (int(s['relOffset']), int(s['len'])) for s in spans}
    size = sum(int(s['len']) for s in spans if s['field'] in ('User', 'Steer', 'Assistant'))
    left = max(0, share - size)
    messages: list[dict[str, Any]] = []
    content = None
    calls: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal content, calls, results
        if content is not None or calls:
            message: dict[str, Any] = {'role': 'assistant', 'content': content}
            if calls:
                message['tool_calls'] = calls
            messages.append(message)
        messages.extend(results)
        content, calls, results = None, [], []

    def field(index: str, name: str) -> bytes:
        start, length = fields[index, name]
        return raw[start:start + length]

    for item in record['items']:
        kind = item['kind']
        if kind in ('user', 'steer'):
            flush()
            messages.append({'role': 'user', 'content': item['text']})
        elif kind == 'assistant':
            if content is not None or calls:
                flush()
            content = item['text']
        elif kind == 'exchange':
            if item['tool'] != 'Bash':
                raise SeedError('First-projection native tool mapping unavailable')
            arguments = field(item['item'], 'Arguments')
            try:
                is_object = isinstance(json.loads(item['arguments']), dict)
            except ValueError:
                is_object = False
            if len(arguments) <= left and is_object:
                argument_text = item['arguments']
                left -= len(arguments)
                size += len(arguments)
            else:
                argument_text = json.dumps({'cut': len(item['arguments'].encode())}, separators=(',', ':'))
                size += len(argument_text.encode())
            result = prefix(field(item['item'], 'Result'), left)
            left -= len(result)
            size += len(result)
            calls.append({'id': item['callId'], 'type': 'function', 'function': {
                'name': item['tool'].lower(), 'arguments': argument_text}})
            results.append({'role': 'tool', 'tool_call_id': item['callId'],
                            'content': json.loads(b'"' + result + b'"')})
        elif kind == 'reasoning':
            if content is not None or calls:
                flush()
        else:
            raise SeedError(f"First-projection comparison unavailable for {kind}")
    flush()
    return messages, size


def ladder(record: dict[str, Any]) -> list[str]:
    return ['native', *[f'summary-{i+1}' for i, s in reversed(list(enumerate(record['summaries'])))
                       if s['state'] == 'generated'], 'metadata']


def envelope(raw: bytes, record: dict[str, Any], rung: str) -> str:
    time = datetime.datetime.fromtimestamp(int(record['atMs']) / 1000, datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    if rung.startswith('summary-'):
        part = int(rung.split('-')[1])
        detail = f"summary {part}/{len(record['summaries'])}"
    else:
        detail = f"{len({s['item'] for s in record['spans']})} items · {len(raw)} B"
    text = f"[memory #{record['key']['recordId']} · {time} · {detail}]"
    if rung.startswith('summary-'):
        text += '\n' + '\n'.join(s['text'] for s in record['summaries'][:part] if s['state'] == 'generated')
    for item in record['items']:
        if item['kind'] == 'exchange':
            outcome = item['outcome']
            label = f"exit {outcome['Exit']}" if isinstance(outcome, dict) and 'Exit' in outcome else str(outcome).lower()
            text += f"\n[tool: {item['tool'].lower()}, {label}]"
    return text


def expected(seed: Seed, config: dict[str, Any], now_ms: int) -> dict[str, Any]:
    gateway = config['gateway']
    route = gateway['routes'][0]
    memory = route['memory']
    agent = gateway.get('sessions', {}).get('memory', {}).get('agents', {}).get(route['agent'], {})
    max_turns = memory.get('maxTurns', 12)
    max_bytes = memory.get('maxBytes', 524288)
    hot = memory.get('hotTurns', agent.get('hotTurns', min(10, max_turns)))
    retention = gateway.get('sessions', {}).get('memory', {}).get('retention', {})
    age = agent.get('retention', {}).get('maxAgeMs', retention.get('maxAgeMs', 604800000))
    horizon = now_ms - min(age, memory.get('forgetAfterMs', 604800000))
    records = seed.record['journals']
    if len({(r['key']['agent'], r['key']['stem']) for r in records}) != 1:
        raise SeedError('First-projection comparison requires one captured conversation')
    omissions: dict[str, str] = {}
    grant = records[-1]['grant'] if records else []
    eligible = []
    trailing = True
    for record in reversed(records):
        rid = record['key']['recordId']
        if len(eligible) >= 2 * max_turns + 1:
            omissions[rid] = 'RecallWindow'
        elif not trailing:
            omissions[rid] = 'AdmissionBoundary'
        elif record['grant'] != grant or int(record['atMs']) < horizon:
            trailing = False
            omissions[rid] = 'GrantBoundary' if record['grant'] != grant else 'Horizon'
        else:
            eligible.append(record)
    eligible.reverse()
    lines = {path: seed.files[path].splitlines(keepends=True) for path in {r['at']['path'] for r in eligible}}
    bodies = [lines[r['at']['path']][r['at']['line'] - 2] for r in eligible]
    native_views = [native(raw, record, max_bytes // hot) for raw, record in zip(bodies, eligible)]
    ladders = [ladder(record) for record in eligible]
    cold_from = max(0, len(eligible) - hot)
    rungs: list[str | None] = []
    for index, record in enumerate(eligible):
        available = ladders[index]
        if index >= cold_from:
            rungs.append('native')
        else:
            pin, choice = record['pin'], record['choice']
            if pin['state'] != 'known' or choice['state'] != 'known':
                raise SeedError('Frozen pin or choice is unknown')
            rungs.append(next((r for r in [pin['value'], choice['value'], *available[1:-1], 'native']
                               if r in available), 'native'))

    @cache
    def rendered(index: int, rung: str) -> str:
        return envelope(bodies[index], eligible[index], rung)

    @cache
    def cost(index: int, rung: str | None) -> int:
        if rung is None:
            return 0
        return native_views[index][1] if rung == 'native' else len(rendered(index, rung).encode()) + 1

    total = sum(cost(i, rung) for i, rung in enumerate(rungs))

    def select(index: int, rung: str | None) -> None:
        nonlocal total
        total += cost(index, rung) - cost(index, rungs[index])
        rungs[index] = rung

    repacked = total > max_bytes or len(eligible) >= 2 * max_turns
    if repacked:
        for index in range(max(0, len(eligible) - max_turns)):
            select(index, None)
        for index in range(len(eligible)):
            while total > max_bytes * 3 // 4 and rungs[index] is not None:
                available = ladders[index]
                at = available.index(rungs[index]) + 1
                select(index, available[at] if index < cold_from and at < len(available) else None)
            if total <= max_bytes * 3 // 4:
                break
    history = []
    earlier = []
    rows = []
    for index, (record, rung) in enumerate(zip(eligible, rungs)):
        rid = record['key']['recordId']
        if rung is None:
            omissions[rid] = 'WindowFit'
        elif rung == 'native':
            history.extend(native_views[index][0])
        else:
            earlier.append('\n' + rendered(index, rung))
        rows.append({'key': record['key'], 'expectedRung': rung, 'omission': omissions.get(rid),
                     'expectedMessages': native_views[index][0] if rung == 'native' else []})
    if earlier:
        history.insert(0, {'role': 'user', 'content': '[gateway: earlier conversation]' + ''.join(earlier)})
    present = {r['key']['recordId'] for r in eligible}
    rows.extend({'key': r['key'], 'expectedRung': None, 'omission': omissions[r['key']['recordId']]}
                for r in records if r['key']['recordId'] not in present)
    return {'history': history, 'records': rows, 'repacked': repacked,
            'recordIds': [r['key']['recordId'] for r, rung in zip(eligible, rungs) if rung is not None],
            'bytes': total,
            'rungCounts': {'native': rungs.count('native'),
                           'summary': sum(bool(r and r.startswith('summary-')) for r in rungs),
                           'metadata': rungs.count('metadata')}}


def compare(seed: Seed, config: dict[str, Any], trial: dict[str, Any]) -> dict[str, Any]:
    messages = trial['messages']
    if not seed.messages:
        return {'status': 'unavailable', 'reason': 'no_continuations', 'records': []}
    if not messages or not messages[0]['calls']:
        return {'status': 'unavailable', 'reason': 'first_model_call_missing', 'records': []}
    call = messages[0]['calls'][0]
    if not call.get('completionSpans'):
        return {'status': 'unavailable', 'reason': 'first_model_complete_missing', 'records': []}
    if call['input']['state'] != 'known':
        return {'status': 'unavailable', 'reason': 'first_model_input_unavailable', 'records': []}
    plan = expected(seed, config, int(call['startedAt']) // 1000000)
    raw = call['input']['value']['messages']
    actual = [m for m in raw if m.get('role') != 'system']
    if not actual or actual[-1].get('role') != 'user':
        return {'status': 'unavailable', 'reason': 'continuation_frame_missing', 'records': plan['records']}
    principal = seed.json('config/scenario.json')['subject']['principal']
    current_matches = actual[-1].get('content') == f'[gateway: authenticated participant: {principal}]\n' + seed.messages[0]['text']
    actual = actual[:-1]
    expected_history = plan.pop('history')
    # Empty tool-call arrays and absent assistant content serialize identically at this seam.
    def canonical(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{k: v for k, v in m.items() if not (k == 'tool_calls' and not v) and
                 not (k == 'content' and v is None)} for m in history]
    matched = current_matches and canonical(actual) == canonical(expected_history)
    evidence = [e for e in messages[0]['evidence'] if e['name'] == 'gateway_memory_projection']
    attributes = evidence[0]['attributes'] if len(evidence) == 1 else {}
    observed = attributes.get('memory.record.ids')
    observed_counts = {name: attributes.get('memory.rung.' + name) for name in ('native', 'summary', 'metadata')}
    matched = matched and all(decimal(value) == plan['rungCounts'][name]
                              for name, value in observed_counts.items())
    matched = matched and decimal(attributes.get('memory.bytes')) == plan['bytes']
    if observed is not None:
        matched = matched and observed == plan['recordIds']
    notice = '\n'.join(m.get('content', '') for m in raw if m.get('role') == 'system')
    omitted = set()
    for group in re.findall(r'Omitted window-fit: ([^\n]+)\.', notice):
        omitted.update(re.findall(r'\d+', group))
    matched = matched and all(r['key']['recordId'] in omitted for r in plan['records'] if r['omission'] == 'WindowFit')
    for row in plan['records']:
        row.pop('expectedMessages', None)
        row['observedRung'] = row['expectedRung'] if matched else None
        row['attribution'] = 'reconstructed-from-exact-replay' if matched else 'unavailable'
        row['matches'] = matched
    return {**plan, 'status': 'matched' if matched else 'mismatch', 'modelCall': call['key'],
            'seedDigest': seed.digest, 'observedRecordIds': observed, 'observedRungCounts': observed_counts, 'currentMessageMatches': current_matches,
            'expectedInputDigest': hashlib.sha256(json.dumps(canonical(expected_history), sort_keys=True).encode()).hexdigest(),
            'observedInputDigest': hashlib.sha256(json.dumps(canonical(actual), sort_keys=True).encode()).hexdigest(),
            'reason': None if matched else 'frozen_projection_does_not_match_first_model_input'}
