using System;
using System.Threading.Tasks;
using UnityEngine;
using Il2Cpp;
using JunBridge.Utils;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.Chat;

// when she talks first. cue names match CHAT_IDLE_CUES in api/lib/chat/request.php
public static class Initiative {
  public const string Outing = "outing";
  public const string Intimacy = "intimacy";
  public const string Morning = "morning";

  private enum WelcomeStep { NotYet, Asking, Done }

  private static readonly Logger logger = new("Initiative");

  private static string pendingCue;
  private static WelcomeStep welcome = WelcomeStep.NotYet;
  private static double idleSince;
  private static double lastSpokeAt = double.NegativeInfinity;
  private static Vector3 lastMouse;
  private static string lastBlockedBy = "";

  public static void Mark(string cue) => pendingCue = cue;

  private static double Now => Environment.TickCount64 / 1000.0;

  public static void Update() {
    var now = Now;
    var mouse = Input.mousePosition;
    var blockedBy = BlockedBy();
    if (blockedBy != lastBlockedBy) {
      logger.Log(blockedBy == null ? "she can talk first now" : $"she won't talk first: {blockedBy}");
      lastBlockedBy = blockedBy;
    }
    var canSpeak = blockedBy == null;
    if (Input.anyKey || mouse != lastMouse || Input.mouseScrollDelta != Vector2.zero || !canSpeak) {
      idleSince = now;
    }
    lastMouse = mouse;

    if (!canSpeak || welcome == WelcomeStep.Asking) {
      return;
    }
    if (welcome == WelcomeStep.NotYet) {
      welcome = WelcomeStep.Asking;
      _ = AskWelcome();
      return;
    }

    if (pendingCue != null) {
      var cue = pendingCue;
      pendingCue = null;
      lastSpokeAt = now;
      logger.Log($"she talks first: {cue}");
      ChatManager.Instance.StartInitiative(cue, false);
      return;
    }

    if (now - idleSince >= ModConfig.IdleSeconds && now - lastSpokeAt >= ModConfig.CooldownSeconds) {
      lastSpokeAt = now;
      idleSince = now;
      logger.Log("she talks first: idle");
      ChatManager.Instance.StartInitiative(null, true);
    }
  }

  private static async Task AskWelcome() {
    try {
      if (await ChatManager.Instance.TryWelcome()) {
        lastSpokeAt = Now;
        logger.Log("she talks first: welcome back");
      }
    } finally {
      welcome = WelcomeStep.Done;
    }
  }

  // null = she can speak. logged once per change, the gate failing says nothing otherwise
  private static string BlockedBy() {
    if (!ModConfig.InitiativeEnabled) return "turned off in [Initiative]";
    if (ChatManager.Instance.IsChatActive) return "a chat is running";
    if (!Utils.GameState.IsWithHer()) return $"not with her ({GameScript.Instance?.GameState?.GetIl2CppType()?.Name ?? "no state"})";
    if (GameScript.Instance?.GameVariables?.IsBotSmart != true) return "she isn't smart in this save";
    var ui = UIManager.Instance;
    var popups = ui?.currentlyOpenPopups;
    if (popups != null) {
      var open = 0;
      foreach (var popup in popups) {
        if (!ui.staticPopups.Contains(popup)) open++;
      }
      if (open > 0) return $"{open} popup(s) open";
    }
    // she isn't always in the room view (out, at work)
    if (Live2DControllerSingleton.Instance?.GetReadyController("bot") == null) return "her model isn't ready";
    return null;
  }
}
