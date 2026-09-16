# PDF Splitter (PNL/EL Plan)

Splits and/or renames batches of Parent Notification Letter (PNL) PDFs to
`26-27 ETA PNL [Student ID].pdf` by reading the Student ID out of each
PDF. Everything runs client-side in the browser — no upload, no backend,
no account. Verified to make zero external network requests once loaded.

## Run it locally

```bash
npm install
npm run dev       # dev server, or:
npm run build && npm run preview   # production build + local preview
```

## Deploy

`npm run build` produces a static `dist/` folder — deploy it as-is to
Netlify (drag-and-drop at app.netlify.com/drop), GitHub Pages, Cloudflare
Pages, or any static host.

## Two modes

- **Split one merged PDF** (default tab): upload one PDF containing every
  student's letter back-to-back. Splits into fixed 2-page units, reads the
  Student ID from within each unit, and flags anything where the page count
  doesn't divide evenly or the two pages in a unit disagree on the ID.
- **Rename individual PDFs**: for files that are already separated —
  select or drag in a batch, same detection logic, no splitting step.

## How detection works

1. **Embedded PDF text + label matching** (`src/lib/detectId.ts`, via
   pdf.js): finds the "Student ID" label — in English or a translated
   equivalent — and reads the value in the same column, whether it's on
   the same line, the line above, or the line below. Handles both simple
   "Label: value" layouts and fill-in-the-blank layouts where the label
   and value are drawn as separate lines.
2. **Positional fallback**: if no label matches, looks for plausible
   4–10 digit numbers in the upper portion of the page, scored by position
   and length, with decoys (dates, phone numbers, zip codes, grades,
   proficiency scores) filtered out by nearby context words.
3. **OCR fallback** (Tesseract.js, fully local): only runs when the page
   has little/no embedded text (i.e. it's a scan). Applies the same
   label-matching logic to OCR'd words. Deliberately does *not* do a
   context-free "just find digits" pass on pages that already have
   embedded text with no ID present — that was found to reliably misread
   phone numbers as IDs.

Multiple languages are supported for the label text (the MD ELD template
layout is unchanged across translations) — see `LABEL_PATTERNS` and
`EXCLUSION_CONTEXT_WORDS_INTL` in `src/lib/detectId.ts` to add or correct
entries. These were originally verified against real official MCPS
translated PNL templates, not guessed translations, and that's the
workflow to repeat if a district's exact wording differs from what's here.

## Privacy

No PDF bytes, filenames, or extracted text are ever sent anywhere. All
processing (text extraction, OCR, ZIP building) happens in-browser. All
library assets (pdf.js worker, cmaps, standard fonts, Tesseract.js worker/
core/wasm/traineddata) are bundled locally under `public/` — nothing is
fetched from a CDN at runtime.

## Note on this copy

This source was reconstructed from the original build conversation record
(the working sandbox it was originally built in is ephemeral and no longer
accessible). Core logic — detection, splitting, safety checks, UI — has
been rebuilt and independently re-verified end-to-end in a real browser
(type-checks clean, builds clean, zero console errors, zero external
network calls, correct split/detect/rename/download for a real 2-student
test batch). The one area to treat as lower-confidence is the exact
wording in the non-English `LABEL_PATTERNS`/`EXCLUSION_CONTEXT_WORDS_INTL`
regexes — those were reassembled from chat fragments and, while structured
the same way as the verified originals, are worth spot-checking against a
real sample in each language before relying on them.
