using System.Collections;
using MelonLoader;
using UnityEngine;
using JunBridge.Utils;

namespace JunBridge.Chat;

// any state that isn't her room or cuddle owns her face and ends the linger
public static class ExpressionLinger {
  private const float settleTimeout = 3f;

  private static int generation;

  public static bool IsActive { get; private set; }

  public static void Begin() {
    if (ModConfig.ExpressionLingerSeconds <= 0f) {
      ChatExecutor.ResetBotEmotes();
      return;
    }
    IsActive = true;
    MelonCoroutines.Start(Run(++generation));
  }

  public static void Cancel() {
    IsActive = false;
    generation++;
  }

  private static IEnumerator Run(int gen) {
    var settleBy = Time.time + settleTimeout;
    while (!GameState.IsWithHer() && Time.time < settleBy) {
      yield return null;
      if (gen != generation) yield break;
    }
    if (!GameState.IsWithHer()) {
      Cancel();
      yield break;
    }

    // the face reset patch can't catch every path back to the room, this covers the rest
    yield return new WaitForSeconds(0.3f);
    if (gen != generation) yield break;
    ChatExecutor.ReapplyShownEmotes();

    var until = Time.time + ModConfig.ExpressionLingerSeconds;
    while (Time.time < until) {
      yield return null;
      if (gen != generation) yield break;
      if (!GameState.IsWithHer()) {
        Cancel();
        yield break;
      }
    }
    IsActive = false;
    ChatExecutor.ResetBotEmotes();
  }
}
