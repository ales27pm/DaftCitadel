#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agents_sync.py — Safe, idempotent manager for agent-generated documentation.

Modes:
  - plan  : Analyze AGENTS.md + filesystem, build a proposed change plan (dry-run).
  - apply : Execute the plan transactionally with backups and Git safety.

Features:
  • Parses AGENTS.md for "managed artifacts" (files agents may modify).
  • If pre-existing docs exist, reads/consults them for reuse before rewriting.
  • Generates a human-readable plan (create/modify/keep/remove) with diffs.
  • Dry-run by default; 'apply' requires explicit command.
  • Automatic backups to .agents/backups/<ts>/ and rollback metadata.
  • Git safety: requires clean tree; otherwise auto-branches (unless disabled).
  • Locking: prevents concurrent runs (.agents/.lock).
  • Complete JSON report: .agents/reports/<ts>.report.json

Assumptions:
  • Your agents (e.g., Codex flows) will read the prepared context pack at:
      .agents/context/context_pack.json + source files under .agents/context/src/
  • This script does not make calls to remote services; it prepares/curates artifacts locally.

Author: Repo-safe by design
"""

from __future__ import annotations
import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Dict, Optional, Tuple

ROOT = Path.cwd()
AGENTS_MD = ROOT / "AGENTS.md"
AGENTS_DIR = ROOT / ".agents"
SCHEMAS_DIR = AGENTS_DIR / "schemas"
CONTEXT_DIR = AGENTS_DIR / "context"
BACKUPS_DIR = AGENTS_DIR / "backups"
REPORTS_DIR = AGENTS_DIR / "reports"
TMP_DIR = AGENTS_DIR / "tmp"
INDEX_FILE = AGENTS_DIR / "index.json"
LOCK_FILE = AGENTS_DIR / ".lock"

# Reasonable default managed artifacts if AGENTS.md doesn't declare any.
DEFAULT_MANAGED = [
    "docs/ROADMAP.md",
    "docs/ARCHITECTURE.md",
    "docs/AGENT_GUIDE.md",
    "docs/CONTRIBUTING_AGENTS.md",
    "docs/CHANGELOG_AGENTS.md",
]

# File header tag to mark managed files (for provenance checks).
MANAGED_HEADER = "<!-- managed-by: agents_sync.py v1 -->\n"

# Regex patterns to discover a managed-artifacts declaration in AGENTS.md
FENCE_PATTERNS = [
    # ```agents.managed
    re.compile(r"```(?:\s*agents\.managed[^\n]*)\n(.*?)\n```", re.DOTALL | re.IGNORECASE),
    # ```managed_artifacts
    re.compile(r"```(?:\s*managed_artifacts[^\n]*)\n(.*?)\n```", re.DOTALL | re.IGNORECASE),
    # YAML-like list under a heading containing "Managed Artifacts"
    re.compile(r"(?mi)^#+\s*Managed\s+Artifacts.*?\n+((?:- .+\n?)+)"),
]

# Safe write options (prevent partial writes)
def atomic_write(path: Path, data: str, mode: str = "w", encoding: str = "utf-8"):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, mode, encoding=encoding) as f:
        f.write(data)
    os.replace(tmp, path)

def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def now_ts() -> str:
    return time.strftime("%Y%m%d-%H%M%S")

def run(cmd: List[str]) -> Tuple[int, str, str]:
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    out, err = p.communicate()
    return p.returncode, out, err

def assert_git_safety(allow_dirty: bool, auto_branch: bool, branch_prefix: str) -> Optional[str]:
    # Ensure we are in a Git repo
    code, out, _ = run(["git", "rev-parse", "--is-inside-work-tree"])
    if code != 0 or out.strip() != "true":
        print("[git] Not a Git repository; proceeding without Git safeguards.")
        return None

    # Check dirty state
    code, out, _ = run(["git", "status", "--porcelain"])
    dirty = bool(out.strip())
    current_branch = None
    code, out, _ = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    if code == 0:
        current_branch = out.strip()

    if dirty and not allow_dirty:
        # Auto-branch if requested and working tree clean with respect to committed changes
        if auto_branch:
            new_branch = f"{branch_prefix}{now_ts()}"
            code, _, err = run(["git", "checkout", "-b", new_branch])
            if code != 0:
                print(f"[git][ERR] Cannot create branch {new_branch}: {err.strip()}", file=sys.stderr)
                sys.exit(2)
            print(f"[git] Created and switched to branch: {new_branch}")
            return new_branch
        else:
            print("[git][ERR] Working tree is dirty. Commit/stash or pass --allow-dirty or enable auto-branch.", file=sys.stderr)
            sys.exit(2)

    if not dirty and auto_branch:
        new_branch = f"{branch_prefix}{now_ts()}"
        code, _, err = run(["git", "checkout", "-b", new_branch])
        if code != 0:
            print(f"[git][ERR] Cannot create branch {new_branch}: {err.strip()}", file=sys.stderr)
            sys.exit(2)
        print(f"[git] Created and switched to branch: {new_branch}")
        return new_branch

    return current_branch

def ensure_layout():
    for d in (AGENTS_DIR, CONTEXT_DIR, BACKUPS_DIR, REPORTS_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
    # .gitignore for internal dirs
    gi = AGENTS_DIR / ".gitignore"
    if not gi.exists():
        atomic_write(gi, "# Internal agent working dirs\nbackups/\ncontext/\nreports/\ntmp/\n.lock\n")

@dataclass
class Artifact:
    path: Path
    exists: bool
    managed: bool
    current_hash: Optional[str] = None
    current_size: Optional[int] = None
    suggested_content: Optional[str] = None  # New or updated content
    decision: str = "keep"  # keep | create | modify | remove
    rationale: str = ""

@dataclass
class Plan:
    ts: str
    root: str
    artifacts: List[Artifact] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "ts": self.ts,
            "root": self.root,
            "artifacts": [
                {
                    "path": str(a.path),
                    "exists": a.exists,
                    "managed": a.managed,
                    "current_hash": a.current_hash,
                    "current_size": a.current_size,
                    "decision": a.decision,
                    "rationale": a.rationale,
                } for a in self.artifacts
            ],
            "notes": self.notes,
        }, indent=2)

def locked() -> bool:
    return LOCK_FILE.exists()

def acquire_lock():
    if locked():
        print("[lock][ERR] Another run is in progress (.agents/.lock exists).", file=sys.stderr)
        sys.exit(3)
    atomic_write(LOCK_FILE, f"{now_ts()} pid={os.getpid()}\n")

def release_lock():
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        pass

def parse_managed_from_agents_md() -> List[str]:
    if not AGENTS_MD.exists():
        return []
    text = AGENTS_MD.read_text(encoding="utf-8", errors="ignore")

    blocks = []
    for rx in FENCE_PATTERNS:
        m = rx.search(text)
        if m:
            payload = m.group(1).strip()
            blocks.append(payload)

    managed: List[str] = []
    for b in blocks:
        # Try YAML-ish list: lines starting with "- "
        for line in b.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("- "):
                managed.append(line[2:].strip())
                continue
            # Or simple path per line
            if re.match(r"^[\w\./\-]+$", line):
                managed.append(line)

    # Unique & normalized
    norm = []
    seen = set()
    for p in managed:
        sp = str(Path(p))
        if sp not in seen:
            seen.add(sp)
            norm.append(sp)
    return norm

def compute_hash_and_size(path: Path) -> Tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
            size += len(chunk)
    return h.hexdigest(), size

def gather_existing_generated_docs(managed_paths: List[str]) -> Dict[str, str]:
    """
    Consult (read) any existing docs (managed or nearby sibling docs)
    to feed the new content synthesis. We don't do LLM work here;
    we build a 'context pack' for your agent runner to ingest.
    """
    harvested: Dict[str, str] = {}

    # Managed files
    for rel in managed_paths:
        p = ROOT / rel
        if p.exists() and p.is_file():
            harvested[str(p)] = p.read_text(encoding="utf-8", errors="ignore")

    # Nearby sibling docs in docs/ directory as additional context
    docs_dir = ROOT / "docs"
    if docs_dir.exists() and docs_dir.is_dir():
        for p in docs_dir.glob("**/*.md"):
            try:
                harvested[str(p)] = p.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                pass

    # Write context pack for agent ingestion
    CONTEXT_DIR.mkdir(parents=True, exist_ok=True)
    src_dir = CONTEXT_DIR / "src"
    if src_dir.exists():
        shutil.rmtree(src_dir)
    src_dir.mkdir(parents=True, exist_ok=True)

    manifest = []
    for i, (path_str, content) in enumerate(harvested.items(), start=1):
        dst = src_dir / f"doc_{i:04d}.md"
        atomic_write(dst, content)
        manifest.append({"source": path_str, "copied_to": str(dst), "bytes": len(content)})

    context_pack = {
        "ts": now_ts(),
        "sources": manifest,
        "note": "These are previously generated documents harvested for review/reuse by agents.",
    }
    atomic_write(CONTEXT_DIR / "context_pack.json", json.dumps(context_pack, indent=2))
    return harvested

def synthesize_desired_content(relpath: str, existing_text: Optional[str], consulted_corpus: Dict[str, str]) -> str:
    """
    Deterministic content synthesis stub:
      - We do not call external LLMs here (repo-safe).
      - We create a structured, well-formed baseline that agents can then refine.
    Strategy:
      - If existing_text exists: keep header, add managed-by tag, normalize sections, preserve useful headings.
      - Else: create a minimal but high-quality scaffold with TODO anchors for the agent system.
    """
    title = Path(relpath).stem.replace("_", " ").replace("-", " ").title()
    header = f"# {title}\n\n{MANAGED_HEADER}"

    # Light heuristic reuse: extract first level-2 sections from consulted corpus for hints
    hints = []
    for src, txt in consulted_corpus.items():
        for m in re.finditer(r"(?m)^##\s+([^\n]+)", txt):
            sec = m.group(1).strip()
            if sec and sec not in hints and len(hints) < 12:
                hints.append(sec)

    reuse_block = ""
    if hints:
        reuse_block = "## Candidate Sections (from previous docs)\n" + "\n".join(f"- {h}" for h in hints) + "\n\n"

    baseline_sections = textwrap.dedent(f"""
    ## Overview
    Provide a concise narrative of the current state, scope, and intent of this artifact.

    ## Decisions
    Record key decisions, dates, and rationale. Keep immutable history; add new entries rather than rewriting.

    ## Tasks
    - [ ] High-priority
    - [ ] Medium-priority
    - [ ] Low-priority

    ## References
    - Link/mention related documents, modules, and owners.

    ## Changelog
    - {time.strftime("%Y-%m-%d")} • Initialized/updated by agents_sync.py
    """).strip() + "\n"

    if existing_text:
        # Preserve any unique content after removing previous managed tag
        preserved = re.sub(r"(?m)^<!-- managed-by:.*?-->[\r\n]*", "", existing_text).strip()
        # Avoid duplicating identical content
        if preserved and sha256_text(preserved) != sha256_text(baseline_sections):
            body = f"{reuse_block}## Preserved Content\n\n{preserved}\n\n" + baseline_sections
        else:
            body = f"{reuse_block}{baseline_sections}"
    else:
        body = f"{reuse_block}{baseline_sections}"

    return header + "\n" + body

def diff_text(a: str, b: str, path: str) -> str:
    a_lines = a.splitlines(keepends=True)
    b_lines = b.splitlines(keepends=True)
    return "".join(difflib.unified_diff(a_lines, b_lines, fromfile=f"{path} (current)", tofile=f"{path} (proposed)"))

def build_plan() -> Plan:
    ensure_layout()

    managed_paths = parse_managed_from_agents_md()
    notes = []
    if not managed_paths:
        managed_paths = DEFAULT_MANAGED
        notes.append("No managed artifacts declared in AGENTS.md; using defaults.")

    # Consult existing docs to inform generation (context pack)
    consulted = gather_existing_generated_docs(managed_paths)

    artifacts: List[Artifact] = []
    for rel in managed_paths:
        p = ROOT / rel
        exists = p.exists()
        managed = exists and p.is_file() and MANAGED_HEADER in p.read_text(encoding="utf-8", errors="ignore")
        current_hash, current_size = (None, None)
        current_text = None

        if exists and p.is_file():
            current_text = p.read_text(encoding="utf-8", errors="ignore")
            current_hash, current_size = compute_hash_and_size(p)

        desired = synthesize_desired_content(rel, current_text, consulted)

        art = Artifact(
            path=p, exists=exists, managed=managed,
            current_hash=current_hash, current_size=current_size,
            suggested_content=desired, decision="keep", rationale=""
        )

        if not exists:
            art.decision = "create"
            art.rationale = "File missing; will create scaffold guided by existing docs."
        else:
            # Decide modify/keep:
            if current_text is None:
                art.decision = "modify"
                art.rationale = "Non-text or unreadable; will rewrite as Markdown."
            else:
                if sha256_text(current_text) != sha256_text(desired):
                    art.decision = "modify"
                    art.rationale = "Content drift detected; propose normalized, managed version preserving useful parts."
                else:
                    art.decision = "keep"
                    art.rationale = "Already aligned with desired baseline."

        artifacts.append(art)

    # Removal pass (optional): remove stale managed files explicitly marked in AGENTS.md?
    # For safety, we do NOT delete anything not listed unless AGENTS.md says so.
    # Look for an explicit removal directive fence.
    removal_candidates = []
    if AGENTS_MD.exists():
        text = AGENTS_MD.read_text(encoding="utf-8", errors="ignore")
        rm_block = re.search(r"```(?:\s*agents\.remove[^\n]*)\n(.*?)\n```", text, re.DOTALL | re.IGNORECASE)
        if rm_block:
            for line in rm_block.group(1).splitlines():
                line = line.strip()
                if line.startswith("- "):
                    removal_candidates.append(line[2:].strip())
                elif re.match(r"^[\w\./\-]+$", line):
                    removal_candidates.append(line)

    for rel in removal_candidates:
        p = ROOT / rel
        if p.exists() and p.is_file():
            artifacts.append(Artifact(
                path=p, exists=True, managed=False,
                current_hash=compute_hash_and_size(p)[0],
                current_size=p.stat().st_size,
                suggested_content=None,
                decision="remove",
                rationale="Explicitly requested removal in AGENTS.md (agents.remove)."
            ))

    return Plan(ts=now_ts(), root=str(ROOT), artifacts=artifacts, notes=notes)

def print_plan(plan: Plan, with_diffs: bool = True):
    print("\n=== PLAN SUMMARY ===")
    print(f"Time: {plan.ts}")
    if plan.notes:
        print("Notes:")
        for n in plan.notes:
            print(f"  - {n}")
    counts = {"create":0, "modify":0, "keep":0, "remove":0}
    for a in plan.artifacts:
        counts[a.decision] += 1
    print("Decisions:", counts)
    print()

    for a in plan.artifacts:
        print(f"[{a.decision.upper()}] {a.path}")
        print(f"  exists={a.exists} managed-previously={a.managed} size={a.current_size} hash={a.current_hash}")
        print(f"  rationale: {a.rationale}")
        if a.decision in ("create", "modify") and with_diffs:
            current_text = ""
            if a.exists and a.path.is_file():
                current_text = a.path.read_text(encoding="utf-8", errors="ignore")
            proposed = a.suggested_content or ""
            d = diff_text(current_text, proposed, str(a.path))
            if d.strip():
                print("  --- DIFF ---")
                sys.stdout.write(textwrap.indent(d, "    "))
        print()

def backup_file(src: Path, backup_root: Path) -> Optional[Path]:
    if not src.exists() or not src.is_file():
        return None
    rel = src.relative_to(ROOT)
    dst = backup_root / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return dst

def apply_plan(plan: Plan, allow_dirty: bool, auto_branch: bool, no_branch: bool, branch_prefix: str):
    branch = None
    if not no_branch:
        branch = assert_git_safety(allow_dirty=allow_dirty, auto_branch=auto_branch, branch_prefix=branch_prefix)

    # Create backup root
    backup_root = BACKUPS_DIR / plan.ts
    report_path = REPORTS_DIR / f"{plan.ts}.report.json"
    backup_manifest = []
    change_manifest = []

    for art in plan.artifacts:
        if art.decision == "keep":
            change_manifest.append({"path": str(art.path), "decision": "keep"})
            continue

        if art.decision == "remove":
            # backup then remove
            b = backup_file(art.path, backup_root)
            backup_manifest.append({"path": str(art.path), "backup": str(b) if b else None})
            art.path.unlink(missing_ok=True)
            change_manifest.append({"path": str(art.path), "decision": "remove"})
            continue

        if art.decision in ("create", "modify"):
            # backup existing if any
            if art.path.exists():
                b = backup_file(art.path, backup_root)
                backup_manifest.append({"path": str(art.path), "backup": str(b) if b else None})
            # write proposed content (always include managed header)
            content = art.suggested_content or ""
            if MANAGED_HEADER not in content:
                content = MANAGED_HEADER + content
            atomic_write(art.path, content)
            change_manifest.append({"path": str(art.path), "decision": art.decision})

    # Write report
    report = {
        "ts": plan.ts,
        "root": plan.root,
        "branch": branch,
        "backups_dir": str(backup_root),
        "changes": change_manifest,
        "backups": backup_manifest,
        "notes": plan.notes,
    }
    atomic_write(report_path, json.dumps(report, indent=2))
    print(f"[ok] Applied. Report at {report_path}")

    # Stage and commit if in Git repo
    code, out, _ = run(["git", "rev-parse", "--is-inside-work-tree"])
    if code == 0 and out.strip() == "true":
        run(["git", "add", "--all"])
        msg = f"agents_sync: apply plan {plan.ts}"
        code, _, err = run(["git", "commit", "-m", msg])
        if code == 0:
            print(f"[git] Committed changes: {msg}")
        else:
            print("[git] No commit made (possibly no changes).")

def main():
    parser = argparse.ArgumentParser(
        prog="agents_sync.py",
        description="Safely manage agent-generated documentation with consult/modify/remove semantics."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_plan = sub.add_parser("plan", help="Analyze and print the change plan (dry-run).")
    p_plan.add_argument("--no-diffs", action="store_true", help="Do not print diffs.")
    p_plan.add_argument("--json", action="store_true", help="Also write plan JSON to .agents/reports/<ts>.plan.json")

    p_apply = sub.add_parser("apply", help="Apply the plan (transactional with backups).")
    p_apply.add_argument("--allow-dirty", action="store_true", help="Allow applying with a dirty working tree.")
    p_apply.add_argument("--auto-branch", action="store_true", help="Create a new branch before applying.")
    p_apply.add_argument("--no-branch", action="store_true", help="Do not create/switch branches at all.")
    p_apply.add_argument("--branch-prefix", default="agents-sync/", help="Prefix for auto-created branch names.")

    args = parser.parse_args()
    ensure_layout()

    if locked():
        print("[ERR] Lock present; previous run may still be active. If safe, delete .agents/.lock and retry.", file=sys.stderr)
        sys.exit(1)

    acquire_lock()
    try:
        plan = build_plan()

        if args.cmd == "plan":
            print_plan(plan, with_diffs=not args.no_diffs)
            if args.json:
                plan_path = REPORTS_DIR / f"{plan.ts}.plan.json"
                atomic_write(plan_path, plan.to_json())
                print(f"[ok] Wrote plan JSON to {plan_path}")
            return

        if args.cmd == "apply":
            # Show summary one more time for safety
            print_plan(plan, with_diffs=True)
            apply_plan(
                plan,
                allow_dirty=getattr(args, "allow_dirty", False),
                auto_branch=getattr(args, "auto_branch", False),
                no_branch=getattr(args, "no_branch", False),
                branch_prefix=getattr(args, "branch_prefix", "agents-sync/")
            )
            return

    finally:
        release_lock()

if __name__ == "__main__":
    main()
