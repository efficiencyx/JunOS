using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Il2Cpp;
using MelonLoader;
using MelonLoader.Preferences;
using JunBridge.JunApi;
using JunBridge.Utils;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge;

// F8. the game's own context menu (a vertical button list), its IMGUI is stripped (see LoginPrompt).
// a button closes its popup, so every pick names the page to open next
public static class SettingsMenu {
  private static readonly Logger logger = new("SettingsMenu");

  private static UIPopup popup;
  private static Action nextPage;
  private static bool open;
  private static string account = "";
  private static Dictionary<string, (List<string> Voices, string Default)> voices;

  public static void Toggle() {
    if (open) {
      nextPage = null;
      popup?.CloseFromUIOverlay();
      return;
    }
    open = true;
    nextPage = Checking;
  }

  public static void Update() {
    if (!open || (popup != null && UIManager.Instance.currentlyOpenPopups.Contains(popup))) {
      return;
    }
    popup = null;
    var page = nextPage;
    nextPage = null;
    if (page == null) {
      open = false;
      return;
    }
    try {
      page();
    } catch (Exception ex) {
      logger.LogError($"couldn't open the settings: {ex.Message}");
      open = false;
    }
  }

  private static void Checking() {
    Show([("Checking your Jun OS account...", () => { }), ("Close", () => { })]);
    _ = CheckAccountThenOpen();
  }

  // swaps the page that's up for another one, from a task that finished
  private static void Replace(Action page) {
    if (!open) {
      return;
    }
    nextPage = page;
    popup?.CloseFromUIOverlay();
  }

  private static async Task CheckAccountThenOpen() {
    var state = await JunSession.Instance.Check();
    var email = ModConfig.GetJunConfig().Email;
    account = state switch {
      JunSession.State.SignedIn => $"signed in as {email}",
      JunSession.State.SignedOut => "not signed in",
      _ => "Jun OS isn't reachable",
    };
    await MainThreadRunner.Run(() => Replace(Main));
  }

  private static void Main() {
    var tts = ModConfig.GetTtsConfig();
    Show([
      ($"Jun OS: {account} (sign in)", SignIn),
      ($"Her voice: {OnOff(tts.Enabled)}", Flip(ModConfig.ttsEnabledEntry, ReloadVoice)),
      ($"Voice engine: {tts.Engine}", () => nextPage = EnginePage),
      ($"Voice: {tts.Voice}", () => nextPage = VoicePage),
      ($"Speed: {tts.Speed:0.##}x", Pick(ModConfig.ttsSpeedEntry, [0.75, 0.9, 1.0, 1.1, 1.25, 1.5], v => $"{v:0.##}x", ReloadVoice)),
      ($"Volume: {tts.Volume:0.#}", Pick(ModConfig.ttsVolumeEntry, [1.0, 1.5, 2.0, 2.5, 3.0, 4.0], v => $"{v:0.#}", ReloadVoice)),
      ($"Lip sync: {OnOff(tts.LipSync)}", Flip(ModConfig.ttsLipSyncEntry, ReloadVoice)),
      ($"Thinking: {ModConfig.junReasoningEntry.Value}", Pick(ModConfig.junReasoningEntry, ["Auto", "Low", "Medium", "High"], v => v)),
      ($"She talks first: {OnOff(ModConfig.InitiativeEnabled)}", Flip(ModConfig.initiativeEnabledEntry)),
      ($"Idle before she talks: {ModConfig.idleMinutesEntry.Value:0.#} min", Pick(ModConfig.idleMinutesEntry, [1.0, 2.0, 3.0, 5.0, 10.0, 20.0], v => $"{v:0.#} min")),
      ($"Between her own lines: {ModConfig.cooldownMinutesEntry.Value:0.#} min", Pick(ModConfig.cooldownMinutesEntry, [2.0, 5.0, 10.0, 20.0, 30.0, 60.0], v => $"{v:0.#} min")),
      ($"Face stays after a chat: {ModConfig.expressionLingerSecondsEntry.Value:0} s", Pick(ModConfig.expressionLingerSecondsEntry, [0.0, 10.0, 30.0, 60.0, 120.0], v => $"{v:0} s")),
      ($"Sync with the game: {OnOff(ModConfig.SyncEnabled)}", Flip(ModConfig.syncEnabledEntry, Sync.BridgeSync.Start)),
      ("Close", () => { }),
    ]);
  }

  private static void EnginePage() {
    Show([
      ("kokoro", () => SetEngine("kokoro")),
      ("pockettts", () => SetEngine("pockettts")),
      ("Back", () => nextPage = Main),
    ]);
  }

  private static void SetEngine(string engine) {
    if (ModConfig.ttsEngineEntry.Value != engine) {
      ModConfig.ttsEngineEntry.Value = engine;
      // the old voice belongs to the other engine, tts.php would refuse it
      if (voices != null && voices.TryGetValue(engine, out var list)) {
        ModConfig.ttsVoiceEntry.Value = list.Default;
      }
      Save(ReloadVoice);
    }
    nextPage = Main;
  }

  private static void VoicePage() {
    var engine = ModConfig.ttsEngineEntry.Value;
    if (voices == null) {
      Show([("Asking Jun OS for her voices...", () => nextPage = VoicePage), ("Back", () => nextPage = Main)]);
      _ = LoadVoices();
      return;
    }
    if (!voices.TryGetValue(engine, out var list)) {
      Show([($"No voices for '{engine}', pick an engine first", () => nextPage = EnginePage), ("Back", () => nextPage = Main)]);
      return;
    }
    var choices = list.Voices.Select(v => (v == ModConfig.ttsVoiceEntry.Value ? $"{v} (now)" : v, (Action)(() => {
      ModConfig.ttsVoiceEntry.Value = v;
      Save(ReloadVoice);
      nextPage = Main;
    }))).ToList();
    choices.Add(("Back", () => nextPage = Main));
    Show(choices);
  }

  private static async Task LoadVoices() {
    try {
      var session = JunSession.Instance;
      using var response = await session.SendAuthenticated(() => session.Client.GetAsync("api/tts.php?action=voices"));
      using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
      var found = new Dictionary<string, (List<string>, string)>();
      foreach (var engine in json.RootElement.GetProperty("engines").EnumerateObject()) {
        var list = engine.Value.GetProperty("voices").EnumerateArray().Select(v => v.GetString()).ToList();
        var fallback = engine.Value.TryGetProperty("default", out var d) ? d.GetString() : list.FirstOrDefault();
        found[engine.Name] = (list, fallback);
      }
      voices = found;
    } catch (Exception ex) {
      logger.LogWarning($"couldn't load her voices: {ex.Message}");
    }
    // reopen the voice page whether it worked or not, a failure shows as the empty-engine line
    await MainThreadRunner.Run(() => {
      voices ??= new();
      Replace(VoicePage);
    });
  }

  private static void SignIn() {
    LoginPrompt.MainMenuReady();
    _ = SignInThenReopen();
  }

  private static async Task SignInThenReopen() {
    if (await LoginPrompt.Ask(false)) {
      await JunSession.Instance.EnsureSyncToken();
    }
    await MainThreadRunner.Run(() => {
      open = true;
      nextPage = Checking;
    });
  }

  private static Action Flip(MelonPreferences_Entry<bool> entry, Action after = null) => () => {
    entry.Value = !entry.Value;
    Save(after);
    nextPage = Main;
  };

  private static Action Pick<T>(MelonPreferences_Entry<T> entry, T[] values, Func<T, string> label, Action after = null) => () => {
    nextPage = () => {
      var choices = values.Select(v => (
        EqualityComparer<T>.Default.Equals(v, entry.Value) ? $"{label(v)} (now)" : label(v),
        (Action)(() => {
          entry.Value = v;
          Save(after);
          nextPage = Main;
        }))).ToList();
      choices.Add(("Back", () => nextPage = Main));
      Show(choices);
    };
  };

  private static void Save(Action after) {
    MelonPreferences.Save();
    after?.Invoke();
  }

  private static void ReloadVoice() => Tts.TtsManager.Instance.Reload();

  private static string OnOff(bool value) => value ? "on" : "off";

  private static void Show(List<(string Text, Action Pick)> buttons) {
    var choices = new Il2CppSystem.Collections.Generic.List<PopupChoice>();
    foreach (var (label, pick) in buttons) {
      choices.Add(new PopupChoice(label, new Action(() => {
        try {
          pick();
        } catch (Exception ex) {
          logger.LogError($"setting failed: {ex.Message}");
        }
        if (popup != null && UIManager.Instance.currentlyOpenPopups.Contains(popup)) {
          popup.CloseFromUIOverlay();
        }
      })));
    }
    UiOverlay.Instance.OpenContextMenuPopup(choices, false);
    var openPopups = UIManager.Instance.currentlyOpenPopups;
    popup = null;
    for (var i = openPopups.Count - 1; i >= 0 && popup == null; i--) {
      if (openPopups[i]?.TryCast<ContextMenuPopup>() != null) {
        popup = openPopups[i];
      }
    }
  }
}
