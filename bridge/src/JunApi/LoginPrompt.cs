using System;
using System.Threading.Tasks;
using Il2Cpp;
using Il2CppTMPro;
using JunBridge.Utils;
using UnityEngine;
using Logger = JunBridge.Utils.Logger;

namespace JunBridge.JunApi;

public static class LoginPrompt {
  private static readonly Logger logger = new("LoginPrompt");
  private static readonly object gate = new();
  private static TaskCompletionSource<bool> pending;
  private static InputPopup popup;
  private static bool menuReady;
  private static bool expired;
  private static bool busy;
  private static bool passwordStep;
  private static bool openNext;
  private static string email = "";
  private static string error;

  public static Task<bool> Ask(bool sessionExpired) {
    lock (gate) {
      if (pending == null) {
        pending = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        expired = sessionExpired;
        email = ModConfig.GetJunConfig().Email ?? "";
        passwordStep = false;
        openNext = true;
        error = null;
      }
      return pending.Task;
    }
  }

  public static void MainMenuReady() => menuReady = true;

  // the game's IMGUI is stripped: SetNextControlName never returns and TextField throws, so it's the game's own popup
  public static void Update() {
    if (pending == null || !menuReady) {
      return;
    }
    try {
      if (popup is not null) {
        if (popup != null && UIManager.Instance.currentlyOpenPopups.Contains(popup)) {
          return;
        }
        if (popup != null) {
          popup.inputTmp.text = "";
        }
        popup = null;
        if (!openNext && !busy) {
          Finish(false);
          return;
        }
      }
      if (busy || !openNext || UiOverlay.Instance == null || UIManager.Instance == null) {
        return;
      }
      Open();
    } catch (Exception ex) {
      logger.LogError($"couldn't open JunOS sign-in: {ex.Message}");
      popup?.CloseFromUIOverlay();
      popup = null;
      Finish(false);
    }
  }

  private static void Open() {
    openNext = false;
    string title = passwordStep ? "Jun OS password" : "Jun OS email";
    string description = error ?? (passwordStep
      ? $"Signing in as {email}. Use your Jun OS webapp password."
      : expired ? "Sign in to Jun OS again to keep talking and syncing here."
      : "Use the email address from your Jun OS webapp account.");
    var contentType = passwordStep ? TMP_InputField.ContentType.Password : TMP_InputField.ContentType.EmailAddress;
    var choices = new Il2CppSystem.Collections.Generic.List<PopupStringChoice>();
    choices.Add(new PopupStringChoice {
      Text = passwordStep ? "Sign in" : "Next",
      Action = new Action<string>(Continue)
    });
    choices.Add(new PopupStringChoice {
      Text = "Not now",
      Action = new Action<string>(_ => Finish(false))
    });
    popup = UiOverlay.Instance.InputPopup(title, description, new Action<string>(_ => { }));
    popup.Open(choices, title, description, passwordStep ? "" : email, contentType);
    // Open registers twice, the duplicate makes the game's modal non-interactable
    UIManager.Instance.currentlyOpenPopups.Remove(popup);
    UIManager.Instance.SyncAllPopups();
    var insertAt = popup.pasteFromClipboardButton;
    insertAt.gameObject.SetActive(!passwordStep);
    if (!passwordStep) {
      popup.inputTmp.resetOnDeActivation = false;
      popup.inputTmp.onFocusSelectAll = false;
      var label = insertAt.GetComponentInChildren<TMP_Text>();
      // or the localizer puts "Paste from clipboard" back
      var localizer = label.GetComponent<UnityEngine.Localization.PropertyVariants.GameObjectLocalizer>();
      if (localizer != null) {
        localizer.enabled = false;
      }
      label.text = "Insert @";
      insertAt.onClick = new UnityEngine.UI.Button.ButtonClickedEvent();
      insertAt.onClick.AddListener(new Action(() => {
        popup.inputTmp.Append('@');
        popup.inputTmp.ActivateInputField();
      }));
    }
  }

  private static void Continue(string value) {
    popup.inputTmp.text = "";
    if (passwordStep) {
      busy = true;
      Submit(value ?? "");
    } else {
      email = (value ?? "").Trim();
      passwordStep = email.Length > 0;
      error = passwordStep ? null : "Enter your Jun OS email address.";
      openNext = true;
    }
  }

  public static void Draw() {
    if (!busy) {
      return;
    }
    var box = new Rect((Screen.width - 300) / 2, (Screen.height - 60) / 2, 300, 60);
    GUI.Box(box, "Signing in to Jun OS...");
  }

  private static async void Submit(string password) {
    string failure;
    try {
      failure = await JunSession.Instance.Login(email, password);
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
        openNext = true;
      }
    });
  }

  private static void Finish(bool ok) {
    TaskCompletionSource<bool> done;
    lock (gate) {
      if (popup != null) {
        popup.inputTmp.text = "";
      }
      done = pending;
      pending = null;
      error = null;
    }
    done?.TrySetResult(ok);
  }
}
