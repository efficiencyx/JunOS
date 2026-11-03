using System.Reflection;
using HarmonyLib;
using Il2Cpp;

namespace JunBridge.Patches;

// 0.97.5 has no MainMenuScene.Prepare override, only ViewScene's
[HarmonyPatch]
public class MainMenuScenePatch {
  public static MethodBase TargetMethod() =>
    AccessTools.DeclaredMethod(typeof(MainMenuScene), "Prepare") ?? AccessTools.Method(typeof(ViewScene), "Prepare");

  [HarmonyPostfix]
  public static void AfterPrepare(ViewScene __instance) {
    if (__instance.TryCast<MainMenuScene>() != null) {
      JunApi.LoginPrompt.MainMenuReady();
    }
  }
}
