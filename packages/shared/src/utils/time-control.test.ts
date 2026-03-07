import { describe, it, expect } from 'vitest';
import { classifyTimeControl } from './time-control.js';

describe('classifyTimeControl', () => {
  it('should classify bullet: totalTime < 180', () => {
    expect(classifyTimeControl(60, 0)).toBe('bullet');
    expect(classifyTimeControl(60, 1)).toBe('bullet');
    expect(classifyTimeControl(120, 0)).toBe('bullet');
  });

  it('should classify blitz: 180 <= totalTime < 600', () => {
    expect(classifyTimeControl(180, 0)).toBe('blitz');
    expect(classifyTimeControl(300, 0)).toBe('blitz');
    expect(classifyTimeControl(300, 3)).toBe('blitz');
  });

  it('should classify rapid: 600 <= totalTime < 3600', () => {
    expect(classifyTimeControl(600, 0)).toBe('rapid');
    expect(classifyTimeControl(900, 0)).toBe('rapid');
    expect(classifyTimeControl(1800, 0)).toBe('rapid');
  });

  it('should classify classical: totalTime >= 3600', () => {
    expect(classifyTimeControl(3600, 0)).toBe('classical');
    expect(classifyTimeControl(1800, 45)).toBe('classical');
  });

  it('should account for increment in classification', () => {
    expect(classifyTimeControl(60, 3)).toBe('blitz');
    expect(classifyTimeControl(120, 12)).toBe('rapid');
  });
});
