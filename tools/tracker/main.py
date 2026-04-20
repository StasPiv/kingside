#!/usr/bin/env python3
"""Kingside Tracker — lightweight task tracker for agent coordination."""

import json
import os
import sqlite3
import threading
import urllib.request
import yaml
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

app = FastAPI(title="Kingside Tracker", version="0.1.0")

CONFIG_PATH = Path(__file__).parent / "config.yaml"
DB_PATH = os.environ.get("TRACKER_DB", str(Path(__file__).parent / "tracker.db"))
WEBHOOK_URL = os.environ.get("TRACKER_WEBHOOK_URL", "")  # e.g. http://localhost:9876/tracker
WEBHOOK_AUTH_TOKEN = os.environ.get("WEBHOOK_AUTH_TOKEN", "")
PROJECT_PREFIX = os.environ.get("TRACKER_PREFIX", "KS")


def load_agents() -> list[str]:
    try:
        with open(CONFIG_PATH) as f:
            return yaml.safe_load(f).get("agents", [])
    except (FileNotFoundError, yaml.YAMLError):
        return []


AGENTS = load_agents()

_local = threading.local()


def get_db() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


@contextmanager
def db():
    conn = get_db()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


STATUSES = {"todo": "To Do", "in_progress": "In Progress", "done": "Done"}
TRANSITIONS = {11: "todo", 21: "in_progress", 41: "done"}


def init_db():
    with db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS issues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                summary TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'todo',
                assignee TEXT DEFAULT '',
                labels TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                issue_key TEXT NOT NULL REFERENCES issues(key),
                author TEXT DEFAULT '',
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_key);
            CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
        """)
        # Миграция: добавить labels в существующие issues
        cols = [r[1] for r in conn.execute("PRAGMA table_info(issues)").fetchall()]
        if "labels" not in cols:
            conn.execute("ALTER TABLE issues ADD COLUMN labels TEXT DEFAULT ''")


def _normalize_labels(labels) -> str:
    """Нормализует labels: list|str → 'lab1,lab2,lab3' (без дубликатов, lowercase)."""
    if not labels:
        return ""
    if isinstance(labels, str):
        parts = labels.split(",")
    else:
        parts = list(labels)
    seen = []
    for p in parts:
        p = p.strip().lower()
        if p and p not in seen:
            seen.append(p)
    return ",".join(seen)


def next_key() -> str:
    conn = get_db()
    row = conn.execute(
        "SELECT key FROM issues WHERE key LIKE ? ORDER BY CAST(SUBSTR(key, ?) AS INTEGER) DESC LIMIT 1",
        (f"{PROJECT_PREFIX}-%", len(PROJECT_PREFIX) + 2),
    ).fetchone()
    if row:
        n = int(row[0].split("-", 1)[1]) + 1
    else:
        n = 1
    return f"{PROJECT_PREFIX}-{n}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fire_webhook(event: str, data: dict):
    if not WEBHOOK_URL:
        return
    payload = json.dumps({"event": event, **data}).encode()
    headers = {"Content-Type": "application/json"}
    if WEBHOOK_AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {WEBHOOK_AUTH_TOKEN}"
    try:
        req = urllib.request.Request(
            WEBHOOK_URL, data=payload,
            headers=headers,
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def row_to_dict(row) -> dict:
    return dict(row) if row else {}


# --- Models ---

class IssueCreate(BaseModel):
    summary: str
    description: str = ""
    assignee: str = ""
    labels: Optional[list] = None
    key: Optional[str] = None  # explicit key for import

class IssueUpdate(BaseModel):
    summary: Optional[str] = None
    description: Optional[str] = None
    assignee: Optional[str] = None
    status: Optional[str] = None
    labels: Optional[list] = None

class TransitionRequest(BaseModel):
    id: int  # 21=in_progress, 41=done

class CommentCreate(BaseModel):
    author: str = ""
    body: str


# --- API ---

@app.on_event("startup")
def startup():
    init_db()


@app.get("/api/agents")
def list_agents():
    return AGENTS


@app.get("/api/issues")
def list_issues(
    status: Optional[str] = Query(None),
    assignee: Optional[str] = Query(None),
    q: Optional[str] = Query(None, alias="search"),
    labels: Optional[str] = Query(None, description="CSV меток — задача должна содержать ВСЕ указанные"),
):
    conn = get_db()
    sql = "SELECT * FROM issues WHERE 1=1"
    params = []
    if status:
        sql += " AND status = ?"
        params.append(status)
    if assignee:
        sql += " AND assignee = ?"
        params.append(assignee)
    if q:
        sql += " AND (summary LIKE ? OR description LIKE ? OR key LIKE ?)"
        term = f"%{q}%"
        params.extend([term, term, term])
    if labels:
        for label in labels.split(","):
            label = label.strip().lower()
            if label:
                sql += " AND (',' || labels || ',') LIKE ?"
                params.append(f"%,{label},%")
    sql += " ORDER BY id DESC"
    rows = conn.execute(sql, params).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/issues", status_code=201)
def create_issue(data: IssueCreate, validate: bool = Query(True)):
    ts = now_iso()
    if validate and data.assignee and AGENTS and data.assignee not in AGENTS:
        raise HTTPException(400, f"Unknown agent: {data.assignee}. Valid: {AGENTS}")
    # Метки обязательны (1-3)
    if validate:
        labels_list = data.labels if isinstance(data.labels, list) else (
            [l.strip() for l in data.labels.split(",")] if data.labels else []
        )
        labels_list = [l for l in (labels_list or []) if l and l.strip()]
        if not labels_list:
            raise HTTPException(400, "Field 'labels' is required. Provide 1-3 labels (e.g. [\"game\", \"mobile\"]).")
        if len(labels_list) > 3:
            raise HTTPException(400, f"Too many labels ({len(labels_list)}). Maximum is 3.")
    key = data.key or next_key()
    # Check duplicate
    if get_db().execute("SELECT 1 FROM issues WHERE key = ?", (key,)).fetchone():
        raise HTTPException(409, f"Issue {key} already exists")
    labels = _normalize_labels(data.labels)
    with db() as conn:
        conn.execute(
            "INSERT INTO issues (key, summary, description, status, assignee, labels, created_at, updated_at) VALUES (?, ?, ?, 'todo', ?, ?, ?, ?)",
            (key, data.summary, data.description, data.assignee, labels, ts, ts),
        )
    issue = row_to_dict(get_db().execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone())
    fire_webhook("issue_created", {"issue": issue})
    return issue


@app.get("/api/issues/{key}")
def get_issue(key: str):
    row = get_db().execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone()
    if not row:
        raise HTTPException(404, f"Issue {key} not found")
    return row_to_dict(row)


@app.patch("/api/issues/{key}")
def update_issue(key: str, data: IssueUpdate):
    conn = get_db()
    row = conn.execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone()
    if not row:
        raise HTTPException(404, f"Issue {key} not found")

    updates = {}
    if data.summary is not None:
        updates["summary"] = data.summary
    if data.description is not None:
        updates["description"] = data.description
    if data.assignee is not None:
        if data.assignee and AGENTS and data.assignee not in AGENTS:
            raise HTTPException(400, f"Unknown agent: {data.assignee}. Valid: {AGENTS}")
        updates["assignee"] = data.assignee
    if data.status is not None:
        if data.status not in STATUSES:
            raise HTTPException(400, f"Invalid status: {data.status}")
        updates["status"] = data.status
    if data.labels is not None:
        updates["labels"] = _normalize_labels(data.labels)

    if not updates:
        return row_to_dict(row)

    updates["updated_at"] = now_iso()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [key]

    with db() as c:
        c.execute(f"UPDATE issues SET {set_clause} WHERE key = ?", values)

    issue = row_to_dict(conn.execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone())
    fire_webhook("issue_updated", {"issue": issue})
    return issue


@app.delete("/api/issues/{key}", status_code=204)
def delete_issue(key: str):
    conn = get_db()
    row = conn.execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone()
    if not row:
        raise HTTPException(404, f"Issue {key} not found")
    with db() as c:
        c.execute("DELETE FROM comments WHERE issue_key = ?", (key,))
        c.execute("DELETE FROM issues WHERE key = ?", (key,))


@app.post("/api/issues/{key}/transitions")
def transition_issue(key: str, data: TransitionRequest):
    new_status = TRANSITIONS.get(data.id)
    if not new_status:
        raise HTTPException(400, f"Unknown transition id: {data.id}")
    conn = get_db()
    row = conn.execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone()
    if not row:
        raise HTTPException(404, f"Issue {key} not found")
    with db() as c:
        c.execute("UPDATE issues SET status = ?, updated_at = ? WHERE key = ?", (new_status, now_iso(), key))
    issue = row_to_dict(conn.execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone())
    fire_webhook("issue_transitioned", {"issue": issue, "transition_id": data.id})
    return issue


@app.get("/api/issues/{key}/comments")
def list_comments(key: str):
    conn = get_db()
    row = conn.execute("SELECT 1 FROM issues WHERE key = ?", (key,)).fetchone()
    if not row:
        raise HTTPException(404, f"Issue {key} not found")
    rows = conn.execute("SELECT * FROM comments WHERE issue_key = ? ORDER BY id", (key,)).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/api/issues/{key}/comments", status_code=201)
def add_comment(key: str, data: CommentCreate):
    conn = get_db()
    row = conn.execute("SELECT 1 FROM issues WHERE key = ?", (key,)).fetchone()
    if not row:
        raise HTTPException(404, f"Issue {key} not found")
    ts = now_iso()
    with db() as c:
        c.execute(
            "INSERT INTO comments (issue_key, author, body, created_at) VALUES (?, ?, ?, ?)",
            (key, data.author, data.body, ts),
        )
    comment = row_to_dict(conn.execute("SELECT * FROM comments WHERE issue_key = ? ORDER BY id DESC LIMIT 1", (key,)).fetchone())
    issue = row_to_dict(conn.execute("SELECT * FROM issues WHERE key = ?", (key,)).fetchone())
    fire_webhook("comment_added", {"issue": issue, "issue_key": key, "comment": comment})
    return comment


# --- Web UI ---

@app.get("/", response_class=HTMLResponse)
def index():
    return HTML_PAGE


HTML_PAGE = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kingside Tracker</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; }
header { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; }
header h1 { font-size: 18px; color: #58a6ff; }
.btn { padding: 6px 14px; border: 1px solid #30363d; border-radius: 6px; background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 13px; }
.btn:hover { background: #30363d; }
.btn-primary { background: #238636; border-color: #238636; color: #fff; }
.btn-primary:hover { background: #2ea043; }
.board { display: flex; gap: 16px; padding: 20px; height: calc(100vh - 56px); overflow-x: auto; }
.column { flex: 1; min-width: 280px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; display: flex; flex-direction: column; }
.column-header { padding: 12px 16px; border-bottom: 1px solid #30363d; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
.column-header .count { background: #30363d; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.cards { flex: 1; overflow-y: auto; padding: 8px; }
.card { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
.card:hover { border-color: #58a6ff; }
.card-key { font-size: 12px; color: #8b949e; margin-bottom: 4px; }
.card-summary { font-size: 14px; margin-bottom: 6px; }
.card-assignee { font-size: 11px; color: #8b949e; }
.label-chip { display: inline-block; background: #1f6feb33; color: #79c0ff; font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-right: 3px; margin-top: 2px; }
.label-chip.removable { cursor: pointer; }
.label-chip.removable:hover { background: #da363333; color: #f85149; }
/* Modal */
.modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; justify-content: center; align-items: flex-start; padding-top: 80px; }
.modal-bg.open { display: flex; }
.modal { background: #161b22; border: 1px solid #30363d; border-radius: 8px; width: 560px; max-height: 80vh; overflow-y: auto; }
.modal-header { padding: 16px; border-bottom: 1px solid #30363d; display: flex; justify-content: space-between; align-items: center; }
.modal-header h2 { font-size: 16px; }
.modal-body { padding: 16px; }
.modal-body label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px; margin-top: 12px; }
.modal-body input, .modal-body textarea, .modal-body select { width: 100%; padding: 8px; border: 1px solid #30363d; border-radius: 6px; background: #0d1117; color: #c9d1d9; font-size: 14px; font-family: inherit; }
.modal-body textarea { min-height: 80px; resize: vertical; }
.modal-footer { padding: 12px 16px; border-top: 1px solid #30363d; display: flex; justify-content: flex-end; gap: 8px; }
/* Detail */
.detail-status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.status-todo { background: #1f2937; color: #9ca3af; }
.status-in_progress { background: #1e3a5f; color: #58a6ff; }
.status-done { background: #1a3d2e; color: #3fb950; }
.comments-list { margin-top: 12px; }
.comment { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px; margin-bottom: 8px; }
.comment-author { font-size: 12px; color: #58a6ff; margin-bottom: 4px; }
.comment-body { font-size: 13px; }
.comment-body p { margin: 4px 0; }
.comment-body pre { background: #161b22; padding: 8px; border-radius: 4px; overflow-x: auto; }
.comment-body code { background: #161b22; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.comment-time { font-size: 11px; color: #484f58; margin-top: 4px; }
.description { font-size: 14px; background: #0d1117; padding: 10px; border-radius: 6px; border: 1px solid #30363d; margin-top: 8px; min-height: 40px; }
.description p { margin: 4px 0; }
.description pre { background: #161b22; padding: 8px; border-radius: 4px; overflow-x: auto; }
.description code { background: #161b22; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.actions { display: flex; gap: 6px; margin-top: 12px; }
</style>
</head>
<body>

<header>
    <h1>Kingside Tracker</h1>
    <button class="btn btn-primary" onclick="openCreate()">+ New Issue</button>
</header>

<div class="board" id="board"></div>

<!-- Create modal -->
<div class="modal-bg" id="createModal">
    <div class="modal">
        <div class="modal-header"><h2>New Issue</h2><button class="btn" onclick="closeCreate()">&times;</button></div>
        <div class="modal-body">
            <label>Summary</label>
            <input id="cSummary" placeholder="Task summary">
            <label>Description</label>
            <textarea id="cDesc" placeholder="Details..."></textarea>
            <label>Assignee</label>
            <select id="cAssignee"><option value="">— unassigned —</option></select>
            <label>Labels (comma-separated)</label>
            <input id="cLabels" placeholder="bug, backend, urgent">
        </div>
        <div class="modal-footer">
            <button class="btn" onclick="closeCreate()">Cancel</button>
            <button class="btn btn-primary" onclick="submitCreate()">Create</button>
        </div>
    </div>
</div>

<!-- Detail modal -->
<div class="modal-bg" id="detailModal">
    <div class="modal">
        <div class="modal-header"><h2 id="dKey"></h2><button class="btn" onclick="closeDetail()">&times;</button></div>
        <div class="modal-body">
            <div style="display:flex;justify-content:space-between;align-items:center">
                <span class="detail-status" id="dStatus"></span>
                <span id="dAssignee" style="font-size:13px;color:#8b949e"></span>
            </div>
            <label>Summary</label>
            <div id="dSummary" style="font-size:15px;font-weight:600;margin-top:4px"></div>
            <label>Description</label>
            <div class="description" id="dDesc"></div>
            <label>Labels</label>
            <div id="dLabels" style="margin-top:4px"></div>
            <input id="dLabelsEdit" placeholder="bug, backend (Enter to save)" style="margin-top:6px;font-size:13px">
            <div class="actions" id="dActions"></div>
            <label style="margin-top:16px">Comments</label>
            <div class="comments-list" id="dComments"></div>
            <div style="margin-top:12px;display:flex;gap:8px">
                <input id="commentAuthor" placeholder="Author" style="width:120px">
                <input id="commentBody" placeholder="Comment..." style="flex:1">
                <button class="btn btn-primary" onclick="addComment()">Send</button>
            </div>
        </div>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
const API = '/api';
function md(s) { try { return marked.parse(s || ''); } catch(e) { return esc(s); } }
let currentKey = null;

async function api(path, opts = {}) {
    const r = await fetch(API + path, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 204) return null;
    return r.json();
}

async function loadBoard() {
    const issues = await api('/issues');
    const cols = { todo: [], in_progress: [], done: [] };
    issues.forEach(i => (cols[i.status] || cols.todo).push(i));

    const names = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
    document.getElementById('board').innerHTML = Object.entries(names).map(([k, v]) => `
        <div class="column">
            <div class="column-header">${v} <span class="count">${cols[k].length}</span></div>
            <div class="cards">${cols[k].map(i => `
                <div class="card" onclick="openDetail('${i.key}')">
                    <div class="card-key">${i.key}</div>
                    <div class="card-summary">${esc(i.summary)}</div>
                    ${i.assignee ? `<div class="card-assignee">${esc(i.assignee)}</div>` : ''}
                    ${i.labels ? `<div>${i.labels.split(',').map(l => `<span class="label-chip">${esc(l)}</span>`).join('')}</div>` : ''}
                </div>
            `).join('')}</div>
        </div>
    `).join('');
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function openCreate() { document.getElementById('createModal').classList.add('open'); document.getElementById('cSummary').focus(); }
function closeCreate() { document.getElementById('createModal').classList.remove('open'); }

async function submitCreate() {
    const summary = document.getElementById('cSummary').value.trim();
    if (!summary) return;
    const labelsStr = document.getElementById('cLabels').value.trim();
    const labels = labelsStr ? labelsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    await api('/issues', { method: 'POST', body: {
        summary,
        description: document.getElementById('cDesc').value,
        assignee: document.getElementById('cAssignee').value.trim(),
        labels,
    }});
    document.getElementById('cSummary').value = '';
    document.getElementById('cDesc').value = '';
    document.getElementById('cAssignee').value = '';
    document.getElementById('cLabels').value = '';
    closeCreate();
    loadBoard();
}

async function openDetail(key) {
    currentKey = key;
    const issue = await api(`/issues/${key}`);
    const comments = await api(`/issues/${key}/comments`);

    document.getElementById('dKey').textContent = key;
    document.getElementById('dSummary').textContent = issue.summary;
    document.getElementById('dDesc').innerHTML = md(issue.description) || '—';
    document.getElementById('dAssignee').textContent = issue.assignee ? `Assignee: ${issue.assignee}` : '';

    const s = document.getElementById('dStatus');
    s.textContent = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' }[issue.status];
    s.className = `detail-status status-${issue.status}`;

    const labelsDiv = document.getElementById('dLabels');
    const labels = issue.labels ? issue.labels.split(',') : [];
    labelsDiv.innerHTML = labels.length
        ? labels.map(l => `<span class="label-chip removable" onclick="removeLabel('${key}','${esc(l)}')" title="click to remove">${esc(l)} &times;</span>`).join('')
        : '<span style="color:#484f58;font-size:12px">no labels</span>';
    document.getElementById('dLabelsEdit').value = '';

    let btns = '';
    if (issue.status === 'todo') btns += `<button class="btn" onclick="transition('${key}',21)">Start</button>`;
    if (issue.status === 'in_progress') btns += `<button class="btn" onclick="transition('${key}',41)">Done</button>`;
    if (issue.status !== 'todo') btns += `<button class="btn" onclick="transition('${key}',11)">Reopen</button>`;
    btns += `<button class="btn" style="margin-left:auto;color:#f85149" onclick="deleteIssue('${key}')">Delete</button>`;
    document.getElementById('dActions').innerHTML = btns;

    document.getElementById('dComments').innerHTML = comments.map(c => `
        <div class="comment">
            <div class="comment-author">${esc(c.author || 'anonymous')}</div>
            <div class="comment-body">${md(c.body)}</div>
            <div class="comment-time">${new Date(c.created_at).toLocaleString()}</div>
        </div>
    `).join('') || '<div style="color:#484f58;font-size:13px">No comments</div>';

    document.getElementById('detailModal').classList.add('open');
}

function closeDetail() { document.getElementById('detailModal').classList.remove('open'); currentKey = null; }

async function transition(key, id) {
    await api(`/issues/${key}/transitions`, { method: 'POST', body: { id } });
    loadBoard();
    openDetail(key);
}

async function deleteIssue(key) {
    if (!confirm(`Delete ${key}?`)) return;
    await api(`/issues/${key}`, { method: 'DELETE' });
    closeDetail();
    loadBoard();
}

async function saveLabels(key, labels) {
    await api(`/issues/${key}`, { method: 'PATCH', body: { labels } });
    loadBoard();
    openDetail(key);
}

async function removeLabel(key, label) {
    const issue = await api(`/issues/${key}`);
    const labels = (issue.labels ? issue.labels.split(',') : []).filter(l => l !== label);
    await saveLabels(key, labels);
}

async function addLabels(key, input) {
    const issue = await api(`/issues/${key}`);
    const existing = issue.labels ? issue.labels.split(',') : [];
    const toAdd = input.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const merged = [...new Set([...existing, ...toAdd])];
    await saveLabels(key, merged);
}

async function addComment() {
    const body = document.getElementById('commentBody').value.trim();
    if (!body || !currentKey) return;
    await api(`/issues/${currentKey}/comments`, { method: 'POST', body: {
        author: document.getElementById('commentAuthor').value.trim(),
        body,
    }});
    document.getElementById('commentBody').value = '';
    openDetail(currentKey);
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeCreate(); closeDetail(); }
});

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'dLabelsEdit' && currentKey) {
        const val = e.target.value.trim();
        if (val) addLabels(currentKey, val);
    }
});

async function loadAgents() {
    const agents = await api('/agents');
    const sel = document.getElementById('cAssignee');
    agents.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; sel.appendChild(o); });
}
loadAgents();
loadBoard();
setInterval(loadBoard, 10000);
</script>
</body>
</html>"""


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("TRACKER_PORT", "8090"))
    uvicorn.run(app, host="0.0.0.0", port=port)
