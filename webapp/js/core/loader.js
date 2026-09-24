// Groups load together, one group after the other. there is only
// one real order left, cubism4 needs PIXI and the Cubism core
// first, so this stays two deep instead of putting seventeen
// files in a row.
//
// Classic scripts only. a module needs type="module", and
// `s.async = false` doesn't order it against these anyway. so
// modules come in through import, never through here.

export function loadScripts(groups) {
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
}
