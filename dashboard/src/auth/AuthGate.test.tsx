import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from './AuthGate.js';

describe('AuthGate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('test_AuthGate_renders_input_and_button', () => {
    it('renders a text input and submit button', () => {
      render(<AuthGate onAuthenticated={vi.fn()} />);
      expect(screen.getByRole('textbox')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();
    });
  });

  describe('test_AuthGate_submit_calls_exchange_endpoint', () => {
    it('POSTs token and calls onAuthenticated with AuthMe', async () => {
      const onAuthenticated = vi.fn();
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } }),
        });
      vi.stubGlobal('fetch', mockFetch);

      render(<AuthGate onAuthenticated={onAuthenticated} />);
      const input = screen.getByRole('textbox');
      await userEvent.type(input, 'pasted');
      await userEvent.click(screen.getByRole('button', { name: /submit/i }));

      await waitFor(() => {
        expect(onAuthenticated).toHaveBeenCalledOnce();
      });

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/dashboard/api/auth/exchange');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ token: 'pasted' });
      expect(onAuthenticated.mock.calls[0][0]).toMatchObject({ user_id: 'u1' });
    });
  });

  describe('test_AuthGate_invalid_token_shows_error', () => {
    it('shows error on 400 and does not call onAuthenticated', async () => {
      const onAuthenticated = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'invalid_token' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      render(<AuthGate onAuthenticated={onAuthenticated} />);
      await userEvent.type(screen.getByRole('textbox'), 'bad');
      await userEvent.click(screen.getByRole('button', { name: /submit/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      expect(screen.getByRole('alert').textContent).toMatch(/invalid or expired/i);
      expect(onAuthenticated).not.toHaveBeenCalled();
    });
  });

  describe('test_AuthGate_no_localStorage_writes', () => {
    it('never writes to localStorage', async () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user_id: 'u1', expires_at: '2099-01-01T00:00:00Z' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ user_id: 'u1', scopes: { role: 'owner', allowed_group_ids: [], no_filter: true } }),
        });
      vi.stubGlobal('fetch', mockFetch);

      render(<AuthGate onAuthenticated={vi.fn()} />);
      await userEvent.type(screen.getByRole('textbox'), 'tok');
      await userEvent.click(screen.getByRole('button', { name: /submit/i }));

      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
      expect(setItemSpy).not.toHaveBeenCalled();
      setItemSpy.mockRestore();
    });
  });
});
