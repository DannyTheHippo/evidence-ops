import { clearToken, getToken, setToken } from '../lib/auth';

const API = '/api/v1';

export interface Me {
  id: string;
  email: string;
  createdAt: string;
}

export interface AuthToken {
  accessToken: string;
  user: Me;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return res.statusText || `HTTP ${res.status}`;
    const body = JSON.parse(text) as unknown;
    if (
      body !== null &&
      typeof body === 'object' &&
      'message' in body &&
      typeof (body as Record<string, unknown>).message === 'string'
    ) {
      return (body as Record<string, unknown>).message as string;
    }
  } catch {}
  return res.statusText || `HTTP ${res.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...init, headers });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    clearToken();
    window.location.assign('/login');
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    throw new ApiError(res.status, await readErrorMessage(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : undefined) as T;
}

function jsonBody(data: unknown): RequestInit {
  return { body: JSON.stringify(data) };
}

export function register(email: string, password: string): Promise<Me> {
  return request<Me>('/auth/register', { method: 'POST', ...jsonBody({ email, password }) });
}

export async function login(email: string, password: string): Promise<AuthToken> {
  const result = await request<AuthToken>('/auth/login', {
    method: 'POST',
    ...jsonBody({ email, password }),
  });
  setToken(result.accessToken);
  return result;
}

export function logout(): void {
  clearToken();
}

export function getMe(): Promise<Me> {
  return request<Me>('/auth/me');
}
