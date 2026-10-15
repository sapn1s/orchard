#!/bin/sh
# ARCH-021 D1 — run INSIDE the confined runner. Prints one `KEY=value` line per probe;
# the suite (scripts/verify-arch-021-confined-userns.mjs) grades them. Every attack
# line prints the observed outcome, never just PASS/FAIL (WA §C).
r() { key=$1; shift; if out=$( "$@" 2>&1 ); then echo "$key=ok"; else echo "$key=refused:$(printf %s "$out" | tr '\n' ' ' | cut -c1-160)"; fi; }

# The property the opt-in exists for: an unprivileged user namespace.
r USERNS unshare -Ur true
r USERNS_MNT unshare -Urm sh -c 'mount -t tmpfs t /mnt && touch /mnt/x'

# Capability gain in the CONTAINER's own namespaces (must stay 0 / refused).
echo "CAPEFF=$(awk '/^CapEff/{print $2}' /proc/self/status)"
echo "NNP=$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)"
echo "SECCOMP=$(awk '/^Seccomp:/{print $2}' /proc/self/status)"
# Raw syscalls (util-linux refuses non-root before the kernel is asked; that proves nothing).
sc() { python3 -c "import ctypes,os,sys;l=ctypes.CDLL(None,use_errno=True);a=sys.argv[1:];
f={'mount':lambda:l.mount(b't',a[1].encode(),b'tmpfs',0,None),'remount':lambda:l.mount(None,a[1].encode(),None,32|4096,None),'umount':lambda:l.umount2(a[1].encode(),2)}[a[0]];
rc=f();e=ctypes.get_errno();print('ok' if rc==0 else 'errno:'+os.strerror(e));sys.exit(0 if rc==0 else 1)" "$@"; }
r MOUNT_CONTAINER_NS sc mount /mnt
r REMOUNT_ROOT_RW sc remount /
r UMOUNT_WORK_CONTAINER_NS sc umount /work
r SETNS_INIT_USERNS nsenter --user=/proc/1/ns/user --mount=/proc/1/ns/mnt true
# Inside a fresh userns: try to make the container's read-only rootfs writable.
r USERNS_REMOUNT_ROOT unshare -Urm sh -c 'mount -o remount,rw / && touch /etc/escaped'
r USERNS_REMOUNT_ROOT_RAW unshare -Urm python3 -c "import ctypes,sys;l=ctypes.CDLL(None,use_errno=True);sys.exit(0 if l.mount(None,b'/',None,32|4096,None)==0 else 1)"
r WRITE_ETC sh -c 'echo x > /etc/escaped'

# Host-mount escape: there is no host mount to reach, and the block devices are absent.
echo "HOST_DOCKER_SOCK=$(ls /var/run/docker.sock /run/docker.sock 2>/dev/null | tr '\n' ' ')"
echo "BLOCKDEVS=$(ls /dev 2>/dev/null | grep -E '^(sd|nvme|vd|xvd|loop|dm-)' | tr '\n' ' ')"
r USERNS_MOUNT_BLOCK unshare -Urm sh -c 'for d in /dev/sda /dev/nvme0n1p1 /dev/vda1 /dev/loop0; do mount "$d" /mnt 2>/dev/null && exit 0; done; exit 1'
r PROC1_ROOT_HOME sh -c 'test -n "$HOST_USER" && ls "/proc/1/root/home/$HOST_USER"'
r USERNS_PROC_MOUNT unshare -Urmpf --mount-proc sh -c 'ls /proc/1/root/ >/dev/null'
echo "HOST_HOME_EXISTS=$( [ -n "$HOST_USER" ] && [ -e "/home/$HOST_USER" ] && echo yes || echo no )"

# Network: still none, also from a new netns.
echo "IFACES=$(ls /sys/class/net | tr '\n' ' ')"
r NET_TCP node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>{process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))"
r USERNS_NET_TCP unshare -Urn node -e "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>{process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))"

# bwrap when the image has it (the D1 suite's image does).
if command -v bwrap >/dev/null 2>&1; then
  r BWRAP bwrap --dev-bind / / --ro-bind /work /work sh -c 'touch /work/should-fail'
  r BWRAP_TRUE bwrap --dev-bind / / true
else echo "BWRAP=absent"; fi
