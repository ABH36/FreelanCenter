/**
 * Transactional email behind one interface (ADR-012 working assumption: Resend; local development uses a
 * capture sink, never real sends). Adapters never log message bodies: they carry single-use tokens.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable per logical message, so a retried send is delivered once by the provider. */
  idempotencyKey?: string;
  /** Machine-readable kind for tests and metrics, e.g. `auth.verify_email`. Not sent to the provider. */
  kind: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ id: string }>;
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

export interface ResendOptions {
  apiKey: string;
  /** Verified sending identity, e.g. `Platform <no-reply@mail.example.com>` (DG-10). */
  from: string;
  /** Defaults to the public Resend API. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Resend over its REST API (no SDK: one endpoint, fewer dependencies to audit). */
export function createResendProvider(options: ResendOptions): EmailProvider {
  if (!options.apiKey) throw new Error('Resend API key is required');
  if (!options.from) throw new Error('Resend sender (EMAIL_FROM) is required');
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.baseUrl ?? 'https://api.resend.com'}/emails`;
  return {
    name: 'resend',
    async send(message) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      };
      if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey;
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        // The error body names the problem (unverified domain, bad key); it never echoes the message.
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new EmailSendError(`resend rejected the message (${res.status}): ${detail}`, res.status);
      }
      const json = (await res.json()) as { id?: string };
      return { id: json.id ?? '' };
    },
  };
}

/** In-memory sink for tests and local development. */
export interface CaptureEmailProvider extends EmailProvider {
  readonly sent: readonly EmailMessage[];
  clear(): void;
}

export function createCaptureProvider(onSend?: (message: EmailMessage) => void): CaptureEmailProvider {
  const sent: EmailMessage[] = [];
  let seq = 0;
  return {
    name: 'capture',
    sent,
    clear() {
      sent.length = 0;
    },
    async send(message) {
      sent.push(message);
      onSend?.(message);
      return { id: `capture-${++seq}` };
    },
  };
}
