import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';

// A field inside this modal went inactive after every keystroke: the
// focus-on-open effect used to depend on `[open, onClose]`, and `onClose` is
// typically a fresh inline arrow function on every render of whichever
// screen owns the modal — RfqView's Update Price modal is one such caller.
// Each keystroke's state update re-rendered the caller, `onClose` got a new
// reference, the effect re-ran, and `panelRef.current.focus()` yanked focus
// off the input and onto the modal panel mid-word.

describe('Modal focus does not fight a field inside it', () => {
  it('keeps focus in a text field across keystrokes even when onClose is a new function every render', async () => {
    const user = userEvent.setup();

    // Mimics a real caller re-rendering on its own state and handing Modal a
    // brand new onClose closure each time — exactly what RfqView's
    // closePriceUpdate is, since it is not wrapped in useCallback.
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <Modal open onClose={() => {}} title="Test">
          <input aria-label="Price" value={value} onChange={(e) => setValue(e.target.value)} />
        </Modal>
      );
    }

    render(<Harness />);
    const input = screen.getByLabelText('Price');

    await user.click(input);
    await user.type(input, '1000');

    expect(input).toHaveValue('1000');
    expect(input).toHaveFocus();
  });

  it('still focuses the panel itself when there is no field to focus', () => {
    const { rerender } = render(<Modal open={false} onClose={() => {}} title="Test">content</Modal>);
    rerender(<Modal open onClose={() => {}} title="Test">content</Modal>);

    expect(screen.getByRole('dialog')).toHaveFocus();
  });
});
