import { lazyHandler } from '../src/lib/boot';

/** OAuth redirect target. Register https://<app>/api/x-callback as the callback URL in the X developer portal. */
export default lazyHandler(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return (require('../src/dashboard/xconnect') as typeof import('../src/dashboard/xconnect')).handleXCallback;
});
