"""The ruled arms restore one unchanged synthetic Studio seed through the existing driver."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import artifacts, projection, scenario as scenarios
from .bridge import Seed, SeedError, call
from .bundle import sha256

ARM_IDS = ('live-policy', 'decider', 'summaries-preferred')
DECIDER = {'decider': {'capability': 'decide.choose', 'backend': 'openrouter-jev',
                       'model': 'typesafe/jev-1.13', 'requireProbabilities': True}}


def knobs(memory: dict[str, Any], arm: str) -> None:
    if arm == 'summaries-preferred':
        memory['hotTurns'] = 1
    elif arm == 'decider':
        memory['selection'] = copy.deepcopy(DECIDER)
    elif arm != 'live-policy':
        raise SeedError(f'Unknown ruled arm: {arm}')


def port(url: str, suffix: str = '') -> int:
    value = urlsplit(url)
    if value.scheme != 'http' or value.hostname != '127.0.0.1' or not value.port or \
            value.username or value.password or value.path != suffix or value.query or value.fragment:
        raise SeedError('Executable seeds require loopback fixture endpoints')
    return value.port


def normalized(config: dict[str, Any]) -> dict[str, Any]:
    value = copy.deepcopy(config)
    broker, gateway = value['broker'], value['gateway']
    broker['socketPath'] = '@broker-socket'
    broker['policiesPath'] = '@policy-file'
    broker['providers'] = [f'@provider-{i}' for i in range(len(broker['providers']))]
    for identity in broker['identities']:
        identity['uid'] = '@operator-uid'
    gateway['broker'].update(socketPath='@broker-socket', serverUid='@operator-uid')
    gateway['catalogPath'] = '@catalog-file'
    for transport in gateway['transports']:
        transport['socketPath'] = '@local-socket'
    gateway['sessions']['journal']['path'] = '@journal-root'
    gateway['sessions']['assets']['path'] = '@asset-root'
    for section in (broker, gateway):
        section['telemetry']['endpoint'] = '@collector-endpoint'
    return value


class Restored:
    def __init__(self, seed: Seed, arm: str) -> None:
        if arm not in ARM_IDS:
            raise SeedError(f'Unknown ruled arm: {arm}')
        self.seed, self.arm_id = seed, arm
        self.seed_digest = seed.digest
        self.manifest = seed.json('manifest.json')
        self.original = seed.json('config/scenario.json')
        scenarios.validate(self.original)
        captured_driver = seed.json('driver.json')
        if not all(isinstance(captured_driver.get('fixtures', {}).get(name), dict) for name in ('model', 'service')) or \
                captured_driver.get('attempt') != self.manifest['attempt']['id'] or \
                [m.get('text') for m in captured_driver.get('messages', [])] != [m['text'] for m in self.original['messages']]:
            raise SeedError('Executable synthetic seeds require the harness scenario and fixture evidence')
        if self.manifest['dekopon']['version'] != artifacts.DEKOPON_VERSION or \
                self.manifest['dekopon'].get('artifact', {}).get('sha256') != artifacts.DEKOPON.sha256:
            raise SeedError('Restoration requires the pinned v0.70.0 journal format and release')
        expected_providers = [{'id': name, 'name': artifacts.PROVIDERS[name].name,
                               'version': artifacts.PROVIDERS[name].version, 'source': artifacts.PROVIDERS[name].source,
                               'sha256': artifacts.PROVIDERS[name].sha256} for name in self.original['providers']]
        if self.manifest['providers'] != expected_providers:
            raise SeedError('Seed provider identities differ from the installed synthetic fixture')
        self.source_config = {name: seed.json('config/' + name + '.json') for name in ('catalog', 'broker', 'gateway')}
        self.source_config['policies'] = seed.files['config/policies.cedar'].decode('utf-8')
        gateway = self.source_config['gateway']
        broker = self.source_config['broker']
        self.model_port = port(gateway['models'][0]['endpoint'], '/v1')
        if any(port(model['endpoint'], '/v1') != self.model_port for model in gateway['models']):
            raise SeedError('Seed models must use the same loopback stub')
        origins = [broker['providerSettings'][name]['baseUrl'] for name in self.original['providers']]
        self.service_port = port(origins[0]) if origins else 0
        if any(port(origin) != self.service_port for origin in origins):
            raise SeedError('Seed providers must use the same loopback fixture service')
        for name, path in zip(self.original['providers'], broker['providers'], strict=True):
            if Path(path).name != artifacts.PROVIDERS[name].name:
                raise SeedError('Recorded provider runtime paths do not identify the pinned providers')
        base = scenarios.assemble(self.original, Path('/synthetic/runtime'),
                                  providers={name: Path('/synthetic/cache') / artifacts.PROVIDERS[name].name
                                             for name in self.original['providers']},
                                  model_authority=f'127.0.0.1:{self.model_port}',
                                  service_authority=f'127.0.0.1:{self.service_port}',
                                  collector_endpoint='http://127.0.0.1:1', uid=os.geteuid())
        if normalized(base) != normalized(self.source_config):
            raise SeedError('Seed catalog, policy, grant, configuration or horizon differs from its synthetic fixture')
        if arm == 'decider' and 'decide' not in self.original['providers']:
            raise SeedError('The common seed must already grant and pin the decider provider')
        self.scenario = copy.deepcopy(self.original)
        self.scenario['messages'] = copy.deepcopy(seed.messages)
        self.scenario['model']['completions'] = copy.deepcopy(self.original['model'].get('continuations', []))
        self.scenario['expect']['rules'] = [copy.deepcopy(rule) for rule in self.original['expect'].get('continuationRules', [])
                                             if rule['message'] <= len(seed.messages)]
        knobs(self.scenario['gateway']['route']['memory'], arm)
        scenarios.validate(self.scenario, allow_empty=True)
        self.config: dict[str, Any] | None = None

    def apply(self, config: dict[str, Any]) -> dict[str, Any]:
        expected = copy.deepcopy(self.source_config)
        knobs(expected['gateway']['routes'][0]['memory'], self.arm_id)
        if normalized(config) != normalized(expected):
            raise SeedError('Arm changed something outside hotTurns, summaries and selection or runtime locations')
        self.config = copy.deepcopy(config)
        return config

    def stage(self, runtime: Path) -> None:
        for reference in self.manifest['journal']['files']:
            relative = reference['path']
            if relative not in self.seed.files:
                continue
            destination = runtime / relative
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as handle:
                handle.write(self.seed.files[relative])
        self.verify_staged(runtime)

    def verify_staged(self, runtime: Path) -> None:
        for reference in self.manifest['journal']['files']:
            relative = reference['path']
            if relative in self.seed.files and sha256(runtime / relative) != reference['sha256']:
                raise SeedError('A staged journal edit is a different experiment and is refused')

    def check(self, root: Path) -> dict[str, Any]:
        try:
            if self.config is None:
                raise SeedError('Arm configuration unavailable')
            result = projection.compare(self.seed, self.config, call('bundle', root)['record'])
            if not result['records']:
                result['records'] = self.unavailable(result['reason'])['records']
            result['seedDigest'] = self.seed_digest
            result['armId'] = self.arm_id
            return result
        except Exception as error:
            return self.unavailable(f'{type(error).__name__}: {error}')

    def unavailable(self, reason: str) -> dict[str, Any]:
        return {'status': 'unavailable', 'reason': reason,
                'seedDigest': self.seed_digest, 'armId': self.arm_id,
                'records': [{'key': r['key'], 'expectedRung': None, 'omission': 'ComparisonUnavailable',
                             'observedRung': None, 'attribution': 'unavailable', 'matches': False}
                            for r in self.seed.record['journals']]}


def run(seed_path: Path, output: Path, cache: Path, arms: tuple[str, ...] = ARM_IDS) -> list[dict[str, Any]]:
    from . import driver
    seed = Seed.read(seed_path)
    restorations = [Restored(seed, arm) for arm in arms]
    output.mkdir(mode=0o700)
    results = []
    for restored in restorations:
        arm = restored.arm_id
        manifest, grade = driver.run(None, output / arm, cache, restored=restored)
        results.append({'armId': arm, 'manifest': manifest, 'grade': grade,
                        'firstProjection': json.loads((output / arm / 'driver.json').read_text())['firstProjection']})
    return results
