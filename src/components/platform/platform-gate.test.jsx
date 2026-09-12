import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_PLATFORM_API } from '@/test/fixtures';
import PlatformGate from '@/components/platform/PlatformGate';
import { OPERATOR_SESSION } from '@/test/renderWithPortal';

// The platform console is the one plane that can reach every tenant's data,
// and MFA is what stands in front of it. The gate walks a session through
// password → enrolment → verification and only then renders the console
// (lib/platform-session.js's stageFor). Nothing tested that it actually
// refuses at each step, which is the only part that matters.

const Console = () => <h1>Platform console</h1>;

const renderGate = (session, route = '/platform') => renderWithPortal(
  <PlatformGate><Console /></PlatformGate>,
  { plane: 'platform', route, api: EMPTY_PLATFORM_API, session },
);

const consoleShown = () => screen.queryByRole('heading', { name: 'Platform console' });

// The gate renders a loading spinner until the session resolves; every
// assertion below has to be past that or it proves nothing.
const settled = () => waitFor(() => {
  expect(document.body.textContent.replace(/\s/g, '')).not.toBe('');
}, { timeout: 3000 });

describe('the platform console MFA gate', () => {
  it('opens the console for an operator who has enrolled and verified', async () => {
    renderGate(OPERATOR_SESSION);

    expect(await screen.findByRole('heading', { name: 'Platform console' })).toBeInTheDocument();
  });

  it('refuses an operator who has not enrolled an authenticator', async () => {
    renderGate({ ...OPERATOR_SESSION, mfa: { enrolled: false, verified: false } });

    await settled();
    await waitFor(() => expect(consoleShown()).not.toBeInTheDocument());
  });

  it('refuses an operator who is enrolled but has not typed a code this session', async () => {
    renderGate({ ...OPERATOR_SESSION, mfa: { enrolled: true, verified: false } });

    await settled();
    await waitFor(() => expect(consoleShown()).not.toBeInTheDocument());
  });

  it('refuses an operator still on a provisioned temporary password', async () => {
    renderGate({ ...OPERATOR_SESSION, mustChangePassword: true });

    await settled();
    await waitFor(() => expect(consoleShown()).not.toBeInTheDocument());
  });

  it('refuses a visitor with no operator session at all', async () => {
    renderWithPortal(<PlatformGate><Console /></PlatformGate>, {
      plane: 'platform',
      route: '/platform',
      api: { 'GET /platform/auth/me': { status: 401, body: { error: 'Unauthorized' } } },
    });

    await settled();
    await waitFor(() => expect(consoleShown()).not.toBeInTheDocument());
  });

  it('lets the password-reset route through without a session, and only that route', async () => {
    // Completing a reset happens with no session, so the gate exempts this one
    // path — an exemption worth pinning, since widening it would open the
    // console itself.
    renderWithPortal(<PlatformGate><Console /></PlatformGate>, {
      plane: 'platform',
      route: '/platform/reset-password',
      api: { 'GET /platform/auth/me': { status: 401, body: { error: 'Unauthorized' } } },
    });

    expect(await screen.findByRole('heading', { name: 'Platform console' })).toBeInTheDocument();
  });
});
