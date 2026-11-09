/**
 * Every fenced ```json block in the prose contracts must validate against the schema it
 * illustrates. The contract is the source of truth and the schemas are generated from it,
 * so an example that does not validate means one of the two is wrong — a docs/structure
 * mismatch that would otherwise reach an implementer as a plausible-looking payload.
 *
 * There is deliberately no escape hatch. A earlier plan revision carried a `knownDeviation`
 * flag for the timeline example, which was missing `truncated`; that was a contract defect
 * and was fixed in the contract instead (R-02). Reintroducing such a flag would let a real
 * regression be silenced by editing this manifest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createAjv,
  openApiComponentsSchema,
  openApiExtensionKeywords,
  validateMessage,
} from '@flowledger/contracts';

interface Entry {
  file: string;
  index: number;
  target: { registry: true } | { openapi: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const manifest: Entry[] = JSON.parse(
  readFileSync(join(here, 'fixtures', 'prose-examples.json'), 'utf8'),
) as Entry[];

/** The regex the plan fixes for block extraction; capture 1 is the block body. */
function jsonBlocks(path: string): string[] {
  const source = readFileSync(join(repoRoot, path), 'utf8');
  return [...source.matchAll(/^```json\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? '');
}

const ajv = createAjv();
// The components schemas carry OpenAPI extension keywords that JSON Schema does not know;
// strict mode rejects an unknown keyword at compile time, so they are registered as
// annotations (they document a HTTP/body invariant, they do not constrain the instance).
for (const keyword of openApiExtensionKeywords) ajv.addKeyword(keyword);
ajv.addSchema(openApiComponentsSchema);

describe('prose examples', () => {
  it('the manifest covers every json block in both files', () => {
    const byFile = new Map<string, number>();
    for (const entry of manifest) {
      byFile.set(entry.file, Math.max(byFile.get(entry.file) ?? 0, entry.index + 1));
    }
    const actual = new Map<string, number>();
    for (const file of byFile.keys()) actual.set(file, jsonBlocks(file).length);

    // A new example with no manifest entry must fail here rather than be silently skipped.
    expect([...actual.entries()].sort()).toEqual([...byFile.entries()].sort());
    expect(manifest.map((e) => `${e.file}#${e.index}`)).toHaveLength(11);
  });

  it.each(manifest.filter((e) => 'registry' in e.target))(
    '$file block $index validates against the message registry',
    (entry) => {
      const block = jsonBlocks(entry.file)[entry.index] ?? '';
      const result = validateMessage(JSON.parse(block));
      expect(result.ok, JSON.stringify(result)).toBe(true);
    },
  );

  it.each(manifest.filter((e) => 'openapi' in e.target))(
    '$file block $index validates against components.schemas.$target.openapi',
    (entry) => {
      const name = (entry.target as { openapi: string }).openapi;
      const validate = ajv.compile({ $ref: `${openApiComponentsSchema.$id}#/$defs/${name}` });
      const block = jsonBlocks(entry.file)[entry.index] ?? '';

      expect(validate(JSON.parse(block)), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it('every manifest target names a real component', () => {
    const defs = openApiComponentsSchema.$defs as Record<string, unknown>;
    for (const entry of manifest) {
      if ('openapi' in entry.target) expect(defs).toHaveProperty(entry.target.openapi);
    }
  });
});
