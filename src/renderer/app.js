'use strict';

(function () {
  const D = window.DATA;
  const api = window.imediatek;

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ } },
  };

  const state = {
    view: 'overview',
    step: store.get('step', 0),
    done: new Set(store.get('done', [])),
    checks: store.get('checks', []),
    profile: store.get('profile', 'stable'),
    args: store.get('args', null),
    returnAfter: store.get('returnAfter', 300),
    confirmed: false,
    manifest: null,
    source: null,
    manifestError: null,
    download: { running: false, progress: {}, results: null, dir: null },
    inspect: null,
    busy: false,
    logs: [],
    showRaw: false,
    info: null,
  };

  /* ---------- helpers ---------- */
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name) => `<i class="bi ${name}"></i>`;
  const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const $ = (selector) => document.querySelector(selector);

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function log(text, cls) {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    state.logs.push({ stamp, text, cls: cls || '' });
    if (state.logs.length > 500) state.logs.shift();
    const box = $('#console');
    if (box) { box.insertAdjacentHTML('beforeend', logLine(state.logs[state.logs.length - 1])); box.scrollTop = box.scrollHeight; }
  }
  const logLine = (l) => `<div><span class="ts">${l.stamp}</span> <span class="${l.cls}">${esc(l.text)}</span></div>`;

  function persist() {
    store.set('step', state.step);
    store.set('done', [...state.done]);
    store.set('checks', state.checks);
    store.set('profile', state.profile);
    store.set('args', state.args);
    store.set('returnAfter', state.returnAfter);
  }

  function ensureArgs() {
    if (state.args) return;
    state.args = {};
    const preset = D.presets.find((p) => p.id === state.profile) || D.presets[0];
    D.bootArgs.forEach((a) => { state.args[a.key] = D.gpuArgs.includes(a.key) ? preset.gpu : a.on; });
  }

  function applyPreset(id) {
    const preset = D.presets.find((p) => p.id === id);
    if (!preset) return;
    state.profile = id;
    ensureArgs();
    D.gpuArgs.forEach((key) => { state.args[key] = preset.gpu; });
    persist();
  }

  function cmdline() {
    ensureArgs();
    const parts = D.bootArgs.filter((a) => a.locked || state.args[a.key]).map((a) => `${a.key}=${a.value}`);
    parts.push(`loader_return_after=${state.returnAfter}`);
    return parts.join(' ');
  }

  const stepUnlocked = (i) => i === 0 || state.done.has(i - 1) || state.done.has(i);

  /* ---------- views ---------- */
  const NAV = [
    ['overview', 'bi-house-door-fill', 'Overview'],
    ['install', 'bi-download', 'Install'],
    ['config', 'bi-sliders2', 'Configuration'],
    ['releases', 'bi-box-seam-fill', 'Releases'],
    ['logs', 'bi-terminal-fill', 'Logs'],
    ['safety', 'bi-shield-lock-fill', 'Safety'],
  ];

  function renderNav() {
    $('#nav').innerHTML = NAV.map(([id, ic, label]) => `
      <button class="nav-item ${state.view === id ? 'active' : ''}" data-action="nav" data-id="${id}">
        ${icon(ic)}<span>${label}</span>
        ${id === 'install' ? `<span class="count">${state.done.size}/${D.steps.length}</span>` : ''}
      </button>`).join('');
    const live = state.source === 'remote';
    $('#sidebarFoot').innerHTML = `
      <div class="pill-live"><span class="dot ${live ? 'ok' : ''}"></span>${live ? 'Release feed online' : 'Demo manifest'}</div>
      <div style="margin-top:4px">v${esc(state.info ? state.info.version : '0.1.0')} · front-end preview</div>`;
  }

  function viewOverview() {
    const m = state.manifest;
    return `
      <div class="hero">
        <div class="hero-icon">${icon('bi-phone-fill')}</div>
        <div>
          <h1>iMediaTek</h1>
          <p>iOS 16.5 on the ${esc(D.device.model)}. Flash the proof of concept to the test slot and boot it once, safely.</p>
          <div class="hero-actions">
            <button class="btn" data-action="nav" data-id="install">${icon('bi-play-fill')} Start installation</button>
            <button class="btn secondary" data-action="nav" data-id="safety">${icon('bi-shield-check')} How it stays safe</button>
          </div>
        </div>
      </div>

      <div class="callout blue" style="margin-top:16px">
        ${icon('bi-info-circle-fill')}
        <div><b>Front-end preview.</b> Downloads and hash checks are real once a release exists; device actions are dry runs that print what they would do and write nothing.</div>
      </div>

      <div class="section-label">Device</div>
      <div class="group">
        ${deviceRow('bi-phone', 't-blue', 'Model', `${D.device.model} (${D.device.codename})`)}
        ${deviceRow('bi-cpu', 't-purple', 'SoC', D.device.soc)}
        ${deviceRow('bi-gpu-card', 't-orange', 'GPU', D.device.gpu)}
        ${deviceRow('bi-display', 't-teal', 'Panel', D.device.panel)}
      </div>

      <div class="section-label">Release</div>
      <div class="group">
        <div class="row">
          <span class="icon-tile t-green">${icon('bi-box-seam-fill')}</span>
          <div class="grow"><div class="title">${m ? `iMediaTek ${esc(m.version)}` : 'No release loaded'}</div>
          <div class="sub">${m ? `${esc(m.channel || 'stable')} · ${m.assets.length} files · ${state.source === 'remote' ? 'from GitHub Releases' : 'bundled demo manifest'}` : 'Open Releases to fetch version.json'}</div></div>
          <button class="btn secondary small" data-action="refresh">${icon('bi-arrow-clockwise')} Check for updates</button>
        </div>
        <div class="row">
          <span class="icon-tile t-blue">${icon('bi-play-circle-fill')}</span>
          <div class="grow"><div class="title">Target slot</div><div class="sub">The only partition that is ever written</div></div>
          <span class="badge blue">boot_a · /dev/sdc36</span>
        </div>
        <div class="row">
          <span class="icon-tile t-red">${icon('bi-lock-fill')}</span>
          <div class="grow"><div class="title">Protected</div><div class="sub">Arch Linux rescue system</div></div>
          <span class="badge red">boot_b · userdata</span>
        </div>
      </div>`;
  }

  const deviceRow = (ic, tile, label, value) => `
    <div class="row"><span class="icon-tile ${tile}">${icon(ic)}</span><div class="grow title">${label}</div><div class="value">${esc(value)}</div></div>`;

  /* ----- install wizard ----- */
  function viewInstall() {
    const s = D.steps[state.step];
    return `
      <h1>Install</h1>
      <p class="lede">Ten steps from a connected phone to a one-shot boot.</p>
      <div class="callout" style="margin-bottom:22px">${icon('bi-exclamation-triangle-fill')}<div><b>Dry run.</b> This build simulates every device action. Nothing is written to the phone.</div></div>
      <div class="stepper" role="list">
        ${D.steps.map((st, i) => `
          <button class="sdot ${i === state.step ? 'current' : ''} ${state.done.has(i) ? 'done' : ''}" role="listitem" data-action="step" data-i="${i}" title="${esc(st.title)}" ${stepUnlocked(i) ? '' : 'disabled'}>${state.done.has(i) ? icon('bi-check-lg') : i + 1}</button>
          ${i < D.steps.length - 1 ? `<span class="sline ${state.done.has(i) ? 'done' : ''}"></span>` : ''}`).join('')}
      </div>
      <div class="step-card">
        <div class="kicker">Step ${state.step + 1} of ${D.steps.length}</div>
        <h2>${icon(s.icon)}<span>${esc(s.title)}</span></h2>
        <p>${esc(s.text)}</p>
        ${stepBody(s)}
        <div class="step-actions">
          <button class="btn secondary" data-action="prev" ${state.step === 0 ? 'disabled' : ''}>${icon('bi-chevron-left')} Back</button>
          <span class="spacer"></span>
          ${state.step === D.steps.length - 1
            ? `<button class="btn" data-action="finish" ${state.done.has(state.step) ? '' : 'disabled'}>${icon('bi-check2-circle')} Finish</button>`
            : `<button class="btn" data-action="next" ${state.done.has(state.step) ? '' : 'disabled'}>Continue ${icon('bi-chevron-right')}</button>`}
        </div>
      </div>
    </div>`;
  }

  const cmdLine = (c) => `<div class="cmd"><code>${esc(c)}</code><button data-action="copy" data-text="${esc(c)}" title="Copy">${icon('bi-clipboard')}</button></div>`;
  const cmdBox = (c) => `<details class="disclose"><summary>${icon('bi-chevron-right')}<span>Show command</span></summary>${cmdLine(c)}</details>`;

  function stepBody(s) {
    switch (s.id) {
      case 'prepare': return prepareBody(s);
      case 'download': return downloadBody();
      case 'verify': return verifyBody();
      case 'profile': return profileBody();
      case 'flash': return flashBody(s);
      case 'observe': return observeBody(s);
      case 'inspect': return `${cmdBox(s.command)}${inspectResult()}${runButton(s)}`;
      default: return `${s.command ? cmdBox(s.command) : ''}${runButton(s)}`;
    }
  }

  const runButton = (s, disabled) => `
    <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
      <button class="btn" data-action="run" data-step="${s.run}" ${state.busy || disabled ? 'disabled' : ''}>${icon(s.runIcon)} ${s.runLabel}</button>
      ${state.done.has(state.step) ? `<span class="badge green">${icon('bi-check-lg')} Done</span>` : ''}
      ${state.busy ? '<span class="badge">Working…</span>' : ''}
    </div>`;

  function prepareBody(s) {
    return `<ul class="checklist">${s.checklist.map((text, i) => `
      <li><button class="check ${state.checks[i] ? 'on' : ''}" data-action="check" data-i="${i}" aria-pressed="${!!state.checks[i]}">${icon('bi-check-lg')}</button><span>${esc(text)}</span></li>`).join('')}</ul>`;
  }

  function inspectResult() {
    if (!state.inspect) return '';
    return `<div class="group" style="margin-top:14px">${D.slots.filter((x) => x.kind !== 'readonly').map((x) => `
      <div class="row"><span class="icon-tile ${x.tile}">${icon(x.icon)}</span>
      <div class="grow"><div class="title">${x.id}</div><div class="sub mono">${x.dev}</div></div>
      <span class="badge ${x.kind === 'target' ? 'blue' : 'red'}">${x.kind === 'target' ? 'will be written' : 'protected'}</span></div>`).join('')}</div>`;
  }

  function downloadBody() {
    const m = state.manifest;
    if (!m) {
      return `<div style="margin-top:12px"><button class="btn" data-action="refresh" ${state.busy ? 'disabled' : ''}>${icon('bi-cloud')} Read version.json</button></div>`;
    }
    const dl = state.download;
    const rows = m.assets.map((a) => {
      const p = dl.progress[a.name];
      const pct = p ? Math.min(100, Math.round((p.received / p.total) * 100)) : (dl.results ? 100 : 0);
      return `<div class="row"><div class="grow"><div class="title">${esc(a.name)}</div><div class="sub">${esc(a.role || '')} · ${bytes(a.size)}</div>
        <div class="progress ${dl.results ? 'ok' : ''}" style="margin-top:8px"><i style="width:${pct}%"></i></div></div><div class="value">${pct}%</div></div>`;
    }).join('');
    return `
      <div style="margin:12px 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="badge ${state.source === 'remote' ? 'green' : 'orange'}">${state.source === 'remote' ? 'GitHub release' : 'Demo manifest'}</span>
        <span class="badge">v${esc(m.version)}</span><span class="badge">${esc(m.channel || 'stable')}</span>
      </div>
      <div class="group">${rows}</div>
      <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
        <button class="btn" data-action="download" ${dl.running ? 'disabled' : ''}>${icon('bi-cloud-arrow-down-fill')} ${dl.results ? 'Download again' : 'Download'}</button>
        ${dl.results && dl.dir ? `<button class="btn secondary" data-action="folder">${icon('bi-folder2-open')} Show in Finder</button>` : ''}
        ${state.done.has(state.step) ? `<span class="badge green">${icon('bi-check-lg')} Done</span>` : ''}
      </div>
      ${state.source === 'demo' ? `<p class="footnote">${state.manifestError ? `No release found (${esc(state.manifestError)}). ` : ''}Demo mode: downloads are simulated.</p>` : ''}`;
  }

  function verifyBody() {
    const res = state.download.results;
    if (!res) return `<div class="callout">${icon('bi-exclamation-triangle-fill')}<div>Download the files first.</div></div>`;
    const m = state.manifest;
    return `<div class="group">${res.map((r) => {
      const a = m.assets.find((x) => x.name === r.name) || {};
      return `<div class="row"><span class="icon-tile ${r.ok ? 't-green' : 't-red'}">${icon(r.ok ? 'bi-patch-check-fill' : 'bi-x-lg')}</span>
        <div class="grow"><div class="title">${esc(r.name)}</div>
        <div class="hash">sha256 ${esc(a.sha256 || '')}</div>
        ${a.md5 ? `<div class="hash">md5 ${esc(a.md5)}</div>` : ''}</div>
        <span class="badge ${r.ok ? 'green' : 'red'}">${r.simulated ? 'simulated' : r.ok ? 'match' : 'MISMATCH'}</span></div>`;
    }).join('')}</div>
    ${res.every((r) => r.ok) ? '' : '<div class="callout red" style="margin-top:12px">' + icon('bi-x-octagon-fill') + '<div><b>A file does not match its hash.</b> It was deleted. Download again; if it keeps failing, do not flash.</div></div>'}`;
  }

  function profileBody() {
    ensureArgs();
    return `<div class="group" style="margin-top:6px">${D.presets.map((p) => `
      <div class="row" data-action="profile" data-id="${p.id}" style="cursor:default">
        <span class="icon-tile ${p.tile}">${icon(p.icon)}</span>
        <div class="grow"><div class="title">${p.title}</div><div class="sub">${p.subtitle}</div></div>
        ${state.profile === p.id ? `<span class="badge blue">${icon('bi-check-lg')} Selected</span>` : ''}
      </div>`).join('')}</div>
      <div class="section-label">Boot arguments</div>${cmdLine(cmdline())}
      <p class="footnote">Fine-tune them in Configuration. The same boot image is flashed either way.</p>`;
  }

  function flashBody(s) {
    return `
      <div class="group" style="margin-top:6px">
        <div class="row"><span class="icon-tile t-blue">${icon('bi-file-earmark-binary-fill')}</span><div class="grow"><div class="title">rosemary_xnu_boot.img</div><div class="sub">${state.manifest ? `v${esc(state.manifest.version)}` : 'no release loaded'} · profile ${esc(state.profile)}</div></div></div>
        <div class="row"><span class="icon-tile t-blue">${icon('bi-play-circle-fill')}</span><div class="grow"><div class="title">Destination</div><div class="sub mono">/dev/sdc36 (boot_a)</div></div><span class="badge blue">write</span></div>
        <div class="row"><span class="icon-tile t-red">${icon('bi-lock-fill')}</span><div class="grow"><div class="title">Never touched</div><div class="sub mono">/dev/sdc56 (boot_b) · /dev/sdc61 (userdata)</div></div><span class="badge red">protected</span></div>
      </div>
      ${cmdBox(s.command)}
      <ul class="checklist"><li><button class="check ${state.confirmed ? 'on' : ''}" data-action="confirm" aria-pressed="${state.confirmed}">${icon('bi-check-lg')}</button><span>I checked that the destination is boot_a and I have the Arch rescue system on boot_b.</span></li></ul>
      ${runButton(s, !state.confirmed || !state.download.results)}`;
  }

  function observeBody(s) {
    return `<ul class="timeline">${s.timeline.map(([t, text]) => `<li><span class="t">${t}</span><span>${esc(text)}</span></li>`).join('')}</ul>
      <div class="callout blue" style="margin-top:12px">${icon('bi-hand-index-thumb-fill')}<div>${esc(s.extra)}</div></div>
      <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
        <button class="btn" data-action="mark" ${state.done.has(state.step) ? 'disabled' : ''}>${icon('bi-check2')} The phone is back in Arch</button>
        ${state.done.has(state.step) ? `<span class="badge green">${icon('bi-check-lg')} Done</span>` : ''}
      </div>`;
  }

  /* ----- configuration ----- */
  function viewConfig() {
    ensureArgs();
    return `
      <h1>Configuration</h1>
      <p class="lede">Where the image goes and what the kernel is told when it starts.</p>

      <div class="section-label">Slot map</div>
      <div class="slotmap">${D.slots.slice(0, 3).map((x) => `
        <div class="slot ${x.kind}"><span class="icon-tile ${x.tile}">${icon(x.icon)}</span>
          <div class="name">${x.id}</div><div class="dev mono">${x.dev}</div>
          <div style="margin:8px 0 6px"><span class="badge ${x.kind === 'target' ? 'blue' : 'red'}">${x.kind === 'target' ? 'Write target' : 'Protected'}</span></div>
          <div class="sub" style="color:var(--text-2)">${esc(x.role)}. ${esc(x.note)}</div></div>`).join('')}</div>
      <div class="group" style="margin-top:12px"><div class="row"><span class="icon-tile t-gray">${icon('bi-eye-fill')}</span>
        <div class="grow"><div class="title">super · <span class="mono">/dev/sdc60</span></div><div class="sub">${esc(D.slots[3].role)}. ${esc(D.slots[3].note)}</div></div><span class="badge">Read only</span></div></div>

      <div class="section-label">Boot behaviour</div>
      <div class="group">
        <div class="row"><div class="grow"><div class="title">Preset</div><div class="sub">Switches the GPU arguments on or off</div></div>
          <div class="segmented">${D.presets.map((p) => `<button class="${state.profile === p.id ? 'on' : ''}" data-action="preset" data-id="${p.id}">${p.title}</button>`).join('')}</div></div>
        <div class="row"><div class="grow"><div class="title">Return to Arch after</div><div class="sub">DirectBoot hands the phone back after this many seconds (loader_return_after)</div></div>
          <input type="range" min="60" max="900" step="30" value="${state.returnAfter}" data-action="range"><span class="value" style="width:56px">${state.returnAfter} s</span></div>
        <div class="row"><div class="grow"><div class="title">Boot method</div><div class="sub">One-shot: slot_mgr.py a 1 0, then reboot</div></div><span class="badge green">Watchdog fallback to slot B</span></div>
      </div>

      <div class="section-label">Boot arguments</div>
      <div class="group">${D.bootArgs.map((a) => `
        <div class="row"><div class="grow"><div class="title mono">${a.key}=${a.value}</div><div class="sub">${esc(a.desc)}${a.locked ? ' · required' : ''}</div></div>
          <label class="toggle"><input type="checkbox" data-action="arg" data-key="${a.key}" ${(a.locked || state.args[a.key]) ? 'checked' : ''} ${a.locked ? 'disabled' : ''}><span></span></label></div>`).join('')}</div>
      <div class="section-label">Resulting command line</div>
      ${cmdLine(cmdline())}
      <p class="footnote">The command line is compiled into DirectBoot today. The final flasher will rebuild the image from these choices.</p>`;
  }

  /* ----- releases ----- */
  function viewReleases() {
    const m = state.manifest;
    const url = state.info ? state.info.manifestUrl : '';
    return `
      <h1>Releases</h1>
      <p class="lede">Every release carries a <span class="mono">version.json</span> with sizes and hashes. The app downloads it directly, not through the API.</p>
      <div class="group">
        <div class="row"><span class="icon-tile t-blue">${icon('bi-link-45deg')}</span><div class="grow"><div class="title">Manifest</div><div class="sub mono" style="word-break:break-all">${esc(url)}</div></div>
          <button class="btn secondary small" data-action="refresh">${icon('bi-arrow-clockwise')} Refresh</button></div>
        ${m ? `<div class="row"><span class="icon-tile t-green">${icon('bi-tag-fill')}</span><div class="grow"><div class="title">Version ${esc(m.version)}</div><div class="sub">${esc(m.channel || 'stable')} · released ${esc(String(m.released || '').slice(0, 10))}</div></div>
          <span class="badge ${state.source === 'remote' ? 'green' : 'orange'}">${state.source === 'remote' ? 'Online' : 'Demo'}</span></div>` : ''}
      </div>
      ${state.manifestError ? `<p class="footnote">${icon('bi-exclamation-circle')} ${esc(state.manifestError)}</p>` : ''}
      ${m ? `<div class="section-label">Files</div>
      <div class="group scroll-x"><table class="table"><thead><tr><th>File</th><th>Size</th><th>SHA-256</th></tr></thead><tbody>
        ${m.assets.map((a) => `<tr><td><b>${esc(a.name)}</b><div class="sub" style="color:var(--text-2)">${esc(a.role || '')}</div></td><td>${bytes(a.size)}</td><td class="hash">${esc(a.sha256)}</td></tr>`).join('')}
      </tbody></table></div>
      ${m.notes ? `<p class="footnote">${esc(m.notes)}</p>` : ''}
      <div style="margin-top:14px"><button class="btn plain" data-action="raw">${icon(state.showRaw ? 'bi-chevron-down' : 'bi-chevron-right')} version.json</button></div>
      ${state.showRaw ? `<pre class="json">${esc(JSON.stringify(m, null, 2))}</pre>` : ''}` : ''}
      <div class="section-label">Links</div>
      <div class="group"><div class="row"><span class="icon-tile t-gray">${icon('bi-github')}</span><div class="grow title">Releases on GitHub</div><a data-action="open" data-url="${esc(state.info ? state.info.repoUrl + '/releases' : '')}">Open ${icon('bi-box-arrow-up-right')}</a></div></div>`;
  }

  /* ----- logs ----- */
  function viewLogs() {
    return `
      <h1>Logs</h1>
      <p class="lede">What the app did. The kernel log itself lives in pstore on the phone (step 10).</p>
      <div class="console" id="console">${state.logs.length ? state.logs.map(logLine).join('') : '<span class="ts">Nothing yet.</span>'}</div>
      <div style="margin-top:12px;display:flex;gap:10px">
        <button class="btn secondary small" data-action="copylog">${icon('bi-clipboard')} Copy</button>
        <button class="btn secondary small" data-action="clearlog">${icon('bi-trash')} Clear</button></div>
      <div class="section-label">Read the phone log by hand</div>
      ${cmdLine("python3 phone_sh.py 'mountpoint -q /sys/fs/pstore || mount -t pstore pstore /sys/fs/pstore; cat /sys/fs/pstore/console-ramoops-0' 30")}`;
  }

  /* ----- safety ----- */
  function viewSafety() {
    return `
      <h1>Safety</h1>
      <p class="lede">The rules that make a failed test boot a non-event.</p>
      <div class="group">${D.safety.map(([ic, tile, title, text]) => `
        <div class="row"><span class="icon-tile ${tile}">${icon(ic)}</span><div class="grow"><div class="title">${esc(title)}</div><div class="sub">${esc(text)}</div></div></div>`).join('')}</div>

      <div class="section-label">If something goes wrong</div>
      <div class="group">
        ${recoveryRow('The screen stays black', 'Wait. SpringBoard needs about two minutes. After five minutes the phone returns to Arch by itself.')}
        ${recoveryRow('The phone does not come back', 'Hold the power button for 10–15 seconds. The one-shot flag is already consumed, so it boots slot B.')}
        ${recoveryRow('You want out now', 'Hold five fingers on the screen for 1.5 seconds.')}
        ${recoveryRow('A hash does not match', 'Do not flash. Download again. Report it if it repeats.')}
      </div>

      <div class="section-label">About</div>
      <div class="group">
        <div class="row"><div class="grow"><div class="title">This project is a research proof of concept.</div>
        <div class="sub">It contains no Apple software. iOS, the kernel image and the root filesystem are not part of this repository. "iPhone", "iOS", "Mac" and "SF Pro" are trademarks of Apple Inc.; iMediaTek is not affiliated with or endorsed by Apple.</div></div></div>
      </div>`;
  }
  const recoveryRow = (title, text) => `<div class="row"><span class="icon-tile t-orange">${icon('bi-life-preserver')}</span><div class="grow"><div class="title">${esc(title)}</div><div class="sub">${esc(text)}</div></div></div>`;

  /* ---------- rendering ---------- */
  const VIEWS = { overview: viewOverview, install: viewInstall, config: viewConfig, releases: viewReleases, logs: viewLogs, safety: viewSafety };

  function render() {
    renderNav();
    const view = $('#view');
    const top = view.scrollTop;
    view.innerHTML = `<div class="page">${VIEWS[state.view]()}</div>`;
    view.scrollTop = top;
    const box = $('#console');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function go(id) { state.view = id; render(); $('#view').scrollTop = 0; }

  /* ---------- actions ---------- */
  async function loadManifest(quiet) {
    state.busy = true; render();
    try {
      const result = await api.fetchManifest();
      state.manifest = result.manifest;
      state.source = result.source;
      state.manifestError = result.error || null;
      state.download = { running: false, progress: {}, results: null, dir: null };
      log(result.source === 'remote' ? `Loaded version.json v${result.manifest.version} from GitHub Releases` : `No release feed (${result.error}); using the demo manifest`, result.source === 'remote' ? 'ok' : 'warn');
      if (!quiet) toast(result.source === 'remote' ? `Release ${result.manifest.version} found` : 'Demo manifest loaded');
    } catch (error) {
      log(`Manifest failed: ${error.message}`, 'err');
      toast('Could not read the manifest');
    }
    state.busy = false; render();
  }

  async function runDownload() {
    const dl = state.download;
    dl.running = true; dl.progress = {}; dl.results = null; render();
    log(`Downloading ${state.manifest.assets.length} files for v${state.manifest.version}`);
    try {
      const out = await api.downloadRelease(state.manifest);
      dl.results = out.results; dl.dir = out.dir;
      out.results.forEach((r) => log(`${r.name}: ${r.ok ? (r.cached ? 'cached, hash ok' : 'hash ok') : 'HASH MISMATCH'}${r.simulated ? ' (simulated)' : ''}`, r.ok ? 'ok' : 'err'));
      if (out.ok) { state.done.add(3); state.done.add(4); toast('Download verified'); }
      else toast('A file failed verification');
    } catch (error) {
      log(`Download failed: ${error.message}`, 'err');
      toast('Download failed');
    }
    dl.running = false; persist(); render();
  }

  async function runStep(stepName) {
    const s = D.steps[state.step];
    state.busy = true; render();
    try {
      const result = await api.runStep(stepName, { image: 'rosemary_xnu_boot.img', profile: state.profile, cmdline: cmdline() });
      if (stepName === 'inspect') state.inspect = result;
      log(`${s.title}: done (dry run)`, 'ok');
      state.done.add(state.step); persist();
    } catch (error) {
      log(`${s.title}: ${error.message}`, 'err'); toast('Step failed');
    }
    state.busy = false; render();
  }

  function enterStep(i) {
    state.step = i;
    if (D.steps[i].autoDone) state.done.add(i); // nothing to run: looking at the choice is enough
    persist(); render();
  }

  const actions = {
    nav: (el) => go(el.dataset.id),
    step: (el) => { const i = Number(el.dataset.i); if (stepUnlocked(i)) enterStep(i); },
    prev: () => { if (state.step > 0) enterStep(state.step - 1); },
    next: () => { if (state.step < D.steps.length - 1) enterStep(state.step + 1); },
    finish: () => { toast('Installation complete'); go('overview'); },
    check: (el) => {
      const i = Number(el.dataset.i);
      state.checks[i] = !state.checks[i];
      if (D.steps[0].checklist.every((_, k) => state.checks[k])) state.done.add(0); else state.done.delete(0);
      persist(); render();
    },
    run: (el) => runStep(el.dataset.step),
    confirm: () => { state.confirmed = !state.confirmed; render(); },
    mark: () => { state.done.add(state.step); persist(); render(); },
    refresh: () => loadManifest(false),
    download: () => runDownload(),
    folder: () => { if (state.download.dir) api.openFolder(state.download.dir); },
    profile: (el) => { applyPreset(el.dataset.id); render(); },
    preset: (el) => { applyPreset(el.dataset.id); render(); },
    arg: (el) => { state.args[el.dataset.key] = el.checked; persist(); render(); },
    range: (el) => { state.returnAfter = Number(el.value); persist(); const v = el.nextElementSibling; if (v) v.textContent = `${state.returnAfter} s`; },
    raw: () => { state.showRaw = !state.showRaw; render(); },
    open: (el) => { if (el.dataset.url) api.openExternal(el.dataset.url); },
    copy: (el) => { navigator.clipboard.writeText(el.dataset.text).then(() => toast('Copied'), () => toast('Copy failed')); },
    copylog: () => { navigator.clipboard.writeText(state.logs.map((l) => `${l.stamp} ${l.text}`).join('\n')).then(() => toast('Log copied')); },
    clearlog: () => { state.logs = []; render(); },
  };

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT') return;
    const handler = actions[el.dataset.action];
    if (handler) handler(el);
  });
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (el.tagName === 'INPUT' && el.dataset.action === 'arg') actions.arg(el);
  });
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (el.tagName === 'INPUT' && el.dataset.action === 'range') actions.range(el);
  });

  /* ---------- boot ---------- */
  api.onBackendLog((line) => log(line));
  api.onDownloadProgress((p) => {
    state.download.progress[p.name] = p;
    // Update bars in place so a fast download does not re-render the page hundreds of times.
    const rows = document.querySelectorAll('.step-card .group .row');
    const names = state.manifest ? state.manifest.assets.map((a) => a.name) : [];
    const index = names.indexOf(p.name);
    if (state.view === 'install' && D.steps[state.step].id === 'download' && rows[index]) {
      const pct = Math.min(100, Math.round((p.received / p.total) * 100));
      const bar = rows[index].querySelector('.progress > i');
      const label = rows[index].querySelector('.value');
      if (bar) bar.style.width = `${pct}%`;
      if (label) label.textContent = `${pct}%`;
    }
  });

  ensureArgs();
  api.info().then((info) => {
    state.info = info;
    if (info.platform === 'darwin') document.body.classList.add('vibrant');
    render();
    loadManifest(true);
  });
  render();
})();
