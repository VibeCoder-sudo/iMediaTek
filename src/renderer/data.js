'use strict';

/* Static knowledge the UI shows: the device, the slot map, boot arguments and every install step. */
window.DATA = {
  device: {
    model: 'POCO M5s',
    codename: 'rosemary',
    soc: 'MediaTek Helio G95 (MT6785)',
    gpu: 'Mali-G76 MC4 (Bifrost)',
    panel: 'dsi_panel_k7_38_0c_0a_fhdp_video',
    console: '/dev/cu.usbmodemnyam00011',
  },

  slots: [
    { id: 'boot_a', dev: '/dev/sdc36', kind: 'target', icon: 'bi-play-circle-fill', tile: 't-blue', role: 'Test slot', note: 'The only partition a test boot writes. Every iMediaTek boot is a one-shot boot of this slot.' },
    { id: 'boot_b', dev: '/dev/sdc56', kind: 'locked', icon: 'bi-lock-fill', tile: 't-red', role: 'Arch Linux rescue kernel', note: 'Never written. The phone falls back here when a test boot hangs.' },
    { id: 'userdata', dev: '/dev/sdc61', kind: 'locked', icon: 'bi-lock-fill', tile: 't-red', role: 'Arch Linux root filesystem', note: 'Never written. It holds the rescue system you flash from.' },
    { id: 'super', dev: '/dev/sdc60', kind: 'readonly', icon: 'bi-eye-fill', tile: 't-gray', role: 'iOS 16.5 System volume', note: 'Read only during test boots: XNU reads it through the CPU1 block server, which refuses every write. The one-time iOS volume setup from the IPSW is not part of this preview and will ask for its own confirmation.' },
  ],

  /* Boot arguments compiled into DirectBoot. `locked` ones are required for the system to boot. */
  bootArgs: [
    { key: 'rd', value: 'md0', locked: true, on: true, desc: 'RAM disk root used by init' },
    { key: 'root_apfs', value: 'ufs_super', locked: true, on: true, desc: 'Mount the iOS System volume from flash' },
    { key: 'ufs_shared_pa', value: '0xd5380000', locked: true, on: true, desc: 'Mailbox shared with the CPU1 block server' },
    { key: 'pagesize16k', value: '1', locked: true, on: true, desc: '16 KB VM pages, required by the dyld shared cache signature' },
    { key: 'cpumask', value: '0xdd', locked: false, on: true, desc: 'Cores XNU may use' },
    { key: 'small_cores', value: '0', locked: false, on: true, desc: 'Keep the A55 cores off' },
    { key: 'mtk_touch', value: '1', locked: false, on: true, desc: 'Touch screen driver' },
    { key: 'keepsyms', value: '1', locked: false, on: true, desc: 'Keep kernel symbols for logs' },
    { key: 'debug', value: '0x8', locked: false, on: true, desc: 'XNU debug flags' },
    { key: 'serial', value: '0', locked: false, on: true, desc: 'No serial console' },
    { key: 'mali', value: '1', locked: false, on: false, desc: 'Start the Mali-G76 driver' },
    { key: 'metal', value: '2', locked: false, on: false, desc: 'Metal device on top of Mali' },
    { key: 'camtl', value: '1', locked: false, on: false, desc: 'CoreAnimation renders through Metal' },
    { key: 'metal_profile', value: '1', locked: false, on: false, desc: 'Report an Apple2+ GPU family to Metal Performance Shaders' },
    { key: 'mali_trace', value: '0', locked: false, on: false, desc: 'Silence per-job GPU logging' },
  ],

  presets: [
    { id: 'stable', title: 'Stable', subtitle: 'CPU rendering', icon: 'bi-shield-check', tile: 't-green', gpu: false },
    { id: 'metal', title: 'Metal on Mali', subtitle: 'Experimental GPU path', icon: 'bi-gpu-card', tile: 't-purple', gpu: true },
  ],
  gpuArgs: ['mali', 'metal', 'camtl', 'metal_profile', 'mali_trace'],

  steps: [
    {
      id: 'prepare', icon: 'bi-clipboard2-check', title: 'Prepare',
      kicker: 'Before you start',
      text: 'iMediaTek replaces nothing on your phone permanently, but it does need a phone that is already set up for it. Check every item.',
      checklist: [
        'The bootloader of the POCO M5s is unlocked.',
        'The Arch Linux rescue system is installed on boot_b and userdata (the phone boots into it normally).',
        'The phone is charged to at least 50% and connected with a data-capable USB cable.',
        'You can reach the Arch console on this Mac at /dev/cu.usbmodemnyam00011.',
        'You have a backup of anything you care about. A test boot is safe by design, but this is a research build.',
        'You know how to leave a stuck boot: hold five fingers on the screen for 1.5 seconds, or hold the power button.',
      ],
    },
    {
      id: 'connect', icon: 'bi-usb-symbol', title: 'Connect',
      kicker: 'Step 2',
      text: 'Open the Arch console over USB. All device actions go through this console, so nothing needs to be installed on the phone beyond the rescue system.',
      command: "python3 phone_sh.py 'uname -a'",
      run: 'connect', runLabel: 'Connect to the phone', runIcon: 'bi-link-45deg',
    },
    {
      id: 'inspect', icon: 'bi-hdd-rack', title: 'Check slots',
      kicker: 'Step 3',
      text: 'Before anything is written, the partition names are read back. The flasher refuses to continue unless /dev/sdc36 really is boot_a.',
      command: 'for p in sdc36 sdc56 sdc61; do grep PARTNAME /sys/class/block/$p/uevent; done',
      run: 'inspect', runLabel: 'Read partition table', runIcon: 'bi-search',
    },
    {
      id: 'download', icon: 'bi-cloud-arrow-down', title: 'Download',
      kicker: 'Step 4',
      text: 'The app reads version.json from the latest GitHub release and downloads every file straight from the release (no API calls, so there are no rate limits to hit).',
    },
    {
      id: 'verify', icon: 'bi-shield-check', title: 'Verify',
      kicker: 'Step 5',
      text: 'Each file is hashed while it downloads and compared with the SHA-256 in version.json. The boot image is also checked with MD5, the same check the on-phone flasher uses.',
    },
    {
      id: 'ipsw', icon: 'bi-file-earmark-zip', title: 'Get iOS',
      kicker: 'Step 6',
      text: 'iOS itself is not part of this project. The app downloads the official iOS 16.5 firmware (IPSW) straight from Apple to your Mac. The iOS System volume, the dyld shared cache and the cryptexes come from it.',
    },
    {
      id: 'profile', icon: 'bi-sliders', title: 'Choose kernel', autoDone: true,
      kicker: 'Step 6',
      text: 'Pick which build to flash. Both use the same boot image layout; they differ in the boot arguments baked into DirectBoot.',
    },
    {
      id: 'flash', icon: 'bi-cpu', title: 'Flash boot_a',
      kicker: 'Step 7',
      text: 'The boot image is streamed to /dev/sdc36 (boot_a) and read back; the MD5 of the partition must equal the MD5 of the file. boot_b and userdata are never opened for writing.',
      command: 'python3 flash_boot_a.py',
      run: 'flash', runLabel: 'Flash boot_a', runIcon: 'bi-lightning-charge-fill', confirm: true,
    },
    {
      id: 'arm', icon: 'bi-power', title: 'One-shot boot',
      kicker: 'Step 8',
      text: 'The slot manager is told to boot slot A exactly once. If anything hangs, the hardware watchdog resets the phone and it comes back in slot B (Arch) by itself.',
      command: '/usr/local/bin/slot_mgr.py a 1 0 && reboot -f',
      run: 'arm', runLabel: 'Boot iMediaTek once', runIcon: 'bi-arrow-repeat',
    },
    {
      id: 'observe', icon: 'bi-eye', title: 'Watch',
      kicker: 'Step 9',
      text: 'Look at the phone. This is what a healthy run looks like. The system returns to Arch on its own after about five minutes.',
      timeline: [
        ['0:00', 'POCO logo, then colored bars from DirectBoot.'],
        ['0:15', 'XNU verbose console fills the screen.'],
        ['0:30', 'The console disappears; the panel goes black while launchd and backboardd start.'],
        ['~2:00', 'SpringBoard needs about two minutes before it can draw. A black screen before that is normal.'],
        ['5:00', 'The phone resets by itself and boots back into Arch (slot B).'],
      ],
      extra: 'Leave early: hold five fingers on the screen for 1.5 seconds, or hold the power button.',
    },
    {
      id: 'collect', icon: 'bi-journal-text', title: 'Read the log',
      kicker: 'Step 10',
      text: 'DirectBoot mirrors the kernel log into the ramoops console zone. Once the phone is back in Arch, mount pstore and read it.',
      command: "mountpoint -q /sys/fs/pstore || mount -t pstore pstore /sys/fs/pstore; cat /sys/fs/pstore/console-ramoops-0",
      run: 'collect', runLabel: 'Fetch the log', runIcon: 'bi-box-arrow-in-down',
    },
  ],

  safety: [
    ['bi-lock-fill', 't-red', 'boot_b and userdata are never written', 'They hold the Arch Linux rescue system. The flasher refuses any plan that names them.'],
    ['bi-play-circle-fill', 't-blue', 'Test boots only write boot_a (/dev/sdc36)', 'The partition label is read back before every write. The iOS volume on super is read only while testing.'],
    ['bi-clock-history', 't-orange', 'Every boot is one-shot', 'slot_mgr.py a 1 0 arms slot A once; a hang makes the watchdog fall back to slot B.'],
    ['bi-check2-circle', 't-green', 'Every file is verified', 'SHA-256 from version.json for release files, SHA-256 of the iOS IPSW, MD5 of the partition after flashing.'],
  ],
};
