# Snag website

Landing page and ten developer guides, kept alongside the application source.

```bash
npm run build
npm test
npm run dev
```

Open http://localhost:4173. Node.js runs the build/check scripts; Python 3 serves the preview. No npm dependencies are required.

Edit `src/index.html` for the landing page, `src/docs/` for guides, and `src/samples.json` for the landing-page examples. `src/app.js` handles copy buttons, sample tabs, the illustrative workflow demo, and guide filtering. `src/style.css` contains responsive styles.

The examples target a separate local Snag instance. The site never sends requests to the Snag API. The workflow illustration is sample data, not a connected dashboard.

Build output is in `dist/` and can be served by any static host. The `.openai/hosting.json` file retains the registered private Sites identity; registration alone does not mean the site is deployed.

Fonts load from Google Fonts with system-font fallbacks. The project uses Apache-2.0; see the repository's root LICENSE.
