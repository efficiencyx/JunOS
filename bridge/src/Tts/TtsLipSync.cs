using System;
using UnityEngine;
using Il2Cpp;
using Il2CppLive2D.Cubism.Core;
using JunBridge.Utils;
// Disambiguate from UnityEngine.Logger (both namespaces are imported)
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.Tts;

public class TtsLipSync {
  private static readonly Logger logger = new("TtsLipSync");

  // Parameter ids used by common Cubism model rigs, checked in order
  private static readonly string[] mouthParameterIds = [
    "ParamMouthOpenY",
    "PARAM_MOUTH_OPEN_Y",
    "ParamMouthOpen",
    "Mouth"
  ];

  private CubismParameter mouthParameter;
  private bool resolveFailed = false;
  private float lastAppliedValue = 0f;

  // Applies a mouth openness value (0..1). Safe to call every frame; does
  // nothing if the model/parameter can't be found
  public void Apply(float value) {
    var parameter = ResolveMouthParameter();
    if (parameter == null) {
      return;
    }

    try {
      var clamped = Mathf.Clamp01(value);
      parameter.Value = Mathf.Lerp(parameter.MinimumValue, parameter.MaximumValue, clamped);
      lastAppliedValue = clamped;
    } catch (Exception) {
      // Model was likely destroyed during a scene change; re-resolve next frame
      mouthParameter = null;
    }
  }

  // Closes the mouth and stops touching the parameter until the next Apply
  public void Release() {
    if (lastAppliedValue > 0f) {
      Apply(0f);
      lastAppliedValue = 0f;
    }
  }

  // Drops cached references (call on scene changes or when the model is rebuilt)
  public void InvalidateCache() {
    mouthParameter = null;
    resolveFailed = false;
  }

  private CubismParameter ResolveMouthParameter() {
    if (mouthParameter != null) {
      return mouthParameter;
    }

    if (resolveFailed) {
      // Don't spam expensive lookups every frame once we know the rig has no mouth parameter
      return null;
    }

    try {
      var model = FindBotModel();
      if (model == null) {
        return null;
      }

      var parameters = model.Parameters;
      if (parameters == null) {
        return null;
      }

      foreach (var id in mouthParameterIds) {
        for (var i = 0; i < parameters.Length; i++) {
          var parameter = parameters[i];
          if (parameter != null && parameter.name == id) {
            mouthParameter = parameter;
            logger.Log($"Using mouth parameter '{id}' for lipsync");
            return mouthParameter;
          }
        }
      }

      logger.LogWarning("No mouth parameter found on the Live2D model, lipsync disabled");
      resolveFailed = true;
    } catch (Exception ex) {
      logger.LogError($"Failed to resolve mouth parameter: {ex.Message}");
      resolveFailed = true;
    }

    return null;
  }

  private static CubismModel FindBotModel() {
    // Preferred path: take the model that belongs to the bot's Live2D controller
    try {
      var live2DController = Live2DControllerSingleton.Instance;
      var controller = live2DController?.GetReadyController("bot");
      var component = controller?.TryCast<Component>();
      var model = component?.GetComponentInChildren<CubismModel>();

      if (model != null) {
        return model;
      }
    } catch (Exception) {
      // Fall through to the scene-wide lookup
    }

    return UnityEngine.Object.FindObjectOfType<CubismModel>();
  }
}
