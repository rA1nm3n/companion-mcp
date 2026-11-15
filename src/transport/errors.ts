export type TransportErrorCode =
  | 'NOT_CONNECTED'
  | 'CONNECT_FAILED'
  | 'CLOSED'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'REMOTE_ERROR'
  | 'VERSION_UNSUPPORTED'
  | 'IMPORT_IN_PROGRESS'
  | 'IMPORT_FAILED'
  | 'IMPORT_CONNECTION_LOST'
  | 'RECONNECT_FORBIDDEN'
  | 'INVALID_ARGUMENT'
  | 'HTTP_ERROR'
  | 'REST_DISABLED'
  | 'REST_UNAUTHORIZED'
  | 'REST_FORBIDDEN';

export interface TransportErrorDetails {
  /** tRPC procedure path (`importExport.importSinglePage`) or HTTP path. */
  path?: string;
  /** Code reported by the remote side (`INTERNAL_SERVER_ERROR`, `API_DISABLED`, ...). */
  remoteCode?: string;
  /** HTTP status, if any. */
  status?: number;
  cause?: unknown;
}

/** Typed error for the live layer. Messages never contain tokens. */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly path: string | undefined;
  readonly remoteCode: string | undefined;
  readonly status: number | undefined;

  constructor(code: TransportErrorCode, message: string, details: TransportErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'TransportError';
    this.code = code;
    this.path = details.path;
    this.remoteCode = details.remoteCode;
    this.status = details.status;
  }
}
