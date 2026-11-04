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
4. **Get iOS.** Download the official iOS 16.5 (20F66) firmware for iPhone10,3 / iPhone10,6 from Apple (about 6.2 GB) and check its SHA-256 (`c1091c40...07d52f2`). The installer does this with resume; skip it if the phone already has the iOS volume.
5. **Pick the build.** *Stable* boots with CPU rendering. *Metal on Mali* adds `mali=1 metal=2 camtl=1 metal_profile=1 mali_trace=0` and is experimental.
6. **Flash `boot_a`.** `flash_boot_a.py` checks that `sdc36` is `boot_a`, streams the image, compares the MD5 and only then arms the one-shot boot.
   ```bash
   python3 flash_boot_a.py
   ```
7. **One-shot boot.**
   ```bash
   /usr/local/bin/slot_mgr.py a 1 0 && reboot -f
   ```
8. **Watch the phone.**

   | Time | What you see |
   | --- | --- |
   | 0:00 | POCO logo, then colored bars (DirectBoot) |
   | 0:15 | XNU verbose console |
   | 0:30 | Console gone, panel black while launchd and backboardd start |
   | ~2:00 | SpringBoard can draw (a black screen before this is normal) |
   | 5:00 | The phone resets and boots back into Arch (`loader_return_after=300`) |

   To leave early: hold five fingers on the screen for 1.5 seconds, or hold the power button.
9. **Read the log.** DirectBoot mirrors the kernel log into the ramoops console zone.
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

## What the installer does for you

In Live mode the app runs these same commands over the serial console (see `src/main/device/guard.js` for the exact templates): the partition checks, `head -c SIZE > /dev/sdc36` fed with the raw image, the MD5 read-back, and `slot_mgr.py a 1 0 && reboot -f`. Run it with Dry run first, and do the first Live run only up to *Check slots*, which only reads.
