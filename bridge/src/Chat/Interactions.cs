using System;
using System.Collections.Generic;
using System.Linq;
using Il2Cpp;

namespace JunBridge.Chat;

// what he did to her in the game since the last chat turn, sent as game_actions
public static class Interactions {
  // ActivateComplex keeps firing while a touch is held, one touch = calls closer than this
  private const double sameTouchSeconds = 4;

  private static readonly Dictionary<InteractionMemoryEnum, string> touches = new() {
    [InteractionMemoryEnum.Headpat] = "Anon patted your head",
    [InteractionMemoryEnum.KissMouth] = "Anon kissed you on the lips",
    [InteractionMemoryEnum.KissBody] = "Anon kissed your body",
    [InteractionMemoryEnum.FaceStroke] = "Anon stroked your face",
    [InteractionMemoryEnum.ThumbMouth] = "Anon put his thumb in your mouth",
    [InteractionMemoryEnum.Handholding] = "Anon held your hand",
    [InteractionMemoryEnum.GrabHead] = "Anon held your head",
    [InteractionMemoryEnum.NipplePull] = "Anon pulled your nipples",
    [InteractionMemoryEnum.BoobsFondle] = "Anon fondled your breasts",
    [InteractionMemoryEnum.AssFondle] = "Anon fondled your butt",
    [InteractionMemoryEnum.AssGrab] = "Anon grabbed your butt",
    [InteractionMemoryEnum.Scrubbing] = "Anon scrubbed you clean",
  };

  private static readonly List<(string Text, int Times)> pending = [];
  private static readonly Dictionary<string, double> lastTouch = [];
  private static IntPtr lastHeld;

  public static void Touched(InteractionMemoryEnum touch) {
    if (touches.TryGetValue(touch, out var text)) {
      Touched(text);
    }
  }

  private static void Touched(string text) {
    Initiative.NoteTouch();
    var now = Environment.TickCount64 / 1000.0;
    lock (pending) {
      var held = lastTouch.TryGetValue(text, out var last) && now - last < sameTouchSeconds;
      lastTouch[text] = now;
      if (!held) {
        Add(text);
      }
    }
  }

  // skirt and panties have no InteractionMemory entry, a chest touch logged none in play. so watch his hand
  public static void Poll() {
    var controller = Utils.GameState.IsWithHer() ? Live2DControllerSingleton.Instance?.GetReadyController("bot") : null;
    ILive2DInteractable held = null;
    if (controller == null || !controller.TryGetHeldInteractable(out held)) {
      held = null;
    }
    var pointer = held?.Pointer ?? IntPtr.Zero;
    if (pointer == lastHeld) {
      return;
    }
    lastHeld = pointer;
    var text = pointer == IntPtr.Zero ? null : Describe(controller.CurrentBrain?.CurrentState?.TryCast<NewInteractBrainState>(), pointer);
    if (text != null) {
      Touched(text);
    }
  }

  private static string Describe(NewInteractBrainState brain, IntPtr held) {
    bool Is(Il2CppInterop.Runtime.InteropTypes.Il2CppObjectBase part) => part != null && part.Pointer == held;
    if (brain == null) return null;
    if (Is(brain._skirtInteractable)) return "Anon lifted your skirt";
    if (Is(brain._pantiesInteractable)) return "Anon pulled your panties aside";
    if (Is(brain._boobL) || Is(brain._boobR) || Is(brain._boobsBoth)) return touches[InteractionMemoryEnum.BoobsFondle];
    return null;
  }

  public static void Dressed(string itemName) {
    if (string.IsNullOrWhiteSpace(itemName)) {
      return;
    }
    lock (pending) {
      Add($"Anon put the {itemName} on you");
    }
  }

  public static List<string> Drain() {
    lock (pending) {
      var lines = pending.Select(p => p.Times > 1 ? $"{p.Text} ({p.Times} times)." : $"{p.Text}.").ToList();
      pending.Clear();
      return lines;
    }
  }

  private static void Add(string text) {
    var i = pending.FindIndex(p => p.Text == text);
    if (i >= 0) {
      pending[i] = (text, pending[i].Times + 1);
    } else if (pending.Count < 20) {
      pending.Add((text, 1));
    }
  }
}
