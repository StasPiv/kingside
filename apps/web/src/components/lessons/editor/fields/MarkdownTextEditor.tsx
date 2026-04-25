import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * `MarkdownTextEditor` — лёгкий WYSIWYG-toolbar поверх обычной `<textarea>`
 * для тела `text`-шага в редакторе курса (KS-1874).
 *
 * # Почему не внешний редактор
 *
 * `@uiw/react-md-editor`/`react-simplemde-editor` тащат за собой
 * собственные парсеры markdown и подсветку — результат: +~200KB gzip
 * чанк, peer-deps на React ≤18 (на 19 ругаются), плюс риск сломать
 * совместимость с нашим набором плейсхолдеров. У нас на read-only
 * стороне работает свой `simpleMarkdown.tsx` с ограниченным набором
 * (заголовки 1–3, **жирный**, *курсив*, `code`, ```code-block```,
 * списки, ссылки). Toolbar этого компонента покрывает РОВНО этот
 * набор и ни байта больше: всё, что генерит toolbar, гарантированно
 * рендерится в ученическом режиме.
 *
 * # Совместимость с диаграммами
 *
 * `bodyMarkdown` хранит plain-text токены `{{diagram:N}}` и fenced
 * ```` ```fen ```` блоки. Здесь они никак не парсятся и не
 * экранируются — просто остаются в строке как обычный текст.
 * `TextStep.tsx` режет их при рендере на свои сегменты.
 */

export interface MarkdownTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Минимальная высота в строках. По умолчанию 20. */
  minRows?: number;
  /** testid на textarea (для совместимости с существующими тестами). */
  textareaTestId?: string;
  /** testid на корневой обёртке (toolbar + textarea). */
  rootTestId?: string;
  placeholder?: string;
}

type ToolbarAction =
  | { kind: 'wrap'; before: string; after: string; placeholderKey: string; sample?: string }
  | { kind: 'linePrefix'; prefix: string; placeholderKey: string; sample?: string }
  | { kind: 'codeBlock' }
  | { kind: 'link' };

interface ToolbarButton {
  id: string;
  /** короткая подпись на кнопке (1–2 символа / иконка) */
  label: string;
  /** i18n-ключ для title/aria-label */
  titleKey: string;
  titleFallback: string;
  action: ToolbarAction;
}

const BUTTONS: ToolbarButton[] = [
  {
    id: 'h2',
    label: 'H2',
    titleKey: 'editor.step.text.toolbar.heading2',
    titleFallback: 'Heading 2',
    action: { kind: 'linePrefix', prefix: '# ', placeholderKey: 'editor.step.text.toolbar.headingSample' },
  },
  {
    id: 'h3',
    label: 'H3',
    titleKey: 'editor.step.text.toolbar.heading3',
    titleFallback: 'Heading 3',
    action: { kind: 'linePrefix', prefix: '## ', placeholderKey: 'editor.step.text.toolbar.headingSample' },
  },
  {
    id: 'bold',
    label: 'B',
    titleKey: 'editor.step.text.toolbar.bold',
    titleFallback: 'Bold',
    action: { kind: 'wrap', before: '**', after: '**', placeholderKey: 'editor.step.text.toolbar.boldSample' },
  },
  {
    id: 'italic',
    label: 'I',
    titleKey: 'editor.step.text.toolbar.italic',
    titleFallback: 'Italic',
    action: { kind: 'wrap', before: '*', after: '*', placeholderKey: 'editor.step.text.toolbar.italicSample' },
  },
  {
    id: 'code',
    label: '<>',
    titleKey: 'editor.step.text.toolbar.code',
    titleFallback: 'Inline code',
    action: { kind: 'wrap', before: '`', after: '`', placeholderKey: 'editor.step.text.toolbar.codeSample' },
  },
  {
    id: 'ul',
    label: '• –',
    titleKey: 'editor.step.text.toolbar.bulletList',
    titleFallback: 'Bullet list',
    action: { kind: 'linePrefix', prefix: '- ', placeholderKey: 'editor.step.text.toolbar.listSample' },
  },
  {
    id: 'ol',
    label: '1.',
    titleKey: 'editor.step.text.toolbar.numberedList',
    titleFallback: 'Numbered list',
    action: { kind: 'linePrefix', prefix: '1. ', placeholderKey: 'editor.step.text.toolbar.listSample' },
  },
  {
    id: 'link',
    label: '↗',
    titleKey: 'editor.step.text.toolbar.link',
    titleFallback: 'Link',
    action: { kind: 'link' },
  },
  {
    id: 'codeblock',
    label: '{ }',
    titleKey: 'editor.step.text.toolbar.codeBlock',
    titleFallback: 'Code block',
    action: { kind: 'codeBlock' },
  },
];

function applyAction(
  textarea: HTMLTextAreaElement,
  value: string,
  action: ToolbarAction,
  placeholder: string,
): { next: string; selStart: number; selEnd: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = value.slice(start, end);

  if (action.kind === 'wrap') {
    const inner = selected.length > 0 ? selected : placeholder;
    const next =
      value.slice(0, start) + action.before + inner + action.after + value.slice(end);
    const innerStart = start + action.before.length;
    return {
      next,
      selStart: innerStart,
      selEnd: innerStart + inner.length,
    };
  }

  if (action.kind === 'linePrefix') {
    // Расширяем выделение до начала первой строки и конца последней.
    let lineStart = start;
    while (lineStart > 0 && value[lineStart - 1] !== '\n') lineStart -= 1;
    let lineEnd = end;
    while (lineEnd < value.length && value[lineEnd] !== '\n') lineEnd += 1;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.length === 0 ? [placeholder] : block.split('\n');
    const transformed = lines.map((l) => `${action.prefix}${l}`).join('\n');
    const next = value.slice(0, lineStart) + transformed + value.slice(lineEnd);
    return {
      next,
      selStart: lineStart,
      selEnd: lineStart + transformed.length,
    };
  }

  if (action.kind === 'codeBlock') {
    const inner = selected.length > 0 ? selected : placeholder;
    // Гарантируем перевод строки до и после блока для корректного парсинга.
    const needLeadingNl = start > 0 && value[start - 1] !== '\n';
    const needTrailingNl = end < value.length && value[end] !== '\n';
    const block = `${needLeadingNl ? '\n' : ''}\`\`\`\n${inner}\n\`\`\`${needTrailingNl ? '\n' : ''}`;
    const next = value.slice(0, start) + block + value.slice(end);
    const innerStart = start + (needLeadingNl ? 1 : 0) + 4; // ```\n
    return {
      next,
      selStart: innerStart,
      selEnd: innerStart + inner.length,
    };
  }

  // link: [label](url)
  const label = selected.length > 0 ? selected : placeholder;
  const url = 'https://';
  const inserted = `[${label}](${url})`;
  const next = value.slice(0, start) + inserted + value.slice(end);
  // Поставим курсор на место URL чтобы пользователь сразу его дописал.
  const urlStart = start + label.length + 3; // [LABEL](
  return {
    next,
    selStart: urlStart,
    selEnd: urlStart + url.length,
  };
}

export function MarkdownTextEditor({
  value,
  onChange,
  minRows = 20,
  textareaTestId,
  rootTestId,
  placeholder,
}: MarkdownTextEditorProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const handleButton = useCallback(
    (button: ToolbarButton) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const placeholderText =
        button.action.kind === 'wrap'
          ? t(button.action.placeholderKey, button.action.sample ?? 'text')
          : button.action.kind === 'linePrefix'
            ? t(button.action.placeholderKey, button.action.sample ?? 'text')
            : button.action.kind === 'codeBlock'
              ? t('editor.step.text.toolbar.codeBlockSample', 'code')
              : t('editor.step.text.toolbar.linkSample', 'link');
      const { next, selStart, selEnd } = applyAction(ta, value, button.action, placeholderText);
      onChange(next);
      // Восстанавливаем фокус и выделение после React-рендера.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(selStart, selEnd);
      });
    },
    [onChange, t, value],
  );

  return (
    <div
      className="editor-md"
      data-testid={rootTestId ?? 'editor-step-text-body-root'}
    >
      <div
        className="editor-md__toolbar"
        role="toolbar"
        aria-label={t('editor.step.text.toolbar.label', 'Markdown formatting')}
      >
        {BUTTONS.map((b) => (
          <button
            key={b.id}
            type="button"
            className="editor-md__btn"
            data-testid={`editor-md-btn-${b.id}`}
            title={t(b.titleKey, b.titleFallback)}
            aria-label={t(b.titleKey, b.titleFallback)}
            onMouseDown={(e) => {
              // Не теряем выделение в textarea при клике по кнопке.
              e.preventDefault();
            }}
            onClick={() => handleButton(b)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        className="editor-md__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={minRows}
        data-testid={textareaTestId ?? 'editor-step-text-body'}
        placeholder={placeholder}
        spellCheck
      />
    </div>
  );
}
