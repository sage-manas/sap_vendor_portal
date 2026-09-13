import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePortal } from '@/lib/portal-context';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, VENDOR_PROFILE } from '@/test/fixtures';
import RegistrationPage from '@/app/registration/page';
import { validateField } from '@/features/profile/validation';

// Registration is where a supplier's compliance identity is captured, and
// where GSTIN/PAN/IFSC either hold or do not. validation.js's rules already
// have unit tests; these cover the two things those cannot see — that the
// wizard actually applies them before it will advance, and that a completed
// registration reaches the API as a submission rather than only a draft.

const DRAFT_PROFILE = { ...VENDOR_PROFILE, status: 'Draft', submittedAt: null };

const draftApi = {
  ...EMPTY_SUPPLIER_API,
  'GET /vendors/profile': DRAFT_PROFILE,
};

describe('the rules the wizard enforces', () => {
  // Guards the wiring rather than the rules: if validateField stopped
  // recognising these, every step gate in the wizard would silently open.
  it.each([
    ['gstin', '27AABCB1234F1Z5', 'NOTAGSTIN'],
    ['pan', 'AABCB1234F', 'BADPAN'],
    ['ifscCode', 'HDFC0000060', 'nope'],
  ])('%s accepts a valid value and rejects a malformed one', (fieldName, good, bad) => {
    expect(validateField(fieldName, good)).toBeFalsy();
    expect(validateField(fieldName, bad)).toBeTruthy();
  });
});

describe('the registration wizard', () => {
  it('refuses to advance while mandatory fields are empty', async () => {
    const user = userEvent.setup();
    renderWithPortal(<RegistrationPage />, {
      plane: 'supplier',
      route: '/registration',
      api: { ...draftApi, 'GET /vendors/profile': { ...DRAFT_PROFILE, companyName: '' } },
    });

    await screen.findByRole('heading', { name: /Vendor Registration/i });
    const next = await screen.findByRole('button', { name: /Continue|Next/i });
    await user.click(next);

    expect(await screen.findByText(/fill in all mandatory fields/i)).toBeInTheDocument();
  });
});

// The submit itself goes through the provider's handler, for the same reason
// the ASN test does: the button sits at the end of a four-step wizard, and
// what is worth pinning is the payload and the status transition, not the
// route through the steps. The chain below the handler is the real one.
const SubmitHarness = () => {
  const { profileHook } = usePortal();
  return (
    <button
      type="button"
      onClick={() => profileHook.submitRegistration({
        ...VENDOR_PROFILE,
        companyName: 'Test Supplier Pvt Ltd',
        gstin: '27AABCB1234F1Z5',
        pan: 'AABCB1234F',
        ifscCode: 'HDFC0000060',
      })}
    >
      submit registration
    </button>
  );
};

describe('submitting a completed registration', () => {
  it('sends the profile and then the submission, with the compliance fields intact', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<SubmitHarness />, {
      plane: 'supplier',
      route: '/registration',
      api: {
        ...draftApi,
        'PUT /vendors/profile': { vendor: { ...VENDOR_PROFILE, status: 'Pending Approval' } },
        'POST /vendors/profile/submit': { vendor: { ...VENDOR_PROFILE, status: 'Under Review' } },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'submit registration' }));

    await waitFor(() =>
      expect(apiMock.callsTo('POST', '/vendors/profile/submit')).toHaveLength(1));

    // Saving the profile is not the same act as submitting it for approval —
    // a draft that was only saved never reaches the approval queue.
    expect(apiMock.callsTo('PUT', '/vendors/profile')).toHaveLength(1);

    const saved = apiMock.lastBody('PUT', '/vendors/profile');
    expect(saved).toMatchObject({
      companyName: 'Test Supplier Pvt Ltd',
      gstin: '27AABCB1234F1Z5',
      pan: 'AABCB1234F',
      ifscCode: 'HDFC0000060',
      status: 'Pending Approval',
    });
    expect(saved.submittedAt).toEqual(expect.any(String));
  });

  it('re-reads the profile afterwards, so the server decides the status', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<SubmitHarness />, {
      plane: 'supplier',
      route: '/registration',
      api: {
        ...draftApi,
        'PUT /vendors/profile': { vendor: DRAFT_PROFILE },
        'POST /vendors/profile/submit': { vendor: { ...VENDOR_PROFILE, status: 'Under Review' } },
      },
    });

    const before = apiMock.callsTo('GET', '/vendors/profile').length;
    await user.click(await screen.findByRole('button', { name: 'submit registration' }));

    // The backend runs the GSTIN/PAN check synchronously with the submit and
    // may answer 'Under Review' rather than 'Pending Approval', so the client's
    // optimistic status must not be the last word.
    await waitFor(() =>
      expect(apiMock.callsTo('GET', '/vendors/profile').length).toBeGreaterThan(before));
  });
});

// The wizard is built from FieldCards, and five of them do not hand over a
// bare input: two wrap a SearchableSelect for width, two wrap an input for a
// positioned adornment, and one is a file drop zone. Those are exactly the
// shapes an association helper misses — silently, because an unlabelled field
// looks identical on screen.
//
// Scope: step 1 only. The wizard refuses to advance past a step with empty
// mandatory fields (asserted above), so walking all four here would mean
// filling the whole form; the two SearchableSelects — the case most likely to
// regress, since a custom component has to forward the id itself — are both on
// step 1.
describe('every field on the first step is announced with a name', () => {
  const unlabelled = () => [
    ...document.querySelectorAll('input, select, textarea, [aria-haspopup="listbox"]'),
  ]
    .filter((el) => el.type !== 'hidden')
    .filter((el) => !el.labels?.length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
    .map((el) => el.id || el.name || el.placeholder || el.textContent?.trim().slice(0, 30) || el.type);

  it('associates a label with every control', async () => {
    // FieldCard reports a field it could not attach a label to; nothing else
    // in the app writes this prefix.
    const warnings = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (String(args[0]).includes('[FieldCard]')) warnings.push(String(args[0]));
    });

    renderWithPortal(<RegistrationPage />, {
      plane: 'supplier', route: '/registration', api: draftApi,
    });
    await screen.findByRole('heading', { name: /Vendor Registration/i });

    expect(warnings).toEqual([]);
    expect(unlabelled()).toEqual([]);
  });

  it('labels the searchable selects, whose control is a button rather than an input', async () => {
    renderWithPortal(<RegistrationPage />, {
      plane: 'supplier', route: '/registration', api: draftApi,
    });
    await screen.findByRole('heading', { name: /Vendor Registration/i });

    // SearchableSelect renders its own trigger button and has to forward the
    // id onto it; passing the prop is not proof that it did.
    const triggers = [...document.querySelectorAll('[aria-haspopup="listbox"]')];
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      expect(trigger.id).toBeTruthy();
      expect(trigger.labels?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
