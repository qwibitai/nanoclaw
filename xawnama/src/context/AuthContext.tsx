import React, { createContext, useContext, useState, useCallback } from 'react';
import { UserProfile } from '../types';
import * as authService from '../services/authService';

interface AuthContextType {
  user: UserProfile | null;
  loading: boolean;
  signUp: (
    email: string,
    password: string,
    profile: Omit<UserProfile, 'id' | 'createdAt'>
  ) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);

  const signUp = useCallback(
    async (
      email: string,
      password: string,
      profile: Omit<UserProfile, 'id' | 'createdAt'>
    ) => {
      setLoading(true);
      try {
        const newUser = await authService.signUp(email, password, profile);
        setUser(newUser);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const signIn = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      const loggedInUser = await authService.signIn(email, password);
      setUser(loggedInUser);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await authService.signOut();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
