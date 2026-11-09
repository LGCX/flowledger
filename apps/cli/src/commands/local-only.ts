/**
 * Commands that print a raw credential run only where `NODE_ENV` says the database is disposable.
 *
 * An allowlist, not `NODE_ENV !== 'production'`: a production shell with `NODE_ENV` unset or
 * misspelled must be refused too, because the failure mode is a live credential in a terminal
 * scrollback and a shell history, and the credentials these commands mint are `fl_test_` synthetic
 * ones that have no place in production anyway.
 */
export function isLocalEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}
