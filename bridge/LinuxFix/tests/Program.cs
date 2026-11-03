using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using JunBridge.LinuxFix;
using MelonLoader;

internal static unsafe class Program {
  private static int fallbackCalls;
  private static readonly BindingFlags instance = BindingFlags.Instance | BindingFlags.NonPublic;
  private static readonly BindingFlags statics = BindingFlags.Static | BindingFlags.NonPublic;

  [DllImport("libc")] private static extern IntPtr mmap(IntPtr address, nuint length, int protection, int flags, int fd, nint offset);
  [DllImport("libc")] private static extern int mprotect(IntPtr address, nuint length, int protection);
  [DllImport("libc")] private static extern int munmap(IntPtr address, nuint length);

  private static void Require(bool condition) {
    if (!condition) throw new Exception("native hook smoke test failed");
  }

  private static void OldHook(IntPtr* target, IntPtr replacement) { fallbackCalls++; }

  private static void Main(string[] args) {
    var directory = Path.Combine(Path.GetTempPath(), "junos-hooks-test-" + Guid.NewGuid().ToString("N"));
    var plugin = typeof(LinuxFix).Assembly;
    var ml = typeof(MelonPlugin).Assembly;
    var interop = ml.GetType("MelonLoader.InternalUtils.BootstrapInterop", true);
    var library = Activator.CreateInstance(ml.GetType("MelonLoader.InternalUtils.BootstrapLibrary", true), true);
    var attach = library.GetType().GetProperty("NativeHookAttach", instance);
    var detach = library.GetType().GetProperty("NativeHookDetach", instance);
    var oldHook = Delegate.CreateDelegate(attach.PropertyType, typeof(Program).GetMethod(nameof(OldHook), statics));
    attach.SetValue(library, oldHook);
    detach.SetValue(library, oldHook);
    interop.GetProperty("Library", statics).SetValue(null, library);
    LoaderConfig.Current.Loader.GetType().GetProperty("BaseDirectory").SetValue(LoaderConfig.Current.Loader, directory);
    var payload = plugin.GetManifestResourceStream("JunBridge.LinuxFix.dobby.so");
    Require(payload != null && plugin.GetManifestResourceStream("JunBridge.LinuxFix.NOTICES.txt") != null);
    using var bytes = new MemoryStream();
    payload.CopyTo(bytes);
    var hash = Convert.ToHexString(SHA256.HashData(bytes.ToArray())).ToLowerInvariant();
    var cache = Path.Combine(directory, "UserData", "JunBridge.LinuxFix", $"hooks-{hash}.so");
    bool repair = args.Contains("repair");
    if (repair) {
      Directory.CreateDirectory(Path.GetDirectoryName(cache));
      File.WriteAllText(cache, "damaged cache");
    }
    try {
      plugin.GetType("JunBridge.LinuxFix.NativeHooks", true).GetMethod("Install", statics).Invoke(null, null);
      Require(File.ReadAllText("/proc/self/maps").Contains(cache));
      Require(File.ReadAllText(Path.Combine(Path.GetDirectoryName(cache), "NOTICES.txt")).Contains("Matthew Endsley"));
      var attachPointer = Marshal.GetFunctionPointerForDelegate((Delegate)attach.GetValue(library));
      var detachPointer = Marshal.GetFunctionPointerForDelegate((Delegate)detach.GetValue(library));
      var code = mmap(IntPtr.Zero, 8192, 3, 0x22, -1, 0);
      Require(code != (IntPtr)(-1));
      try {
        var instructions = Enumerable.Repeat((byte)0x90, 8192).ToArray();
        instructions[0] = instructions[4096] = 0xb8;
        Array.Copy(BitConverter.GetBytes(7), 0, instructions, 1, 4);
        Array.Copy(BitConverter.GetBytes(99), 0, instructions, 4097, 4);
        instructions[24] = instructions[4120] = 0xc3;
        Marshal.Copy(instructions, 0, code, instructions.Length);
        Require(mprotect(code, 8192, 5) == 0);
        var call = (delegate* unmanaged[Cdecl]<int>)code;
        var replacement = code + 4096;
        for (int i = 0; i < 2; i++) {
          IntPtr original = code;
          ((delegate* unmanaged[Cdecl]<IntPtr*, IntPtr, void>)attachPointer)(&original, replacement);
          GC.Collect();
          GC.WaitForPendingFinalizers();
          Require(call() == 99 && ((delegate* unmanaged[Cdecl]<int>)original)() == 7);
          IntPtr target = code;
          ((delegate* unmanaged[Cdecl]<IntPtr*, IntPtr, void>)detachPointer)(&target, replacement);
          Require(call() == 7 && fallbackCalls == 0);
        }
        IntPtr earlier = code;
        ((delegate* unmanaged[Cdecl]<IntPtr*, IntPtr, void>)detachPointer)(&earlier, replacement);
        Require(fallbackCalls == 1);
      } finally {
        munmap(code, 8192);
      }
      Console.WriteLine($"native hook callbacks, trampoline, GC and detach: ok ({(repair ? "cache repair" : "first extraction")})");
    } finally {
      if (Directory.Exists(directory)) Directory.Delete(directory, true);
    }
  }
}
