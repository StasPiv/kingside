#!/bin/bash
# Читаемый вывод логов агентов
LOG="${1:-/home/pivovartsev/work/kingside/logs/agents.log}"
tail -f -n +1 "$LOG" | python3 -u -c "
import sys, json
from datetime import datetime

# sid[:8] -> AGENT_NAME
agents = {}
# sid[:8] -> datetime старта текущего сообщения
start_ts = {}
# agent_name_lower -> текущая задача (KS-XXX)
current_task = {}
# agent_name_lower -> sid[:8]
agent_sid = {}

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

def label(sid):
    name = agents.get(sid, sid)
    for aname, asid in agent_sid.items():
        if asid == sid:
            task = current_task.get(aname, '')
            if task:
                return f'{name} {task}'
    return name

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

    if t == 'agent_msg':
        agent = d.get('agent', '')
        task = d.get('task', '')
        current_task[agent.lower()] = task
        print(f'{now()} [{agent} {task}] <<< новое сообщение >>>')

    elif t == 'agent_init':
        agent = d.get('agent', '')
        sid = d.get('session_id', '')[:8]
        agents[sid] = agent.upper()
        agent_sid[agent.lower()] = sid
        start_ts[sid] = datetime.now()
        print(f'{now()} [{agent.upper()}] === DAEMON ЗАПУЩЕН ===')

    elif t == 'system' and d.get('subtype') == 'init':
        if sid not in agents:
            agents[sid] = sid
            start_ts[sid] = datetime.now()
            print(f'{now()} [{sid}] === DAEMON ЗАПУЩЕН ===')

    elif t == 'assistant':
        msg = d.get('message', {})
        lbl = label(sid)
        d_str = delta(sid)
        for c in msg.get('content', []):
            if c.get('type') == 'thinking':
                text = c.get('thinking', '')
                if text:
                    print(f'{now()}{d_str} [{lbl}] {text}')
                    d_str = ''
            elif c.get('type') == 'text':
                text = c.get('text', '')
                if text:
                    print(f'{now()}{d_str} [{lbl}] {text}')
                    d_str = ''
            elif c.get('type') == 'tool_use':
                tname = c.get('name', '')
                inp = json.dumps(c.get('input', {}), ensure_ascii=False)
                print(f'{now()}{d_str} [{lbl}] {tname} -> {inp}')
                d_str = ''

    elif t == 'result':
        lbl = label(sid)
        cost = d.get('total_cost_usd', 0)
        d_str = delta(sid)
        start_ts[sid] = datetime.now()
        print(f'{now()}{d_str} [{lbl}] === ГОТОВ (\${cost:.4f}) ===')
"
