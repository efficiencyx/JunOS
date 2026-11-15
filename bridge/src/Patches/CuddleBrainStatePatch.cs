using HarmonyLib;
using Il2Cpp;
using JunBridge.Chat;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(CuddleBrainState))]
public class CuddleBrainStatePatch {
  // EnterState starts Brain(), which greets and picks far/close off these. set them first
  [HarmonyPatch("EnterState")]
  [HarmonyPrefix]
  public static void BeforeEnterState(CuddleBrainState __instance) {
    var snapshot = CuddleReturn.Pending;
    if (snapshot == null) {
      return;
    }
    __instance.CurrentState = snapshot.Closeness;
    __instance.HasGreeted = snapshot.HasGreeted;
    __instance.SleptForMinutes = snapshot.SleptForMinutes;
  }

  [HarmonyPatch("EnterState")]
  [HarmonyPostfix]
  public static void AfterEnterState(CuddleBrainState __instance) {
    var snapshot = CuddleReturn.Pending;
    if (snapshot == null) {
      return;
    }
    __instance.CuddleStartedAtTime = snapshot.CuddleStartedAtTime;
    snapshot.Applied = true;
  }
}
