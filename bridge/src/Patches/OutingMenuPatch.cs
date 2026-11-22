using HarmonyLib;
using Il2Cpp;
using JunBridge.Chat;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(StoryMenuEntryPointCommand), nameof(StoryMenuEntryPointCommand.OnEnter))]
public class OutingMenuPatch {
  // the place menu at the end of Outside/OutsideWithBot. this is the game's own Call in StopThenCall mode, by hand
  [HarmonyPrefix]
  public static bool Before(StoryMenuEntryPointCommand __instance) {
    if (Outing.Destination == null || __instance.ParentBlock?.BlockName != FungusBlocks.Outside_OutsideWithBot.Name) {
      return true;
    }
    var block = Outing.Take();
    var flowchart = __instance.GetFlowchart();
    if (flowchart == null || !flowchart.HasBlock(block)) {
      return true;
    }
    __instance.StopParentBlock();
    flowchart.ExecuteBlock(block);
    return false;
  }
}
