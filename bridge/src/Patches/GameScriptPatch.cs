using HarmonyLib;
using Il2Cpp;
using JunBridge.Sync;
using JunBridge.Utils;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(GameScript))]
public class GameScriptPatch {
  [HarmonyPatch("LoadGame")]
  [HarmonyPostfix]
  public static void AfterLoadGame(GameScript __instance, GameVariables save, GameScript.LoadProcedureData lpd) {
    SaveStorage.Instance.InvalidateCache();
    BridgeSync.SyncNow();
  }

  [HarmonyPatch("StartNewGame", [typeof(GameScript.LoadProcedureData)])]
  [HarmonyPostfix]
  public static void AfterStartNewGame(GameScript __instance, GameScript.LoadProcedureData lpd) {
    SaveStorage.Instance.InvalidateCache();
    BridgeSync.SyncNow();
  }
}
