#!/usr/bin/env python3.12
"""Run ruled arms from an unchanged synthetic Studio seed, or make and run the reference seed."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from evalgw import arms, driver, scenario  # noqa: E402
from evalgw.bridge import SeedError, call  # noqa: E402
from evalgw.bundle import write_json  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('seed', type=Path, nargs='?')
    parser.add_argument('--reference', action='store_true', help='make the synthetic reference bundle and Studio-format seed first')
    parser.add_argument('--output', type=Path, required=True, help='new directory; never reused')
    parser.add_argument('--cache', type=Path, default=HERE / '.cache')
    parser.add_argument('--arm', action='append', choices=arms.ARM_IDS)
    args = parser.parse_args()
    if args.reference == (args.seed is not None):
        parser.error('choose one seed file or --reference')
    try:
        original = None
        seed_path = args.seed
        target = args.output
        if args.reference:
            target.mkdir(mode=0o700)
            fixture = HERE / 'scenarios/memory-reference.json'
            spec = scenario.load(fixture)
            original, original_grade = driver.run(fixture, target / 'original', args.cache)
            if original['completeness']['status'] != 'complete' or original['freeze'] is None:
                raise SeedError('Reference trial has no complete frozen bundle; original evidence retained')
            captured = call('bundle', target / 'original')['record']
            first = captured['journals'][0]
            outputs = [item['result'] for item in first['items'] if item['kind'] == 'exchange']
            if not outputs or not 200000 <= len(outputs[0].encode()) <= 225280 or not all(
                    r['summaries'] and all(slot['state'] == 'generated' for slot in r['summaries'])
                    for r in captured['journals']):
                raise SeedError('Reference journal lacks the large result or generated summary parts')
            seed_path = target / 'dekopon-seed-v1.json'
            exported = call('export', target / 'original', output=str(seed_path.resolve()),
                            continuationMessages=spec['continuationMessages'])
            report = {'seedDigest': exported['seedDigest'], 'original': {'manifest': original, 'grade': original_grade}}
            target = target / 'arms'
        else:
            report = {}
        results = arms.run(seed_path, target, args.cache, tuple(args.arm or arms.ARM_IDS))
        report['arms'] = results
        write_json(args.output / 'results.json', report)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 2 if any(r['grade']['status'] == 'infrastructure_error' for r in results) else \
               1 if any(r['grade']['status'] == 'failed' for r in results) else 0
    except (SeedError, ValueError, OSError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
