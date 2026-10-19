/**
 * @platform/logger - Redaction engine
 * Redacts secrets, tokens, authorization headers, cookies, database URLs/passwords, and common PII.
 * Enforces SEC-05, SEC-15, and Cross-Module Privacy/Observability contracts.
 */

export const REDACTED_VALUE = '[REDACTED]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';
export const REDACTED_PHONE = '[REDACTED_PHONE]';
export const REDACTED_CARD = '[REDACTED_CARD]';
export const REDACTED_NATIONAL_ID = '[REDACTED_NATIONAL_ID]';
export const REDACTED_JWT = '[REDACTED_JWT]';
export const REDACTED_API_KEY = '[REDACTED_API_KEY]';

function getWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'auth',
  'authorization',
  'bearer',
  'privatekey',
  'privkey',
  'cert',
  'certificate',
  'signature',
  'salt',
  'hash',
  'cvv',
  'cvc',
  'pin',
  'otp',
  'totp',
  'ssn',
  'aadhaar',
]);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  if (
    normalized.includes('databaseurl') ||
    normalized.includes('directurl') ||
    normalized.includes('connstring') ||
    normalized.includes('connectionstring') ||
    normalized.includes('apikey') ||
    normalized.includes('creditcard') ||
    normalized.includes('cardnumber') ||
    normalized.includes('sessionid') ||
    normalized.includes('sessiontoken') ||
    normalized.includes('privatekey') ||
    normalized.includes('encryptionkey')
  ) {
    return true;
  }

  const words = getWords(key);
  for (const word of words) {
    if (SENSITIVE_WORDS.has(word)) {
      return true;
    }
  }

  return false;
}

export function isCookieKey(key: string): boolean {
  const words = getWords(key);
  return words.includes('cookie');
}

export function isEmailKey(key: string): boolean {
  const words = getWords(key);
  return words.includes('email');
}

export function isPhoneKey(key: string): boolean {
  const words = getWords(key);
  return (
    words.includes('phone') ||
    words.includes('mobile') ||
    words.includes('telephone') ||
    words.includes('whatsapp')
  );
}

/**
 * Regex patterns for inline string redaction.
 */
const BEARER_OR_BASIC_AUTH_REGEX = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_REGEX = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;

// Database connection strings: postgres://user:pass@host:5432/db, redis://, mysql://, mongodb://, etc.
const DB_URL_CREDENTIALS_REGEX =
  /((?:postgres(?:ql)?|mysql|mariadb|redis|rediss|mongodb(?:\+srv)?|https?):\/\/)([^:\s/@]+):([^@\s/]+)@/gi;

// URL query string secrets: e.g. ?token=..., &key=..., &password=...
const URL_QUERY_SECRET_REGEX =
  /([?&](?:token|key|api_?key|password|secret|auth|access_?token|refresh_?token)=)([^&#\s]+)/gi;

// Vendor API keys
const ANTHROPIC_API_KEY_REGEX = /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/g;
const OPENAI_API_KEY_REGEX = /\b(sk-(?:proj-)?[a-zA-Z0-9_-]{20,})\b/g;
const AWS_ACCESS_KEY_REGEX = /\b(AKIA[0-9A-Z]{16})\b/g;
const GITHUB_TOKEN_REGEX = /\b(gh[pousr]_[A-Za-z0-9_]{36,})\b/g;
const PAYMENT_KEY_REGEX = /\b((?:sk|pk|rzp)_(?:test|live)_[a-zA-Z0-9]{14,})\b/g;
const SUPABASE_KEY_REGEX = /\b(sbp_[a-zA-Z0-9]{20,})\b/g;

// Bare assignment secret patterns ("secret=value", "token: abc", "api_key=...", "password: cleartext")
const BARE_ASSIGNMENT_SECRET_REGEX =
  /\b(password|passwd|pwd|secret|token|api_?key|auth_?token|access_?token|refresh_?token|session_?token|session_?id|private_?key|bearer_?token|client_?secret)(\s*[:=]\s*)(["']?)([^\s"';,&=?\r\n]+)\3/gi;

// Safe non-secret words that legitimately follow security keywords in messages (e.g. "password reset", "token rotation")
const SAFE_NON_SECRET_FOLLOWING_WORDS = new Set([
  'reset',
  'resets',
  'change',
  'changed',
  'update',
  'updated',
  'policy',
  'policies',
  'mismatch',
  'mismatches',
  'hash',
  'hashed',
  'hashes',
  'expired',
  'expires',
  'expiry',
  'expiration',
  'required',
  'requirement',
  'requirements',
  'field',
  'fields',
  'confirmation',
  'strength',
  'length',
  'validation',
  'validator',
  'recovery',
  'rule',
  'rules',
  'check',
  'checks',
  'checked',
  'attempt',
  'attempts',
  'attempted',
  'generation',
  'generator',
  'complexity',
  'status',
  'type',
  'types',
  'format',
  'formats',
  'algorithm',
  'spec',
  'version',
  'lifecycle',
  'rotation',
  'rotated',
  'revoke',
  'revoked',
  'revocation',
  'issued',
  'issuer',
  'verified',
  'verification',
  'bucket',
  'buckets',
  'count',
  'balance',
  'usage',
  'ledger',
  'reserve',
  'commit',
  'refund',
  'rate',
  'limit',
  'limits',
  'limiter',
  'limiting',
  'error',
  'errors',
  'failure',
  'failures',
  'failed',
  'success',
  'successful',
  'successfully',
  'leak',
  'exposure',
  'protection',
  'management',
  'manager',
  'vault',
  'store',
  'storage',
  'is',
  'was',
  'are',
  'were',
  'been',
  'has',
  'have',
  'had',
  'set',
  'equals',
  'for',
  'in',
  'at',
  'of',
  'from',
  'by',
  'and',
  'or',
  'not',
  'with',
  'without',
  'to',
  'must',
  'should',
  'cannot',
  'can',
  'does',
  'did',
  'will',
  'would',
]);

// Space-separated bare secrets ("password cleartext-value", "secret my-secret")
const BARE_SPACE_SECRET_REGEX =
  /\b(password|passwd|pwd|secret|token|api_?key|auth_?token|access_?token|refresh_?token|session_?token|session_?id|private_?key|bearer_?token|client_?secret)\s+(["']?)([^\s"';,&=?\r\n]+)\2/gi;

// Verb phrase bare secrets ("password is cleartext", "token set to xyz")
const VERB_PHRASE_SECRET_REGEX =
  /\b(password|passwd|pwd|secret|token|api_?key)\s+(is|was|set\s+to|equals)\s+(["']?)([^\s"';,&=?\r\n]+)\3/gi;

// Prefixed token/secret code identifiers ("ERR_TOKEN_xyz123", "TOKEN_abc")
const PREFIXED_CODE_SECRET_REGEX =
  /(^|[^A-Za-z0-9])([A-Za-z0-9]+[_-])?(token|secret|password|passwd|api_?key)[_-]([A-Za-z0-9_-]+)/gi;

// PII: Email addresses
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// PII: Credit cards (13 to 19 digits formatted or contiguous)
const CREDIT_CARD_REGEX = /\b(?:\d{4}[ -]?){3}\d{4}\b|\b(?:\d{4}[ -]?){2}\d{4}[ -]?\d{3}\b/g;

// PII: Indian Aadhaar numbers (12 digits in 4-4-4 format)
const AADHAAR_REGEX = /\b[2-9]\d{3}\s\d{4}\s\d{4}\b/g;

// PII: Phone numbers (Indian mobile starting 6-9, standard international +91/US/generic formats)
// Note: crafted to not match dates like 2026-10-17 or version numbers like 16.3.8
const IN_PHONE_REGEX = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;
const US_INTL_PHONE_REGEX = /(?:\+1[\s-]?)?(?:\(\d{3}\)|\b\d{3}\b)[\s.-]\d{3}[\s.-]\d{4}\b/g;

/**
 * Redacts a raw cookie or set-cookie string.
 * Example: "token=abc1234; session=xyz; path=/" -> "token=[REDACTED]; session=[REDACTED]; path=/"
 */
export function redactCookieString(cookieStr: string): string {
  return cookieStr.replace(/([^=;\s]+)=([^;]*)/g, (_match, name, val) => {
    const trimmedName = name.trim();
    // Retain common harmless cookie directives
    if (/^(?:path|domain|expires|max-age|samesite|secure|httponly)$/i.test(trimmedName)) {
      return `${trimmedName}=${val}`;
    }
    return `${trimmedName}=${REDACTED_VALUE}`;
  });
}

/**
 * Redacts a string by running regex passes for secrets, credentials, URLs and PII.
 */
export function redactString(input: string): string {
  if (!input || typeof input !== 'string') return input;

  let result = input;

  // 1. Bearer / Basic auth
  result = result.replace(BEARER_OR_BASIC_AUTH_REGEX, `$1 ${REDACTED_VALUE}`);

  // 2. JWTs
  result = result.replace(JWT_REGEX, REDACTED_JWT);

  // 3. Database & URL credentials
  result = result.replace(DB_URL_CREDENTIALS_REGEX, `$1$2:${REDACTED_VALUE}@`);
  result = result.replace(URL_QUERY_SECRET_REGEX, `$1${REDACTED_VALUE}`);

  // 4. API keys
  result = result.replace(ANTHROPIC_API_KEY_REGEX, REDACTED_API_KEY);
  result = result.replace(OPENAI_API_KEY_REGEX, REDACTED_API_KEY);
  result = result.replace(AWS_ACCESS_KEY_REGEX, REDACTED_VALUE);
  result = result.replace(GITHUB_TOKEN_REGEX, REDACTED_VALUE);
  result = result.replace(PAYMENT_KEY_REGEX, REDACTED_VALUE);
  result = result.replace(SUPABASE_KEY_REGEX, REDACTED_VALUE);

  // 5. Bare assignment secrets ("secret=value", "token: abc", "api_key=...", "password: cleartext")
  result = result.replace(BARE_ASSIGNMENT_SECRET_REGEX, (match, key, sep, quote, val) => {
    if (val.startsWith('[REDACTED')) {
      return match;
    }
    const trimmedSep = sep.trim();
    const formattedSep = trimmedSep === ':' || /\s$/.test(sep) ? `${trimmedSep} ` : trimmedSep;
    return `${key}${formattedSep}${quote}${REDACTED_VALUE}${quote}`;
  });

  // 6. Verb phrase bare secrets ("password is cleartext", "token was xyz")
  result = result.replace(VERB_PHRASE_SECRET_REGEX, (match, key, verb, quote, val) => {
    if (val.startsWith('[REDACTED')) {
      return match;
    }
    return `${key} ${verb} ${quote}${REDACTED_VALUE}${quote}`;
  });

  // 7. Space-separated bare secrets ("password cleartext-value")
  result = result.replace(BARE_SPACE_SECRET_REGEX, (match, key, quote, val) => {
    if (val.startsWith('[REDACTED')) {
      return match;
    }
    const lower = val.toLowerCase();
    if (SAFE_NON_SECRET_FOLLOWING_WORDS.has(lower)) {
      return match;
    }
    return `${key} ${quote}${REDACTED_VALUE}${quote}`;
  });

  // 8. Prefixed token/secret code identifiers ("ERR_TOKEN_xyz123", "TOKEN_abc")
  result = result.replace(PREFIXED_CODE_SECRET_REGEX, (match, prefixNonWord, prefixWord, key, val) => {
    if (val.startsWith('[REDACTED') || val === REDACTED_VALUE) {
      return match;
    }
    return `${prefixNonWord ?? ''}${prefixWord ?? ''}${key}_${REDACTED_VALUE}`;
  });

  // 9. Common PII
  result = result.replace(EMAIL_REGEX, REDACTED_EMAIL);
  result = result.replace(CREDIT_CARD_REGEX, REDACTED_CARD);
  result = result.replace(AADHAAR_REGEX, REDACTED_NATIONAL_ID);
  result = result.replace(IN_PHONE_REGEX, REDACTED_PHONE);
  result = result.replace(US_INTL_PHONE_REGEX, REDACTED_PHONE);

  return result;
}

export interface RedactOptions {
  maxDepth?: number;
}

/**
 * Deeply and recursively redacts arbitrary values (objects, arrays, errors, primitives).
 * Safely handles circular references, deep nesting, Error objects, and special types.
 */
export function redact<T>(input: T, options?: RedactOptions): T {
  const maxDepth = options?.maxDepth ?? 10;
  const seen = new WeakSet<object>();

  function redactInternal(value: unknown, depth: number, currentKey?: string): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      if (currentKey) {
        if (isCookieKey(currentKey)) {
          return redactCookieString(value);
        }
        if (isSensitiveKey(currentKey)) {
          return REDACTED_VALUE;
        }
        if (isEmailKey(currentKey)) {
          return REDACTED_EMAIL;
        }
        if (isPhoneKey(currentKey)) {
          return REDACTED_PHONE;
        }
      }
      return redactString(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      if (currentKey && isSensitiveKey(currentKey)) {
        return REDACTED_VALUE;
      }
      return value;
    }

    if (typeof value !== 'object') {
      return value;
    }

    if (depth > maxDepth) {
      return '[MaxDepthExceeded]';
    }

    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    // Error serialization: sanitize name, message, stack, code, cause, and all own properties
    if (value instanceof Error) {
      const errorObj: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message),
        stack: value.stack ? redactString(value.stack) : undefined,
      };

      if ('code' in value && value.code !== undefined && value.code !== null) {
        errorObj.code =
          typeof value.code === 'string'
            ? redactString(value.code)
            : redactInternal(value.code, depth + 1, 'code');
      }

      if ('cause' in value && value.cause !== undefined && value.cause !== null) {
        errorObj.cause = redactInternal(value.cause, depth + 1, 'cause');
      }

      // Deeply sanitize and redact every own property (both enumerable and non-enumerable)
      const ownProps = Object.getOwnPropertyNames(value);
      for (const prop of ownProps) {
        if (
          prop !== 'name' &&
          prop !== 'message' &&
          prop !== 'stack' &&
          prop !== 'cause' &&
          prop !== 'code'
        ) {
          const propVal = (value as unknown as Record<string, unknown>)[prop];
          errorObj[prop] = redactInternal(propVal, depth + 1, prop);
        }
      }

      // Also copy any inherited enumerable properties
      for (const [k, v] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(errorObj, k)) {
          errorObj[k] = redactInternal(v, depth + 1, k);
        }
      }

      return errorObj;
    }

    // Array serialization
    if (Array.isArray(value)) {
      return value.map((item) => redactInternal(item, depth + 1, currentKey));
    }

    // Date
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Headers object (from fetch / Next.js)
    if (
      typeof (value as { forEach?: unknown }).forEach === 'function' &&
      typeof (value as { entries?: unknown }).entries === 'function' &&
      value.constructor?.name === 'Headers'
    ) {
      const headerRecord: Record<string, string> = {};
      (value as unknown as { forEach: (cb: (v: string, k: string) => void) => void }).forEach((v, k) => {
        headerRecord[k] = v;
      });
      return redactInternal(headerRecord, depth + 1);
    }

    // URL object
    if (value instanceof URL) {
      return redactString(value.toString());
    }

    // Map
    if (value instanceof Map) {
      const mapObj: Record<string, unknown> = {};
      for (const [k, v] of value.entries()) {
        const keyStr = String(k);
        mapObj[keyStr] = redactInternal(v, depth + 1, keyStr);
      }
      return mapObj;
    }

    // Set
    if (value instanceof Set) {
      return Array.from(value).map((item) => redactInternal(item, depth + 1));
    }

    // Plain Object
    const result: Record<string, unknown> = {};
    for (const [key, propVal] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        result[key] = REDACTED_VALUE;
      } else if (isCookieKey(key) && typeof propVal === 'string') {
        result[key] = redactCookieString(propVal);
      } else if (isEmailKey(key) && typeof propVal === 'string') {
        result[key] = REDACTED_EMAIL;
      } else if (isPhoneKey(key) && typeof propVal === 'string') {
        result[key] = REDACTED_PHONE;
      } else {
        result[key] = redactInternal(propVal, depth + 1, key);
      }
    }

    return result;
  }

  return redactInternal(input, 0) as T;
}
