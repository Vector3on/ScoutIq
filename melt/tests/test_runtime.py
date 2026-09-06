import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cli import bundle, export
from runtime import Engine, MeltError, validate_source

class RuntimeTests(unittest.TestCase):
    def test_no_authority_expansion_in_source(self):
        invalid = [
            'import os\ndef run(data): return data',
            'def run(data): return data.__class__',
            "def run(data): return open('/etc/passwd')",
            "def run(data): return use('missing', data)",
            'def run(data): return eval(data)',
            'def run(data): return (lambda: data)()',
            'def run(data):\n    for len in data:\n        pass\n    return data',
            'def run(data): return [x for x in data]',
        ]
        for source in invalid:
            with self.subTest(source=source), self.assertRaises(MeltError):
                validate_source(source)

    def test_meter_bounds_nonterminating_candidate(self):
        payload = bundle('probe')
        source = 'def run(data):\n    while True:\n        pass\n'
        spec = payload['capsules']['probe']; spec['source'] = source
        spec['sha256'] = hashlib.sha256(source.encode()).hexdigest()
        answer = Engine(payload, max_steps=20).run({})
        self.assertEqual(answer['status'], 'rejected')
        self.assertIn('budget', answer['error'])

    def test_digest_and_dependency_graph(self):
        payload = bundle('scene')
        bad = copy.deepcopy(payload)
        bad['capsules']['objects']['source'] += '\n'
        with self.assertRaises(MeltError): Engine(bad)
        bad = copy.deepcopy(payload)
        bad['capsules']['objects']['dependencies'] = ['scene']
        with self.assertRaises(MeltError): Engine(bad)

    def test_composition_calls_real_dependencies(self):
        answer = Engine(bundle('scene')).run({'grid': [[1, 0], [0, 1]], 'connectivity': 8})
        self.assertEqual(answer['receipt']['capsule_calls'], ['scene', 'objects', 'plan'])
        self.assertEqual(len(answer['result']['objects']), 1)
        self.assertEqual(answer['result']['schedule']['layers'], [['object-0'], ['compose-scene']])

    def test_cycle_descendant_and_self_cycle(self):
        answer = Engine(bundle('plan')).run({'tasks': {'a':['b'], 'b':['a'], 'c':['b'], 'd':['d'], 'e':[]}})['result']
        self.assertEqual(answer['cycle_nodes'], ['a','b','d'])
        self.assertEqual(answer['blocked'], ['a','b','c','d'])
        self.assertEqual(answer['layers'], [['e']])

    def test_unsupported_json_and_shape(self):
        for data in ([1], {'grid': [[float('nan')]]}, {'grid': [[1], [2,3]]}):
            self.assertEqual(Engine(bundle('objects')).run(data)['status'], 'rejected')

    def test_export_reproducible_and_detached(self):
        with tempfile.TemporaryDirectory() as directory:
            first = export('probe', Path(directory)/'one.py')
            second = export('probe', Path(directory)/'two.py')
            self.assertEqual(first['sha256'], second['sha256'])
            proc = subprocess.run([sys.executable, '-I', first['file']],
                input=json.dumps({'candidates': [['a','a'], ['a','b']]}),
                cwd=directory, env={}, text=True, capture_output=True, timeout=5)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)['result']['experiment'], 1)

if __name__ == '__main__': unittest.main()
