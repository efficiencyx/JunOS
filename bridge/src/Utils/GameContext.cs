using System;
using System.Collections.Generic;
using System.Globalization;
using Il2Cpp;

namespace JunBridge.Utils;

// read on the main thread, the chat request runs on a worker
public sealed record GameContext(string ClientTime, int Hour, string PlayerName, string BotName, string Outfit) {
  public static GameContext Capture() {
    try {
      var vars = GameScript.Instance?.GameVariables;
      if (vars == null) {
        return new GameContext("", 12, "", "", "");
      }
      var clock = new DateTime(2000, 1, 1, vars.Hour, vars.Minute, 0).ToString("h:mm tt", CultureInfo.InvariantCulture);
      return new GameContext($"Day {vars.Day}, {vars.GameDateTime.DayOfWeek} at {clock}", vars.Hour, vars.playerName ?? "", vars.botName ?? "", DescribeOutfit(vars));
    } catch (Exception) {
      return new GameContext("", 12, "", "", "");
    }
  }

  // same sentence the web app's wardrobe sends as outfit_context
  private static string DescribeOutfit(GameVariables vars) {
    var items = vars.itemManager?.botEquippedItems;
    if (items == null) {
      return "";
    }
    var names = new List<string>();
    for (var i = 0; i < items.Count; i++) {
      var name = items[i]?.GetName();
      if (!string.IsNullOrWhiteSpace(name)) {
        names.Add(name.ToLowerInvariant());
      }
    }
    return names.Count == 0
      ? "You are currently fully nude (wearing nothing)."
      : $"You are currently wearing: {string.Join(", ", names)}.";
  }
}
