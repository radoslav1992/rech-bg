# Rech BG creator theme

Visual adaptation of the user-provided RUBOZ ThemeForest template, specifically its Digital Human Creator (human-creator) demo. The app uses native React components, not the template's JavaScript or Bootstrap bundle.

## Design

- Blue #5667F5, ink #0A0910, ice #F5F8FF, white surfaces.
- Split portrait hero, floating media cards, rounded surfaces, numbered workflow, product examples, caption preview, live voice samples, pricing and FAQ.
- Solid backgrounds and single-color headings; no gradients.
- Existing self-hosted Manrope retains Bulgarian Cyrillic support.
- Shared theme covers public pages, authentication, dashboard and studio controls.
- Desktop/tablet/mobile breakpoints and reduced-motion support.

## Assets

The decorative arrow at public/images/theme/creator-arrow.svg comes from the supplied human-creator demo. The commercial template archive is not redistributed in this repository.

The three fictional example portraits were generated for this redesign, converted to 900×1200 WebP, and stored at public/images/avatars/{mila,boris,elena}.webp. Together they are approximately 199 KB. They are labeled as AI examples; no claim is made that they are generated videos or that they correspond to the audio voice samples. Portrait and caption selectors are interactive visual previews.

## Image prompts

### Mila

Use case: photorealistic-natural. Asset type: hero portrait for Bulgarian AI avatar video creator landing page. Create one photorealistic editorial portrait of a fictional friendly Bulgarian woman in her early 30s, dark brown shoulder-length softly wavy hair, warm brown eyes, wearing a tailored warm beige blazer over a simple ivory top. Waist-up, directly facing camera with a natural gentle confident smile and mouth visible, hands relaxed below crop. Bright airy minimalist creative studio with ivory wall and very softly out-of-focus shelf, soft daylight, sophisticated warm-neutral photographic palette, realistic skin texture, premium magazine photography. Portrait 3:4 composition with generous breathing room above head and shoulders, centered subject filling frame. No text, captions, watermarks, logos, UI, collage or other people. This is a fictional example avatar, not a real person.

### Boris

Use case: photorealistic-natural. Asset type: example avatar card for Bulgarian AI video creator website. One photorealistic editorial portrait of a fictional Bulgarian male presenter in his late 30s, short dark hair, neatly trimmed beard, wearing a dark charcoal overshirt over a light grey T-shirt. Chest-up facing camera, natural friendly expression, mouth visible. Minimal creative workspace, warm blurred taupe background, soft directional daylight. Portrait 3:4 composition, centered, ample space around head. Premium camera photograph, natural skin texture. No text, watermarks, logos, UI, borders, collage, microphones or extra people.

### Elena

Use case: photorealistic-natural. Asset type: example avatar card for Bulgarian AI video creator website. One photorealistic editorial portrait of a fictional Bulgarian woman in her early 40s with red hair tied in a ponytail, wearing an elegant ivory shirt, small simple earrings, calm confident friendly expression, looking straight at camera. Waist-up with unobstructed face and mouth. Modern Sofia office, large window behind her with softly blurred city and mountains in daylight. Portrait 3:4 composition, centered subject, premium natural commercial photography, real skin texture, restrained warm colors. No text, watermarks, logos, UI, borders, collage, other people.

## Deployment

Deploy through the existing GitHub → Cloudflare flow. No database migration, new secret, or runtime binding is required. Backend generation, billing and authentication logic is unchanged.
