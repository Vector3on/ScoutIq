import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cli import bundle
from runtime import Engine
from benchmarks.suite import (apply, counter_task, generate, diagnosis_reference,
                               greedy_diagnosis, verify_policy, replay)

def run(name,data):
    answer=Engine(bundle(name)).run(data)
    if answer['status']!='ok': raise AssertionError(answer)
    return answer['result']

class ReasoningTests(unittest.TestCase):
    def test_setback_and_nonuniform_cost(self):
        data=next(c['input'] for c in generate(1717,8)['state_planner'] if c['tag']=='setback' and c['input']['actions'][-1]['cost']==25)
        answer=run('state_planner',data)
        self.assertEqual(answer['plan'],['prepare','authorize','prepare','deliver'])
        self.assertEqual(answer['cost'],4)
        self.assertTrue(replay(data,answer))

    def test_planner_representation_invariance(self):
        data=counter_task(5)
        expected=run('state_planner',data)['cost']
        # Rename/reorder actions and reverse the ordering of all state dimensions.
        data['initial'].reverse(); data['goal'].reverse(); data['actions'].reverse()
        for i,action in enumerate(data['actions']):
            action['name']='opaque-'+str(i)
            action['pre'].reverse(); action['effect'].reverse()
        self.assertEqual(run('state_planner',data)['cost'],expected)

    def test_budget_is_not_unreachability(self):
        answer=run('state_planner',counter_task(6,2))
        self.assertEqual(answer['outcome'],'budget_exhausted')
        self.assertEqual(run('state_planner',counter_task(6))['cost'],63)

    def test_visual_witnesses_really_disagree(self):
        data={'examples':[{'input':[[0]],'output':[[0]]}],'query':[[1]]}
        answer=run('visual_rule',data)
        self.assertEqual(answer['outcome'],'ambiguous')
        a,b=answer['witness_programs']
        self.assertNotEqual(apply(data['query'],a),apply(data['query'],b))
        for program in (a,b): self.assertEqual(apply([[0]],program),[[0]])

    def test_visual_outside_language(self):
        data={'examples':[{'input':[[1,2]],'output':[[1,2,1,2]]}],'query':[[2,1]]}
        self.assertEqual(run('visual_rule',data)['outcome'],'unsupported')

    def test_diagnosis_lookahead_improves_cost(self):
        cases=generate(1717,8)['diagnose']
        compared=False
        for case in cases:
            expected,cost=diagnosis_reference(case['input'])
            if expected=='solved' and greedy_diagnosis(case['input'])>cost:
                answer=run('diagnose',case['input'])
                self.assertEqual(answer['worst_cost'],cost)
                self.assertTrue(verify_policy(case['input'],answer)); compared=True
                break
        self.assertTrue(compared)

    def test_diagnosis_refines_after_observation(self):
        data={'hypotheses':['a','b','c','d'],'tests':[
            {'name':'left','cost':1,'outcomes':['0','0','1','1']},
            {'name':'right','cost':1,'outcomes':['0','1','0','1']}]}
        self.assertEqual(run('diagnose',data)['worst_cost'],2)
        data['observed']={'left':'1'}
        result=run('diagnose',data)
        self.assertEqual(result['worst_cost'],1)
        self.assertTrue(verify_policy(data,result))
        data['observed']['right']='0'
        self.assertEqual(run('diagnose',data)['policy'],{'hypothesis':'c'})

    def test_malformed_complex_inputs_rejected(self):
        bad=[('state_planner',{'initial':[0],'goal':[1],'actions':[{'name':'x','cost':-1,'pre':[None],'effect':[1]}]}),
             ('visual_rule',{'examples':[],'query':[[1]]}),
             ('visual_rule',{'examples':[{'input':[[1]],'output':[[1]]}],'query':[[1]],'max_depth':4}),
             ('diagnose',{'hypotheses':['a','a'],'tests':[]}),
             ('diagnose',{'hypotheses':['a'],'tests':[],'observed':{'missing':'yes'}})]
        for name,data in bad:
            with self.subTest(name=name,data=data):
                self.assertEqual(Engine(bundle(name)).run(data)['status'],'rejected')

if __name__=='__main__': unittest.main()
