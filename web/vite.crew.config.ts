import { defineConfig } from 'vite'
import path from 'node:path'
import { inlineSingleFile } from './vite.config'

/* ------------------------------------------------------------------ */
/*  The crew export's own build (PRD v2 §5).                           */
/*                                                                     */
/*  One entry (crew.html), one output file (dist-crew/crew.html), no   */
/*  React and no dev middleware — everything the main config carries    */
/*  for the app is dead weight here. scripts/crew-export.mjs runs this  */
/*  build when the shell is missing or older than its sources, then     */
/*  injects a race's data into the <script id="crew-data"> block.       */
/*                                                                     */
/*  Every setting below exists to make the output a SINGLE file:        */
/*  inlineDynamicImports refuses to split chunks, cssCodeSplit puts the */
/*  CSS in one asset, assetsInlineLimit turns any image into a data:    */
/*  URI, and modulePreload's polyfill would add a second chunk. What is */
/*  left, inlineSingleFile folds into the HTML — and fails the build if */
/*  anything is left pointing outside it.                               */
/* ------------------------------------------------------------------ */
export default defineConfig({
  // The dev server's plugins are deliberately absent; this config is only
  // ever `vite build`, never `vite`.
  plugins: [inlineSingleFile()],
  // web/public/ is the app's snapshot directory — strava.json, oura.json,
  // crew-base.json and the rest. Copying ANY of it next to the crew shell
  // would both defeat the one-file goal and scatter personal data into a
  // build directory, so this build has no public dir at all.
  publicDir: false,
  build: {
    outDir: 'dist-crew',
    emptyOutDir: true,
    cssCodeSplit: false,
    // Infinity as a number literal, not `Infinity`: Vite compares it against
    // byte sizes, and every asset must lose to it.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    // The crew sheet is read on whatever phone the crew chief owns, including
    // the one they have not updated since 2021.
    target: 'es2020',
    rollupOptions: {
      input: path.resolve(__dirname, 'crew.html'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'crew.js',
        assetFileNames: 'crew.[ext]',
      },
    },
  },
})
