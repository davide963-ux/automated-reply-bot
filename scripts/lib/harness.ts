let passed = 0;
let failed = 0;

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

export async function expectThrows(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function finish(label: string): never {
  console.log(`\n${label}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
