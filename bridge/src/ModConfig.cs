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
  private static MelonPreferences_Entry<string> junReasoningEntry;
  private static MelonPreferences_Entry<int> junTimeoutSecondsEntry;

  private static MelonPreferences_Entry<bool> syncEnabledEntry;
  private static MelonPreferences_Entry<string> syncTokenEntry;

  private static MelonPreferences_Entry<bool> ttsEnabledEntry;
  private static MelonPreferences_Entry<string> ttsVoiceEntry;
  private static MelonPreferences_Entry<string> ttsEngineEntry;
  private static MelonPreferences_Entry<double> ttsSpeedEntry;
  private static MelonPreferences_Entry<double> ttsVolumeEntry;
  private static MelonPreferences_Entry<bool> ttsLipSyncEntry;
  private static MelonPreferences_Entry<double> ttsLipSyncGainEntry;
  private static MelonPreferences_Entry<int> ttsMaxConcurrentRequestsEntry;
  private static MelonPreferences_Entry<int> ttsTimeoutSecondsEntry;

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
    ttsSpeedEntry = tts.CreateEntry("Speed", 1.0, "Speech speed multiplier", validator: new ValueRange<double>(0.25, 4.0));
    ttsVolumeEntry = tts.CreateEntry("Volume", 2.5, "Playback gain (1.0 = original level)", validator: new ValueRange<double>(0.0, 5.0));
    ttsLipSyncEntry = tts.CreateEntry("LipSync", true, "Move the mouth with the audio");
    ttsLipSyncGainEntry = tts.CreateEntry("LipSyncGain", 3.5, "Amplitude-to-mouth gain", validator: new ValueRange<double>(0.1, 20.0));
    ttsMaxConcurrentRequestsEntry = tts.CreateEntry("MaxConcurrentRequests", 2, "Sentences generated in parallel", validator: new ValueRange<int>(1, 8));
    ttsTimeoutSecondsEntry = tts.CreateEntry("TimeoutSeconds", 60, "Timeout in seconds");

    MelonPreferences.Save();
  }

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
