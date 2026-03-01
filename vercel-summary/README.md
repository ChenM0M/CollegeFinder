# CollegeFinder Summary (Static)

This folder is a standalone, static `summary` page that can be deployed to Vercel without running the backend.

## Deploy to Vercel

- In Vercel, set **Root Directory** to `vercel-summary`.
- No build step is required.

## Data

- The page loads `./results.json` (committed in this folder).
- To update data: replace `vercel-summary/results.json` with a newer export, commit, and redeploy.

## Local preview

Run a static file server from this folder (do not open `index.html` via `file://`).

```bash
cd vercel-summary
python -m http.server 8000
```

Then open:

- `http://localhost:8000/`
