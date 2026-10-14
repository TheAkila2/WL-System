import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5001/api',
  headers: {
    'Content-Type': 'application/json',
  },
  // Set timeout to 30 minutes for file uploads and slow connections
  timeout: 30 * 60 * 1000,
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Ensure uploads have extended timeout
  if (config.url?.includes('/uploads')) {
    config.timeout = 30 * 60 * 1000; // 30 minutes
  }
  return config;
});

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries are scoped to GET requests only — POST/PUT/DELETE must never be
// replayed automatically (a retried attempt-create was the root cause of a
// duplicate-key bug earlier). A transient network blip or 502/503/504 (not a
// real 401/404/validation error) on a read should not leave the screen stuck
// during a live competition.
const isRetryableError = (error) => {
  if (error.config?.method?.toLowerCase() !== 'get') return false;
  if (!error.response) return true; // network error / timeout, no response at all
  return [502, 503, 504].includes(error.response.status);
};

// Handle response errors
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
      return Promise.reject(error);
    }

    const config = error.config;
    if (config && isRetryableError(error)) {
      config.__retryCount = (config.__retryCount || 0) + 1;
      if (config.__retryCount <= MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * config.__retryCount);
        return api(config);
      }
    }

    return Promise.reject(error);
  }
);

export default api;
