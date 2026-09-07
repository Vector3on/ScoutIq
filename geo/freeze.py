"""Freeze the reviewed audit; validate the score capsule with the real Melt runtime."""
import ast
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from melt.runtime import Engine
from geo.audit import opportunity


def freeze():
    source = (ROOT/'geo/audit.py').read_text()
    tree = ast.parse(source)
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'opportunity')
    capsule = ast.get_source_segment(source, function).replace('def opportunity(data):', 'def run(data):', 1)+'\n'
    sha = lambda text: hashlib.sha256(text.encode()).hexdigest()
    bundle = {'format':'melt-1', 'entry':'geo-opportunity', 'capsules':{'geo-opportunity':{
        'source':capsule, 'sha256':sha(capsule), 'dependencies':[]}}}
    engine = Engine(bundle)
    checks = []
    for n in [0,1,2,10,100]:
        for k in sorted({0,n//2,n}):
            data = {'n':n,'mentions':k,'intent':0.9,'fixability':0.5}
            result = engine.run(data)
            assert result['status']=='ok' and result['result']==opportunity(data)
            checks.append(result)
    out = ROOT/'geo/colab'
    out.mkdir(exist_ok=True)
    (out/'geo_audit.py').write_text(source)
    (out/'opportunity.melt.json').write_text(json.dumps(bundle, indent=2)+'\n')
    (out/'freeze.json').write_text(json.dumps({'format':'geo-freeze-1','standalone_sha256':sha(source),
        'source':'geo/audit.py','dependencies':'Python 3.10+ standard library only','model_calls_for_analysis':0,
        'melt_validation_cases':len(checks),'capsule_receipt':checks[-1]['receipt'],
        'scope':'Melt validates the pure opportunity function. Collector, IO and statistical code are reviewed Python, not Melt-sandboxed.'},indent=2)+'\n')
    code = 'from pathlib import Path\nimport subprocess, sys\n'
    for name, content in [('geo_audit.py',source),('target.json',(ROOT/'geo/target.json').read_text()),
                          ('captures.jsonl',(ROOT/'geo/evidence/captures.jsonl').read_text())]:
        code += f'Path({name!r}).write_text({content!r}, encoding="utf-8")\n'
    code += 'subprocess.run([sys.executable,"geo_audit.py","analyze","--config","target.json","--captures","captures.jsonl","--out","audit-output"],check=True)\n'
    code += 'print(Path("audit-output/audit.md").read_text())\n'
    notebook = {'nbformat':4,'nbformat_minor':5,'metadata':{'kernelspec':{'display_name':'Python 3','language':'python','name':'python3'}},
        'cells':[{'cell_type':'markdown','id':'intro','metadata':{},'source':['# GEO real-brand pilot replay\n','Five measured consumer answers, not a new engine run. Run All: standard library only, no downloads or API calls. Output: audit-output/audit.md.\n','For fresh answers, use the embedded script in collect mode as documented in geo/README.md.']},
        {'cell_type':'code','id':'pilot','metadata':{},'execution_count':None,'outputs':[],'source':code.splitlines(True)}]}
    (out/'pilot.ipynb').write_text(json.dumps(notebook,indent=2,ensure_ascii=False)+'\n')
    print('Frozen and Melt-validated:',len(checks),'cases')


if __name__ == '__main__':
    freeze()
