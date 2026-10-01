import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';

import SignUpPage from '@/app/sign-up/page';
import ConfirmEmailPage from '@/app/confirm-email/page';

// Finding 1.4. Registration no longer hands back a session: the account exists
// once the emailed link has been followed, and the API answers the same 202
// whether or not the address was already known. So the screen after "Create
// Account" must not sign anyone in, and must not say anything the API did not.

const WORKSPACE = {
  'GET /auth/workspace': {
    workspace: {
      clientId: 'CLT-0001',
      companyName: 'Nucleus Manufacturing',
      branding: {},
      features: { supplierSelfRegistration: true },
    },
  },
};

describe('sign-up', () => {
  const fill = async (user) => {
    await user.type(await screen.findByLabelText(/Company Registered Name/i), 'Acme Manufacturing Ltd');
    await user.type(screen.getByLabelText(/Corporate Contact Email/i), 'partner@acme.example');
    await user.type(screen.getByLabelText(/Create Password/i), 'Secret12345');
    await user.type(screen.getByLabelText(/GSTIN Number/i), '27AAAAA1111A1Z1');
    await user.type(screen.getByLabelText(/PAN Number/i), 'AAAAA1111A');
    await user.click(screen.getByRole('button', { name: /Create Account/i }));
  };

  it('tells the visitor to check their email, and starts no session', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<SignUpPage />, {
      plane: 'bare',
      route: '/sign-up',
      signedOut: true,
      api: {
        ...WORKSPACE,
        'POST /auth/register': { status: 202, body: { success: true, message: 'Check your email.' } },
      },
    });

    await fill(user);

    expect(await screen.findByText(/Check your email/i)).toBeInTheDocument();
    expect(screen.getByText(/partner@acme.example/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Create Password/i)).not.toBeInTheDocument();

    expect(apiMock.lastBody('POST', '/auth/register')).toEqual({
      companyName: 'Acme Manufacturing Ltd',
      email: 'partner@acme.example',
      password: 'Secret12345',
      gstin: '27AAAAA1111A1Z1',
      pan: 'AAAAA1111A',
    });
    expect(localStorage.getItem('jwt_token')).toBeNull();
    expect(localStorage.getItem('sap_vendor_profile_data')).toBeNull();
  });

  it('shows a validation error from the API on the form', async () => {
    const user = userEvent.setup();
    renderWithPortal(<SignUpPage />, {
      plane: 'bare',
      route: '/sign-up',
      signedOut: true,
      api: {
        ...WORKSPACE,
        'POST /auth/register': { status: 400, body: { errors: { password: 'Password must include a number' } } },
      },
    });

    await fill(user);

    expect(await screen.findByText(/Password must include a number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Create Password/i)).toBeInTheDocument();
  });
});

describe('/confirm-email', () => {
  it('sends the emailed token with the password, then points to sign-in', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<ConfirmEmailPage />, {
      plane: 'bare',
      route: '/confirm-email?token=abc123',
      signedOut: true,
      api: { ...WORKSPACE, 'POST /auth/confirm-email': { success: true, message: 'Email confirmed.' } },
    });

    await user.type(await screen.findByLabelText(/Your password/i), 'Secret12345');
    await user.click(screen.getByRole('button', { name: /Confirm email/i }));

    expect(await screen.findByText(/Email confirmed\. You can now sign in/i)).toBeInTheDocument();
    expect(apiMock.lastBody('POST', '/auth/confirm-email')).toEqual({ token: 'abc123', password: 'Secret12345' });
  });

  it('shows the refusal for a wrong password or a dead link', async () => {
    const user = userEvent.setup();
    renderWithPortal(<ConfirmEmailPage />, {
      plane: 'bare',
      route: '/confirm-email?token=abc123',
      signedOut: true,
      api: {
        ...WORKSPACE,
        'POST /auth/confirm-email': { status: 400, body: { error: 'This confirmation link is invalid or has expired, or the password does not match.' } },
      },
    });

    await user.type(await screen.findByLabelText(/Your password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /Confirm email/i }));

    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/You can now sign in/i)).not.toBeInTheDocument();
  });

  it('does not call the API for a link that lost its token', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<ConfirmEmailPage />, {
      plane: 'bare',
      route: '/confirm-email',
      signedOut: true,
      api: WORKSPACE,
    });

    await user.type(await screen.findByLabelText(/Your password/i), 'Secret12345');
    await user.click(screen.getByRole('button', { name: /Confirm email/i }));

    await waitFor(() => expect(screen.getByText(/missing its token/i)).toBeInTheDocument());
    expect(apiMock.callsTo('POST', '/auth/confirm-email')).toHaveLength(0);
  });
});
