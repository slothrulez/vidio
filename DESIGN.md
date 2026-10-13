# vidio design guide

## Product and audience
vidio is an AI product-video creation tool for e-commerce sellers and creators: upload product images, get selling points and a script, generate scenes and compose a finished short video.

## Brand and visual direction
- **Name**: vidio, always lowercase, never translated or capitalised.
- **Logo**: original geometric "V" mark with the lowercase vidio wordmark; no legacy mascot or third-party platform logos.
- **Assets**: [wordmark](public/assets/vidio-logo.svg), [icon](public/assets/vidio-icon.svg); favicon, app icons and the social image live in `src/app/`.
- **Compatibility**: branding changes never alter existing APIs, environment variable names, browser-persisted data or media paths.
- **Keywords**: minimal, soft, modern, professional.
- **Primary palette**: soft lavender (calm, trustworthy).
- **Overall style**: light theme, off-white background, restrained purple accents.

## Design tokens

### Colours
- Background: #F8F7F5 (off-white)
- Primary: #D4C2F6 (soft lavender)
- Primary button: #B999F3 (purple)
- Secondary: #7A7A7A (dark grey icons)
- Selected background: #ECE6F7 (light lavender tint)
- Card background: #F1F3F5 (light grey-white)
- Input background: #FFFFFF with #E5E5E5 border

### Text colours
- Headings: #333333
- Secondary text: #666666
- Timestamps / tertiary text: #999999

### Typography
- System default font stack.

### Layout and responsiveness
- Max width: `max-w-4xl`
- Padding: `px-4 py-8`
- Spacing: Tailwind spacing scale (gap-2, gap-4, …)

### Components
- Cards: light grey-white background (#F1F3F5)
- Buttons: lavender fill (#D4C2F6 or #B999F3) with dark grey text
- Inputs: white background, light grey border, rounded corners
- Selected sidebar item: light lavender tint (#ECE6F7)

### Icons
- Lucide React icon set.
