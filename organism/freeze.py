"""Rebuild the reviewed partition capsule with the unchanged Melt exporter."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'melt'))
from cli import export

receipt = export('partition', ROOT / 'frozen/partition.py', ROOT / 'capsules')
receipt['file'] = 'organism/frozen/partition.py'
receipt['purpose'] = 'Static hypothesis filtering and categorical partitions; no target code'
(ROOT / 'frozen/receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
