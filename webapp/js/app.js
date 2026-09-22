// ?v= is module identity. two imports of one file with different
// ?v= and the browser builds two copies of it, then the cycles
// die with "can't access lexical declaration before
// initialization". a bump has to cover index.html, the imports
// here, js/app/ and js/live2d/. everything is cached immutable
// for a year, so a URL that didn't change keeps its stale
// imports. renumber the whole graph. and no example version
// numbers in comments, a bulk renumber rewrites those too.

import { showAuthScreen } from './app/auth-screen.js?v=13';
import * as Auth from './core/auth.js?v=1';
import { loadScripts } from './core/loader.js?v=1';
// side effect only. it sets the phone-ui class and the viewport
// css vars the auth screen lays out against
import './core/viewport.js?v=1';

const me = await Auth.me().catch(() => null);
if (!me) {
  showAuthScreen();
} else {
  // everything past the login loads only now, the vendor libs and
  // main.js's module graph side by side. nothing in that graph
  // touches PIXI or marked at import, boot() is the first to
  const [{ boot }] = await Promise.all([
    import('./app/main.js?v=2'),
    loadScripts([
      ['vendor/pixi.min.js', 'vendor/live2dcubismcore.min.js',
       'vendor/marked.min.js', 'vendor/purify.min.js?v=4'],
      ['vendor/cubism4.min.js', 'vendor/pixi-unsafe-eval.min.js'],
    ]),
  ]);
  boot(me);
}
