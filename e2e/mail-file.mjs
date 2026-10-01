import path from 'node:path';

// Where the API under test writes the mail it sends (MAIL_TRANSPORT=file in
// playwright.config.mjs), and where a spec reads it back. Registration is
// confirmed by an emailed link, and the browser has no other way to see it.
export const MAIL_FILE = path.resolve(import.meta.dirname, '..', 'test-results', 'e2e-mail.jsonl');
