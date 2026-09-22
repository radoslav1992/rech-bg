# Ready-made avatars

Users can choose a synthetic portrait in Video Studio or the product-avatar panel, or continue uploading their own images. The initial library contains Mila, Boris and Elena, generated for Rech BG. Choosing a portrait costs no credits; voice and video generation keep their existing prices. The voice is selected independently.

## Administration

Open Settings as an administrator, then **Библиотека с аватари**. Add a JPG/PNG up to 2 MB with a name, description and style. Confirm that it is a synthetic character you may distribute to users for content creation. Existing entries can be renamed, hidden and restored. Hiding removes an avatar from future selection; already selected/downloaded copies and generated outputs remain available under their normal retention policy.

## Persistence and deployment

No migration, binding or API key is required. The initial JPEGs are bundled static assets in `public/images/avatar-library/`. They are format-converted copies of the existing generated landing-page portraits, compatible with the video providers.

Metadata is stored as independent R2 objects at `config/avatar-library/<id>.json`, and custom images at `library/avatars/<id>`. A hidden default gets a persisted tombstone, so deployment does not restore it. Hidden images are retained for administrative restoration. No shared manifest is overwritten when adding avatars concurrently. These library objects are global, outside user cleanup prefixes and quotas.

Library reads require a signed-in session; all writes require existing administrator authorization and same-origin requests. Stored paths are derived from validated IDs; arbitrary image URLs are not accepted. Browser selections retrieve authenticated image bytes and pass them through the existing validated upload paths. Video jobs store their own private portrait copy. The product panel stores a personal portrait asset, which counts towards the user's storage limit and expires under the plan's normal retention policy. Neither flow sends the provider an authenticated browser URL.

## Validation

Regression coverage checks authentication/admin isolation, file signatures and size, bundled image delivery, concurrent additions, persistent hiding/restoring, and video submission using a library portrait with normal credits and a private input copy.
