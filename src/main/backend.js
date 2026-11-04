'use strict';

const stub = require('./backend-stub');
const live = require('./device/live');

/** Routes a step to the dry-run stub or to the live device backend. */
async function run(step, params, log, ctx) {
  params = params || {};
  if (!params.live) return stub.run(step, params, log);
  const handler = live.steps[step];
  if (!handler) throw new Error(`unknown step: ${step}`);
  log(`[live] ${step}`);
  return handler(params, log, ctx);
}

module.exports = { run, listPorts: live.listPorts, inspectImage: live.inspectImage, disconnect: live.disconnect };
