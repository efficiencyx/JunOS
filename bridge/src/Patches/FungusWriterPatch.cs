using HarmonyLib;
using Il2CppFungus;
using JunBridge.Utils;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(Writer))]
public class FungusWriterPatch {
  [HarmonyPatch("OnNextLineEvent", [typeof(Writer.InputFlagState)])]
  [HarmonyPrefix]
  public static bool BeforeOnNextLineEvent(Writer __instance, Writer.InputFlagState inputFlagState) {
    return !Locker<Writer>.IsLocked(__instance);
  }
}
