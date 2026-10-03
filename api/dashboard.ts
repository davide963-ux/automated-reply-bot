import { lazyHandler } from '../src/lib/boot';

/**
 * Vercel entry for the dashboard: open /api/dashboard (HTTP Basic, password = DASHBOARD_TOKEN).
 * Loaded lazily so a missing/invalid environment variable shows a readable page instead of a 500 crash.
 * Deps are created after authentication, so anonymous requests never touch the database.
 */
export default lazyHandler(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createDashboardHandler } = require('../src/dashboard/handler') as typeof import('../src/dashboard/handler');
  const { ensureAccount } = require('../src/db/accounts') as typeof import('../src/db/accounts');
  const { createDeps } = require('../src/engine/deps') as typeof import('../src/engine/deps');
  let cached: ReturnType<typeof createDeps> | undefined;
  return createDashboardHandler(async () => (cached ??= createDeps(await ensureAccount())));
});
