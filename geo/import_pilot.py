"""Convert preserved browser snapshots to captures without rewriting answer content."""
import json
from pathlib import Path
from geo.audit import digest, stable

ROOT = Path(__file__).resolve().parent
config = json.loads((ROOT/'target.json').read_text())
records = []
for i in range(1,5):
    source = json.loads((ROOT/f'evidence/capture-{i}.json').read_text())
    snapshot = source['snapshot']
    begin = '  - heading "ChatGPT said:" [level=4]\n'
    end = '  - group "Response actions":'
    assert begin in snapshot and end in snapshot and 'Stop answering' not in snapshot
    answer = snapshot.split(begin,1)[1].split(end,1)[0]
    q = config['queries'][0 if i<=2 else 1]
    assert q['prompt'] in snapshot
    urls = [line.split('- /url: ',1)[1].strip() for line in answer.splitlines() if '- /url: https' in line]
    records.append({'id':f'chatgpt-pilot-{i}', 'query_id':q['id'], 'prompt':q['prompt'],
        'engine':'chatgpt-consumer','model':'ChatGPT (underlying model not disclosed)',
        'observed_at':source['observedAt'],'status':'ok','evidence_kind':'measured','raw_answer':answer,
        'sha256':digest(answer),'format':'dom-snapshot','citation_coverage':'visible-only',
        'citations':[{'url':u} for u in sorted(set(urls))],
        'context':{'session':'anonymous-cloud-pilot-2026-09-07','locale':'English','region':'unknown',
            'search':'automatic; cited links visible','collector':'browser-dom-snapshot','new_chat':True},
        'provenance':{'snapshot':f'capture-{i}.json','snapshot_sha256':digest(snapshot),'surface_url':source['url'],
            'clock':'browser collector clock; retained verbatim, not independently synchronized',
            'note':'Anonymous chat URL is not a replay/share link. Snapshot is the preserved evidence.'}})
records[2]['sentiment_reviews'] = {'GoatCounter':{'label':'positive',
    'quote':'Probably the best fit for a small site.', 'reviewer':'Codex analyst',
    'note':'Positive recommendation in this answer; not a verified product-quality claim.'}}
source = json.loads((ROOT/'evidence/gemini-1.json').read_text())
snapshot = source['snapshot']
answer = snapshot.split('  - heading "Gemini said" [level=6]\n',1)[1].split('  - button "Redo":',1)[0]
urls = [line.split('- /url: ',1)[1].strip() for line in answer.splitlines() if '- /url: https' in line]
q = config['queries'][0]
assert q['prompt'] in snapshot
records.append({'id':'gemini-pilot-1','query_id':q['id'],'prompt':q['prompt'],
    'engine':'gemini-consumer','model':'Flash-Lite (UI label; version not disclosed)',
    'observed_at':source['observedAt'],'status':'ok','evidence_kind':'measured','raw_answer':answer,
    'sha256':digest(answer),'format':'dom-snapshot','citation_coverage':'visible-only',
    'citations':[{'url':u} for u in sorted(set(urls))],
    'context':{'session':'anonymous-cloud-pilot-2026-09-07','locale':'English','region':'unknown',
        'search':'automatic; source details visible','collector':'browser-dom-snapshot','new_chat':True},
    'provenance':{'snapshot':'gemini-1.json','snapshot_sha256':digest(snapshot),'surface_url':source['url'],
        'clock':'browser collector clock; retained verbatim, not independently synchronized',
        'note':'Only one expanded citation drawer captured; source coverage is partial.'}})
(ROOT/'evidence/captures.jsonl').write_text(''.join(stable(r)+'\n' for r in records))
print('Imported',len(records),'actual browser answers')
