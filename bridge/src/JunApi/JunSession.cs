using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using JunBridge.Utils;

namespace JunBridge.JunApi;

public class JunSession {
  private static readonly Logger logger = new("JunSession");
  private static readonly string[] cookieNames = { "omega_session", "omega_key" };

  // omega_key is her data key, same as the browser keeps it. the user's
  // profile, not the game folder, so it's private to them on windows
  private static readonly string sessionPath = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JunBridge", "session");

  private static JunSession instance;

  public static JunSession Instance => instance ??= new JunSession(ModConfig.GetJunConfig());

  public enum State { SignedIn, SignedOut, Unreachable }

  public JunConfig Config { get; }

  public HttpClient Client { get; }

  private readonly CookieContainer cookies = new();
  private readonly Uri baseUri;
  private bool hadSession;

  public JunSession(JunConfig config) {
    Config = config;
    baseUri = JunHttp.BaseUri(config.ApiUrl);
    Client = JunHttp.Create(config.ApiUrl, TimeSpan.FromSeconds(Math.Max(30, config.TimeoutSeconds)), cookies);
    LoadCookies();
  }

  // asks in-game when signed out. false = JunOS is off or they said not now
  public async Task<bool> EnsureAuthenticated() {
    var state = await Check();
    if (state == State.SignedIn) {
      return true;
    }
    if (state == State.Unreachable) {
      return false;
    }
    bool signedIn = !string.IsNullOrEmpty(Config.Password) && await Login(Config.Email, Config.Password) == null;
    if (!signedIn) {
      signedIn = await LoginPrompt.Ask(hadSession);
    }
    if (signedIn) {
      await EnsureSyncToken();
    }
    return signedIn;
  }

  public async Task<State> Check() {
    if (!HasCookies()) {
      return State.SignedOut;
    }
    try {
      using var response = await Client.GetAsync("api/auth.php?action=me");
      if (response.IsSuccessStatusCode) {
        return State.SignedIn;
      }
      if (NeedsSignIn(response.StatusCode)) {
        ForgetCookies();
        return State.SignedOut;
      }
      return State.Unreachable;
    } catch (Exception ex) {
      logger.LogWarning($"can't reach JunOS at {Config.ApiUrl}: {ex.Message}");
      return State.Unreachable;
    }
  }

  // null on success, otherwise what to tell them
  public async Task<string> Login(string email, string password) {
    try {
      var body = JsonSerializer.Serialize(new { email, password });
      using var response = await Client.PostAsync(
        "api/auth.php?action=login",
        new StringContent(body, Encoding.UTF8, "application/json")
      );
      if (response.StatusCode == HttpStatusCode.Unauthorized) {
        return "Wrong email or password.";
      }
      if ((int)response.StatusCode == 429) {
        return "Too many tries, wait a minute.";
      }
      if (!response.IsSuccessStatusCode) {
        return $"Jun OS said {(int)response.StatusCode}.";
      }
    } catch (Exception ex) {
      logger.LogError($"login failed: {ex.Message}");
      return $"Can't reach Jun OS at {Config.ApiUrl}. Is she running?";
    }

    SaveCookies();
    await MainThreadRunner.Run(() => ModConfig.SignedIn(email));
    logger.Log("signed in to JunOS");
    return null;
  }

  public static bool NeedsSignIn(HttpStatusCode status) =>
    status == HttpStatusCode.Unauthorized || status == HttpStatusCode.Forbidden;

  public async Task<HttpResponseMessage> SendAuthenticated(
    Func<Task<HttpResponseMessage>> send, CancellationToken cancellationToken = default) {
    var response = await send();
    if (!NeedsSignIn(response.StatusCode)) {
      return response;
    }
    ForgetCookies();
    try {
      if (!await LoginPrompt.Ask(true).WaitAsync(cancellationToken)) {
        return response;
      }
    } catch {
      response.Dispose();
      throw;
    }
    response.Dispose();
    cancellationToken.ThrowIfCancellationRequested();
    return await send();
  }

  public async Task EnsureSyncToken() {
    if (!string.IsNullOrEmpty(ModConfig.SyncToken) || !ModConfig.SyncEnabled) {
      return;
    }
    try {
      using var response = await SendAuthenticated(() => Client.PostAsync("api/bridge-pair.php", null));
      if (response.StatusCode == HttpStatusCode.NotFound) {
        logger.LogWarning("the game bridge is off in JunOS (GAME_BRIDGE in .env)");
        return;
      }
      if (!response.IsSuccessStatusCode) {
        logger.LogError($"pairing failed: {(int)response.StatusCode}");
        return;
      }
      using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
      var token = doc.RootElement.GetProperty("token").GetString();
      await MainThreadRunner.Run(() => {
        ModConfig.SetSyncToken(token);
        Sync.BridgeSync.SyncNow();
      });
      logger.Log("paired with JunOS");
    } catch (Exception ex) {
      logger.LogError($"pairing failed: {ex.Message}");
    }
  }

  // JunOS dropped the token (Unpair, New token, factory reset)
  public async Task Repair(bool signInRequired = false) {
    await MainThreadRunner.Run(() => ModConfig.SetSyncToken(""));
    if (signInRequired) {
      ForgetCookies();
    }
    if (signInRequired ? await LoginPrompt.Ask(true) : await EnsureAuthenticated()) {
      await EnsureSyncToken();
    }
  }

  private bool HasCookies() => cookies.GetCookies(baseUri).Cast<Cookie>().Any(c => c.Name == cookieNames[0]);

  private void LoadCookies() {
    try {
      if (!File.Exists(sessionPath)) {
        return;
      }
      foreach (var line in File.ReadAllLines(sessionPath)) {
        var eq = line.IndexOf('=');
        if (eq > 0 && cookieNames.Contains(line[..eq])) {
          cookies.Add(baseUri, new Cookie(line[..eq], line[(eq + 1)..], "/"));
          hadSession = true;
        }
      }
    } catch (Exception ex) {
      logger.LogWarning($"couldn't read the saved session: {ex.Message}");
    }
  }

  private void SaveCookies() {
    var lines = cookies.GetCookies(baseUri).Cast<Cookie>()
      .Where(c => cookieNames.Contains(c.Name))
      .Select(c => $"{c.Name}={c.Value}")
      .ToArray();
    try {
      Directory.CreateDirectory(Path.GetDirectoryName(sessionPath));
      File.WriteAllLines(sessionPath, lines);
      if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) {
        chmod(sessionPath, 0x180);
      }
      hadSession = true;
    } catch (Exception ex) {
      logger.LogWarning($"couldn't save the session, it'll ask again next start: {ex.Message}");
    }
  }

  private void ForgetCookies() {
    foreach (Cookie c in cookies.GetCookies(baseUri)) {
      c.Expired = true;
    }
    try {
      File.Delete(sessionPath);
    } catch (Exception) {
    }
  }

  [DllImport("libc", SetLastError = true)]
  private static extern int chmod(string path, int mode);
}
