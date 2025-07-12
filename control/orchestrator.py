# control/orchestrator.py
import json
import os
import time
import subprocess
import shutil
import numpy as np
from datetime import datetime

from inference.graph_manager import InvestigationGraph
from inference.confidence_scorer import calculate_heuristic_score
from control.rl_agent import ContextualBanditAgent, ARMS
from inference.causal_model import build_causal_model, check_causal_consistency

ACTION_CONTINUE = "[CONTINUE]"
ACTION_REFLECT = "[REFLECT]"
ACTION_END = "[END]"
SCANNER_TIMEOUT_SECONDS = 120
TRIGGER_DIR = "/tmp/scoutiq_triggers"
INVESTIGATION_LOG_DIR = "/tmp/scoutiq_investigations"
PROCESSED_DIR = os.path.join(TRIGGER_DIR, "processed")
ERROR_DIR = os.path.join(TRIGGER_DIR, "error")

class ReasoningAgent:
    def __init__(self):
        print(f"\nAutonomous Contextual RL Agent is online.")
        self.investigations = {}
        self.rl_agent = ContextualBanditAgent(n_features=4)
        self.causal_model = build_causal_model("Ex_FAANG_Al_Architect")
        
        os.makedirs(TRIGGER_DIR, exist_ok=True)
        os.makedirs(INVESTIGATION_LOG_DIR, exist_ok=True)
        os.makedirs(PROCESSED_DIR, exist_ok=True)
        os.makedirs(ERROR_DIR, exist_ok=True)

    def log_event(self, investigation_id: str, event_data: dict):
        log_path = os.path.join(INVESTIGATION_LOG_DIR, f"{investigation_id}.jsonl")
        log_entry = {"timestamp": datetime.utcnow().isoformat(), **event_data}
        with open(log_path, 'a') as f: f.write(json.dumps(log_entry) + '\n')
        print(f" [LOG] {investigation_id} | {event_data['type']} | {event_data.get('summary')}")

    def create_context_vector(self, state: dict) -> np.array:
        trigger_source = state.get('trigger_source', '')
        investigation = self.investigations.get(state['id'])
        
        is_domain_trigger = 1 if trigger_source == "certspotter" else 0
        is_person_trigger = 1 if trigger_source == "person_of_interest" else 0
        is_reddit_trigger = 1 if trigger_source == "reddit_founder_cluster" else 0
        current_confidence = investigation['confidence_score'] if investigation else 0.0
        
        context = np.array([is_domain_trigger, is_person_trigger, is_reddit_trigger, current_confidence])
        print(f" [AGENT_LOGIC] Created context vector: {context}")
        return context

    def decide_next_action(self, state: dict) -> tuple[str, dict, int]:
        """
        The agent now makes a decision purely based on the RL policy.
        The hard-coded rules have been removed.
        """
        investigation = self.investigations.get(state['id'])
        if not investigation or investigation.get('actions_taken', 0) >= 3:
            return ACTION_END, {}, -1

        context = self.create_context_vector(state)
        action_params, arm_index = self.rl_agent.choose_action(context)
        
        return ACTION_CONTINUE, action_params, arm_index

    def execute_scanner(self, scanner_path: str, target: str):
        command = []
        if scanner_path.endswith(".js"): command = ["node", scanner_path, f"https://{target}"]
        elif scanner_path.endswith(".py"):
            if "reddit" in scanner_path: command = ["python", scanner_path]
            else: command = ["python", scanner_path, target]
        
        if not command: return {"error": "Invalid scanner path"}
        
        try:
            timeout = 3600 if "reddit" in scanner_path else SCANNER_TIMEOUT_SECONDS
            result = subprocess.run(command, capture_output=True, text=True, check=True, encoding='utf-8', timeout=timeout)
            return json.loads(result.stdout)
        except (subprocess.TimeoutExpired, Exception) as e:
            return {"error": getattr(e, 'stderr', str(e))}

    def process_scan_data(self, investigation, target, scan_data, scanner_name):
        if not scan_data or "error" in scan_data: return
        graph_manager = investigation['graph_manager']
        
        if scanner_name == "tech_stack_scanner":
            graph_manager.add_tech_stack(target, scan_data.get("technologies", []))
        elif scanner_name == "github_scanner":
            for org in scan_data.get("organizations", []):
                graph_manager.add_github_org(target, org)
        elif scanner_name == "reddit_scanner":
            for founder in scan_data.get("potential_founders", []):
                graph_manager.add_reddit_fingerprint(founder)
        elif scanner_name == "github_activity_scanner":
            graph_manager.add_activity_signal(target, scan_data)

    def run_reasoning_cycle(self, investigation_id: str):
        investigation = self.investigations[investigation_id]
        state = investigation['state']
        
        print(f"\n--- Agent reasoning about: {investigation_id} ---")
        action_type, action_params, arm_index = self.decide_next_action(state)
        
        scanner_name = action_params.get("scanner_name")
        self.log_event(investigation_id, {"type": "AGENT_THOUGHT", "summary": f"Agent chose action '{scanner_name if scanner_name else action_type}'."})
        
        if action_type == ACTION_CONTINUE:
            investigation['actions_taken'] += 1
            score_before = investigation['confidence_score']
            target = state['target']

            self.log_event(investigation_id, {"type": "EXECUTING_SCANNER", "summary": f"Running {scanner_name} on {target}"})
            scan_data = self.execute_scanner(action_params["scanner_path"], target)
            
            if "error" not in scan_data:
                self.log_event(investigation_id, {"type": "NEW_SIGNAL", "source": scanner_name, "summary": f"Successfully parsed data for {target}."})
                self.process_scan_data(investigation, target, scan_data, scanner_name)
                investigation['confidence_score'] = calculate_heuristic_score(investigation['graph_manager'].graph)
                self.log_event(investigation['id'], {"type": "CONFIDENCE_UPDATE", "summary": f"New confidence score is {investigation['confidence_score']}"})
            else:
                 self.log_event(investigation_id, {"type": "SCANNER_FAILURE", "summary": f"Scanner {scanner_name} failed: {scan_data['error']}"})

            score_after = investigation['confidence_score']
            reward = score_after - score_before
            
            # Punish for choosing a scanner that is not applicable to the trigger type
            trigger_type = state['trigger_source']
            if (trigger_type == 'certspotter' and scanner_name != 'tech_stack_scanner') or \
               (trigger_type == 'person_of_interest' and scanner_name not in ['github_scanner', 'github_activity_scanner']):
                reward -= 0.5 # Penalty for wrong action type
                print(f" [AGENT_LOGIC] Applied penalty. Action '{scanner_name}' is not ideal for trigger '{trigger_type}'.")

            if "error" in scan_data: reward = -1.0 # Heavy penalty for failing scanners
            
            context = self.create_context_vector(state)
            self.rl_agent.update_policy(context, arm_index, reward)
        else:
            self.log_event(investigation_id, {"type": "INVESTIGATION_END", "summary": "Agent has no more actions for this target."})

        print("--- Agent finished reasoning cycle ---")

    def start_investigation(self, trigger_data: dict):
        source = trigger_data.get('trigger_source')
        investigation_id, target = "", ""

        if source == 'certspotter':
            investigation_id = target = trigger_data.get("dns_names", ["unknown"])[0].replace('*.', 'wildcard_')
        elif source == 'person_of_interest':
            investigation_id = target = trigger_data.get('username', 'unknown_person')
        
        if not investigation_id: return

        if investigation_id not in self.investigations:
            graph_manager = InvestigationGraph(investigation_id)
            state = {"id": investigation_id, "trigger_source": source, "target": target}
            self.investigations[investigation_id] = {
                "graph_manager": graph_manager, 
                "confidence_score": 0.0, 
                "id": investigation_id,
                "state": state,
                "actions_taken": 0
            }
            print(f"\n{'='*60}\nNew Investigation Triggered: {investigation_id}\n{'='*60}")
            if source == 'certspotter': graph_manager.add_node(target, 'Domain')
            elif source == 'person_of_interest': graph_manager.add_node(target, 'Person', username=target)
        
        self.log_event(investigation_id, {"type": "INITIAL_TRIGGER", "source": source, "summary": f"Received trigger for: {investigation_id}"})
        self.run_reasoning_cycle(investigation_id)

    def listen_for_triggers(self):
        while True:
            try:
                trigger_files = sorted([f for f in os.listdir(TRIGGER_DIR) if os.path.isfile(os.path.join(TRIGGER_DIR, f)) and f.endswith('.json')])
                if not trigger_files:
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] No new triggers found. Waiting... (IST)", end='\r')
                    time.sleep(5)
                    continue

                filename = trigger_files[0]
                filepath = os.path.join(TRIGGER_DIR, filename)
                print(f"\n[QUEUE] Processing trigger file: {filename}")
                
                with open(filepath, 'r') as f: data = json.load(f)

                if data and data.get('trigger_source'): self.start_investigation(data)
                else: print(f"[AGENT_WARN] Invalid or empty trigger file: {filename}. Archiving.")

                shutil.move(filepath, os.path.join(PROCESSED_DIR, filename))

            except Exception as e:
                print(f"[AGENT_CRITICAL] An unexpected error occurred in the listener loop: {e}")
                if 'filepath' in locals() and filepath and os.path.exists(filepath):
                    shutil.move(filepath, os.path.join(ERROR_DIR, os.path.basename(filepath)))
                time.sleep(10)

if __name__ == '__main__':
    agent = ReasoningAgent()
    agent.listen_for_triggers()