using MelonLoader;

namespace JunBridge.Utils;

public class Logger {
  private readonly string scope;

  public Logger(string scope) {
    this.scope = scope;
  }

  public void Log(string message) {
    MelonLogger.Msg($"[{scope}] {message}");
  }

  public void LogWarning(string message) {
    MelonLogger.Warning($"[{scope}] {message}");
  }

  public void LogError(string message) {
    MelonLogger.Error($"[{scope}] {message}");
  }
}
