import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BankChangeRequest } from './components/BankChangeRequest';

// Finding 4.2. The review half of the bank-account change has existed since
// issue #53: a change to any payout column on an Approved supplier is diverted
// into `Vendor.pendingBankChange`, and the tenant approves it and then confirms
// it was keyed into SAP. Every part of that worked except the first — an
// approved supplier's own screen showed their account masked, read-only, with
// no way to ask for a change. The only route was emailing someone, on the one
// field the whole review flow exists to protect.
//
// Rendered directly rather than through the whole RegistrationView: this is a
// self-contained card over an endpoint that already behaves correctly, and
// the 1400-line registration flow around it has its own suite.

const APPROVED = {
  status: 'Approved',
  vendorId: 'vendor_test_001',
  companyName: 'Acme Industries Pvt Ltd',
  accountName: 'Acme Industries Pvt Ltd',
  accountNumber: '50100123456789',
  ifscCode: 'HDFC0000060',
  bankName: 'HDFC Bank',
  bankBranch: 'Andheri East',
  pendingBankChange: null,
};

const NEW_ACCOUNT = {
  accountName: 'Acme Industries Private Limited',
  accountNumber: '917020041234567',
  ifscCode: 'UTIB0000123',
  bankName: 'Axis Bank',
  bankBranch: 'Powai',
};

const renderCard = (profile = APPROVED, onSubmit = vi.fn().mockResolvedValue({ success: true })) => {
  const result = render(<BankChangeRequest profile={profile} onSubmit={onSubmit} />);
  return { ...result, onSubmit };
};

const fillForm = async (fields = NEW_ACCOUNT) => {
  await userEvent.clear(screen.getByLabelText(/account holder name/i));
  await userEvent.type(screen.getByLabelText(/account holder name/i), fields.accountName);
  await userEvent.type(screen.getByLabelText(/bank account number/i), fields.accountNumber);
  await userEvent.clear(screen.getByLabelText(/ifsc code/i));
  await userEvent.type(screen.getByLabelText(/ifsc code/i), fields.ifscCode);
  await userEvent.clear(screen.getByLabelText(/bank name/i));
  await userEvent.type(screen.getByLabelText(/bank name/i), fields.bankName);
  await userEvent.clear(screen.getByLabelText(/bank branch/i));
  await userEvent.type(screen.getByLabelText(/bank branch/i), fields.bankBranch);
};

describe('an approved supplier can ask for their payout account to be changed', () => {
  it('offers a way to request a change', () => {
    renderCard();

    expect(screen.getByRole('button', { name: /request a change/i })).toBeInTheDocument();
  });

  it('sends the five bank fields', async () => {
    const { onSubmit } = renderCard();

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(NEW_ACCOUNT);
  });

  it('says the change is not in effect yet', async () => {
    const { onSubmit } = renderCard();

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // The thing a supplier most needs to be told, and the thing a form that
    // merely said "Saved" would get wrong: their money still goes to the old
    // account until a person approves this and records it in SAP.
    expect(await screen.findByRole('status')).toHaveTextContent(/once your buyer approves it/i);
  });

  it('does not pre-fill the account number', async () => {
    renderCard();

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));

    // The field's purpose is to state a *new* account. Pre-filling the old
    // one invites a submit that changes nothing.
    expect(screen.getByLabelText(/bank account number/i)).toHaveValue('');
  });
});

describe('the request is validated before it is sent', () => {
  it('refuses an account number that is not 9 to 18 digits', async () => {
    const { onSubmit } = renderCard();

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await fillForm({ ...NEW_ACCOUNT, accountNumber: '12345' });
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByText(/9 to 18 digits/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a malformed IFSC code', async () => {
    const { onSubmit } = renderCard();

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await fillForm({ ...NEW_ACCOUNT, ifscCode: 'NOTANIFSC' });
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByText(/standard format/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses an empty form rather than sending blanks over a live account', async () => {
    const { onSubmit } = renderCard();

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await userEvent.clear(screen.getByLabelText(/account holder name/i));
    await userEvent.clear(screen.getByLabelText(/bank name/i));
    await userEvent.clear(screen.getByLabelText(/bank branch/i));
    await userEvent.clear(screen.getByLabelText(/ifsc code/i));
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(screen.getByText(/account number is required/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('reports a refusal from the server instead of claiming success', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: false, error: 'GSTIN does not match our records' });
    renderCard(APPROVED, onSubmit);

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('GSTIN does not match our records');
  });

  it('reports a thrown error too', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Network unreachable'));
    renderCard(APPROVED, onSubmit);

    await userEvent.click(screen.getByRole('button', { name: /request a change/i }));
    await fillForm();
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network unreachable');
  });
});

describe('the live account and a pending request are never confused', () => {
  it('shows the account SAP will actually pay, masked', () => {
    renderCard();

    expect(screen.getByText('••••6789')).toBeInTheDocument();
    expect(screen.getByText(/HDFC Bank \(HDFC0000060\)/)).toBeInTheDocument();
  });

  it('shows a pending request as pending, and says payments have not moved', () => {
    renderCard({
      ...APPROVED,
      pendingBankChange: { ...NEW_ACCOUNT, requestedAt: '2026-10-01T10:00:00.000Z' },
    });

    expect(screen.getByText(/awaiting your buyer’s approval/i)).toBeInTheDocument();
    expect(screen.getByText(/still go to the account above/i)).toBeInTheDocument();
    // The requested account, also masked, and distinguishable from the live one.
    expect(screen.getByText('••••4567')).toBeInTheDocument();
    expect(screen.getByText('Axis Bank')).toBeInTheDocument();
  });

  it('distinguishes an approved-but-not-yet-in-SAP request', () => {
    // approveBankChange records sapApproval and leaves the live row alone when
    // the tenant's SAP has no endpoint for the update (the driver throws
    // not_implemented), until someone confirms it was keyed into XK02. A
    // supplier seeing an unchanged account needs that explained.
    renderCard({
      ...APPROVED,
      pendingBankChange: {
        ...NEW_ACCOUNT,
        requestedAt: '2026-10-01T10:00:00.000Z',
        sapApproval: { approvedAt: '2026-10-02T10:00:00.000Z' },
      },
    });

    expect(screen.getByText(/being recorded in your buyer’s SAP system/i)).toBeInTheDocument();
    expect(screen.getByText(/has approved this change/i)).toBeInTheDocument();
  });

  it('does not offer to replace a request already approved and awaiting SAP', () => {
    renderCard({
      ...APPROVED,
      pendingBankChange: { ...NEW_ACCOUNT, sapApproval: { approvedAt: '2026-10-02T10:00:00.000Z' } },
    });

    // At that point it is out of the supplier's hands — the buyer has
    // committed to it and is keying it in.
    expect(screen.queryByRole('button', { name: /request a change|replace request/i })).not.toBeInTheDocument();
  });

  it('warns that a new request replaces one still awaiting approval', async () => {
    renderCard({
      ...APPROVED,
      pendingBankChange: { ...NEW_ACCOUNT, requestedAt: '2026-10-01T10:00:00.000Z' },
    });

    await userEvent.click(screen.getByRole('button', { name: /replace request/i }));

    // The server overwrites pendingBankChange rather than refusing a second
    // request, so without this a supplier correcting a typo and a supplier
    // discarding their earlier request look identical.
    expect(screen.getByText(/replaces the request already awaiting approval/i)).toBeInTheDocument();
  });

  it('shows only the fields a pending request actually changed', () => {
    // The server stores only the fields that differed from the live row.
    renderCard({
      ...APPROVED,
      pendingBankChange: { ifscCode: 'UTIB0000123', bankName: 'Axis Bank', requestedAt: '2026-10-01T10:00:00.000Z' },
    });

    expect(screen.getByText('UTIB0000123')).toBeInTheDocument();
    expect(screen.getByText('Axis Bank')).toBeInTheDocument();
    // Nothing invented for the three fields the request did not mention.
    expect(screen.queryByText('Powai')).not.toBeInTheDocument();
  });
});
