import { describe, it, expect } from 'vitest';
import { parseCommentMacros, serializeCommentWithMacros } from './commentMacros';

describe('parseCommentMacros', () => {
  it('extracts eval from comment', () => {
    const result = parseCommentMacros('[%eval 0.18]');
    expect(result.eval).toBe(0.18);
    expect(result.comment).toBeUndefined();
  });

  it('extracts clock from comment', () => {
    const result = parseCommentMacros('[%clk 1:59:27]');
    expect(result.clock).toBe('1:59:27');
    expect(result.comment).toBeUndefined();
  });

  it('extracts both eval and clock', () => {
    const result = parseCommentMacros('[%eval 0.18] [%clk 1:59:27]');
    expect(result.eval).toBe(0.18);
    expect(result.clock).toBe('1:59:27');
    expect(result.comment).toBeUndefined();
  });

  it('extracts macros and preserves human text', () => {
    const result = parseCommentMacros('[%eval 0.5] Хороший ход [%clk 0:45:00]');
    expect(result.eval).toBe(0.5);
    expect(result.clock).toBe('0:45:00');
    expect(result.comment).toBe('Хороший ход');
  });

  it('handles negative eval', () => {
    const result = parseCommentMacros('[%eval -1.23]');
    expect(result.eval).toBe(-1.23);
  });

  it('handles mate eval', () => {
    const result = parseCommentMacros('[%eval #5]');
    expect(result.eval).toBe(100);
  });

  it('handles no macros', () => {
    const result = parseCommentMacros('Just a comment');
    expect(result.eval).toBeUndefined();
    expect(result.clock).toBeUndefined();
    expect(result.comment).toBe('Just a comment');
  });
});

describe('serializeCommentWithMacros', () => {
  it('serializes eval only', () => {
    expect(serializeCommentWithMacros(undefined, 0.18)).toBe('[%eval 0.18]');
  });

  it('serializes clock only', () => {
    expect(serializeCommentWithMacros(undefined, undefined, '1:59:27')).toBe('[%clk 1:59:27]');
  });

  it('serializes eval + comment + clock', () => {
    expect(serializeCommentWithMacros('Good', 0.5, '0:45:00')).toBe('[%eval 0.50] Good [%clk 0:45:00]');
  });

  it('returns undefined when no data', () => {
    expect(serializeCommentWithMacros()).toBeUndefined();
  });
});
