import { ensureAccount } from '../src/db/accounts';
import { createDashboardHandler } from '../src/dashboard/handler';
import { createDeps, type Deps } from '../src/engine/deps';

/**
 * Vercel entry for the dashboard: open /api/dashboard (HTTP Basic, password = DASHBOARD_TOKEN).
 * Deps are created lazily AFTER authentication, so anonymous requests never touch the database.
 */
let cached: Deps | undefined;

export default createDashboardHandler(async () => (cached ??= createDeps(await ensureAccount())));
