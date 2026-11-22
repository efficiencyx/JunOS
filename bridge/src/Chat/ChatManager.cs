using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;
using MelonLoader;
using Il2Cpp;
using Il2CppInterop.Runtime.Attributes;
using JunBridge.Utils;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.Chat;

[MonoSingleton]
[RegisterTypeInIl2Cpp]
public class ChatManager : MonoBehaviour {
  public static ChatManager Instance => MonoSingletonManager.Get<ChatManager>();

  public bool IsChatActive { get; private set; } = false;
  private bool isInConversation = false;

  private readonly JunApi.JunChat junChat;
  private readonly ChatParser parser;
  private readonly ChatWriter writer;
  private readonly Action<string> processUserInput;

  private InputPopup chatPopup;
  private static readonly Logger logger = new("ChatManager");

  private string chatTitle = "Say something to the bot";
  // Command hints and the paste button are stripped in ConfigureChatPopup, and OK is replaced by
  // Send + Close, so the body text is left empty.
  private readonly string chatDescription = "";

  public ChatManager() : base() {
    junChat = new JunApi.JunChat();
    writer = ChatWriter.Instance;
    parser = new ChatParser(writer);
    processUserInput = new(ProcessUserInput);
  }

  public void Awake() {
    this.ValidateSingleton();
  }

  public void StartChat() {
    Begin(null);
  }

  public void StartInitiative(string cue, bool mutter, int awayMinutes = 0) {
    Begin(game => junChat.SendCue(cue, mutter, game, awayMinutes));
  }

  // no chat box after this one, he's still mid-headpat
  public void StartReaction() {
    Begin(game => junChat.SendCue(Initiative.Touched, true, game), openChat: false);
  }

  // false = nothing to say or JunOS isn't there, and nothing was drained
  [HideFromIl2Cpp]
  public async Task<bool> TryWelcome() {
    var game = GameContext.Capture();
    if (await JunApi.JunSession.Instance.Check() != JunApi.JunSession.State.SignedIn) {
      return false;
    }
    var welcome = await junChat.FetchWelcome(game.Hour);
    if (welcome == null) {
      return false;
    }

    var names = new JunApi.JunActionTranslator(game.PlayerName, game.BotName);
    string Resolve(string text) => names.Process(text) + names.Flush();
    var spoken = Resolve(string.Join(" ", welcome.Live ?? []));
    if (spoken == "") {
      return false;
    }

    var face = welcomeFaces.TryGetValue(welcome.Tier ?? "", out var expression) ? $"#!bot.Expression.{expression} " : "";
    await MainThreadRunner.Run(() => Begin(_ => Canned(face + spoken), () => junChat.Remember(spoken)));
    return true;
  }

  public void StopChat() {
    writer.Stop();
    Tts.TtsManager.Instance.StopAll();

    IsChatActive = false;
    isInConversation = false;
  }

  [HideFromIl2Cpp]
  private void Begin(Func<GameContext, IAsyncEnumerable<string>> opening, Action afterOpening = null, bool openChat = true) {
    if (IsChatActive) {
      return;
    }
    IsChatActive = true;
    MelonCoroutines.Start(ChatLoop(opening, afterOpening, openChat));
  }

  private static readonly Dictionary<string, string> welcomeFaces = new() {
    ["none"] = "Happy",
    ["missed"] = "Happy",
    ["ached"] = "Sad",
    ["panicked"] = "VeryShock",
    ["unravelled"] = "VerySad",
    ["hollow"] = "Sad",
  };

  [HideFromIl2Cpp]
  private static async IAsyncEnumerable<string> Canned(string text) {
    await Task.CompletedTask;
    yield return text;
  }

  private static void EnterStoryState() {
    var gameScript = GameScript.Instance;
    var live2DController = Live2DControllerSingleton.Instance;
    var currentController = live2DController.GetReadyController("bot");
    var currentBrain = currentController.CurrentBrain;

    currentController.PrepareForDialogue();
    gameScript.ChangeToStoryState();
    currentBrain.EnableBrain();
    currentBrain.ChangeState(new StoryBrainState());
    currentController.SetEnabled(true);
  }

  private static void ExitStoryState(bool zoomedIn) {
    InteractState.OnStoryStateFinished(zoomedIn);
  }

  [HideFromIl2Cpp]
  private IEnumerator ChatLoop(Func<GameContext, IAsyncEnumerable<string>> opening, Action afterOpening, bool openChat) {
    ExpressionLinger.Cancel();

    // an unprompted line waits for its first words before the story state starts,
    // a dead model or a sign-in box must not cost him the room
    ReplyStream openingStream = null;
    if (opening != null) {
      var signedIn = JunApi.JunSession.Instance.Check();
      while (!signedIn.IsCompleted) {
        yield return null;
      }
      var ready = signedIn.Result == JunApi.JunSession.State.SignedIn ? junChat.EnsureReady() : Task.FromResult(false);
      while (!ready.IsCompleted) {
        yield return null;
      }
      if (ready.Result) {
        openingStream = new ReplyStream(opening(GameContext.Capture()));
        while (openingStream.Chunks.IsEmpty && !openingStream.Done.IsCompleted) {
          yield return null;
        }
      }
      if (openingStream == null || openingStream.Chunks.IsEmpty || !Utils.GameState.IsWithHer()) {
        if (openingStream?.Done.Exception != null) {
          logger.LogWarning($"She kept quiet: {openingStream.Done.Exception.InnerException?.Message}");
        }
        IsChatActive = false;
        yield break;
      }
    }

    var uiOverlay = UiOverlay.Instance;
    var gameScript = GameScript.Instance;
    var gameVariables = gameScript.GameVariables;

    var interactState = gameScript.GameState?.TryCast<InteractState>();
    var wasZoomedIn = interactState != null && interactState._isZoomedIn;
    var wasInRoom = gameScript.GameState?.TryCast<GameScript.RoomState>() != null;
    var cuddle = CuddleReturn.Capture(gameScript);

    EnterStoryState();

    if (openingStream == null) {
      // still opens when this fails, the send then shows the error in her box
      var preflightTask = junChat.EnsureReady();
      while (!preflightTask.IsCompleted) {
        yield return null;
      }
    } else {
      var speaking = SpeakReply(openingStream);
      while (!speaking.IsCompleted) {
        yield return null;
      }
      afterOpening?.Invoke();
      if (!openChat || Outing.IsQueued) {
        IsChatActive = false;
      }
    }

    while (IsChatActive) {
      isInConversation = true;
      chatTitle = $"Say something to {gameVariables.botName}";

      // Show the input popup, then strip the paste button / commands text and swap OK for Send + Close.
      var popup = uiOverlay.InputPopup(chatTitle, chatDescription, processUserInput);
      ConfigureChatPopup(popup);

      while (isInConversation) {
        // Wait for bot to finish speaking
        yield return null;
      }
    }

    if (wasInRoom) {
      gameScript.ChangeToRoomState();
    } else if (!CuddleReturn.TryRestore(cuddle)) {
      ExitStoryState(wasZoomedIn);
    }
    ExpressionLinger.Begin();
    if (Outing.IsQueued) {
      yield return null;
      Outing.StartIfQueued();
    }
  }

  private static bool ValidateUserInput(string userInput) {
    return userInput.Trim() != "";
  }

  private async void ProcessUserInput(string userInput) {
    try {
      // The actual logic is moved to a separate method so that
      // the code in the finally block is executed anyway
      await ProcessUserInputInternal(userInput);
    } finally {
      // Add a small delay so the window has time to close
      await Task.Delay(500);
      isInConversation = false;
    }
  }

  [HideFromIl2Cpp]
  private async Task ProcessUserInputInternal(string userInput) {
    if (userInput.StartsWith("/")) {
      switch (userInput.ToLower()) {
        case "/exit":
          StopChat();
          return;
        case "/reset":
          junChat.Reset();
          return;
        case "/clear":
          ChatExecutor.ResetBotEmotes();
          return;
      }
    }

    if (!ValidateUserInput(userInput)) {
      return;
    }

    // fetching starts now and runs while he reads and clicks his own echo, that hides the model's latency
    var stream = new ReplyStream(junChat.SendMessage(userInput, GameContext.Capture()));
    await SayPlayerLine(userInput);
    await SpeakReply(stream);
    // she said yes to going out, the box doesn't come back and the door opens
    if (Outing.IsQueued) {
      IsChatActive = false;
    }
  }

  [HideFromIl2Cpp]
  private async Task SpeakReply(ReplyStream stream) {
    var tts = Tts.TtsManager.Instance;
    bool prepared = false;

    tts.BeginUtterance();
    try {
      await parser.Prepare();
      prepared = true;

      while (!stream.Done.IsCompleted || !stream.Chunks.IsEmpty) {
        if (stream.Chunks.TryDequeue(out var chunk)) {
          await parser.Parse(chunk);
        } else {
          await Task.Delay(10);
        }
      }

      if (stream.Done.IsFaulted) {
        throw stream.Done.Exception.InnerException ?? stream.Done.Exception;
      }

      // Speak the trailing partial sentence before waiting for the user's click
      tts.CompleteUtterance();
      await parser.Flush();
    } catch (Exception ex) {
      logger.LogError($"Error during AI response: {ex.Message}");
      tts.CompleteUtterance();

      if (prepared) {
        // Flush writes any partial text to the dialog and unlocks the Writer.
        // Without this the Writer stays locked and the game softlocks.
        try { await parser.Flush(); } catch { /* best effort */ }
      }
    }
  }

  private sealed class ReplyStream {
    public readonly ConcurrentQueue<string> Chunks = new();
    public readonly Task Done;

    public ReplyStream(IAsyncEnumerable<string> source) {
      Done = Task.Run(async () => {
        await foreach (var chunk in source) {
          Chunks.Enqueue(chunk);
        }
      });
    }
  }

  [HideFromIl2Cpp]
  private void ConfigureChatPopup(InputPopup popup) {
    if (popup == null) {
      return;
    }
    chatPopup = popup;
    try {
      // Re-open the popup through the game's own choice path so the buttons keep their built-in
      // close-on-click behavior (ButtonList.InitializeFromPopupChoices did NOT, which softlocked
      // the modal). PopupStringChoice.Action receives the typed text. Empty body drops the
      // commands box.
      var choices = new Il2CppSystem.Collections.Generic.List<PopupStringChoice>();
      var send = new PopupStringChoice { Text = "Send", Action = new Action<string>(t => ProcessUserInput(t ?? "")) };
      var close = new PopupStringChoice { Text = "Close", Action = new Action<string>(_ => CloseFromPopup()) };
      choices.Add(send);
      choices.Add(close);
      popup.Open(choices, chatTitle, "", "", Il2CppTMPro.TMP_InputField.ContentType.Standard);

      // Every Open pushes the popup onto UIManager.currentlyOpenPopups (no duplicate check),
      // so this second Open leaves the same popup on the stack twice. SyncAllPopups walks the
      // stack top-down and only the first entry keeps its CanvasGroup interactable; the
      // duplicate entry immediately switches the same popup back to non-interactable, leaving
      // it visible but deaf to clicks and typing. Drop the duplicate and resync.
      var uiManager = UIManager.Instance;
      if (uiManager != null) {
        uiManager.currentlyOpenPopups.Remove(popup);
        uiManager.SyncAllPopups();
      }

      // Remove the "Paste from clipboard" button and the now-empty commands text box.
      if (popup.pasteFromClipboardButton != null) {
        popup.pasteFromClipboardButton.gameObject.SetActive(false);
      }
      if (popup.textTmp != null) {
        popup.textTmp.gameObject.SetActive(false);
      }
    } catch (Exception ex) {
      logger.LogError($"Failed to configure chat popup: {ex.Message}");
    }
  }

  // Closes the chat entirely (the "Close" button). The native choice already dismisses the popup;
  // if it is somehow still alive, close it through the game's own path so it is also removed
  // from UIManager.currentlyOpenPopups (a raw Destroy would leave a stale stack entry that
  // breaks every popup opened afterwards).
  private void CloseFromPopup() {
    try {
      if (chatPopup != null) {
        chatPopup.CloseFromUIOverlay();
      }
      StopChat();
    } catch (Exception ex) {
      logger.LogError($"Failed to close chat: {ex.Message}");
    }
  }

  [HideFromIl2Cpp]
  private async Task SayPlayerLine(string text) {
    var tcs = new TaskCompletionSource();

    Action<Il2CppFungus.SayDialog> handler = null;
    handler = new Action<Il2CppFungus.SayDialog>(dialog => {
      Il2CppFungus.SayDialogSignals.OnDialogFinished -= handler;
      tcs.TrySetResult();
    });
    Il2CppFungus.SayDialogSignals.OnDialogFinished += handler;

    await MainThreadRunner.Run(() => {
      var say = Il2CppFungus.SayDialog.GetSayDialog();
      if (say != null) {
        var speaker = ConversationSingleton.Instance.GetCharacter("You");
        if (speaker != null) {
          say.SetCharacter(speaker);
        }
      }
      ChatWriter.Instance.StartCoroutine(
        BetterConversationManager.DoConversation($"You: {text}")
      );
    });

    // Wait until the user clicks and the player's dialog finishes typing/advancing
    await tcs.Task;
  }
}
