using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using JunBridge.Utils;

namespace JunBridge.JunApi;

public class JunChat {
  private static readonly Logger logger = new("JunChat");

  private const string conversationSaveKey = "jun-conversation-id";
  private const int maxHistoryMessages = 78;

  private readonly JunSession session = JunSession.Instance;
  private readonly List<ChatMessage> messages = [];
  private int conversationId = 0;

  public async Task<bool> EnsureReady() {
    if (!await session.EnsureAuthenticated() || !await EnsureConversation()) {
      return false;
    }
    await PullServerHistory();
    return true;
  }

  // the old chat stays in JunOS, the game just starts a new one next time
  public void Reset() {
    messages.Clear();
    conversationId = 0;
    SaveStorage.Instance.SetValue(conversationSaveKey, 0);
  }

  public IAsyncEnumerable<string> SendMessage(string message, GameContext game) {
    messages.Add(new ChatMessage { Role = "user", Content = message });
    return Stream(game, null);
  }

  public IAsyncEnumerable<string> SendCue(string cue, bool ephemeral, GameContext game) {
    var extra = new Dictionary<string, object> { { "idle", true }, { "ephemeral", ephemeral } };
    if (cue != null) {
      extra["cue"] = cue;
    }
    return Stream(game, extra);
  }

  // client side only, the next turns see what she said but the server never stored it
  public void Remember(string assistantText) {
    messages.Add(new ChatMessage { Role = "assistant", Content = assistantText });
  }

  private async IAsyncEnumerable<string> Stream(GameContext game, Dictionary<string, object> extra) {
    var userTurn = extra == null;
    HttpResponseMessage response = null;
    string error = null;

    try {
      response = await MakeChatRequest(game, extra);
      if (!response.IsSuccessStatusCode) {
        error = $"Jun webapp returned {(int)response.StatusCode} ({response.StatusCode})";
      }
    } catch (Exception ex) {
      error = ex.Message;
    }

    var translator = new JunActionTranslator(game.PlayerName, game.BotName);
    var raw = new StringBuilder(2048);

    if (error == null) {
      using var reader = new StreamReader(await response.Content.ReadAsStreamAsync());

      while (!reader.EndOfStream) {
        string cleanText = null;

        try {
          var line = await reader.ReadLineAsync();
          if (string.IsNullOrWhiteSpace(line) || !line.StartsWith("data: ")) continue;

          var payload = line[6..];
          if (payload == "[DONE]") break;

          var chunk = JsonSerializer.Deserialize<ChatEvent>(payload);
          if (!string.IsNullOrEmpty(chunk?.Error)) {
            error = chunk.Error;
            break;
          }

          // debug/thinking/stats events carry no token
          if (!string.IsNullOrEmpty(chunk?.Token)) {
            raw.Append(chunk.Token);
            cleanText = translator.Process(chunk.Token);
          }
        } catch (Exception ex) {
          logger.LogError($"Parse error: {ex.Message}");
        }

        if (!string.IsNullOrEmpty(cleanText)) {
          yield return cleanText;
        }
      }
    }

    if (error != null) {
      if (!userTurn) {
        throw new InvalidOperationException(error);
      }
      messages.RemoveAt(messages.Count - 1);
      yield return $"Error: {error}";
      yield break;
    }

    var trailing = translator.Flush();
    if (!string.IsNullOrEmpty(trailing)) {
      yield return trailing;
    }

    // raw with the tags, same as the server stores it. an ephemeral line stays client side only
    messages.Add(new ChatMessage { Role = "assistant", Content = raw.ToString() });
  }

  private async Task<HttpResponseMessage> MakeChatRequest(GameContext game, Dictionary<string, object> extra) {
    var history = messages.Count > maxHistoryMessages
      ? messages.GetRange(messages.Count - maxHistoryMessages, maxHistoryMessages)
      : messages;

    var payload = new Dictionary<string, object> {
      { "conversation_id", conversationId },
      { "messages", history },
      { "reasoning", NormalizeReasoning(ModConfig.GetJunConfig().Reasoning) },
      { "client_time", game.ClientTime }
    };
    if (game.Outfit != "") {
      payload["outfit_context"] = game.Outfit;
    }
    var lines = Chat.GameLines.Drain();
    if (lines.Count > 0) {
      payload["game_lines"] = lines;
    }
    var actions = Chat.Interactions.Drain();
    if (actions.Count > 0) {
      payload["game_actions"] = actions;
    }
    foreach (var (key, value) in extra ?? []) {
      payload[key] = value;
    }

    if (!string.IsNullOrEmpty(session.Config.Model)) {
      payload["model"] = session.Config.Model;
    }

    var body = JsonSerializer.Serialize(payload);
    return await session.SendAuthenticated(async () => {
      using var request = new HttpRequestMessage(HttpMethod.Post, "api/chat.php") {
        Content = new StringContent(body, Encoding.UTF8, "application/json")
      };
      return await session.Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
    });
  }

  private async Task<bool> EnsureConversation() {
    var configuredId = session.Config.ConversationId;
    var candidateId = configuredId > 0
      ? configuredId
      : SaveStorage.Instance.GetValue(conversationSaveKey, 0);

    if (candidateId > 0 && await ConversationExists(candidateId)) {
      conversationId = candidateId;
      return true;
    }

    try {
      using var response = await session.SendAuthenticated(() => session.Client.PostAsync("api/conversations.php?action=create", null));
      if (!response.IsSuccessStatusCode) {
        logger.LogError($"Failed to create conversation: {response.StatusCode}");
        return false;
      }

      var created = JsonSerializer.Deserialize<CreatedConversation>(await response.Content.ReadAsStringAsync());
      if (created == null || created.Id <= 0) {
        logger.LogError("Conversation create returned no id");
        return false;
      }

      conversationId = created.Id;
      SaveStorage.Instance.SetValue(conversationSaveKey, conversationId);
      logger.Log($"Created server conversation #{conversationId}");
      return true;
    } catch (Exception ex) {
      logger.LogError($"Failed to create conversation: {ex.Message}");
      return false;
    }
  }

  private async Task<bool> ConversationExists(int id) {
    try {
      using var response = await session.SendAuthenticated(() => session.Client.GetAsync($"api/conversations.php?action=messages&id={id}"));
      return response.IsSuccessStatusCode;
    } catch (Exception) {
      return false;
    }
  }

  private async Task PullServerHistory() {
    try {
      using var response = await session.SendAuthenticated(() => session.Client.GetAsync($"api/conversations.php?action=messages&id={conversationId}"));
      if (!response.IsSuccessStatusCode) {
        logger.LogWarning($"History pull failed: {response.StatusCode}");
        return;
      }

      var rows = JsonSerializer.Deserialize<List<ChatMessage>>(await response.Content.ReadAsStringAsync());
      if (rows == null) {
        return;
      }

      messages.Clear();
      foreach (var row in rows) {
        if (row?.Content != null && (row.Role == "user" || row.Role == "assistant")) {
          messages.Add(new ChatMessage { Role = row.Role, Content = row.Content });
        }
      }
      logger.Log($"Restored {messages.Count} messages from server conversation #{conversationId}");
    } catch (Exception ex) {
      logger.LogWarning($"History pull failed: {ex.Message}");
    }
  }

  // drains the queue and closes the absence, so only call it when she can say it right away
  public async Task<Welcome> FetchWelcome(int hour) {
    try {
      using var response = await session.SendAuthenticated(() => session.Client.GetAsync($"api/consolidate.php?action=welcome&hour={hour}"));
      if (!response.IsSuccessStatusCode) {
        logger.LogWarning($"Welcome fetch failed: {response.StatusCode}");
        return null;
      }
      var welcome = JsonSerializer.Deserialize<Welcome>(await response.Content.ReadAsStringAsync());
      return welcome?.Show == true ? welcome : null;
    } catch (Exception ex) {
      logger.LogWarning($"Welcome fetch failed: {ex.Message}");
      return null;
    }
  }

  private static string NormalizeReasoning(string value) {
    return (value ?? "auto").ToLowerInvariant() switch {
      "low" => "low",
      "medium" => "medium",
      "high" => "high",
      _ => "auto",
    };
  }

  private class ChatMessage {
    [JsonPropertyName("role")]
    public string Role { get; set; }

    [JsonPropertyName("content")]
    public string Content { get; set; }
  }

  private class ChatEvent {
    [JsonPropertyName("token")]
    public string Token { get; set; }

    [JsonPropertyName("error")]
    public string Error { get; set; }
  }

  public class Welcome {
    [JsonPropertyName("show")]
    public bool Show { get; set; }

    [JsonPropertyName("tier")]
    public string Tier { get; set; }

    [JsonPropertyName("live")]
    public List<string> Live { get; set; }

    [JsonPropertyName("milestones")]
    public List<Milestone> Milestones { get; set; }
  }

  public class Milestone {
    [JsonPropertyName("items")]
    public List<MilestoneItem> Items { get; set; }
  }

  public class MilestoneItem {
    [JsonPropertyName("kind")]
    public string Kind { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; }
  }

  private class CreatedConversation {
    [JsonPropertyName("id")]
    public int Id { get; set; }
  }
}
