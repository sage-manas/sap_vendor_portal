import { expect } from 'vitest';

const headingLevels = () => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
  .map((node) => ({ level: Number(node.tagName[1]), text: node.textContent.trim() }));

/**
 * Asserts the rendered page's heading outline opens at the page title (h2 —
 * the app shell owns the h1) and descends one level at a time.
 *
 * A skip matters because assistive technology presents headings as a tree:
 * jumping h2 -> h4 claims a section that is not there, and a page whose first
 * heading is deeper than h2 has no name at all.
 *
 * @param {string} where names the screen in the failure message
 */
export const expectHeadingOutline = (where) => {
  const headings = headingLevels();
  const shown = JSON.stringify(headings);

  expect(headings[0]?.level, `first heading on ${where}: ${shown}`).toBe(2);
  headings.slice(1).forEach(({ level }, i) => {
    expect(level - headings[i].level, `heading ${i + 1} on ${where}: ${shown}`).toBeLessThanOrEqual(1);
  });
};
