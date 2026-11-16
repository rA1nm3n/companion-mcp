import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  createSnapshot,
  loadSafetyConfig,
  planPageImport,
  planRollback,
  planWrite,
  SafetyError,
  verifySnapshot,
  type JsonObject,
} from '../../src/safety/index.js';

const pageExport: JsonObject = { version: 12, type: 'page', page: { name: 'P', controls: {} } };
const fullExport: JsonObject = { version: 12, type: 'full', pages: {} };
const fixedNow = (): Date => new Date('2026-01-02T03:04:05.000Z');

describe('planWrite', () => {
  it('is a dry run listing the operations, blocked by default', () => {
    const plan = planWrite(loadSafetyConfig({}), 'http://127.0.0.1:8000', [
      { kind: 'readback', description: 'x' },
    ]);
    expect(plan).toMatchObject({
      dryRun: true,
      host: '127.0.0.1',
      wouldBeAllowed: false,
      blockedBy: ['WRITE_DISABLED'],
    });
    expect(plan.operations).toHaveLength(1);
  });

  it('lists every blocking gate and is allowed when none applies', () => {
    const blocked = planWrite(loadSafetyConfig({}), '192.0.2.50', []);
    expect(blocked.blockedBy).toEqual(['WRITE_DISABLED', 'HOST_NOT_ALLOWED']);
    const ok = planWrite(loadSafetyConfig({ COMPANION_MCP_WRITE: '1' }), 'localhost', []);
    expect(ok).toMatchObject({ wouldBeAllowed: true, blockedBy: [] });
  });

  it('does not mutate its inputs', () => {
    const operations = [{ kind: 'readback' as const, description: 'x' }];
    const plan = planWrite(loadSafetyConfig({}), 'localhost', operations);
    expect(plan.operations).not.toBe(operations);
  });
});

describe('planPageImport', () => {
  const config = loadSafetyConfig({ COMPANION_MCP_WRITE: '1' });

  it('plans snapshot, import and read-back for a replace', () => {
    const plan = planPageImport(config, 'localhost', pageExport, 3);
    expect(plan.operations.map((o) => o.kind)).toEqual(['snapshot', 'import-page', 'readback']);
    expect(plan.operations[1]).toMatchObject({ kind: 'import-page', targetPage: 3 });
    expect(plan.warnings).toEqual([]);
  });

  it('plans an append without snapshot and warns about rollback', () => {
    const plan = planPageImport(config, 'localhost', pageExport, -1);
    expect(plan.operations.map((o) => o.kind)).toEqual(['import-page', 'readback']);
    expect(plan.warnings[0]).toContain('rollback');
  });
});

describe('snapshot and rollback', () => {
  it('creates a page snapshot with checksum, host, scope and time', () => {
    const snapshot = createSnapshot({
      host: 'localhost',
      scope: { kind: 'page', page: 2 },
      exportFile: pageExport,
      companionVersion: '5.1.3',
      now: fixedNow,
    });
    expect(snapshot).toMatchObject({
      createdAt: '2026-01-02T03:04:05.000Z',
      host: 'localhost',
      scope: { kind: 'page', page: 2 },
      companionVersion: '5.1.3',
      checksum: checksumOf(pageExport),
    });
    expect(verifySnapshot(snapshot)).toBe(true);
  });

  it('computes an order-independent checksum', () => {
    expect(checksumOf({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      checksumOf({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(checksumOf({ a: 1 })).not.toBe(checksumOf({ a: 2 }));
  });

  it('rejects a snapshot whose export type does not match the scope', () => {
    expect(() =>
      createSnapshot({ host: 'h', scope: { kind: 'full' }, exportFile: pageExport }),
    ).toThrowError(SafetyError);
    expect(() =>
      createSnapshot({ host: 'h', scope: { kind: 'page', page: 1 }, exportFile: fullExport }),
    ).toThrowError(/needs an export of type "page"/);
  });

  it('plans a page rollback as re-import of the same export into the same page', () => {
    const snapshot = createSnapshot({
      host: 'localhost',
      scope: { kind: 'page', page: 2 },
      exportFile: pageExport,
      now: fixedNow,
    });
    const plan = planRollback(snapshot);
    expect(plan.dryRun).toBe(true);
    expect(plan.operations).toEqual([
      { kind: 'import-page', targetPage: 2, exportFile: pageExport },
    ]);
  });

  it('plans a full rollback as import-full', () => {
    const snapshot = createSnapshot({ host: 'h', scope: { kind: 'full' }, exportFile: fullExport });
    expect(planRollback(snapshot).operations[0]).toMatchObject({ kind: 'import-full' });
  });

  it('refuses to roll back a tampered snapshot', () => {
    const snapshot = createSnapshot({
      host: 'h',
      scope: { kind: 'page', page: 1 },
      exportFile: structuredClone(pageExport),
    });
    (snapshot.exportFile['page'] as JsonObject)['name'] = 'TAMPERED';
    expect(verifySnapshot(snapshot)).toBe(false);
    expect(() => planRollback(snapshot)).toThrowError(/checksum mismatch/);
  });
});
