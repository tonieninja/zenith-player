export const ONBOARDING_VERSION = 1;
export const LEGAL_ACK_VERSION = 1;

const DONE_KEY = 'zenith_onboarding_done';
const LEGAL_KEY = 'zenith_legal_ack';

export function isOnboardingDone(): boolean {
  return localStorage.getItem(DONE_KEY) === String(ONBOARDING_VERSION);
}

export function markOnboardingDone(): void {
  localStorage.setItem(DONE_KEY, String(ONBOARDING_VERSION));
}

export function isLegalAcked(): boolean {
  return localStorage.getItem(LEGAL_KEY) === String(LEGAL_ACK_VERSION);
}

export function markLegalAcked(): void {
  localStorage.setItem(LEGAL_KEY, String(LEGAL_ACK_VERSION));
}

export function resetOnboarding(): void {
  localStorage.removeItem(DONE_KEY);
}

export function shouldShowOnboarding(): boolean {
  return !isLegalAcked() || !isOnboardingDone();
}
