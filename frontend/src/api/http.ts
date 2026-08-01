import { getSessionToken, notifyForbidden } from '@/auth/session';
import type { ApiError } from './types';

/** Thrown for any non-2xx response or network failure. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds from a 429's Retry-After header (brute-force lockout). */
    readonly retryAfterS?: number,
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
    const body = (await res.json()) as Partial<ApiError> & {
      detail?: unknown;
    };
    // API-SPEC says { error }, but the as-built FastAPI backend sends { detail }
    // (a string for HTTPException, or an array for 422 validation errors).
    if (body && typeof body.error === 'string') return body.error;
    if (typeof body?.detail === 'string') return body.detail;
    if (Array.isArray(body?.detail)) {
      const msg = body.detail
        .map((d) =>
          d && typeof d === 'object' && 'msg' in d
            ? String((d as { msg: unknown }).msg)
            : String(d),
        )
        .join('; ');
      if (msg) return msg;
    }
  } catch {
    // fall through to status text
  }
  return res.statusText || `Request failed with status ${res.status}`;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  // Build headers explicitly so we attach the passkey and a sensible
  // Content-Type, while letting a caller's headers merge instead of clobbering.
  const headers = new Headers(init?.headers);
  // Don't force application/json for FormData — the browser must set the
  // multipart boundary itself.
  const isFormData =
    typeof FormData !== 'undefined' && init?.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Browsers authenticate via the httpOnly session cookie (rides on its own,
  // same-origin); the Android shell attaches its session token instead.
  const token = getSessionToken();
  if (token) headers.set('X-Session', token);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch (err) {
    // AbortError surfaces as-is so callers can distinguish a user cancel.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError('Network error — is the backend running?', 0);
  }

  if (!res.ok) {
    const message = await parseError(res);
    // 403 (or 401, if a proxy/backend swaps codes) = no valid session:
    // drop the shell token and let the UI lock for re-login.
    if (res.status === 403 || res.status === 401) notifyForbidden();
    const retryAfter = Number(res.headers.get('Retry-After'));
    throw new ApiRequestError(
      message,
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  return res;
}

/** Make a request and parse a JSON response. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Make a request and return the raw streaming Response (e.g. an SSE body). */
export async function requestStream(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return send(path, init);
}
