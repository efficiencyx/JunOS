using System.Collections.Generic;
using Il2Cpp;

namespace JunBridge.Chat;

// games with her, off the game's own counters. they're Anon's: chess is scripted for him to lose and timesLostChess is the one that grows
public static class Games {
  private static readonly string[] lines = [
    "Anon beat you at chess",
    "You beat Anon at chess",
    "Anon won a round of Old Maid against you",
    "You won a round of Old Maid against Anon",
    "Anon beat you at word chain",
    "You beat Anon at word chain",
  ];

  private static int[] seen;

  public static void Reset() => seen = null;

  // a played game nobody has heard about yet. the first look after a load takes the baseline
  public static bool HasNew(GameVariables vars) {
    var now = Read(vars);
    seen ??= now;
    for (var i = 0; i < now.Length; i++) {
      if (now[i] > seen[i]) {
        return true;
      }
    }
    return false;
  }

  // main thread
  public static List<string> Drain(GameVariables vars) {
    var now = Read(vars);
    var result = new List<string>();
    for (var i = 0; seen != null && i < now.Length; i++) {
      var more = now[i] - seen[i];
      if (more > 0) {
        result.Add(more > 1 ? $"{lines[i]} ({more} times)." : $"{lines[i]}.");
      }
    }
    seen = now;
    return result;
  }

  private static int[] Read(GameVariables vars) => [
    vars.timesWonChess, vars.timesLostChess,
    vars.timesWonOldMaid, vars.timesLostOldMaid,
    vars.timesWonWordChain, vars.timesLostWordChain,
  ];
}
