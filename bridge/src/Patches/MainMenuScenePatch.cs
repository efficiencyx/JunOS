using HarmonyLib;
using Il2Cpp;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(MainMenuScene), "Prepare")]
public class MainMenuScenePatch {
  [HarmonyPostfix]
  public static void AfterPrepare() => JunApi.LoginPrompt.MainMenuReady();
}
