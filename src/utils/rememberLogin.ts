const REMEMBER_LOGIN_KEY = 'zenith_remember_login';

export function getRememberLogin(): boolean {
  try {
    const v = localStorage.getItem(REMEMBER_LOGIN_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

export function setRememberLogin(enabled: boolean): void {
  try {
    localStorage.setItem(REMEMBER_LOGIN_KEY, enabled ? '1' : '0');
  } catch (err) {
    console.debug('rememberLogin setRememberLogin', err);
  }
}
