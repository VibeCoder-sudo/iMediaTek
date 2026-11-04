'use strict';

// Development helper: IMEDIATEK_SHOTS=<dir> npx electron . renders every screen to a PNG and quits.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = function shots(getWindow, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const run = async () => {
    const win = getWindow();
    const js = (code) => win.webContents.executeJavaScript(code);
    const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const shot = async (name) => {
      await sleep(500);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
    };
    await sleep(3500);
    await js('localStorage.clear()');
    win.webContents.reload();
    await sleep(3000);
    await shot('01-overview');
    await click('[data-action=nav][data-id=install]');
    await shot('02-install-prepare');
    for (let i = 0; i < 6; i += 1) await click(`[data-action=check][data-i="${i}"]`);
    await click('[data-action=next]');
    await click('[data-action=mode][data-live="1"]'); await sleep(700); await shot('03a-install-live-connect');
    await click('[data-action=mode][data-live="0"]'); await sleep(300);
    await click('[data-action=run]'); await sleep(1800); await shot('03-install-connect');
    await click('[data-action=next]');
    await click('[data-action=run]'); await sleep(2000); await shot('04-install-slots');
    await click('[data-action=next]'); await sleep(600);
    await click('[data-action=download]'); await sleep(6500); await shot('05-install-download');
    await click('[data-action=next]'); await shot('06-install-verify');
    await click('[data-action=next]'); await shot('06b-install-ipsw');
    await click('[data-action=ipsw-skip]'); await click('[data-action=next]'); await shot('07-install-kernel');
    await click('[data-action=next]'); await click('[data-action=confirm]'); await shot('08-install-flash');
    await click('.step-card summary'); await shot('08b-install-flash-command');
    win.setSize(900, 620); await sleep(500); await shot('08c-install-short');
    win.setSize(1120, 760); await sleep(400);
    for (const id of ['config', 'releases', 'logs', 'safety']) {
      await click(`[data-action=nav][data-id=${id}]`);
      await shot(`09-${id}`);
    }
    app.quit();
  };
  run().catch((error) => { console.error(error); app.quit(); });
};
