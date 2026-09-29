import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';

import WorkspaceUsersPage from '@/app/workspace/users/page';
import WorkspaceSettingsPage from '@/app/workspace/settings/page';

// Issue #159. Of the ten workspace screens, these two were the only ones that
// crashed to Next's raw error boundary when a workspace API call failed —
// every other screen (including /workspace/audit, which loads the same way)
// degraded to the usual inline error notice. The cause: useResource sets
// `data: null` on a failed load, and these two pages read `data.foo`
// unguarded instead of `data?.foo` like the rest of the console does.

const failing = (status) => () => ({ status, body: { error: 'Forbidden' } });

describe('/workspace/users, when the API call fails', () => {
  it('shows an inline error notice instead of crashing', async () => {
    renderWithPortal(<WorkspaceUsersPage />, {
      plane: 'workspace',
      route: '/workspace/users',
      api: { ...EMPTY_WORKSPACE_API, 'GET /users': failing(403) },
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/forbidden/i);
    });
    expect(screen.getByRole('heading', { name: 'Users', level: 1 })).toBeInTheDocument();
  });
});

describe('/workspace/settings, when the API call fails', () => {
  it('shows an inline error notice instead of crashing', async () => {
    renderWithPortal(<WorkspaceSettingsPage />, {
      plane: 'workspace',
      route: '/workspace/settings',
      api: { ...EMPTY_WORKSPACE_API, 'GET /workspace/settings': failing(500) },
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/forbidden/i);
    });
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
  });
});
