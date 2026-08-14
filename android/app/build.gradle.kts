import java.security.MessageDigest
import java.util.zip.ZipFile
import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
    id("com.chaquo.python")
}

android {
    namespace = "com.efficiencyx.junos"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.efficiencyx.junos"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            val keystore = providers.environmentVariable("JUN_ANDROID_KEYSTORE")
            if (keystore.isPresent) {
                signingConfig = signingConfigs.create("releaseEnv") {
                    storeFile = file(keystore.get())
                    storePassword = providers.environmentVariable("JUN_ANDROID_STORE_PASSWORD").orNull
                    keyAlias = providers.environmentVariable("JUN_ANDROID_KEY_ALIAS").orNull
                    keyPassword = providers.environmentVariable("JUN_ANDROID_KEY_PASSWORD").orNull
                }
            }
        }
    }

    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The JVM tests touch classes that log through android.util.Log, and the stub jar
    // throws on every method unless we ask for defaults back.
    testOptions.unitTests.isReturnDefaultValues = true

    packaging {
        jniLibs.useLegacyPackaging = false
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }

    sourceSets.named("main") {
        assets.srcDir(layout.buildDirectory.dir("generated/junWeb"))
    }
}

kotlin {
    compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 }
}

ksp { arg("room.schemaLocation", "$projectDir/schemas") }

chaquopy {
    defaultConfig {
        version = "3.12"
        val configuredPython = providers.environmentVariable("JUN_PYTHON_312").orNull
        val localPython = System.getenv("LOCALAPPDATA")?.let { file("$it/JunOS/python312/python.exe") }
        buildPython(configuredPython ?: localPython?.takeIf { it.isFile }?.absolutePath ?: "python3.12")
        pip {
            options("--no-deps")
            install("-r", "src/main/python/requirements.txt")
        }
    }
    sourceSets {
        getByName("main") {
            srcDir(layout.buildDirectory.dir("generated/recoveryPython"))
            srcDir(layout.buildDirectory.dir("generated/unityPyPython"))
        }
    }
    productFlavors { }
}

val unityPyVersion = "1.25.0"
val unityPySdist by configurations.creating

val verifyUnityPySdist by tasks.registering {
    doLast {
        val digest = MessageDigest.getInstance("SHA-256").digest(unityPySdist.singleFile.readBytes())
            .joinToString("") { "%02x".format(it) }
        check(digest == "4267195aba76fff95975a9687e2d04b8f16e5909a92ac8d4020241284d9082fb") {
            "UnityPy sdist checksum mismatch"
        }
    }
}

// UnityPy's wheels bundle a compiled UnityPyBoost that has no Android build, but every call
// site falls back to pure Python, so the package tree is unpacked out of the sdist straight
// into the Chaquopy source set. The C++ sits in a sibling directory and never comes along.
// The version has to match the desktop installers, which pull UnityPy unpinned - anything
// older than 1.10 misparses this game's Unity 6 Texture2D headers.
val unpackUnityPy by tasks.registering(Copy::class) {
    dependsOn(verifyUnityPySdist)
    from(provider { tarTree(resources.gzip(unityPySdist.singleFile)) }) {
        include("unitypy-$unityPyVersion/UnityPy/**")
        exclude("**/*.pyi")
        eachFile { path = path.substringAfter("unitypy-$unityPyVersion/") }
    }
    includeEmptyDirs = false
    into(layout.buildDirectory.dir("generated/unityPyPython"))
}

tasks.named("preBuild").configure { dependsOn(unpackUnityPy) }
tasks.matching { it.name.matches(Regex("merge(.*)PythonSources")) }.configureEach {
    dependsOn(unpackUnityPy)
}

val generateJunWebAssets by tasks.registering(Copy::class) {
    from(rootProject.projectDir.parentFile.resolve("webapp")) {
        exclude("api/**", "assets/**", "**/*.php", "lore_corpus.txt", "lore_index.bin", "lore_meta.json")
    }
    from(rootProject.projectDir.parentFile.resolve("tools/lore_dataset.jsonl")) {
        into("data")
    }
    into(layout.buildDirectory.dir("generated/junWeb"))
}

tasks.named("preBuild").configure { dependsOn(generateJunWebAssets) }

val generateRecoverySource by tasks.registering(Copy::class) {
    from(rootProject.projectDir.parentFile.resolve("tools/recover_assets.py"))
    into(layout.buildDirectory.dir("generated/recoveryPython"))
}

tasks.named("preBuild").configure { dependsOn(generateRecoverySource) }
tasks.matching { it.name.matches(Regex("merge(.*)PythonSources")) }.configureEach {
    dependsOn(generateRecoverySource)
}

val sherpaAar by configurations.creating
configurations.named("implementation") { extendsFrom(sherpaAar) }

val verifySherpaAar by tasks.registering {
    doLast {
        val file = sherpaAar.singleFile
        val digest = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
        check(digest == "03f9c4df965f21c71269365a7951a7f23b5696fddd093fa318c80d65550ab780") {
            "sherpa-onnx AAR checksum mismatch"
        }
    }
}

tasks.named("preBuild").configure { dependsOn(verifySherpaAar) }

val verifyPinnedManifests by tasks.registering {
    doLast {
        val file = file("src/main/assets/manifests/litert_model.json")
        val manifest = JsonSlurper().parse(file) as Map<*, *>
        check((manifest["download_url"] as? String)?.startsWith("https://") == true)
        check((manifest["sha256"] as? String)?.matches(Regex("[a-fA-F0-9]{64}")) == true)
        check((manifest["size"] as? Number)?.toLong()?.let { it > 0 } == true) {
            "litert_model.json needs a pinned release URL, size, and SHA-256 before a release build."
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyPinnedManifests) }

val forbiddenReleaseEntries = listOf(
    Regex("(?i).*\\.gguf$"), Regex("(?i).*\\.litertlm$"), Regex("(?i).*\\.(zip|apk)$"),
    Regex("(?i).*webapp/assets/.*"), Regex("(?i).*(omega\\.sqlite|meta\\.json)$"),
)

tasks.register("verifyReleaseContents") {
    dependsOn("assembleRelease")
    doLast {
        val apk = layout.buildDirectory.dir("outputs/apk/release").get().asFile
            .walkTopDown().firstOrNull { it.extension == "apk" }
            ?: error("Release APK not found")
        ZipFile(apk).use { zip ->
            val forbidden = zip.entries().asSequence().map { it.name }
                .filter { name -> forbiddenReleaseEntries.any { it.matches(name) } }.toList()
            check(forbidden.isEmpty()) { "Forbidden private content in APK: ${forbidden.joinToString()}" }
        }
        check(apk.length() <= 180L * 1024 * 1024) {
            "Release APK is ${apk.length() / 1024 / 1024} MiB; limit is 180 MiB"
        }
    }
}

dependencies {
    sherpaAar("k2-fsa:sherpa-onnx:1.13.4@aar")
    unityPySdist("u:unitypy:$unityPyVersion@tar.gz")
    val composeBom = platform("androidx.compose:compose-bom:2025.03.01")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    implementation("androidx.room:room-runtime:2.7.0")
    implementation("androidx.room:room-ktx:2.7.0")
    ksp("androidx.room:room-compiler:2.7.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    implementation("io.ktor:ktor-server-cio:3.1.2")
    implementation("io.ktor:ktor-server-core:3.1.2")
    implementation("io.ktor:ktor-server-content-negotiation:3.1.2")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.1.2")
    implementation("io.ktor:ktor-server-status-pages:3.1.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.16.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.apache.commons:commons-compress:1.27.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
