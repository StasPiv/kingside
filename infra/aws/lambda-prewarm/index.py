"""
ECS Pre-warming Lambda for Kingside tournaments.

Runs every 2 minutes via EventBridge rule.
Checks upcoming tournaments and scales ECS tasks before start.

Formula: desiredTasks = max(currentTasks, ceil(registeredPlayers / 100))
Trigger: 5 minutes before tournament startsAt
"""

import json
import math
import os
import urllib.request
from datetime import datetime, timezone

ECS_CLUSTER = os.environ.get("ECS_CLUSTER", "kingside")
ECS_SERVICE = os.environ.get("ECS_SERVICE", "kingside-api")
API_URL = os.environ.get("API_URL", "https://kingside.site")
PREWARM_MINUTES = int(os.environ.get("PREWARM_MINUTES", "5"))
PLAYERS_PER_TASK = int(os.environ.get("PLAYERS_PER_TASK", "100"))


def get_upcoming_tournaments():
    """Fetch tournaments that are upcoming (not yet started)."""
    url = f"{API_URL}/api/arena"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"Error fetching tournaments: {e}")
        return []

    now = datetime.now(timezone.utc)
    upcoming = []
    for t in data:
        if t.get("status") not in ("upcoming", "active"):
            continue
        starts_at = t.get("startsAt")
        if not starts_at:
            continue
        try:
            start_dt = datetime.fromisoformat(starts_at.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        minutes_until = (start_dt - now).total_seconds() / 60
        entries = t.get("_count", {}).get("entries", 0)
        upcoming.append({
            "id": t["id"],
            "name": t.get("name", ""),
            "startsAt": starts_at,
            "minutesUntil": round(minutes_until, 1),
            "entries": entries,
        })
    return upcoming


def get_current_desired(ecs_client):
    """Get current ECS service desired count."""
    resp = ecs_client.describe_services(
        cluster=ECS_CLUSTER, services=[ECS_SERVICE]
    )
    services = resp.get("services", [])
    if not services:
        return 1
    return services[0].get("desiredCount", 1)


def scale_ecs(ecs_client, desired_count):
    """Update ECS service desired count."""
    ecs_client.update_service(
        cluster=ECS_CLUSTER,
        service=ECS_SERVICE,
        desiredCount=desired_count,
    )
    print(f"Scaled ECS to {desired_count} tasks")


def handler(event, context):
    import boto3

    tournaments = get_upcoming_tournaments()
    if not tournaments:
        print("No upcoming/active tournaments")
        return {"statusCode": 200, "body": "No tournaments to prewarm"}

    ecs = boto3.client("ecs")
    current = get_current_desired(ecs)
    needed = current

    for t in tournaments:
        mins = t["minutesUntil"]
        entries = t["entries"]
        tid = t["id"][:8]

        if mins > PREWARM_MINUTES:
            print(f"Tournament {tid}: starts in {mins}min, too early (>{PREWARM_MINUTES}min)")
            continue

        if mins < -60:
            continue

        tasks_for_tournament = max(1, math.ceil(entries / PLAYERS_PER_TASK))
        print(
            f"Tournament {tid}: {entries} players, starts in {mins}min "
            f"-> needs {tasks_for_tournament} tasks"
        )
        needed = max(needed, tasks_for_tournament)

    if needed > current:
        print(f"Pre-warming: {current} -> {needed} tasks")
        scale_ecs(ecs, needed)
        return {
            "statusCode": 200,
            "body": f"Scaled from {current} to {needed} tasks",
        }

    print(f"No scaling needed (current={current}, needed={needed})")
    return {"statusCode": 200, "body": "No scaling needed"}
