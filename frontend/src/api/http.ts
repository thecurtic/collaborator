import type { ApiError } from './types';

/** Thrown for any non-2xx response or network failure. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/**
 * Base URL for the API. In dev we hit a relative path so Vite's proxy forwards
 * /api to the backend (see vite.config.ts). In other environments set
 * VITE_API_BASE_URL (e.g. the production host).
 */
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // fall through to status text
  }
  return res.statusText || `Request failed with status ${res.status}`;
}

export async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch (cause) {
    throw new ApiRequestError(
      'Network error — is the backend running?',
      0,
    );
  }

  if (!res.ok) {
    throw new ApiRequestError(await parseError(res), res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
