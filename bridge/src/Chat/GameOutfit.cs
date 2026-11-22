using System.Collections.Generic;
using System.Text.Json.Serialization;
using Il2Cpp;
using JunBridge.Utils;

namespace JunBridge.Chat;

// change_outfit from JunOS. on/off are indexes into the clothes list that turn sent
public static class GameOutfit {
  private static readonly Logger logger = new("GameOutfit");

  public sealed class Change {
    [JsonPropertyName("on")]
    public List<int> On { get; set; }

    [JsonPropertyName("off")]
    public List<int> Off { get; set; }
  }

  public static void Apply(GameContext game, Change change) {
    _ = MainThreadRunner.Run(() => {
      var manager = GameScript.Instance?.GameVariables?.itemManager;
      if (manager == null) {
        return;
      }
      foreach (var i in change.Off ?? []) {
        if (i >= 0 && i < game.Clothes.Count) {
          manager.UnequipItemWithDependencies(game.Clothes[i].Item);
        }
      }
      foreach (var i in change.On ?? []) {
        if (i < 0 || i >= game.Clothes.Count) {
          continue;
        }
        var result = manager.Equip(game.Clothes[i].Item, true);
        if (result != Item.ItemManager.EquipResults.Success) {
          logger.LogWarning($"{game.Clothes[i].Name} didn't go on: {result}");
        }
      }
    });
  }
}
