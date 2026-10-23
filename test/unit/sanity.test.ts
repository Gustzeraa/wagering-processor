import { describe, expect, it } from 'bun:test';

describe('sanity', () => {
  it('runs tests with bun', () => {
    expect(1 + 1).toBe(2);
  });

  it('shows why we never use number for money', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});