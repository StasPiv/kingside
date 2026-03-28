import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import type { User, AuthTokenResponse } from '@kingside/shared';
import { api } from '../api';
import { socket, matchmakingSocket } from '../socket';
import i18n from '../i18n/index';

type AuthState = {
  user: User | null;
  token: string | null;
  loading: boolean;
};

type AuthContextType = AuthState & {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  loginWithTokens: (accessToken: string, refreshToken: string) => void;
  logout: () => void;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: localStorage.getItem('token'),
    loading: true,
  });

  const isFetchingRef = useRef(false);

  const fetchMe = useCallback(async () => {
    if (isFetchingRef.current) {
      console.log('[AuthContext] fetchMe skipped — already in progress');
      return;
    }
    isFetchingRef.current = true;
    const tokenAtStart = localStorage.getItem('token');
    console.log('[AuthContext] fetchMe start', { tokenAtStartPreview: tokenAtStart ? tokenAtStart.slice(0, 20) + '...' : null });
    try {
      const user = await api.get<User | null>('/api/auth/me');
      const currentToken = localStorage.getItem('token');
      console.log('[AuthContext] fetchMe success', { userId: user?.id, username: user?.username, tokenChanged: tokenAtStart !== currentToken });
      // Only apply server locale if user has explicitly chosen one
      // (localStorage already has a locale). Otherwise, keep browser-detected language.
      if (user?.locale && localStorage.getItem('locale')) {
        i18n.changeLanguage(user.locale);
        localStorage.setItem('locale', user.locale);
      }
      setState((s) => ({ ...s, user: user ?? null, token: currentToken, loading: false }));
    } catch (err) {
      const currentToken = localStorage.getItem('token');
      const tokenReplaced = currentToken !== tokenAtStart;
      console.log('[AuthContext] fetchMe error', {
        error: err instanceof Error ? err.message : String(err),
        tokenAtStartPreview: tokenAtStart ? tokenAtStart.slice(0, 20) + '...' : null,
        currentTokenPreview: currentToken ? currentToken.slice(0, 20) + '...' : null,
        tokenReplaced,
        willSkipWipe: tokenReplaced,
      });
      // Guard against race condition: if the token was replaced while this
      // request was in-flight (e.g. by OAuth loginWithTokens), don't wipe
      // the new token — a fresh fetchMe will be triggered by the token effect.
      if (currentToken === tokenAtStart) {
        console.log('[AuthContext] fetchMe wiping tokens (no race condition detected)');
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        setState({ user: null, token: null, loading: false });
      } else {
        console.log('[AuthContext] fetchMe skipping wipe — token was replaced mid-flight, waiting for re-trigger');
      }
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Read from localStorage (not state.token) to avoid a race condition where a
    // child component's effect (OAuthCallbackPage) writes the token to localStorage
    // before this parent effect runs, but state.token is still null in the closure.
    const currentToken = localStorage.getItem('token');
    console.log('[AuthContext] token effect triggered', {
      stateToken: state.token ? state.token.slice(0, 20) + '...' : null,
      localStorageToken: currentToken ? currentToken.slice(0, 20) + '...' : null,
    });
    if (currentToken) {
      fetchMe();
    } else {
      console.log('[AuthContext] no token in localStorage, setting loading=false');
      setState((s) => ({ ...s, loading: false }));
    }
  }, [state.token, fetchMe]);

  useEffect(() => {
    if (state.token) {
      socket.auth = { token: state.token };
      socket.connect();
      matchmakingSocket.auth = { token: state.token };
      matchmakingSocket.connect();
    } else {
      socket.disconnect();
      matchmakingSocket.disconnect();
    }
  }, [state.token]);

  const login = async (username: string, password: string) => {
    const { accessToken, refreshToken } = await api.post<AuthTokenResponse>('/api/auth/login', { username, password });
    localStorage.setItem('token', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    setState((s) => ({ ...s, token: accessToken }));
  };

  const register = async (username: string, email: string, password: string) => {
    const { accessToken, refreshToken } = await api.post<AuthTokenResponse>('/api/auth/register', { username, email, password });
    localStorage.setItem('token', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    setState((s) => ({ ...s, token: accessToken }));
  };

  const loginWithTokens = useCallback((accessToken: string, refreshToken: string) => {
    console.log('[AuthContext] loginWithTokens called', {
      accessTokenPreview: accessToken.slice(0, 20) + '...',
      hasRefreshToken: !!refreshToken,
    });
    localStorage.setItem('token', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
    setState((s) => ({ ...s, token: accessToken, loading: true }));
  }, []);

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    setState({ user: null, token: null, loading: false });
  };

  return (
    <AuthContext.Provider value={{ ...state, login, register, loginWithTokens, logout, refreshUser: fetchMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
