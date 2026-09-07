"""Original synthetic benchmark families. No official benchmark data is used."""
from collections import Counter, deque
from itertools import product
import hashlib
import json
from pathlib import Path
import random
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cli import ROOT, bundle
from experiment import offline_batch

OPS = ('turn', 'mirror', 'crop', 'recolor', 'wide_mirror')

def transform(grid, op):
    if op == 'turn':
        return [list(row) for row in zip(*grid[::-1])]
    if op == 'mirror' or op == 'wide_mirror' and len(grid[0]) > len(grid):
        return [row[::-1] for row in grid]
    if op == 'recolor':
        return [[0 if v == 0 else {1:2, 2:3, 3:1}[v] for v in row] for row in grid]
    if op == 'crop':
        occupied = [(r,c) for r,row in enumerate(grid) for c,v in enumerate(row) if v]
        if not occupied: return [[0]]
        ys, xs = zip(*occupied)
        return [row[min(xs):max(xs)+1] for row in grid[min(ys):max(ys)+1]]
    return grid

def apply(grid, program):
    for op in program: grid = transform(grid, op)
    return grid

def visual_reference(data):
    programs = [p for depth in range(data.get('max_depth',3)+1) for p in product(OPS, repeat=depth)]
    survivors = [p for p in programs if all(apply(e['input'], p) == e['output'] for e in data['examples'])]
    outputs = {json.dumps(apply(data['query'],p)) for p in survivors}
    return {'outcome': 'unsupported' if not survivors else 'solved' if len(outputs)==1 else 'ambiguous',
            'output': json.loads(next(iter(outputs))) if len(outputs)==1 else None,
            'first': apply(data['query'],survivors[0]) if survivors else None,
            'survivors': len(survivors)}

def matches(state, pattern):
    return all(want is None or value == want for value,want in zip(state,pattern))

def successors(state, actions):
    for action in actions:
        if matches(state, action['pre']):
            yield tuple(old if new is None else new for old,new in zip(state,action['effect'])), action

def planning_reference(data):
    # Bellman-Ford relaxation over explicitly enumerated states, not a priority queue.
    states = list(product((0,1), repeat=len(data['initial'])))
    edges = [(state,nxt,a['cost']) for state in states for nxt,a in successors(state,data['actions'])]
    infinity = float('inf')
    distance = {s: infinity for s in states}; distance[tuple(data['initial'])] = 0
    for _ in range(len(states)-1):
        changed = False
        for src,dst,cost in edges:
            if distance[src]+cost < distance[dst]:
                distance[dst] = distance[src]+cost; changed = True
        if not changed: break
    best = min((v for s,v in distance.items() if matches(s,data['goal'])), default=infinity)
    return None if best == infinity else best

def breadth_baseline(data):
    # Shortest action sequence, ignoring cost until a complete plan is found.
    initial = tuple(data['initial']); queue = deque([(initial,0)])
    seen = {initial}
    expanded = 0
    while queue:
        state,cost = queue.popleft()
        if matches(state,data['goal']): return cost
        if expanded >= data.get('max_expansions',1024): return 'budget_exhausted'
        expanded += 1
        for nxt,action in successors(state,data['actions']):
            if nxt not in seen:
                seen.add(nxt); queue.append((nxt,cost+action['cost']))
    return None

def replay(data,result):
    state = tuple(data['initial']); cost = 0; trace = [list(state)]
    actions = {a['name']:a for a in data['actions']}
    for name in result.get('plan',[]):
        action = actions.get(name)
        if not action or not matches(state,action['pre']): return False
        state = tuple(old if new is None else new for old,new in zip(state,action['effect']))
        cost += action['cost']; trace.append(list(state))
    return matches(state,data['goal']) and cost == result.get('cost') and trace == result.get('states')

def diagnosis_survivors(data):
    return [i for i in range(len(data['hypotheses'])) if all(
        t['name'] not in data.get('observed',{}) or t['outcomes'][i] == data['observed'][t['name']]
        for t in data['tests'])]

def diagnosis_reference(data):
    survivors = diagnosis_survivors(data)
    if not survivors: return 'inconsistent', None
    signatures = [tuple(t['outcomes'][i] for t in data['tests']) for i in survivors]
    if len(set(signatures)) != len(signatures): return 'unidentifiable', None
    # Bottom-up exhaustive subset optimization, rather than recursive memoized search.
    n = len(survivors); best = {1 << i:0 for i in range(n)}
    for size in range(2,n+1):
        for mask in range(1,1 << n):
            if mask.bit_count()!=size: continue
            options = []
            for test in data['tests']:
                groups = {}
                for j,original in enumerate(survivors):
                    if mask & (1 << j):
                        label = test['outcomes'][original]
                        groups[label] = groups.get(label,0) | (1 << j)
                if len(groups)>1:
                    options.append(test['cost']+max(best[group] for group in groups.values()))
            best[mask] = min(options)
    return 'solved', best[(1 << n)-1]

def greedy_diagnosis(data, survivors=None):
    survivors = diagnosis_survivors(data) if survivors is None else survivors
    if len(survivors)<=1: return 0
    choices = []
    for index,test in enumerate(data['tests']):
        groups = {}
        for i in survivors: groups.setdefault(test['outcomes'][i],[]).append(i)
        if len(groups)>1:
            # Existing single-step probe objective, with deterministic tie-breaking.
            choices.append((sum(len(g)**2 for g in groups.values()), index, groups))
    if not choices: return None
    _,index,groups = min(choices,key=lambda x:(x[0],x[1]))
    costs = [greedy_diagnosis(data,g) for g in groups.values()]
    return None if None in costs else data['tests'][index]['cost']+max(costs)

def verify_policy(data,result):
    tests = {t['name']:t for t in data['tests']}; costs = []
    for i in diagnosis_survivors(data):
        node = result.get('policy',{}); seen = set(); cost = 0
        while 'test' in node:
            name = node['test']
            if name in seen or name not in tests: return False
            seen.add(name); test = tests[name]; cost += test['cost']
            node = node.get('branches',{}).get(test['outcomes'][i],{})
        if node.get('hypothesis') != data['hypotheses'][i]: return False
        costs.append(cost)
    return bool(costs) and max(costs)==result.get('worst_cost')

def counter_task(n, limit=1024):
    actions=[]
    for i in range(n):
        pre=[1]*i+[0]+[None]*(n-i-1)
        effect=[0]*i+[1]+[None]*(n-i-1)
        actions.append({'name':'carry-'+str(i),'pre':pre,'effect':effect,'cost':1})
    return {'initial':[0]*n,'goal':[1]*n,'actions':actions,'max_expansions':limit}

def generate(seed, count):
    rng=random.Random(seed); cases={'state_planner':[],'visual_rule':[],'diagnose':[]}
    def record(family,tag,data,truth=None):
        cases[family].append({'id':family+'-'+str(len(cases[family])), 'tag':tag,'input':data,'hidden_output':truth})
    for i in range(count):
        n=rng.randint(4,7); actions=[]
        for j in range(rng.randint(n, min(20,3*n))):
            pre=[rng.choice((None,None,0,1)) for _ in range(n)]
            effect=[rng.choice((None,None,None,0,1)) for _ in range(n)]
            actions.append({'name':'op-'+str(rng.randrange(10**8))+'-'+str(j),'pre':pre,'effect':effect,'cost':rng.randint(1,9)})
        # A costly unconditional route creates an optimum-cost challenge, not only unreachability.
        initial=[rng.randrange(2) for _ in range(n)]; goal=[rng.randrange(2) for _ in range(n)]
        if i%2==0:
            actions.append({'name':'expensive-reset','pre':[None]*n,'effect':goal,'cost':30})
        rng.shuffle(actions)
        record('state_planner','random_costed',{'initial':initial,'goal':goal,'actions':actions})
    # Explicit setback puzzle: clean -> authorize consumes clean -> rebuild clean -> deliver.
    for cost in (4,9,25):
        record('state_planner','setback',{'initial':[0,0,0],'goal':[None,None,1], 'actions':[
            {'name':'prepare','pre':[None,None,None],'effect':[1,None,None],'cost':1},
            {'name':'authorize','pre':[1,0,None],'effect':[0,1,None],'cost':1},
            {'name':'deliver','pre':[1,1,0],'effect':[None,None,1],'cost':1},
            {'name':'shortcut','pre':[None,None,None],'effect':[None,None,1],'cost':cost}]})
    for n in (6,8,10): record('state_planner','long_horizon',counter_task(n))
    for n in (5,7,9): record('state_planner','budget',counter_task(n,2))
    record('state_planner','unreachable',{'initial':[0,0],'goal':[None,1],'actions':[
        {'name':'on','pre':[0,None],'effect':[1,None],'cost':1},
        {'name':'off','pre':[1,None],'effect':[0,None],'cost':1}]})
    def grid(big=False):
        h=rng.randint(4,7) if big else rng.randint(2,4)
        w=rng.randint(4,7) if big else rng.randint(2,4)
        return [[0 if rng.random()<0.55 else rng.randint(1,3) for _ in range(w)] for _ in range(h)]
    for _ in range(count):
        program=[rng.choice(OPS) for _ in range(3)]
        examples=[]
        for j in range(3):
            value=grid(); examples.append({'input':value,'output':apply(value,program)})
        query=grid(True)
        record('visual_rule','composition_size_transfer',{'examples':examples,'query':query},apply(query,program))
    for _ in range(max(4,count//4)):
        query=grid(True); program=['recolor','turn','wide_mirror']
        record('visual_rule','ambiguous',{'examples':[{'input':[[0]],'output':[[0]]}],'query':query},apply(query,program))
    for _ in range(max(4,count//4)):
        value=[[rng.randint(1,3) for _ in range(3)] for _ in range(3)]
        record('visual_rule','outside_grammar',{'examples':[{'input':value,'output':[row+row for row in value]}],'query':value},[row+row for row in value])
    for i in range(count):
        n=rng.randint(5,8); q=rng.randint(4,8)
        tests=[{'name':'test-'+str(j),'cost':rng.randint(1,9),'outcomes':[str(rng.randrange(3)) for _ in range(n)]} for j in range(q)]
        data={'hypotheses':['hyp-'+str(j) for j in range(n)],'tests':tests}
        if i%3==0:
            chosen=rng.randrange(n); test=rng.choice(tests)
            data['observed']={test['name']:test['outcomes'][chosen]}
        record('diagnose','adaptive_cost',data)
    for i in range(4):
        record('diagnose','unidentifiable',{'hypotheses':['a','b','c'],'tests':[
            {'name':'look','cost':i+1,'outcomes':['same','same','other']}]})
    record('diagnose','inconsistent',{'hypotheses':['a','b'],'tests':[
        {'name':'look','cost':1,'outcomes':['yes','no']}],'observed':{'look':'impossible'}})
    for i in range(4):
        record('diagnose','budget',{'hypotheses':['a','b','c','d'],'tests':[
            {'name':'left','cost':i+1,'outcomes':['0','0','1','1']},
            {'name':'right','cost':1,'outcomes':['0','1','0','1']}],'max_subsets':1})
    return cases

def assess(family, case, answer):
    data=case['input']; tag=case['tag']; result=answer.get('result',{})
    if answer.get('status')!='ok':
        return False, 'runtime_rejected', None, None
    outcome=result.get('outcome'); baseline=None; expected=None
    if family=='state_planner':
        if tag=='budget':
            return outcome=='budget_exhausted',outcome,'budget_exhausted',None
        expected=planning_reference(data); baseline=breadth_baseline(data)
        passed=(outcome=='unreachable' if expected is None else
                outcome=='solved' and result.get('cost')==expected and replay(data,result))
    elif family=='visual_rule':
        reference=visual_reference(data); expected=reference['outcome']
        baseline=reference['first']==case['hidden_output'] if reference['first'] is not None else False
        passed=outcome==expected and (outcome!='solved' or result.get('output')==reference['output'])
        if outcome=='solved':
            program=result.get('program',[])
            passed=passed and result.get('output')==case['hidden_output'] and apply(data['query'],program)==result.get('output')
            passed=passed and all(apply(e['input'],program)==e['output'] for e in data['examples'])
        if outcome=='ambiguous' and passed:
            programs=result.get('witness_programs',[])
            predictions=[apply(data['query'],p) for p in programs]
            passed=len(programs)==2 and predictions[0]!=predictions[1] and predictions==result.get('witness_predictions')
            passed=passed and all(all(apply(e['input'],p)==e['output'] for e in data['examples']) for p in programs)
    else:
        if tag=='budget':
            return outcome=='budget_exhausted',outcome,'budget_exhausted',None
        expected,cost=diagnosis_reference(data); baseline=greedy_diagnosis(data) if expected=='solved' else None
        passed=outcome==expected
        if expected=='solved':
            passed=passed and result.get('worst_cost')==cost and verify_policy(data,result)
            expected=cost
        elif expected=='unidentifiable' and passed:
            witness=result.get('witness',[])
            passed=len(witness)==2 and len(set(witness))==2 and all(x in data['hypotheses'] for x in witness)
            if passed:
                a,b=[data['hypotheses'].index(x) for x in witness]
                survivors=diagnosis_survivors(data)
                passed=a in survivors and b in survivors and all(t['outcomes'][a]==t['outcomes'][b] for t in data['tests'])
    return bool(passed),outcome,expected,baseline

def benchmark(output,seed=880301,count=60):
    if not 1<=count<=200: raise ValueError('count must be 1..200')
    families=('state_planner','visual_rule','diagnose')
    frozen={name:bundle(name)['capsules'][name]['sha256'] for name in families}
    freeze={'capsules':frozen,'runtime':hashlib.sha256((ROOT/'runtime.py').read_bytes()).hexdigest(),
            'evaluator':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    cases=generate(seed,count)
    results={}; witnesses=[]
    for family,records in cases.items():
        detached=offline_batch(family,[c['input'] for c in records])
        statuses=Counter(); tags={}; passed=0; wrong_definitive=0
        rows=[]; baseline_matches=0; baseline_eligible=0; improvement=[]
        for case,answer in zip(records,detached['answers']):
            ok,status,expected,baseline=assess(family,case,answer)
            passed+=ok; statuses[status]+=1
            if not ok and status in ('solved','unreachable','unsupported','unidentifiable','inconsistent'): wrong_definitive+=1
            stat=tags.setdefault(case['tag'],{'passed':0,'total':0}); stat['passed']+=ok; stat['total']+=1
            result=answer.get('result',{})
            rows.append({'id':case['id'],'tag':case['tag'],'pass':ok,'outcome':status,
                         'steps':answer.get('receipt',{}).get('steps',0),
                         'expected':expected,'baseline':baseline,
                         'cost':result.get('cost',result.get('worst_cost')),
                         'plan_length':len(result.get('plan',[])) if family=='state_planner' and status=='solved' else None})
            if case['tag']!='budget':
                if family=='visual_rule':
                    baseline_eligible+=1; baseline_matches+=bool(baseline)
                elif family=='state_planner' or isinstance(expected,int):
                    baseline_eligible+=1; baseline_matches+=baseline==expected
                    if isinstance(baseline,int) and isinstance(expected,int) and baseline>expected:
                        improvement.append(baseline-expected)
            if not ok and len(witnesses)<9:
                witnesses.append({'family':family,'case':case,'answer':answer,'expected':expected})
        results[family]={'passed_contract':passed,'total':len(records),'outcomes':dict(statuses),'tags':tags,
                         'wrong_definitive_answers':wrong_definitive,'artifact_sha256':detached['artifact_sha256'],
                         'external_action_attempts':detached['external_action_attempts'],
                         'maximum_steps':max(r['steps'] for r in rows),
                         'baseline':{'name':{'state_planner':'action-count BFS','visual_rule':'first-consistent guess','diagnose':'greedy immediate partition'}[family],
                                     'matches':baseline_matches,'eligible':baseline_eligible,
                                     'metric':'matches hidden target output' if family=='visual_rule' else 'matches optimum/status',
                                     'strict_cost_improvements':len(improvement),'total_cost_saved':sum(improvement)},
                         'cases':rows}
    passed=sum(r['passed_contract'] for r in results.values()); total=sum(r['total'] for r in results.values())
    report={'benchmark':'Melt reasoning 2','seed':seed,'random_cases_per_family':count,'freeze':freeze,
            'corpus_sha256':hashlib.sha256(json.dumps(cases,sort_keys=True).encode()).hexdigest(),
            'results':results,'passed_contract':passed,'total':total,'failures':witnesses,
            'status':'passed' if passed==total and all(not r['external_action_attempts'] for r in results.values()) else 'failed',
            'limitations':['Original synthetic benchmarks, not official ARC, PlanBench, or tau2 scores.',
                           'Author knows task families and writes both candidates and evaluators; no independent blinding.',
                           'Contract correctness includes explicit abstention; it is not the same as solving every task.',
                           'No live-model baseline, learned trace compiler, weight transfer, or autonomous source revision.',
                           'Program search is limited to a declared visual grammar. Beyond-grammar tasks stay unsupported.',
                           'Fixed algorithmic baselines use the same task data, not necessarily equal computation.',
                           'Python-level offline audit, not kernel-enforced network isolation.']}
    path=Path(output); path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(report,indent=2)+'\n')
    return report

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(); parser.add_argument('--out',required=True)
    parser.add_argument('--seed',type=int,default=880301); parser.add_argument('--count',type=int,default=60)
    args=parser.parse_args(); result=benchmark(args.out,args.seed,args.count)
    print(json.dumps({'status':result['status'],'passed_contract':result['passed_contract'],'total':result['total'],
                      'families':{k:{x:v[x] for x in ('passed_contract','total','outcomes','baseline')} for k,v in result['results'].items()}},indent=2))
    sys.exit(0 if result['status']=='passed' else 2)
