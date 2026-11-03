using System;
using System.Collections;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using MelonLoader;
using UnityEngine;
using Il2Cpp;
using JunBridge.Utils;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.Sync;

// JsonUtility.ToJson is the same json a save keeps in savedata, so
// the server reads the mod and the save file with one parser
public static class BridgeSync {
  private static readonly Logger logger = new("BridgeSync");
  private const float intervalSeconds = 60f;

  private static HttpClient client;
  private static string clientToken;
  private static string lastSent;
  private static bool busy;
  private static bool started;

  public static void Start() {
    if (started || !ModConfig.SyncEnabled) {
      return;
    }
    started = true;
    MelonCoroutines.Start(Loop());
  }

  // after a load the game holds a different save, push it now
  public static void SyncNow() {
    lastSent = null;
    Push();
  }

  // the token shows up mid-game, after the sign-in box pairs
  private static HttpClient Client() {
    var token = ModConfig.SyncToken;
    if (string.IsNullOrEmpty(token)) {
      return null;
    }
    if (client == null || clientToken != token) {
      client?.Dispose();
      client = JunApi.JunHttp.Create(ModConfig.GetJunConfig().ApiUrl, TimeSpan.FromSeconds(30));
      client.DefaultRequestHeaders.Add("Authorization", "Bearer " + token);
      clientToken = token;
    }
    return client;
  }

  private static IEnumerator Loop() {
    while (true) {
      yield return new WaitForSeconds(intervalSeconds);
      Push();
    }
  }

  private static void Push() {
    var vars = GameScript.Instance?.GameVariables;
    var http = Client();
    if (vars == null || busy || http == null) {
      return;
    }
    string json;
    try {
      json = JsonUtility.ToJson(vars);
    } catch (Exception e) {
      logger.LogError($"could not read the game state: {e.Message}");
      return;
    }
    if (json == lastSent) {
      return;
    }
    busy = true;
    _ = Send(http, json);
  }

  private static async Task Send(HttpClient http, string json) {
    try {
      var body = JsonSerializer.Serialize(new { savedata = json });
      using var response = await http.PostAsync("api/bridge.php", new StringContent(body, Encoding.UTF8, "application/json"));
      if (JunApi.JunSession.NeedsSignIn(response.StatusCode)) {
        logger.LogWarning("JunOS doesn't know this token anymore, pairing again");
        await JunApi.JunSession.Instance.Repair(response.StatusCode == HttpStatusCode.Forbidden);
        return;
      }
      if (!response.IsSuccessStatusCode) {
        logger.LogError($"JunOS said {(int)response.StatusCode}");
        return;
      }
      using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
      int sympathy = doc.RootElement.GetProperty("sympathy").GetInt32();
      await MainThreadRunner.Run(() => ApplySympathy(sympathy));
      lastSent = json;
    } catch (Exception e) {
      // JunOS is off, the next tick tries again with the whole state anyway
      logger.LogWarning($"sync failed: {e.Message}");
    } finally {
      busy = false;
    }
  }

  // the raw field, not the sympathy setter, the game goes past 1000
  private static void ApplySympathy(int sympathy) {
    var vars = GameScript.Instance?.GameVariables;
    if (vars != null) {
      vars._sympathy = sympathy;
    }
  }
}
