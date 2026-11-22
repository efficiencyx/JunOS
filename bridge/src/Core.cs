using System.Collections;
using System.Threading.Tasks;
using MelonLoader;
using UnityEngine;
using JunBridge.Utils;

[assembly: MelonInfo(typeof(JunBridge.Core), "JunBridge", "0.3.2", "JunOS", null)]
[assembly: MelonGame("IncontinentCell", "My Dystopian Robot Girlfriend")]

namespace JunBridge;

public class Core : MelonMod {
  public static Core Instance { get; private set; }

  public GameObject RootObject { get; private set; }

  public override void OnInitializeMelon() {
    Instance = this;
    ModConfig.Load();

    RootObject = new GameObject(System.Guid.NewGuid().ToString());
    Object.DontDestroyOnLoad(RootObject);

    MonoSingletonManager.Add<MainThreadRunner>();
    MonoSingletonManager.Add<SaveStorage>();
    MonoSingletonManager.Add<Chat.ChatManager>();
    MonoSingletonManager.Add<Chat.ChatWriter>();
    MonoSingletonManager.Add<Tts.TtsManager>();

    Sync.BridgeSync.Start();
    _ = SignInOnStart();
  }

  public override void OnLateInitializeMelon() {
    ModSettingsPage.Register();
  }

  // ModSettingsMenu hooks MainMenuScene.Prepare, a second hook on it crashed the game on boot
  public override void OnSceneWasInitialized(int buildIndex, string sceneName) {
    if (sceneName == "MainScene") {
      MelonCoroutines.Start(WaitForMainMenu());
    }
  }

  private static IEnumerator WaitForMainMenu() {
    yield return new WaitWhile((System.Func<bool>)(() => Object.FindObjectOfType<Il2Cpp.MenuStaticGui>() == null));
    JunApi.LoginPrompt.MainMenuReady();
  }

  public override void OnUpdate() {
    JunApi.LoginPrompt.Update();
    Chat.Interactions.Poll();
    Chat.Initiative.Update();
    SettingsMenu.Update();
    if (Input.GetKeyDown(KeyCode.F8)) {
      OpenSettings();
    }
  }

  // with ModSettingsMenu our page sits in Options > Mod settings
  private static void OpenSettings() {
    if (ModSettingsPage.Available && Il2Cpp.UiOverlay.Instance != null) {
      try {
        Il2Cpp.UiOverlay.Instance.OpenOptions();
        return;
      } catch (System.Exception ex) {
        MelonLogger.Warning($"couldn't open Options: {ex.Message}");
      }
    }
    SettingsMenu.Toggle();
  }

  public override void OnGUI() {
    JunApi.LoginPrompt.Draw();
  }

  private static async Task SignInOnStart() {
    var session = JunApi.JunSession.Instance;
    if (await session.EnsureAuthenticated()) {
      await session.EnsureSyncToken();
    }
  }
}
