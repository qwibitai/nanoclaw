/**
 * Mock Firebase Authentication Service
 * Replace with real Firebase when ready for production.
 */

import { UserProfile } from '../types';

// In-memory store (mocked)
let currentUser: UserProfile | null = null;
const users: Map<string, { email: string; password: string; profile: UserProfile }> = new Map();

function generateId(): string {
  return `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function signUp(
  email: string,
  password: string,
  profile: Omit<UserProfile, 'id' | 'createdAt'>
): Promise<UserProfile> {
  // Simulate network delay
  await new Promise((r) => setTimeout(r, 800));

  if (users.has(email)) {
    throw new Error('ئەم ئیمەیڵە پێشتر تۆمار کراوە');
  }

  const newUser: UserProfile = {
    ...profile,
    id: generateId(),
    createdAt: Date.now(),
  };

  users.set(email, { email, password, profile: newUser });
  currentUser = newUser;
  return newUser;
}

export async function signIn(email: string, password: string): Promise<UserProfile> {
  await new Promise((r) => setTimeout(r, 800));

  const user = users.get(email);
  if (!user || user.password !== password) {
    throw new Error('ئیمەیڵ یان وشەی نهێنی هەڵەیە');
  }

  currentUser = user.profile;
  return user.profile;
}

export async function signOut(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  currentUser = null;
}

export function getCurrentUser(): UserProfile | null {
  return currentUser;
}
