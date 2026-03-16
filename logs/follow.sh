#!/bin/bash
# Читаемый вывод логов агентов
LOG="${1:-/home/pivovartsev/work/kingside/logs/agents.log}"
tail -f -n +1 "$LOG" | python3 -u -c "
import sys, json
from datetime import datetime

from collections import deque

agents = {}
start_ts = {}
pending_names = deque()

def now():
    return datetime.now().strftime('%H:%M:%S')

def delta(sid):
    start = start_ts.get(sid)
    if start is None:
        return ''
    s = (datetime.now() - start).total_seconds()
    if s < 60:
        return f' +{s:.0f}s'
    return f' +{s/60:.1f}m'

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except:
        continue
    t = d.get('type', '')
    sid = d.get('session_id', '')[:8]

    if t == 'agent_start':
        pending_names.append(f'{d[\"agent\"]} [{d[\"task\"]}]')

    elif t == 'system' and d.get('subtype') == 'init':
        model = d.get('model', '')
        name = pending_names.popleft() if pending_names else 'АГЕНТ'
        agents[sid] = name
        start_ts[sid] = datetime.now()
        print(f'{now()} [{sid}] === {name} ЗАПУЩЕН ({model}) ===')

    elif t == 'assistant':
        msg = d.get('message', {})
        label = agents.get(sid, sid)
        d_str = delta(sid)
        for c in msg.get('content', []):
            if c.get('type') == 'thinking':
                text = c.get('thinking', '')
                if text:
                    print(f'{now()}{d_str} [{label}] {text}')
                    d_str = ''
            elif c.get('type') == 'text':
                text = c.get('text', '')
                if text:
                    print(f'{now()}{d_str} [{label}] {text}')
                    d_str = ''
            elif c.get('type') == 'tool_use':
                tname = c.get('name', '')
                inp = json.dumps(c.get('input', {}), ensure_ascii=False)
                print(f'{now()}{d_str} [{label}] {tname} -> {inp}')
                d_str = ''

    elif t == 'result':
        name = agents.pop(sid, 'АГЕНТ')
        start_ts.pop(sid, None)
        cost = d.get('total_cost_usd', 0)
        d_str = delta(sid)
        print(f'{now()}{d_str} [{sid}] === {name} ЗАВЕРШЁН (\${cost:.4f}) ===')
"
