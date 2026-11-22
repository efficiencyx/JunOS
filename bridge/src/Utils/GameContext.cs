using System;
using System.Collections.Generic;
using System.Globalization;
using Il2Cpp;

namespace JunBridge.Utils;

public sealed record Garment(Item Item, string Name, string Slot, bool Worn);

// Date is the game's Outside/CheckDate in its order, Shop the door check of Outside/Clothier/startWithBot
public sealed record OutingState(bool Out, string Date, string Shop) {
  public static OutingState Read(GameVariables vars) {
    try {
      return ReadUnsafe(vars);
    } catch (Exception) {
      return null;
    }
  }

  private static OutingState ReadUnsafe(GameVariables vars) {
    var hour = vars.Hour;
    var date = vars.CheckFlag("lastdate") && !vars.CheckFlagBeforeRelative("lastdate", 14 * 60) ? "recent"
      : hour < 9 || hour > 19 ? "hours"
      : vars.money <= 2000 ? "money"
      : "ok";
    var shop = hour >= 8 && hour < 18 ? "ok" : "hours";
    return new OutingState(vars.HasTheOptionToGoOutsideWithBot && vars.CanGoOutsideWithBot && !vars.IsThereCumOnHer, date, shop);
  }
}

// his stamina, hunger and mood, her longing (0-10) and horniness. php turns them into words
public sealed record BodyState(float Stamina, float Satiation, float Mental, float Longing, float Horniness) {
  public static BodyState Read(GameVariables vars) {
    try {
      return new BodyState(vars.Stamina, vars.Satiation, vars.MentalHealth, vars.Longing, vars.CurrentHorniness);
    } catch (Exception) {
      return null;
    }
  }
}

// read on the main thread, the chat request runs on a worker
public sealed record GameContext(string ClientTime, string DayPart, int Hour, string PlayerName, string BotName, string Outfit,
    IReadOnlyList<Garment> Clothes, IReadOnlyList<string> Played, OutingState Outing, BodyState Body) {
  private const int maxClothes = 150;

  private static readonly GameContext empty = new("", "", 12, "", "", "", [], [], null, null);

  public static GameContext Capture() {
    try {
      var vars = GameScript.Instance?.GameVariables;
      if (vars == null) {
        return empty;
      }
      var clock = new DateTime(2000, 1, 1, vars.Hour, vars.Minute, 0).ToString("h:mm tt", CultureInfo.InvariantCulture);
      var day = $"Day {vars.Day}, {vars.GameDateTime.DayOfWeek}";
      return new GameContext($"{day} at {clock}", $"{day} {PartOf(vars.Hour)}", vars.Hour, vars.playerName ?? "", vars.botName ?? "",
        DescribeOutfit(vars), ReadClothes(vars), Chat.Games.Drain(vars), OutingState.Read(vars), BodyState.Read(vars));
    } catch (Exception) {
      return empty;
    }
  }

  // cues only. the minute in the context and she reads the clock back to him
  private static string PartOf(int hour) => hour switch {
    < 5 => "night",
    < 12 => "morning",
    < 14 => "around noon",
    < 18 => "afternoon",
    < 22 => "evening",
    _ => "night",
  };

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

  // BotClothes slots only. her limbs, hair and personality module are BotPart / BotHair, change_outfit NEVER gets them
  private static List<Garment> ReadClothes(GameVariables vars) {
    var worn = new List<Garment>();
    var bag = new List<Garment>();
    var items = vars.itemManager?.items;
    for (var i = 0; items != null && i < items.Count; i++) {
      try {
        var item = items[i];
        var slot = item?.GetItemPrefab()?.SlotData?.TargetSlot;
        if (slot == null || slot.Type != ItemSlot.SlotType.BotClothes) {
          continue;
        }
        var name = item.GetName();
        if (string.IsNullOrWhiteSpace(name)) {
          continue;
        }
        if (!string.IsNullOrEmpty(item.EquippedSlot)) {
          worn.Add(new Garment(item, name, item.EquippedSlot, true));
        } else if (item.ItemLocation == Item.ItemLocationEnum.AtHome) {
          bag.Add(new Garment(item, name, slot.Id, false));
        }
      } catch (Exception) {
        // a broken mod item costs that item, not the clock and the outfit
      }
    }
    worn.AddRange(bag);
    return worn.Count > maxClothes ? worn.GetRange(0, maxClothes) : worn;
  }
}
