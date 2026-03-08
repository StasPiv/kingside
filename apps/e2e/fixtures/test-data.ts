/**
 * Test data for E2E tests.
 * Uses timestamps to ensure unique usernames/emails per test run.
 */
export function generateUser(prefix = 'e2e') {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    username: `${prefix}_${id}`,
    email: `${prefix}_${id}@test.local`,
    password: 'TestPass123!',
  };
}

export const API_URL = process.env.E2E_API_URL || 'http://localhost:3000';
