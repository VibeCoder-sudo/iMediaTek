#!/usr/bin/env python3
"""A stand-in for the phone's Arch console, on a pty, for testing the device backend.

It understands exactly the commands the backend sends and logs every write to a "partition"
(a file in FAKE_DEV_DIR) in events.log, so a test can prove nothing but boot_a was written.
Env: FAKE_DEV_DIR (required), FAKE_CORRUPT=1 (flip a byte when flashing), FAKE_BAD_PARTS=1
(report sdc36 under the wrong name).
"""
import hashlib, os, pty, re, socket, sys, time

dev_dir = os.environ['FAKE_DEV_DIR']
corrupt = os.environ.get('FAKE_CORRUPT') == '1'
bad_parts = os.environ.get('FAKE_BAD_PARTS') == '1'
PARTS = {'sdc36': ('boot_a', 16384), 'sdc56': ('boot_b', 16384), 'sdc61': ('userdata', 65536), 'sdc60': ('super', 65536)}
events = open(os.path.join(dev_dir, 'events.log'), 'a', buffering=1)

if os.environ.get('FAKE_TCP') == '1':
    # deterministic transport for tests: one TCP connection on localhost
    server = socket.socket()
    server.bind(('127.0.0.1', 0))
    server.listen(1)
    print('tcp:%d' % server.getsockname()[1], flush=True)
    conn, _ = server.accept()
    rd = lambda n: conn.recv(n)
    wr = lambda b: conn.sendall(b)
else:
    master, slave = pty.openpty()
    print(os.ttyname(slave), flush=True)
    rd = lambda n: os.read(master, n)
    wr = lambda b: os.write(master, b)


def out(text):
    wr((text + '\n').replace('\n', '\r\n').encode())


def event(text):
    events.write(text + '\n')


def read_exact(n):
    data = b''
    while len(data) < n:
        chunk = rd(min(65536, n - len(data)))
        if not chunk:
            raise SystemExit
        data += chunk
    return data


def handle(line):
    mark = None
    m = re.search(r'; echo (END_\S+)$', line)
    if m:
        mark, line = m.group(1), line[:m.start()]
    if line == 'uname -a':
        out('Linux fake 4.19.325-Orion #1 SMP PREEMPT aarch64 GNU/Linux')
    elif line == 'cat /proc/cmdline':
        out('console=ttyS0 androidboot.slot_suffix=_b')
    elif re.fullmatch(r'grep PARTNAME /sys/class/block/(sdc\d+)/uevent', line):
        sys_name = re.fullmatch(r'grep PARTNAME /sys/class/block/(sdc\d+)/uevent', line).group(1)
        name = PARTS[sys_name][0]
        if bad_parts and sys_name == 'sdc36':
            name = 'boot_x'
        out('PARTNAME=' + name)
    elif re.fullmatch(r'cat /sys/class/block/(sdc\d+)/size', line):
        out(str(PARTS[re.fullmatch(r'cat /sys/class/block/(sdc\d+)/size', line).group(1)][1]))
    elif line.startswith('stty -F /dev/ttyGS0 raw -echo; head -c '):
        m = re.fullmatch(r'stty -F /dev/ttyGS0 raw -echo; head -c (\d+) > /dev/(sdc\d+); sync; stty -F /dev/ttyGS0 sane; echo FLASH_DONE', line)
        size, target = int(m.group(1)), m.group(2)
        event('WRITE %s %d' % (target, size))
        if target != 'sdc36':
            event('VIOLATION %s' % target)
        time.sleep(0.2)
        data = read_exact(size)
        if corrupt:
            data = bytes([data[0] ^ 0xFF]) + data[1:]
        with open(os.path.join(dev_dir, target), 'wb') as f:
            f.write(data)
        out('FLASH_DONE')
    elif re.fullmatch(r'echo MD5=\$\(head -c (\d+) /dev/sdc36 \| md5sum\)', line):
        size = int(re.fullmatch(r'echo MD5=\$\(head -c (\d+) /dev/sdc36 \| md5sum\)', line).group(1))
        path = os.path.join(dev_dir, 'sdc36')
        data = open(path, 'rb').read(size) if os.path.exists(path) else b''
        out('MD5=%s  -' % hashlib.md5(data).hexdigest())
    elif line == '/usr/local/bin/slot_mgr.py a 1 0 && reboot -f':
        event('ARMED')
        time.sleep(0.3)
        raise SystemExit
    elif 'console-ramoops-0' in line:
        out('[    0.000000] DirectBoot: fake log line 1\n[   15.8] XNU: fake log line 2\n=== init: done ===')
    elif line.strip():
        event('UNKNOWN ' + line)
        out('sh: ' + line.split()[0] + ': command not found')
    if mark:
        out(mark)


buf = b''
while True:
    ch = rd(1)
    if not ch:
        break
    if ch == b'\n':
        wr(b'\r\n')
        handle(buf.decode('latin1').strip())
        buf = b''
    elif ch != b'\r':
        wr(ch)
        buf += ch
