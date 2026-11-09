import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsDefault from 'ajv-formats';
import { jsonSchemas } from './generated/schemas.js';

/**
 * ajv-formats ships CommonJS only (no `exports` map, no ESM build). Under
 * `verbatimModuleSyntax` TypeScript types its default import as the module namespace while
 * Node's interop supplies the callable plugin at runtime, so the mismatch is recorded here
 * once instead of loosening module resolution for the whole repo.
 */
const addFormats = addFormatsDefault as unknown as (ajv: Ajv2020) => Ajv2020;

/** A generated schema entry, narrowed so `$id` is known to exist. */
export interface GeneratedSchema {
  readonly $id: string;
  readonly [keyword: string]: unknown;
}

const SCHEMAS = jsonSchemas as readonly {
  readonly path: string;
  readonly schema: GeneratedSchema;
}[];

/**
 * Draft 2020-12 with format assertion and no remote loading
 * (schemas/README §Validator requirements, §Local validation expectations 4).
 *
 * - `strictSchema: true` turns an unknown keyword into a compile error, which is the
 *   malformed-schema gate docs/10 §M0 asks for.
 * - `verbose: false` keeps instance data out of `errors[]`, so a validation issue can
 *   never echo a prohibited value into a log or a response.
 * - No `loadSchema` is configured: a `$ref` that is not one of the generated schemas
 *   therefore fails at compile time with `MissingRefError` instead of reaching network.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strictSchema: true,
    strictTypes: false,
    strictRequired: false,
    strictTuples: true,
    allowUnionTypes: true,
    allErrors: true,
    verbose: false,
    // `loadSchema` is deliberately not passed: with `exactOptionalPropertyTypes` an
    // explicit `undefined` is a type error, and the default already means "no loader", so
    // a remote `$ref` fails to compile instead of reaching the network.
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Every generated schema registered under its `$id`, then every one compiled eagerly so a
 * broken `$ref` surfaces at startup rather than on the first message of that type.
 */
export function createMessageAjv(): Ajv2020 {
  const ajv = createAjv();

  for (const entry of SCHEMAS) {
    if (ajv.getSchema(entry.schema.$id) === undefined) ajv.addSchema(entry.schema);
  }
  for (const entry of SCHEMAS) {
    ajv.getSchema(entry.schema.$id);
  }

  return ajv;
}

/** The `$id` a registry row's `schema` path is registered under. */
export function schemaIdForPath(path: string): string {
  return `https://flowledger.dev/schemas/${path}`;
}
