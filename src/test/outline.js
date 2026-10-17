import { expect } from 'vitest';

const headingLevels = () => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
  .map((node) => ({ level: Number(node.tagName[1]), text: node.textContent.trim() }));

/**
 * Asserts the rendered page's heading outline opens at the page title and
 * descends one level at a time.
 *
 * The page title is the h1 on every surface (components/ui/Page.jsx's
 * PageHeader). It used to be an h2 under an h1 the old supplier header held;
 * the redesigned shell names its workspace in plain text, so the page owns
 * the h1, as the workspace and platform pages already did.
 *
 * A skip matters because assistive technology presents headings as a tree:
 * jumping h1 -> h3 claims a section that is not there, and a page whose first
 * heading is deeper than h1 has no name at all.
 *
 * @param {string} where names the screen in the failure message
 */
export const expectHeadingOutline = (where) => {
  const headings = headingLevels();
  const shown = JSON.stringify(headings);

  expect(headings[0]?.level, `first heading on ${where}: ${shown}`).toBe(1);
  headings.slice(1).forEach(({ level }, i) => {
    expect(level - headings[i].level, `heading ${i + 1} on ${where}: ${shown}`).toBeLessThanOrEqual(1);
  });
};
