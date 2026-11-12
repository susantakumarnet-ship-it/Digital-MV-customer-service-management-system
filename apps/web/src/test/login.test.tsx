import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from '@/features/auth/login-page';
import { makeAuth, Wrapper } from './utils';

vi.mock('@/lib/queries', () => ({ usePublicSettings: () => ({ data: undefined }) }));

function apiError(status: number, code: string, message: string) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(message, 'ERR', config, null, {
    status,
    statusText: '',
    headers: {},
    config,
    data: { error: { code, message, requestId: 'req-1' } },
  });
}

describe('LoginPage', () => {
  it('validates required fields before calling the API', async () => {
    const auth = makeAuth(null);
    render(
      <Wrapper auth={auth} route="/login">
        <LoginPage />
      </Wrapper>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or username is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('shows the API error message for bad credentials', async () => {
    const auth = makeAuth(null, {
      login: vi.fn(async () => {
        throw apiError(401, 'INVALID_CREDENTIALS', 'The email/username or password is incorrect.');
      }),
    });
    render(
      <Wrapper auth={auth} route="/login">
        <LoginPage />
      </Wrapper>,
    );
    await userEvent.type(screen.getByLabelText(/email or username/i), 'someone@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email/username or password is incorrect.');
    expect(auth.login).toHaveBeenCalledWith('someone@example.com', 'wrong-password');
  });

  it('shows lockout messages from the API', async () => {
    const auth = makeAuth(null, {
      login: vi.fn(async () => {
        throw apiError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes or reset your password.');
      }),
    });
    render(
      <Wrapper auth={auth} route="/login">
        <LoginPage />
      </Wrapper>,
    );
    await userEvent.type(screen.getByLabelText(/email or username/i), 'a');
    await userEvent.type(screen.getByLabelText(/^password/i), 'b');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many failed attempts/);
  });

  it('moves to the MFA step when the API asks for a code', async () => {
    const auth = makeAuth(null, { login: vi.fn(async () => ({ mfaChallenge: 'challenge-token-123' })) });
    render(
      <Wrapper auth={auth} route="/login">
        <LoginPage />
      </Wrapper>,
    );
    await userEvent.type(screen.getByLabelText(/email or username/i), 'admin');
    await userEvent.type(screen.getByLabelText(/^password/i), 'Secret12345678');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Two-step verification')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/verification code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify and sign in/i }));
    expect(auth.completeMfa).toHaveBeenCalledWith('challenge-token-123', '123456');
  });
});
