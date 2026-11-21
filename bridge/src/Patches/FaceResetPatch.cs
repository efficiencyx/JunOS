using HarmonyLib;
using Il2Cpp;
using JunBridge.Chat;
using JunBridge.Utils;

namespace JunBridge.Patches;

// back in the room the game wipes her face to default, the linger wants it kept
[HarmonyPatch]
public class FaceResetPatch {
  private static bool ShouldBlock() =>
    ExpressionLinger.IsActive && !ChatExecutor.IsOwnReset && Utils.GameState.IsWithHer();

  [HarmonyPatch(typeof(Live2DController), nameof(Live2DController.SetDefaultEmote), [typeof(bool)])]
  [HarmonyPrefix]
  public static bool BeforeSetDefaultEmote() => !ShouldBlock();

  [HarmonyPatch(typeof(Live2DExpression), nameof(Live2DExpression.ReturnToBasicExpressionState))]
  [HarmonyPrefix]
  public static bool BeforeReturnToBasicExpression() => !ShouldBlock();
}
