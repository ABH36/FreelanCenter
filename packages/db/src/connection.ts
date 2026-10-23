/**
 * `pg` connection settings shared by the runtime clients and the Node scripts (self-contained for type stripping).
 *
 * TLS: local Docker URLs use no TLS. Every other host requires TLS; when `DATABASE_SSL_ROOT_CERT` names a PEM
 * file (Supabase publishes its CA certificate), the server certificate is verified against it. Without it the
 * URL's own `sslmode` decides, and a remote URL without any `sslmode` is rejected rather than silently
 * connecting in plaintext.
 *
 * Serverless deployments (Vercel) have no file to point at, so `DATABASE_SSL_ROOT_CERT` may instead name a pinned
 * CA bundled below. The certificate is public; pinning it in code means a changed CA fails loudly.
 */
import { readFileSync } from 'node:fs';
import type { ClientConfig } from 'pg';

/**
 * Supabase Root 2021 CA (valid until 2031-04-26). SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:
 * F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA, confirmed by the Owner against the Supabase dashboard download on 2026-10-22
 * (S1 report, open decision 1) and asserted by the unit tests.
 */
export const PINNED_CAS: Record<string, string> = {
  'supabase-root-2021': `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`,
};

export function connectionConfig(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): ClientConfig {
  const url = new URL(connectionString);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (local) return { connectionString };

  const caSetting = env.DATABASE_SSL_ROOT_CERT;
  if (caSetting) {
    url.searchParams.delete('sslmode');
    const ca = PINNED_CAS[caSetting] ?? readFileSync(caSetting, 'utf8');
    return { connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true } };
  }
  if (!url.searchParams.has('sslmode')) {
    throw new Error('remote database URLs need DATABASE_SSL_ROOT_CERT or an explicit sslmode parameter');
  }
  return { connectionString };
}
