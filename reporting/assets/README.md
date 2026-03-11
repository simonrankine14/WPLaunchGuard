# Branding Assets

To brand the interactive HTML report (`reports/<client>/qa_html/index.html`), place your logo here:

- `reporting/assets/logo.svg` (recommended)
- `reporting/assets/logo.png`
- `reporting/assets/logo.jpg`
- `reporting/assets/logo.jpeg`

The HTML generator will automatically embed the logo as a base64 data URI so the report stays self-contained.

You can also provide a logo path directly when generating the HTML report:

```bash
npm run qa:html -- <client> --logo="/absolute/path/to/logo.png"
```
