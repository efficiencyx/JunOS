using Il2Cpp;

namespace JunBridge.Utils;

public static class GameState {
  public static GameStateWithLive2D<Live2DInteractionController> CurrentState { get; private set; }

  public static void SetCurrentState(GameStateWithLive2D<Live2DInteractionController> state) {
    CurrentState = state;
  }

  public static bool IsStateType<T>() where T : GameStateWithLive2D<Live2DInteractionController> {
    return CurrentState is T;
  }
}
