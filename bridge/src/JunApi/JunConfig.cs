namespace JunBridge.JunApi;

public class JunConfig {
  // e.g. https://your-host (NGINX terminates TLS there).
  // Endpoints: /api/auth.php, /api/chat.php, /api/conversations.php, /api/tts.php
  public string ApiUrl { get; set; }

  // Same account as the web UI
  public string Email { get; set; }
  public string Password { get; set; }

  // 0 = create one on first chat and remember it in the save file
  public int ConversationId { get; set; }

  // Empty = let the server pick its default
  public string Model { get; set; }

  // Forwarded to chat.php: Auto, Low, Medium or High
  public string Reasoning { get; set; }

  public int TimeoutSeconds { get; set; }
}
