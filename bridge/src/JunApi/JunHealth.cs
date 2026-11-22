using System;
using System.Threading.Tasks;

namespace JunBridge.JunApi;

// does her model answer. false = the game keeps its own touch lines
public static class JunHealth {
  private const double probeEverySeconds = 60;

  private static double lastProbeAt = double.NegativeInfinity;
  private static bool probing;

  public static bool Up { get; private set; }

  public static void Report(bool ok) => Up = ok;

  // models.php is a 502 when the model server is down. once a reply worked, replies keep this fresh
  public static void Tick(double now) {
    if (Up || probing || now - lastProbeAt < probeEverySeconds) {
      return;
    }
    lastProbeAt = now;
    probing = true;
    _ = Probe();
  }

  private static async Task Probe() {
    try {
      using var response = await JunSession.Instance.Client.GetAsync("api/models.php");
      Up = response.IsSuccessStatusCode;
    } catch (Exception) {
      Up = false;
    } finally {
      probing = false;
    }
  }
}
