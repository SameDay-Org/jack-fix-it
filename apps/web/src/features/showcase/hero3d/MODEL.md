# The hero's 3D phone: source and licence

**What it is.** A procedural phone. `phone-model.ts` builds it in the browser from three.js
primitives: a rounded-rectangle extrusion with a bevel for the body and its titanium-like band,
flat rounded planes for the glass, the screen and the camera island, and rounded boxes for the
side buttons. No model file (`.glb`, `.gltf`, `.obj`) exists or is downloaded. The model adds
0 bytes to the download; its code is part of the lazy 3D chunk (`pnpm check:bundle` reports
its size).

**Where it comes from.** It was written for this repository (#403, PR 2). It contains no
third-party model, texture or render, and nothing from Apple (no official 3D assets, marketing
renders or trademarks). Its proportions are generic ones for a modern phone. The screen keeps
the 1:2 shape of the app's captures (`../media.ts`).

**How to reproduce it.** The code is the source. Building the page builds the phone, and
`phone-model.test.ts` checks its size, its screen proportions and its texture mapping.

**Textures.**

- The screen shows the app's own captures from `public/showcase/posters/`, the same files as
  the rest of the page (media manifest, `handoffs/showcase-media-needed.md`).
- The reflection on the glass is a gradient drawn in a canvas at run time (`phone-scene.ts`).
- The surroundings the metal reflects are three.js's `RoomEnvironment`, which is generated in
  code.

**Licence.** The phone is original work under the same terms as the rest of this repository.
three.js is used under its MIT licence (`node_modules/three/LICENSE`, copyright the three.js
authors).
