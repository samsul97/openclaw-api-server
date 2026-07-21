#!/usr/bin/env python3
"""Read and sync OpenClaw auth profiles without exposing credential values."""

import argparse
import json
import os
import sqlite3
import sys
import time


def load_store(db_path):
    if not os.path.isfile(db_path):
        return {"version": 1, "profiles": {}}, False
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT store_json FROM auth_profile_store WHERE store_key='primary'"
        ).fetchone()
        return (json.loads(row[0]) if row else {"version": 1, "profiles": {}}), bool(row)
    finally:
        conn.close()


def public_profile(profile_id, profile):
    expires = profile.get("expires")
    now_ms = int(time.time() * 1000)
    access_expired = bool(expires and int(expires) <= now_ms)
    refresh_available = bool(profile.get("refresh"))
    return {
        "profile_id": profile_id,
        "email": profile.get("email") or profile_id.removeprefix("openai:"),
        "type": profile.get("type"),
        "provider": profile.get("provider", "openai"),
        "plan": profile.get("chatgptPlanType"),
        "account_id": profile.get("accountId"),
        "expires_at": expires,
        "access_expired": access_expired,
        "refresh_available": refresh_available,
        "expired": access_expired and not refresh_available,
    }


def list_profiles(args):
    store, _ = load_store(args.db)
    profiles = [
        public_profile(pid, value)
        for pid, value in store.get("profiles", {}).items()
        if pid.startswith("openai:")
    ]
    print(json.dumps({"ok": True, "profiles": profiles}))


def sync_profile(args):
    source, _ = load_store(args.source)
    profile = source.get("profiles", {}).get(args.profile_id)
    if not profile or not args.profile_id.startswith("openai:"):
        raise RuntimeError("Selected OpenAI profile was not found in pool")

    backup = None
    if os.path.isfile(args.target):
        backup_dir = os.path.join(os.path.dirname(args.target), "auth-backups")
        os.makedirs(backup_dir, exist_ok=True)
        backup = os.path.join(backup_dir, f"openclaw-agent-{time.time_ns()}.sqlite")
        source_conn = sqlite3.connect(args.target)
        backup_conn = sqlite3.connect(backup)
        try:
            source_conn.backup(backup_conn)
        finally:
            backup_conn.close()
            source_conn.close()

    os.makedirs(os.path.dirname(args.target), exist_ok=True)
    if not os.path.isfile(args.target):
        conn = sqlite3.connect(args.target)
        try:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS auth_profile_store (
                    store_key TEXT NOT NULL PRIMARY KEY,
                    store_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                )"""
            )
            conn.commit()
        finally:
            conn.close()

    target, row_exists = load_store(args.target)
    profiles = target.setdefault("profiles", {})
    removed = []
    if args.replace:
        removed = [pid for pid in profiles if pid.startswith("openai:") and pid != args.profile_id]
        for pid in removed:
            del profiles[pid]
    profiles[args.profile_id] = profile

    conn = sqlite3.connect(args.target)
    try:
        now_ms = int(time.time() * 1000)
        payload = json.dumps(target, separators=(",", ":"))
        if row_exists:
            conn.execute(
                "UPDATE auth_profile_store SET store_json=?, updated_at=? WHERE store_key='primary'",
                (payload, now_ms),
            )
        else:
            conn.execute(
                "INSERT OR REPLACE INTO auth_profile_store (store_key, store_json, updated_at) VALUES ('primary', ?, ?)",
                (payload, now_ms),
            )
        conn.commit()
    finally:
        conn.close()

    print(json.dumps({
        "ok": True,
        "profile": public_profile(args.profile_id, profile),
        "backup_path": backup,
        "removed_profiles": removed,
    }))


def backup_store(args):
    if not os.path.isfile(args.db):
        raise RuntimeError("Auth SQLite does not exist")
    os.makedirs(args.backup_dir, exist_ok=True)
    backup = os.path.join(args.backup_dir, f"pool-auth-{time.time_ns()}.sqlite")
    source_conn = sqlite3.connect(args.db)
    backup_conn = sqlite3.connect(backup)
    try:
        source_conn.backup(backup_conn)
    finally:
        backup_conn.close()
        source_conn.close()
    print(json.dumps({"ok": True, "backup_path": backup, "backup_name": os.path.basename(backup)}))


def restore_store(args):
    if not os.path.isfile(args.backup):
        raise RuntimeError("Backup SQLite does not exist")
    os.makedirs(os.path.dirname(args.target), exist_ok=True)
    source_conn = sqlite3.connect(args.backup)
    target_conn = sqlite3.connect(args.target)
    try:
        source_conn.backup(target_conn)
    finally:
        target_conn.close()
        source_conn.close()
    print(json.dumps({"ok": True, "restored": os.path.basename(args.backup)}))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("list")
    listing.add_argument("--db", required=True)
    syncing = sub.add_parser("sync")
    syncing.add_argument("--source", required=True)
    syncing.add_argument("--target", required=True)
    syncing.add_argument("--profile-id", required=True)
    syncing.add_argument("--replace", action="store_true")
    backup = sub.add_parser("backup")
    backup.add_argument("--db", required=True)
    backup.add_argument("--backup-dir", required=True)
    restore = sub.add_parser("restore")
    restore.add_argument("--backup", required=True)
    restore.add_argument("--target", required=True)
    args = parser.parse_args()
    try:
        if args.command == "list":
            list_profiles(args)
        elif args.command == "sync":
            sync_profile(args)
        elif args.command == "backup":
            backup_store(args)
        else:
            restore_store(args)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
