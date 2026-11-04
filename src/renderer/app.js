'use strict';

(function () {
  const D = window.DATA;
  const api = window.imediatek;

  const store = {
    get(key, fallback) {
      key = `v2.${key}`;
      try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(`v2.${key}`, JSON.stringify(value)); } catch (e) { /* private mode */ } },
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
    ipsw: { status: 'idle', received: 0, total: 0, speed: 0, eta: null, path: null, error: null, free: null, dir: null, skipped: false },
    live: store.get('live', false),
    ports: [],
    port: store.get('port', null),
    image: null,
    flash: { sent: 0, total: 0 },
    collect: null,
    busy: false,
    anim: null,
    pop: null,
    logs: [],
    showRaw: false,
    info: null,
  };

  /* ---------- helpers ---------- */
  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = () => window.HOSTS[state.info && state.info.platform] || window.HOSTS.linux;
  const fill = (text) => String(text).replace(/\{(computer|files|console|py)\}/g, (m, key) => host()[key]);
  const icon = (name) => `<i class="bi ${name}"></i>`;
  // An SVG tick centres exactly; a glyph from the icon font sits wherever its metrics put it.
  const CHECK = '<svg class="tick" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.4 8.1 6.4 11.1 12.6 4.9" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
  const dur = (s) => (s == null || !isFinite(s) ? '' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const $ = (selector) => document.querySelector(selector);

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 2000);
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
    store.set('live', state.live);
    store.set('port', state.port);
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

  const rangePct = (v) => Math.round(((v - 60) / (900 - 60)) * 100);
  const IPSW_STEP = D.steps.findIndex((st) => st.id === 'ipsw');
  const stepUnlocked = (i) => i === 0 || state.done.has(i - 1) || state.done.has(i);

  /* ---------- views ---------- */
  const NAV = [
    ['overview', 'bi-house-door-fill', 'Overview', 't-blue'],
    ['install', 'bi-download', 'Install', 't-green'],
    ['config', 'bi-sliders2', 'Configuration', 't-gray'],
    ['releases', 'bi-box-seam-fill', 'Releases', 't-orange'],
    ['logs', 'bi-terminal-fill', 'Logs', 't-purple'],
    ['safety', 'bi-shield-lock-fill', 'Safety', 't-red'],
  ];

  function renderNav() {
    $('#nav').innerHTML = NAV.map(([id, ic, label, tile]) => `
      <button class="nav-item ${state.view === id ? 'active' : ''}" data-action="nav" data-id="${id}">
        <span class="nav-ic ${tile}">${icon(ic)}</span><span>${label}</span>
        ${id === 'install' ? `<span class="count">${state.done.size}/${D.steps.length}</span>` : ''}
      </button>`).join('');
    const live = state.source === 'remote';
    $('#sidebarFoot').innerHTML = `
      <div class="pill-live"><span class="dot ${live ? 'ok' : ''}"></span>${live ? 'Release feed online' : 'Demo manifest'}</div>
      <div style="margin-top:4px">v${esc(state.info ? state.info.version : '0.1.0')} · ${state.live ? 'live mode' : 'dry run'}</div>`;
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
    const last = state.step === D.steps.length - 1;
    return `
      <div class="page-head"><h1>Install</h1>
        <div class="segmented" role="group" aria-label="Mode"><button class="${state.live ? '' : 'on'}" data-action="mode" data-live="0">Dry run</button><button class="${state.live ? 'on' : ''}" data-action="mode" data-live="1">Live</button></div>
        ${state.live ? `<span class="badge red">${icon('bi-lightning-charge-fill')} Live · writes boot_a only</span>` : `<span class="badge orange">${icon('bi-exclamation-triangle-fill')} Dry run · nothing is written</span>`}
      </div>
      <div class="stepper" role="list">
        ${D.steps.map((st, i) => `
          <button class="sdot ${i === state.step ? 'current' : ''} ${state.done.has(i) ? 'done' : ''}" role="listitem" data-action="step" data-i="${i}" title="${esc(st.title)}" ${stepUnlocked(i) ? '' : 'disabled'}>${state.done.has(i) ? CHECK : i + 1}</button>
          ${i < D.steps.length - 1 ? `<span class="sline ${state.done.has(i) ? 'done' : ''}"></span>` : ''}`).join('')}
      </div>
      <div class="step-card">
        <div class="step-head">
          <div class="kicker">Step ${state.step + 1} of ${D.steps.length}</div>
          <h2>${icon(s.icon)}<span>${esc(s.title)}</span></h2>
          <p>${esc(fill(s.text))}</p>
        </div>
        <div class="step-body">${stepBody(s)}</div>
        <div class="step-actions">
          <button class="btn secondary" data-action="prev" ${state.step === 0 ? 'disabled' : ''}>${icon('bi-chevron-left')} Back</button>
          <span class="spacer"></span>
          ${last
            ? `<button class="btn" data-action="finish" ${state.done.has(state.step) ? '' : 'disabled'}>${icon('bi-check2-circle')} Finish</button>`
            : `<button class="btn" data-action="next" ${state.done.has(state.step) ? '' : 'disabled'}>Continue ${icon('bi-chevron-right')}</button>`}
        </div>
      </div>`;
  }

  const cmdLine = (raw) => { const c = fill(raw); return `<div class="cmd"><code>${esc(c)}</code><button data-action="copy" data-text="${esc(c)}" title="Copy">${icon('bi-clipboard')}</button></div>`; };
  const cmdBox = (c) => `<details class="disclose"><summary>${icon('bi-chevron-right')}<span>Show command</span></summary>${cmdLine(c)}</details>`;

  function stepBody(s) {
    switch (s.id) {
      case 'prepare': return prepareBody(s);
      case 'download': return downloadBody();
      case 'verify': return verifyBody();
      case 'ipsw': return ipswBody();
      case 'profile': return profileBody();
      case 'flash': return flashBody(s);
      case 'observe': return observeBody(s);
      case 'inspect': return `${cmdBox(s.command)}${inspectResult()}${runButton(s)}`;
      case 'connect': return connectBody(s);
      case 'collect': return collectBody(s);
      default: return `${s.command ? cmdBox(s.command) : ''}${runButton(s)}`;
    }
  }

  const runButton = (s, disabled) => `
    <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
      <button class="btn" data-action="run" data-step="${s.run}" ${state.busy || disabled ? 'disabled' : ''}>${icon(s.runIcon)} ${s.runLabel}</button>
      ${state.done.has(state.step) ? `<span class="badge green">${CHECK} Done</span>` : ''}
      ${state.busy ? '<span class="badge">Working…</span>' : ''}
    </div>`;

  function prepareBody(s) {
    return `<ul class="checklist">${s.checklist.map((text, i) => `
      <li><button class="check ${state.checks[i] ? 'on' : ''}" data-pop="check-${i}" data-action="check" data-i="${i}" aria-pressed="${!!state.checks[i]}">${CHECK}</button><span>${esc(fill(text))}</span></li>`).join('')}</ul>`;
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
        ${dl.results && dl.dir ? `<button class="btn secondary" data-action="folder">${icon('bi-folder2-open')} Show in ${host().files}</button>` : ''}
        ${state.done.has(state.step) ? `<span class="badge green">${CHECK} Done</span>` : ''}
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

  function ipswBody() {
    const info = state.manifest && state.manifest.ipsw;
    if (!info) return `<div class="callout">${icon('bi-exclamation-triangle-fill')}<div>This release does not list an iOS firmware. Load a release first.</div></div>`;
    const ip = state.ipsw;
    const pct = ip.total ? Math.min(100, Math.round((ip.received / ip.total) * 100)) : 0;
    const low = ip.free != null && ip.free < info.size * 2.2;
    const busy = ip.status === 'downloading' || ip.status === 'verifying';
    let main;
    if (ip.status === 'ok') {
      main = `<div class="row"><span class="icon-tile t-green">${icon('bi-patch-check-fill')}</span><div class="grow"><div class="title">Firmware verified</div><div class="sub mono" style="word-break:break-all">${esc(ip.path || '')}</div></div><span class="badge green">SHA-256 match</span></div>`;
    } else if (ip.skipped) {
      main = `<div class="row"><span class="icon-tile t-gray">${icon('bi-skip-forward-fill')}</span><div class="grow"><div class="title">Skipped</div><div class="sub">The iOS volume is already on the phone.</div></div></div>`;
    } else {
      const label = ip.status === 'verifying' ? 'Verifying SHA-256…' : ip.status === 'downloading' ? 'Downloading from Apple' : ip.status === 'paused' ? 'Paused' : ip.received ? 'Partial download found' : 'Not downloaded yet';
      const detail = ip.received ? `${gb(ip.received)} of ${gb(info.size)}${ip.status === 'downloading' && ip.speed ? ` · ${(ip.speed / 1e6).toFixed(1)} MB/s · ${dur(ip.eta)} left` : ''}` : `${gb(info.size)} download`;
      main = `<div class="row"><div class="grow"><div class="title">${label}</div><div class="sub" id="ipswDetail">${esc(detail)}</div>
        <div class="progress ${ip.status === 'verifying' ? 'ok' : ''}" style="margin-top:8px"><i id="ipswBar" style="width:${pct}%"></i></div></div><div class="value" id="ipswPct">${pct}%</div></div>`;
    }
    return `
      <div class="group">
        <div class="row"><span class="icon-tile t-blue">${icon('bi-phone-fill')}</span><div class="grow"><div class="title">iOS ${esc(info.version)} (${esc(info.build)})</div><div class="sub">${esc(info.device)} · ${gb(info.size)}</div></div><span class="badge">Official</span></div>
        <div class="row"><span class="icon-tile t-gray">${icon('bi-cloud-fill')}</span><div class="grow"><div class="title">Source</div><div class="sub">${esc(info.source || 'Apple CDN')}</div></div></div>
        <div class="row"><span class="icon-tile t-gray">${icon('bi-hash')}</span><div class="grow"><div class="title">SHA-256</div><div class="hash">${esc(info.sha256)}</div></div></div>
        ${ip.free != null ? `<div class="row"><span class="icon-tile ${low ? 't-orange' : 't-gray'}">${icon('bi-hdd-fill')}</span><div class="grow"><div class="title">Free space</div><div class="sub">${gb(ip.free)} available · about ${gb(info.size * 2.2)} recommended</div></div>${low ? '<span class="badge orange">Low</span>' : ''}</div>` : ''}
        ${main}
      </div>
      ${ip.error ? `<div class="callout red" style="margin-top:12px">${icon('bi-x-octagon-fill')}<div>${esc(ip.error)}</div></div>` : ''}
      <div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${ip.status === 'downloading'
          ? `<button class="btn secondary" data-action="ipsw-pause">${icon('bi-pause-fill')} Pause</button>`
          : ip.status === 'ok' || ip.skipped ? `<button class="btn secondary" data-action="ipsw-show">${icon('bi-folder2-open')} Show in ${host().files}</button>`
          : `<button class="btn" data-action="ipsw-download" ${busy ? 'disabled' : ''}>${icon('bi-cloud-arrow-down-fill')} ${ip.received ? 'Resume download' : 'Download from Apple'}</button>`}
        ${ip.status !== 'ok' && !ip.skipped ? `<button class="btn secondary" data-action="ipsw-pick" ${busy ? 'disabled' : ''}>${icon('bi-file-earmark-arrow-up')} I already have it…</button>
        <button class="btn plain" data-action="ipsw-skip" ${busy ? 'disabled' : ''}>My phone already has iOS</button>` : ''}
      </div>
      <p class="footnote">The firmware is downloaded directly from Apple's servers to this ${host().computer}. iMediaTek does not host or redistribute it, and using it is subject to Apple's license terms. The download can be paused and resumed.</p>`;
  }

  function profileBody() {
    ensureArgs();
    return `<div class="group" style="margin-top:6px">${D.presets.map((p) => `
      <div class="row" data-action="profile" data-id="${p.id}" style="cursor:default">
        <span class="icon-tile ${p.tile}">${icon(p.icon)}</span>
        <div class="grow"><div class="title">${p.title}</div><div class="sub">${p.subtitle}</div></div>
        ${state.profile === p.id ? `<span class="badge blue">${CHECK} Selected</span>` : ''}
      </div>`).join('')}</div>
      <div class="section-label">Boot arguments</div>${cmdLine(cmdline())}
      <p class="footnote">Fine-tune them in Configuration. The same boot image is flashed either way.</p>`;
  }

  function connectBody(s) {
    const portPicker = state.live ? `
      <div class="group" style="margin-top:10px">
        <div class="row"><span class="icon-tile t-teal">${icon('bi-usb-symbol')}</span>
          <div class="grow"><div class="title">Console port</div><div class="sub">The phone's Arch console (USB serial). Plug the phone in, then refresh.</div></div>
          <select class="field" data-action="port">${state.ports.length ? state.ports.map((p) => `<option value="${esc(p.path)}" ${p.path === state.port ? 'selected' : ''}>${esc(p.path)}${p.likely ? '  (likely the phone)' : ''}</option>`).join('') : '<option value="">No serial ports found</option>'}</select>
          <button class="btn secondary small" data-action="ports">${icon('bi-arrow-clockwise')} Refresh</button></div>
      </div>` : '';
    return `${s.command ? cmdBox(s.command) : ''}${portPicker}${runButton(s, state.live && !state.port)}`;
  }

  function collectBody(s) {
    const c = state.collect;
    return `${cmdBox(s.command)}
      ${c ? `<div class="group" style="margin-top:12px"><div class="row"><span class="icon-tile t-green">${icon('bi-journal-text')}</span><div class="grow"><div class="title">${c.bytes} bytes saved</div><div class="sub mono" style="word-break:break-all">${esc(c.path)}</div></div><button class="btn secondary small" data-action="log-show">${icon('bi-folder2-open')} Show</button></div></div>
        <pre class="json" style="margin-top:10px;max-height:160px">${esc(c.tail)}</pre>` : ''}
      ${runButton(s, state.live && !state.port)}
      ${state.live ? '<p class="footnote">Waits up to about five minutes for the phone to return to Arch, then reads the log.</p>' : ''}`;
  }

  function imageRow() {
    const im = state.image;
    if (!im) return `<div class="row"><span class="icon-tile t-gray">${icon('bi-file-earmark-binary')}</span><div class="grow"><div class="title">No boot image chosen</div><div class="sub">${state.live ? 'Download a release or choose a file.' : 'Dry run uses rosemary_xnu_boot.img.'}</div></div><button class="btn secondary small" data-action="image-pick">${icon('bi-folder2-open')} Choose…</button></div>`;
    return `<div class="row"><span class="icon-tile t-blue">${icon('bi-file-earmark-binary-fill')}</span><div class="grow"><div class="title">${esc(im.name)}</div>
      <div class="sub">${bytes(im.size)} · ${im.source === 'release' ? `release v${esc(state.manifest ? state.manifest.version : '')}, hashes match` : 'local file, no release hash to compare'}</div><div class="hash">md5 ${esc(im.md5)}</div></div>
      ${im.androidHeader ? '' : '<span class="badge red">Not an Android boot image</span>'}<button class="btn secondary small" data-action="image-pick">Change…</button></div>`;
  }

  function flashBody(s) {
    return `
      <div class="group" style="margin-top:6px">
        ${imageRow()}
        <div class="row"><span class="icon-tile t-blue">${icon('bi-play-circle-fill')}</span><div class="grow"><div class="title">Destination</div><div class="sub mono">/dev/sdc36 (boot_a)</div></div><span class="badge blue">write</span></div>
        <div class="row"><span class="icon-tile t-red">${icon('bi-lock-fill')}</span><div class="grow"><div class="title">Never touched</div><div class="sub mono">/dev/sdc56 (boot_b) · /dev/sdc61 (userdata)</div></div><span class="badge red">protected</span></div>
      </div>
      ${cmdBox(s.command)}
      <ul class="checklist"><li><button class="check ${state.confirmed ? 'on' : ''}" data-pop="confirm" data-action="confirm" aria-pressed="${state.confirmed}">${CHECK}</button><span>I checked that the destination is boot_a and I have the Arch rescue system on boot_b.</span></li></ul>
      ${state.flash.total && state.busy ? `<div class="progress" style="margin-top:12px"><i id="flashBar" style="width:${Math.round((state.flash.sent / state.flash.total) * 100)}%"></i></div><p class="footnote" id="flashText">Writing ${Math.round(state.flash.sent / 1048576)} of ${Math.round(state.flash.total / 1048576)} MB</p>` : ''}
      ${runButton(s, !state.confirmed || (state.live ? !state.image : !state.download.results))}`;
  }

  function observeBody(s) {
    return `<ul class="timeline">${s.timeline.map(([t, text]) => `<li><span class="t">${t}</span><span>${esc(text)}</span></li>`).join('')}</ul>
      <div class="callout blue" style="margin-top:12px">${icon('bi-hand-index-thumb-fill')}<div>${esc(s.extra)}</div></div>
      <div style="margin-top:16px;display:flex;gap:10px;align-items:center">
        <button class="btn" data-action="mark" ${state.done.has(state.step) ? 'disabled' : ''}>${icon('bi-check2')} The phone is back in Arch</button>
        ${state.done.has(state.step) ? `<span class="badge green">${CHECK} Done</span>` : ''}
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
          <input type="range" min="60" max="900" step="30" value="${state.returnAfter}" data-action="range" style="--p:${rangePct(state.returnAfter)}%"><span class="value" style="width:56px">${state.returnAfter} s</span></div>
        <div class="row"><div class="grow"><div class="title">Boot method</div><div class="sub">One-shot: slot_mgr.py a 1 0, then reboot</div></div><span class="badge green">Watchdog fallback to slot B</span></div>
      </div>

      <div class="section-label">Boot arguments</div>
      <div class="group args">${D.bootArgs.map((a) => `
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
      ${cmdLine("{py} phone_sh.py 'mountpoint -q /sys/fs/pstore || mount -t pstore pstore /sys/fs/pstore; cat /sys/fs/pstore/console-ramoops-0' 30")}`;
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
    const bodyTop = (view.querySelector('.step-body') || {}).scrollTop || 0;
    view.classList.toggle('fill', state.view === 'install');
    view.innerHTML = `<div class="page">${VIEWS[state.view]()}</div>`;
    view.scrollTop = top;
    const body = view.querySelector('.step-body');
    if (body && state.anim !== 'step' && state.anim !== 'page') body.scrollTop = bodyTop;
    // One-shot motion: a render caused by navigation fades in; a plain re-render stays still.
    if (state.anim) {
      const target = state.anim === 'step' ? view.querySelector('.step-card') : view.querySelector('.page');
      if (target) target.classList.add('enter');
      state.anim = null;
    }
    if (state.pop) {
      const el = view.querySelector(`[data-pop="${state.pop}"]`);
      if (el) el.classList.add('pop');
      state.pop = null;
    }
    const box = $('#console');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function go(id) { state.view = id; state.anim = 'page'; render(); $('#view').scrollTop = 0; }

  /* ---------- actions ---------- */
  async function loadManifest(quiet) {
    state.busy = true; render();
    try {
      const result = await api.fetchManifest();
      state.manifest = result.manifest;
      state.source = result.source;
      state.manifestError = result.error || null;
      state.download = { running: false, progress: {}, results: null, dir: null };
      refreshIpsw();
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
      if (out.ok) { state.done.add(3); state.done.add(4); toast('Download verified'); await useReleaseImage(); }
      else toast('A file failed verification');
    } catch (error) {
      log(`Download failed: ${error.message}`, 'err');
      toast('Download failed');
    }
    dl.running = false; persist(); render();
  }

  const ipswInfo = () => state.manifest && state.manifest.ipsw;

  async function refreshIpsw() {
    const info = ipswInfo();
    if (!info) return;
    try {
      const st = await api.ipswStatus(info);
      const ip = state.ipsw;
      ip.free = st.free; ip.dir = st.dir; ip.total = info.size;
      if (st.ready) { ip.status = 'ok'; ip.path = st.path; ip.received = info.size; state.done.add(IPSW_STEP); }
      else if (st.partial) { ip.status = 'paused'; ip.received = st.partial; }
      persist(); render();
    } catch (error) { log(`iOS firmware status: ${error.message}`, 'err'); }
  }

  async function ipswDownload() {
    const info = ipswInfo();
    const ip = state.ipsw;
    ip.status = 'downloading'; ip.error = null; ip.total = info.size; render();
    log(`Downloading ${info.file} from Apple (${gb(info.size)})`);
    try {
      const result = await api.ipswDownload(info);
      if (result.ok) {
        ip.status = 'ok'; ip.path = result.path; ip.received = info.size; state.done.add(IPSW_STEP);
        log('iOS firmware downloaded and verified (SHA-256)', 'ok'); toast('iOS firmware verified');
      } else if (result.paused) {
        ip.status = 'paused'; ip.received = result.received || ip.received; log('iOS download paused');
      } else {
        ip.status = 'error'; ip.error = result.error || 'The download failed'; log(`iOS download: ${ip.error}`, 'err');
        if (!/SHA-256/.test(ip.error)) ip.status = 'paused';
        if (/SHA-256/.test(ip.error)) ip.received = 0;
      }
    } catch (error) {
      ip.status = ip.received ? 'paused' : 'idle'; ip.error = error.message; log(`iOS download failed: ${error.message}`, 'err');
    }
    persist(); render();
  }

  async function ipswPick() {
    const info = ipswInfo();
    const ip = state.ipsw;
    ip.status = 'verifying'; ip.error = null; ip.total = info.size; ip.received = 0; render();
    try {
      const result = await api.ipswPick(info);
      if (result.canceled) { ip.status = ip.received ? 'paused' : 'idle'; }
      else if (result.ok) { ip.status = 'ok'; ip.path = result.path; ip.received = info.size; state.done.add(IPSW_STEP); log(`Using ${result.path} (SHA-256 verified)`, 'ok'); toast('Firmware verified'); }
      else { ip.status = 'idle'; ip.received = 0; ip.error = `That file is not the expected firmware: ${result.error}`; log(ip.error, 'err'); }
    } catch (error) { ip.status = 'idle'; ip.error = error.message; }
    persist(); render();
  }

  async function runStep(stepName) {
    const s = D.steps[state.step];
    if (state.live && ['flash', 'arm'].includes(stepName) && !state.image) { toast('Choose a boot image first'); return; }
    state.busy = true; state.flash = { sent: 0, total: 0 }; render();
    try {
      const expected = state.image && state.image.source === 'release' ? state.image.expected : null;
      const result = await api.runStep(stepName, {
        live: state.live, port: state.port, console: fill('{console}'),
        imagePath: state.image ? state.image.path : null, expected,
        image: 'rosemary_xnu_boot.img', profile: state.profile, cmdline: cmdline(), waitSeconds: 420,
      });
      if (stepName === 'inspect') state.inspect = result;
      if (stepName === 'collect' && state.live) state.collect = result;
      if (result && result.canceled) { log(`${s.title}: cancelled, nothing was written`, 'warn'); toast('Cancelled'); }
      else {
        log(`${s.title}: done${state.live ? '' : ' (dry run)'}`, 'ok');
        state.done.add(state.step); persist();
      }
    } catch (error) {
      log(`${s.title}: ${error.message}`, 'err'); toast('Step failed');
    }
    state.busy = false; render();
  }

  async function refreshPorts() {
    try {
      state.ports = await api.listPorts();
      if (!state.port || !state.ports.some((p) => p.path === state.port)) state.port = (state.ports.find((p) => p.likely) || state.ports[0] || {}).path || null;
    } catch (error) { log(`Could not list serial ports: ${error.message}`, 'err'); }
    render();
  }

  async function pickImage() {
    const picked = await api.pickImage();
    if (!picked || picked.canceled) return;
    state.image = { path: picked.path, name: picked.path.split(/[\\/]/).pop(), size: picked.size, md5: picked.md5, sha256: picked.sha256, androidHeader: picked.androidHeader, source: 'local' };
    log(`Boot image: ${state.image.name}, ${picked.size} bytes, md5 ${picked.md5}${picked.androidHeader ? '' : ' (NOT an Android boot image)'}`, picked.androidHeader ? '' : 'warn');
    render();
  }

  // The image that came with the release (already hash-checked by the downloader).
  async function useReleaseImage() {
    const asset = state.manifest && state.manifest.assets.find((a) => a.name === 'rosemary_xnu_boot.img');
    const result = state.download.results && state.download.results.find((r) => r.name === 'rosemary_xnu_boot.img' && r.path);
    if (!asset || !result) return;
    const info = await api.inspectImage(result.path);
    state.image = { path: info.path, name: asset.name, size: info.size, md5: info.md5, sha256: info.sha256, androidHeader: info.androidHeader, source: 'release', expected: { sha256: asset.sha256, md5: asset.md5 } };
    render();
  }

  function enterStep(i) {
    state.step = i;
    if (D.steps[i].autoDone) state.done.add(i); // nothing to run: looking at the choice is enough
    state.anim = 'step';
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
      if (state.checks[i]) state.pop = `check-${i}`;
      if (D.steps[0].checklist.every((_, k) => state.checks[k])) state.done.add(0); else state.done.delete(0);
      persist(); render();
    },
    run: (el) => runStep(el.dataset.step),
    confirm: () => { state.confirmed = !state.confirmed; if (state.confirmed) state.pop = 'confirm'; render(); },
    mark: () => { state.done.add(state.step); persist(); render(); },
    refresh: () => loadManifest(false),
    mode: (el) => {
      const live = el.dataset.live === '1';
      if (live === state.live) return;
      state.live = live;
      // What a dry run "did" proves nothing about a real phone: device steps start over.
      D.steps.forEach((st, i) => { if (st.run || st.id === 'observe') state.done.delete(i); });
      state.inspect = null; state.collect = null; state.confirmed = false;
      if (live) refreshPorts();
      persist(); render();
    },
    ports: () => refreshPorts(),
    'image-pick': () => pickImage(),
    'log-show': () => { if (state.collect) api.openFolder(state.collect.path); },
    'ipsw-download': () => ipswDownload(),
    'ipsw-pause': () => { api.ipswPause(); },
    'ipsw-pick': () => ipswPick(),
    'ipsw-skip': () => { state.ipsw.skipped = true; state.done.add(state.step); toast('Skipped: the phone already has iOS'); persist(); render(); },
    'ipsw-show': () => { if (state.ipsw.path) api.openFolder(state.ipsw.path); },
    download: () => runDownload(),
    folder: () => { if (state.download.dir) api.openFolder(state.download.dir); },
    profile: (el) => { applyPreset(el.dataset.id); render(); },
    preset: (el) => { applyPreset(el.dataset.id); render(); },
    arg: (el) => {
      state.args[el.dataset.key] = el.checked; persist();
      const line = document.querySelector('.cmd code');
      if (line) { line.textContent = cmdline(); line.nextElementSibling.dataset.text = cmdline(); }
    },
    range: (el) => { state.returnAfter = Number(el.value); persist(); el.style.setProperty('--p', `${rangePct(state.returnAfter)}%`); const v = el.nextElementSibling; if (v) v.textContent = `${state.returnAfter} s`; },
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
    if (el.tagName === 'SELECT' && el.dataset.action === 'port') { state.port = el.value || null; persist(); return; }
    if (el.tagName === 'INPUT' && el.dataset.action === 'arg') actions.arg(el);
  });
  document.addEventListener('input', (event) => {
    const el = event.target;
    if (el.tagName === 'INPUT' && el.dataset.action === 'range') actions.range(el);
  });

  /* ---------- boot ---------- */
  api.onBackendLog((line) => log(line));
  api.onBackendProgress((p) => {
    if (p.phase !== 'flash') return;
    state.flash = { sent: p.sent, total: p.total };
    const bar = $('#flashBar'); const text = $('#flashText');
    if (bar) bar.style.width = `${Math.round((p.sent / p.total) * 100)}%`;
    if (text) text.textContent = `Writing ${Math.round(p.sent / 1048576)} of ${Math.round(p.total / 1048576)} MB`;
    else if (state.busy) render();
  });
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

  api.onIpswProgress((p) => {
    const ip = state.ipsw;
    ip.received = p.received; ip.total = p.total; ip.speed = p.speed || 0; ip.eta = p.eta;
    if (p.phase === 'verify' && ip.status !== 'verifying') { ip.status = 'verifying'; render(); return; }
    if (state.view !== 'install' || D.steps[state.step].id !== 'ipsw') return;
    const info = ipswInfo();
    const pct = Math.min(100, Math.round((p.received / p.total) * 100));
    const bar = $('#ipswBar'); const label = $('#ipswPct'); const detail = $('#ipswDetail');
    if (bar) bar.style.width = `${pct}%`;
    if (label) label.textContent = `${pct}%`;
    if (detail && info) detail.textContent = p.phase === 'verify' ? `Checking the file… ${pct}%` : `${gb(p.received)} of ${gb(info.size)}${p.speed ? ` · ${(p.speed / 1e6).toFixed(1)} MB/s · ${dur(p.eta)} left` : ''}`;
  });

  ensureArgs();
  api.info().then((info) => {
    state.info = info;
    if (info.platform === 'darwin') document.body.classList.add('vibrant');
    render();
    loadManifest(true);
    if (state.live) refreshPorts();
  });
  render();
})();
