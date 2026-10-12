import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { currentSlug, rememberWorkspace, forgetStoredWorkspace, withWorkspace } from '@/lib/workspace-slug';
import { forgetWorkspaceRealm } from '@/lib/workspace-realm';

import SignInPage from '@/app/sign-in/page';
import SignUpPage from '@/app/sign-up/page';

// One address for every tenant (ADR-0044). A tenant's administrator shares
// `/sign-in?workspace=<slug>` and `/sign-up?workspace=<slug>`; the link only
// picks the branding and the registration target. These pin the browser half:
// the link is read and passed on, malformed values are not, and what a sign-in
// teaches the shell is forgotten when the session ends.

const NORTHWIND = {
  clientId: 'CLT-0002',
  slug: 'northwind',
  companyName: 'Northwind Traders',
  branding: {},
  features: { supplierSelfRegistration: true },
};

const visit = (search) => window.history.pushState({}, '', `/${search}`);

beforeEach(() => {
  visit('');
  localStorage.clear();
  forgetWorkspaceRealm();
});

describe('the workspace slug', () => {
  it('is read from the link, normalised', () => {
    visit('?workspace=%20Northwind');
    expect(currentSlug()).toBe('northwind');
  });

  it.each([
    ['too short', 'a'],
    ['a path', '../admin'],
    ['a slash', 'north/wind'],
    ['a leading hyphen', '-northwind'],
  ])('ignores %s', (_label, value) => {
    visit(`?workspace=${encodeURIComponent(value)}`);
    expect(currentSlug()).toBeNull();
  });

  it('falls back to the one a sign-in remembered, and the link wins over it', () => {
    rememberWorkspace('contoso');
    expect(currentSlug()).toBe('contoso');
    visit('?workspace=northwind');
    expect(currentSlug()).toBe('northwind');
  });

  it('refuses to remember something that is not a slug, and forgets on request', () => {
    rememberWorkspace('../admin');
    expect(localStorage.getItem('vc_workspace')).toBeNull();
    rememberWorkspace('northwind');
    expect(localStorage.getItem('vc_workspace')).toBe('northwind');
    forgetStoredWorkspace();
    expect(localStorage.getItem('vc_workspace')).toBeNull();
  });

  it('is appended to a path only when there is one', () => {
    expect(withWorkspace('/sign-up', 'northwind')).toBe('/sign-up?workspace=northwind');
    expect(withWorkspace('/a?b=1', 'northwind')).toBe('/a?b=1&workspace=northwind');
    expect(withWorkspace('/sign-up', null)).toBe('/sign-up');
    expect(withWorkspace('/sign-up', '../admin')).toBe('/sign-up');
  });
});

describe('sign-in under account tenancy', () => {
  it('names the workspace a link points at, and carries the link on to registration', async () => {
    visit('?workspace=northwind');
    const { apiMock } = renderWithPortal(<SignInPage />, {
      plane: 'bare',
      route: '/sign-in',
      signedOut: true,
      api: { 'GET /auth/workspace': { workspace: NORTHWIND } },
    });

    expect(await screen.findByRole('link', { name: /register profile/i }))
      .toHaveAttribute('href', '/sign-up?workspace=northwind');
    expect(apiMock.calls.some((call) => call.url.endsWith('/auth/workspace?workspace=northwind'))).toBe(true);
  });

  it('with no link, offers no registration and says where to get one', async () => {
    renderWithPortal(<SignInPage />, {
      plane: 'bare',
      route: '/sign-in',
      signedOut: true,
      api: { 'GET /auth/workspace': { workspace: null, tenancy: 'account' } },
    });

    expect(await screen.findByText(/registration link your buyer sent you/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /register profile/i })).not.toBeInTheDocument();
  });

  it('remembers the workspace the account belongs to once it signs in', async () => {
    const user = userEvent.setup();
    renderWithPortal(<SignInPage />, {
      plane: 'bare',
      route: '/sign-in',
      signedOut: true,
      api: {
        'GET /auth/workspace': { workspace: null, tenancy: 'account' },
        'POST /auth/login': {
          token: 'issued-token',
          vendor: { vendorId: 'VND-1' },
          workspace: NORTHWIND,
        },
      },
    });

    await user.type(await screen.findByLabelText(/vendor id or registered email/i), 'supplier@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'Passw0rd-long');
    await user.click(screen.getByRole('button', { name: /sign in|authenticate|log in/i }));

    await waitFor(() => expect(localStorage.getItem('vc_workspace')).toBe('northwind'));
    expect(localStorage.getItem('jwt_token')).toBe('issued-token');
  });

  it('drops a workspace remembered from an earlier session when this sign-in names none', async () => {
    const user = userEvent.setup();
    rememberWorkspace('contoso');
    renderWithPortal(<SignInPage />, {
      plane: 'bare',
      route: '/sign-in',
      signedOut: true,
      api: {
        'GET /auth/workspace': { workspace: null },
        'POST /auth/login': { token: 'issued-token', vendor: { vendorId: 'VND-1' } },
      },
    });

    await user.type(await screen.findByLabelText(/vendor id or registered email/i), 'supplier@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'Passw0rd-long');
    await user.click(screen.getByRole('button', { name: /sign in|authenticate|log in/i }));

    await waitFor(() => expect(localStorage.getItem('jwt_token')).toBe('issued-token'));
    expect(localStorage.getItem('vc_workspace')).toBeNull();
  });
});

describe('sign-up under account tenancy', () => {
  it('registers into the workspace the link names', async () => {
    const user = userEvent.setup();
    visit('?workspace=northwind');
    const { apiMock } = renderWithPortal(<SignUpPage />, {
      plane: 'bare',
      route: '/sign-up',
      signedOut: true,
      api: {
        'GET /auth/workspace': { workspace: NORTHWIND },
        'POST /auth/register': { status: 202, body: { success: true } },
      },
    });

    await screen.findByText(/supplier registration/i);
    const field = (id) => document.getElementById(id);
    await user.type(field('signup-company'), 'Acme Fabrication Pvt Ltd');
    await user.type(field('signup-email'), 'partner@acme.example');
    await user.type(field('signup-password'), 'Passw0rd-long');
    await user.type(field('signup-gstin'), '27AAAAA1111A1Z1');
    await user.type(field('signup-pan'), 'AAAAA1111A');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(apiMock.calls.some((call) => call.method === 'POST' && call.url.endsWith('/auth/register?workspace=northwind'))).toBe(true));
  });

  it('with no link, explains that registration starts from a link instead of showing a form that cannot work', async () => {
    renderWithPortal(<SignUpPage />, {
      plane: 'bare',
      route: '/sign-up',
      signedOut: true,
      api: { 'GET /auth/workspace': { workspace: null, tenancy: 'account' } },
    });

    expect(await screen.findByText(/starts from the link your buying organisation shares/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/gstin/i)).not.toBeInTheDocument();
  });
});
