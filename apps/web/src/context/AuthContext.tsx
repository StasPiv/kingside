import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import type { User } from '@kingside/shared';
import { api } from '../api';
import { socket, matchmakingSocket } from '../socket';
import i18n from '../i18n';

type AuthState = {
  user: User | null;
  token: string | null;
  loading: boolean;
};

type AuthContextType = AuthState & {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    token: localStorage.getItem('token'),
    loading: true,
  });

  const fetchMe = useCallback(async () => {
    try {
      const user = await api.get<User>('/api/auth/me');
      if (user.locale) {
        i18n.changeLanguage(user.locale);
      }
      setState((s) => ({ ...s, user, loading: false }));
    } catch {
      localStorage.removeItem('token');
      setState({ user: null, token: null, loading: false });
    }
  }, []);

  useEffect(() => {
    if (state.token) {
      fetchMe();
    } else {
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
    const { accessToken } = await api.post<{ accessToken: string }>('/api/auth/login', { username, password });
    localStorage.setItem('token', accessToken);
    setState((s) => ({ ...s, token: accessToken }));
  };

  const register = async (username: string, email: string, password: string) => {
    const { accessToken } = await api.post<{ accessToken: string }>('/api/auth/register', { username, email, password });
    localStorage.setItem('token', accessToken);
    setState((s) => ({ ...s, token: accessToken }));
  };

  const logout = () => {
    localStorage.removeItem('token');
    setState({ user: null, token: null, loading: false });
  };

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
