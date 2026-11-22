using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using MelonLoader;
using MelonLoader.Preferences;
using JunBridge.JunApi;
using JunBridge.Utils;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge;

// our page in ModSettingsMenu (Options > Mod settings) when that mod is installed.
// reflection so JunBridge builds and runs without it, F8's popup menu is the fallback
public static class ModSettingsPage {
  private const string id = "JunBridge";
  private static readonly Logger logger = new("ModSettingsPage");

  private static Type msm;
  private static readonly List<string> voiceOptions = [];
  private static readonly Dictionary<string, (List<string> Voices, string Default)> voices = [];

  public static bool Available => msm != null;

  public static void Register() {
    msm = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("ModSettingsMenu.MSM")).FirstOrDefault(t => t != null);
    if (msm == null) {
      return;
    }
    try {
      Call("RegisterMod", id, "Jun OS");

      Call("AddLabel", id, "LeftPanel", "Account");
      Call("AddButton", id, "LeftPanel", "Sign in", (Action)SignIn);
      Call("AddPadding", id, "LeftPanel");
      Call("AddLabel", id, "LeftPanel", "Her voice");
      Checkbox("LeftPanel", "Speak her replies", ModConfig.ttsEnabledEntry, ReloadVoice);
      Call("AddDropdown", id, "LeftPanel", "Engine", new List<string> { "kokoro", "pockettts" },
        (Func<string>)(() => ModConfig.ttsEngineEntry.Value), (Action<string>)SetEngine, "");
      voiceOptions.Add(ModConfig.ttsVoiceEntry.Value);
      Call("AddDropdown", id, "LeftPanel", "Voice", voiceOptions,
        (Func<string>)(() => ModConfig.ttsVoiceEntry.Value), (Action<string>)(v => Set(ModConfig.ttsVoiceEntry, v, ReloadVoice)), "");
      Slider("LeftPanel", "Speed", 0.5f, 2f, 16, ModConfig.ttsSpeedEntry, ReloadVoice);
      Slider("LeftPanel", "Volume", 0f, 5f, 11, ModConfig.ttsVolumeEntry, ReloadVoice);
      Checkbox("LeftPanel", "Lip sync", ModConfig.ttsLipSyncEntry, ReloadVoice);

      Call("AddLabel", id, "RightPanel", "She talks first");
      Checkbox("RightPanel", "Welcome back, events, touches, idle lines", ModConfig.initiativeEnabledEntry);
      Slider("RightPanel", "Idle before she talks (min)", 0.5f, 30f, 60, ModConfig.idleMinutesEntry);
      Slider("RightPanel", "Between her own lines (min)", 1f, 60f, 60, ModConfig.cooldownMinutesEntry);
      Slider("RightPanel", "Face stays after a chat (s)", 0f, 120f, 25, ModConfig.expressionLingerSecondsEntry);
      Call("AddPadding", id, "RightPanel");
      Call("AddLabel", id, "RightPanel", "Jun OS");
      Call("AddDropdown", id, "RightPanel", "Thinking", new List<string> { "Auto", "Low", "Medium", "High" },
        (Func<string>)(() => ModConfig.junReasoningEntry.Value), (Action<string>)(v => Set(ModConfig.junReasoningEntry, v)), "");
      Checkbox("RightPanel", "Sync with the game", ModConfig.syncEnabledEntry, Sync.BridgeSync.Start);

      _ = LoadVoices();
    } catch (Exception ex) {
      logger.LogError($"couldn't add the Jun OS page to Mod settings: {ex.Message}");
      msm = null;
    }
  }

  public static async Task LoadVoices() {
    try {
      if (await JunSession.Instance.Check() != JunSession.State.SignedIn) {
        return;
      }
      var session = JunSession.Instance;
      using var response = await session.SendAuthenticated(() => session.Client.GetAsync("api/tts.php?action=voices"));
      using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
      foreach (var engine in json.RootElement.GetProperty("engines").EnumerateObject()) {
        var list = engine.Value.GetProperty("voices").EnumerateArray().Select(v => v.GetString()).ToList();
        voices[engine.Name] = (list, engine.Value.TryGetProperty("default", out var d) ? d.GetString() : list.FirstOrDefault());
      }
      await MainThreadRunner.Run(() => FillVoices(false));
    } catch (Exception ex) {
      logger.LogWarning($"couldn't load her voices: {ex.Message}");
    }
  }

  // RefreshSettings rebuilds whatever page is up, with no window yet it throws. only refresh from our own controls
  private static void FillVoices(bool refresh) {
    if (!voices.TryGetValue(ModConfig.ttsEngineEntry.Value, out var list)) {
      return;
    }
    voiceOptions.Clear();
    voiceOptions.AddRange(list.Voices);
    if (refresh) {
      Call("RefreshSettings", id);
    }
  }

  private static void SetEngine(string engine) {
    if (ModConfig.ttsEngineEntry.Value == engine) {
      return;
    }
    ModConfig.ttsEngineEntry.Value = engine;
    // the old voice belongs to the other engine, tts.php would refuse it
    if (voices.TryGetValue(engine, out var list)) {
      ModConfig.ttsVoiceEntry.Value = list.Default;
    }
    Save(ReloadVoice);
    FillVoices(true);
  }

  private static void SignIn() {
    LoginPrompt.MainMenuReady();
    _ = SignInThenLoad();
  }

  private static async Task SignInThenLoad() {
    if (await LoginPrompt.Ask(false)) {
      await JunSession.Instance.EnsureSyncToken();
      await LoadVoices();
    }
  }

  private static void Checkbox(string side, string label, MelonPreferences_Entry<bool> entry, Action after = null) {
    Call("AddCheckbox", id, side, label, (Func<bool>)(() => entry.Value), (Action<bool>)(v => Set(entry, v, after)), "");
  }

  private static void Slider(string side, string label, float min, float max, int steps, MelonPreferences_Entry<double> entry, Action after = null) {
    var step = (max - min) / (steps - 1);
    Call("AddSlider", id, side, label, min, max, (Func<float>)(() => (float)entry.Value), steps,
      (Action<float>)(v => Set(entry, Math.Round(min + Math.Round((v - min) / step) * step, 2), after)), "");
  }

  private static void Set<T>(MelonPreferences_Entry<T> entry, T value, Action after = null) {
    if (EqualityComparer<T>.Default.Equals(entry.Value, value)) {
      return;
    }
    entry.Value = value;
    Save(after);
  }

  private static void Save(Action after) {
    MelonPreferences.Save();
    after?.Invoke();
  }

  private static void ReloadVoice() => Tts.TtsManager.Instance.Reload();

  // positional args, the rest take their defaults. a string where MSM wants an enum is its name
  private static void Call(string name, params object[] args) {
    var method = msm.GetMethods(BindingFlags.Public | BindingFlags.Static).First(m => {
      var ps = m.GetParameters();
      return m.Name == name && ps.Length >= args.Length
        && ps.Skip(args.Length).All(p => p.HasDefaultValue)
        && args.Select((a, i) => a == null || ps[i].ParameterType.IsInstanceOfType(a) || (ps[i].ParameterType.IsEnum && a is string)).All(ok => ok);
    });
    var ps = method.GetParameters();
    var full = ps.Select((p, i) => i < args.Length
      ? (p.ParameterType.IsEnum && args[i] is string s ? Enum.Parse(p.ParameterType, s) : args[i])
      : p.DefaultValue).ToArray();
    method.Invoke(null, full);
  }
}
