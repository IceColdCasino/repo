#!/usr/bin/env python3
"""Skip a game's proof tests when they already passed and the macOS library is stored.

The library artifact is uploaded before the proofs, so an artifact by itself is
not enough. The game job on this runner and the macOS job for the same game
must both have succeeded, and the proof inputs must be unchanged since that
commit. macOS then downloads the library and uploads it again so later jobs in
this run can still find libzkcasino-macos-<game>.
"""

import json
import os
import re
import subprocess
import sys
from urllib.parse import quote

TOOLCHAIN = (
    re.compile(r"version:\s*0\.\d+\.\d+"),
    re.compile(r"ver=v\d+\.\d+\.\d+"),
    re.compile(r"brew install icecoldcasino/groth16/zkey"),
    re.compile(r"zig build -Doptimize=\S+"),
)


def api(path):
    result = subprocess.run(
        ["gh", "api", path],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(detail or f"gh api {path} failed")
    return json.loads(result.stdout)


def write_output(reuse, run_id):
    print(f"reuse={'true' if reuse else 'false'}")
    if run_id:
        print(f"run_id={run_id}")
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"reuse={'true' if reuse else 'false'}\n")
        if run_id:
            handle.write(f"run_id={run_id}\n")


def proof_paths(test_file, lfs):
    paths = [
        "libzkcasino",
        "circuits",
        "src",
        "test/helpers",
        f"test/{test_file}",
        "package.json",
        "bun.lock",
        "bun.lockb",
        "bunfig.toml",
        "tsconfig.json",
        ":(glob)tsconfig*.json",
        ".github/run-proof-tests.sh",
    ]
    for pattern in lfs.split(","):
        pattern = pattern.strip()
        if pattern:
            paths.append(f":(glob){pattern}")
    return paths


def toolchain_fingerprint(sha):
    show = subprocess.run(
        ["git", "show", f"{sha}:.github/workflows/tests.yml"],
        check=False,
        capture_output=True,
        text=True,
    )
    if show.returncode != 0:
        return None
    hits = []
    for line in show.stdout.splitlines():
        if any(pattern.search(line) for pattern in TOOLCHAIN):
            hits.append(line.strip())
    return "\n".join(hits)


def proof_inputs_match(old_sha, head_sha, paths):
    fetch = subprocess.run(
        ["git", "fetch", "--no-tags", "--depth", "1", "origin", old_sha],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if fetch.returncode != 0:
        print(f"could not fetch {old_sha}: {(fetch.stderr or '').strip()}")
        return False
    if toolchain_fingerprint(old_sha) != toolchain_fingerprint(head_sha):
        print(f"prover or Zig version differs since {old_sha[:12]}")
        return False
    diff = subprocess.run(
        ["git", "diff", "--quiet", old_sha, head_sha, "--", *paths],
        check=False,
        capture_output=True,
        text=True,
    )
    if diff.returncode == 0:
        return True
    if diff.returncode == 1:
        print(f"proof inputs differ since {old_sha[:12]}")
        return False
    print(f"git diff failed for {old_sha}: {(diff.stderr or '').strip()}")
    return False


def job_conclusions(repo, run_id):
    conclusions = {}
    for page in range(1, 11):
        data = api(f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100&page={page}")
        jobs = data.get("jobs") or []
        for job in jobs:
            conclusions[job.get("name")] = job.get("conclusion")
        if len(jobs) < 100:
            break
    return conclusions


def find_reuse(game, runner, test_file, lfs, circuit_set):
    repo = os.environ["GITHUB_REPOSITORY"]
    head_sha = os.environ["GITHUB_SHA"]
    branch = os.environ.get("GITHUB_REF_NAME") or ""
    current_run = os.environ.get("GITHUB_RUN_ID") or ""
    artifact_name = f"libzkcasino-macos-{circuit_set}"
    job_name = f"{game} ({runner})"
    mac_job = f"{game} (macos-latest)"
    paths = proof_paths(test_file, lfs)
    artifacts = []
    quoted = quote(artifact_name, safe="")
    for page in range(1, 4):
        data = api(f"repos/{repo}/actions/artifacts?name={quoted}&per_page=20&page={page}")
        batch = data.get("artifacts") or []
        artifacts.extend(batch)
        if len(batch) < 20:
            break
    artifacts.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    conclusions_by_run = {}
    for artifact in artifacts:
        if artifact.get("name") != artifact_name or artifact.get("expired"):
            continue
        workflow_run = artifact.get("workflow_run") or {}
        run_id = str(workflow_run.get("id") or "")
        old_sha = workflow_run.get("head_sha") or ""
        if not run_id or not old_sha or run_id == current_run:
            continue
        if branch and workflow_run.get("head_branch") not in (None, branch):
            continue
        if run_id not in conclusions_by_run:
            conclusions_by_run[run_id] = job_conclusions(repo, run_id)
        conclusions = conclusions_by_run[run_id]
        mac_conclusion = conclusions.get(mac_job)
        job_conclusion = conclusions.get(job_name)
        if mac_conclusion != "success" or job_conclusion != "success":
            if job_name == mac_job:
                print(f"skip run {run_id}: {job_name}={job_conclusion}")
            else:
                print(
                    f"skip run {run_id}: {job_name}={job_conclusion} {mac_job}={mac_conclusion}"
                )
            continue
        if not proof_inputs_match(old_sha, head_sha, paths):
            continue
        print(
            f"reusing {artifact_name} from run {run_id} ({old_sha[:12]}); {job_name} already passed"
        )
        return True, run_id
    print(f"no stored {artifact_name} from a passed run with the same proof inputs")
    return False, ""


def main():
    if len(sys.argv) != 6:
        print(
            "usage: reuse-proof-artifact.py <game> <runner> <test> <lfs> <circuit-set>",
            file=sys.stderr,
        )
        return 2
    try:
        reuse, run_id = find_reuse(*sys.argv[1:6])
    except Exception as exc:
        print(f"proof reuse check failed, running tests: {exc}", file=sys.stderr)
        reuse, run_id = False, ""
    write_output(reuse, run_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
