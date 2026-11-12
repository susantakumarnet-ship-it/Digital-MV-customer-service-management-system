import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { applyFieldErrors, errorMessage, parseApiError } from '@/lib/api';

function axiosErr(status: number | undefined, data?: unknown) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('fail', 'ERR', config, null, status ? { status, statusText: '', headers: {}, config, data } : undefined);
}

describe('parseApiError', () => {
  it('extracts the standard error body', () => {
    const e = parseApiError(
      axiosErr(400, { error: { code: 'VALIDATION_FAILED', message: 'Fix fields', fields: { email: 'Bad email' }, requestId: 'abc' } }),
    );
    expect(e).toEqual({ status: 400, code: 'VALIDATION_FAILED', message: 'Fix fields', fields: { email: 'Bad email' }, requestId: 'abc' });
  });
  it('reports network failures', () => {
    expect(parseApiError(axiosErr(undefined)).code).toBe('NETWORK');
  });
  it('handles plain errors', () => {
    expect(parseApiError(new Error('x')).message).toBe('x');
  });
  it('adds the request reference for server errors', () => {
    const msg = errorMessage(axiosErr(500, { error: { code: 'INTERNAL_ERROR', message: 'Oops', requestId: '12345678-aaaa' } }));
    expect(msg).toBe('Oops (ref 12345678)');
  });
});

describe('applyFieldErrors', () => {
  it('maps API field errors onto the form, including nested keys', () => {
    const setError = vi.fn();
    const applied = applyFieldErrors(
      axiosErr(400, { error: { code: 'VALIDATION_FAILED', message: 'x', fields: { email: 'Already in use', 'scope.siteIds': 'Unknown site' } } }),
      setError,
    );
    expect(applied).toBe(true);
    expect(setError).toHaveBeenCalledWith('email', { type: 'server', message: 'Already in use' });
    expect(setError).toHaveBeenCalledWith('scope.siteIds', { type: 'server', message: 'Unknown site' });
  });
  it('respects the known-field filter and reports when nothing applied', () => {
    const setError = vi.fn();
    const applied = applyFieldErrors(axiosErr(409, { error: { code: 'DUPLICATE', message: 'dup', fields: { code: 'Already in use' } } }), setError, ['name']);
    expect(applied).toBe(false);
    expect(setError).not.toHaveBeenCalled();
  });
  it('returns false when there are no field errors', () => {
    expect(applyFieldErrors(axiosErr(403, { error: { code: 'FORBIDDEN', message: 'no' } }), vi.fn())).toBe(false);
  });
});
