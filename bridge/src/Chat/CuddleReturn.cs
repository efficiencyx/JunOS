using System;
using Il2Cpp;
using Il2CppFungus;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.Chat;

public static class CuddleReturn {
  public sealed class Snapshot {
    public Live2DInteractionController Controller;
    public View View;
    public CuddleBrainState.CuddleState Closeness;
    public bool HasGreeted;
    public int SleptForMinutes;
    public int CuddleStartedAtTime;
    public bool Applied;
  }

  private static readonly Logger logger = new("CuddleReturn");

  // CuddleBrainStatePatch reads this while the new brain state enters
  public static Snapshot Pending { get; private set; }

  public static Snapshot Capture(GameScript gameScript) {
    try {
      var cuddleState = gameScript.GameState?.TryCast<CuddleState>();
      var brainState = cuddleState?.Brain?.CurrentState?.TryCast<CuddleBrainState>();
      var controller = cuddleState?.CurrentController;
      var view = ViewSingleton.Instance?.CurrentView;
      if (brainState == null || controller == null || view == null) {
        return null;
      }
      return new Snapshot {
        Controller = controller,
        View = view,
        Closeness = brainState.CurrentState,
        HasGreeted = brainState.HasGreeted,
        SleptForMinutes = brainState.SleptForMinutes,
        CuddleStartedAtTime = brainState.CuddleStartedAtTime,
      };
    } catch (Exception ex) {
      logger.LogError($"Could not read the cuddle state: {ex.Message}");
      return null;
    }
  }

  public static bool TryRestore(Snapshot snapshot) {
    if (snapshot == null) {
      return false;
    }
    try {
      var gameScript = GameScript.Instance;
      if (gameScript.GameState?.TryCast<GameScript.StoryState>() == null) {
        return false;
      }
      if (snapshot.Controller == null || ViewSingleton.Instance?.CurrentView != snapshot.View) {
        return false;
      }

      Pending = snapshot;
      try {
        gameScript.ChangeState(new CuddleState(snapshot.Controller));
      } finally {
        Pending = null;
      }
      if (!snapshot.Applied) {
        logger.LogWarning("Back in cuddle, but the brain state was not restored");
      }
      return true;
    } catch (Exception ex) {
      logger.LogError($"Could not return to cuddle: {ex.Message}");
      return false;
    }
  }
}
