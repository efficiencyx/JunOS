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

  // the plain room view is GameScript.RoomState, the Talk (AI) button only lives in the other two
  public static bool IsWithHer() {
    var state = GameScript.Instance?.GameState;
    return state != null && (state.TryCast<GameScript.RoomState>() != null
      || state.TryCast<InteractState>() != null || state.TryCast<CuddleState>() != null);
  }
}
