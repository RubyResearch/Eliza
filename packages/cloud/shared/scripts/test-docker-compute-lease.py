"""Exercise the paid-runtime guard against real, isolated Linux Docker containers.

Run as root with a generated guard program path and an existing local image id.
No images are pulled, no agent credentials are supplied, and only containers
created by this invocation are stopped or removed. The test never installs a
system service or changes the host clock.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


def run(*args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=20, **kwargs)


def checked(*args, **kwargs):
    result = run(*args, **kwargs)
    if result.returncode:
        raise RuntimeError("Test command failed: " + args[0] + ": " + result.stderr)
    return result.stdout.strip()


def main():
    assert os.geteuid() == 0, "Linux root is required for the real host guard test"
    program = Path(sys.argv[1]).resolve()
    image = checked("docker", "image", "inspect", "--format", "{{.Id}}", sys.argv[2])
    root = Path(tempfile.mkdtemp(prefix="eliza-compute-lease-test-"))
    (root / "grants").mkdir(mode=0o700)
    (root / "receipts").mkdir(mode=0o700)
    (root / "revocations").mkdir(mode=0o700)
    log = (root / "daemon.log").open("w")
    daemon = subprocess.Popen([sys.executable, str(program), str(root), "daemon"], stdout=log, stderr=log)
    names = []
    assertions = []
    started_at = time.time()

    def cli(operation, payload):
        return run(sys.executable, str(program), str(root), operation, input=json.dumps(payload))

    def accepted(operation, payload):
        result = cli(operation, payload)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    def rejected(operation, payload, code):
        result = cli(operation, payload)
        assert result.returncode != 0 and code in result.stderr, (code, result.stdout, result.stderr)
        assertions.append(code)

    def running(container_id):
        return checked("docker", "inspect", "--format", "{{.State.Running}}", container_id) == "true"

    def wait_stopped(container_id, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert daemon.poll() is None, "Guard exited unexpectedly"
            if not running(container_id):
                return
            time.sleep(0.2)
        raise AssertionError("Container remained running past the bounded expiry check")

    agent_id, organization_id = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        deadline = time.monotonic() + 5
        while not (root / "heartbeat").exists():
            assert time.monotonic() < deadline and daemon.poll() is None
            time.sleep(0.05)
        for _ in range(2):
            name = "eliza-compute-lease-test-" + str(uuid.uuid4())
            names.append(name)
            checked("docker", "create", "--name", name, "--network", "none", "--memory", "64m",
                "--cpus", "0.2", "--pids-limit", "32", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--user", "65534:65534",
                "--restart", "unless-stopped", "--label", "ai.elizaos.managed-by=eliza-cloud",
                "--label", "ai.elizaos.container-class=test", "--label", "ai.elizaos.agent-id=" + agent_id,
                "--label", "ai.elizaos.org-id=" + organization_id, "--entrypoint", "/bin/sh", image,
                "-c", "exec sleep 600")
        container_id, other_id = [checked("docker", "inspect", "--format", "{{.Id}}", name) for name in names]
        now = time.time_ns() // 1000000
        auth = dict(agentId=agent_id, organizationId=organization_id, containerId=container_id,
            fundingId=str(uuid.uuid4()), previousFundingId=None, issuedAtMs=now,
            paidFromMs=now - 1000, paidUntilMs=now + 130000)
        start = dict(containerId=container_id, fundingId=auth["fundingId"])
        rejected("start", start, "funding_mismatch")
        rejected("grant", {**auth, "organizationId": str(uuid.uuid4())}, "organization_identity_mismatch")
        rejected("grant", {**auth, "issuedAtMs": now - 60000}, "stale_authorization_or_clock_skew")
        first = accepted("grant", auth)
        replay = accepted("grant", auth)
        assert replay == first, "A retry extended or rewrote the original paid interval"
        refreshed = accepted("grant", {**auth, "issuedAtMs": time.time_ns() // 1000000})
        assert refreshed == first, "A newly authorized retry extended the paid interval"
        rejected("grant", {**auth, "paidUntilMs": auth["paidUntilMs"] + 1}, "funding_replay_conflict")
        rejected("grant", {**auth, "containerId": other_id}, "funding_replay_conflict")
        database_now = time.time_ns() // 1000000 + 5000
        skewed = {**auth, "containerId": other_id, "fundingId": str(uuid.uuid4()),
            "issuedAtMs": database_now, "paidFromMs": database_now,
            "paidUntilMs": database_now + 7200000}
        accepted("grant", skewed)
        assertions.append("two_hour_grant_with_bounded_database_clock_skew")
        accepted("start", start)
        assert running(container_id) and not running(other_id)
        assert checked("docker", "inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", container_id) == "no"
        marker = str(uuid.uuid4())
        checked("docker", "exec", container_id, "/bin/sh", "-c", "printf '%s' '" + marker + "' > /tmp/paid-marker")
        renewed = {**auth, "fundingId": str(uuid.uuid4()), "previousFundingId": auth["fundingId"],
            "issuedAtMs": time.time_ns() // 1000000, "paidFromMs": time.time_ns() // 1000000 - 1000,
            "paidUntilMs": auth["paidUntilMs"] + 10000}
        rejected("grant", {**renewed, "previousFundingId": str(uuid.uuid4())}, "previous_funding_mismatch")
        rejected("grant", {**renewed, "paidFromMs": auth["paidUntilMs"] + 1}, "funding_interval_has_gap")
        second = accepted("grant", renewed)
        assert second["expiresBootNs"] <= first["expiresBootNs"] + 10000000000
        rejected("start", start, "funding_mismatch")
        rejected("grant", auth, "stale_authorization_or_clock_skew" if time.time_ns() // 1000000 - now > 10000 else "previous_funding_mismatch")
        print(json.dumps({"phase": "real_container_running", "checks": assertions}), flush=True)
        # A real monotonic deadline passes: renewal must survive the first window's stop point.
        remaining = (first["expiresBootNs"] - time.clock_gettime_ns(time.CLOCK_BOOTTIME)) / 1e9 + 1
        if remaining > 0:
            time.sleep(remaining)
        assert running(container_id), "The old funding window stopped a renewed container"
        wait_stopped(container_id, 30)
        receipt = root / "receipts" / (renewed["fundingId"] + ".json")
        deadline = time.monotonic() + 3
        while not receipt.exists():
            assert time.monotonic() < deadline, "No provider-stop receipt"
            time.sleep(0.05)
        rejected("start", dict(containerId=container_id, fundingId=renewed["fundingId"]), "funding_expired")
        # Simulate a delayed provider command outside the guarded entrypoint.
        checked("docker", "start", container_id)
        wait_stopped(container_id, 15)
        # A fresh paid grant can recover the stopped container without losing its data.
        now = time.time_ns() // 1000000
        fresh = {**renewed, "fundingId": str(uuid.uuid4()), "previousFundingId": renewed["fundingId"],
            "issuedAtMs": now, "paidFromMs": now, "paidUntilMs": now + 130000}
        accepted("grant", fresh)
        accepted("start", dict(containerId=container_id, fundingId=fresh["fundingId"]))
        assert checked("docker", "exec", container_id, "cat", "/tmp/paid-marker") == marker
        # A prior-boot lease must stop even when its wall-clock paid deadline is still future.
        path = root / (container_id + ".json")
        lease = json.loads(path.read_text())
        lease["bootId"] = str(uuid.uuid4())
        replacement = root / "boot-test.tmp"
        replacement.write_text(json.dumps(lease))
        os.replace(replacement, path)
        wait_stopped(container_id, 15)
        # Stop a valid paid runtime while its committed successor has not yet
        # reached the host. Neither the old grant nor the delayed successor may
        # start it again after the unused reservation is eligible for refund.
        accepted("start", dict(containerId=other_id, fundingId=skewed["fundingId"]))
        checked("docker", "exec", other_id, "/bin/sh", "-c", "printf '%s' '" + marker + "' > /tmp/retained-after-refund")
        now = time.time_ns() // 1000000
        pending = {**skewed, "fundingId": str(uuid.uuid4()), "previousFundingId": skewed["fundingId"],
            "issuedAtMs": now, "paidFromMs": now, "paidUntilMs": now + 7200000}
        rejected("revoke", {**pending, "previousFundingId": str(uuid.uuid4())}, "revocation_funding_superseded")
        stopped = accepted("revoke", pending)
        assert stopped["expired"] and stopped["stoppedAtMs"] is not None and not running(other_id)
        assert accepted("revoke", pending) == stopped
        now = time.time_ns() // 1000000
        never_delivered = {**pending, "fundingId": str(uuid.uuid4()), "previousFundingId": pending["fundingId"],
            "issuedAtMs": now, "paidFromMs": now, "paidUntilMs": now + 7200000}
        no_new_usage = accepted("revoke", never_delivered)
        assert no_new_usage["stoppedAtMs"] == stopped["stoppedAtMs"]
        assert (root / "receipts" / (never_delivered["fundingId"] + ".json")).exists()
        rejected("grant", {**pending, "issuedAtMs": time.time_ns() // 1000000}, "funding_revoked")
        rejected("grant", {**skewed, "issuedAtMs": time.time_ns() // 1000000}, "funding_revoked")
        rejected("grant", never_delivered, "funding_revoked")
        rejected("start", dict(containerId=other_id, fundingId=never_delivered["fundingId"]), "funding_expired")
        checked("docker", "start", other_id)
        assert checked("docker", "exec", other_id, "cat", "/tmp/retained-after-refund") == marker
        wait_stopped(other_id, 15)
        assertions.append("revocation_stopped_runtime_and_fenced_delayed_renewal")
        daemon.terminate()
        daemon.wait(timeout=20)
        time.sleep(3.1)
        rejected("start", dict(containerId=container_id, fundingId=fresh["fundingId"]), "guard_not_healthy")
        print(json.dumps({"passed": True, "durationSeconds": round(time.time() - started_at, 2),
            "realDocker": True, "fundingReplayAndOwnerChecks": assertions,
            "renewalSurvivedPreviousDeadline": True, "expiryStoppedContainer": True,
            "lateStartStoppedAgain": True, "dataRetainedAfterRenewedStart": True,
            "previousBootLeaseStopped": True, "deadGuardRefusedStart": True}), flush=True)
    except Exception:
        # error-policy:J2 Preserve real host guard diagnostics before disposing only this test's resources.
        print(json.dumps({"guardDiagnostics": (root / "daemon.log").read_text()}), flush=True)
        raise
    finally:
        if daemon.poll() is None:
            daemon.terminate()
            daemon.wait(timeout=20)
        log.close()
        for name in names:
            checked("docker", "rm", "-f", name)
        shutil.rmtree(root)


if __name__ == "__main__":
    main()
