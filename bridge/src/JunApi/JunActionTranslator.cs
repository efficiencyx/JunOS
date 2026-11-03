using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace JunBridge.JunApi;

public class JunActionTranslator {
  // Longest text we are willing to hold back while waiting for a ']'
  private const int maxTagLength = 300;

  private readonly StringBuilder held = new(64);
  private bool holding = false;

  // emote/brow value -> game expression command
  private static readonly Dictionary<string, string> emoteMap = new(StringComparer.OrdinalIgnoreCase) {
    ["happy"] = "#!bot.Expression.VeryHappy",
    ["excited"] = "#!bot.Expression.VeryHappy",
    ["laughing"] = "#!bot.Expression.VeryHappy",
    ["smug"] = "#!bot.Expression.Happy",
    ["sad"] = "#!bot.Expression.VerySad",
    ["crying"] = "#!bot.Expression.VerySad",
    ["sleepy"] = "#!bot.Expression.Sad",
    ["worried"] = "#!bot.Expression.Sad",
    ["angry"] = "#!bot.Expression.VeryAngry",
    ["pout"] = "#!bot.Expression.Angry",
    ["surprised"] = "#!bot.Expression.VeryShock",
    ["shocked"] = "#!bot.Expression.VeryShock",
    ["embarrassed"] = "#!bot.Expression.VeryBlush",
    ["neutral"] = "#!bot.Expression.Clear",
  };

  // Processes one streamed chunk, returning text with tags removed and translated
  // commands inserted in place
  public string Process(string chunk) {
    if (string.IsNullOrEmpty(chunk)) {
      return "";
    }

    var output = new StringBuilder(chunk.Length);

    foreach (var character in chunk) {
      if (!holding) {
        if (character == '[') {
          holding = true;
          held.Clear();
          held.Append(character);
        } else {
          output.Append(character);
        }
        continue;
      }

      held.Append(character);

      if (character == ']') {
        output.Append(TranslateTag(held.ToString()));
        held.Clear();
        holding = false;
      } else if (held.Length >= maxTagLength) {
        // Too long to be a tag; it was regular text after all
        output.Append(held);
        held.Clear();
        holding = false;
      }
    }

    return output.ToString();
  }

  // Flushes any text still held back (call once at end of stream)
  public string Flush() {
    if (!holding || held.Length == 0) {
      Reset();
      return "";
    }

    var rest = held.ToString();
    Reset();
    return rest;
  }

  // Resets the filter for a new message
  public void Reset() {
    held.Clear();
    holding = false;
  }

  private static string TranslateTag(string tag) {
    // tag includes the surrounding brackets: [A:name|value|...] or [ACTION:name|key=value|...]
    var inner = tag.Substring(1, tag.Length - 2).Trim();

    var colonIndex = inner.IndexOf(':');
    if (colonIndex < 0) {
      // Not an action tag ("[laughs]" and similar stay visible text)
      return tag;
    }

    var marker = inner[..colonIndex].Trim();
    var isAction = marker.Equals("A", StringComparison.OrdinalIgnoreCase)
      || marker.Equals("ACTION", StringComparison.OrdinalIgnoreCase)
      || marker.Equals("ACTIONS", StringComparison.OrdinalIgnoreCase);

    if (!isAction) {
      return tag;
    }

    var parts = inner[(colonIndex + 1)..].Split('|');
    var name = parts[0].Trim().ToLowerInvariant();

    var command = name switch {
      "emote" => MapEmote(GetValue(parts, 1, "type")),
      "brow" => MapEmote(GetValue(parts, 1, "emotion")),
      "blush" => MapBlush(GetValue(parts, 1, "intensity")),
      _ => "", // No in-game equivalent; drop silently
    };

    // Commands are space-terminated for the ChatParser
    return command.Length > 0 ? $"{command} " : "";
  }

  private static string MapEmote(string value) {
    if (value != null && emoteMap.TryGetValue(value, out var command)) {
      return command;
    }
    return "";
  }

  private static string MapBlush(string value) {
    var intensity = 0.5;
    if (value != null && double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) {
      intensity = parsed;
    }
    return intensity >= 0.7 ? "#!bot.Expression.VeryBlush" : "#!bot.Expression.Blush";
  }

  // Reads a positional or key=value argument from a tag
  private static string GetValue(string[] parts, int position, string key) {
    if (parts.Length <= position) {
      return null;
    }

    // Prefer an explicit key=value anywhere in the tag (legacy form)
    foreach (var part in parts) {
      var eq = part.IndexOf('=');
      if (eq > 0 && part[..eq].Trim().Equals(key, StringComparison.OrdinalIgnoreCase)) {
        return part[(eq + 1)..].Trim();
      }
    }

    var positional = parts[position].Trim();
    return positional.Contains('=') ? null : positional;
  }
}
