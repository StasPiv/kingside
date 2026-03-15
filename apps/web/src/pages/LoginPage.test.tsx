import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';
import { LoginPage } from './LoginPage';

const mockNavigate = vi.fn();
let mockLocationState: Record<string, unknown> | null = null;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ state: mockLocationState, pathname: '/login', search: '', hash: '', key: 'default' }),
  };
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockLocationState = null;
  Object.defineProperty(window, 'location', {
    value: { href: '' },
    writable: true,
  });
});

describe('LoginPage', () => {
  it('renders heading and two OAuth buttons (no Chess.com)', () => {
    renderWithProviders(<LoginPage />);

    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Facebook' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Chess.com' })).not.toBeInTheDocument();
  });

  it('does not show error without oauth error state', () => {
    renderWithProviders(<LoginPage />);
    expect(screen.queryByText('Authorization failed. Please try again.')).not.toBeInTheDocument();
  });

  it('shows oauth error from location state', () => {
    mockLocationState = { oauthError: 'Authorization failed. Please try again.' };
    renderWithProviders(<LoginPage />);
    expect(screen.getByText('Authorization failed. Please try again.')).toBeInTheDocument();
  });

  it('disables all buttons and shows loading state when one is clicked', () => {
    renderWithProviders(<LoginPage />);

    const googleButton = screen.getByRole('button', { name: 'Continue with Google' });
    fireEvent.click(googleButton);

    expect(screen.getByText('Connecting...')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    buttons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });
});
