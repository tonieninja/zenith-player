const REMEMBER_LOGIN_KEY = 'zenith_remember_login';

export function getRememberLogin(): boolean {
  const v = localStorage.getItem(REMEMBER_LOGIN_KEY);
  if (v === null) return true;
  return v === '1';
}

export function setRememberLogin(enabled: boolean): void {
  localStorage.setItem(REMEMBER_LOGIN_KEY, enabled ? '1' : '0');
}
