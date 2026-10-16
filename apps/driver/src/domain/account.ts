import type { SessionUser } from '../api/types';

export const NOT_DRIVER_MESSAGE = '기사 계정이 아닙니다. 기사 계정으로 로그인해 주세요.';

/** The server decides what an account may do. The app only refuses to open for an account that is not a driver's. */
export function isDriverAccount(user: SessionUser): boolean {
  return user.role === 'driver';
}
