export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

export type SessionUser = { username: string; displayName?: string | null };

export type DriverMessage = {
  id: string;
  from: 'ops' | 'driver';
  body: string;
  createdAt: string;
};
