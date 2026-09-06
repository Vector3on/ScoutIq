"""Run from any directory: python3 /path/to/melt/cli.py --help."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from runtime import Engine, MeltError, validate_bundle

ROOT = Path(__file__).resolve().parent

def bundle(entry, capsules_dir=None):
    directory = Path(capsules_dir or ROOT / 'capsules')
    catalog = json.loads((directory / 'catalog.json').read_text())
    selected = {}
    visiting = set()
    def collect(name):
        if name in visiting:
            raise MeltError('cyclic capsule dependencies')
        if name in selected:
            return
        if name not in catalog:
            raise MeltError('unknown capsule: ' + name)
        visiting.add(name)
        spec = catalog[name]
        for dep in spec.get('dependencies', []):
            collect(dep)
        source = (directory / (name + '.py')).read_text()
        selected[name] = {**spec, 'source': source, 'sha256': hashlib.sha256(source.encode()).hexdigest()}
        visiting.remove(name)
    collect(entry)
    result = {'format': 'melt-1', 'entry': entry, 'capsules': selected,
              'provenance': {'author': 'assistant in this development session',
                             'material': 'public implementation and design notes',
                             'hidden_reasoning_extracted': False, 'model_weights_modified': False}}
    validate_bundle(result)
    return result

def export(entry, output, capsules_dir=None):
    payload = bundle(entry, capsules_dir)
    runtime = (ROOT / 'runtime.py').read_text()
    footer = '''
if __name__ == '__main__':
    import sys
    try:
        text = sys.stdin.read(1000001)
        if len(text) > 1000000:
            raise MeltError('input exceeds one megabyte')
        value = json.loads(text)
        answer = Engine(BUNDLE).run(value)
    except (ValueError, TypeError, KeyError) as error:
        answer = {'status': 'rejected', 'error': str(error)}
    print(json.dumps(answer, allow_nan=False, sort_keys=True))
    sys.exit(0 if answer['status'] == 'ok' else 2)
'''
    content = '# MELT portable capability. Python standard library only.\n' + runtime + '\nBUNDLE = ' + repr(payload) + '\n' + footer
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return {'file': str(path), 'sha256': hashlib.sha256(content.encode()).hexdigest(),
            'entry': entry, 'capsules': sorted(payload['capsules']), 'requires_model': False}

def main():
    parser = argparse.ArgumentParser(description='Melt: export model-authored capabilities to portable computation')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    p = sub.add_parser('export'); p.add_argument('capsule'); p.add_argument('--out', required=True)
    p = sub.add_parser('run'); p.add_argument('capsule'); p.add_argument('--input', required=True)
    p = sub.add_parser('target'); p.add_argument('path', nargs='?', default=str(ROOT.parent / 'MELT_TARGET.json'))
    p = sub.add_parser('experiment'); p.add_argument('--out', default=str(ROOT / 'out' / 'experiment.json'))
    p = sub.add_parser('request'); p.add_argument('goal'); p.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'list':
            result = json.loads((ROOT / 'capsules/catalog.json').read_text())
        elif args.command == 'export':
            result = export(args.capsule, args.out)
        elif args.command == 'run':
            # Always execute in a child with a wall-clock bound.
            import tempfile
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'capability.py'
                export(args.capsule, path)
                process = subprocess.run([sys.executable, '-I', str(path)],
                    input=Path(args.input).read_text(), text=True, capture_output=True,
                    timeout=10, cwd=directory, env={})
                result = json.loads(process.stdout)
        elif args.command == 'target':
            target_path = Path(args.path).resolve()
            target = json.loads(target_path.read_text())
            entry = target['capsule']
            out = target_path.parent / target.get('export', 'melt/out/capability.py')
            # Target data cannot redirect writes outside the project directory.
            if not out.resolve().is_relative_to(target_path.parent):
                raise MeltError('export must stay within the target directory')
            receipt = export(entry, out)
            process = subprocess.run([sys.executable, '-I', str(out)],
                input=json.dumps(target['input']), text=True, capture_output=True,
                timeout=10, cwd=out.parent, env={})
            result = {'export': receipt, 'execution': json.loads(process.stdout)}
            if result['execution']['status'] != 'ok':
                result['status'] = 'rejected'
        elif args.command == 'experiment':
            from experiment import experiment
            result = experiment(args.out)
        else:
            result = {'goal': args.goal, 'status': 'needs_model_authored_candidate',
                'instruction': 'Provide public implementation notes, examples, applicability limits, and a run(data) function in the supported Python subset. Do not provide hidden reasoning.',
                'available_helpers': sorted(__import__('runtime').HELPERS),
                'next_step': 'Review and add a capsule to capsules/catalog.json, then test and export.',
                'automatic_model_connection': False}
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2, allow_nan=False))
        return 2 if result.get('status') in ('rejected', 'failed') else 0
    except (MeltError, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({'status': 'rejected', 'error': str(exc)}))
        return 2

if __name__ == '__main__':
    sys.exit(main())
