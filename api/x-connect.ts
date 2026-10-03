import { lazyHandler } from '../src/lib/boot';

/** Start connecting the X account: open https://<app>/api/x-connect (dashboard password required). */
export default lazyHandler(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return (require('../src/dashboard/xconnect') as typeof import('../src/dashboard/xconnect')).handleXConnect;
});
