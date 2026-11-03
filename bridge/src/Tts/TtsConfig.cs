namespace JunBridge.Tts;

public class TtsConfig {
  public bool Enabled { get; set; }

  public string Voice { get; set; }

  // "kokoro" or "pockettts"
  public string Engine { get; set; }

  public double Speed { get; set; }

  // Sample-level gain (AudioSource.volume caps at 1.0, so quiet TTS is boosted here)
  public double Volume { get; set; }

  public bool LipSync { get; set; }
  public double LipSyncGain { get; set; }

  // How many TTS requests may generate in parallel while audio is playing
  public int MaxConcurrentRequests { get; set; }

  public int TimeoutSeconds { get; set; }
}
