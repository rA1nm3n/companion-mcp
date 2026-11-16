import { isJsonObject, type JsonObject, type JsonValue } from '../safety/json.js';
import { TransportError } from './errors.js';

export interface RestOptions {
  /** Request timeout. Default 10000 ms. */
  timeoutMs?: number;
}

/**
 * Client for Companion REST API v2 (`/api/v2`, Bearer token `cpn_...`). It is off by default and covers only
 * connections and surfaces in 5.1.3 (measured via its OpenAPI document). The token is never logged or put
 * into error messages.
 */
export class RestV2Client {
  readonly #base: string;
  readonly #token: string | undefined;
  readonly #timeoutMs: number;

  constructor(baseUrl: string, token?: string, options: RestOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch (cause) {
      throw new TransportError('INVALID_ARGUMENT', 'Invalid base URL', { cause });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TransportError('INVALID_ARGUMENT', `Unsupported URL scheme: ${parsed.protocol}`);
    }
    this.#base = `${parsed.protocol}//${parsed.host}/api/v2`;
    this.#token = token;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async #get(path: string, auth: boolean): Promise<JsonValue> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) {
      if (this.#token === undefined || this.#token === '') {
        throw new TransportError('REST_UNAUTHORIZED', 'This call needs an API token (cpn_...)');
      }
      headers['Authorization'] = `Bearer ${this.#token}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, {
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new TransportError(
        timedOut ? 'TIMEOUT' : 'HTTP_ERROR',
        timedOut
          ? `Timeout after ${this.#timeoutMs} ms: /api/v2${path}`
          : `HTTP request failed: /api/v2${path}`,
        { path, cause },
      );
    }
    const text = await response.text();
    let body: JsonValue | undefined;
    try {
      body = JSON.parse(text) as JsonValue;
    } catch {
      body = undefined;
    }
    if (!response.ok) throw this.#toError(response.status, body, path);
    if (body === undefined) {
      throw new TransportError('PROTOCOL', `Response of /api/v2${path} is not JSON`, {
        path,
        status: response.status,
      });
    }
    return body;
  }

  #toError(status: number, body: JsonValue | undefined, path: string): TransportError {
    let remoteCode: string | undefined;
    let message = '';
    if (body !== undefined && isJsonObject(body) && isJsonObject(body['error'])) {
      const err = body['error'];
      if (typeof err['code'] === 'string') remoteCode = err['code'];
      if (typeof err['message'] === 'string') message = err['message'];
    }
    const details = { path, status, ...(remoteCode === undefined ? {} : { remoteCode }) };
    if (status === 403 && remoteCode === 'API_DISABLED') {
      return new TransportError(
        'REST_DISABLED',
        'REST API disabled: enable it in the Companion settings (config key rest_api_enabled) before using it.',
        details,
      );
    }
    if (status === 401) {
      return new TransportError('REST_UNAUTHORIZED', 'Missing or invalid API token', details);
    }
    if (status === 403) {
      return new TransportError(
        'REST_FORBIDDEN',
        message || 'Token lacks the required scope',
        details,
      );
    }
    return new TransportError(
      'HTTP_ERROR',
      `HTTP ${status} for /api/v2${path}${message === '' ? '' : `: ${message}`}`,
      details,
    );
  }

  /** `GET /connections/v1`. Note (measured): connections without `updatePolicy` make this fail with 500. */
  async listConnections(): Promise<JsonObject[]> {
    return this.#list('/connections/v1');
  }

  async listSurfaces(): Promise<JsonObject[]> {
    return this.#list('/surfaces/v1');
  }

  async #list(path: string): Promise<JsonObject[]> {
    const body = await this.#get(path, true);
    if (!isJsonObject(body) || !Array.isArray(body['data'])) {
      throw new TransportError('PROTOCOL', `Unexpected response shape for /api/v2${path}`, {
        path,
      });
    }
    return body['data'].filter((entry): entry is JsonObject => isJsonObject(entry));
  }

  /** `GET /openapi.json` needs no token but the API must be enabled. */
  async getOpenApi(): Promise<JsonObject> {
    const body = await this.#get('/openapi.json', false);
    if (!isJsonObject(body)) {
      throw new TransportError('PROTOCOL', 'OpenAPI document is not an object', {
        path: '/openapi.json',
      });
    }
    return body;
  }
}
