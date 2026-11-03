using System;
using System.Threading.Tasks;
using JunBridge.Utils;
using UnityEngine;
using UnityEngine.EventSystems;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.JunApi;

public static class LoginPrompt {
  private const float PanelWidth = 560f;
  private const float PanelHeight = 430f;
  private const float Pad = 28f;

  private static readonly Logger logger = new("LoginPrompt");
  private static readonly object gate = new();
  private static TaskCompletionSource<bool> pending;
  private static bool menuReady;
  private static bool expired;
  private static bool busy;
  private static bool focusSet;
  private static string email = "";
  private static string password = "";
  private static string error;
  private static EventSystem blockedEvents;
  private static Styles styles;

  public static Task<bool> Ask(bool sessionExpired) {
    lock (gate) {
      if (pending == null) {
        pending = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        expired = sessionExpired;
        email = ModConfig.GetJunConfig().Email ?? "";
        password = "";
        error = null;
        focusSet = false;
      }
      return pending.Task;
    }
  }

  public static void MainMenuReady() => menuReady = true;

  private static bool Visible => pending != null && menuReady;

  public static void Update() {
    if (Visible) {
      BlockGameInput();
    } else {
      ReleaseGameInput();
    }
  }

  public static void Draw() {
    if (!Visible) {
      return;
    }
    try {
      styles ??= new Styles();
      DrawWindow();
    } catch (Exception ex) {
      logger.LogError($"couldn't draw JunOS sign-in: {ex.Message}");
      Finish(false);
    }
  }

  private static void DrawWindow() {
    float scale = Mathf.Max(1f, Screen.height / 1080f);
    var saved = GUI.matrix;
    GUI.matrix = Matrix4x4.TRS(Vector3.zero, Quaternion.identity, new Vector3(scale, scale, 1f));
    float w = Screen.width / scale, h = Screen.height / scale;

    GUI.Box(new Rect(0, 0, w, h), GUIContent.none, styles.Shade);
    var panel = new Rect((w - PanelWidth) / 2, (h - PanelHeight) / 2, PanelWidth, PanelHeight);
    GUI.Box(panel, GUIContent.none, styles.Panel);

    float x = panel.x + Pad, y = panel.y + Pad, inner = PanelWidth - Pad * 2;
    GUI.Label(new Rect(x, y, inner, 34), expired ? "Sign in to Jun OS again" : "Sign in to Jun OS", styles.Title);
    y += 44;
    string intro = expired
      ? "Your Jun OS session ran out. They last 30 days, and changing the password ends them early."
      : "This links the game to Jun OS, so she knows what happened here and can talk in the game.";
    GUI.Label(new Rect(x, y, inner, 44), intro, styles.Body);
    y += 50;
    GUI.Label(new Rect(x, y, inner, 44), "Use the email and password of your Jun OS account, the one you sign in with in the browser. Jun OS has to be running.", styles.Hint);
    y += 58;

    bool submit = Event.current.type == EventType.KeyDown
      && (Event.current.keyCode == KeyCode.Return || Event.current.keyCode == KeyCode.KeypadEnter);
    bool dismiss = Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.Escape;

    GUI.enabled = !busy;
    GUI.Label(new Rect(x, y, inner, 22), "Email", styles.Field);
    GUI.SetNextControlName("junos-email");
    email = GUI.TextField(new Rect(x, y + 24, inner, 34), email, 254, styles.Input);
    y += 70;
    GUI.Label(new Rect(x, y, inner, 22), "Password", styles.Field);
    GUI.SetNextControlName("junos-password");
    password = GUI.PasswordField(new Rect(x, y + 24, inner, 34), password, '*', 1024, styles.Input);
    y += 70;
    if (!focusSet) {
      GUI.FocusControl(email.Length > 0 ? "junos-password" : "junos-email");
      focusSet = true;
    }

    if (busy) {
      GUI.Label(new Rect(x, y, inner, 22), "Signing in...", styles.Hint);
    } else if (error != null) {
      GUI.Label(new Rect(x, y, inner, 22), error, styles.Error);
    } else {
      GUI.Label(new Rect(x, y, inner, 22), "F8 opens this again later. Only the session is kept, never the password.", styles.Hint);
    }

    float by = panel.yMax - Pad - 38;
    if (GUI.Button(new Rect(panel.xMax - Pad - 140, by, 140, 38), "Sign in", styles.Primary)) {
      submit = true;
    }
    if (GUI.Button(new Rect(panel.xMax - Pad - 140 - 12 - 110, by, 110, 38), "Not now", styles.Secondary)) {
      dismiss = true;
    }
    GUI.enabled = true;
    GUI.matrix = saved;

    if (busy) {
      return;
    }
    if (submit) {
      Event.current.Use();
      TrySubmit();
    } else if (dismiss) {
      Event.current.Use();
      Finish(false);
    }
  }

  private static void TrySubmit() {
    email = email.Trim();
    if (email.Length == 0) {
      error = "Enter your Jun OS email.";
      return;
    }
    if (password.Length == 0) {
      error = "Enter your Jun OS password.";
      GUI.FocusControl("junos-password");
      return;
    }
    busy = true;
    error = null;
    string typed = password;
    password = "";
    Submit(typed);
  }

  private static async void Submit(string typed) {
    string failure;
    try {
      failure = await JunSession.Instance.Login(email, typed);
    } catch (Exception ex) {
      logger.LogError($"sign-in failed: {ex.Message}");
      failure = "Couldn't sign in. Try again.";
    }
    await MainThreadRunner.Run(() => {
      busy = false;
      if (failure == null) {
        Finish(true);
      } else {
        error = failure;
        focusSet = false;
      }
    });
  }

  // the menu's uGUI buttons still take clicks under an IMGUI window
  private static void BlockGameInput() {
    var current = EventSystem.current;
    if (current != null && current.enabled) {
      blockedEvents = current;
      current.enabled = false;
    }
  }

  private static void ReleaseGameInput() {
    if (blockedEvents != null) {
      blockedEvents.enabled = true;
      blockedEvents = null;
    }
  }

  private static void Finish(bool ok) {
    TaskCompletionSource<bool> done;
    lock (gate) {
      done = pending;
      pending = null;
      password = "";
      error = null;
      busy = false;
    }
    ReleaseGameInput();
    done?.TrySetResult(ok);
  }

  private sealed class Styles {
    public readonly GUIStyle Shade, Panel, Title, Body, Hint, Field, Error, Input, Primary, Secondary;

    public Styles() {
      var text = new Color(0.95f, 0.96f, 0.97f);
      var muted = new Color(0.68f, 0.71f, 0.76f);

      Shade = Flat(new Color(0f, 0f, 0f, 0.6f));
      Panel = Flat(new Color(0.09f, 0.10f, 0.13f, 0.98f));
      Title = Label(26, text, FontStyle.Bold);
      Body = Label(17, text, FontStyle.Normal);
      Hint = Label(15, muted, FontStyle.Normal);
      Field = Label(15, muted, FontStyle.Bold);
      Error = Label(15, new Color(1f, 0.55f, 0.5f), FontStyle.Normal);

      Input = new GUIStyle(GUI.skin.textField) { fontSize = 18, padding = new RectOffset(10, 10, 7, 7) };
      Input.normal.background = Tex(new Color(0.14f, 0.15f, 0.19f));
      Input.focused.background = Tex(new Color(0.18f, 0.20f, 0.25f));
      Input.hover.background = Input.normal.background;
      Input.normal.textColor = Input.focused.textColor = Input.hover.textColor = text;

      Primary = Button(new Color(0.0f, 0.47f, 0.83f), new Color(0.09f, 0.55f, 0.88f), text);
      Secondary = Button(new Color(0.16f, 0.18f, 0.22f), new Color(0.22f, 0.24f, 0.29f), text);
    }

    private static GUIStyle Label(int size, Color color, FontStyle weight) {
      var style = new GUIStyle(GUI.skin.label) { fontSize = size, fontStyle = weight, wordWrap = true };
      style.normal.textColor = color;
      return style;
    }

    private static GUIStyle Button(Color fill, Color hover, Color text) {
      var style = new GUIStyle(GUI.skin.button) { fontSize = 17, fontStyle = FontStyle.Bold };
      style.normal.background = Tex(fill);
      style.hover.background = style.active.background = Tex(hover);
      style.normal.textColor = style.hover.textColor = style.active.textColor = text;
      return style;
    }

    private static GUIStyle Flat(Color color) {
      var style = new GUIStyle();
      style.normal.background = Tex(color);
      return style;
    }

    // HideAndDontSave or a scene change unloads them and the window goes see-through
    private static Texture2D Tex(Color color) {
      var tex = new Texture2D(1, 1) { hideFlags = HideFlags.HideAndDontSave };
      tex.SetPixel(0, 0, color);
      tex.Apply();
      return tex;
    }
  }
}
