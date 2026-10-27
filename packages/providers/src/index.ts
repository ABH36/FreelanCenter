/**
 * @platform/providers
 * Provider interfaces and adapters: domain, payment, email, storage, WhatsApp.
 * Email lands in P1 S4 (auth mail); the others land in Phases 3-7.
 */
export const PACKAGE_NAME = '@platform/providers' as const;

export {
  type CaptureEmailProvider,
  type EmailMessage,
  type EmailProvider,
  type ResendOptions,
  EmailSendError,
  createCaptureProvider,
  createResendProvider,
} from './email';
export {
  type KeyValueConfig,
  type KeyValueStore,
  type MemoryKeyValueStore,
  type UpstashOptions,
  KeyValueError,
  createKeyValueStore,
  createMemoryStore,
  createUpstashStore,
  loadKeyValueConfig,
} from './kv';
