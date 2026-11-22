using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using HarmonyLib;
using Il2CppInterop.Common.XrefScans;
using MelonLoader;

[assembly: MelonInfo(typeof(JunBridge.LinuxFix.LinuxFix), "JunBridge.LinuxFix", "0.2.1", "JunOS")]
[assembly: MelonPriority(int.MinValue)]
[assembly: MelonGame("IncontinentCell", "My Dystopian Robot Girlfriend")]

namespace JunBridge.LinuxFix;

// Il2CppInterop finds GetTypeInfoFromTypeDefinitionIndex(int) by
// following single jumps. in the linux GameAssembly.so the function
// before it ends in TWO jumps there, so it hooks that one (takes a
// pointer, not an int) and the game segfaults on start
public class LinuxFix : MelonPlugin {
  private const string hookType = "Il2CppInterop.Runtime.Injection.Hooks.MetadataCache_GetTypeInfoFromTypeDefinitionIndex_Hook";

  public override void OnEarlyInitializeMelon() {
    if (OperatingSystem.IsLinux()) {
      NativeHooks.Install();
      LoggerInstance.Msg("native hooks use the embedded allocator");
      var injector = typeof(MelonPlugin).Assembly.GetType("MelonLoader.Fixes.Il2CppInterop.Il2CppICallInjector");
      var early = injector?.GetField("il2cpp_resolve_icall_hook", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)?.GetValue(null);
      bool earlyInstalled = early?.GetType().GetProperty("IsHooked")?.GetValue(early) is true;
      LoggerInstance.Msg($"loader hook present before plugin: {earlyInstalled}");
      ReapDumpForks();
    }
  }

  public override void OnApplicationQuit() {
    if (OperatingSystem.IsLinux()) {
      ReapDumpForks();
    }
  }

  // MelonLoader's ClrMD check asks .NET for a dump before any plugin runs.
  // .NET forks the game for createdump, the dump fails and that fork never
  // execs. it sits in poll and outlives the game
  private void ReapDumpForks() {
    var self = Environment.ProcessId;
    var exe = new FileInfo("/proc/self/exe").LinkTarget;
    foreach (var dir in Directory.EnumerateDirectories("/proc")) {
      if (!int.TryParse(Path.GetFileName(dir), out var pid) || pid == self) {
        continue;
      }
      try {
        if (ParentOf(File.ReadAllText($"{dir}/stat")) != self || new FileInfo($"{dir}/exe").LinkTarget != exe
            || !File.ReadLines($"{dir}/status").Contains("Threads:\t1")) {
          continue;
        }
        using var fork = Process.GetProcessById(pid);
        fork.Kill();
        LoggerInstance.Msg($"killed stray dump fork {pid}");
      } catch (Exception) {
        // gone already, or not ours to read
      }
    }
  }

  // comm is free text ("My Dystopian Ro", parens allowed), ppid is the 2nd field after the last ')'
  internal static int ParentOf(string stat) => int.Parse(stat[(stat.LastIndexOf(')') + 2)..].Split(' ')[1]);

  public override void OnPreInitialization() {
    if (!OperatingSystem.IsLinux()) {
      return;
    }
    var target = typeof(Il2CppInterop.Runtime.IL2CPP).Assembly.GetType(hookType)?.GetMethod("FindTargetMethod");
    if (target == null) {
      LoggerInstance.Warning($"{hookType} is gone, this Il2CppInterop doesn't need the fix (or moved it)");
      return;
    }
    HarmonyInstance.Patch(target, postfix: new HarmonyMethod(typeof(LinuxFix), nameof(FollowSameJump)));

    var hooks = target.DeclaringType.Assembly.GetTypes()
      .Where(t => t.Name.EndsWith("_Hook"))
      .Select(t => t.GetMethod("FindTargetMethod"))
      .Where(m => m != null && m.DeclaringType == m.ReflectedType);
    foreach (var find in hooks) {
      HarmonyInstance.Patch(find, postfix: new HarmonyMethod(typeof(LinuxFix), nameof(LogTarget)) { priority = HarmonyLib.Priority.Last });
    }
  }

  private static void LogTarget(System.Reflection.MethodBase __originalMethod, IntPtr __result) {
    var gameAssembly = System.Diagnostics.Process.GetCurrentProcess().Modules.Cast<System.Diagnostics.ProcessModule>()
      .FirstOrDefault(m => m.ModuleName == "GameAssembly.so");
    var offset = gameAssembly == null ? "?" : $"0x{__result.ToInt64() - gameAssembly.BaseAddress.ToInt64():X}";
    Melon<LinuxFix>.Logger.Msg($"{__originalMethod.DeclaringType.Name} -> 0x{__result.ToInt64():X} (GameAssembly.so+{offset})");
  }

  private static void FollowSameJump(ref IntPtr __result) {
    if (__result == IntPtr.Zero) {
      return;
    }
    var jumps = XrefScannerLowLevel.JumpTargets(__result).ToArray();
    if (jumps.Length > 1 && jumps.Distinct().Count() == 1) {
      Melon<LinuxFix>.Logger.Msg($"GetTypeInfoFromTypeDefinitionIndex: 0x{__result.ToInt64():X} -> 0x{jumps[0].ToInt64():X}");
      __result = jumps[0];
    }
  }
}
