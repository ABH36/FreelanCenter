import { describe, expect, it } from 'vitest';
import {
  ObjectTooLargeError,
  StorageError,
  createMemoryStorage,
  createS3Storage,
  loadObjectStorageConfig,
} from './storage';

const config = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  uploadBucket: 'uploads',
  publicBucket: 'assets',
  publicUrl: 'https://pub-123.r2.dev/',
};

function storage(reply: (req: Request) => Response = () => new Response(null, { status: 200 })) {
  const calls: Request[] = [];
  const s = createS3Storage(config, {
    fetch: async (input) => {
      const req = input as Request;
      calls.push(req);
      return reply(req);
    },
  });
  return { s, calls };
}

describe('S3 storage adapter (ADR-009)', () => {
  it('signs an upload URL for the private bucket that covers the type and the exact length', async () => {
    const { s } = storage();
    const signed = await s.signUpload('uploads/ws/w/a/t', {
      contentType: 'image/jpeg',
      contentLength: 1234,
      expiresInSeconds: 600,
    });
    const url = new URL(signed.url);
    expect(url.origin + url.pathname).toBe(
      'https://account.r2.cloudflarestorage.com/uploads/uploads/ws/w/a/t',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers).toEqual({ 'content-type': 'image/jpeg' });
    expect(signed.url).not.toContain('secret-example');
    await expect(
      s.signUpload('k', { contentType: 'image/png', contentLength: 1, expiresInSeconds: 5 }),
    ).rejects.toThrow(RangeError);
  });

  it('refuses keys that could escape their prefix', async () => {
    const { s } = storage();
    for (const key of ['../x', 'a/../b', '/abs', 'a//b', 'a b', '']) {
      await expect(s.readUpload(key, 10), key).rejects.toBeInstanceOf(StorageError);
    }
  });

  it('reads an upload with a byte cap, whatever Content-Length says', async () => {
    const big = new Uint8Array(50);
    const { s } = storage(() => new Response(big, { status: 200 }));
    await expect(s.readUpload('k', 100)).resolves.toHaveLength(50);
    await expect(s.readUpload('k', 10)).rejects.toBeInstanceOf(ObjectTooLargeError);
    // A stream without a length header is counted as it arrives.
    const streamed = storage(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(10));
              c.close();
            },
          }),
        ),
    );
    await expect(streamed.s.readUpload('k', 20)).rejects.toBeInstanceOf(ObjectTooLargeError);
  });

  it('a missing upload is null; other failures are errors without the key', async () => {
    expect(
      await storage(() => new Response(null, { status: 404 })).s.readUpload('secret/key', 10),
    ).toBeNull();
    const err = await storage(() => new Response('denied', { status: 403 }))
      .s.readUpload('secret/key', 10)
      .then(
        () => null,
        (e: unknown) => e as StorageError,
      );
    expect(err).toBeInstanceOf(StorageError);
    expect(err?.message).not.toContain('secret');
  });

  it('writes public variants immutable and inline, signed (over TLS)', async () => {
    const { s, calls } = storage();
    await s.putPublic('ws/w/a/t/400.webp', new Uint8Array([1, 2]), 'image/webp');
    const req = calls[0]!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://account.r2.cloudflarestorage.com/assets/ws/w/a/t/400.webp');
    expect(req.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(req.headers.get('content-type')).toBe('image/webp');
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(req.headers.get('x-amz-content-sha256')).toBeTruthy();
    expect(s.publicUrl('ws/w/a/t/400.webp')).toBe('https://pub-123.r2.dev/ws/w/a/t/400.webp');
  });

  it('needs https outside local hosts', () => {
    expect(() => createS3Storage({ ...config, endpoint: 'http://r2.example.com' })).toThrow(/https/);
    expect(() => createS3Storage({ ...config, publicUrl: 'http://cdn.example.com' })).toThrow(/https/);
    expect(() =>
      createS3Storage({
        ...config,
        endpoint: 'http://127.0.0.1:59090',
        publicUrl: 'http://127.0.0.1:59090/assets',
      }),
    ).not.toThrow();
  });
});

describe('loadObjectStorageConfig', () => {
  const env = {
    ASSET_S3_ENDPOINT: config.endpoint,
    ASSET_S3_ACCESS_KEY_ID: 'a',
    ASSET_S3_SECRET_ACCESS_KEY: 'b',
    ASSET_UPLOAD_BUCKET: 'uploads',
    ASSET_PUBLIC_BUCKET: 'assets',
    ASSET_PUBLIC_URL: 'https://pub.r2.dev',
  };
  it('is off when nothing is set, complete when everything is, and an error in between', () => {
    expect(loadObjectStorageConfig({})).toBeNull();
    expect(loadObjectStorageConfig(env)).toMatchObject({ region: 'auto', uploadBucket: 'uploads' });
    expect(() => loadObjectStorageConfig({ ...env, ASSET_PUBLIC_URL: undefined })).toThrow(/ASSET|publicUrl/);
  });
});

describe('memory storage', () => {
  it('keeps uploads and public objects apart', async () => {
    const m = createMemoryStorage();
    m.uploads.set('u/1', new Uint8Array(3));
    expect(await m.readUpload('u/1', 3)).toHaveLength(3);
    await expect(m.readUpload('u/1', 2)).rejects.toBeInstanceOf(ObjectTooLargeError);
    await m.deleteUpload('u/1');
    expect(await m.readUpload('u/1', 3)).toBeNull();
    await m.putPublic('p/1.webp', new Uint8Array(1), 'image/webp');
    expect(m.objects.has('p/1.webp')).toBe(true);
  });
});
