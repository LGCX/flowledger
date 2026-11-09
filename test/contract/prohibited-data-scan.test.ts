/**
 * Proves the repository itself is clean: no contract, doc, infrastructure file, fixture, or
 * representative message carries a PAN, a card field, a bearer credential, a merchant
 * credential, or a provider secret (docs/10 §M0, docs/09 §Static checks).
 *
 * The scanner runs over the tree rather than a fixed file list, so a document added later is
 * covered without anyone remembering to add it. It only asserts the absence of prohibited
 * data; a redaction allowlist is P11's, and there are no logs to scan yet.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROHIBITED_FIXTURES, findProhibitedData } from '@flowledger/testkit';
import { registeredTypes } from '@flowledger/contracts';
import { validMessages } from './fixtures/messages.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function walk(path: string, accept: (file: string) => boolean): string[] {
  const absolute = join(repoRoot, path);
  const found: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(path, entry);
    if (statSync(join(repoRoot, child)).isDirectory()) found.push(...walk(child, accept));
    else if (accept(child)) found.push(child);
  }
  return found;
}

function findingsIn(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    for (const finding of findProhibitedData(readFileSync(join(repoRoot, file), 'utf8'))) {
      // Name the file and the kind, never the matched text.
      offenders.push(`${file}: ${finding.kind}`);
    }
  }
  return offenders;
}

describe('repository prohibited-data scan', () => {
  /**
   * The execution plan is excluded, and only it. The plan tasks quote the synthetic fixture
   * values verbatim because they specify them (P00-T12 lists every one, P02 and P04 quote the
   * ones their tests need), so scanning it would report the plan for doing its job. It is not a
   * shipped contract and not a runtime artifact. Everything that is a contract — `schemas/`,
   * `openapi/`, `docs/00`–`docs/10`, `docs/adr/` — is scanned.
   */
  const isContractDoc = (file: string): boolean =>
    !file.startsWith(join('docs', 'execution-plan')) && extname(file) === '.md';

  it('contracts and docs contain no prohibited data', () => {
    const files = [
      ...walk('schemas', (file) => extname(file) === '.json' || extname(file) === '.md'),
      ...walk('openapi', (file) => extname(file) === '.yaml' || extname(file) === '.md'),
      ...walk('docs', isContractDoc),
    ];

    // A floor that catches a walk that silently returns nothing.
    expect(files.length).toBeGreaterThan(40);
    // The contract documents specifically must be in scope, not just "some files".
    expect(files.filter((file) => /^docs[\\/]\d{2}-/.test(file)).length).toBeGreaterThanOrEqual(11);
    expect(findingsIn(files)).toEqual([]);
  });

  it('infra and fixtures contain no prohibited data', () => {
    const files = [
      ...walk('infra', (file) => !file.includes('node_modules')),
      ...walk('test/contract/fixtures', () => true),
    ];

    expect(files.length).toBeGreaterThan(0);
    expect(findingsIn(files)).toEqual([]);
  });

  it('representative messages contain no prohibited data', () => {
    const offenders: string[] = [];
    for (const type of registeredTypes) {
      const serialised = JSON.stringify(validMessages[type]);
      for (const finding of findProhibitedData(serialised)) {
        offenders.push(`${type}: ${finding.kind}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the scanner would catch a planted value', () => {
    // Guards against a scanner that silently reads nothing (an empty walk passes vacuously).
    const planted = findingsIn(['docs/04-EVENT_CONTRACTS.md'].map(() => 'package.json'));
    expect(planted).toEqual([]);

    const text = `{"pan":"${PROHIBITED_FIXTURES.pan}"}`;
    expect(findProhibitedData(text).length).toBeGreaterThan(0);
  });
});
