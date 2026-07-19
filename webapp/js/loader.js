// Sequential-groups script loader for everything deferred past the auth check.
//
// Each group loads in parallel; the next group waits for it. Only two real
// ordering edges exist in this app (cubism4 needs PIXI + the Cubism core,
// live2d.js destructures PIXI.live2d at eval time), so grouping keeps the
// critical chain three deep instead of serialising seventeen files.

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
