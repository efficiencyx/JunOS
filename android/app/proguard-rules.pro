-keep class com.chaquo.python.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
# their JNI reads config getters/fields and calls onMessage BY NAME. renamed = release apk dies on the first prompt
-keep class com.google.ai.edge.litertlm.** { *; }
-keep class com.k2fsa.sherpa.onnx.** { *; }
-dontwarn io.ktor.**
# commons-compress references codecs we never pull in (only its ZIP reader is used)
-dontwarn org.apache.commons.compress.**
-dontwarn org.brotli.dec.**
-dontwarn org.tukaani.xz.**
-dontwarn com.github.luben.zstd.**
# jun_recovery.py calls onProgress by name, R8 can't see that
-keep class com.efficiencyx.junos.setup.AssetRecovery$RecoveryProgress { public *; }
