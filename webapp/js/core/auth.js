import { api, apiGet, apiJson } from './api.js?v=1';

export const me = () => apiGet('auth.php?action=me');

export const signup = (email, password, adult_consent, registration_key) =>
  apiJson('auth.php?action=signup', registration_key
    ? { email, password, adult_consent, registration_key }
    : { email, password, adult_consent });

export const login = (email, password) => apiJson('auth.php?action=login', { email, password });

export const recover = (email, recovery_code, password) =>
  apiJson('auth.php?action=recover', { email, recovery_code, password });

export const logout = () => api('auth.php?action=logout', { method: 'POST' });
