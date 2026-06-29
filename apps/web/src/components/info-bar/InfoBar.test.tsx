// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  InfoBar,
  InfoBarProvider,
  useInfoBar,
  type InfoBarEntry,
} from './InfoBar';

function Publisher({ entry }: { entry: InfoBarEntry | null }) {
  const { push, clear } = useInfoBar();
  return (
    <div>
      <button
        type="button"
        data-testid="publish"
        onClick={() => entry && push(entry)}
      >
        publish
      </button>
      <button
        type="button"
        data-testid="clear"
        onClick={() => entry && clear(entry.id)}
      >
        clear
      </button>
    </div>
  );
}

function setup(entry: InfoBarEntry | null) {
  return render(
    <InfoBarProvider>
      <InfoBar />
      <Publisher entry={entry} />
    </InfoBarProvider>,
  );
}

describe('InfoBar (KS-4815)', () => {
  it('пока entry нет — ничего не рендерит', () => {
    setup(null);
    expect(screen.queryByTestId('info-bar')).not.toBeInTheDocument();
  });

  it('push → рендер title + body + CTA + крестик', () => {
    const onCta = vi.fn();
    const onDismiss = vi.fn();
    setup({
      id: 'e1',
      title: 'Hello',
      body: 'World',
      cta: { label: 'Go', onClick: onCta },
      onDismiss,
    });

    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });

    expect(screen.getByTestId('info-bar')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('World')).toBeInTheDocument();
    expect(screen.getByTestId('info-bar-cta')).toHaveTextContent('Go');
    expect(screen.getByTestId('info-bar-close')).toBeInTheDocument();
  });

  it('CTA-клик вызывает onClick из entry', () => {
    const onCta = vi.fn();
    setup({
      id: 'e2',
      title: 'T',
      cta: { label: 'Go', onClick: onCta },
    });
    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('info-bar-cta'));
    });
    expect(onCta).toHaveBeenCalledTimes(1);
  });

  it('крестик вызывает onDismiss', () => {
    const onDismiss = vi.fn();
    setup({
      id: 'e3',
      title: 'T',
      onDismiss,
    });
    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('info-bar-close'));
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clear(id) снимает запись с тем же id', () => {
    setup({ id: 'e4', title: 'T' });
    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });
    expect(screen.getByTestId('info-bar')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId('clear'));
    });
    expect(screen.queryByTestId('info-bar')).not.toBeInTheDocument();
  });

  it('без onDismiss — крестик не рендерится', () => {
    setup({ id: 'e5', title: 'T' });
    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });
    expect(screen.queryByTestId('info-bar-close')).not.toBeInTheDocument();
  });

  it('без cta — кнопка CTA не рендерится', () => {
    setup({ id: 'e6', title: 'T' });
    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });
    expect(screen.queryByTestId('info-bar-cta')).not.toBeInTheDocument();
  });

  it('кастомный testid', () => {
    setup({ id: 'e7', title: 'T', testid: 'hint-info-bar' });
    act(() => {
      fireEvent.click(screen.getByTestId('publish'));
    });
    expect(screen.getByTestId('hint-info-bar')).toBeInTheDocument();
  });

  it('clear с чужим id не снимает текущий entry', () => {
    function MultiPublisher() {
      const { push, clear } = useInfoBar();
      return (
        <div>
          <button
            data-testid="push-a"
            type="button"
            onClick={() => push({ id: 'A', title: 'A-title' })}
          >
            a
          </button>
          <button
            data-testid="clear-b"
            type="button"
            onClick={() => clear('B')}
          >
            b
          </button>
        </div>
      );
    }
    render(
      <InfoBarProvider>
        <InfoBar />
        <MultiPublisher />
      </InfoBarProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByTestId('push-a'));
    });
    expect(screen.getByText('A-title')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId('clear-b'));
    });
    expect(screen.getByText('A-title')).toBeInTheDocument();
  });
});
