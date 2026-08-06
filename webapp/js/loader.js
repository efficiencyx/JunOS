// Groups load in parallel, one group after another. There are only two real
// ordering edges here (cubism4 needs PIXI + the Cubism core, live2d.js
// destructures PIXI.live2d at eval time) so this stays three deep rather than
// serialising seventeen files.

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
