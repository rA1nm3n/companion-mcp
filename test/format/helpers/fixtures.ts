import { readFileSync } from 'node:fs';

/** Load a JSON fixture from test/format/fixtures as an untyped value. */
export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
