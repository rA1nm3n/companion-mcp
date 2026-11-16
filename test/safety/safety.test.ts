import { describe, expect, it } from 'vitest';
import {
  assertHostAllowed,
  assertPressAllowed,
  assertWriteAllowed,
  loadSafetyConfig,
  SafetyError,
  type SafetyConfig,
} from '../../src/safety/index.js';

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SafetyError);
    expect((error as SafetyError).code).toBe(code);
    return;
  }
  throw new Error(`expected SafetyError ${code}`);
}

describe('loadSafetyConfig', () => {
  it('defaults: writes off, loopback hosts only, no press restriction', () => {
    expect(loadSafetyConfig({})).toEqual({
      writeEnabled: false,
      allowedHosts: ['127.0.0.1', 'localhost', '::1'],
      pressAllow: null,
    });
  });

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    [' 1 ', true],
    ['0', false],
    ['false', false],
    ['', false],
    ['yes', false],
    ['2', false],
  ])('COMPANION_MCP_WRITE=%j gives writeEnabled=%s', (raw, expected) => {
    expect(loadSafetyConfig({ COMPANION_MCP_WRITE: raw }).writeEnabled).toBe(expected);
  });

  it('parses, trims, lower-cases and de-duplicates the host list', () => {
    const config = loadSafetyConfig({
      COMPANION_MCP_ALLOWED_HOSTS: ' Companion.Example.test , 192.0.2.10,[::1],192.0.2.10 ',
    });
    expect(config.allowedHosts).toEqual(['companion.example.test', '192.0.2.10', '::1']);
  });

  it('falls back to the defaults for an empty or blank host list', () => {
    expect(loadSafetyConfig({ COMPANION_MCP_ALLOWED_HOSTS: '' }).allowedHosts).toEqual([
      '127.0.0.1',
      'localhost',
      '::1',
    ]);
    expect(loadSafetyConfig({ COMPANION_MCP_ALLOWED_HOSTS: ' , ' }).allowedHosts).toEqual([
      '127.0.0.1',
      'localhost',
      '::1',
    ]);
  });

  it('parses the press allow-list', () => {
    expect(loadSafetyConfig({ COMPANION_MCP_PRESS_ALLOW: '1/0/0, 2/3/7' }).pressAllow).toEqual([
      { page: 1, row: 0, column: 0 },
      { page: 2, row: 3, column: 7 },
    ]);
  });

  it.each(['1/0', 'a/b/c', '1/0/0/0', '0/1/1', '1/-1/0', '1/0/0,,'])(
    'fails closed on malformed press entry %j',
    (raw) => {
      expectCode(() => loadSafetyConfig({ COMPANION_MCP_PRESS_ALLOW: raw }), 'CONFIG_INVALID');
    },
  );
});

describe('gate', () => {
  const open: SafetyConfig = loadSafetyConfig({
    COMPANION_MCP_WRITE: '1',
    COMPANION_MCP_ALLOWED_HOSTS: '127.0.0.1,localhost,::1,studio.example.test',
  });
  const readOnly = loadSafetyConfig({});

  it('refuses writes by default', () => {
    expectCode(() => assertWriteAllowed(readOnly, '127.0.0.1'), 'WRITE_DISABLED');
  });

  it('allows writes to loopback hosts with the flag set, from URLs and bare hosts', () => {
    const config = loadSafetyConfig({ COMPANION_MCP_WRITE: '1' });
    for (const target of [
      '127.0.0.1',
      'localhost',
      '::1',
      '[::1]',
      'http://127.0.0.1:8000',
      'ws://localhost:8000/trpc',
      'http://[::1]:8000/',
      'LOCALHOST:8000',
    ]) {
      expect(() => assertWriteAllowed(config, target)).not.toThrow();
    }
  });

  it('refuses writes to hosts outside the allow-list even with the flag set', () => {
    const config = loadSafetyConfig({ COMPANION_MCP_WRITE: '1' });
    expectCode(() => assertWriteAllowed(config, '192.0.2.50'), 'HOST_NOT_ALLOWED');
    expectCode(() => assertWriteAllowed(config, 'http://192.0.2.50:8000'), 'HOST_NOT_ALLOWED');
  });

  it('does not match host prefixes or suffixes', () => {
    const config = loadSafetyConfig({ COMPANION_MCP_WRITE: '1' });
    expectCode(() => assertWriteAllowed(config, 'localhost.evil.test'), 'HOST_NOT_ALLOWED');
    expectCode(() => assertWriteAllowed(config, '127.0.0.10'), 'HOST_NOT_ALLOWED');
    expectCode(() => assertWriteAllowed(config, 'http://127.0.0.1@evil.test/'), 'HOST_NOT_ALLOWED');
  });

  it('honors a custom allow-list that replaces the defaults', () => {
    const config = loadSafetyConfig({
      COMPANION_MCP_WRITE: '1',
      COMPANION_MCP_ALLOWED_HOSTS: 'studio.example.test',
    });
    expect(() => assertWriteAllowed(config, 'http://studio.example.test:8000')).not.toThrow();
    expectCode(() => assertWriteAllowed(config, '127.0.0.1'), 'HOST_NOT_ALLOWED');
  });

  it('checks the host alone with assertHostAllowed (no write flag needed)', () => {
    expect(() => assertHostAllowed(readOnly, 'localhost')).not.toThrow();
    expectCode(() => assertHostAllowed(readOnly, 'studio.example.test'), 'HOST_NOT_ALLOWED');
  });

  it('rejects an empty or invalid target', () => {
    expectCode(() => assertHostAllowed(open, ''), 'CONFIG_INVALID');
    expectCode(() => assertHostAllowed(open, 'http://'), 'CONFIG_INVALID');
  });

  describe('assertPressAllowed', () => {
    const location = { page: 1, row: 0, column: 0 };

    it('needs the write gate first', () => {
      expectCode(() => assertPressAllowed(readOnly, '127.0.0.1', location), 'WRITE_DISABLED');
    });

    it('allows any button when no press list is configured', () => {
      expect(() =>
        assertPressAllowed(open, '127.0.0.1', { page: 9, row: 3, column: 7 }),
      ).not.toThrow();
    });

    it('allows only listed buttons when the list is configured', () => {
      const config = loadSafetyConfig({
        COMPANION_MCP_WRITE: '1',
        COMPANION_MCP_PRESS_ALLOW: '1/0/0,2/1/1',
      });
      expect(() => assertPressAllowed(config, 'localhost', location)).not.toThrow();
      expect(() =>
        assertPressAllowed(config, 'localhost', { page: 2, row: 1, column: 1 }),
      ).not.toThrow();
      expectCode(
        () => assertPressAllowed(config, 'localhost', { page: 1, row: 0, column: 1 }),
        'PRESS_NOT_ALLOWED',
      );
      expectCode(
        () => assertPressAllowed(config, 'localhost', { page: 2, row: 0, column: 0 }),
        'PRESS_NOT_ALLOWED',
      );
    });

    it('still checks the host', () => {
      const config = loadSafetyConfig({ COMPANION_MCP_WRITE: '1' });
      expectCode(() => assertPressAllowed(config, '192.0.2.50', location), 'HOST_NOT_ALLOWED');
    });
  });
});
