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
  public const string OutingWork = "outing_work";
  public const string OutingTogether = "outing_together";
  public const string Intimacy = "intimacy";
  public const string Morning = "morning";
  public const string Played = "played";
  public const string Touched = "touched";

  // kisses and the rest have no game line to stand in for, so she waits for his hands to stop
  private const double touchSettleSeconds = 4;
  private const double touchStaleSeconds = 20;
  private const double touchGapSeconds = 30;
  // floor between two game-line takeovers, in case the brain retries a line it got false for
  private const double touchLineGapSeconds = 10;

  private enum WelcomeStep { NotYet, Asking, Done }

  private static readonly Logger logger = new("Initiative");

  private static string pendingCue;
  private static int pendingAwayMinutes;
  private static int lastWithHerAt = -1;
  private static int workedDayWhenLeft;
  private static double touchedAt = double.NegativeInfinity;
  private static double gamesCheckedAt;
  private static WelcomeStep welcome = WelcomeStep.NotYet;
  private static double idleSince;
  private static double lastSpokeAt = double.NegativeInfinity;
  private static Vector3 lastMouse;
  private static string lastBlockedBy = "";

  public static void Mark(string cue) {
    pendingCue = cue;
    pendingAwayMinutes = 0;
  }

  public static void OnLoad() {
    Mark(null);
    lastWithHerAt = -1;
    Games.Reset();
    Chat.Outing.Clear();
  }

  // lastOutsideWithBotAt only moves when she came along, going out or coming back, both past the last room minute
  public static void CameHome() {
    var vars = GameScript.Instance?.GameVariables;
    if (vars == null || lastWithHerAt < 0) {
      Mark(Outing);
      return;
    }
    // a door the game turned you back at (cum on her, can't go out) is no trip
    if (vars.time - lastWithHerAt < 15) {
      Mark(null);
      return;
    }
    Mark(vars.lastOutsideWithBotAt >= lastWithHerAt ? OutingTogether
      : vars.lastWorkedAtDay != workedDayWhenLeft ? OutingWork : Outing);
    pendingAwayMinutes = vars.time - lastWithHerAt;
  }

  public static void NoteTouch() => touchedAt = Now;

  // the game is about to say its own touch line. true = hers goes instead
  public static bool TakeTouchLine() {
    if (!JunApi.JunHealth.Up || welcome != WelcomeStep.Done) return false;
    if (ChatManager.Instance.IsChatActive || Now - lastSpokeAt < touchLineGapSeconds) return true;
    if (BlockedBy() != null) return false;
    React(Now);
    return true;
  }

  private static void React(double now) {
    lastSpokeAt = now;
    logger.Log("she reacts to a touch");
    ChatManager.Instance.StartReaction();
  }

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
    var vars = GameScript.Instance?.GameVariables;
    if (vars != null && Utils.GameState.IsWithHer()) {
      lastWithHerAt = vars.time;
      workedDayWhenLeft = vars.lastWorkedAtDay;
      JunApi.JunHealth.Tick(now);
    }
    // chess and word chain are story scenes, no game state says a game ended. the counters do
    if (vars != null && pendingCue == null && now - gamesCheckedAt >= 1) {
      gamesCheckedAt = now;
      if (Games.HasNew(vars)) {
        Mark(Played);
      }
    }
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

    // a chat he opened first already carried the game, nothing left to bring up
    if (pendingCue == Played && vars != null && !Games.HasNew(vars)) {
      Mark(null);
    }
    if (pendingCue != null) {
      var cue = pendingCue;
      var away = pendingAwayMinutes;
      Mark(null);
      lastSpokeAt = now;
      logger.Log($"she talks first: {cue}");
      ChatManager.Instance.StartInitiative(cue, false, away);
      return;
    }

    var sinceTouch = now - touchedAt;
    if (touchedAt > lastSpokeAt && sinceTouch >= touchSettleSeconds && sinceTouch < touchStaleSeconds
        && now - lastSpokeAt >= touchGapSeconds && JunApi.JunHealth.Up) {
      React(now);
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
