import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../../../test/test-utils';
import { MarkdownTextEditor } from './MarkdownTextEditor';

/**
 * KS-1874: WYSIWYG-toolbar над textarea для тела `text`-шага.
 *
 * Тесты держат три ключевых контракта:
 *   1. data-testid'ы стабильны (`editor-step-text-body` на textarea
 *      — на нём существующие smoke/E2E тесты).
 *   2. Toolbar генерит ровно тот markdown, который понимает
 *      `simpleMarkdown.tsx` (никаких `__bold__`, `~~strike~~`).
 *   3. Плейсхолдеры `{{diagram:N}}` и fenced ```fen``` не трогаются —
 *      они лежат в textarea как обычный текст.
 */

function setSelection(textarea: HTMLTextAreaElement, start: number, end: number) {
  textarea.focus();
  textarea.setSelectionRange(start, end);
}

describe('<MarkdownTextEditor>', () => {
  it('рендерит textarea с дефолтным testid', () => {
    renderWithProviders(<MarkdownTextEditor value="hello" onChange={vi.fn()} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    expect(ta).toBeInTheDocument();
    expect(ta.value).toBe('hello');
  });

  it('Bold над выделением → оборачивает в **…**', () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownTextEditor value="hello world" onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    setSelection(ta, 6, 11); // "world"
    fireEvent.click(screen.getByTestId('editor-md-btn-bold'));
    expect(onChange).toHaveBeenCalledWith('hello **world**');
  });

  it('Italic над пустым выделением → вставляет *placeholder*', () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownTextEditor value="" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('editor-md-btn-italic'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const result = onChange.mock.calls[0][0] as string;
    expect(result.startsWith('*')).toBe(true);
    expect(result.endsWith('*')).toBe(true);
    expect(result.length).toBeGreaterThan(2);
  });

  it('H2 → префикс "# " на текущей строке', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <MarkdownTextEditor value={'line one\nline two'} onChange={onChange} />,
    );
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    // курсор внутри "line two"
    setSelection(ta, 11, 11);
    fireEvent.click(screen.getByTestId('editor-md-btn-h2'));
    expect(onChange).toHaveBeenCalledWith('line one\n# line two');
  });

  it('Inline code → оборачивает в `…`', () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownTextEditor value="see foo here" onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    setSelection(ta, 4, 7); // "foo"
    fireEvent.click(screen.getByTestId('editor-md-btn-code'));
    expect(onChange).toHaveBeenCalledWith('see `foo` here');
  });

  it('Bullet list → "- " префикс на каждой выделенной строке', () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownTextEditor value={'a\nb\nc'} onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    setSelection(ta, 0, 5); // всё
    fireEvent.click(screen.getByTestId('editor-md-btn-ul'));
    expect(onChange).toHaveBeenCalledWith('- a\n- b\n- c');
  });

  it('Code block → оборачивает в ```...```', () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownTextEditor value="hello" onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    setSelection(ta, 0, 5);
    fireEvent.click(screen.getByTestId('editor-md-btn-codeblock'));
    const result = onChange.mock.calls[0][0] as string;
    expect(result).toContain('```\nhello\n```');
  });

  it('плейсхолдер {{diagram:0}} остаётся нетронутым после форматирования соседнего текста', () => {
    const onChange = vi.fn();
    const initial = 'Текст\n\n{{diagram:0}}\n\nХвост';
    renderWithProviders(<MarkdownTextEditor value={initial} onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    // выделяем "Хвост"
    const start = initial.indexOf('Хвост');
    setSelection(ta, start, start + 'Хвост'.length);
    fireEvent.click(screen.getByTestId('editor-md-btn-bold'));
    const result = onChange.mock.calls[0][0] as string;
    expect(result).toContain('{{diagram:0}}');
    expect(result).toContain('**Хвост**');
    // строка плейсхолдера не была экранирована
    expect(result).not.toContain('\\{\\{');
  });

  it('fenced ```fen``` блок остаётся как plain-текст в textarea', () => {
    const onChange = vi.fn();
    const initial = 'intro\n\n```fen\nrnbqkbnr/...\n```\n\nend';
    renderWithProviders(<MarkdownTextEditor value={initial} onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    expect(ta.value).toBe(initial);
    // вставляем bold вокруг "intro"
    setSelection(ta, 0, 5);
    fireEvent.click(screen.getByTestId('editor-md-btn-bold'));
    const result = onChange.mock.calls[0][0] as string;
    expect(result).toContain('```fen\nrnbqkbnr/...\n```');
  });

  it('обычный ввод в textarea пробрасывает onChange', () => {
    const onChange = vi.fn();
    renderWithProviders(<MarkdownTextEditor value="" onChange={onChange} />);
    const ta = screen.getByTestId('editor-step-text-body') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'new' } });
    expect(onChange).toHaveBeenCalledWith('new');
  });

  it('toolbar содержит все 9 кнопок', () => {
    renderWithProviders(<MarkdownTextEditor value="" onChange={vi.fn()} />);
    const ids = ['h2', 'h3', 'bold', 'italic', 'code', 'ul', 'ol', 'link', 'codeblock'];
    for (const id of ids) {
      expect(screen.getByTestId(`editor-md-btn-${id}`)).toBeInTheDocument();
    }
  });
});
