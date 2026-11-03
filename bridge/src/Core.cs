using System.Threading.Tasks;
using MelonLoader;
using UnityEngine;
using JunBridge.Utils;

[assembly: MelonInfo(typeof(JunBridge.Core), "JunBridge", "0.1.0", "JunOS", null)]
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

  public override void OnUpdate() {
    JunApi.LoginPrompt.Update();
    if (Input.GetKeyDown(KeyCode.F8)) {
      JunApi.LoginPrompt.MainMenuReady();
      _ = SignInManually();
    }
  }

  private static async Task SignInManually() {
    if (await JunApi.LoginPrompt.Ask(false)) {
      await JunApi.JunSession.Instance.EnsureSyncToken();
    }
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
