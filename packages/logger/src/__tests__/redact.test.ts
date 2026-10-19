import { describe, expect, it } from 'vitest';
import {
  REDACTED_API_KEY,
  REDACTED_CARD,
  REDACTED_EMAIL,
  REDACTED_JWT,
  REDACTED_NATIONAL_ID,
  REDACTED_PHONE,
  REDACTED_VALUE,
  redact,
  redactCookieString,
  redactString,
} from '../redact';

describe('redactString', () => {
  it('redacts Authorization Bearer and Basic headers', () => {
    const bearer = 'Authorization: Bearer my-secret-token-123456';
    const basic = 'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==';
    expect(redactString(bearer)).toBe(`Authorization: Bearer ${REDACTED_VALUE}`);
    expect(redactString(basic)).toBe(`Proxy-Authorization: Basic ${REDACTED_VALUE}`);
  });

  it('redacts JSON Web Tokens (JWT)', () => {
    // Deliberately invalid, low-entropy fixture. It meets the logger's JWT-shaped
    // pattern without resembling a credential to repository secret scanners.
    const jwt = 'token eyJaaaaaaaaaa.eyJbbbbbbbbbb.cccccccccc in header';
    expect(redactString(jwt)).toBe(`token ${REDACTED_JWT} in header`);
  });

  it('redacts database credentials in connection strings', () => {
    const pg = 'postgresql://postgres_user:super_secret_pw@db.project.supabase.co:5432/postgres';
    const redis = 'redis://default:authpass999@redis.cache.internal:6379';
    const mysql = 'mysql://app_user:dbpassword@127.0.0.1:3306/platform';
    const mongo = 'mongodb+srv://admin:clustermongopw@cluster0.mongodb.net/test';

    expect(redactString(pg)).toBe(
      `postgresql://postgres_user:${REDACTED_VALUE}@db.project.supabase.co:5432/postgres`,
    );
    expect(redactString(redis)).toBe(`redis://default:${REDACTED_VALUE}@redis.cache.internal:6379`);
    expect(redactString(mysql)).toBe(`mysql://app_user:${REDACTED_VALUE}@127.0.0.1:3306/platform`);
    expect(redactString(mongo)).toBe(`mongodb+srv://admin:${REDACTED_VALUE}@cluster0.mongodb.net/test`);
  });

  it('redacts sensitive query parameters in URLs', () => {
    const url = 'https://api.platform.internal/webhook?token=secret123&env=prod&api_key=key_abc';
    expect(redactString(url)).toBe(
      `https://api.platform.internal/webhook?token=${REDACTED_VALUE}&env=prod&api_key=${REDACTED_VALUE}`,
    );
  });

  it('redacts vendor and cloud API keys', () => {
    const anthropic = 'Anthropic key sk-ant-api03-abcdef12345678901234567890_xyz';
    const openai = 'OpenAI key sk-proj-1234567890abcdef1234567890abcdef';
    const aws = 'AWS key AKIAIOSFODNN7EXAMPLE used for S3';
    const github = 'GitHub token ghp_1234567890abcdefghijklmnopqrstuvwxyzAB';
    const razorpay = 'Razorpay key rzp_test_1234567890abcd';
    const supabase = 'Supabase key sbp_1234567890abcdef1234567890';

    expect(redactString(anthropic)).toBe(`Anthropic key ${REDACTED_API_KEY}`);
    expect(redactString(openai)).toBe(`OpenAI key ${REDACTED_API_KEY}`);
    expect(redactString(aws)).toBe(`AWS key ${REDACTED_VALUE} used for S3`);
    expect(redactString(github)).toBe(`GitHub token ${REDACTED_VALUE}`);
    expect(redactString(razorpay)).toBe(`Razorpay key ${REDACTED_VALUE}`);
    expect(redactString(supabase)).toBe(`Supabase key ${REDACTED_VALUE}`);
  });

  it('redacts email addresses', () => {
    const text = 'Contact lead: john.doe+promo@agency.co.in or support@platform.com';
    expect(redactString(text)).toBe(`Contact lead: ${REDACTED_EMAIL} or ${REDACTED_EMAIL}`);
  });

  it('redacts credit card numbers', () => {
    const cardSpaced = 'Payment attempted with card 4111 2222 3333 4444';
    const cardDashed = 'Card 5500-0000-0000-0004 entered';
    expect(redactString(cardSpaced)).toBe(`Payment attempted with card ${REDACTED_CARD}`);
    expect(redactString(cardDashed)).toBe(`Card ${REDACTED_CARD} entered`);
  });

  it('redacts national IDs (Indian Aadhaar)', () => {
    const aadhaar = 'Citizen ID 2345 6789 0123 submitted';
    expect(redactString(aadhaar)).toBe(`Citizen ID ${REDACTED_NATIONAL_ID} submitted`);
  });

  it('redacts phone numbers while preserving dates, timestamps, and semantic versions', () => {
    const phoneIndia = 'Client phone +91 98765 43210 requested callback';
    const phoneUS = 'Calling office (555) 123-4567 now';
    const safeDateAndVersion = 'Released v16.3.8 on 2026-10-17T15:30:00.000Z';

    expect(redactString(phoneIndia)).toBe(`Client phone ${REDACTED_PHONE} requested callback`);
    expect(redactString(phoneUS)).toBe(`Calling office ${REDACTED_PHONE} now`);
    expect(redactString(safeDateAndVersion)).toBe(safeDateAndVersion);
  });
});

describe('redactCookieString', () => {
  it('redacts cookie values while preserving standard directives', () => {
    const cookie = 'session_id=sess_abc123; auth_token=token_xyz; Path=/; Secure; HttpOnly; SameSite=Lax';
    const redacted = redactCookieString(cookie);
    expect(redacted).toBe(
      `session_id=${REDACTED_VALUE}; auth_token=${REDACTED_VALUE}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
  });
});

describe('redact object hierarchy', () => {
  it('redacts sensitive keys in plain objects', () => {
    const input = {
      workspaceId: 'ws_123',
      user: {
        id: 'usr_1',
        password: 'cleartext-password-123',
        api_key: 'sk-ant-api03-abcdef12345678901234567890_xyz',
        email: 'freelancer@example.com',
        phone: '+91 98765 43210',
        metadata: {
          secretToken: 'shhh-123',
          totpSecret: 'JBSWY3DPEHPK3PXP',
          databaseUrl: 'postgres://app:secret@localhost:5432/db',
        },
      },
    };

    const redacted = redact(input);

    expect(redacted.workspaceId).toBe('ws_123');
    expect(redacted.user.id).toBe('usr_1');
    expect(redacted.user.password).toBe(REDACTED_VALUE);
    expect(redacted.user.api_key).toBe(REDACTED_VALUE);
    expect(redacted.user.email).toBe(REDACTED_EMAIL);
    expect(redacted.user.phone).toBe(REDACTED_PHONE);
    expect(redacted.user.metadata.secretToken).toBe(REDACTED_VALUE);
    expect(redacted.user.metadata.totpSecret).toBe(REDACTED_VALUE);
    expect(redacted.user.metadata.databaseUrl).toBe(REDACTED_VALUE);
  });

  it('redacts cookie and authorization in headers', () => {
    const headers = {
      authorization: 'Bearer secret_access_token',
      cookie: 'sess=val123; other=secret456',
      'user-agent': 'Mozilla/5.0',
      'x-correlation-id': 'corr-123',
    };

    const redacted = redact(headers);
    expect(redacted.authorization).toBe(REDACTED_VALUE);
    expect(redacted.cookie).toBe(`sess=${REDACTED_VALUE}; other=${REDACTED_VALUE}`);
    expect(redacted['user-agent']).toBe('Mozilla/5.0');
    expect(redacted['x-correlation-id']).toBe('corr-123');
  });

  it('redacts Error objects including stack trace and cause', () => {
    const cause = new Error('Database connection failed at postgres://user:secretpw@db.internal:5432/main');
    const err = new Error('Auth failed for user test@domain.com', { cause });
    err.stack =
      'Error: Auth failed for user test@domain.com\n    at login (postgres://user:secretpw@db.internal:5432/main:10:5)';

    const redacted = redact(err) as {
      name: string;
      message: string;
      stack: string;
      cause: { message: string };
    };

    expect(redacted.name).toBe('Error');
    expect(redacted.message).toBe(`Auth failed for user ${REDACTED_EMAIL}`);
    expect(redacted.stack).toContain(REDACTED_EMAIL);
    expect(redacted.stack).toContain(`postgres://user:${REDACTED_VALUE}@db.internal:5432/main`);
    expect(redacted.cause.message).toBe(
      `Database connection failed at postgres://user:${REDACTED_VALUE}@db.internal:5432/main`,
    );
  });

  it('redacts bare secret-bearing message patterns while preserving non-sensitive text', () => {
    // 1. Bare space-delimited secrets
    expect(redactString('password cleartext-value')).toBe(`password ${REDACTED_VALUE}`);
    expect(redactString('secret my-secret-val')).toBe(`secret ${REDACTED_VALUE}`);
    expect(redactString('token my-token-123')).toBe(`token ${REDACTED_VALUE}`);
    expect(redactString('api_key key-secret-999')).toBe(`api_key ${REDACTED_VALUE}`);

    // 2. Bare assignment patterns
    expect(redactString('secret=value')).toBe(`secret=${REDACTED_VALUE}`);
    expect(redactString('token: abc')).toBe(`token: ${REDACTED_VALUE}`);
    expect(redactString('api_key=mykey123')).toBe(`api_key=${REDACTED_VALUE}`);
    expect(redactString('apiKey: secretVal')).toBe(`apiKey: ${REDACTED_VALUE}`);
    expect(redactString('passwd: 12345')).toBe(`passwd: ${REDACTED_VALUE}`);
    expect(redactString('auth_token: bearer_xyz')).toBe(`auth_token: ${REDACTED_VALUE}`);

    // 3. Verb phrase bare secrets
    expect(redactString('password is cleartextPass')).toBe(`password is ${REDACTED_VALUE}`);
    expect(redactString('token set to token_xyz')).toBe(`token set to ${REDACTED_VALUE}`);
    expect(redactString('secret equals super_secret')).toBe(`secret equals ${REDACTED_VALUE}`);

    // 4. Prefixed code secrets
    expect(redactString('error code ERR_TOKEN_xyz123 occurred')).toBe(
      `error code ERR_TOKEN_${REDACTED_VALUE} occurred`,
    );
    expect(redactString('TOKEN_secretVal')).toBe(`TOKEN_${REDACTED_VALUE}`);

    // 5. Preserves legitimate non-sensitive message text
    expect(redactString('User password reset successfully')).toBe('User password reset successfully');
    expect(redactString('Password policy applied to workspace')).toBe('Password policy applied to workspace');
    expect(redactString('Password updated')).toBe('Password updated');
    expect(redactString('token rotation completed')).toBe('token rotation completed');
    expect(redactString('token bucket rate limit reached')).toBe('token bucket rate limit reached');
    expect(redactString('Secret vault storage verified')).toBe('Secret vault storage verified');
  });

  it('redacts Error.code and all custom Error properties', () => {
    const err = new Error('Database operation failed');
    (err as unknown as { code: string }).code = 'ERR_TOKEN_xyz123';
    (err as unknown as { secretPayload: string }).secretPayload = 'sensitive_custom_property';
    (err as unknown as { apiKey: string }).apiKey = 'sk-ant-api03-12345678901234567890';
    Object.defineProperty(err, 'hiddenSecret', {
      value: 'non_enumerable_secret',
      enumerable: false,
      configurable: true,
    });

    const redacted = redact(err) as unknown as Record<string, unknown>;
    expect(redacted.name).toBe('Error');
    expect(redacted.code).toBe(`ERR_TOKEN_${REDACTED_VALUE}`);
    expect(redacted.secretPayload).toBe(REDACTED_VALUE);
    expect(redacted.apiKey).toBe(REDACTED_VALUE);
    expect(redacted.hiddenSecret).toBe(REDACTED_VALUE);

    // Standard non-sensitive error code is preserved
    const standardErr = new Error('File read failure');
    (standardErr as unknown as { code: string }).code = 'ENOENT';
    const redactedStandard = redact(standardErr) as unknown as Record<string, unknown>;
    expect(redactedStandard.code).toBe('ENOENT');
  });

  it('safely handles circular references and depth limits', () => {
    const circular: Record<string, unknown> = { name: 'safe' };
    circular.self = circular;

    const redacted = redact(circular) as { name: string; self: unknown };
    expect(redacted.name).toBe('safe');
    expect(redacted.self).toBe('[Circular]');
  });
});
