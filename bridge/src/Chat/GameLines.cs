using System.Collections.Generic;
using System.Text.RegularExpressions;
using Il2Cpp;

namespace JunBridge.Chat;

// the game's own scripted lines since the last chat turn, sent as game_lines
public static class GameLines {
  private const int keep = 12;
  private const int maxChars = 300;

  // fungus tags ({w}, {s=40}, {color=red}...) and TMP rich text (<b>, <size=...>)
  private static readonly Regex markup = new(@"\{[^}]*\}|<[^>]*>", RegexOptions.Compiled);
  private static readonly Regex spaces = new(@"\s+", RegexOptions.Compiled);

  private static readonly List<string> pending = [];

  public static void Said(string speaker, string text) {
    if (Utils.MonoSingletonManager.Has<ChatManager>() && ChatManager.Instance.IsChatActive) {
      return;
    }
    var line = Clean(text);
    if (line == "") {
      return;
    }
    if (line.Length > maxChars) {
      line = line[..maxChars] + "...";
    }
    var who = Who(Clean(speaker));
    var entry = who == "" ? line : $"{who}: {line}";
    lock (pending) {
      if (pending.Count > 0 && pending[^1] == entry) {
        return;
      }
      pending.Add(entry);
      if (pending.Count > keep) {
        pending.RemoveAt(0);
      }
    }
  }

  public static List<string> Drain() {
    lock (pending) {
      var lines = new List<string>(pending);
      pending.Clear();
      return lines;
    }
  }

  public static void Clear() {
    lock (pending) {
      pending.Clear();
    }
  }

  private static string Who(string name) {
    var vars = GameScript.Instance?.GameVariables;
    if (name == "" || vars == null) {
      return name;
    }
    if (name == vars.botName) {
      return "You";
    }
    return name == vars.playerName || name == "You" ? "Anon" : name;
  }

  private static string Clean(string text) =>
    string.IsNullOrEmpty(text) ? "" : spaces.Replace(markup.Replace(text, ""), " ").Trim();
}
