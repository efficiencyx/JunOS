using HarmonyLib;
using Il2Cpp;
using JunBridge.Chat;

namespace JunBridge.Patches;

// AndWait stays unpatched, whatever yields on its coroutine would get null
[HarmonyPatch(typeof(StoryBotDialogueTagDefinition), nameof(StoryBotDialogueTagDefinition.StartDialogueFromModelBrainState))]
public class TouchLinePatch {
  [HarmonyPrefix]
  public static bool Before(StoryBotDialogueTagDefinition __instance, ModelBrainState modelBrainState, ref bool __result) {
    if (!IsTouchLine(__instance, modelBrainState) || !Initiative.TakeTouchLine()) {
      return true;
    }
    __result = false;
    return false;
  }

  private static bool IsTouchLine(StoryBotDialogueTagDefinition tag, ModelBrainState brain) {
    var interact = brain?.TryCast<NewInteractBrainState>()?.Dialogue;
    if (interact != null) {
      return Same(tag, interact.Headpat) || Same(tag, interact.Handholding) || Same(tag, interact.FaceStroke);
    }
    var cuddle = brain?.TryCast<CuddleBrainState>()?.Dialogue;
    return cuddle != null && (Same(tag, cuddle.Headpat) || Same(tag, cuddle.Handholding) || Same(tag, cuddle.FaceStroke));
  }

  private static bool Same(StoryBotDialogueTagDefinition a, StoryBotDialogueTagDefinition b) => b != null && a.Pointer == b.Pointer;
}
