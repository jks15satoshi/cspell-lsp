import { describe, expect, test } from 'bun:test';

import { getBundledVersion } from '../../src/engine/package.js';

describe('bundled engine version', () => {
  test('resolves the installed version when it is not build-defined', () => {
    expect(getBundledVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
