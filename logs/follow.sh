#!/bin/bash
# Читаемый вывод логов агентов
LOG="${1:-/home/pivovartsev/work/kingside/logs/agents.log}"
tail -f -n +1 "$LOG" | python3 -u -c "
import sys, json
from datetime import datetime

agents = {}
start_ts = {}
pending_tasks = {}

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
        agent = d.get('agent', '')
        task = d.get('task', '')
        pending_tasks[agent.lower()] = f'{agent} [{task}]'

    elif t == 'agent_msg':
        # v2: сообщение отправлено daemon-агенту
        agent = d.get('agent', '')
        task = d.get('task', '')
        print(f'{now()} [{agent}] <<< задача {task} >>>')

    elif t == 'agent_init':
        agent = d.get('agent', '')
        sid = d.get('session_id', '')[:8]
        name = pending_tasks.pop(agent, agent.upper())
        agents[sid] = name
        start_ts[sid] = datetime.now()
        print(f'{now()} [{sid}] === {name} ЗАПУЩЕН ===')

    elif t == 'system' and d.get('subtype') == 'init':
        if sid not in agents:
            agent_name = d.get('agent', sid)
            agents[sid] = agent_name.upper() if agent_name else sid
            start_ts[sid] = datetime.now()
            print(f'{now()} [{sid}] === DAEMON {agents[sid]} ЗАПУЩЕН ===')

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
        name = agents.get(sid, 'АГЕНТ')
        cost = d.get('total_cost_usd', 0)
        d_str = delta(sid)
        # В v2 daemon не завершается после result — обновляем таймер
        start_ts[sid] = datetime.now()
        print(f'{now()}{d_str} [{sid}] === {name} ГОТОВ (\${cost:.4f}) ===')
"
