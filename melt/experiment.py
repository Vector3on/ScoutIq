"""Reproducible self-export experiment with algorithmically distinct oracles.

The assistant authored candidates AND this evaluator: this is not blinded or
independently supervised. Fresh generated instances measure bounded transfer.
"""
import hashlib
from itertools import product
import json
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
from cli import ROOT, bundle, export

# Copied into a fresh directory with only one exported file. No repository imports.
DRIVER = '''import json, runpy, sys
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    os_limits = True
except ImportError:
    os_limits = False
attempts = []
def audit(event, args):
    if event.startswith('socket.') or event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn'):
        attempts.append(event)
        raise RuntimeError('offline evaluation blocked external action')
sys.addaudithook(audit)
module = runpy.run_path('capability.py', run_name='melt_test_artifact')
engine = module['Engine'](module['BUNDLE'])
inputs = json.load(sys.stdin)
answers = [engine.run(value) for value in inputs]
print(json.dumps({'answers': answers, 'external_action_attempts': attempts, 'os_resource_limits': os_limits}))
'''

def objects_oracle(data):
    grid = data['grid']; h = len(grid); w = len(grid[0]); bg = data.get('background', 0)
    points = [(y, x) for y in range(h) for x in range(w) if grid[y][x] != bg]
    parent = {p: p for p in points}
    def root(p):
        while parent[p] != p:
            p = parent[p]
        return p
    offsets = [(1, 0), (0, 1)]
    if data.get('connectivity', 4) == 8:
        offsets += [(1, 1), (1, -1)]
    for p in points:
        for dy, dx in offsets:
            q = (p[0] + dy, p[1] + dx)
            if q in parent and grid[p[0]][p[1]] == grid[q[0]][q[1]]:
                parent[root(q)] = root(p)
    groups = {}
    for p in points:
        groups.setdefault(root(p), []).append(list(p))
    objects = []
    for cells in sorted(groups.values(), key=lambda c: c[0]):
        ys, xs = zip(*cells)
        objects.append({'color': grid[cells[0][0]][cells[0][1]], 'area': len(cells),
                        'cells': cells, 'bbox': [min(ys), min(xs), max(ys)+1, max(xs)+1]})
    return {'height': h, 'width': w, 'objects': objects}

def plan_oracle(data):
    tasks = data['tasks']; names = sorted(tasks)
    # Transitive closure gives an independent oracle for membership in cycles.
    reach = {n: set(tasks[n]) for n in names}
    for k in names:
        for n in names:
            if k in reach[n]:
                reach[n] |= reach[k]
    cycle = sorted(n for n in names if n in reach[n])
    blocked = sorted(n for n in names if n in cycle or set(cycle).intersection(reach[n]))
    levels = {}
    remaining = set(names) - set(blocked)
    while remaining:
        ready = [n for n in remaining if all(d in levels for d in tasks[n])]
        if not ready:
            raise AssertionError('oracle failed to classify graph')
        for n in ready:
            levels[n] = 1 + max((levels[d] for d in tasks[n]), default=-1)
        remaining -= set(ready)
    layers = [[n for n in names if levels.get(n) == level] for level in range(max(levels.values(), default=-1)+1)]
    return {'layers': layers, 'blocked': blocked, 'cycle_nodes': cycle}

def probe_oracle(data):
    rows = data['candidates']; n = len(rows)
    # Pairwise equality, unlike the exported histogram implementation.
    scores = [sum(a[i] == b[i] for a in rows for b in rows) / n for i in range(len(rows[0]))]
    return {'experiment': scores.index(min(scores)), 'expected_survivors': scores,
            'indistinguishable': min(scores) == n}

def scene_oracle(data):
    perception = objects_oracle(data)
    summaries = [{'id': 'object-' + str(i), **{k: obj[k] for k in ('color', 'area', 'bbox')}}
                 for i, obj in enumerate(perception['objects'])]
    tasks = {obj['id']: [] for obj in summaries}
    tasks['compose-scene'] = sorted(tasks)
    return {'objects': summaries, 'schedule': plan_oracle({'tasks': tasks}),
            'height': perception['height'], 'width': perception['width']}

def corpus(seed=260906):
    rng = random.Random(seed)
    grids = []
    for bits in product((0, 1), repeat=8):
        for connectivity in (4, 8):
            grids.append({'grid': [list(bits[:4]), list(bits[4:])], 'connectivity': connectivity})
    for _ in range(100):
        h, w = rng.randint(1, 8), rng.randint(1, 8)
        grids.append({'grid': [[rng.randrange(4) for _ in range(w)] for _ in range(h)],
                      'background': rng.randrange(4), 'connectivity': rng.choice((4, 8))})
    grids += [{'grid': [[1]*64 for _ in range(64)], 'connectivity': 8}]
    graphs = []
    for _ in range(160):
        names = ['t'+str(i) for i in range(rng.randrange(15))]
        density = rng.choice((0.05, 0.15, 0.4))
        graphs.append({'tasks': {n: [d for d in names if rng.random() < density] for n in names}})
    graphs += [{'tasks': {'a':['b'], 'b':['a'], 'c':['b']}},
               {'tasks': {str(i): [str(i-1)] if i else [] for i in range(128)}},
               {'tasks': {str(i): [str(j) for j in range(128)] for i in range(128)}}]
    probes = []
    for _ in range(100):
        n, q = rng.randint(1, 20), rng.randint(1, 15)
        probes.append({'candidates': [[str(rng.randrange(5)) for _ in range(q)] for _ in range(n)]})
    return {'objects': grids, 'plan': graphs, 'probe': probes, 'scene': grids[::16]}

def offline_batch(entry, cases, capsules_dir=None):
    with tempfile.TemporaryDirectory(prefix='melt-detached-') as directory:
        path = Path(directory)
        receipt = export(entry, path / 'capability.py', capsules_dir)
        (path / 'driver.py').write_text(DRIVER)
        process = subprocess.run([sys.executable, '-I', str(path / 'driver.py')],
            input=json.dumps(cases), text=True, capture_output=True, cwd=path,
            env={}, timeout=20)
        if process.returncode:
            raise RuntimeError('detached export failed: ' + process.stderr[-2000:])
        result = json.loads(process.stdout)
        result['artifact_sha256'] = receipt['sha256']
        result['capsules'] = receipt['capsules']
        return result

def score(entry, cases, results):
    oracle = {'objects': objects_oracle, 'plan': plan_oracle, 'probe': probe_oracle, 'scene': scene_oracle}[entry]
    failures = []
    passed = 0
    for data, answer in zip(cases, results['answers']):
        expected = oracle(data)
        correct = answer.get('status') == 'ok' and answer.get('result') == expected
        passed += correct
        if not correct and len(failures) < 3:
            failures.append({'input': data, 'expected': expected, 'actual': answer})
    assert len(cases) == len(results['answers'])
    return {'passed': passed, 'total': len(cases), 'failure_examples': failures,
            'artifact_sha256': results['artifact_sha256'], 'capsules': results['capsules'],
            'external_action_attempts': results['external_action_attempts'],
            'os_resource_limits': results['os_resource_limits'],
            'maximum_steps': max(a.get('receipt', {}).get('steps', 0) for a in results['answers'])}

def experiment(output):
    # Freeze candidate identities before generating the evaluation instances.
    frozen = {n: s['sha256'] for n in ('objects', 'plan', 'probe', 'scene') for s in [bundle(n)['capsules'][n]]}
    cases = corpus()
    revised = {name: score(name, inputs, offline_batch(name, inputs)) for name, inputs in cases.items()}
    with tempfile.TemporaryDirectory(prefix='melt-history-') as directory:
        directory = Path(directory)
        shutil.copytree(ROOT / 'capsules', directory / 'capsules')
        for name in ('objects', 'plan'):
            shutil.copyfile(ROOT / 'history' / (name + '_v0.py'), directory / 'capsules' / (name + '.py'))
        catalog_path = directory / 'capsules' / 'catalog.json'
        catalog = json.loads(catalog_path.read_text())
        for name in ('objects', 'plan'):
            catalog[name]['version'] = 0
        catalog_path.write_text(json.dumps(catalog))
        initial = {name: score(name, cases[name], offline_batch(name, cases[name], directory / 'capsules'))
                   for name in ('objects', 'plan')}
    invalid = {
        'objects': [{'grid': [[1], [1, 2]]}, {'grid': [[True]]}, {'grid': [[1]], 'connectivity': 3}, []],
        'plan': [{'tasks': {'a': ['missing']}}, {'tasks': []}],
        'probe': [{'candidates': []}, {'candidates': [['a'], ['b', 'c']]}],
    }
    rejection = {}
    for name, values in invalid.items():
        answers = offline_batch(name, values)['answers']
        rejection[name] = {'rejected': sum(a['status'] == 'rejected' for a in answers), 'total': len(values)}
    report = {
        'experiment': 'Melt self-export 1', 'date': '2026-09-06',
        'claim_tested': 'Model-authored procedures retain bounded task behavior as detached executable artifacts.',
        'author_role': 'The conversational assistant authored public source, tests, and revisions; no hidden reasoning was accessed.',
        'seed': 260906, 'frozen_sources': frozen,
        'corpus_sha256': hashlib.sha256(json.dumps(cases, sort_keys=True).encode()).hexdigest(),
        'protocol': {'process': 'fresh isolated Python process, empty environment, temporary working directory',
                     'network': 'Python audit hook rejects socket and process-launch events; not kernel network isolation',
                     'model': 'No model client, credentials, or inference operation in exported call graph',
                     'oracle_independence': 'Different algorithms where practical; same assistant authored both sides',
                     'evaluation': 'Fixed synthetic family, fresh generated instances, not blinded evaluation'},
        'initial': initial, 'revised': revised, 'invalid_inputs': rejection,
        'total_revised_passed': sum(x['passed'] for x in revised.values()),
        'total_revised_cases': sum(x['total'] for x in revised.values()),
        'limitations': ['No whole-model transfer, weight training, or hidden-trace extraction.',
                        'Examples demonstrate procedural export, not preservation of general reasoning.',
                        'Development failure cases were chosen by the author; not a blind discovery experiment.',
                        'Capsule revisions were made by the assistant in this session, not by the disconnected runtime.',
                        'The exporter validates and packages source; it does not automatically compile natural-language reasoning.',
                        'Guarded Python execution is not a hardened multi-tenant sandbox. Review capsule source.'],
    }
    report['status'] = 'passed' if (
        report['total_revised_passed'] == report['total_revised_cases']
        and all(v['rejected'] == v['total'] for v in rejection.values())
        and all(not v['external_action_attempts'] for v in revised.values())
    ) else 'failed'
    path = Path(output); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + '\n')
    return report
