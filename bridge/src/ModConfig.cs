using System.IO;
using MelonLoader;
using MelonLoader.Preferences;
using MelonLoader.Utils;

namespace JunBridge;

// UserData/JunBridge.cfg. JunOS writes ApiUrl on every start, the sign-in box fills Email and Token
public static class ModConfig {
  private static readonly string configPath = Path.Combine(MelonEnvironment.UserDataDirectory, "JunBridge.cfg");

  private static MelonPreferences_Entry<string> junApiUrlEntry;
  private static MelonPreferences_Entry<string> junEmailEntry;
  private static MelonPreferences_Entry<string> junPasswordEntry;
  private static MelonPreferences_Entry<int> junConversationIdEntry;
  private static MelonPreferences_Entry<string> junModelEntry;
  internal static MelonPreferences_Entry<string> junReasoningEntry;
  private static MelonPreferences_Entry<int> junTimeoutSecondsEntry;

  internal static MelonPreferences_Entry<bool> syncEnabledEntry;
  private static MelonPreferences_Entry<string> syncTokenEntry;

  internal static MelonPreferences_Entry<bool> ttsEnabledEntry;
  internal static MelonPreferences_Entry<string> ttsVoiceEntry;
  internal static MelonPreferences_Entry<string> ttsEngineEntry;
  internal static MelonPreferences_Entry<double> ttsSpeedEntry;
  internal static MelonPreferences_Entry<double> ttsVolumeEntry;
  internal static MelonPreferences_Entry<bool> ttsLipSyncEntry;
  private static MelonPreferences_Entry<double> ttsLipSyncGainEntry;
  private static MelonPreferences_Entry<int> ttsMaxConcurrentRequestsEntry;
  private static MelonPreferences_Entry<int> ttsTimeoutSecondsEntry;

  internal static MelonPreferences_Entry<bool> initiativeEnabledEntry;
  internal static MelonPreferences_Entry<double> idleMinutesEntry;
  internal static MelonPreferences_Entry<double> cooldownMinutesEntry;
  internal static MelonPreferences_Entry<double> expressionLingerSecondsEntry;

  public static void Load() {
    var jun = MelonPreferences.CreateCategory("Jun");
    jun.SetFilePath(configPath);
    junApiUrlEntry = jun.CreateEntry("ApiUrl", "https://localhost", "JunOS address, the same one the browser opens");
    junEmailEntry = jun.CreateEntry("Email", "", "JunOS account email");
    junPasswordEntry = jun.CreateEntry("Password", "", "Leave empty, the game asks you to sign in");
    junConversationIdEntry = jun.CreateEntry("ConversationId", 0, "Conversation to continue (0 = make one and remember it in the save)");
    junModelEntry = jun.CreateEntry("Model", "", "Model override (empty = what JunOS uses)");
    junReasoningEntry = jun.CreateEntry("Reasoning", "Auto", "Auto, Low, Medium or High");
    junTimeoutSecondsEntry = jun.CreateEntry("TimeoutSeconds", 600, "Timeout in seconds");

    var sync = MelonPreferences.CreateCategory("Sync");
    sync.SetFilePath(configPath);
    syncEnabledEntry = sync.CreateEntry("Enabled", true, "Sync sympathy, outfit and what happens with JunOS");
    syncTokenEntry = sync.CreateEntry("Token", "", "Bridge token from JunOS Settings > Account > Game bridge");

    var tts = MelonPreferences.CreateCategory("Tts");
    tts.SetFilePath(configPath);
    ttsEnabledEntry = tts.CreateEntry("Enabled", false, "Speak her replies with the JunOS voice");
    ttsVoiceEntry = tts.CreateEntry("Voice", "af_heart", "Voice name");
    ttsEngineEntry = tts.CreateEntry("Engine", "kokoro", "kokoro or pockettts");
    // tts.php refuses anything else and every line goes silent
    if (ttsEngineEntry.Value is not ("kokoro" or "pockettts")) {
      ttsEngineEntry.Value = ttsEngineEntry.Value.StartsWith("pocket", System.StringComparison.OrdinalIgnoreCase) ? "pockettts" : "kokoro";
    }
    ttsSpeedEntry = tts.CreateEntry("Speed", 1.0, "Speech speed multiplier", validator: new ValueRange<double>(0.25, 4.0));
    ttsVolumeEntry = tts.CreateEntry("Volume", 2.5, "Playback gain (1.0 = original level)", validator: new ValueRange<double>(0.0, 5.0));
    ttsLipSyncEntry = tts.CreateEntry("LipSync", true, "Move the mouth with the audio");
    ttsLipSyncGainEntry = tts.CreateEntry("LipSyncGain", 3.5, "Amplitude-to-mouth gain", validator: new ValueRange<double>(0.1, 20.0));
    ttsMaxConcurrentRequestsEntry = tts.CreateEntry("MaxConcurrentRequests", 2, "Sentences generated in parallel", validator: new ValueRange<int>(1, 8));
    ttsTimeoutSecondsEntry = tts.CreateEntry("TimeoutSeconds", 60, "Timeout in seconds");

    var initiative = MelonPreferences.CreateCategory("Initiative");
    initiative.SetFilePath(configPath);
    initiativeEnabledEntry = initiative.CreateEntry("Enabled", true, "She talks first: welcome back, after outings, intimacy and sleep, and now and then when you're idle in her room");
    idleMinutesEntry = initiative.CreateEntry("IdleMinutes", 3.0, "Idle time in her room before she says something on her own", validator: new ValueRange<double>(0.5, 120.0));
    cooldownMinutesEntry = initiative.CreateEntry("CooldownMinutes", 10.0, "At most one unprompted line every this many minutes", validator: new ValueRange<double>(1.0, 240.0));
    expressionLingerSecondsEntry = initiative.CreateEntry("ExpressionLingerSeconds", 30.0, "How long her last expression stays after the chat closes (0 = reset right away)", validator: new ValueRange<double>(0.0, 600.0));

    MelonPreferences.Save();
  }

  public static bool InitiativeEnabled => initiativeEnabledEntry.Value;
  public static float IdleSeconds => (float)(idleMinutesEntry.Value * 60);
  public static float CooldownSeconds => (float)(cooldownMinutesEntry.Value * 60);
  public static float ExpressionLingerSeconds => (float)expressionLingerSecondsEntry.Value;

  public static bool SyncEnabled => syncEnabledEntry.Value;
  public static string SyncToken => syncTokenEntry.Value;

  public static void SetSyncToken(string token) {
    syncTokenEntry.Value = token;
    MelonPreferences.Save();
  }

  // an old start.ps1 bridge left the password in the file, it goes on the first good sign-in
  public static void SignedIn(string email) {
    junEmailEntry.Value = email;
    junPasswordEntry.Value = "";
    MelonPreferences.Save();
  }

  public static JunApi.JunConfig GetJunConfig() {
    return new JunApi.JunConfig {
      ApiUrl = junApiUrlEntry.Value,
      Email = junEmailEntry.Value,
      Password = junPasswordEntry.Value,
      ConversationId = junConversationIdEntry.Value,
      Model = junModelEntry.Value,
      Reasoning = junReasoningEntry.Value,
      TimeoutSeconds = junTimeoutSecondsEntry.Value
    };
  }

  public static Tts.TtsConfig GetTtsConfig() {
    return new Tts.TtsConfig {
      Enabled = ttsEnabledEntry.Value,
      Voice = ttsVoiceEntry.Value,
      Engine = ttsEngineEntry.Value,
      Speed = ttsSpeedEntry.Value,
      Volume = ttsVolumeEntry.Value,
      LipSync = ttsLipSyncEntry.Value,
      LipSyncGain = ttsLipSyncGainEntry.Value,
      MaxConcurrentRequests = ttsMaxConcurrentRequestsEntry.Value,
      TimeoutSeconds = ttsTimeoutSecondsEntry.Value
    };
  }
}
