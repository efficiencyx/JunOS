using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using System.Threading;
using UnityEngine;
using Il2CppInterop.Runtime;
using MelonLoader;

namespace JunBridge.Utils;

[MonoSingleton]
[RegisterTypeInIl2Cpp]
public class MainThreadRunner : MonoBehaviour {
  public static MainThreadRunner Instance => MonoSingletonManager.Get<MainThreadRunner>();

  private static readonly ConcurrentQueue<(Action action, TaskCompletionSource tcs)> actions = new();
  private static SynchronizationContext mainThreadContext;
  private static Il2CppSystem.Threading.SynchronizationContext unitySynchronizationContext;

  public void Awake() {
    this.ValidateSingleton();
    mainThreadContext = SynchronizationContext.Current;
    unitySynchronizationContext = UnitySynchronizationContext.Current;
  }

  public void Update() {
    while (actions.TryDequeue(out var work)) {
      try {
        work.action();
        work.tcs.SetResult();
      } catch (Exception e) {
        work.tcs.SetException(e);
      }
    }
  }

  public static Task Run(Action action) {
    if (IsMainThread()) {
      return RunInPlace(action);
    }

    if (mainThreadContext != null) {
      return RunInMainThreadContext(action);
    } else if (unitySynchronizationContext != null) {
      return RunInUnitySynchronizationContext(action);
    } else {
      return RunInNextUpdate(action);
    }
  }

  private static bool IsMainThread() {
    return Environment.CurrentManagedThreadId == 1;
  }

  private static Task RunInPlace(Action action) {
    try {
      action();
      return Task.CompletedTask;
    } catch (Exception e) {
      return Task.FromException(e);
    }
  }

  private static Task RunInMainThreadContext(Action action) {
    var tcs = new TaskCompletionSource();

    mainThreadContext.Post((state) => {
      try {
        action();
        tcs.TrySetResult();
      } catch (Exception e) {
        tcs.TrySetException(e);
      }
    }, null);

    return tcs.Task;
  }

  private static Task RunInUnitySynchronizationContext(Action action) {
    var tcs = new TaskCompletionSource();

    void wrappedAction(Il2CppSystem.Object state) {
      try {
        action();
        tcs.SetResult();
      } catch (Exception e) {
        tcs.SetException(e);
      }
    }

    // It is necessary to convert .NET Action to Il2CppAction
    var callback = DelegateSupport.ConvertDelegate<Il2CppSystem.Threading.SendOrPostCallback>(wrappedAction);
    unitySynchronizationContext.Post(callback, null);

    return tcs.Task;
  }

  private static Task RunInNextUpdate(Action action) {
    var tcs = new TaskCompletionSource();

    lock (actions) {
      actions.Enqueue((action, tcs));
    }

    return tcs.Task;
  }
}
