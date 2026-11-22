using HarmonyLib;
using Il2Cpp;
using JunBridge.Chat;
using JunBridge.Sync;
using JunBridge.Utils;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(GameScript))]
public class GameScriptPatch {
  [HarmonyPatch("LoadGame")]
  [HarmonyPostfix]
  public static void AfterLoadGame(GameScript __instance, GameVariables save, GameScript.LoadProcedureData lpd) {
    SaveStorage.Instance.InvalidateCache();
    Initiative.OnLoad();
    GameLines.Clear();
    BridgeSync.SyncNow();
  }

  [HarmonyPatch("StartNewGame", [typeof(GameScript.LoadProcedureData)])]
  [HarmonyPostfix]
  public static void AfterStartNewGame(GameScript __instance, GameScript.LoadProcedureData lpd) {
    SaveStorage.Instance.InvalidateCache();
    Initiative.OnLoad();
    BridgeSync.SyncNow();
  }

  // she brings these up the next time you're in her room, the latest one wins
  // GoOutside only opens the prompt, cancelling it still called it
  [HarmonyPatch("GoHome")]
  [HarmonyPostfix]
  public static void AfterGoHome() {
    Outing.Clear();
    Initiative.CameHome();
  }

  // GoToSleep is just getting into bed, cuddles start there too. a nap isn't a morning
  [HarmonyPatch("Sleep")]
  [HarmonyPostfix]
  public static void AfterSleep(int minutes) {
    if (minutes >= 180) {
      Initiative.Mark(Initiative.Morning);
    }
  }

  [HarmonyPatch("ChangeState")]
  [HarmonyPrefix]
  public static void BeforeChangeState(Il2Cpp.GameState newState) {
    if (newState?.TryCast<NewFrickState>() != null || newState?.TryCast<ShowerState>() != null) {
      Initiative.Mark(Initiative.Intimacy);
    }
  }
}
