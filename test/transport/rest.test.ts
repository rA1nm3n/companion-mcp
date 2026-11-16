import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RestV2Client } from '../../src/transport/index.js';

describe('RestV2Client', () => {
  let http: Server;
  let base: string;
  let lastAuth: string | undefined;
  let mode: 'ok' | 'disabled' | 'unauthorized' | 'forbidden' | 'error500' | 'notjson' = 'ok';

  beforeEach(async () => {
    mode = 'ok';
    lastAuth = undefined;
    http = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      const send = (status: number, body: unknown): void => {
        res.statusCode = status;
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (mode === 'disabled')
        return send(403, { error: { code: 'API_DISABLED', message: 'REST API is disabled' } });
      if (mode === 'unauthorized')
        return send(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
      if (mode === 'forbidden')
        return send(403, {
          error: { code: 'FORBIDDEN', message: "Insufficient scope: requires 'read'" },
        });
      if (mode === 'error500')
        return send(500, {
          error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
        });
      if (mode === 'notjson') return send(200, 'nope');
      if (req.url === '/api/v2/connections/v1')
        return send(200, { data: [{ id: 'c1' }], meta: { total: 1 } });
      if (req.url === '/api/v2/surfaces/v1')
        return send(200, { data: [{ id: 's1' }, 'junk'], meta: {} });
      if (req.url === '/api/v2/openapi.json') return send(200, { openapi: '3.0.3' });
      return send(404, { error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it('lists connections with a Bearer token', async () => {
    const client = new RestV2Client(base, 'cpn_testtoken');
    expect(await client.listConnections()).toEqual([{ id: 'c1' }]);
    expect(lastAuth).toBe('Bearer cpn_testtoken');
  });

  it('lists surfaces and drops non-object entries', async () => {
    expect(await new RestV2Client(base, 'cpn_t').listSurfaces()).toEqual([{ id: 's1' }]);
  });

  it('reads the OpenAPI document without a token', async () => {
    const client = new RestV2Client(base);
    expect(await client.getOpenApi()).toEqual({ openapi: '3.0.3' });
    expect(lastAuth).toBeUndefined();
  });

  it('requires a token for authenticated calls before any request', async () => {
    await expect(new RestV2Client(base).listConnections()).rejects.toMatchObject({
      code: 'REST_UNAUTHORIZED',
    });
    expect(lastAuth).toBeUndefined();
  });

  it('reports 403 API_DISABLED clearly as REST_DISABLED', async () => {
    mode = 'disabled';
    const error = await new RestV2Client(base, 'cpn_t').listConnections().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'REST_DISABLED', status: 403, remoteCode: 'API_DISABLED' });
    expect((error as Error).message).toContain('REST API disabled');
  });

  it('maps 401 and scope 403', async () => {
    mode = 'unauthorized';
    await expect(new RestV2Client(base, 'cpn_t').listConnections()).rejects.toMatchObject({
      code: 'REST_UNAUTHORIZED',
    });
    mode = 'forbidden';
    await expect(new RestV2Client(base, 'cpn_t').listConnections()).rejects.toMatchObject({
      code: 'REST_FORBIDDEN',
    });
  });

  it('maps the measured 500 (connection without updatePolicy) to HTTP_ERROR', async () => {
    mode = 'error500';
    await expect(new RestV2Client(base, 'cpn_t').listConnections()).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 500,
      remoteCode: 'INTERNAL_ERROR',
    });
  });

  it('rejects a non-JSON success body', async () => {
    mode = 'notjson';
    await expect(new RestV2Client(base, 'cpn_t').listConnections()).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('never puts the token into error messages', async () => {
    mode = 'error500';
    const error = (await new RestV2Client(base, 'cpn_secret123')
      .listConnections()
      .catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain('cpn_secret123');
  });

  it('wraps connection failures and invalid base URLs', async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await expect(
      new RestV2Client(base, 'cpn_t', { timeoutMs: 500 }).listConnections(),
    ).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });
    expect(() => new RestV2Client('nonsense')).toThrowError(/Invalid base URL/);
    expect(() => new RestV2Client('ftp://x')).toThrowError(/scheme/);
    http = createServer();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  });
});
