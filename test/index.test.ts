import { describe, expect, it } from 'vitest';
import { PROJECT_NAME, describeProject } from '../src/index.js';

describe('index', () => {
  it('exposes the project name', () => {
    expect(PROJECT_NAME).toBe('companion-mcp');
  });

  it('describes the project', () => {
    expect(describeProject()).toContain('Bitfocus Companion');
  });
});
