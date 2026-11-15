import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_COMPANION_URL, loadConfig } from '../../src/config.js';
import { SafetyError } from '../../src/safety/index.js';

describe('loadConfig', () => {
  it('has safe defaults: local Companion, no token, version guard on, writes off', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      url: DEFAULT_COMPANION_URL,
      restToken: undefined,
      allowUnknownVersion: false,
      safety: {
        writeEnabled: false,
        allowedHosts: ['127.0.0.1', 'localhost', '::1'],
        pressAllow: null,
      },
    });
  });

  it('reads all variables, including the safety ones', () => {
    const config = loadConfig({
      COMPANION_URL: ' http://studio-pc.example:8001/ignored/path ',
      COMPANION_REST_TOKEN: 'cpn_abc',
      COMPANION_MCP_ALLOW_UNKNOWN_VERSION: 'TRUE',
      COMPANION_MCP_WRITE: '1',
      COMPANION_MCP_ALLOWED_HOSTS: 'studio-pc.example',
      COMPANION_MCP_PRESS_ALLOW: '1/0/0',
    });
    expect(config.url).toBe('http://studio-pc.example:8001');
    expect(config.restToken).toBe('cpn_abc');
    expect(config.allowUnknownVersion).toBe(true);
    expect(config.safety).toMatchObject({
      writeEnabled: true,
      allowedHosts: ['studio-pc.example'],
      pressAllow: [{ page: 1, row: 0, column: 0 }],
    });
  });

  it('treats an empty token as unset and anything but 1/true as false', () => {
    const config = loadConfig({
      COMPANION_REST_TOKEN: '  ',
      COMPANION_MCP_ALLOW_UNKNOWN_VERSION: 'yes',
    });
    expect(config.restToken).toBeUndefined();
    expect(config.allowUnknownVersion).toBe(false);
  });

  it('strips credentials from the URL and never echoes an invalid value', () => {
    expect(loadConfig({ COMPANION_URL: 'http://user:pw@127.0.0.1:8000' }).url).toBe(
      'http://127.0.0.1:8000',
    );
    for (const bad of ['not a url', 'ftp://127.0.0.1', 'http://user:hunter2@']) {
      let error: unknown;
      try {
        loadConfig({ COMPANION_URL: bad });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('hunter2');
      expect((error as Error).message).not.toContain(bad);
    }
  });

  it('fails closed on a malformed press allow-list', () => {
    expect(() => loadConfig({ COMPANION_MCP_PRESS_ALLOW: 'nonsense' })).toThrow(SafetyError);
  });
});
