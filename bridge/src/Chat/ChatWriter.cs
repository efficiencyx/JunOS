using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using MelonLoader;
using UnityEngine;
using Il2Cpp;
using Il2CppInterop.Runtime.Attributes;
using JunBridge.Utils;

namespace JunBridge.Chat;

[MonoSingleton]
[RegisterTypeInIl2Cpp]
public class ChatWriter : MonoBehaviour {
  public static ChatWriter Instance => MonoSingletonManager.Get<ChatWriter>();
  public static EventBus EventBus { get; private set; } = new();

  private bool isReady = false;
  private bool isFlushing = false;
  private bool isPaused = false;
  private bool isWaitingForCallback = false;

  private Il2CppFungus.SayDialog sayDialog;
  private readonly StringBuilder textBuffer = new(1024);
  private float nextCharacterTime = 0f;
  private int visibleCharactersCount = 0;
  private int textEnd = 0; // Position (not index) of the last character to be printed

  private bool needUpdateText = false;
  private bool needUpdateVisibleCharacters = false;

  private readonly Action<Il2CppFungus.SayDialog> onDialogFinished;
  private readonly Action<Il2CppFungus.Writer, Il2CppFungus.WriterState> onWriterState;

  private readonly Queue<(int Position, Func<Task> Callback)> pendingCallbacks = new();
  private (int Position, Func<Task> Callback)? nextCallback;

  public ChatWriter() : base() {
    onDialogFinished = new(OnDialogFinished);
    onWriterState = new(OnWriterState);
  }

  public void Awake() {
    this.ValidateSingleton();
  }

  public void Start() {
    Il2CppFungus.SayDialogSignals.OnDialogFinished += onDialogFinished;
    Il2CppFungus.WriterSignals.OnWriterState += onWriterState;
  }

  public void OnDestroy() {
    Il2CppFungus.SayDialogSignals.OnDialogFinished -= onDialogFinished;
    Il2CppFungus.WriterSignals.OnWriterState -= onWriterState;
  }

  public void Update() {
    if (needUpdateText) {
      needUpdateText = false;

      sayDialog.writer.targetTextTMP.text = textBuffer.ToString().Trim();
    }

    if (needUpdateVisibleCharacters) {
      needUpdateVisibleCharacters = false;

      sayDialog.writer.targetTextTMP.maxVisibleCharacters = visibleCharactersCount;
      sayDialog.writer.visibleCharacterCount = visibleCharactersCount;

      if (visibleCharactersCount > 0) {
        var lastCharacter = textBuffer[textEnd - 1];
        sayDialog.writer.NotifyGlyph(lastCharacter);
      }
    }

    if (isFlushing && IsAllTextPrinted()) {
      isFlushing = false;
      EventBus.Fire("text-flushed");
      return;
    }

    if (isReady && !isPaused && !isWaitingForCallback) {
      var writingSpeed = sayDialog.writer.writingSpeed;
      var invWritingSpeed = 1f / writingSpeed;

      while (Time.time >= nextCharacterTime && !IsAllTextPrinted() && !isWaitingForCallback) {
        MelonCoroutines.Start(RevealNextCharacter());
        nextCharacterTime = Time.time + invWritingSpeed;
      }
    }
  }

  [HideFromIl2Cpp]
  public async Task Prepare() {
    ResetState();

    // Set traps for those events so we don't miss any
    EventBus.Capture("say-dialog-changed");
    EventBus.Capture("ready-to-start");

    await MainThreadRunner.Run(() => {
      StartCoroutine(BetterConversationManager.DoConversation("Bot: {s=1000}...{/s}"));
    });

    sayDialog = await EventBus.WaitFor<Il2CppFungus.SayDialog>("say-dialog-changed");
    Locker<Il2CppFungus.Writer>.Lock(sayDialog.writer);

    // Wait for {wi} tag to be reached
    await EventBus.WaitFor("ready-to-start");
    isReady = true;
  }

  public void Type(string symbols) {
    if (!isReady) {
      // The writer is not ready. This could mean either that
      // the user did not call Prepare(), or that
      // some command aborted execution before all Type() were called.
      return;
    }

    if (textBuffer.Length == 0) {
      // During the first call, we need to synchronize visible characters,
      // to hide all characters and avoid flickering
      SyncVisibleCharacters();
    }

    textBuffer.Append(symbols);
    SyncTmpText();
  }

  [HideFromIl2Cpp]
  public async Task AddCallback(Func<Task> callback) {
    var position = textBuffer.Length;

    if (textEnd >= position) {
      // If text is already printed beyond the callback position, execute it immediately
      Pause();
      await callback();
      Resume();
      return;
    }

    pendingCallbacks.Enqueue((position, callback));
  }

  [HideFromIl2Cpp]
  public async Task Flush() {
    try {
      isFlushing = true;

      if (!IsAllTextPrinted()) {
        await EventBus.WaitFor("text-flushed");
      }

      // Execute remaining callbacks if any
      await ExecuteCallbacks();

      if (sayDialog?.writer != null) {
        Locker<Il2CppFungus.Writer>.Unlock(sayDialog.writer);
      }

      await EventBus.WaitFor("dialog-finished");
    } finally {
      ResetState();
    }
  }

  public void Pause() {
    isPaused = true;
  }

  public void Resume() {
    isPaused = false;
  }

  public void Stop() {
    sayDialog?.Stop();
    ResetState();
  }

  [HideFromIl2Cpp]
  private IEnumerator RevealNextCharacter() {
    if (!IsAllTextPrinted()) {
      IncrementPositionCounters();
      SyncVisibleCharacters();
      yield return ExecuteCallbacksCoroutine();
    }
  }

  private void IncrementPositionCounters() {
    visibleCharactersCount++;
    textEnd++;
  }

  private void SyncTmpText() {
    needUpdateText = true;
  }

  private void SyncVisibleCharacters() {
    needUpdateVisibleCharacters = true;
  }

  [HideFromIl2Cpp]
  private async Task ExecuteCallbacks() {
    // Prepare next callback if needed
    if (nextCallback == null && pendingCallbacks.Count > 0) {
      nextCallback = pendingCallbacks.Dequeue();
    }

    while (nextCallback != null && nextCallback?.Position <= textEnd) {
      await nextCallback?.Callback();
      nextCallback = pendingCallbacks.Count > 0 ? pendingCallbacks.Dequeue() : null;
    }
  }

  [HideFromIl2Cpp]
  private IEnumerator ExecuteCallbacksCoroutine() {
    isWaitingForCallback = true;

    try {
      var task = ExecuteCallbacks();
      while (!task.IsCompleted) {
        yield return null;
      }
    } finally {
      isWaitingForCallback = false;
    }
  }

  private bool IsAllTextPrinted() {
    return textEnd >= textBuffer.Length;
  }

  private void OnDialogFinished(Il2CppFungus.SayDialog dialog) {
    if (dialog != null && dialog == sayDialog) {
      EventBus.Fire("dialog-finished");
    }
  }

  private void OnWriterState(Il2CppFungus.Writer writer, Il2CppFungus.WriterState state) {
    if (writer == null || sayDialog == null || writer != sayDialog.writer) {
      return;
    }

    if (state == Il2CppFungus.WriterState.PauseWaitForInput) {
      EventBus.Fire("ready-to-start");
    }
  }

  private void ResetState() {
    isReady = false;
    isFlushing = false;
    isPaused = false;
    isWaitingForCallback = false;

    if (sayDialog?.writer != null) {
      Locker<Il2CppFungus.Writer>.Unlock(sayDialog.writer);
    }

    sayDialog = null;
    textBuffer.Clear();
    nextCharacterTime = 0f;
    visibleCharactersCount = 0;
    textEnd = 0;

    pendingCallbacks.Clear();
    nextCallback = null;

    EventBus.ReleaseCapture("say-dialog-changed");
    EventBus.ReleaseCapture("ready-to-start");
  }
}
