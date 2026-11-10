import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The README says that the end-to-end tests fail when any page contacts another
 * origin. That holds because every test is given a watched page by the `test` of
 * e2e/helpers.ts. A spec file that takes `test` from Playwright itself runs without
 * the check, silently, so that is ruled out here.
 */
const E2E = join(__dirname, '..', 'e2e');
const specs = readdirSync(E2E).filter((name) => name.endsWith('.spec.ts'));
const read = (name: string) => readFileSync(join(E2E, name), 'utf8');

describe('the end-to-end tests', () => {
  it('all use the watched test of the helpers, never Playwright’s own', () => {
    expect(specs.length).toBeGreaterThan(0);
    for (const name of specs) {
      const source = read(name);
      const fromPlaywright = source.match(/import\s*\{([^}]*)\}\s*from '@playwright\/test'/)?.[1] ?? '';
      expect(fromPlaywright.split(',').map((part) => part.trim()), name).not.toContain('test');
      expect(source, name).toMatch(/import\s*\{[^}]*\btest\b[^}]*\}\s*from '\.\/helpers'/);
    }
  });

  it('get a page that is watched without being asked, and fail when it reported anything', () => {
    const helpers = read('helpers.ts');
    expect(helpers).toMatch(/export const test = base\.extend/);
    expect(helpers).toMatch(/\{ auto: true \}/);
    expect(helpers).toMatch(/const problems = watch\(page\);\s*await use\(problems\);\s*expect\(problems[^)]*\)\.toEqual\(\[\]\);/);
    // What is watched for: script errors, failed requests, and requests to another origin.
    expect(helpers).toContain("page.on('pageerror'");
    expect(helpers).toContain('request to another origin');
    expect(helpers).toContain('response.status() >= 400');
  });

  it('say in the docs only what the helpers do', () => {
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    const architecture = readFileSync(join(__dirname, '..', 'docs', 'ARCHITECTURE.md'), 'utf8');
    expect(readme).toContain('The end-to-end tests fail if any page contacts another');
    expect(architecture.replace(/\s+/g, ' ')).toContain('every test fails on a script error, a failed request, or any request to another origin');
  });
});
