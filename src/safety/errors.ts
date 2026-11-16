export type SafetyErrorCode =
  | 'WRITE_DISABLED'
  | 'HOST_NOT_ALLOWED'
  | 'PRESS_NOT_ALLOWED'
  | 'CONFIG_INVALID'
  | 'SNAPSHOT_INVALID';

/** Typed error for every refusal of the safety layer. Messages never contain tokens. */
export class SafetyError extends Error {
  readonly code: SafetyErrorCode;

  constructor(code: SafetyErrorCode, message: string) {
    super(message);
    this.name = 'SafetyError';
    this.code = code;
  }
}
