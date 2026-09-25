import { describe, expect, it } from 'vitest';
import { shouldApplyStatus, formatDelay } from '../src/index.js';

describe('shouldApplyStatus', () => {
  it('progresse dans le cycle de vie', () => {
    expect(shouldApplyStatus('ACCEPTED', 'SENT')).toBe(true);
    expect(shouldApplyStatus('SENT', 'DELIVERED')).toBe(true);
    expect(shouldApplyStatus('DELIVERED', 'READ')).toBe(true);
  });
  it('ne rétrograde jamais', () => {
    expect(shouldApplyStatus('READ', 'DELIVERED')).toBe(false);
    expect(shouldApplyStatus('DELIVERED', 'SENT')).toBe(false);
    expect(shouldApplyStatus('READ', 'READ')).toBe(false);
  });
  it('gère FAILED', () => {
    expect(shouldApplyStatus('ACCEPTED', 'FAILED')).toBe(true);
    expect(shouldApplyStatus('READ', 'FAILED')).toBe(false);
    expect(shouldApplyStatus('FAILED', 'DELIVERED')).toBe(true);
  });
  it('formate le délai', () => {
    expect(formatDelay(20)).toBe('00:20');
    expect(formatDelay(70)).toBe('01:10');
    expect(formatDelay(120)).toBe('02:00');
  });
});
