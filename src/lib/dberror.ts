/**
 * Turns low-level database errors into a fixed set of plain-language hints.
 * Returns undefined for anything else, so internal details are never shown to the browser.
 * (Only constant strings are returned: nothing from the error message or the connection string.)
 */
export function describeDbError(err: unknown): string | undefined {
  const e = err as { code?: string; message?: string; errors?: Array<{ code?: string }> };
  const code = e?.code ?? e?.errors?.[0]?.code;
  const msg = String(e?.message ?? '');

  if (code === '28P01' || code === '28000') return 'The database rejected the login: check the user and password in DATABASE_URL.';
  if (code === '3D000') return 'The database named in DATABASE_URL does not exist.';
  if (/SSL|TLS|self[- ]signed|certificate/i.test(msg)) return 'Database SSL problem: set DATABASE_SSL=true (or false if your database has no SSL), then redeploy.';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || /timeout exceeded when trying to connect|Connection terminated/i.test(msg)) {
    return 'Cannot reach the database server: check DATABASE_URL (host and port) and that the database is running.';
  }
  return undefined;
}
