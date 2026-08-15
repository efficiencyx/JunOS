// renderer state more than one module writes to. you can't assign to an
// imported binding but you CAN set its properties, so the shared ones all sit
// on one object.
export const S = {
  cameraMode: 'desktop',
  cameraPersistenceEnabled: true,
  drawableIndexById: null,
  // a loaded position counts too, or fitModel piles its rest offset on top
  hasUserPos: false,
  legacyDesktopCamera: null,
  needsRender: true,
  stageElement: null,
  userOffsetX: 0,
  userOffsetY: 0,
  userZoom: 1,
};
