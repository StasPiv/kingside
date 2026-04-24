import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { VideoStepPayload } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { VideoStep, parseVideoUrl } from './VideoStep';

function payload(url: string, extra?: Partial<VideoStepPayload>): VideoStepPayload {
  return { type: 'video', url, ...extra };
}

describe('parseVideoUrl', () => {
  it('распознаёт youtube.com/watch?v=ID', () => {
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('распознаёт youtu.be/ID', () => {
    expect(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('распознаёт youtube.com/embed/ID и youtube-nocookie.com/embed/ID', () => {
    expect(parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
    expect(
      parseVideoUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'),
    ).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    });
  });

  it('распознаёт youtube shorts', () => {
    expect(parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      embedUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
    });
  });

  it('распознаёт vimeo.com/ID', () => {
    expect(parseVideoUrl('https://vimeo.com/76979871')).toEqual({
      provider: 'vimeo',
      embedUrl: 'https://player.vimeo.com/video/76979871',
    });
  });

  it('распознаёт vimeo.com/ID/HASH (unlisted)', () => {
    expect(parseVideoUrl('https://vimeo.com/76979871/abcdef1234')).toEqual({
      provider: 'vimeo',
      embedUrl: 'https://player.vimeo.com/video/76979871?h=abcdef1234',
    });
  });

  it('распознаёт player.vimeo.com/video/ID[?h=HASH]', () => {
    expect(parseVideoUrl('https://player.vimeo.com/video/76979871')).toEqual({
      provider: 'vimeo',
      embedUrl: 'https://player.vimeo.com/video/76979871',
    });
    expect(
      parseVideoUrl('https://player.vimeo.com/video/76979871?h=abcdef1234'),
    ).toEqual({
      provider: 'vimeo',
      embedUrl: 'https://player.vimeo.com/video/76979871?h=abcdef1234',
    });
  });

  it.each([
    '',
    '   ',
    null,
    undefined,
    'not a url',
    'javascript:alert(1)',
    'https://example.com/video.mp4',
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/',
    'https://www.youtube.com/playlist?list=PL',
    'https://vimeo.com/',
    'https://vimeo.com/channels/staffpicks',
    'https://youtu.be/',
    'https://player.vimeo.com/something/76979871',
  ])('не принимает невалидный URL: %s', (url) => {
    expect(parseVideoUrl(url as string)).toBeNull();
  });
});

describe('<VideoStep>', () => {
  it('рендерит iframe с корректным embed-URL для YouTube', () => {
    renderWithProviders(
      <VideoStep payload={payload('https://www.youtube.com/watch?v=dQw4w9WgXcQ')} />,
    );
    const iframe = screen.getByTestId('lesson-video-step-iframe');
    expect(iframe).toHaveAttribute(
      'src',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
    expect(iframe).toHaveAttribute('allowFullScreen');
    expect(screen.getByTestId('lesson-video-step-frame')).toHaveAttribute(
      'data-provider',
      'youtube',
    );
  });

  it('рендерит iframe с корректным embed-URL для Vimeo', () => {
    renderWithProviders(
      <VideoStep payload={payload('https://vimeo.com/76979871/abcdef1234')} />,
    );
    const iframe = screen.getByTestId('lesson-video-step-iframe');
    expect(iframe).toHaveAttribute(
      'src',
      'https://player.vimeo.com/video/76979871?h=abcdef1234',
    );
    expect(screen.getByTestId('lesson-video-step-frame')).toHaveAttribute(
      'data-provider',
      'vimeo',
    );
  });

  it('для невалидного URL iframe не рендерится, показывается плейсхолдер', () => {
    renderWithProviders(
      <VideoStep payload={payload('https://evil.com/watch?v=dQw4w9WgXcQ')} />,
    );
    expect(screen.queryByTestId('lesson-video-step-iframe')).toBeNull();
    expect(screen.getByTestId('lesson-video-step-invalid')).toBeInTheDocument();
  });

  it('кнопка «Продолжить» вызывает onStepDone (валидный URL)', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <VideoStep
        payload={payload('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}
        onStepDone={onStepDone}
      />,
    );
    fireEvent.click(screen.getByTestId('lesson-video-step-next'));
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('кнопка «Продолжить» вызывает onStepDone также для плейсхолдера', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <VideoStep payload={payload('not a url')} onStepDone={onStepDone} />,
    );
    fireEvent.click(screen.getByTestId('lesson-video-step-next'));
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('hideNext убирает кнопку «Продолжить»', () => {
    renderWithProviders(
      <VideoStep
        payload={payload('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}
        hideNext
      />,
    );
    expect(screen.queryByTestId('lesson-video-step-next')).toBeNull();
  });

  it('рендерит заголовок, если задан titleI18nKey', () => {
    renderWithProviders(
      <VideoStep
        payload={payload('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
          titleI18nKey: 'lessons.stepType.video',
        })}
      />,
    );
    // i18n-ключ резолвится (или fallback — сам ключ, если перевода нет).
    const title = screen.getByRole('heading', { level: 3 });
    expect(title).toBeInTheDocument();
    expect(title.textContent?.length).toBeGreaterThan(0);
  });
});
