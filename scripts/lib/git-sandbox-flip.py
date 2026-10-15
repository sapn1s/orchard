#!/usr/bin/env python3
"""ARCH-021 D1 — switch a running session sandbox's git dirs read-only / read-write.

    git-sandbox-flip.py <pid> <userns-inode> <ro|rw> <path> [<path> ...]

Run by the Orchard SERVER only (never from inside a sandbox: there it gets EPERM,
because the sandboxed process holds no capability over its own namespace's
mounts and cannot setns into the parent user namespace).

Why a separate, single-threaded process: setns(CLONE_NEWUSER) refuses a
multithreaded caller (Node is always multithreaded), and nsenter+exec loses the
capabilities on execve for a non-root uid. So the flip is done in-process here.

Protocol: one JSON object on stdout {"ok": bool, "results": [{path, state, error?}]}.
Exit 0 only when every path reached the requested state. Fails closed: any error
leaves the path as it was (a ro path stays ro).

Safety:
  * the namespace is pinned by fd BEFORE it is checked, and its inode must equal
    <userns-inode> (the value the server recorded at spawn), so a recycled pid can
    never redirect the flip to a different process;
  * the target userns must differ from this process's own (never remount the host);
  * only an existing mount point whose path is exactly <path> is remounted; when
    <path> is not a mount point and the request is `ro`, a ro bind is ADDED (a repo
    registered after the session started); a `rw` request on a non-mount-point is
    an error (nothing to open);
  * per-mount flags (nosuid/nodev/noexec/atime) are preserved; only MS_RDONLY moves.
"""
import ctypes
import json
import os
import sys

CLONE_NEWUSER = 0x10000000
CLONE_NEWNS = 0x00020000
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND = 32, 4096
MS_NOATIME, MS_NODIRATIME, MS_RELATIME, MS_STRICTATIME = 1024, 2048, 1 << 21, 1 << 24
ST = {'ST_NOSUID': MS_NOSUID, 'ST_NODEV': MS_NODEV, 'ST_NOEXEC': MS_NOEXEC,
      'ST_NOATIME': MS_NOATIME, 'ST_NODIRATIME': MS_NODIRATIME, 'ST_RELATIME': MS_RELATIME}

libc = ctypes.CDLL(None, use_errno=True)


def die(msg, results=None):
    print(json.dumps({'ok': False, 'error': msg, 'results': results or []}))
    sys.exit(1)


def mountpoints():
    out = set()
    with open('/proc/self/mountinfo') as f:
        for line in f:
            mp = line.split(' ')[4]
            out.add(mp.encode().decode('unicode_escape'))
    return out


def preserved_flags(p):
    f = os.statvfs(p).f_flag
    flags = 0
    for name, ms in ST.items():
        bit = getattr(os, name, None)
        if bit is not None and f & bit:
            flags |= ms
    return flags


def main():
    if len(sys.argv) < 5:
        die('usage: git-sandbox-flip.py <pid> <userns-inode> <ro|rw> <path>...')
    pid, want_ino, mode, paths = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    if not pid.isdigit() or not want_ino.isdigit() or mode not in ('ro', 'rw'):
        die('bad arguments')
    if any(not os.path.isabs(p) or '\0' in p for p in paths):
        die('paths must be absolute')
    try:
        ufd = os.open(f'/proc/{pid}/ns/user', os.O_RDONLY)
        mfd = os.open(f'/proc/{pid}/ns/mnt', os.O_RDONLY)
    except OSError as e:
        die(f'cannot open namespaces of pid {pid}: {e.strerror}')
    if os.fstat(ufd).st_ino != int(want_ino):
        die(f'pid {pid} is not the recorded sandbox (userns inode {os.fstat(ufd).st_ino} != {want_ino})')
    if os.fstat(ufd).st_ino == os.stat('/proc/self/ns/user').st_ino:
        die('target user namespace is our own; refusing to remount the host')
    if libc.setns(ufd, CLONE_NEWUSER) != 0:
        die(f'setns(user) failed: {os.strerror(ctypes.get_errno())}')
    if libc.setns(mfd, CLONE_NEWNS) != 0:
        die(f'setns(mnt) failed: {os.strerror(ctypes.get_errno())}')
    os.chdir('/')
    mps = mountpoints()
    results, ok = [], True
    for p in paths:
        r = {'path': p}
        try:
            if p not in mps:
                if mode == 'rw':
                    raise OSError(0, 'not a sandbox mount point; nothing to open')
                if not os.path.isdir(p):
                    raise OSError(0, 'not a directory')
                if libc.mount(p.encode(), p.encode(), None, MS_BIND, None) != 0:
                    raise OSError(ctypes.get_errno(), 'bind: ' + os.strerror(ctypes.get_errno()))
                r['added'] = True
            flags = MS_REMOUNT | MS_BIND | preserved_flags(p) | (MS_RDONLY if mode == 'ro' else 0)
            if libc.mount(None, p.encode(), None, flags, None) != 0:
                e = ctypes.get_errno()
                raise OSError(e, 'remount: ' + os.strerror(e))
            r['state'] = 'ro' if os.statvfs(p).f_flag & os.ST_RDONLY else 'rw'
            if r['state'] != mode:
                raise OSError(0, f'state is {r["state"]} after remount')
        except OSError as e:
            ok = False
            r['error'] = e.strerror or str(e)
            try:
                r['state'] = 'ro' if os.statvfs(p).f_flag & os.ST_RDONLY else 'rw'
            except OSError:
                r['state'] = 'unknown'
        results.append(r)
    print(json.dumps({'ok': ok, 'results': results}))
    sys.exit(0 if ok else 1)


main()
