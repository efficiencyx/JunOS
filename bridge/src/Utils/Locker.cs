using System.Collections.Generic;

namespace JunBridge.Utils;

public static class Locker<T> {
  private static readonly HashSet<T> locks = [];

  public static void Lock(T key) => locks.Add(key);

  public static void Unlock(T key) => locks.Remove(key);

  public static bool IsLocked(T key) => locks.Contains(key);
}
