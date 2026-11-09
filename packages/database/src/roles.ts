/**
 * Database role names (CONVENTIONS §7).
 *
 * These names appear in migrations, grants, RLS policies, and application config, so they live in one
 * place and are asserted against the database in P02 tests rather than retyped per call site. A typo in
 * a role name fails at runtime with a permission error that reads like a logic bug, which is the worst
 * possible failure shape.
 */

/** Runs migrations, owns schemas and tables. Never used by an application process. */
export const MIGRATION_OWNER = 'fl_migration_owner' as const;

/** NOLOGIN roles that own the protected `SECURITY DEFINER` functions per schema (ADR-0007). */
export const FUNCTION_OWNER_ROLES = [
  'payments_function_owner',
  'ledger_function_owner',
  'settlement_function_owner',
  'messaging_function_owner',
  'reconciliation_function_owner',
  'webhooks_function_owner',
  'audit_function_owner',
] as const;

/** Every role an application process logs in as. */
export const LOGIN_RUNTIME_ROLES = [
  'fl_api',
  'fl_relay',
  'fl_payment_worker',
  'fl_webhook_receiver',
  'fl_webhook_worker',
  'fl_reconciler',
  'fl_settlement_worker',
  'fl_webhook_projector',
  'fl_webhook_dispatcher',
  'fl_operator_readonly',
  'fl_operator_command',
  'fl_correction',
] as const;

export type FunctionOwnerRole = (typeof FUNCTION_OWNER_ROLES)[number];
export type LoginRuntimeRole = (typeof LOGIN_RUNTIME_ROLES)[number];
