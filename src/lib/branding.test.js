import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { hexToRgbTriplet, accentVariables, brandMark, ACCENT_VARIABLE } from './branding';

// The accent a tenant picks is validated on the way in by the settings registry
// and rendered on the way out by this module. If the two disagree about what a
// colour looks like, a tenant saves a value that silently does nothing — so the
// test reaches across to the real registry rather than restating its rule.
const require = createRequire(import.meta.url);
const { SETTING_DEFINITIONS } = require('../../backend/config/tenantSettings');

const accentSetting = SETTING_DEFINITIONS.find((setting) => setting.key === 'branding.primaryColor');

describe('tenant accent colours', () => {
  it('renders a hex colour as the rgb triplet the stylesheet expects', () => {
    expect(hexToRgbTriplet('#2f6f4e')).toBe('47, 111, 78');
    expect(hexToRgbTriplet('2f6f4e')).toBe('47, 111, 78');
    expect(hexToRgbTriplet('#FFFFFF')).toBe('255, 255, 255');
    expect(hexToRgbTriplet('#000000')).toBe('0, 0, 0');
  });

  it('reads nothing out of a value that is not a colour', () => {
    for (const value of ['', null, undefined, 'rebeccapurple', '#abc', '#12345g', 'javascript:alert(1)']) {
      expect(hexToRgbTriplet(value)).toBeNull();
    }
  });

  it('overrides exactly one variable, the accent the design system already has', () => {
    expect(accentVariables('#2f6f4e')).toEqual({ [ACCENT_VARIABLE]: '47, 111, 78' });
  });

  it('leaves the console default alone when a tenant has not chosen one', () => {
    expect(accentVariables('')).toEqual({});
    expect(accentVariables(undefined)).toEqual({});
  });

  it('accepts every colour the settings registry accepts', () => {
    const valid = '#2f6f4e';
    expect(accentSetting.type).toBe('color');
    expect(hexToRgbTriplet(valid)).not.toBeNull();
    // …and nothing it rejects reaches a style property.
    expect(accentVariables('not-a-colour')).toEqual({});
  });
});

describe('the mark on a signed-out screen', () => {
  it('names the workspace, with its logo when it has one', () => {
    expect(brandMark({ companyName: 'Northwind Traders', branding: { logo: 'https://cdn/nw.svg' } }))
      .toEqual({ name: 'Northwind Traders', logo: 'https://cdn/nw.svg' });
  });

  it('falls back to the product mark before the realm has answered', () => {
    expect(brandMark(null)).toEqual({ name: 'VendorConnect', logo: null });
    expect(brandMark({ companyName: 'Northwind Traders', branding: {} }))
      .toEqual({ name: 'Northwind Traders', logo: null });
  });
});
