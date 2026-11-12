export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new AppError(400, 'BAD_REQUEST', message, fields);
export const validationFailed = (fields: Record<string, string>, message = 'Please correct the highlighted fields') =>
  new AppError(400, 'VALIDATION_FAILED', message, fields);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, code = 'CONFLICT', details?: Record<string, unknown>) =>
  new AppError(409, code, message, undefined, details);
export const unprocessable = (message: string, code = 'UNPROCESSABLE', fields?: Record<string, string>) =>
  new AppError(422, code, message, fields);
export const tooMany = (message = 'Too many requests. Please try again later.') =>
  new AppError(429, 'RATE_LIMITED', message);
