using System;
using HarmonyLib;
using Il2Cpp;
using Il2CppFungus;
using JunBridge.Chat;

namespace JunBridge.Patches;

[HarmonyPatch(typeof(SayDialog))]
public class FungusSayDialogPatch {
  [HarmonyPatch("DoSay")]
  [HarmonyPrefix]
  public static void BeforeDoSay(SayDialog __instance, string text, bool clearPrevious, bool waitForInput, bool fadeWhenDone, Action onComplete) {
    ChatWriter.EventBus.Fire("say-dialog-changed", __instance);
  }
}
