#!/usr/bin/env python3
"""Import all issues from Jira project into Kingside Tracker."""

import base64
import json
import os
import sys
import urllib.request
import urllib.parse

JIRA_BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
JIRA_EMAIL = os.environ.get("JIRA_EMAIL", "")
JIRA_API_TOKEN = os.environ.get("JIRA_API_TOKEN", "")
TRACKER_URL = os.environ.get("TRACKER_URL", "http://localhost:8090")
PROJECT = "KS"


def jira_auth():
    return base64.b64encode(f"{JIRA_EMAIL}:{JIRA_API_TOKEN}".encode()).decode()


def jira_get(path: str) -> dict:
    url = f"{JIRA_BASE_URL}{path}"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Basic {jira_auth()}")
    req.add_header("Accept", "application/json")
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read().decode())


def extract_text(node) -> str:
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return ""
    t = node.get("type", "")
    if t == "text":
        return node.get("text", "")
    if t == "hardBreak":
        return "\n"
    if t == "emoji":
        return node.get("attrs", {}).get("shortName", "")
    if t == "mention":
        return node.get("text", "") or node.get("attrs", {}).get("text", "")
    if t == "inlineCard":
        return node.get("attrs", {}).get("url", "")
    parts = []
    for child in node.get("content", []):
        parts.append(extract_text(child))
    sep = "\n" if t in ("doc", "paragraph", "bulletList", "orderedList",
                         "listItem", "blockquote", "codeBlock", "heading") else ""
    return sep.join(parts)


def map_status(jira_status: str, category: str = "") -> str:
    cat = category.lower()
    if cat == "done":
        return "done"
    if cat == "indeterminate":
        return "in_progress"
    s = jira_status.lower()
    if s in ("done", "closed", "resolved", "готово"):
        return "done"
    if s in ("in progress", "in review", "в работе"):
        return "in_progress"
    return "todo"


def tracker_post(path: str, data: dict) -> dict:
    payload = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{TRACKER_URL}{path}", data=payload,
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req, timeout=10)
    if resp.status == 204:
        return {}
    return json.loads(resp.read().decode())


def tracker_patch(path: str, data: dict) -> dict:
    payload = json.dumps(data).encode()
    req = urllib.request.Request(
        f"{TRACKER_URL}{path}", data=payload,
        headers={"Content-Type": "application/json"},
        method="PATCH",
    )
    resp = urllib.request.urlopen(req, timeout=10)
    return json.loads(resp.read().decode())


def fetch_all_issues() -> list[dict]:
    issues = []
    jql = urllib.parse.quote(f"project = {PROJECT} ORDER BY key ASC")
    token = None
    while True:
        url = f"/rest/api/3/search/jql?jql={jql}&maxResults=100&fields=summary,description,status,labels,comment,created"
        if token:
            url += f"&nextPageToken={urllib.parse.quote(token)}"
        data = jira_get(url)
        for item in data.get("issues", []):
            issues.append(item)
        if data.get("isLast", True):
            break
        token = data.get("nextPageToken")
        if not token:
            break
        print(f"  fetched {len(issues)} so far...")
    return issues


def main():
    if not JIRA_BASE_URL or not JIRA_EMAIL or not JIRA_API_TOKEN:
        print("Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN env vars")
        sys.exit(1)

    print(f"Fetching issues from {JIRA_BASE_URL} project {PROJECT}...")
    issues = fetch_all_issues()
    print(f"Found {len(issues)} issues")

    imported = 0
    skipped = 0

    for item in issues:
        jira_key = item["key"]
        fields = item.get("fields", {})
        summary = fields.get("summary", "")
        description = fields.get("description", "")
        if isinstance(description, dict):
            description = extract_text(description)
        status_obj = fields.get("status", {})
        status = map_status(
            status_obj.get("name", "To Do"),
            status_obj.get("statusCategory", {}).get("key", ""),
        )
        labels = fields.get("labels", [])
        assignee = labels[0] if labels else ""

        # Create issue in tracker
        try:
            created = tracker_post("/api/issues?validate=false", {
                "key": jira_key,
                "summary": summary,
                "description": description or "",
                "assignee": assignee,
            })
            new_key = created.get("key", "?")

            # Set status if not todo
            if status != "todo":
                tid = {"in_progress": 21, "done": 41}.get(status)
                if tid:
                    tracker_post(f"/api/issues/{new_key}/transitions", {"id": tid})

            # Import comments
            comments = fields.get("comment", {}).get("comments", [])
            for c in comments:
                jira_author = c.get("author", {}).get("displayName", "")
                body = c.get("body", "")
                if isinstance(body, dict):
                    body = extract_text(body)
                if not body:
                    continue
                # Parse agent prefix: "BACKEND: ..." -> author=backend
                author = jira_author
                for agent in ("COORDINATOR", "BACKEND", "FRONTEND", "LAYOUT", "QA", "DEVOPS", "ARCHITECT"):
                    if body.startswith(f"{agent}:"):
                        author = agent.lower()
                        body = body[len(agent) + 1:].lstrip()
                        break
                tracker_post(f"/api/issues/{new_key}/comments", {
                    "author": author,
                    "body": body,
                })

            print(f"  {jira_key} -> {new_key} [{status}] {summary[:60]}  ({len(comments)} comments)")
            imported += 1

        except Exception as e:
            print(f"  {jira_key} FAILED: {e}")
            skipped += 1

    print(f"\nDone: {imported} imported, {skipped} failed")


if __name__ == "__main__":
    main()
