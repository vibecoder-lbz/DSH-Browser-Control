import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try { return require('playwright-core'); }
  catch (error) {
    // An in-process DSH upgrade can retain an incomplete CommonJS bundle export
    // after the old plugin is removed. Refresh only these exact dependency entries.
    if (!(error instanceof TypeError) || !/reading ['"]playwright['"]/u.test(error.message)) throw error;
    delete require.cache[require.resolve('playwright-core/lib/coreBundle')];
    delete require.cache[require.resolve('playwright-core')];
    return require('playwright-core');
  }
}

export const { chromium } = loadPlaywright();
