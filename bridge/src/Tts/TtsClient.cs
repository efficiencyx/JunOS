using System;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using JunBridge.JunApi;
using JunBridge.Utils;

namespace JunBridge.Tts;

public class TtsClient {
  private static readonly Logger logger = new("TtsClient");

  private readonly TtsConfig config;

  public TtsClient(TtsConfig config) {
    this.config = config;
  }

  public async Task<WavAudio> Synthesize(string text, CancellationToken cancellationToken) {
    try {
      var response = await SynthesizeJun(text, cancellationToken);

      if (response == null) {
        return null;
      }

      using (response) {
        if (response.StatusCode == HttpStatusCode.NoContent) {
          // Nothing speakable in this chunk (the Jun TTS sidecar returns 204)
          return null;
        }

        if (!response.IsSuccessStatusCode) {
          var body = await response.Content.ReadAsStringAsync();
          logger.LogError($"TTS request failed: {response.StatusCode} - {Truncate(body, 300)}");
          return null;
        }

        var bytes = await response.Content.ReadAsByteArrayAsync();
        return WavAudio.Parse(bytes);
      }
    } catch (OperationCanceledException) {
      // Session was stopped, not an error
      return null;
    } catch (Exception ex) {
      logger.LogError($"TTS synthesis failed: {ex.Message}");
      return null;
    }
  }

  private async Task<HttpResponseMessage> SynthesizeJun(string text, CancellationToken cancellationToken) {
    var session = JunSession.Instance;

    if (!await session.EnsureAuthenticated()) {
      logger.LogError("TTS skipped: not signed in to JunOS");
      return null;
    }

    // tts.php rejects texts over 2000 chars
    if (text.Length > 2000) {
      text = text[..2000];
    }

    var payload = new JunSpeechRequest {
      Text = text,
      Voice = config.Voice,
      Speed = Math.Clamp(config.Speed, 0.5, 2.0),
      Engine = config.Engine
    };

    return await session.SendAuthenticated(async () => {
      using var request = new HttpRequestMessage(HttpMethod.Post, "api/tts.php?action=tts") {
        Content = new StringContent(
          JsonSerializer.Serialize(payload, new JsonSerializerOptions {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
          }),
          Encoding.UTF8,
          "application/json"
        )
      };
      return await session.Client.SendAsync(request, cancellationToken);
    }, cancellationToken);
  }

  private static string Truncate(string value, int maxLength) {
    if (string.IsNullOrEmpty(value) || value.Length <= maxLength) {
      return value;
    }
    return value[..maxLength] + "...";
  }

  private class JunSpeechRequest {
    [JsonPropertyName("text")]
    public string Text { get; set; }

    [JsonPropertyName("voice")]
    public string Voice { get; set; }

    [JsonPropertyName("speed")]
    public double Speed { get; set; }

    [JsonPropertyName("engine")]
    public string Engine { get; set; }
  }
}
