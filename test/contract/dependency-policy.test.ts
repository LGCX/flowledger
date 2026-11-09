import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export interface DependencyPolicy {
  approved: string[];
  approvedPatterns?: string[];
  justified: Record<string, string>;
}

export interface Manifest {
  file: string;
  json: Record<string, unknown>;
}

function dependencyEntries(manifest: Manifest): Array<[string, string, string]> {
  const entries: Array<[string, string, string]> = [];
  for (const section of SECTIONS) {
    const block = manifest.json[section];
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      entries.push([section, name, typeof spec === 'string' ? spec : String(spec)]);
    }
  }
  return entries;
}

/**
 * Returns one human-readable finding per violation. Kept separate from file IO so the
 * negative cases can feed a mutated in-memory manifest instead of writing to disk.
 */
export function checkManifests(manifests: Manifest[], policy: DependencyPolicy): string[] {
  const approved = new Set(policy.approved);
  const justified = new Set(Object.keys(policy.justified));
  const patterns = policy.approvedPatterns ?? [];
  const findings: string[] = [];

  for (const manifest of manifests) {
    for (const [section, name, spec] of dependencyEntries(manifest)) {
      const where = `${manifest.file}: ${section} "${name}"`;

      if (spec !== 'workspace:*' && !EXACT_VERSION.test(spec)) {
        findings.push(`${where} must be an exact version or "workspace:*", got "${spec}"`);
      }

      if (name.startsWith('@flowledger/')) continue;
      if (approved.has(name) || justified.has(name)) continue;
      if (patterns.some((prefix) => name.startsWith(prefix))) continue;

      if (name.startsWith('@types/')) {
        const base = name.slice('@types/'.length);
        if (approved.has(base)) continue;
        findings.push(
          `${where} is not approved, and an @types/* package requires its base package "${base}" to be approved or itself to be justified`,
        );
        continue;
      }

      findings.push(`${where} is not an approved dependency (CONVENTIONS §2)`);
    }
  }

  return findings;
}

function loadPolicy(): DependencyPolicy {
  return JSON.parse(
    readFileSync(join(repoRoot, 'test/contract/approved-dependencies.json'), 'utf8'),
  ) as DependencyPolicy;
}

/** Root manifest plus every workspace manifest that currently exists. */
function workspaceManifests(): Manifest[] {
  const files = ['package.json'];
  for (const group of ['apps', 'packages']) {
    let dirs: string[];
    try {
      dirs = readdirSync(join(repoRoot, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const dir of dirs) files.push(join(group, dir, 'package.json'));
  }

  return files.map((file) => ({
    file,
    json: JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as Record<string, unknown>,
  }));
}

const policy = loadPolicy();

const manifestWith = (deps: Record<string, string>): Manifest => ({
  file: 'package.json',
  json: { devDependencies: deps },
});

describe('dependency policy', () => {
  it('all manifests comply', () => {
    expect(checkManifests(workspaceManifests(), policy)).toEqual([]);
  });

  it('caret spec rejected', () => {
    const findings = checkManifests([manifestWith({ vitest: '^4.1.12' })], policy);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('exact version');
    expect(findings[0]).toContain('^4.1.12');
  });

  it('tilde spec rejected', () => {
    const findings = checkManifests([manifestWith({ vitest: '~4.1.12' })], policy);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('exact version');
  });

  it('unapproved package rejected', () => {
    const findings = checkManifests([manifestWith({ lodash: '4.17.21' })], policy);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('lodash');
    expect(findings[0]).toContain('not an approved dependency');
  });

  it('@types without approved base rejected', () => {
    const findings = checkManifests([manifestWith({ '@types/lodash': '4.17.21' })], policy);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('@types/lodash');
    expect(findings[0]).toContain('base package "lodash"');
  });

  it('workspace:* accepted', () => {
    expect(
      checkManifests(
        [manifestWith({ '@flowledger/domain': 'workspace:*', '@types/pg': '8.11.10' })],
        policy,
      ),
    ).toEqual([]);
  });

  it('approved dependency accepted', () => {
    expect(checkManifests([manifestWith({ pg: '8.13.1', ulid: '2.3.0' })], policy)).toEqual([]);
  });

  it('justified dependency accepted', () => {
    expect(checkManifests([manifestWith({ typescript: '5.9.3' })], policy)).toEqual([]);
  });

  it('@types accepted when its base is approved', () => {
    expect(checkManifests([manifestWith({ '@types/pg': '8.11.10' })], policy)).toEqual([]);
  });

  it('every dependency section is checked', () => {
    const findings = checkManifests(
      [
        {
          file: 'package.json',
          json: {
            dependencies: { lodash: '4.17.21' },
            optionalDependencies: { lodash: '4.17.21' },
            peerDependencies: { lodash: '4.17.21' },
          },
        },
      ],
      policy,
    );
    expect(findings).toHaveLength(3);
  });

  /**
   * The developer guide is the only place every command is listed together, and a script that
   * exists but is undocumented is a script nobody runs. This also catches the reverse mistake:
   * renaming a script leaves the guide describing a command that no longer exists, which the
   * second assertion catches.
   */
  it('docs/DEVELOPMENT.md documents every root script', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const guide = readFileSync(join(repoRoot, 'docs', 'DEVELOPMENT.md'), 'utf8');

    const undocumented = Object.keys(manifest.scripts).filter(
      (script) => !guide.includes(`\`pnpm ${script}`),
    );
    expect(undocumented).toEqual([]);
  });

  it('docs/DEVELOPMENT.md names no command that does not exist', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const guide = readFileSync(join(repoRoot, 'docs', 'DEVELOPMENT.md'), 'utf8');

    const documented = [...guide.matchAll(/`pnpm ([a-z][a-z:0-9-]*)(?=[\s`]|$)/g)].map(
      (match) => match[1] as string,
    );
    const known = new Set([...Object.keys(manifest.scripts), 'install', 'exec', 'vitest']);
    const unknown = [...new Set(documented)].filter((name) => !known.has(name));
    expect(unknown).toEqual([]);
  });
});
