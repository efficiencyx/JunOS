using HarmonyLib;
using Il2Cpp;
using JunBridge.Chat;

namespace JunBridge.Patches;

[HarmonyPatch]
public class InteractionPatch {
  [HarmonyPatch(typeof(InteractionMemory), nameof(InteractionMemory.ActivateComplex))]
  [HarmonyPostfix]
  public static void AfterActivateComplex(InteractionMemoryEnum e) => Interactions.Touched(e);

  [HarmonyPatch(typeof(GameScript.EquipmentState), nameof(GameScript.EquipmentState.OnItemEquipped))]
  [HarmonyPostfix]
  public static void AfterItemEquipped(Item item) => Interactions.Dressed(item?.GetName());
}
