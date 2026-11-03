using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MelonLoader;
using UnityEngine;
using Il2CppInterop.Runtime.Attributes;
using JunBridge.Utils;
// Disambiguate from UnityEngine.Logger (both namespaces are imported)
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.Tts;

[MonoSingleton]
[RegisterTypeInIl2Cpp]
public class TtsManager : MonoBehaviour {
  public static TtsManager Instance => MonoSingletonManager.Get<TtsManager>();
  private static readonly Logger logger = new("TtsManager");

  // Seconds of audio inspected per frame to derive mouth openness
  private const float lipSyncWindowSeconds = 0.05f;
  // Smoothing speed for mouth movements (higher = snappier)
  private const float lipSyncSmoothing = 14f;

  private TtsConfig config;
  private TtsClient client;
  private TtsLipSync lipSync;
  private SemaphoreSlim concurrencyLimiter;

  private AudioSource audioSource;

  private readonly StringBuilder sentenceBuffer = new(256);
  private bool pendingBoundary = false;
  private bool sessionActive = false;

  private readonly Queue<Task<WavAudio>> pendingChunks = new();
  private CancellationTokenSource cancellation;

  private WavAudio currentAudio;
  private bool isPlaying = false;
  private float mouthValue = 0f;

  public bool IsEnabled => config?.Enabled ?? false;

  public void Awake() {
    this.ValidateSingleton();
    Reload();
  }

  // Re-reads [Tts] and rebuilds the client, so settings-panel changes apply without a restart
  public void Reload() {
    // Stop anything the previous config left playing before swapping the client out
    if (config != null && config.Enabled) {
      StopAll();
    }

    config = ModConfig.GetTtsConfig();
    client = null;
    lipSync = null;
    concurrencyLimiter = null;

    if (!config.Enabled) {
      logger.Log("TTS disabled");
      return;
    }

    try {
      client = new TtsClient(config);
      lipSync = new TtsLipSync();
      concurrencyLimiter = new SemaphoreSlim(Math.Max(1, config.MaxConcurrentRequests));
      logger.Log($"TTS enabled (voice: {config.Voice}, engine: {config.Engine})");
    } catch (Exception ex) {
      logger.LogError($"Failed to initialize TTS, disabling: {ex.Message}");
      config.Enabled = false;
    }
  }

  // Starts a new spoken message, stopping any audio left over from the previous one
  public void BeginUtterance() {
    if (!IsEnabled) {
      return;
    }

    StopAll();

    cancellation = new CancellationTokenSource();
    sessionActive = true;
  }

  // Feeds incrementally streamed visible text (commands already stripped by the parser)
  public void FeedText(string text) {
    if (!IsEnabled || !sessionActive || string.IsNullOrEmpty(text)) {
      return;
    }

    foreach (var character in text) {
      if (character == '\n' || character == '\r') {
        // Hard boundary: speak whatever we have, never wait for punctuation
        FlushSentence();
        pendingBoundary = false;
        continue;
      }

      if (pendingBoundary && char.IsWhiteSpace(character)) {
        // ".", "!" or "?" followed by whitespace ends the sentence.
        // Requiring the whitespace keeps decimals ("3.14") in one chunk
        FlushSentence();
        pendingBoundary = false;
        continue;
      }

      if (character is '.' or '!' or '?') {
        sentenceBuffer.Append(character);
        pendingBoundary = true;
        continue;
      }

      pendingBoundary = false;

      if (sentenceBuffer.Length == 0 && char.IsWhiteSpace(character)) {
        // Skip leading whitespace of a new sentence
        continue;
      }

      sentenceBuffer.Append(character);
    }
  }

  // Marks the end of the streamed message and speaks any trailing partial sentence
  public void CompleteUtterance() {
    if (!IsEnabled || !sessionActive) {
      return;
    }

    FlushSentence();
    pendingBoundary = false;
    sessionActive = false;
    // Queued audio keeps draining in Update
  }

  // Immediately stops playback, cancels in-flight requests and clears the queue
  public void StopAll() {
    if (config == null || !config.Enabled) {
      return;
    }

    sessionActive = false;
    sentenceBuffer.Clear();
    pendingBoundary = false;

    try {
      cancellation?.Cancel();
      cancellation?.Dispose();
    } catch (Exception) {
      // Cancellation races are harmless here
    }
    cancellation = null;

    pendingChunks.Clear();

    if (audioSource != null) {
      audioSource.Stop();
      DestroyCurrentClip();
    }

    currentAudio = null;
    isPlaying = false;
    mouthValue = 0f;
    lipSync?.Release();
  }

  // Drives the playback pipeline and computes the lipsync amplitude
  public void Update() {
    if (!IsEnabled) {
      return;
    }

    // Detect end of the current chunk
    if (isPlaying && (audioSource == null || !audioSource.isPlaying)) {
      isPlaying = false;
      currentAudio = null;
    }

    // Start the next chunk as soon as its audio is ready; skip failed ones
    while (!isPlaying && pendingChunks.Count > 0 && pendingChunks.Peek().IsCompleted) {
      var task = pendingChunks.Dequeue();
      var audio = task.Status == TaskStatus.RanToCompletion ? task.Result : null;

      if (audio != null && audio.FrameCount > 0) {
        PlayChunk(audio);
      }
    }

    UpdateMouthValue();
  }

  // Applies the mouth value after the game's own animation pass
  public void LateUpdate() {
    if (!IsEnabled || !config.LipSync || lipSync == null) {
      return;
    }

    if (isPlaying || mouthValue > 0.005f) {
      lipSync.Apply(mouthValue);
    } else {
      lipSync.Release();
    }
  }

  private void FlushSentence() {
    var text = sentenceBuffer.ToString().Trim();
    sentenceBuffer.Clear();

    if (!ContainsSpeakableContent(text)) {
      return;
    }

    var token = cancellation.Token;
    pendingChunks.Enqueue(SynthesizeLimited(text, token));
  }

  [HideFromIl2Cpp]
  private async Task<WavAudio> SynthesizeLimited(string text, CancellationToken token) {
    // The semaphore keeps request pipelining bounded: the next chunks
    // are already generating while the current one is playing
    await concurrencyLimiter.WaitAsync(token);

    try {
      token.ThrowIfCancellationRequested();
      return await client.Synthesize(text, token);
    } finally {
      concurrencyLimiter.Release();
    }
  }

  private void PlayChunk(WavAudio audio) {
    try {
      EnsureAudioSource();
      DestroyCurrentClip();

      var clip = AudioClip.Create("JunBridgeTts", audio.FrameCount, audio.Channels, audio.SampleRate, false);

      // Volume acts as a gain: AudioSource.volume caps at 1.0, which isn't enough headroom
      // for quiet TTS output, so amplify the PCM directly (clamped to avoid overflow) and
      // leave the source at unity. The lip-sync reads the untouched original samples
      var gain = (float)config.Volume;
      if (Mathf.Abs(gain - 1f) > 0.001f) {
        var scaled = new float[audio.Samples.Length];
        for (var i = 0; i < scaled.Length; i++) {
          scaled[i] = Mathf.Clamp(audio.Samples[i] * gain, -1f, 1f);
        }
        clip.SetData(scaled, 0);
      } else {
        clip.SetData(audio.Samples, 0);
      }

      audioSource.clip = clip;
      audioSource.volume = 1f;
      audioSource.Play();

      currentAudio = audio;
      isPlaying = true;
    } catch (Exception ex) {
      logger.LogError($"Failed to play TTS chunk: {ex.Message}");
      currentAudio = null;
      isPlaying = false;
    }
  }

  private void UpdateMouthValue() {
    var target = 0f;

    if (isPlaying && currentAudio != null && audioSource != null) {
      // Same RMS-to-mouth mapping as the Jun web UI: pow(min(rms * gain, 1), 0.7).
      // The power curve compresses the dynamic range so quiet speech still moves
      // the mouth without loud syllables snapping it fully open
      var rms = ComputeAmplitude(currentAudio, audioSource.timeSamples);
      target = Mathf.Pow(Mathf.Clamp01(rms * (float)config.LipSyncGain), 0.7f);
    }

    mouthValue = Mathf.Lerp(mouthValue, target, Time.deltaTime * lipSyncSmoothing);
  }

  private static float ComputeAmplitude(WavAudio audio, int framePosition) {
    var windowFrames = (int)(audio.SampleRate * lipSyncWindowSeconds);
    var start = framePosition * audio.Channels;
    var end = Math.Min(start + windowFrames * audio.Channels, audio.Samples.Length);

    if (start < 0 || start >= end) {
      return 0f;
    }

    var sum = 0f;
    for (var i = start; i < end; i++) {
      sum += audio.Samples[i] * audio.Samples[i];
    }

    return Mathf.Sqrt(sum / (end - start));
  }

  private void EnsureAudioSource() {
    if (audioSource == null) {
      audioSource = gameObject.AddComponent<AudioSource>();
      audioSource.playOnAwake = false;
      audioSource.spatialBlend = 0f; // Plain 2D voice
    }
  }

  private void DestroyCurrentClip() {
    if (audioSource != null && audioSource.clip != null) {
      var clip = audioSource.clip;
      audioSource.clip = null;
      Destroy(clip);
    }
  }

  private static bool ContainsSpeakableContent(string text) {
    foreach (var character in text) {
      if (char.IsLetterOrDigit(character)) {
        return true;
      }
    }
    return false;
  }
}
