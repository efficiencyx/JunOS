using System;
using Il2Cpp;
using JunBridge.Utils;

namespace JunBridge.Chat;

// she takes you out through the game's own door. Outside/OutsideStartWithBot runs its checks and its
// confirm menu, then OutingMenuPatch picks her place off the outside menu as if you clicked it.
// bed is the Sleep button, the game's own menu and you pick
public static class Outing {
  private static readonly Logger logger = new("Outing");

  private static string queued;

  public static bool IsQueued => queued != null;

  public static string Destination { get; private set; }

  public static void Queue(string where) => queued = where;

  public static void Clear() {
    queued = null;
    Destination = null;
  }

  public static string Take() {
    var block = Destination;
    Destination = null;
    return block;
  }

  // after the chat closed and the room is back
  public static void StartIfQueued() {
    var where = queued;
    queued = null;
    if (where == null) {
      return;
    }
    try {
      if (where == "bed") {
        logger.Log("she takes you to bed");
        GameScript.Instance.ChangeToStoryStateBlockReference(FungusBlocks.Sleep_Go_to_sleep);
        return;
      }
      Destination = BlockFor(where, GameScript.Instance.GameVariables);
      if (Destination == null) {
        logger.LogWarning($"no outing in the game for {where}");
        return;
      }
      logger.Log($"she takes you out: {where} ({Destination})");
      GameScript.Instance.ChangeToStoryStateBlockReference(FungusBlocks.Outside_OutsideStartWithBot);
    } catch (Exception ex) {
      Destination = null;
      logger.LogError($"Could not go out: {ex.Message}");
    }
  }

  // the one you haven't seen yet first, each date flags itself once played. both seen, a coin
  private static string BlockFor(string where, GameVariables vars) {
    FungusBlocks.FungusBlockReference Pair(string flag, FungusBlocks.FungusBlockReference one, FungusBlocks.FungusBlockReference two) =>
      !vars.CheckFlag(flag + "1") ? one
      : !vars.CheckFlag(flag + "2") ? two
      : Random.Shared.Next(2) == 1 ? two : one;
    return (where switch {
      "shop" => FungusBlocks.Outside_Clothier_startWithBot,
      "restaurant" => Pair("restaurant", FungusBlocks.Outside_RestaurantDate1, FungusBlocks.Outside_RestaurantDate2),
      "cinema" => Pair("kino", FungusBlocks.Outside_Kino1, FungusBlocks.Outside_Kino2),
      "karaoke" => FungusBlocks.Outside_Karaoke1,
      _ => null,
    })?.Name;
  }
}
