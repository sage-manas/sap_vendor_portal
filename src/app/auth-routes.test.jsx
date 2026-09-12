import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';

import SignInPage from '@/app/sign-in/page';
import SignUpPage from '@/app/sign-up/page';
import ForgotPasswordPage from '@/app/forgot-password/page';
import ResetPasswordPage from '@/app/reset-password/page';
import ChangePasswordPage from '@/app/change-password/page';
import AcceptInvitationPage from '@/app/accept-invitation/page';
import PlatformResetPasswordPage from '@/app/platform/reset-password/page';

// The screens reached without a session. They render their own chrome rather
// than the portal shell (lib/planes.js's AUTH_PATHS), so they are rendered
// bare here — and, unlike every other route, they must render for a visitor
// carrying no token at all.

const AUTH_API = {
  'GET /auth/workspace': { workspace: { clientId: 'CLT-0001', companyName: 'Nucleus Manufacturing', branding: {} } },
};

const ROUTES = [
  ['/sign-in', SignInPage, /Vendor ID|Email/i],
  ['/sign-up', SignUpPage, /Company|Email/i],
  ['/forgot-password', ForgotPasswordPage, /Email/i],
  ['/reset-password', ResetPasswordPage, /password/i],
  ['/accept-invitation', AcceptInvitationPage, /invitation|password|Loading/i],
  ['/platform/reset-password', PlatformResetPasswordPage, /password/i],
];

describe.each(ROUTES)('%s', (route, Page, expected) => {
  it('renders for a visitor with no session', async () => {
    renderWithPortal(<Page />, { plane: 'bare', route, api: AUTH_API, signedOut: true });

    expect(await screen.findAllByText(expected)).not.toHaveLength(0);
  });
});

describe('/change-password', () => {
  // Not an auth path: it needs a session, and PortalProvider exempts it from
  // the redirect it would otherwise apply (see CHANGE_PASSWORD_PATH there).
  it('renders for a signed-in account still on a temporary password', async () => {
    renderWithPortal(<ChangePasswordPage />, {
      plane: 'bare',
      route: '/change-password',
      api: AUTH_API,
    });

    expect(await screen.findAllByText(/password/i)).not.toHaveLength(0);
  });
});
