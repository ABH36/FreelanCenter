/**
 * SCRAM-SHA-256 password verifier (RFC 5802 / RFC 7677) in the format PostgreSQL stores in `pg_authid`.
 * The bootstrap script sends this verifier instead of a plaintext password, so the password never reaches
 * server-side statement logs (SEC-05). Self-contained for Node type stripping.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_ITERATIONS = 4096;

export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  // PostgreSQL applies SASLprep; generated passwords are printable ASCII, for which SASLprep is the identity.
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('database passwords must be printable ASCII without spaces');
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
