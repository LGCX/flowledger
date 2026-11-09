import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registry } from '../../packages/contracts/src/generated/schemas.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

interface Row {
  kind: string;
  type: string;
  schema: string;
}

const ROWS = registry.messages as unknown as Row[];

/** Backticked first cells of the table under `heading`, until the next `## ` heading. */
function tableTypes(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`heading not found: ${heading}`);

  const types: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const first = (trimmed.split('|')[1] ?? '').trim();
    if (first === '' || first === 'Type' || /^[-\s]+$/.test(first)) continue;

    const match = /^`([^`]+)`$/.exec(first);
    if (match?.[1] !== undefined) types.push(match[1]);
  }
  return types;
}

/** Backticked file paths listed under `heading`. */
function listedFiles(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) throw new Error(`heading not found: ${heading}`);

  const files: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const match = /^- `([^`]+\.schema\.json)`/.exec(line.trim());
    if (match?.[1] !== undefined) files.push(match[1]);
  }
  return files;
}

/** One message naming both sides of a mismatch, or null when the sets agree. */
function parityFailure(label: string, documented: string[], registered: string[]): string | null {
  const missing = registered.filter((type) => !documented.includes(type));
  const extra = documented.filter((type) => !registered.includes(type));
  if (missing.length === 0 && extra.length === 0) return null;
  return `${label}: missing from contract [${missing.join(', ')}]; extra in contract [${extra.join(', ')}]`;
}

const contracts = readFileSync(join(repoRoot, 'docs/04-EVENT_CONTRACTS.md'), 'utf8');
const schemasReadme = readFileSync(join(repoRoot, 'schemas/README.md'), 'utf8');

const registeredCommands = ROWS.filter((row) => row.kind === 'COMMAND').map((row) => row.type);
const registeredEvents = ROWS.filter((row) => row.kind === 'EVENT').map((row) => row.type);

describe('catalog parity', () => {
  it('command catalog == registry commands', () => {
    const documented = tableTypes(contracts, '## Initial command catalog');
    expect(documented).toHaveLength(3);
    expect(parityFailure('commands', documented, registeredCommands)).toBeNull();
  });

  it('event catalog == registry events', () => {
    const documented = tableTypes(contracts, '## Initial event catalog');
    expect(documented).toHaveLength(23);
    expect(parityFailure('events', documented, registeredEvents)).toBeNull();
  });

  it('schemas README file list == registry schema paths', () => {
    const documented = [
      ...listedFiles(schemasReadme, '## Commands'),
      ...listedFiles(schemasReadme, '## Events'),
    ];
    const registered = ROWS.map((row) => row.schema);

    expect(documented).toHaveLength(12);
    expect(parityFailure('schema files', documented, registered)).toBeNull();
  });

  it('parity failure message lists missing and extra types', () => {
    // A table that has dropped one registered type and invented another.
    const mutated = [
      '| Type | Meaning | Primary consumers |',
      '| --- | --- | --- |',
      '| `payment.created.v1` | ok | ok |',
      '| `payment.not.a.real.type.v1` | invented | invented |',
    ].join('\n');

    const documented = tableTypes(
      `## Initial event catalog\n\n${mutated}\n`,
      '## Initial event catalog',
    );
    const failure = parityFailure('events', documented, registeredEvents);

    expect(failure).toBeTypeOf('string');
    expect(failure).toContain('missing from contract');
    expect(failure).toContain('payment.authorization.requested.v1');
    expect(failure).toContain('extra in contract');
    expect(failure).toContain('payment.not.a.real.type.v1');
  });

  it('parity is silent when the sets agree', () => {
    expect(parityFailure('events', registeredEvents, registeredEvents)).toBeNull();
  });
});
