using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using MelonLoader;
using MelonLoader.Utils;
using RuntimeLibrary = System.Runtime.InteropServices.NativeLibrary;

namespace JunBridge.LinuxFix;

internal static unsafe class NativeHooks {
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  private delegate int Hook(IntPtr address, IntPtr replacement, out IntPtr original);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  private delegate int Destroy(IntPtr address);

  private static readonly object gate = new();
  private static readonly HashSet<IntPtr> hooks = new();
  private static Hook hook;
  private static Destroy destroy;
  private static Delegate originalDetach;
  private static IntPtr originalDetachPointer;

  internal static void Install() {
    var payload = Resource("dobby.so");
    var hash = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
    var directory = Path.Combine(MelonEnvironment.UserDataDirectory, "JunBridge.LinuxFix");
    Directory.CreateDirectory(directory);
    CacheFile(directory, "NOTICES.txt", Resource("NOTICES.txt"));
    var handle = RuntimeLibrary.Load(CacheFile(directory, $"hooks-{hash}.so", payload));
    hook = Marshal.GetDelegateForFunctionPointer<Hook>(RuntimeLibrary.GetExport(handle, "DobbyHook"));
    destroy = Marshal.GetDelegateForFunctionPointer<Destroy>(RuntimeLibrary.GetExport(handle, "DobbyDestroy"));

    var interop = typeof(MelonPlugin).Assembly.GetType("MelonLoader.InternalUtils.BootstrapInterop", true);
    var library = interop.GetProperty("Library", BindingFlags.Static | BindingFlags.NonPublic)?.GetValue(null)
      ?? throw new MissingMemberException("MelonLoader's bootstrap library is unavailable");
    var flags = BindingFlags.Instance | BindingFlags.NonPublic;
    var attach = library.GetType().GetProperty("NativeHookAttach", flags)
      ?? throw new MissingMemberException("NativeHookAttach");
    var detach = library.GetType().GetProperty("NativeHookDetach", flags)
      ?? throw new MissingMemberException("NativeHookDetach");
    var originalAttach = (Delegate)attach.GetValue(library);
    originalDetach = (Delegate)detach.GetValue(library);
    originalDetachPointer = Marshal.GetFunctionPointerForDelegate(originalDetach);
    var methods = BindingFlags.Static | BindingFlags.NonPublic;
    var attachReplacement = Delegate.CreateDelegate(attach.PropertyType, typeof(NativeHooks).GetMethod(nameof(Attach), methods));
    var detachReplacement = Delegate.CreateDelegate(detach.PropertyType, typeof(NativeHooks).GetMethod(nameof(Detach), methods));
    attach.SetValue(library, attachReplacement);
    try {
      detach.SetValue(library, detachReplacement);
    } catch {
      attach.SetValue(library, originalAttach);
      throw;
    }
  }

  private static byte[] Resource(string name) {
    using var resource = typeof(NativeHooks).Assembly.GetManifestResourceStream("JunBridge.LinuxFix." + name)
      ?? throw new InvalidOperationException($"the embedded Linux hook resource {name} is missing");
    using var bytes = new MemoryStream();
    resource.CopyTo(bytes);
    return bytes.ToArray();
  }

  private static string CacheFile(string directory, string name, byte[] payload) {
    var path = Path.Combine(directory, name);
    if (File.Exists(path) && SHA256.HashData(File.ReadAllBytes(path)).AsSpan().SequenceEqual(SHA256.HashData(payload))) {
      return path;
    }
    var temporary = path + "." + Guid.NewGuid().ToString("N");
    try {
      File.WriteAllBytes(temporary, payload);
      File.Move(temporary, path, true);
    } finally {
      File.Delete(temporary);
    }
    return path;
  }

  private static void Attach(IntPtr* target, IntPtr replacement) {
    lock (gate) {
      var address = *target;
      if (hook(address, replacement, out var original) != 0 || original == IntPtr.Zero) {
        throw new InvalidOperationException($"couldn't prepare native hook at 0x{address.ToInt64():X}");
      }
      hooks.Add(address);
      *target = original;
    }
  }

  private static void Detach(IntPtr* target, IntPtr replacement) {
    lock (gate) {
      if (hooks.Contains(*target)) {
        if (destroy(*target) != 0) {
          throw new InvalidOperationException($"couldn't remove native hook at 0x{target->ToInt64():X}");
        }
        hooks.Remove(*target);
        return;
      }
      ((delegate* unmanaged[Cdecl]<IntPtr*, IntPtr, void>)originalDetachPointer)(target, replacement);
    }
  }
}
