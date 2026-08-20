-keep class com.chaquo.python.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
-dontwarn io.ktor.**
# commons-compress references codecs we never pull in (only its ZIP reader is used)
-dontwarn org.apache.commons.compress.**
-dontwarn org.brotli.dec.**
-dontwarn org.tukaani.xz.**
-dontwarn com.github.luben.zstd.**
