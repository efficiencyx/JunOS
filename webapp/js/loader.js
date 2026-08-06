// Groups load in parallel, one group after another. Only one real ordering edge
// is left here - cubism4 needs PIXI plus the Cubism core - so this stays two
// deep rather than serialising seventeen files. live2d.js used to be a third
// group; it is an ES module now and app.js imports it after these resolve.
//
// Classic scripts only. A module needs type="module", and s.async = false does
// not order it against these anyway.

window.loadScripts = function (groups) {
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });

  return groups.reduce(
    (chain, group) => chain.then(() => Promise.all(group.map(load))),
    Promise.resolve()
  );
};
