# MELT portable capability. Python standard library only.
"""Portable, bounded interpreter for reviewed model-authored Python functions.

The restricted language is not a general Python or OS sandbox. Only JSON data
enters run(); candidate source is validated before compilation. No provider SDK.
"""
import ast
import hashlib
import json

class MeltError(ValueError):
    pass

MAX_NODES = 100_000
MAX_TEXT = 1_000_000
MAX_STEPS = 200_000
MAX_ITEMS = 10_000

def check_json(value, depth=0, counter=None):
    if counter is None:
        counter = [0]
    counter[0] += 1
    if depth > 32 or counter[0] > MAX_NODES:
        raise MeltError('JSON structure exceeds limits')
    if value is None or type(value) is bool:
        return
    if type(value) is int and abs(value) <= 10**12:
        return
    if type(value) is float and abs(value) <= 10**12:
        return
    if type(value) is str and len(value) <= MAX_TEXT:
        return
    if type(value) is list and len(value) <= MAX_ITEMS:
        for item in value:
            check_json(item, depth + 1, counter)
        return
    if type(value) is dict and len(value) <= MAX_ITEMS:
        for key, item in value.items():
            if type(key) is not str:
                raise MeltError('JSON object keys must be strings')
            check_json(key, depth + 1, counter)
            check_json(item, depth + 1, counter)
        return
    raise MeltError('Unsupported JSON value or size')

def limited_range(*args):
    result = range(*args)
    if len(result) > MAX_ITEMS:
        raise MeltError('range exceeds limits')
    return result

def append(items, item):
    if type(items) is not list or len(items) >= MAX_ITEMS:
        raise MeltError('append exceeds limits or wrong type')
    items.append(item)

def put(items, key, value):
    if type(items) is not dict or (key not in items and len(items) >= MAX_ITEMS):
        raise MeltError('put exceeds limits or wrong type')
    items[key] = value

def add(items, item):
    if type(items) is not set or (item not in items and len(items) >= MAX_ITEMS):
        raise MeltError('add exceeds limits or wrong type')
    items.add(item)

def require(condition, message):
    if not condition:
        raise MeltError(str(message))

def get_value(obj, key, default=None):
    if type(obj) is not dict:
        raise MeltError('expected an object')
    return obj.get(key, default)

def pop_value(items):
    if type(items) is not list or not items:
        raise MeltError('pop requires a nonempty list')
    return items.pop()

HELPERS = {
    'len': len, 'range': limited_range, 'sorted': sorted, 'sum': sum,
    'min': min, 'max': max, 'abs': abs, 'enumerate': enumerate,
    'list': list, 'dict': dict, 'set': set, 'tuple': tuple,
    'int': int, 'str': str, 'bool': bool,
    'is_list': lambda x: type(x) is list,
    'is_dict': lambda x: type(x) is dict,
    'is_int': lambda x: type(x) is int,
    'is_str': lambda x: type(x) is str,
    'get': get_value, 'pop': pop_value,
    'keys': lambda obj: list(obj.keys()),
    'append': append, 'put': put, 'add': add, 'require': require,
}

ALLOWED = (
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Return,
    ast.Assign, ast.AugAssign, ast.Expr, ast.If, ast.For, ast.While,
    ast.Break, ast.Continue, ast.Pass, ast.Name, ast.Load, ast.Store,
    ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set, ast.Subscript,
    ast.Slice, ast.Call, ast.keyword, ast.BinOp, ast.UnaryOp, ast.BoolOp,
    ast.Compare, ast.IfExp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv,
    ast.Mod, ast.USub, ast.UAdd, ast.Not, ast.And, ast.Or,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn,
    ast.Is, ast.IsNot,
)

def validate_source(source, dependencies=()):
    if not isinstance(source, str) or len(source) > 100_000:
        raise MeltError('source exceeds limits')
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise MeltError('invalid Python source') from exc
    functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
    if 'run' not in functions or len(functions) != len(tree.body):
        raise MeltError('source must contain only uniquely named functions including run')
    if functions.intersection(HELPERS) or 'use' in functions:
        raise MeltError('function shadows runtime helper')
    for function in tree.body:
        if function.decorator_list or function.returns or function.args.defaults or function.args.kw_defaults:
            raise MeltError('decorators, annotations, defaults are unsupported')
        if function.args.vararg or function.args.kwarg or function.args.kwonlyargs or function.args.posonlyargs:
            raise MeltError('only plain positional function arguments are supported')
    run = next(node for node in tree.body if node.name == 'run')
    if len(run.args.args) != 1:
        raise MeltError('run must accept exactly one JSON argument')
    allowed_names = set(HELPERS) | functions | {'use'}
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED):
            raise MeltError('unsupported syntax: ' + type(node).__name__)
        if isinstance(node, ast.FunctionDef) and node not in tree.body:
            raise MeltError('nested function definitions are unsupported')
        if isinstance(node, (ast.Name, ast.arg)):
            name = node.id if isinstance(node, ast.Name) else node.arg
            if name.startswith('_'):
                raise MeltError('private names are unavailable')
            if (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) or isinstance(node, ast.arg)) and name in allowed_names:
                raise MeltError('cannot rebind functions or runtime helpers')
        if isinstance(node, ast.FunctionDef) and node.name.startswith('_'):
            raise MeltError('private function names are unavailable')
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in allowed_names:
                raise MeltError('only named functions and declared helpers can be called')
            if any(k.arg is None for k in node.keywords):
                raise MeltError('keyword expansion is unsupported')
            if node.func.id == 'use':
                if len(node.args) != 2 or not isinstance(node.args[0], ast.Constant) or node.args[0].value not in dependencies:
                    raise MeltError('use requires a literal declared dependency and one input')
        if isinstance(node, ast.Constant) and not isinstance(node.value, (str, int, float, bool, type(None))):
            raise MeltError('unsupported literal')
    return tree

class Meter(ast.NodeTransformer):
    def visit_FunctionDef(self, node):
        self.generic_visit(node)
        node.body.insert(0, self.tick())
        return node
    def visit_For(self, node):
        self.generic_visit(node)
        node.body.insert(0, self.tick())
        return node
    def visit_While(self, node):
        self.generic_visit(node)
        node.body.insert(0, self.tick())
        return node
    @staticmethod
    def tick():
        return ast.Expr(ast.Call(ast.Name('_tick', ast.Load()), [], []))

def validate_bundle(bundle):
    if bundle.get('format') != 'melt-1' or type(bundle.get('capsules')) is not dict:
        raise MeltError('unsupported bundle')
    capsules = bundle['capsules']
    if not capsules or len(capsules) > 64 or bundle.get('entry') not in capsules:
        raise MeltError('invalid entry or capsule count')
    visiting, visited = set(), set()
    def visit(name):
        if name in visiting:
            raise MeltError('cyclic capsule dependencies')
        if name in visited:
            return
        if name not in capsules:
            raise MeltError('missing dependency: ' + str(name))
        spec = capsules[name]
        source = spec['source']
        if hashlib.sha256(source.encode()).hexdigest() != spec['sha256']:
            raise MeltError('source digest mismatch: ' + name)
        deps = spec.get('dependencies', [])
        validate_source(source, deps)
        visiting.add(name)
        for dep in deps:
            visit(dep)
        visiting.remove(name)
        visited.add(name)
    for name in capsules:
        visit(name)

class Engine:
    def __init__(self, bundle, max_steps=MAX_STEPS):
        validate_bundle(bundle)
        self.bundle = bundle
        self.max_steps = max_steps
        self.functions = {}
        self.steps = 0
        self.calls = []
        for name, spec in bundle['capsules'].items():
            tree = Meter().visit(validate_source(spec['source'], spec.get('dependencies', [])))
            ast.fix_missing_locations(tree)
            scope = {'__builtins__': {}, **HELPERS, '_tick': self.tick,
                     'use': self.bind(name)}
            exec(compile(tree, '<melt:' + name + '>', 'exec'), scope)
            self.functions[name] = scope['run']
    def tick(self):
        self.steps += 1
        if self.steps > self.max_steps:
            raise MeltError('execution step budget exceeded')
    def bind(self, owner):
        def invoke(name, data):
            if name not in self.bundle['capsules'][owner].get('dependencies', []):
                raise MeltError('undeclared capability')
            return self.invoke(name, data)
        return invoke
    def invoke(self, name, data):
        check_json(data)
        self.calls.append(name)
        result = self.functions[name](data)
        check_json(result)
        return result
    def run(self, data):
        self.steps, self.calls = 0, []
        try:
            result = self.invoke(self.bundle['entry'], data)
            return {'status': 'ok', 'result': result,
                    'receipt': {'entry': self.bundle['entry'], 'steps': self.steps,
                                'capsule_calls': self.calls, 'model_calls': 0,
                                'sources': {n: s['sha256'] for n, s in self.bundle['capsules'].items()}}}
        except (MeltError, TypeError, KeyError, IndexError, ZeroDivisionError, RecursionError, OverflowError) as exc:
            return {'status': 'rejected', 'error': str(exc),
                    'receipt': {'entry': self.bundle['entry'], 'steps': self.steps, 'model_calls': 0}}

BUNDLE = {'format': 'melt-1', 'entry': 'partition', 'capsules': {'partition': {'version': 1, 'dependencies': [], 'purpose': 'Filter static evidence hypotheses and partition their predicted observations', 'contract': 'rows: 1..128 categorical vectors; observed: numeric column strings to categorical answers', 'source': "def run(data):\n    rows = get(data, 'rows')\n    observed = get(data, 'observed', {})\n    require(is_list(rows) and 1 <= len(rows) <= 128, 'provide 1..128 prediction vectors')\n    require(is_list(rows[0]) and 1 <= len(rows[0]) <= 128, 'provide 1..128 questions')\n    width = len(rows[0])\n    require(is_dict(observed), 'observed must be an object')\n    for row in rows:\n        require(is_list(row) and len(row) == width, 'ragged predictions')\n        for value in row:\n            require(is_str(value), 'categorical predictions only')\n    allowed = []\n    for j in range(width):\n        append(allowed, str(j))\n    for key in keys(observed):\n        require(key in allowed and is_str(observed[key]), 'unknown question or noncategorical observation')\n    survivors = []\n    for i in range(len(rows)):\n        fits = True\n        for j in range(width):\n            if str(j) in observed and rows[i][j] != observed[str(j)]:\n                fits = False\n        if fits:\n            append(survivors, i)\n    partitions = []\n    for j in range(width):\n        groups = {}\n        for i in survivors:\n            put(groups, rows[i][j], get(groups, rows[i][j], 0) + 1)\n        counts = []\n        for label in sorted(keys(groups)):\n            append(counts, groups[label])\n        append(partitions, counts)\n    return {'survivors': survivors, 'partitions': partitions}\n", 'sha256': '3f07c75897d86fb174caff9a377c71014d84b2bafe1d3635b53b809eb6dbf4e0'}}, 'provenance': {'author': 'assistant in this development session', 'material': 'public implementation and design notes', 'hidden_reasoning_extracted': False, 'model_weights_modified': False}}

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
