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
  private static readonly Dictionary<InteractionMemoryEnum, double> lastTouch = [];

  public static void Touched(InteractionMemoryEnum touch) {
    if (!touches.TryGetValue(touch, out var text)) {
      return;
    }
    var now = Environment.TickCount64 / 1000.0;
    lock (pending) {
      var held = lastTouch.TryGetValue(touch, out var last) && now - last < sameTouchSeconds;
      lastTouch[touch] = now;
      if (!held) {
        Add(text);
      }
    }
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
