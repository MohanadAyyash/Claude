# User-guide screenshots

Regenerates the annotated screenshots in `public/guide/img/{ar,en}` and inserts them into `docs/USER-GUIDE-*.md`.
Uses demo data only — never point it at the live database.

```bash
DATA_DIR=/tmp/guide-data PORT=3999 node server.js &      # empty database
node tools/guide-shots/seed.js                           # demo company, projects, staff…
node tools/guide-shots/run.js "" ar,en                    # all screens (or e.g. run.js 13,26 ar)
python3 tools/guide-shots/docs.py                        # (re)insert images + numbered explanations
node tools/build-guide.js                                # rebuild the searchable in-app guide (public/guide/index.html)
node tools/build-guide-pdf.js                            # PDFs: docs/Trigon-ERP-User-Guide-{AR,EN}.pdf
```
`setup-shot.js` captures the first-time setup screen and needs a second, empty server (`BASE=http://localhost:3998`).
Needs Playwright with Chromium.
