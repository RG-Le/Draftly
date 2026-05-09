import { ApiError } from './http';

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      if (typeof error.retryAfterSeconds === 'number') {
        return `Rate limit exceeded. Try again in ${error.retryAfterSeconds}s.`;
      }
      return 'Rate limit exceeded. Please wait and retry.';
    }
    return error.message || fallback;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
