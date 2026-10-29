import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from evalgw import artifacts, projection, scenario as scenarios  # noqa: E402
from evalgw.arms import Restored  # noqa: E402
from evalgw.bridge import ROOT, Seed, SeedError  # noqa: E402


def assembled(scenario):
    return scenarios.assemble(scenario, Path('/synthetic/runtime'),
        providers={name: Path('/synthetic/cache') / artifacts.PROVIDERS[name].name for name in scenario['providers']},
        model_authority='127.0.0.1:4001', service_authority='127.0.0.1:4002',
        collector_endpoint='http://127.0.0.1:4003', uid=os.geteuid())


def make_seed():
    scenario = scenarios.load(ROOT / 'harness/scenarios/memory-reference.json')
    request = {'scenario': scenario, 'config': assembled(scenario),
               'dekopon': {'version': artifacts.DEKOPON_VERSION, 'source': artifacts.DEKOPON.source,
                           'artifact': {'name': artifacts.DEKOPON.name, 'version': artifacts.DEKOPON.version,
                                        'sha256': artifacts.DEKOPON.sha256, 'source': artifacts.DEKOPON.source}, 'binaries': {}},
               'providers': [{'id': name, 'name': artifacts.PROVIDERS[name].name, 'version': artifacts.PROVIDERS[name].version,
                              'source': artifacts.PROVIDERS[name].source, 'sha256': artifacts.PROVIDERS[name].sha256}
                             for name in scenario['providers']]}
    result = subprocess.run(['node', str(ROOT / 'harness/tests/make-seed.mjs')], input=json.dumps(request),
                            capture_output=True, text=True, cwd=ROOT, timeout=60, check=True)
    return base64.b64decode(result.stdout)


class SeedAndArmTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed_bytes = make_seed()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.path = self.root / 'dekopon-seed-v1.json'
        self.path.write_bytes(self.seed_bytes)
        self.seed = Seed.read(self.path)

    def tearDown(self):
        self.directory.cleanup()

    def test_exact_bytes_digest_and_unknown_field_note_follow_studio(self):
        envelope = json.loads(self.seed_bytes)
        envelope['future'] = {'value': 'synthetic future value'}
        raw = (' \n' + json.dumps(envelope, indent=2)).encode()
        self.path.write_bytes(raw)
        imported = Seed.read(self.path)
        self.assertEqual(imported.digest, hashlib.sha256(raw).hexdigest())
        self.assertNotEqual(imported.digest, self.seed.digest)
        self.assertTrue(any(n['kind'] == 'unknown-field' and n['name'] == 'future' for n in imported.record['notes']))
        self.assertNotIn('synthetic future value', json.dumps(imported.record))

    def test_seed_refusals_are_the_studio_importers_errors(self):
        for defect, expected in [('path', 'bundle-path'), ('base64', 'seed-base64'), ('freeze', 'seed-freeze')]:
            with self.subTest(defect=defect):
                envelope = json.loads(self.seed_bytes)
                if defect == 'path':
                    envelope['files'][0]['path'] = '../manifest.json'
                elif defect == 'base64':
                    envelope['files'][0]['base64'] = 'Zh=='
                else:
                    ref = next(f for f in envelope['files'] if f['path'] == 'manifest.json')
                    manifest = json.loads(base64.b64decode(ref['base64']))
                    manifest['freeze'] = None
                    ref['base64'] = base64.b64encode(json.dumps(manifest).encode()).decode()
                self.path.write_text(json.dumps(envelope))
                with self.assertRaises(SeedError) as raised:
                    Seed.read(self.path)
                self.assertEqual(raised.exception.errors[0]['kind'], expected)

    def test_journal_is_staged_verbatim_and_an_edit_is_refused(self):
        restored = Restored(self.seed, 'live-policy')
        runtime = self.root / 'runtime'; runtime.mkdir(mode=0o700)
        restored.stage(runtime)
        path = self.seed.json('manifest.json')['journal']['files'][0]['path']
        self.assertEqual((runtime / path).read_bytes(), self.seed.files[path])
        with (runtime / path).open('ab') as handle:
            handle.write(b'\n')
        with self.assertRaises(SeedError):
            restored.verify_staged(runtime)
        self.assertEqual(self.seed.digest, hashlib.sha256(self.seed_bytes).hexdigest())

    def test_ruled_arms_change_only_the_named_knobs(self):
        base = self.seed.json('config/gateway.json')['routes'][0]['memory']
        for arm in ('live-policy', 'decider', 'summaries-preferred'):
            with self.subTest(arm=arm):
                restored = Restored(self.seed, arm)
                config = restored.apply(assembled(restored.scenario))
                memory = config['gateway']['routes'][0]['memory']
                self.assertEqual(memory['summaries'], base['summaries'])
                self.assertEqual(memory['hotTurns'], 1 if arm == 'summaries-preferred' else base['hotTurns'])
                self.assertEqual(memory['selection'], {'decider': {'capability': 'decide.choose', 'backend': 'openrouter-jev',
                    'model': 'typesafe/jev-1.13', 'requireProbabilities': True}} if arm == 'decider' else base['selection'])
                self.assertEqual(config['catalog'], self.seed.json('config/catalog.json'))
                self.assertEqual(config['policies'].encode(), self.seed.files['config/policies.cedar'])

    def test_policy_catalog_grant_and_horizon_changes_are_refused(self):
        restored = Restored(self.seed, 'live-policy')
        for defect in ('policy', 'catalog', 'grant', 'horizon'):
            with self.subTest(defect=defect):
                config = assembled(restored.scenario)
                if defect == 'policy':
                    config['policies'] += '\nforbid(principal, action, resource);'
                elif defect == 'catalog':
                    config['catalog']['spec']['instructions'] = 'different synthetic instructions'
                elif defect == 'grant':
                    config['broker']['capabilities']['gh']['constraints']['http']['allowedMethods'] = ['POST']
                else:
                    config['gateway']['routes'][0]['memory']['forgetAfterMs'] = 1
                with self.assertRaises(SeedError):
                    restored.apply(config)

    def test_frozen_plans_and_first_projection_are_checked_against_actual_input(self):
        restored = Restored(self.seed, 'summaries-preferred')
        config = assembled(restored.scenario)
        plan = projection.expected(self.seed, config, 1000)
        self.assertEqual([r['expectedRung'] for r in plan['records']], ['summary-1', 'summary-1', 'summary-1', 'native'])
        call = {'key': {'traceId': 'synthetic', 'spanId': 'call'}, 'startedAt': '1000000000', 'completionSpans': [{'traceId': 'synthetic', 'spanId': 'complete'}],
                'input': {'state': 'known', 'value': {'messages': plan['history'] + [{'role': 'user', 'content': '[gateway: authenticated participant: ' + restored.original['subject']['principal'] + ']\n' + self.seed.messages[0]['text']}]}}}
        event = {'name': 'gateway_memory_projection', 'attributes': {
            **{'memory.rung.' + key: str(value) for key, value in plan['rungCounts'].items()}, 'memory.bytes': str(plan['bytes'])}}
        trial = {'messages': [{'calls': [call], 'evidence': [event]}]}
        matched = projection.compare(self.seed, config, trial)
        self.assertEqual(matched['status'], 'matched')
        self.assertIsNone(matched['observedRecordIds'])
        event['attributes']['memory.rung.native'] = True
        self.assertEqual(projection.compare(self.seed, config, trial)['status'], 'mismatch')
        event['attributes']['memory.rung.native'] = '1'
        call['completionSpans'] = []
        self.assertEqual(projection.compare(self.seed, config, trial)['reason'], 'first_model_complete_missing')
        call['completionSpans'] = [{'traceId': 'synthetic', 'spanId': 'complete'}]
        call['input']['value']['messages'][-1]['content'] += 'wrong continuation'
        self.assertEqual(projection.compare(self.seed, config, trial)['status'], 'mismatch')
        call['input']['value']['messages'][0]['content'] += 'wrong frozen content'
        self.assertEqual(projection.compare(self.seed, config, trial)['status'], 'mismatch')
        call['input'] = {'state': 'unknown'}
        self.assertEqual(projection.compare(self.seed, config, trial)['status'], 'unavailable')

    def test_empty_continuations_do_not_invent_a_first_projection(self):
        envelope = json.loads(self.seed_bytes); envelope['continuationMessages'] = []
        self.path.write_text(json.dumps(envelope))
        seed = Seed.read(self.path)
        restored = Restored(seed, 'live-policy')
        self.assertEqual(restored.scenario['messages'], [])
        self.assertEqual(restored.scenario['expect']['rules'], [])
        self.assertEqual(projection.compare(seed, assembled(restored.scenario), {'messages': []})['reason'], 'no_continuations')

    def test_window_fit_omissions_are_named_and_required_in_the_notice(self):
        restored = Restored(self.seed, 'live-policy')
        config = assembled(restored.scenario)
        config['gateway']['routes'][0]['memory']['maxBytes'] = 1
        plan = projection.expected(self.seed, config, 1000)
        self.assertTrue(all(r['expectedRung'] is None and r['omission'] == 'WindowFit' for r in plan['records']))
        trial = {'messages': [{'calls': [{'key': {'traceId': 'synthetic', 'spanId': 'call'}, 'startedAt': '1000000000', 'completionSpans': [{'traceId': 'synthetic', 'spanId': 'complete'}],
            'input': {'state': 'known', 'value': {'messages': [
                {'role': 'system', 'content': 'Omitted window-fit: 1, 2, 3, 4.\n'},
                {'role': 'user', 'content': '[gateway: authenticated participant: ' + restored.original['subject']['principal'] + ']\n' + self.seed.messages[0]['text']}]}}}], 'evidence': [
                {'name': 'gateway_memory_projection', 'attributes': {
                    'memory.rung.native': '0', 'memory.rung.summary': '0', 'memory.rung.metadata': '0', 'memory.bytes': '0'}}]}]}
        self.assertEqual(projection.compare(self.seed, config, trial)['status'], 'matched')
        trial['messages'][0]['calls'][0]['input']['value']['messages'][0]['content'] = ''
        self.assertEqual(projection.compare(self.seed, config, trial)['status'], 'mismatch')

    def test_prefix_never_splits_a_json_escape_or_utf8_character(self):
        encoded = json.dumps('a\né\\"\x01z', ensure_ascii=False)[1:-1].encode()
        for limit in range(len(encoded) + 1):
            with self.subTest(limit=limit):
                result = projection.prefix(encoded, limit)
                self.assertLessEqual(len(result), limit)
                json.loads(b'"' + result + b'"')
