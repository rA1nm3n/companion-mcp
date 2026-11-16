export type SatelliteErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'CONNECT_FAILED'
  | 'CONNECT_TIMEOUT'
  | 'HANDSHAKE_TIMEOUT'
  | 'UNSUPPORTED_VERSION'
  | 'PROTOCOL_ERROR'
  | 'LINE_TOO_LONG'
  | 'REQUEST_TIMEOUT'
  | 'COMMAND_REJECTED'
  | 'CONNECTION_LOST'
  | 'PONG_TIMEOUT'
  | 'DEVICE_UNKNOWN'
  | 'SNAPSHOT_TIMEOUT'
  | 'KEY_NOT_FOUND'
  | 'KEY_CHANGED'
  | 'SURFACE_LOCKED';

/** Typed error for every failure of the Satellite client (safety refusals stay `SafetyError`). */
export class SatelliteError extends Error {
  readonly code: SatelliteErrorCode;

  constructor(code: SatelliteErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SatelliteError';
    this.code = code;
  }
}
