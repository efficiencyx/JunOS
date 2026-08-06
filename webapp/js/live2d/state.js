// Renderer state that more than one module writes. An imported binding cannot be
// assigned, but its properties can, so the shared ones live on one object.
export const S = {
  cameraMode: 'desktop',
  cameraPersistenceEnabled: true,
  drawableIndexById: null,
  hasUserPos: false, // true once the user drags her or a saved position loads
  legacyDesktopCamera: null,
  needsRender: true,
  stageElement: null,
  userOffsetX: 0,
  userOffsetY: 0,
  userZoom: 1,
};
