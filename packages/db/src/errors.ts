/** Typed data-access errors. Messages never include connection strings, SQL parameters or tenant data. */

export class DbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A tenant/actor id that is not a UUID. Rejected before it reaches `set_config`. */
export class InvalidScopeError extends DbError {
  constructor(field: string) {
    super('DB_INVALID_SCOPE', `${field} must be a UUID`);
  }
}

/** The bounded transaction queue is full or the wait timed out (Spike B B-3). Callers map this to HTTP 503. */
export class DbBusyError extends DbError {
  constructor() {
    super('DB_BUSY', 'database is busy, retry later');
  }
}

/** The connection authenticated as an unexpected role, or one with SUPERUSER/BYPASSRLS. */
export class UnsafeRoleError extends DbError {
  constructor(message: string) {
    super('DB_UNSAFE_ROLE', message);
  }
}
