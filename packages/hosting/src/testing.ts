/**
 * The local Upstash REST emulator of the Docker stack (packages/db/docker/compose.yml: serverless-redis-http in
 * front of Redis). Fixed local values bound to 127.0.0.1; synthetic data only. Never used by a deployment.
 */
export const LOCAL_UPSTASH = { url: 'http://127.0.0.1:58079', token: 'local-srh-token' } as const;
