import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from geo import audit

ROOT = Path(__file__).resolve().parents[2]


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.c = json.loads((ROOT/'geo/target.json').read_text())
        self.q = self.c['queries'][0]

    def record(self, raw='Plausible is an option.', **kwargs):
        r = audit.make_record(self.q, 'chatgpt-consumer', raw)
        r.update(kwargs)
        return r

    def load(self, records):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp)/'captures.jsonl'
            f.write_text(''.join(audit.stable(r)+'\n' for r in records))
            return audit.read_records(f,self.c)

    def row(self, records):
        a = audit.analyze(self.c,records)
        return next(r for r in a['opportunity_queue'] if r['query_id']==self.q['id'] and r['engine']=='chatgpt-consumer')

    def test_unknown_is_not_absence(self):
        r = self.row([])
        self.assertIsNone(r['opportunity_score'])
        self.assertIsNone(r['metrics']['GoatCounter']['visibility'])

    def test_failures_do_not_change_denominator(self):
        records,_ = self.load([self.record('GoatCounter'),self.record('blocked',status='blocked')])
        r = self.row(records)
        self.assertEqual((r['n'],r['failed'],r['metrics']['GoatCounter']['visibility']),(1,1,1))

    def test_duplicate_ids_count_once_and_conflicts_fail(self):
        a = self.record()
        records, exclusions = self.load([a,a])
        self.assertEqual(len(records),1)
        self.assertEqual(len(exclusions),1)
        b = dict(a,model='changed')
        with self.assertRaisesRegex(ValueError,'conflicting'):
            self.load([a,b])

    def test_fixture_exclusion(self):
        records, exclusions = self.load([self.record('GoatCounter',evidence_kind='illustrative')])
        self.assertEqual(records,[])
        self.assertEqual(len(exclusions),1)

    def test_tampered_raw_evidence_fails(self):
        with self.assertRaisesRegex(ValueError,'hash'):
            self.load([self.record(sha256='wrong')])

    def test_prompt_changes_are_new_queries(self):
        with self.assertRaisesRegex(ValueError,'query text mismatch'):
            self.load([self.record(prompt='Tell me about GoatCounter')])

    def test_url_not_mention_and_domain_boundary(self):
        b = self.c['brands'][0]
        self.assertFalse(audit.mentions(audit.answer_text(self.record('https://goatcounter.com')),b))
        self.assertFalse(audit.belongs('https://evilgoatcounter.com/',b))
        self.assertFalse(audit.belongs('https://goatcounter.com.evil.test/',b))
        self.assertTrue(audit.belongs('https://docs.goatcounter.com/',b))
        self.assertFalse(audit.mentions('FakeGoatCounterish',b))

    def test_citation_chips_do_not_create_mentions(self):
        r = self.record('  - paragraph: Consider alternatives.\n  - button "View source details for GoatCounter":\n    - generic: GoatCounter\n  - dialog:\n    - paragraph: GoatCounter',format='dom-snapshot')
        self.assertFalse(audit.mentions(audit.answer_text(r),self.c['brands'][0]))

    def test_citation_must_exist_in_raw(self):
        with self.assertRaisesRegex(ValueError,'citation URL missing'):
            self.load([self.record(citations=[{'url':'https://goatcounter.com/'}])])

    def test_sentiment_needs_evidence(self):
        with self.assertRaisesRegex(ValueError,'sentiment annotation needs'):
            self.load([self.record(sentiment_reviews={'GoatCounter':{'label':'positive','quote':'made up','reviewer':'test'}})])

    def test_binary_voice_not_repetition(self):
        r = self.row([self.record('GoatCounter GoatCounter GoatCounter Plausible')])
        self.assertEqual(r['metrics']['GoatCounter']['share_of_voice'],0.5)

    def test_strata_not_pooled(self):
        a = audit.analyze(self.c,[self.record('GoatCounter',model='v1'),self.record('Plausible',model='v2')])
        rows = [r for r in a['opportunity_queue'] if r['n']]
        self.assertEqual(len(rows),2)
        self.assertTrue(all(r['n']==1 for r in rows))

    def test_wilson_edge_cases(self):
        self.assertIsNone(audit.wilson(0,0))
        self.assertAlmostEqual(audit.wilson(0,2)[1],0.6576197725)
        self.assertAlmostEqual(audit.wilson(2,2)[0],0.3423802275)

    def test_blocked_api_stops_without_network_or_billing(self):
        with patch('urllib.request.urlopen') as fetch:
            with self.assertRaisesRegex(ValueError,'billing-disabled'):
                audit.collect(self.c,'unused.jsonl','gemini-api',1,True,'test-model',False)
            fetch.assert_not_called()

    def test_pilot_is_real_and_reproducible(self):
        records, exclusions = audit.read_records(ROOT/'geo/evidence/captures.jsonl',self.c)
        a = audit.analyze(self.c,records,exclusions)
        self.assertEqual(len(records),5)
        self.assertEqual(len(a['framing_contrasts']),1)
        self.assertEqual(a['framing_contrasts'][0]['sample_sizes'],[2,2])
        self.assertIn('No illustrative engine answers',audit.report(a))
        for r in records:
            snapshot = json.loads((ROOT/'geo/evidence'/r['provenance']['snapshot']).read_text())['snapshot']
            self.assertEqual(audit.digest(snapshot),r['provenance']['snapshot_sha256'])
            self.assertIn(r['raw_answer'],snapshot)


if __name__ == '__main__':
    unittest.main()
