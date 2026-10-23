/**
 * Starts the local signed Inngest executor with fresh random keys and stops it afterwards. The keys reach the
 * tests through `provide`, never the file system.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const compose = fileURLToPath(new URL('../docker/compose.yml', import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    jobsKeys: { eventKey: string; signingKey: string };
  }
}

export default function setup(project: TestProject) {
  const keys = { eventKey: randomBytes(16).toString('hex'), signingKey: randomBytes(32).toString('hex') };
  const env = {
    ...process.env,
    JOBS_SUITE_EVENT_KEY: keys.eventKey,
    JOBS_SUITE_SIGNING_KEY: keys.signingKey,
  };
  execFileSync('docker', ['compose', '-f', compose, 'up', '-d', '--wait', '--force-recreate'], {
    env,
    stdio: 'inherit',
  });
  project.provide('jobsKeys', keys);
  return () => {
    // JOBS_SUITE_LOGS=1 prints the executor log before teardown (debugging a failed run).
    if (process.env.JOBS_SUITE_LOGS === '1') {
      execFileSync('docker', ['compose', '-f', compose, 'logs', '--no-color', '--tail', '80'], {
        env,
        stdio: 'inherit',
      });
    }
    execFileSync('docker', ['compose', '-f', compose, 'down', '-v'], { env, stdio: 'inherit' });
  };
}
