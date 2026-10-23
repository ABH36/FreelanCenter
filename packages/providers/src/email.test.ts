import { describe, expect, it } from 'vitest';
import { EmailSendError, createCaptureProvider, createResendProvider } from './email';

const message = { to: 'a@example.test', subject: 'S', text: 'T', kind: 'auth.verify_email' };

describe('Resend adapter', () => {
  it('posts one message with the sender, bearer key and idempotency key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = createResendProvider({
      apiKey: 're_test',
      from: 'Platform <no-reply@mail.example.test>',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Response.json({ id: 'msg_1' });
      },
    });
    await expect(provider.send({ ...message, idempotencyKey: 'k1' })).resolves.toEqual({ id: 'msg_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    expect(headers['idempotency-key']).toBe('k1');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ from: 'Platform <no-reply@mail.example.test>', to: ['a@example.test'] });
    expect(body).not.toHaveProperty('kind');
  });

  it('throws EmailSendError with the status on a rejected send', async () => {
    const provider = createResendProvider({
      apiKey: 're_test',
      from: 'x@example.test',
      fetch: async () => new Response('{"message":"domain is not verified"}', { status: 403 }),
    });
    const error = await provider.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).status).toBe(403);
  });

  it('refuses to start without a key or sender', () => {
    expect(() => createResendProvider({ apiKey: '', from: 'x@example.test' })).toThrow(/API key/);
    expect(() => createResendProvider({ apiKey: 're_x', from: '' })).toThrow(/EMAIL_FROM/);
  });
});

describe('capture sink', () => {
  it('records messages and can be cleared', async () => {
    const seen: string[] = [];
    const sink = createCaptureProvider((m) => seen.push(m.kind));
    await sink.send(message);
    expect(sink.sent).toHaveLength(1);
    expect(seen).toEqual(['auth.verify_email']);
    sink.clear();
    expect(sink.sent).toHaveLength(0);
  });
});
