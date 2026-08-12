// Renderer state that more than one module writes to. you can't assign to an
// imported binding but you can set its properties, so the shared ones all sit
// on one object.
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
