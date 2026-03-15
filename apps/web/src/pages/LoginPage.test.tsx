import { describe, it, expect, vi, beforeEach } from 'vitest';
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
});

describe('LoginPage', () => {
  it('renders heading and three OAuth buttons', () => {
    renderWithProviders(<LoginPage />);

    expect(screen.getByRole('heading', { name: 'Login' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Facebook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Chess.com' })).toBeInTheDocument();
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
});
