using System.Collections.Generic;
using System.Threading.Tasks;
using Il2Cpp;
using JunBridge.Utils;

namespace JunBridge.Chat;

public static class ChatExecutor {
  private static readonly Logger logger = new("ChatExecutor");

  public static readonly HashSet<string> validExpressions = [
    "#!bot.Expression.VerySad", "#!bot.Expression.Sad",
    "#!bot.Expression.Happy", "#!bot.Expression.VeryHappy",
    "#!bot.Expression.Shock", "#!bot.Expression.VeryShock",
    "#!bot.Expression.Angry", "#!bot.Expression.VeryAngry"
  ];

  public static Task Run(string command) {
    logger.Log($"Executing command: {command}");
    var parts = command.Split('.');
    if (parts.Length == 3 && parts[0] == "bot") {
      SetEmote(parts[0], parts[1], parts[2]);
    }
    return Task.CompletedTask;
  }

  public static void SetEmote(string characterId, string slotId, string itemId) {
    var isCuddling = Utils.GameState.IsStateType<CuddleState>();

    if (isCuddling && slotId.StartsWith("Arm")) {
      // Ignore arm motions in cuddle state
      return;
    }

    var emote = new EmoteData(slotId, itemId) {
      instant = false
    };

    // Implicit conversion of Il2CppSystem objects is slightly... broken.
    // Basically, it's `var emotes = [emote]`
    var emotesList = new Il2CppSystem.Collections.Generic.List<EmoteData>(1);
    emotesList.Add(emote);
    var emotes = emotesList.Cast<Il2CppSystem.Collections.Generic.IEnumerable<EmoteData>>();

    MainThreadRunner.Run(() => {
      var live2DController = Live2DControllerSingleton.Instance;
      var character = live2DController.GetReadyController(characterId);
      character?.SetEmote(emotes);
    });
  }

  public static void ResetBotEmotes(bool instantly = false) {
    MainThreadRunner.Run(() => {
      var live2DController = Live2DControllerSingleton.Instance;
      var character = live2DController.GetReadyController("bot");
      character?.SetDefaultEmote(instantly);
    });
  }

  public static void ResetBotArms() {
    SetEmote("bot", "ArmBoth", "DownNormal");
  }
}
