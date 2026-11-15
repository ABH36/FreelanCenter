/**
 * Object storage behind one interface (ADR-009: Cloudflare R2; locally and in CI the S3Mock container of
 * packages/db/docker). Plain S3 API over SigV4 (aws4fetch), path-style URLs, no SDK: five calls, fewer dependencies
 * to audit. Two buckets:
 *   - the upload bucket is private: the browser PUTs an original there with a short-lived signed URL, the server
 *     reads it back once, processes it and deletes it;
 *   - the public bucket holds the processed variants, served from `publicUrl` (the asset domain; r2.dev until the
 *     platform domain exists, DG-33).
 * Adapters never log keys, object contents or credentials.
 */
import { AwsClient } from 'aws4fetch';

export interface ObjectStorageConfig {
  /** S3 API endpoint without a bucket, e.g. https://<account>.r2.cloudflarestorage.com. */
  endpoint: string;
  /** `auto` on R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  uploadBucket: string;
  publicBucket: string;
  /** Public base URL of the public bucket (no trailing slash). */
  publicUrl: string;
}

export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the browser must send exactly as given (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** The object is larger than the caller allows; nothing beyond the limit was read. */
export class ObjectTooLargeError extends StorageError {
  constructor() {
    super('object exceeds the size limit');
    this.name = 'ObjectTooLargeError';
  }
}

export interface ObjectStorage {
  readonly name: string;
  /** A signed PUT for one key in the upload bucket, valid for `expiresInSeconds` (60..3600). */
  signUpload(
    key: string,
    input: { contentType: string; contentLength: number; expiresInSeconds?: number },
  ): Promise<SignedUpload>;
  /** Reads an upload, or `null` when it does not exist. Throws ObjectTooLargeError past `maxBytes`. */
  readUpload(key: string, maxBytes: number): Promise<Uint8Array | null>;
  deleteUpload(key: string): Promise<void>;
  /** Reads a public object (a variant, the source of a crop), or `null` when it does not exist. */
  readPublic(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Writes an immutable public object. */
  putPublic(key: string, body: Uint8Array, contentType: string): Promise<void>;
  publicUrl(key: string): string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function checkKey(key: string): string {
  if (!KEY.test(key) || key.includes('..') || key.includes('//'))
    throw new StorageError('invalid object key');
  return key.split('/').map(encodeURIComponent).join('/');
}

function httpsOrLocal(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) throw new Error(`${name} must use https`);
  return url;
}

/**
 * The storage settings from the environment: `null` when none is set (uploads off, like preview links), an error
 * when only some are (a half-configured deployment must fail loudly, not silently drop uploads).
 */
export function loadObjectStorageConfig(
  env: Record<string, string | undefined> = process.env,
): ObjectStorageConfig | null {
  const values = {
    endpoint: env.ASSET_S3_ENDPOINT,
    region: env.ASSET_S3_REGION ?? 'auto',
    accessKeyId: env.ASSET_S3_ACCESS_KEY_ID,
    secretAccessKey: env.ASSET_S3_SECRET_ACCESS_KEY,
    uploadBucket: env.ASSET_UPLOAD_BUCKET,
    publicBucket: env.ASSET_PUBLIC_BUCKET,
    publicUrl: env.ASSET_PUBLIC_URL,
  };
  const required = [
    'endpoint',
    'accessKeyId',
    'secretAccessKey',
    'uploadBucket',
    'publicBucket',
    'publicUrl',
  ] as const;
  const present = required.filter((k) => values[k]);
  if (present.length === 0) return null;
  if (present.length !== required.length) {
    const missing = required.filter((k) => !values[k]);
    throw new Error(`asset storage is partly configured; missing: ${missing.join(', ')}`);
  }
  return values as ObjectStorageConfig;
}

export function createS3Storage(
  config: ObjectStorageConfig,
  options: { fetch?: typeof fetch } = {},
): ObjectStorage {
  const endpoint = httpsOrLocal(config.endpoint, 'ASSET_S3_ENDPOINT');
  const publicBase = httpsOrLocal(config.publicUrl, 'ASSET_PUBLIC_URL').href.replace(/\/+$/, '');
  for (const bucket of [config.uploadBucket, config.publicBucket]) {
    if (!BUCKET.test(bucket)) throw new Error('invalid bucket name');
  }
  const doFetch = options.fetch ?? fetch;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
    retries: 0,
  });
  const base = endpoint.href.replace(/\/+$/, '');
  const objectUrl = (bucket: string, key: string) => `${base}/${bucket}/${checkKey(key)}`;

  async function send(url: string, init: RequestInit): Promise<Response> {
    const signed = await client.sign(url, init);
    return doFetch(signed, { signal: AbortSignal.timeout(30_000) });
  }

  async function fail(res: Response, what: string): Promise<never> {
    await res.body?.cancel().catch(() => undefined);
    throw new StorageError(`storage ${what} failed (${res.status})`, res.status);
  }

  return {
    name: 's3',
    async signUpload(key, input) {
      const expires = input.expiresInSeconds ?? 600;
      if (!Number.isInteger(expires) || expires < 60 || expires > 3600)
        throw new RangeError('expiresInSeconds');
      if (!Number.isInteger(input.contentLength) || input.contentLength < 1)
        throw new RangeError('contentLength');
      const url = new URL(objectUrl(config.uploadBucket, key));
      url.searchParams.set('X-Amz-Expires', String(expires));
      const headers = { 'content-type': input.contentType, 'content-length': String(input.contentLength) };
      // allHeaders: the type and the exact length are part of the signature, so the bucket refuses any other
      // file than the one the server agreed to (R2 checks; the server checks again when it reads it back).
      const signed = await client.sign(url.href, {
        method: 'PUT',
        headers,
        aws: { signQuery: true, allHeaders: true },
      });
      return {
        url: signed.url,
        method: 'PUT',
        headers: { 'content-type': input.contentType },
        expiresAt: new Date(Date.now() + expires * 1000),
      };
    },
    readUpload: (key, maxBytes) => readObject(config.uploadBucket, key, maxBytes),
    readPublic: (key, maxBytes) => readObject(config.publicBucket, key, maxBytes),
    async deleteUpload(key) {
      const res = await send(objectUrl(config.uploadBucket, key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) return fail(res, 'delete');
      await res.body?.cancel().catch(() => undefined);
    },
    async putPublic(key, body, contentType) {
      const res = await send(objectUrl(config.publicBucket, key), {
        method: 'PUT',
        // DOM lib types want an ArrayBuffer-backed view; a copy is cheap next to the encode.
        body: new Uint8Array(body),
        headers: {
          'content-type': contentType,
          // Variants never change: a new image is a new key (ADR-009).
          'cache-control': 'public, max-age=31536000, immutable',
          'content-disposition': 'inline',
        },
      });
      if (!res.ok) return fail(res, 'write');
      await res.body?.cancel().catch(() => undefined);
    },
    publicUrl(key) {
      return `${publicBase}/${checkKey(key)}`;
    },
  };

  async function readObject(bucket: string, key: string, maxBytes: number): Promise<Uint8Array | null> {
    const res = await send(objectUrl(bucket, key), { method: 'GET' });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!res.ok) return fail(res, 'read');
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new ObjectTooLargeError();
    }
    // Read with a running count: a missing or wrong Content-Length cannot make us buffer more than maxBytes.
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ObjectTooLargeError();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

/** In-memory storage for unit tests. */
export interface MemoryObjectStorage extends ObjectStorage {
  readonly uploads: Map<string, Uint8Array>;
  readonly objects: Map<string, { body: Uint8Array; contentType: string }>;
}

export function createMemoryStorage(publicUrl = 'https://assets.example.test'): MemoryObjectStorage {
  const uploads = new Map<string, Uint8Array>();
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    name: 'memory',
    uploads,
    objects,
    async signUpload(key, input) {
      checkKey(key);
      return {
        url: `memory://uploads/${key}`,
        method: 'PUT',
        headers: { 'content-type': input.contentType },
        expiresAt: new Date(Date.now() + (input.expiresInSeconds ?? 600) * 1000),
      };
    },
    async readUpload(key, maxBytes) {
      const body = uploads.get(checkKey(key)) ?? null;
      if (body && body.byteLength > maxBytes) throw new ObjectTooLargeError();
      return body;
    },
    async deleteUpload(key) {
      uploads.delete(checkKey(key));
    },
    async readPublic(key, maxBytes) {
      const body = objects.get(checkKey(key))?.body ?? null;
      if (body && body.byteLength > maxBytes) throw new ObjectTooLargeError();
      return body;
    },
    async putPublic(key, body, contentType) {
      objects.set(checkKey(key), { body, contentType });
    },
    publicUrl(key) {
      return `${publicUrl}/${checkKey(key)}`;
    },
  };
}
