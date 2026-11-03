using System;
using System.Collections.Generic;
using UnityEngine;

namespace JunBridge.Utils;

[AttributeUsage(AttributeTargets.Class)]
public class MonoSingletonAttribute : Attribute { }

public static class MonoSingletonManager {
  private static readonly Logger logger = new("MonoSingletonManager");

  private static readonly Dictionary<Type, MonoBehaviour> singletons = [];
  private static readonly HashSet<Type> pendingSingletons = [];

  public static T Add<T>() where T : MonoBehaviour {
    if (Has<T>()) {
      return Get<T>();
    }

    if (!typeof(T).IsDefined(typeof(MonoSingletonAttribute), false)) {
      throw new Exception($"Type {typeof(T)} is not marked with MonoSingleton attribute");
    }

    logger.Log($"Adding singleton {typeof(T)}");
    pendingSingletons.Add(typeof(T));
    var component = Core.Instance.RootObject.AddComponent<T>();
    UnityEngine.Object.DontDestroyOnLoad(component);
    singletons[typeof(T)] = component;
    pendingSingletons.Remove(typeof(T));

    return component;
  }

  public static T Get<T>() where T : MonoBehaviour {
    if (!singletons.TryGetValue(typeof(T), out var singleton)) {
      singleton = Add<T>();
    }
    return (T)singleton;
  }

  public static bool Has<T>(bool includePending = false) where T : MonoBehaviour {
    if (singletons.ContainsKey(typeof(T))) {
      return true;
    }

    if (includePending) {
      return IsPending<T>();
    }

    return false;
  }

  public static bool IsPending<T>() where T : MonoBehaviour {
    return pendingSingletons.Contains(typeof(T));
  }
}

public static class MonoSingletonExtensions {
  public static void ValidateSingleton<T>(this T component) where T : MonoBehaviour {
    if (!MonoSingletonManager.IsPending<T>()) {
      UnityEngine.Object.Destroy(component);
      throw new Exception($"Singleton {component.GetType()} must be created through MonoSingletonManager.Add<T>()");
    }
  }
}
