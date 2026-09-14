/**
 * Installs a host-owned paid-runtime guard and addresses leases by immutable Docker id.
 * The guard remains independent of the control plane, preserves expired containers and
 * data, and keeps checking tombstones so a delayed Docker start cannot escape expiry.
 * Callers must commit funding and provider identity before granting a lease.
 */

import { createHash } from "node:crypto";
import {
  AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS,
  AGENT_COMPUTE_FUNDING_WINDOW_MS,
  AGENT_COMPUTE_STOP_MARGIN_MS,
} from "./agent-compute-policy";
import { shellQuote } from "./docker-sandbox-utils";
import type { DockerSSHClient } from "./docker-ssh";

const CONTROL_ROOT = "/var/lib/eliza/compute-leases";

/** The guard owns root-only files; deployment users use their existing noninteractive sudo authority. */
export function dockerComputeRootSSH(
  ssh: Pick<DockerSSHClient, "execStdin">,
  sshUsername: string,
): Pick<DockerSSHClient, "execStdin"> {
  return {
    execStdin: (command, input, timeoutMs) =>
      ssh.execStdin(
        sshUsername === "root" ? command : `sudo --non-interactive ${command}`,
        input,
        timeoutMs,
      ),
  };
}

export interface DockerComputeAuthorization {
  agentId: string;
  organizationId: string;
  containerId: string;
  fundingId: string;
  previousFundingId: string | null;
  issuedAtMs: number;
  paidFromMs: number;
  paidUntilMs: number;
}

/** Python is embedded because shared services are also bundled without filesystem assets. */
export const DOCKER_COMPUTE_GUARD_PROGRAM = String.raw`"""Enforce paid Docker lifetimes using root-owned leases and Linux boot time."""
import concurrent.futures
import contextlib
import fcntl
import json
import datetime
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(sys.argv[1])
ID = re.compile(r"[0-9a-f]{64}\Z")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
STOP_MARGIN_MS = ${AGENT_COMPUTE_STOP_MARGIN_MS}
MAX_FUNDING_WINDOW_MS = ${AGENT_COMPUTE_FUNDING_WINDOW_MS}
AUTH_CLOCK_SKEW_MS = ${AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS}
BOOT_ID = Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def wall_ms():
    return time.time_ns() // 1000000

def boot_ns():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME)

def read(path):
    return json.loads(path.read_text()) if path.exists() else None

def write(path, value):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

@contextlib.contextmanager
def lock(container_id):
    require(isinstance(container_id, str) and ID.fullmatch(container_id), 'invalid_container_id')
    with (ROOT / (container_id + '.lock')).open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield ROOT / (container_id + '.json')

def docker(*args, timeout=3):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    require(result.returncode == 0, 'docker_command_failed')
    return result.stdout

def inspect(container_id, authorization=None):
    # Query absence separately: a failed inspect is never evidence of deletion.
    ids = docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + container_id).split()
    if not ids:
        return None
    require(ids == [container_id], 'container_identity_mismatch')
    state = json.loads(docker('inspect', '--format',
        '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"restart":{{json .HostConfig.RestartPolicy.Name}},"startedAt":{{json .State.StartedAt}}}', container_id))
    require(state['id'] == container_id, 'container_identity_mismatch')
    labels = state['labels'] or {}
    require(labels.get('ai.elizaos.managed-by') == 'eliza-cloud', 'unmanaged_container')
    require(labels.get('ai.elizaos.container-class') in ('user', 'test'), 'unsupported_container_class')
    if authorization is not None:
        require(labels.get('ai.elizaos.agent-id') == authorization['agentId'], 'agent_identity_mismatch')
        require(labels.get('ai.elizaos.org-id') == authorization['organizationId'], 'organization_identity_mismatch')
    return state

def expired(lease):
    return (lease['expired'] or lease['bootId'] != BOOT_ID
        or wall_ms() >= lease['authorization']['paidUntilMs'] - STOP_MARGIN_MS
        or boot_ns() >= lease['expiresBootNs'])

def healthy():
    heartbeat = read(ROOT / 'heartbeat')
    require(heartbeat is not None and heartbeat['bootId'] == BOOT_ID
        and 0 <= boot_ns() - heartbeat['bootNs'] < 3000000000, 'guard_not_healthy')

def same_grant(left, right):
    # A fresh database-authorized retry may refresh transport time, never the paid interval or identity.
    return {key: value for key, value in left.items() if key != 'issuedAtMs'} == {key: value for key, value in right.items() if key != 'issuedAtMs'}

def validate(authorization):
    require(set(authorization) == {'agentId', 'organizationId', 'containerId', 'fundingId',
        'previousFundingId', 'issuedAtMs', 'paidFromMs', 'paidUntilMs'}, 'invalid_authorization')
    for key in ('agentId', 'organizationId', 'fundingId'):
        require(isinstance(authorization[key], str) and UUID.fullmatch(authorization[key]), 'invalid_' + key)
    previous = authorization['previousFundingId']
    require(previous is None or isinstance(previous, str) and UUID.fullmatch(previous), 'invalid_previous_funding')
    require(isinstance(authorization['containerId'], str) and ID.fullmatch(authorization['containerId']), 'invalid_container_id')
    for key in ('issuedAtMs', 'paidFromMs', 'paidUntilMs'):
        require(type(authorization[key]) is int and 0 < authorization[key] < 9007199254740991, 'invalid_' + key)
    require(authorization['paidFromMs'] < authorization['paidUntilMs'], 'invalid_paid_interval')

def grant(authorization):
    validate(authorization)
    healthy()
    container_id = authorization['containerId']
    with lock(container_id) as path:
        require(read(ROOT / 'revocations' / (authorization['fundingId'] + '.json')) is None, 'funding_revoked')
        old = read(path)
        if old is not None and old['authorization']['fundingId'] == authorization['fundingId']:
            require(same_grant(old['authorization'], authorization), 'funding_replay_conflict')
            require(not expired(old), 'funding_expired')
            return old
        now = wall_ms()
        require(abs(authorization['issuedAtMs'] - now) <= AUTH_CLOCK_SKEW_MS, 'stale_authorization_or_clock_skew')
        require(0 < authorization['paidUntilMs'] - authorization['issuedAtMs'] <= MAX_FUNDING_WINDOW_MS, 'invalid_funding_horizon')
        require(0 < authorization['paidUntilMs'] - now <= MAX_FUNDING_WINDOW_MS + AUTH_CLOCK_SKEW_MS, 'invalid_funding_horizon')
        require(authorization['paidUntilMs'] - now > 2 * STOP_MARGIN_MS, 'insufficient_paid_time')
        state = inspect(container_id, authorization)
        require(state is not None, 'container_absent')
        expires_boot = boot_ns() + (authorization['paidUntilMs'] - now - STOP_MARGIN_MS) * 1000000
        if old is None:
            require(authorization['previousFundingId'] is None, 'previous_funding_mismatch')
            require(not state['running'], 'initial_container_must_be_stopped')
            require(authorization['paidFromMs'] <= authorization['issuedAtMs'], 'funding_not_started')
        else:
            previous = old['authorization']
            require(authorization['previousFundingId'] == previous['fundingId'], 'previous_funding_mismatch')
            require(authorization['agentId'] == previous['agentId'] and
                authorization['organizationId'] == previous['organizationId'], 'funding_owner_changed')
            require(authorization['issuedAtMs'] >= previous['issuedAtMs'], 'stale_authorization')
            if expired(old):
                require(not state['running'], 'expired_container_must_be_stopped')
                require(authorization['paidFromMs'] <= authorization['issuedAtMs'], 'funding_not_started')
            else:
                require(authorization['paidUntilMs'] > previous['paidUntilMs'], 'funding_cannot_shorten')
                # A rolling reservation must cover the remaining old lease before its funds are released.
                require(authorization['paidFromMs'] <= min(authorization['issuedAtMs'], previous['paidUntilMs']), 'funding_interval_has_gap')
                expires_boot = min(expires_boot, old['expiresBootNs'] +
                    (authorization['paidUntilMs'] - previous['paidUntilMs']) * 1000000)
        history_path = ROOT / 'grants' / (authorization['fundingId'] + '.json')
        history = read(history_path)
        require(history is None or same_grant(history, authorization), 'funding_replay_conflict')
        docker('update', '--restart=no', container_id)
        write(history_path, authorization)
        lease = {'authorization': authorization, 'bootId': BOOT_ID, 'expiresBootNs': expires_boot,
            'expired': False, 'stoppedAtMs': None,
            'startedAtMs': old.get('startedAtMs') if old is not None and state['running'] else None,
            'dockerStartBeforeGrant': state['startedAt'] if not state['running'] else None}
        write(path, lease)
        return lease

def capture_start(path, lease, state):
    if (state is not None and lease.get('startedAtMs') is None
        and state['startedAt'] != lease.get('dockerStartBeforeGrant')
        and not state['startedAt'].startswith('0001-')):
        started = int(datetime.datetime.fromisoformat(state['startedAt'].replace('Z', '+00:00')).timestamp() * 1000)
        lease['startedAtMs'] = started
        write(path, lease)

def stop(path, lease):
    # Persist the tombstone before Docker effects; retries keep enforcing it after success.
    if not lease['expired']:
        lease['expired'] = True
        write(path, lease)
    container_id = lease['authorization']['containerId']
    state = inspect(container_id, lease['authorization'])
    capture_start(path, lease, state)
    if state is not None:
        if state['restart'] != 'no':
            docker('update', '--restart=no', container_id)
        if state['running']:
            try:
                docker('stop', '--time', '10', container_id, timeout=13)
            except (RuntimeError, subprocess.TimeoutExpired):
                # error-policy:J2 A timed-out stop is unresolved until kill and inspect succeed.
                docker('kill', container_id, timeout=5)
            state = inspect(container_id, lease['authorization'])
            require(state is None or not state['running'], 'container_stop_unresolved')
    if lease['stoppedAtMs'] is None:
        lease['stoppedAtMs'] = wall_ms()
        write(path, lease)
        write(ROOT / 'receipts' / (lease['authorization']['fundingId'] + '.json'), lease)
    return lease

def revoke(authorization):
    validate(authorization)
    container_id = authorization['containerId']
    with lock(container_id) as path:
        previous = read(path)
        tombstone_path = ROOT / 'revocations' / (authorization['fundingId'] + '.json')
        tombstone = read(tombstone_path)
        if tombstone is not None:
            require(same_grant(tombstone, authorization), 'revocation_replay_conflict')
        history = read(ROOT / 'grants' / (authorization['fundingId'] + '.json'))
        require(history is None or same_grant(history, authorization), 'revocation_replay_conflict')
        if previous is not None:
            old = previous['authorization']
            require(old['agentId'] == authorization['agentId'] and
                old['organizationId'] == authorization['organizationId'], 'funding_owner_changed')
            require(old['fundingId'] in (authorization['fundingId'], authorization['previousFundingId']),
                'revocation_funding_superseded')
            if old['fundingId'] == authorization['fundingId']:
                require(same_grant(old, authorization), 'revocation_replay_conflict')
        # Revoke even when a committed renewal has not reached the host yet.
        # The tombstone precedes Docker effects and forbids its delayed grant.
        state = inspect(container_id, authorization)
        if previous is not None:
            write(ROOT / 'revocations' / (previous['authorization']['fundingId'] + '.json'), previous['authorization'])
        write(tombstone_path, authorization)
        if previous is not None and previous['authorization']['fundingId'] == authorization['fundingId']:
            lease = previous
            lease['expired'] = True
        else:
            prior_stop = (previous['stoppedAtMs'] if previous is not None
                and previous['bootId'] == BOOT_ID and (state is None or not state['running']) else None)
            lease = {'authorization': authorization, 'bootId': BOOT_ID, 'expiresBootNs': boot_ns(),
                'expired': True, 'stoppedAtMs': prior_stop,
                'startedAtMs': previous.get('startedAtMs') if previous is not None else None,
                'dockerStartBeforeGrant': previous.get('dockerStartBeforeGrant') if previous is not None else (state['startedAt'] if state is not None else None)}
        write(path, lease)
        stopped = stop(path, lease)
        write(ROOT / 'receipts' / (authorization['fundingId'] + '.json'), stopped)
        return stopped

def start(request):
    require(set(request) == {'containerId', 'fundingId'}, 'invalid_start_request')
    healthy()
    with lock(request['containerId']) as path:
        lease = read(path)
        require(lease is not None and lease['authorization']['fundingId'] == request['fundingId'], 'funding_mismatch')
        require(not expired(lease), 'funding_expired')
        state = inspect(request['containerId'], lease['authorization'])
        require(state is not None and state['restart'] == 'no', 'container_not_guarded')
        require(not expired(lease), 'funding_expired_before_start')
        if not state['running']:
            docker('start', request['containerId'], timeout=10)
        if expired(lease):
            stop(path, lease)
            raise RuntimeError('funding_expired_during_start')
        state = inspect(request['containerId'], lease['authorization'])
        require(state is not None and state['running'], 'container_start_unresolved')
        capture_start(path, lease, state)
        return lease

def enforce(container_id):
    with lock(container_id) as path:
        lease = read(path)
        require(lease is not None and lease['authorization']['containerId'] == container_id, 'invalid_stored_lease')
        if expired(lease):
            stop(path, lease)

def daemon():
    with (ROOT / 'daemon.lock').open('a') as singleton:
        fcntl.flock(singleton, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pending = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=32) as executor:
            while True:
                for container_id, future in list(pending.items()):
                    if future.done():
                        try:
                            future.result()
                        except Exception as error:
                            # error-policy:J1 Retry enforcement; emit only a typed diagnostic, never Docker output.
                            print(json.dumps({'containerId': container_id, 'error': type(error).__name__}), file=sys.stderr, flush=True)
                        del pending[container_id]
                write(ROOT / 'heartbeat', {'bootId': BOOT_ID, 'bootNs': boot_ns()})
                for path in ROOT.glob('*.json'):
                    if ID.fullmatch(path.stem) and path.stem not in pending:
                        pending[path.stem] = executor.submit(enforce, path.stem)
                time.sleep(0.5)

def main():
    require(os.geteuid() == 0, 'root_required')
    require(ROOT.is_dir() and ROOT.stat().st_uid == 0 and ROOT.stat().st_mode & 0o077 == 0, 'unsafe_control_directory')
    operation = sys.argv[2]
    if operation == 'daemon':
        daemon()
    elif operation == 'grant':
        print(json.dumps(grant(json.load(sys.stdin))))
    elif operation == 'start':
        print(json.dumps(start(json.load(sys.stdin))))
    elif operation == 'revoke':
        print(json.dumps(revoke(json.load(sys.stdin))))
    else:
        raise RuntimeError('unknown_operation')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # error-policy:J1 CLI boundary fails closed without disclosing subprocess output.
        print(json.dumps({'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}), file=sys.stderr)
        sys.exit(1)
`;

const GUARD_DIGEST = createHash("sha256").update(DOCKER_COMPUTE_GUARD_PROGRAM).digest("hex");
const GUARD_PATH = `${CONTROL_ROOT}/guard-${GUARD_DIGEST}.py`;

const INSTALLER = String.raw`import fcntl, hashlib, json, os, pathlib, subprocess, sys, tempfile, time
root = pathlib.Path(sys.argv[1])
assert os.geteuid() == 0, 'root_required'
root.mkdir(mode=0o700, parents=True, exist_ok=True)
assert root.stat().st_uid == 0 and root.stat().st_mode & 0o077 == 0, 'unsafe_control_directory'
lock = (root / 'install.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX)
for name in ('grants', 'receipts', 'revocations'):
    (root / name).mkdir(mode=0o700, exist_ok=True)
program = sys.stdin.buffer.read()
assert hashlib.sha256(program).hexdigest() == sys.argv[2], 'program_digest_mismatch'
path = root / ('guard-' + sys.argv[2] + '.py')
if path.exists():
    assert path.read_bytes() == program, 'installed_program_mismatch'
else:
    fd, temporary = tempfile.mkstemp(dir=root)
    with os.fdopen(fd, 'wb') as output:
        output.write(program)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
unit = pathlib.Path('/etc/systemd/system/eliza-compute-guard.service')
content = '[Unit]\nDescription=Eliza paid compute expiry guard\nAfter=docker.service\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=/usr/bin/python3 ' + str(path) + ' ' + str(root) + ' daemon\nRestart=always\nRestartSec=1\nTimeoutStopSec=25\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n'
changed = not unit.exists() or unit.read_text() != content
if changed:
    fd, temporary = tempfile.mkstemp(dir=unit.parent)
    with os.fdopen(fd, 'w') as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, unit)
    subprocess.run(['systemctl', 'daemon-reload'], check=True, capture_output=True)
subprocess.run(['systemctl', 'enable', '--now', unit.name], check=True, capture_output=True)
if changed:
    subprocess.run(['systemctl', 'restart', unit.name], check=True, capture_output=True)
deadline = time.monotonic() + 5
boot_id = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
while True:
    heartbeat_path = root / 'heartbeat'
    if heartbeat_path.exists():
        heartbeat = json.loads(heartbeat_path.read_text())
        if heartbeat['bootId'] == boot_id and 0 <= time.clock_gettime_ns(time.CLOCK_BOOTTIME) - heartbeat['bootNs'] < 3000000000:
            break
    assert time.monotonic() < deadline, 'guard_not_healthy_after_install'
    time.sleep(0.05)
`;

export async function installDockerComputeGuard(ssh: Pick<DockerSSHClient, "execStdin">) {
  await ssh.execStdin(
    `python3 -c ${shellQuote(INSTALLER)} ${shellQuote(CONTROL_ROOT)} ${shellQuote(GUARD_DIGEST)}`,
    DOCKER_COMPUTE_GUARD_PROGRAM,
    60_000,
  );
}

export async function grantDockerComputeLease(
  ssh: Pick<DockerSSHClient, "execStdin">,
  authorization: DockerComputeAuthorization,
) {
  return ssh.execStdin(
    `python3 ${shellQuote(GUARD_PATH)} ${shellQuote(CONTROL_ROOT)} grant`,
    JSON.stringify(authorization),
    60_000,
  );
}

export async function startDockerComputeLease(
  ssh: Pick<DockerSSHClient, "execStdin">,
  identity: Pick<DockerComputeAuthorization, "containerId" | "fundingId">,
) {
  return ssh.execStdin(
    `python3 ${shellQuote(GUARD_PATH)} ${shellQuote(CONTROL_ROOT)} start`,
    JSON.stringify({ containerId: identity.containerId, fundingId: identity.fundingId }),
    60_000,
  );
}

/** Persists a terminal funding tombstone and proves the exact container stopped; never removes its state. */
export async function revokeDockerComputeLease(
  ssh: Pick<DockerSSHClient, "execStdin">,
  authorization: DockerComputeAuthorization,
) {
  return ssh.execStdin(
    `python3 ${shellQuote(GUARD_PATH)} ${shellQuote(CONTROL_ROOT)} revoke`,
    JSON.stringify(authorization),
    60_000,
  );
}
