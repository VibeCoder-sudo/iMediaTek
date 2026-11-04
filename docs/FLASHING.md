# Flashing guide

This is the manual procedure the installer automates. It assumes the Arch Linux rescue system is already installed on `boot_b` and `userdata`, and the phone normally boots into it.

## Rules

- **Never write `/dev/sdc56` (`boot_b`) or `/dev/sdc61` (`userdata`).** They are the rescue system.
- Test boots go to **`/dev/sdc36` (`boot_a`)** only.
- Always arm the one-shot boot before testing (`slot_mgr.py a 1 0`), so the watchdog returns the phone to slot B if anything hangs.

## Steps

1. **Connect.** The Arch console shows up on the Mac as `/dev/cu.usbmodemnyam00011`.
   ```bash
   python3 phone_sh.py 'uname -a'
   ```
2. **Check the slots.**
   ```bash
   for p in sdc36 sdc56 sdc61; do grep PARTNAME /sys/class/block/$p/uevent; done
   ```
   `sdc36` must say `boot_a`. If it does not, stop.
3. **Download and verify** the release files (the installer does it; by hand: compare `sha256sum` with `version.json`).
4. **Pick the build.** *Stable* boots with CPU rendering. *Metal on Mali* adds `mali=1 metal=2 camtl=1 metal_profile=1 mali_trace=0` and is experimental.
5. **Flash `boot_a`.** `flash_boot_a.py` checks that `sdc36` is `boot_a`, streams the image, compares the MD5 and only then arms the one-shot boot.
   ```bash
   python3 flash_boot_a.py
   ```
6. **One-shot boot.**
   ```bash
   /usr/local/bin/slot_mgr.py a 1 0 && reboot -f
   ```
7. **Watch the phone.**

   | Time | What you see |
   | --- | --- |
   | 0:00 | POCO logo, then colored bars (DirectBoot) |
   | 0:15 | XNU verbose console |
   | 0:30 | Console gone, panel black while launchd and backboardd start |
   | ~2:00 | SpringBoard can draw (a black screen before this is normal) |
   | 5:00 | The phone resets and boots back into Arch (`loader_return_after=300`) |

   To leave early: hold five fingers on the screen for 1.5 seconds, or hold the power button.
8. **Read the log.** DirectBoot mirrors the kernel log into the ramoops console zone.
   ```bash
   mountpoint -q /sys/fs/pstore || mount -t pstore pstore /sys/fs/pstore
   cat /sys/fs/pstore/console-ramoops-0
   ```

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| Black screen | Wait. After five minutes the phone returns to Arch by itself. |
| Phone does not come back | Hold the power button for 10 to 15 seconds. The one-shot flag is already used, so it boots slot B. |
| Hash mismatch | Do not flash. Download again. |
| `sdc36` is not `boot_a` | Stop. Do not write anything. |

## What the installer will add

The device backend (serial console to the Arch system, the partition check, the streaming write and the MD5 comparison) replaces `src/main/backend-stub.js` and keeps its `run(step, params, log)` contract, so the interface does not change.
