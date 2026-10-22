/**
 * `pg` connection settings shared by the runtime clients and the Node scripts (self-contained for type stripping).
 *
 * TLS: local Docker URLs use no TLS. Every other host requires TLS; when `DATABASE_SSL_ROOT_CERT` names a PEM
 * file (Supabase publishes its CA certificate), the server certificate is verified against it. Without it the
 * URL's own `sslmode` decides, and a remote URL without any `sslmode` is rejected rather than silently
 * connecting in plaintext.
 */
import { readFileSync } from 'node:fs';
import type { ClientConfig } from 'pg';

export function connectionConfig(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): ClientConfig {
  const url = new URL(connectionString);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (local) return { connectionString };

  const caPath = env.DATABASE_SSL_ROOT_CERT;
  if (caPath) {
    url.searchParams.delete('sslmode');
    return {
      connectionString: url.toString(),
      ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
    };
  }
  if (!url.searchParams.has('sslmode')) {
    throw new Error('remote database URLs need DATABASE_SSL_ROOT_CERT or an explicit sslmode parameter');
  }
  return { connectionString };
}
