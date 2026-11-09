/**
 * One set of synthetic prohibited values and one detector, for every later task.
 *
 * These values are fake and must stay recognisably fake: they exist so a redaction test has
 * something to redact and a log-scanning test has something to find. No value here is a real
 * PAN, credential, or provider secret.
 *
 * Detection is deliberately narrow. Money amounts reach 13 digits
 * (`1000000000000` is the documented maximum), so a 13–14 digit run cannot be distinguished
 * from an amount and is not treated as a PAN **[ASSUMPTION A-08]**. The simulator secret
 * formats are P06's to define; if they differ from `sim_sk_*`/`sim_whsec_*`, that phase must
 * extend this detector rather than loosen it **[ASSUMPTION A-09]**.
 */

export const PROHIBITED_FIXTURES = {
  pan: '4111111111111111',
  panFormatted: '4111 1111 1111 1111',
  cvvField: '{"cvv":"123"}',
  bearerCredential: `Bearer fl_test_0123456789AB_${'A'.repeat(43)}`,
  rawCredential: `fl_test_0123456789AB_${'A'.repeat(43)}`,
  providerSecret: 'sim_sk_test_0123456789abcdef0123456789abcdef',
  webhookSigningSecret: 'sim_whsec_0123456789abcdef0123456789abcdef',
} as const;

export type ProhibitedKind =
  'PAN' | 'CARD_FIELD' | 'BEARER_CREDENTIAL' | 'MERCHANT_CREDENTIAL' | 'PROVIDER_SECRET';

export interface ProhibitedFinding {
  readonly kind: ProhibitedKind;
  /** Offset of the match in the scanned text. Never the match itself. */
  readonly index: number;
}

/** Field names that must never appear as a value key in a payload we emit or persist. */
const CARD_FIELD_PATTERN =
  /(?:^|["'\s,{[])(cvv2?|cvc|security_?code|card_?number|pan|account_?number)["']?\s*[:=]/gi;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/g;

/** docs/05 credential format: `fl_test_<12-char Crockford locator>_<43-char base64url secret>`. */
const MERCHANT_CREDENTIAL_PATTERN = /fl_test_[0-9A-HJKMNP-TV-Z]{12}_[A-Za-z0-9_-]{43}/g;

const PROVIDER_SECRET_PATTERN = /sim_(?:sk|whsec)_[a-z_]*[0-9a-f]{32}/g;

/**
 * Candidate digit runs, with single spaces or hyphens allowed as grouping separators.
 * The lookarounds stop a run being detected from inside a longer alphanumeric token, where it
 * would be an identifier fragment rather than a number.
 */
const DIGIT_RUN_PATTERN = /(?<![A-Za-z0-9_])(?:\d[ -]?){14,19}\d(?![A-Za-z0-9_])/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    let contribution = value;
    if (double) {
      contribution *= 2;
      if (contribution > 9) contribution -= 9;
    }
    sum += contribution;
    double = !double;
  }
  return sum % 10 === 0;
}

export function findProhibitedData(text: string): ProhibitedFinding[] {
  const findings: ProhibitedFinding[] = [];

  for (const match of text.matchAll(DIGIT_RUN_PATTERN)) {
    const digits = match[0].replace(/[ -]/g, '');
    // 15–19 digits and a valid checksum. Shorter runs are money amounts (A-08).
    if (digits.length >= 15 && digits.length <= 19 && luhn(digits)) {
      findings.push({ kind: 'PAN', index: match.index ?? 0 });
    }
  }

  for (const match of text.matchAll(CARD_FIELD_PATTERN)) {
    findings.push({ kind: 'CARD_FIELD', index: match.index ?? 0 });
  }

  for (const match of text.matchAll(BEARER_PATTERN)) {
    findings.push({ kind: 'BEARER_CREDENTIAL', index: match.index ?? 0 });
  }

  for (const match of text.matchAll(MERCHANT_CREDENTIAL_PATTERN)) {
    findings.push({ kind: 'MERCHANT_CREDENTIAL', index: match.index ?? 0 });
  }

  for (const match of text.matchAll(PROVIDER_SECRET_PATTERN)) {
    findings.push({ kind: 'PROVIDER_SECRET', index: match.index ?? 0 });
  }

  return findings.sort((left, right) => left.index - right.index);
}

/**
 * Throws when prohibited data is present. The message names the kinds and the label but never
 * the matched text: an assertion message ends up in CI logs, which is the exact place the
 * value must not appear.
 */
export function assertNoProhibitedData(label: string, text: string): void {
  const findings = findProhibitedData(text);
  if (findings.length === 0) return;
  const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
  throw new Error(`${label}: prohibited data (${kinds})`);
}
